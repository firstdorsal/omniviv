use axum::{
    Json,
    extract::State,
    http::StatusCode,
};
use serde::Serialize;
use sqlx::{FromRow, PgPool};
use std::collections::HashMap;
use utoipa::ToSchema;

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
    #[allow(dead_code)]
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
    #[allow(dead_code)]
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
    #[allow(dead_code)]
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
    #[allow(dead_code)]
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
    /// Minimum zoom level at which this station should be shown
    pub min_zoom: i32,
    /// Transport modes serving this station (e.g. ["tram", "bus"])
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub transport_modes: Vec<String>,
    pub platforms: Vec<StationPlatform>,
    pub stop_positions: Vec<StationStopPosition>,
    pub platform_ways: Vec<StationPlatformWay>,
}

// NOTE: list_stations endpoint was removed — station list data is now served
// exclusively via Martin vector tiles (transit_stations SQL function in PostgreSQL).
// The min_zoom logic lives in the SQL function only.

/// Get a single station by its OSM ID
#[utoipa::path(
    get,
    path = "/api/stations/{osm_id}",
    responses(
        (status = 200, description = "Station details with platforms and stop positions", body = Station),
        (status = 404, description = "Station not found", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    ),
    tag = "stations"
)]
pub async fn get_station(
    State(state): State<StationsState>,
    axum::extract::Path(osm_id): axum::extract::Path<i64>,
) -> Result<Json<Station>, (StatusCode, Json<ErrorResponse>)> {
    // Get OSM ID -> GTFS stop ID mapping for this station's elements
    let osm_to_gtfs: HashMap<i64, Vec<String>> = {
        let rows: Vec<(i64, String)> = sqlx::query_as(
            "SELECT osm_id, gtfs_stop_id FROM osm_gtfs_stop_mapping WHERE osm_id IN (
                SELECT osm_id FROM platforms WHERE station_id = $1
                UNION
                SELECT osm_id FROM stop_positions WHERE station_id = $1
            ) ORDER BY osm_id, match_score DESC",
        )
        .bind(osm_id)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();

        let mut map: HashMap<i64, Vec<String>> = HashMap::new();
        for (osm_id, gtfs_stop_id) in rows {
            map.entry(osm_id).or_default().push(gtfs_stop_id);
        }
        map
    };

    let station_row: StationRow = sqlx::query_as(
        r#"
        SELECT s.osm_id, s.osm_type, s.name, s.ref_ifopt, s.lat, s.lon,
               COALESCE(s.tags->>'railway' IN ('station', 'halt'), false) AS is_rail,
               s.tags->>'railway' AS railway_tag
        FROM stations s
        WHERE s.osm_id = $1
        "#,
    )
    .bind(osm_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(internal_error)?
    .ok_or_else(|| (StatusCode::NOT_FOUND, Json(ErrorResponse { error: "Station not found".into() })))?;

    let platform_rows: Vec<PlatformRow> = sqlx::query_as(
        r#"
        SELECT station_id, osm_id, name, ref, ref_ifopt, lat, lon
        FROM platforms
        WHERE station_id = $1
        ORDER BY ref, name
        "#,
    )
    .bind(osm_id)
    .fetch_all(&state.pool)
    .await
    .map_err(internal_error)?;

    let stop_rows: Vec<StopPositionRow> = sqlx::query_as(
        r#"
        SELECT station_id, osm_id, name, ref, ref_ifopt, lat, lon, platform_id
        FROM stop_positions
        WHERE station_id = $1
        ORDER BY ref, name
        "#,
    )
    .bind(osm_id)
    .fetch_all(&state.pool)
    .await
    .map_err(internal_error)?;

    let platform_way_rows: Vec<PlatformWayRow> = sqlx::query_as(
        r#"
        SELECT station_id, osm_id, name, ref, ref_ifopt, lat, lon
        FROM platform_ways
        WHERE station_id = $1
        ORDER BY ref, name
        "#,
    )
    .bind(osm_id)
    .fetch_all(&state.pool)
    .await
    .map_err(internal_error)?;

    let platforms: Vec<StationPlatform> = platform_rows.into_iter().map(|row| {
        let mut gtfs_stop_ids = osm_to_gtfs.get(&row.osm_id).cloned().unwrap_or_default();
        gtfs_stop_ids.sort();
        gtfs_stop_ids.dedup();
        StationPlatform {
            osm_id: row.osm_id,
            name: row.name,
            platform_ref: row.platform_ref,
            ref_ifopt: row.ref_ifopt,
            lat: row.lat,
            lon: row.lon,
            gtfs_stop_ids,
        }
    }).collect();

    let stop_positions = stop_rows.into_iter().map(|row| {
        let mut gtfs_stop_ids = osm_to_gtfs.get(&row.osm_id).cloned().unwrap_or_default();
        gtfs_stop_ids.sort();
        gtfs_stop_ids.dedup();
        StationStopPosition {
            osm_id: row.osm_id,
            name: row.name,
            stop_ref: row.stop_ref,
            ref_ifopt: row.ref_ifopt,
            lat: row.lat,
            lon: row.lon,
            platform_id: row.platform_id,
            gtfs_stop_ids,
        }
    }).collect();

    let platform_ways = platform_way_rows.into_iter().map(|row| {
        StationPlatformWay {
            osm_id: row.osm_id,
            name: row.name,
            platform_ref: row.platform_ref,
            ref_ifopt: row.ref_ifopt,
            lat: row.lat,
            lon: row.lon,
        }
    }).collect();

    let transport_modes: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT DISTINCT r.route_type
        FROM route_stops rs
        JOIN routes r ON r.osm_id = rs.route_id
        WHERE rs.station_id = $1
        "#,
    )
    .bind(station_row.osm_id)
    .fetch_all(&state.pool)
    .await
    .map_err(internal_error)?;

    let platform_count = platforms.len();
    let is_station = station_row.railway_tag.as_deref() == Some("station");
    let is_halt = station_row.railway_tag.as_deref() == Some("halt");
    let name_lower = station_row.name.as_deref().unwrap_or("").to_lowercase();
    let is_hauptbahnhof = name_lower.contains("hauptbahnhof")
        || name_lower.contains(" hbf")
        || name_lower.ends_with(" hbf");
    let mode_count = transport_modes.len();
    let has_train = transport_modes.iter().any(|m| m == "train");

    // min_zoom — must match the transit_stations SQL function in 0001_init.sql
    let min_zoom = if is_hauptbahnhof {
        6
    } else if is_station && has_train && (mode_count >= 3 || platform_count >= 4) {
        8
    } else if is_station || is_halt || has_train {
        12
    } else {
        13
    };

    Ok(Json(Station {
        osm_id: station_row.osm_id,
        osm_type: station_row.osm_type,
        name: station_row.name,
        ref_ifopt: station_row.ref_ifopt,
        lat: station_row.lat,
        lon: station_row.lon,
        min_zoom,
        transport_modes,
        platforms,
        stop_positions,
        platform_ways,
    }))
}
