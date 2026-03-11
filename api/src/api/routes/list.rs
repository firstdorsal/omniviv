use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use tracing::error;
use utoipa::{IntoParams, ToSchema};

use crate::api::{ErrorResponse, internal_error};

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
    pub area_id: Option<i64>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RouteListResponse {
    pub routes: Vec<Route>,
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct RouteQuery {
    /// Filter by area ID
    pub area_id: Option<i64>,
    /// Filter by route type (e.g., "tram", "bus")
    pub route_type: Option<String>,
}

/// List all routes, optionally filtered by area or type
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
    let routes: Vec<Route> = match (query.area_id, query.route_type.as_deref()) {
        (Some(area_id), Some(route_type)) => {
            sqlx::query_as(
                r#"
                SELECT osm_id, osm_type, name, ref, route_type, operator, network, color, area_id
                FROM routes
                WHERE area_id = $1 AND route_type = $2
                ORDER BY ref, name
                "#,
            )
            .bind(area_id)
            .bind(route_type)
            .fetch_all(&pool)
            .await
        }
        (Some(area_id), None) => {
            sqlx::query_as(
                r#"
                SELECT osm_id, osm_type, name, ref, route_type, operator, network, color, area_id
                FROM routes
                WHERE area_id = $1
                ORDER BY ref, name
                "#,
            )
            .bind(area_id)
            .fetch_all(&pool)
            .await
        }
        (None, Some(route_type)) => {
            sqlx::query_as(
                r#"
                SELECT osm_id, osm_type, name, ref, route_type, operator, network, color, area_id
                FROM routes
                WHERE route_type = $1
                ORDER BY ref, name
                "#,
            )
            .bind(route_type)
            .fetch_all(&pool)
            .await
        }
        (None, None) => {
            sqlx::query_as(
                r#"
                SELECT osm_id, osm_type, name, ref, route_type, operator, network, color, area_id
                FROM routes
                ORDER BY ref, name
                "#,
            )
            .fetch_all(&pool)
            .await
        }
    }
    .map_err(internal_error)?;

    Ok(Json(RouteListResponse { routes }))
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
        SELECT osm_id, osm_type, name, ref, route_type, operator, network, color, area_id
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
    // Check if route exists
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
