use axum::{
    extract::{Path, Query, State},
    http::{StatusCode, header},
    Json,
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use tracing::error;
use utoipa::{IntoParams, ToSchema};

use crate::api::{ErrorResponse, bad_request, internal_error};

#[derive(Debug, Serialize, ToSchema, FromRow)]
pub struct Route {
    pub osm_id: i64,
    pub osm_type: String,
    pub name: Option<String>,
    #[serde(rename = "ref")]
    #[sqlx(rename = "ref")]
    pub route_ref: Option<String>,
    pub route_type: String,
    pub operator: Option<String>,
    pub network: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RouteListResponse {
    pub routes: Vec<Route>,
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct RouteQuery {
    /// Filter by route type (e.g., "tram", "bus")
    pub route_type: Option<String>,
    /// Filter by route ref (e.g., "RE 9", "506"). Spaces are ignored for matching.
    #[serde(rename = "ref")]
    pub route_ref: Option<String>,
    /// Search routes whose name contains this text (e.g., "München")
    pub name_contains: Option<String>,
    /// Filter by operator (substring match, e.g., "Augsburger" matches "Augsburger Verkehrsgesellschaft")
    pub operator: Option<String>,
    /// Filter to routes near this latitude (used with `near_lon`, searches within ~30km)
    pub near_lat: Option<f64>,
    /// Filter to routes near this longitude (used with `near_lat`, searches within ~30km)
    pub near_lon: Option<f64>,
}

/// List all routes, optionally filtered by type
#[utoipa::path(
    get,
    path = "/api/routes",
    params(RouteQuery),
    responses(
        (status = 200, description = "List of routes", body = RouteListResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    ),
    tag = "routes"
)]
pub async fn list_routes(
    State(pool): State<PgPool>,
    Query(query): Query<RouteQuery>,
) -> Result<Json<RouteListResponse>, (StatusCode, Json<ErrorResponse>)> {
    const MAX_SEARCH_LEN: usize = 200;
    let routes: Vec<Route> = if query.route_ref.is_some() || query.name_contains.is_some() || query.operator.is_some() {
        // Targeted query: filter by ref and/or name and/or operator (fast, returns few results)
        let ref_normalized = query.route_ref.as_deref().map(|r| r.replace(' ', "").to_uppercase());
        let name_contains = query.name_contains.as_deref().map(|s| &s[..s.len().min(MAX_SEARCH_LEN)]);
        let operator = query.operator.as_deref().map(|s| &s[..s.len().min(MAX_SEARCH_LEN)]);
        sqlx::query_as(
            r#"
            SELECT DISTINCT r.osm_id, r.osm_type, r.name, r.ref, r.route_type, r.operator, r.network, r.color
            FROM routes r
            WHERE ($1::text IS NULL OR r.route_type = $1)
              AND ($2::text IS NULL OR UPPER(REPLACE(r.ref, ' ', '')) = $2)
              AND ($3::text IS NULL OR r.name ILIKE '%' || $3 || '%')
              AND ($4::text IS NULL OR r.operator ILIKE '%' || $4 || '%')
              AND ($5::float8 IS NULL OR (
                  EXISTS (
                      SELECT 1 FROM route_stops rs
                      JOIN stop_positions sp ON sp.osm_id = rs.stop_position_id
                      WHERE rs.route_id = r.osm_id
                        AND sp.lat BETWEEN $5 - 0.3 AND $5 + 0.3
                        AND sp.lon BETWEEN $6 - 0.4 AND $6 + 0.4
                  ) OR EXISTS (
                      SELECT 1 FROM route_stops rs
                      JOIN stations s ON s.osm_id = rs.station_id
                      WHERE rs.route_id = r.osm_id
                        AND s.lat BETWEEN $5 - 0.3 AND $5 + 0.3
                        AND s.lon BETWEEN $6 - 0.4 AND $6 + 0.4
                  )
              ))
            ORDER BY r.ref, r.name
            "#,
        )
        .bind(query.route_type.as_deref())
        .bind(ref_normalized.as_deref())
        .bind(name_contains)
        .bind(operator)
        .bind(query.near_lat)
        .bind(query.near_lon)
        .fetch_all(&pool)
        .await
    } else if let Some(route_type) = query.route_type.as_deref() {
        sqlx::query_as(
            r#"
            SELECT osm_id, osm_type, name, ref, route_type, operator, network, color
            FROM routes
            WHERE route_type = $1
            ORDER BY ref, name
            "#,
        )
        .bind(route_type)
        .fetch_all(&pool)
        .await
    } else {
        sqlx::query_as(
            r#"
            SELECT osm_id, osm_type, name, ref, route_type, operator, network, color
            FROM routes
            ORDER BY ref, name
            "#,
        )
        .fetch_all(&pool)
        .await
    }
    .map_err(internal_error)?;

    Ok(Json(RouteListResponse { routes }))
}

/// Request body for POST /api/routes/search
#[derive(Debug, Deserialize, ToSchema)]
pub struct RouteSearchRequest {
    /// Free-text query that matches against route ref OR name (case-insensitive substring).
    /// When set, all routes where ref starts with the query OR name contains it are returned.
    pub query: Option<String>,
    /// Filter by route type (e.g., "tram", "bus")
    pub route_type: Option<String>,
    /// Filter by route ref (e.g., "RE 9", "506"). Spaces are ignored for matching.
    #[serde(rename = "ref")]
    pub route_ref: Option<String>,
    /// Search routes whose name contains this text (e.g., "München")
    pub name_contains: Option<String>,
    /// Filter by operator (substring match)
    pub operator: Option<String>,
    /// City filter — substring match against name, operator, and network
    /// (e.g., "augsburg" matches AVV/Augsburger Verkehrsgesellschaft routes).
    pub city: Option<String>,
    /// Filter to routes near this latitude (searches within ~30km)
    pub near_lat: Option<f64>,
    /// Filter to routes near this longitude (searches within ~30km)
    pub near_lon: Option<f64>,
    /// Maximum number of results to return (default 100, max 500)
    pub limit: Option<i64>,
    /// When true, deduplicate variants of the same line by (ref, route_type, operator).
    /// One representative route per group is returned. Default: false (variants are real routes).
    pub deduplicate: Option<bool>,
}

/// Search routes with filters (POST body)
#[utoipa::path(
    post,
    path = "/api/routes/search",
    request_body = RouteSearchRequest,
    responses(
        (status = 200, description = "Matching routes", body = RouteListResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    ),
    tag = "routes"
)]
pub async fn search_routes(
    State(pool): State<PgPool>,
    Json(body): Json<RouteSearchRequest>,
) -> Result<Json<RouteListResponse>, (StatusCode, Json<ErrorResponse>)> {
    const MAX_SEARCH_LEN: usize = 200;
    let query_text = body.query.as_deref().map(|s| &s[..s.len().min(MAX_SEARCH_LEN)]);
    let query_ref_normalized = query_text.map(|q| q.replace(' ', "").to_uppercase());
    let ref_normalized = body.route_ref.as_deref().map(|r| r.replace(' ', "").to_uppercase());
    let name_contains = body.name_contains.as_deref().map(|s| &s[..s.len().min(MAX_SEARCH_LEN)]);
    let operator = body.operator.as_deref().map(|s| &s[..s.len().min(MAX_SEARCH_LEN)]);
    let city = body.city.as_deref().map(|s| &s[..s.len().min(MAX_SEARCH_LEN)]);
    let limit = body.limit.unwrap_or(100).clamp(1, 500);
    let deduplicate = body.deduplicate.unwrap_or(false);

    // Common WHERE clause shared between dedup and non-dedup paths
    let base_query = r#"
        SELECT r.osm_id, r.osm_type, r.name, r.ref, r.route_type, r.operator, r.network, r.color
        FROM routes r
        WHERE ($1::text IS NULL OR r.route_type = $1)
          AND ($2::text IS NULL OR UPPER(REPLACE(r.ref, ' ', '')) = $2)
          AND ($3::text IS NULL OR r.name ILIKE '%' || $3 || '%')
          AND ($4::text IS NULL OR r.operator ILIKE '%' || $4 || '%')
          AND ($5::float8 IS NULL OR (
              EXISTS (
                  SELECT 1 FROM route_stops rs
                  JOIN stop_positions sp ON sp.osm_id = rs.stop_position_id
                  WHERE rs.route_id = r.osm_id
                    AND sp.lat BETWEEN $5 - 0.3 AND $5 + 0.3
                    AND sp.lon BETWEEN $6 - 0.4 AND $6 + 0.4
              ) OR EXISTS (
                  SELECT 1 FROM route_stops rs
                  JOIN stations s ON s.osm_id = rs.station_id
                  WHERE rs.route_id = r.osm_id
                    AND s.lat BETWEEN $5 - 0.3 AND $5 + 0.3
                    AND s.lon BETWEEN $6 - 0.4 AND $6 + 0.4
              )
          ))
          AND ($7::text IS NULL OR (
              UPPER(REPLACE(r.ref, ' ', '')) LIKE $7 || '%'
              OR r.name ILIKE '%' || $8 || '%'
          ))
          AND ($10::text IS NULL OR (
              r.name ILIKE '%' || $10 || '%'
              OR r.operator ILIKE '%' || $10 || '%'
              OR r.network ILIKE '%' || $10 || '%'
          ))
    "#;

    // Deduplicated query: pick one representative per (ref, route_type, operator) group.
    // Non-deduplicated: return all matching variants.
    let sql = if deduplicate {
        format!(
            r#"
            WITH matches AS ({base_query})
            SELECT DISTINCT ON (route_type, COALESCE(ref, ''), COALESCE(operator, ''))
                osm_id, osm_type, name, ref, route_type, operator, network, color
            FROM matches
            ORDER BY route_type, COALESCE(ref, ''), COALESCE(operator, ''), name
            LIMIT $9
            "#
        )
    } else {
        format!("{base_query} ORDER BY r.ref, r.name LIMIT $9")
    };

    let routes: Vec<Route> = sqlx::query_as(&sql)
        .bind(body.route_type.as_deref())
        .bind(ref_normalized.as_deref())
        .bind(name_contains)
        .bind(operator)
        .bind(body.near_lat)
        .bind(body.near_lon)
        .bind(query_ref_normalized.as_deref())
        .bind(query_text)
        .bind(limit)
        .bind(city)
        .fetch_all(&pool)
        .await
        .map_err(internal_error)?;

    Ok(Json(RouteListResponse { routes }))
}

#[derive(Debug, Serialize, ToSchema, FromRow)]
pub struct RouteColorEntry {
    #[serde(rename = "ref")]
    #[sqlx(rename = "ref")]
    pub route_ref: Option<String>,
    pub route_type: String,
    pub color: Option<String>,
    pub operator: Option<String>,
    pub network: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RouteColorsResponse {
    pub entries: Vec<RouteColorEntry>,
}

/// Get distinct route line colors and types (lightweight, for color lookups)
#[utoipa::path(
    get,
    path = "/api/routes/colors",
    responses(
        (status = 200, description = "Route color and type lookup", body = RouteColorsResponse),
    ),
    tag = "routes"
)]
pub async fn get_route_colors(
    State(pool): State<PgPool>,
) -> Result<impl IntoResponse, (StatusCode, Json<ErrorResponse>)> {
    // Return ALL distinct (route_type, ref, color) combinations.
    // Includes both OSM operator names AND GTFS agency names as "operator" field,
    // so the frontend can build keys matching MOTIS agencyName (which comes from GTFS,
    // not OSM — e.g. "Stadtwerke München" vs "Münchner Verkehrsgesellschaft").
    let entries: Vec<RouteColorEntry> = sqlx::query_as(
        r#"
        -- OSM operator names (primary source)
        SELECT DISTINCT ref, route_type, color, operator, network FROM routes
        WHERE ref IS NOT NULL AND color IS NOT NULL
        UNION
        -- GTFS agency names (via route mapping, if available)
        SELECT DISTINCT r.ref, r.route_type, r.color, ga.agency_name AS operator, r.network
        FROM routes r
        JOIN osm_gtfs_route_mapping m ON m.osm_route_id = r.osm_id
        JOIN gtfs_routes gr ON gr.route_id = m.gtfs_route_id
        JOIN gtfs_agencies ga ON ga.agency_id = gr.agency_id
        WHERE r.ref IS NOT NULL AND r.color IS NOT NULL
          AND ga.agency_name IS NOT NULL
          AND ga.agency_name != COALESCE(r.operator, '')
        ORDER BY ref, route_type
        "#,
    )
    .fetch_all(&pool)
    .await
    .map_err(internal_error)?;

    // Cache for 1 hour — route colors change only on OSM import
    Ok((
        [(header::CACHE_CONTROL, "public, max-age=3600")],
        Json(RouteColorsResponse { entries }),
    ))
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RouteDetail {
    #[serde(flatten)]
    pub route: Route,
    pub stops: Vec<RouteStop>,
}

#[derive(Debug, Serialize, ToSchema, FromRow)]
pub struct RouteStop {
    pub sequence: i32,
    pub role: Option<String>,
    pub stop_position_id: Option<i64>,
    pub platform_id: Option<i64>,
    pub station_id: Option<i64>,
    pub station_name: Option<String>,
}

/// Get a single route with its stops
#[utoipa::path(
    get,
    path = "/api/routes/{route_id}",
    params(
        ("route_id" = i64, Path, description = "Route OSM ID")
    ),
    responses(
        (status = 200, description = "Route details with stops", body = RouteDetail),
        (status = 404, description = "Route not found", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    ),
    tag = "routes"
)]
pub async fn get_route(
    State(pool): State<PgPool>,
    Path(route_id): Path<i64>,
) -> Result<Json<RouteDetail>, (StatusCode, Json<ErrorResponse>)> {
    let route: Option<Route> = sqlx::query_as(
        r#"
        SELECT osm_id, osm_type, name, ref, route_type, operator, network, color
        FROM routes
        WHERE osm_id = $1
        "#,
    )
    .bind(route_id)
    .fetch_optional(&pool)
    .await
    .map_err(internal_error)?;

    let route = route.ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Route not found".to_string(),
            }),
        )
    })?;

    let stops: Vec<RouteStop> = sqlx::query_as(
        r#"
        SELECT
            rs.sequence,
            rs.role,
            rs.stop_position_id,
            rs.platform_id,
            rs.station_id,
            s.name as station_name
        FROM route_stops rs
        LEFT JOIN stations s ON s.osm_id = rs.station_id
        WHERE rs.route_id = $1
        ORDER BY rs.sequence
        "#,
    )
    .bind(route_id)
    .fetch_all(&pool)
    .await
    .map_err(internal_error)?;

    Ok(Json(RouteDetail { route, stops }))
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RouteGeometry {
    pub route_id: i64,
    pub segments: Vec<Vec<[f64; 2]>>,
}

