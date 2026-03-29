use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use std::collections::HashMap;
use utoipa::{IntoParams, ToSchema};

use crate::api::{ErrorResponse, internal_error};

/// Combined state for stations endpoint
#[derive(Clone)]
pub struct StationsState {
    pub pool: PgPool,
}

/// Internal struct for database row
#[derive(Debug, FromRow)]
struct StationRow {
    pub osm_id: i64,
    pub osm_type: String,
    pub name: Option<String>,
    pub ref_ifopt: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub is_rail: bool,
    pub railway_tag: Option<String>,
}

/// Platform info nested in station response
#[derive(Debug, Serialize, ToSchema)]
pub struct StationPlatform {
    pub osm_id: i64,
    pub name: Option<String>,
    #[serde(rename = "ref")]
    pub platform_ref: Option<String>,
    pub ref_ifopt: Option<String>,
    pub lat: f64,
    pub lon: f64,
    /// GTFS stop IDs matched to this platform via spatial matching
    pub gtfs_stop_ids: Vec<String>,
}

/// Internal row struct for platform query
#[derive(Debug, FromRow)]
struct PlatformRow {
    station_id: i64,
    osm_id: i64,
    name: Option<String>,
    #[sqlx(rename = "ref")]
    platform_ref: Option<String>,
    ref_ifopt: Option<String>,
    lat: f64,
    lon: f64,
}

/// Stop position info nested in station response
#[derive(Debug, Serialize, ToSchema)]
pub struct StationStopPosition {
    pub osm_id: i64,
    pub name: Option<String>,
    #[serde(rename = "ref")]
    pub stop_ref: Option<String>,
    pub ref_ifopt: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub platform_id: Option<i64>,
    /// GTFS stop IDs matched to this stop position via spatial matching
    pub gtfs_stop_ids: Vec<String>,
}

/// Internal row struct for stop position query
#[derive(Debug, FromRow)]
struct StopPositionRow {
    station_id: i64,
    osm_id: i64,
    name: Option<String>,
    #[sqlx(rename = "ref")]
    stop_ref: Option<String>,
    ref_ifopt: Option<String>,
    lat: f64,
    lon: f64,
    platform_id: Option<i64>,
}

/// Platform way info (physical platform outline centroid) nested in station response
#[derive(Debug, Serialize, ToSchema)]
pub struct StationPlatformWay {
    pub osm_id: i64,
    pub name: Option<String>,
    #[serde(rename = "ref")]
    pub platform_ref: Option<String>,
    pub ref_ifopt: Option<String>,
    pub lat: f64,
    pub lon: f64,
}