/// Get the geometry of a route as line segments
#[utoipa::path(
    get,
    path = "/api/routes/{route_id}/geometry",
    params(
        ("route_id" = i64, Path, description = "Route OSM ID")
    ),
    responses(
        (status = 200, description = "Route geometry", body = RouteGeometry),
        (status = 404, description = "Route not found", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    ),
    tag = "routes"
)]
pub async fn get_route_geometry(
    State(pool): State<PgPool>,
    Path(route_id): Path<i64>,
) -> Result<Json<RouteGeometry>, (StatusCode, Json<ErrorResponse>)> {
    // Try PostGIS geometry first (populated by PBF import via osm2pgsql)
    #[derive(FromRow)]
    struct PostgisRow {
        geojson: Option<String>,
    }

    let postgis_row: Option<PostgisRow> = sqlx::query_as(
        "SELECT ST_AsGeoJSON(geom)::text as geojson FROM routes WHERE osm_id = $1 AND geom IS NOT NULL",
    )
    .bind(route_id)
    .fetch_optional(&pool)
    .await
    .map_err(internal_error)?;

    if let Some(row) = postgis_row {
        if let Some(geojson_str) = row.geojson {
            // Parse GeoJSON MultiLineString — coordinates are Vec<Vec<[f64; 2]>>
            if let Ok(geojson) = serde_json::from_str::<serde_json::Value>(&geojson_str) {
                if let Some(coords) = geojson.get("coordinates") {
                    if let Ok(segments) = serde_json::from_value::<Vec<Vec<[f64; 2]>>>(coords.clone()) {
                        return Ok(Json(RouteGeometry {
                            route_id,
                            segments,
                        }));
                    }
                }
            }
        }
    }

    // Fallback: read from route_ways JSONB (legacy Overpass-imported routes)
    let exists: Option<(i64,)> = sqlx::query_as("SELECT osm_id FROM routes WHERE osm_id = $1")
        .bind(route_id)
        .fetch_optional(&pool)
        .await
        .map_err(internal_error)?;

    if exists.is_none() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Route not found".to_string(),
            }),
        ));
    }

    #[derive(FromRow)]
    struct GeometryRow {
        geometry: Option<serde_json::Value>,
    }

    let rows: Vec<GeometryRow> = sqlx::query_as(
        r#"
        SELECT geometry
        FROM route_ways
        WHERE route_id = $1
        ORDER BY sequence
        "#,
    )
    .bind(route_id)
    .fetch_all(&pool)
    .await
    .map_err(internal_error)?;

    let raw_segments: Vec<Vec<[f64; 2]>> = rows
        .into_iter()
        .filter_map(|row| {
            row.geometry.and_then(|g| {
                serde_json::from_value::<Vec<[f64; 2]>>(g)
                    .map_err(|e| {
                        error!("Failed to parse geometry JSON: {}", e);
                        e
                    })
                    .ok()
            })
        })
        .collect();

    // Normalize segment orientations so they form a continuous path.
    // OSM ways can be stored in either direction; we flip segments so that
    // each segment's start connects to the previous segment's end.
    let segments = normalize_segment_directions(raw_segments);

    Ok(Json(RouteGeometry {
        route_id,
        segments,
    }))
}