/// Internal row struct for platform way query
#[derive(Debug, FromRow)]
struct PlatformWayRow {
    station_id: i64,
    osm_id: i64,
    name: Option<String>,
    #[sqlx(rename = "ref")]
    platform_ref: Option<String>,
    ref_ifopt: Option<String>,
    lat: f64,
    lon: f64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct Station {
    pub osm_id: i64,
    pub osm_type: String,
    pub name: Option<String>,
    pub ref_ifopt: Option<String>,
    pub lat: f64,
    pub lon: f64,
    /// Minimum zoom level at which this station should be shown (6=rail, 10=tram, 13=bus)
    pub min_zoom: i32,
    pub platforms: Vec<StationPlatform>,
    pub stop_positions: Vec<StationStopPosition>,
    pub platform_ways: Vec<StationPlatformWay>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct StationListResponse {
    pub stations: Vec<Station>,
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct StationQuery {
    /// Bounding box: west,south,east,north (comma-separated)
    pub bbox: Option<String>,
}

/// List all stations that have platforms linked to them, optionally filtered by bounding box
#[utoipa::path(
    get,
    path = "/api/stations",
    params(StationQuery),
    responses(
        (status = 200, description = "List of stations with their platforms and stop positions", body = StationListResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    ),
    tag = "stations"
)]
pub async fn list_stations(
    State(state): State<StationsState>,
    Query(query): Query<StationQuery>,
) -> Result<Json<StationListResponse>, (StatusCode, Json<ErrorResponse>)> {
    // Get OSM ID -> GTFS stop ID mapping from the database
    let osm_to_gtfs: HashMap<i64, Vec<String>> = {
        let rows: Vec<(i64, String)> = sqlx::query_as(
            "SELECT osm_id, gtfs_stop_id FROM osm_gtfs_stop_mapping ORDER BY osm_id, match_score DESC",
        )
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();

        let mut map: HashMap<i64, Vec<String>> = HashMap::new();
        for (osm_id, gtfs_stop_id) in rows {
            map.entry(osm_id).or_default().push(gtfs_stop_id);
        }
        map
    };

    // Only return stations that have at least one platform or stop_position linked to them.
    // This filters out empty stop_areas (e.g. bus-only when only tram data is imported)
    // while still including stations that have stop_positions but no platform elements in OSM.
    let station_rows: Vec<StationRow> = if let Some(bbox_str) = &query.bbox {
        // Parse bbox: "west,south,east,north"
        let parts: Vec<f64> = bbox_str.split(',').filter_map(|s| s.trim().parse().ok()).collect();
        if parts.len() == 4 {
            sqlx::query_as(
                r#"
                SELECT DISTINCT s.osm_id, s.osm_type, s.name, s.ref_ifopt, s.lat, s.lon,
                       COALESCE(s.tags->>'railway' IN ('station', 'halt'), false) AS is_rail,
                       s.tags->>'railway' AS railway_tag
                FROM stations s
                WHERE s.lon >= $1 AND s.lat >= $2 AND s.lon <= $3 AND s.lat <= $4
                  AND (EXISTS (SELECT 1 FROM platforms WHERE station_id = s.osm_id)
                    OR EXISTS (SELECT 1 FROM stop_positions WHERE station_id = s.osm_id))
                ORDER BY s.name
                "#,
            )
            .bind(parts[0]).bind(parts[1]).bind(parts[2]).bind(parts[3])
            .fetch_all(&state.pool)
            .await
        } else {
            Ok(vec![])
        }
    } else {
        sqlx::query_as(
            r#"
            SELECT DISTINCT s.osm_id, s.osm_type, s.name, s.ref_ifopt, s.lat, s.lon,
                   COALESCE(s.tags->>'railway' IN ('station', 'halt'), false) AS is_rail,
                   s.tags->>'railway' AS railway_tag
            FROM stations s
            WHERE EXISTS (SELECT 1 FROM platforms WHERE station_id = s.osm_id)
               OR EXISTS (SELECT 1 FROM stop_positions WHERE station_id = s.osm_id)
               OR EXISTS (SELECT 1 FROM platform_ways WHERE station_id = s.osm_id)
            ORDER BY s.name
            "#,
        )
        .fetch_all(&state.pool)
        .await
    }
    .map_err(internal_error)?;

    if station_rows.is_empty() {
        return Ok(Json(StationListResponse { stations: vec![] }));
    }

    // Collect station IDs for batch queries
    let station_ids: Vec<i64> = station_rows.iter().map(|s| s.osm_id).collect();

    // Fetch all platforms for these stations in one query
    let platform_rows: Vec<PlatformRow> = sqlx::query_as(
        r#"
        SELECT station_id, osm_id, name, ref, ref_ifopt, lat, lon
        FROM platforms
        WHERE station_id = ANY($1::bigint[])
        ORDER BY ref, name
        "#,
    )
    .bind(&station_ids)
    .fetch_all(&state.pool)
    .await
    .map_err(internal_error)?;

    // Fetch all stop_positions for these stations in one query
    let stop_rows: Vec<StopPositionRow> = sqlx::query_as(
        r#"
        SELECT station_id, osm_id, name, ref, ref_ifopt, lat, lon, platform_id
        FROM stop_positions
        WHERE station_id = ANY($1::bigint[])
        ORDER BY ref, name
        "#,
    )
    .bind(&station_ids)
    .fetch_all(&state.pool)
    .await
    .map_err(internal_error)?;

    // Fetch all platform_ways for these stations in one query
    let platform_way_rows: Vec<PlatformWayRow> = sqlx::query_as(
        r#"
        SELECT station_id, osm_id, name, ref, ref_ifopt, lat, lon
        FROM platform_ways
        WHERE station_id = ANY($1::bigint[])
        ORDER BY ref, name
        "#,
    )
    .bind(&station_ids)
    .fetch_all(&state.pool)
    .await
    .map_err(internal_error)?;

    // Group platforms and stop_positions by station_id, adding GTFS stop IDs (deduplicated)
    let mut platforms_by_station: HashMap<i64, Vec<StationPlatform>> = HashMap::new();
    for row in platform_rows {
        let mut gtfs_stop_ids = osm_to_gtfs
            .get(&row.osm_id)
            .cloned()
            .unwrap_or_default();
        gtfs_stop_ids.sort();
        gtfs_stop_ids.dedup();
        platforms_by_station
            .entry(row.station_id)
            .or_default()
            .push(StationPlatform {
                osm_id: row.osm_id,
                name: row.name,
                platform_ref: row.platform_ref,
                ref_ifopt: row.ref_ifopt,
                lat: row.lat,
                lon: row.lon,
                gtfs_stop_ids,
            });
    }

    let mut stops_by_station: HashMap<i64, Vec<StationStopPosition>> = HashMap::new();
    for row in stop_rows {
        let mut gtfs_stop_ids = osm_to_gtfs
            .get(&row.osm_id)
            .cloned()
            .unwrap_or_default();
        gtfs_stop_ids.sort();
        gtfs_stop_ids.dedup();
        stops_by_station
            .entry(row.station_id)
            .or_default()
            .push(StationStopPosition {
                osm_id: row.osm_id,
                name: row.name,
                stop_ref: row.stop_ref,
                ref_ifopt: row.ref_ifopt,
                lat: row.lat,
                lon: row.lon,
                platform_id: row.platform_id,
                gtfs_stop_ids,
            });
    }

    let mut platform_ways_by_station: HashMap<i64, Vec<StationPlatformWay>> = HashMap::new();
    for row in platform_way_rows {
        platform_ways_by_station
            .entry(row.station_id)
            .or_default()
            .push(StationPlatformWay {
                osm_id: row.osm_id,
                name: row.name,
                platform_ref: row.platform_ref,
                ref_ifopt: row.ref_ifopt,
                lat: row.lat,
                lon: row.lon,
            });
    }

    // Build final response
    let stations = station_rows
        .into_iter()
        .map(|row| Station {
            osm_id: row.osm_id,
            osm_type: row.osm_type,
            name: row.name,
            ref_ifopt: row.ref_ifopt,
            lat: row.lat,
            lon: row.lon,
            min_zoom: match row.railway_tag.as_deref() {
                Some("station") => 6,  // Major rail stations
                Some("halt") => 9,     // Minor halts (S-Bahn etc.)
                _ => 11,               // Tram/bus stops
            },
            platforms: platforms_by_station.remove(&row.osm_id).unwrap_or_default(),
            stop_positions: stops_by_station.remove(&row.osm_id).unwrap_or_default(),
            platform_ways: platform_ways_by_station.remove(&row.osm_id).unwrap_or_default(),
        })
        .collect();

    Ok(Json(StationListResponse { stations }))
}