/// Normalize route geometry segments so they form a continuous path.
///
/// OSM ways can be stored in either direction. This function flips segments
/// as needed so that each segment's start point is closest to the previous
/// segment's end point, creating a consistent direction of travel.
fn normalize_segment_directions(segments: Vec<Vec<[f64; 2]>>) -> Vec<Vec<[f64; 2]>> {
    if segments.len() <= 1 {
        return segments;
    }

    let mut result: Vec<Vec<[f64; 2]>> = Vec::with_capacity(segments.len());

    // Keep the first segment as-is initially; we'll decide its orientation
    // based on how well it connects to the second segment.
    let first = &segments[0];
    let second = &segments[1];

    if first.len() >= 2 && second.len() >= 2 {
        let first_end = first.last().unwrap();
        let first_start = first.first().unwrap();
        let second_start = second.first().unwrap();
        let second_end = second.last().unwrap();

        // Check which orientation of the first segment connects better to the second
        let end_to_start = coord_dist_sq(first_end, second_start);
        let end_to_end = coord_dist_sq(first_end, second_end);
        let start_to_start = coord_dist_sq(first_start, second_start);
        let start_to_end = coord_dist_sq(first_start, second_end);

        let normal_min = end_to_start.min(end_to_end);
        let reversed_min = start_to_start.min(start_to_end);

        if reversed_min < normal_min {
            let mut reversed = first.clone();
            reversed.reverse();
            result.push(reversed);
        } else {
            result.push(first.clone());
        }
    } else {
        result.push(first.clone());
    }

    // For each subsequent segment, check if it needs to be reversed
    // to connect to the previous segment's end point.
    for segment in segments.iter().skip(1) {
        if segment.len() < 2 {
            result.push(segment.clone());
            continue;
        }

        let prev_end = result.last().unwrap().last().unwrap();
        let seg_start = segment.first().unwrap();
        let seg_end = segment.last().unwrap();

        let dist_normal = coord_dist_sq(prev_end, seg_start);
        let dist_reversed = coord_dist_sq(prev_end, seg_end);

        if dist_reversed < dist_normal {
            let mut reversed = segment.clone();
            reversed.reverse();
            result.push(reversed);
        } else {
            result.push(segment.clone());
        }
    }

    result
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct VisibleRoutesRequest {
    /// Bounding box: [west, south, east, north] in WGS84
    pub bbox: [f64; 4],
    /// Current zoom level — only routes with min_zoom <= zoom are returned
    pub zoom: i32,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct VisibleRoute {
    pub osm_id: i64,
    pub name: Option<String>,
    #[serde(rename = "ref")]
    pub route_ref: Option<String>,
    pub route_type: String,
    pub color: Option<String>,
    pub min_zoom: i32,
    pub segments: Vec<Vec<[f64; 2]>>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct VisibleRoutesResponse {
    pub routes: Vec<VisibleRoute>,
}

/// Get routes with geometry visible in the given viewport and zoom level
#[utoipa::path(
    post,
    path = "/api/routes/visible",
    request_body = VisibleRoutesRequest,
    responses(
        (status = 200, description = "Routes with geometry in viewport", body = VisibleRoutesResponse),
        (status = 400, description = "Invalid request parameters", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    ),
    tag = "routes"
)]
pub async fn get_visible_routes(
    State(pool): State<PgPool>,
    Json(request): Json<VisibleRoutesRequest>,
) -> Result<Json<VisibleRoutesResponse>, (StatusCode, Json<ErrorResponse>)> {
    let [west, south, east, north] = request.bbox;

    // Clamp zoom to valid MapLibre range
    let zoom = request.zoom.clamp(0, 24);

    // Reject oversized bounding boxes to prevent expensive full-table scans
    let bbox_area = (east - west).abs() * (north - south).abs();
    if bbox_area > 100.0 {
        return Err(bad_request("Bounding box area too large (max 100 square degrees)"));
    }

    // Simplify geometry based on zoom level to reduce response size.
    // Lower zoom = more simplification (in degrees, roughly).
    let simplify_tolerance = match zoom {
        0..=6 => 0.01,    // ~1km
        7..=9 => 0.002,   // ~200m
        10..=12 => 0.0005, // ~50m
        _ => 0.0,          // full detail
    };

    #[derive(FromRow)]
    struct Row {
        osm_id: i64,
        name: Option<String>,
        #[sqlx(rename = "ref")]
        route_ref: Option<String>,
        route_type: String,
        color: Option<String>,
        min_zoom: i32,
        geojson: Option<String>,
    }

    let rows: Vec<Row> = sqlx::query_as(
        r#"
        SELECT osm_id, name, ref, route_type, color, min_zoom,
               ST_AsGeoJSON(
                   CASE WHEN $6 > 0 THEN ST_Simplify(geom, $6) ELSE geom END
               )::text as geojson
        FROM routes
        WHERE geom IS NOT NULL
          AND min_zoom <= $5
          AND ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
        ORDER BY min_zoom ASC
        LIMIT 200
        "#,
    )
    .bind(west)
    .bind(south)
    .bind(east)
    .bind(north)
    .bind(zoom)
    .bind(simplify_tolerance)
    .fetch_all(&pool)
    .await
    .map_err(internal_error)?;

    let routes: Vec<VisibleRoute> = rows
        .into_iter()
        .filter_map(|row| {
            let segments = row.geojson.and_then(|gj| {
                let val: serde_json::Value = serde_json::from_str(&gj).ok()?;
                serde_json::from_value::<Vec<Vec<[f64; 2]>>>(val.get("coordinates")?.clone()).ok()
            }).unwrap_or_default();

            if segments.is_empty() { return None; }

            Some(VisibleRoute {
                osm_id: row.osm_id,
                name: row.name,
                route_ref: row.route_ref,
                route_type: row.route_type,
                color: row.color,
                min_zoom: row.min_zoom,
                segments,
            })
        })
        .collect();

    Ok(Json(VisibleRoutesResponse { routes }))
}

/// Squared distance between two [lon, lat] coordinates (for comparison only).
fn coord_dist_sq(a: &[f64; 2], b: &[f64; 2]) -> f64 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    dx * dx + dy * dy
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_empty() {
        assert!(normalize_segment_directions(vec![]).is_empty());
    }

    #[test]
    fn test_normalize_single_segment() {
        let segments = vec![vec![[0.0, 0.0], [1.0, 1.0]]];
        let result = normalize_segment_directions(segments.clone());
        assert_eq!(result, segments);
    }

    #[test]
    fn test_normalize_already_connected() {
        // A->B, B->C — already continuous
        let segments = vec![
            vec![[0.0, 0.0], [1.0, 0.0]],
            vec![[1.0, 0.0], [2.0, 0.0]],
            vec![[2.0, 0.0], [3.0, 0.0]],
        ];
        let result = normalize_segment_directions(segments.clone());
        assert_eq!(result, segments);
    }

    #[test]
    fn test_normalize_reversed_second_segment() {
        // A->B, C<-B (second reversed) → should become A->B, B->C
        let segments = vec![
            vec![[0.0, 0.0], [1.0, 0.0]],
            vec![[2.0, 0.0], [1.0, 0.0]], // reversed
        ];
        let result = normalize_segment_directions(segments);
        assert_eq!(result, vec![
            vec![[0.0, 0.0], [1.0, 0.0]],
            vec![[1.0, 0.0], [2.0, 0.0]], // flipped
        ]);
    }

    #[test]
    fn test_normalize_reversed_first_segment() {
        // B<-A, B->C — first should be flipped
        let segments = vec![
            vec![[1.0, 0.0], [0.0, 0.0]], // reversed
            vec![[1.0, 0.0], [2.0, 0.0]],
        ];
        let result = normalize_segment_directions(segments);
        assert_eq!(result, vec![
            vec![[0.0, 0.0], [1.0, 0.0]], // flipped
            vec![[1.0, 0.0], [2.0, 0.0]],
        ]);
    }

    #[test]
    fn test_normalize_multiple_reversed() {
        // A->B, C<-B, C->D, E<-D — mixed orientations
        let segments = vec![
            vec![[0.0, 0.0], [1.0, 0.0]],
            vec![[2.0, 0.0], [1.0, 0.0]], // reversed
            vec![[2.0, 0.0], [3.0, 0.0]],
            vec![[4.0, 0.0], [3.0, 0.0]], // reversed
        ];
        let result = normalize_segment_directions(segments);
        assert_eq!(result, vec![
            vec![[0.0, 0.0], [1.0, 0.0]],
            vec![[1.0, 0.0], [2.0, 0.0]],
            vec![[2.0, 0.0], [3.0, 0.0]],
            vec![[3.0, 0.0], [4.0, 0.0]],
        ]);
    }

    #[test]
    fn test_normalize_multi_point_segments() {
        // Segments with multiple internal points
        let segments = vec![
            vec![[0.0, 0.0], [0.5, 0.0], [1.0, 0.0]],
            vec![[2.0, 0.0], [1.5, 0.0], [1.0, 0.0]], // reversed
        ];
        let result = normalize_segment_directions(segments);
        assert_eq!(result[0], vec![[0.0, 0.0], [0.5, 0.0], [1.0, 0.0]]);
        assert_eq!(result[1], vec![[1.0, 0.0], [1.5, 0.0], [2.0, 0.0]]);
    }
}
