use axum::{extract::State, Json};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use utoipa::ToSchema;

use crate::api::ErrorResponse;
use crate::api::state::AppState;
use crate::api::utils::{ifopt_station_prefix, parse_reference_time};
use crate::providers::timetables::gtfs::realtime;
use crate::sync::{Departure, osm_stop_id, parse_osm_stop_id};

/// How many minutes of past departures to keep so that recent arrivals remain visible.
/// See also: `SCHEDULE_PAST_WINDOW_MINUTES` in `realtime.rs` (10 min for schedule building).
const PAST_GRACE_MINUTES: i64 = 5;

/// Per-stop board queries use a longer time horizon than the main departure list
/// so that events for the rest of the day (and into the next morning) are visible.
const STOP_BOARD_HORIZON_MINUTES: i64 = 720; // 12 hours

/// Filter out departures whose destination is the same station as the queried stop.
/// E.g. Line 4 "towards Hauptbahnhof" should not appear at Hauptbahnhof's departure monitor.
fn filter_same_station_destinations(departures: Vec<Departure>, stop_ifopt: &str) -> Vec<Departure> {
    let station_prefix = match ifopt_station_prefix(stop_ifopt) {
        Some(p) => p,
        None => return departures,
    };
    departures
        .into_iter()
        .filter(|d| {
            match &d.destination_id {
                Some(dest_id) => ifopt_station_prefix(dest_id) != Some(station_prefix),
                None => true,
            }
        })
        .collect()
}

/// Filter departures by the line numbers (refs) of OSM routes serving this platform.
///
/// OSM route relations tell us exactly which lines stop at each platform.
/// For example, A3 at Königsplatz only has "Straßenbahn 4" → only tram 4 departures.
/// This is more precise than keyword matching on destination names.
async fn filter_by_direction(
    departures: Vec<Departure>,
    stop_id: &str,
    pool: &PgPool,
) -> Vec<Departure> {
    // Load line numbers (refs) of OSM routes serving this platform, grouped by type.
    let rows: Vec<(String, String)> = if let Some(osm_id) = parse_osm_stop_id(stop_id) {
        match sqlx::query_as(
            r#"
            SELECT DISTINCT r.ref, r.route_type
            FROM route_stops rs
            JOIN routes r ON r.osm_id = rs.route_id
            WHERE r.ref IS NOT NULL
              AND (rs.platform_id = $1 OR rs.stop_position_id = $1)
            "#,
        )
        .bind(osm_id)
        .fetch_all(pool)
        .await
        {
            Ok(rows) => rows,
            Err(_) => return departures,
        }
    } else {
        match sqlx::query_as(
            r#"
            SELECT DISTINCT r.ref, r.route_type
            FROM route_stops rs
            JOIN routes r ON r.osm_id = rs.route_id
            LEFT JOIN platforms p ON p.osm_id = rs.platform_id
            LEFT JOIN stop_positions sp ON sp.osm_id = rs.stop_position_id
            WHERE r.ref IS NOT NULL
              AND (p.ref_ifopt = $1 OR sp.ref_ifopt = $1)
            "#,
        )
        .bind(stop_id)
        .fetch_all(pool)
        .await
        {
            Ok(rows) => rows,
            Err(_) => return departures,
        }
    };

    if rows.is_empty() {
        return departures;
    }

    // Build allowed line numbers per transport type
    // e.g. tram: {"4"}, bus: {"44", "91"}
    let mut allowed_lines_by_type: HashMap<String, HashSet<String>> = HashMap::new();
    for (route_ref, route_type) in &rows {
        allowed_lines_by_type
            .entry(route_type.clone())
            .or_default()
            .insert(route_ref.clone());
    }

    fn gtfs_to_osm(gtfs_type: i32) -> &'static str {
        match gtfs_type {
            0 => "tram",
            1 => "subway",
            2 => "train",
            3 => "bus",
            4 => "ferry",
            7 => "bus",
            _ => "bus",
        }
    }

    // Collect all allowed line numbers across all types
    let _all_allowed: HashSet<&String> = allowed_lines_by_type.values().flat_map(|s| s.iter()).collect();

    // Filter: only keep departures whose line number matches an OSM route at this platform.
    // BUT: if NO departures match any OSM route (e.g. replacement service B6 for Tram 6),
    // then let ALL departures through — better to show something than nothing.
    let filtered: Vec<Departure> = departures
        .iter()
        .filter(|d| {
            let osm_type = d.gtfs_route_type.map(|t| gtfs_to_osm(t)).unwrap_or("bus");
            match allowed_lines_by_type.get(osm_type) {
                Some(allowed) => allowed.contains(&d.line_number),
                None => true,
            }
        })
        .cloned()
        .collect();

    // If filtering removed ALL departures, the GTFS data doesn't match OSM
    // (e.g. replacement bus service). Return unfiltered in that case.
    if filtered.is_empty() && !departures.is_empty() {
        return departures;
    }
    filtered
}

/// Filter out departures that are too far in the past relative to the given reference time.
/// Departures within [`PAST_GRACE_MINUTES`] of the reference time are kept.
/// Fill in OSM route colors for departures that have no GTFS color.
/// Queries the OSM route serving this stop with the matching line number and route type.
///
/// Supports both IFOPT-based lookup (e.g. "de:09761:101:31:A3") and OSM ID-based
/// lookup (e.g. "osm:12345678"). For OSM IDs, joins directly through the
/// platform/stop_position tables by `osm_id`.
async fn fill_osm_route_colors(departures: &mut [Departure], stop_id: &str, pool: &PgPool) {
    // Collect distinct (line_number, gtfs_route_type) pairs that need colors
    let needs_color: Vec<(String, Option<i32>)> = departures
        .iter()
        .filter(|d| d.color.is_none())
        .map(|d| (d.line_number.clone(), d.gtfs_route_type))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();

    if needs_color.is_empty() {
        return;
    }

    // Look up colors from OSM routes serving this stop
    let gtfs_to_osm = |gt: i32| -> &str {
        match gt { 0 => "tram", 1 => "subway", 2 => "train", 3 => "bus", 4 => "ferry", _ => "bus" }
    };

    #[derive(sqlx::FromRow)]
    struct ColorRow {
        line_ref: String,
        route_type: String,
        color: String,
    }

    let color_rows: Vec<ColorRow> = if let Some(osm_id) = parse_osm_stop_id(stop_id) {
        // OSM ID-based: look up routes by the platform/stop_position osm_id directly
        sqlx::query_as(
            r#"
            SELECT DISTINCT r.ref AS line_ref, r.route_type, r.color
            FROM routes r
            JOIN route_stops rs ON rs.route_id = r.osm_id
            WHERE r.color IS NOT NULL
              AND (rs.platform_id = $1 OR rs.stop_position_id = $1)
            "#,
        )
        .bind(osm_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
    } else {
        // IFOPT-based: look up routes by ref_ifopt on platforms/stop_positions
        sqlx::query_as(
            r#"
            SELECT DISTINCT r.ref AS line_ref, r.route_type, r.color
            FROM routes r
            JOIN route_stops rs ON rs.route_id = r.osm_id
            LEFT JOIN platforms p ON p.osm_id = rs.platform_id
            LEFT JOIN stop_positions sp ON sp.osm_id = rs.stop_position_id
            WHERE r.color IS NOT NULL
              AND COALESCE(p.ref_ifopt, sp.ref_ifopt) = $1
            "#,
        )
        .bind(stop_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
    };

    // Build lookup: (line_ref, route_type) -> color
    let mut color_map = std::collections::HashMap::new();
    for row in &color_rows {
        color_map.entry((row.line_ref.as_str(), row.route_type.as_str())).or_insert(&row.color);
    }

    // Apply colors to departures
    for dep in departures.iter_mut() {
        if dep.color.is_some() {
            continue;
        }
        let osm_type = dep.gtfs_route_type.map(|t| gtfs_to_osm(t)).unwrap_or("bus");
        if let Some(color) = color_map.get(&(dep.line_number.as_str(), osm_type)) {
            dep.color = Some((*color).clone());
        }
    }
}

/// Fill colors from OSM routes nearest to the given coordinates.
/// Used for stops without IFOPT (e.g. München U-Bahn).
async fn fill_osm_route_colors_by_coords(departures: &mut [Departure], lat: f64, lon: f64, pool: &PgPool) {
    let needs_color: Vec<(String, Option<i32>)> = departures
        .iter()
        .filter(|d| d.color.is_none())
        .map(|d| (d.line_number.clone(), d.gtfs_route_type))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();

    if needs_color.is_empty() {
        return;
    }

    let gtfs_to_osm = |gt: i32| -> &str {
        match gt { 0 => "tram", 1 => "subway", 2 => "train", 3 => "bus", 4 => "ferry", _ => "bus" }
    };

    #[derive(sqlx::FromRow)]
    struct ColorRow {
        line_ref: String,
        route_type: String,
        color: String,
    }

    // Find OSM routes whose geometry passes near these coordinates.
    // Use bbox pre-filter (GIST index) then precise distance check on candidates.
    let buffer = 0.003; // ~300m in degrees
    let color_rows: Vec<ColorRow> = sqlx::query_as(
        r#"
        SELECT DISTINCT r.ref AS line_ref, r.route_type, r.color
        FROM routes r
        WHERE r.color IS NOT NULL AND r.ref IS NOT NULL
          AND r.geom IS NOT NULL
          AND r.geom && ST_Expand(ST_SetSRID(ST_MakePoint($1, $2), 4326), $3)
          AND ST_Distance(r.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)) < $3
        "#,
    )
    .bind(lon)
    .bind(lat)
    .bind(buffer)
    .fetch_all(pool)
    .await
    .unwrap_or_default();

    let mut color_map = std::collections::HashMap::new();
    for row in &color_rows {
        color_map.entry((row.line_ref.as_str(), row.route_type.as_str())).or_insert(&row.color);
    }

    for dep in departures.iter_mut() {
        if dep.color.is_some() { continue; }
        let osm_type = dep.gtfs_route_type.map(|t| gtfs_to_osm(t)).unwrap_or("bus");
        if let Some(color) = color_map.get(&(dep.line_number.as_str(), osm_type)) {
            dep.color = Some((*color).clone());
        }
    }
}

fn filter_past_departures(departures: Vec<Departure>, reference_time: DateTime<Utc>) -> Vec<Departure> {
    let cutoff = reference_time - Duration::minutes(PAST_GRACE_MINUTES);
    departures
        .into_iter()
        .filter(|d| {
            let time = d.estimated_time.unwrap_or(d.planned_time);
            time > cutoff
        })
        .collect()
}


#[derive(Debug, Deserialize, ToSchema)]
pub struct StopDeparturesRequest {
    pub stop_ifopt: String,
    /// Optional reference time (ISO 8601/RFC 3339) for time simulation.
    /// When provided, departures are computed from the static GTFS schedule
    /// around this time instead of using live real-time data.
    pub reference_time: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct StopDeparturesResponse {
    pub stop_ifopt: String,
    /// The GTFS stop ID mapped to this IFOPT (if any)
    pub mapped_gtfs_stop_id: Option<String>,
    pub departures: Vec<Departure>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct GtfsStopDeparturesRequest {
    pub gtfs_stop_id: String,
    /// Optional reference time (ISO 8601/RFC 3339) for time simulation.
    pub reference_time: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct GtfsStopDeparturesResponse {
    pub gtfs_stop_id: String,
    pub departures: Vec<Departure>,
}

/// Get departures for a specific stop by IFOPT ID or OSM stop ID.
///
/// Accepts both IFOPT strings (e.g. "de:09761:101:31:A3") and OSM-based
/// identifiers (e.g. "osm:12345678") in the `stop_ifopt` field.
///
/// For OSM IDs, queries `osm_gtfs_stop_mapping` by `osm_id`.
/// For IFOPT strings, queries `osm_gtfs_stop_mapping` by `ref_ifopt`,
/// falling back to the legacy `ifopt_gtfs_mapping` table.
#[utoipa::path(
    post,
    path = "/api/departures/by-stop",
    request_body = StopDeparturesRequest,
    responses(
        (status = 200, description = "Departures for the stop", body = StopDeparturesResponse),
        (status = 400, description = "Bad request", body = ErrorResponse)
    ),
    tag = "departures"
)]
pub async fn get_departures_by_stop(
    State(state): State<AppState>,
    Json(request): Json<StopDeparturesRequest>,
) -> Json<StopDeparturesResponse> {
    let simulated_time = parse_reference_time(&request.reference_time);

    let ref_time = simulated_time.unwrap_or_else(Utc::now);

    // Resolve the stop_ifopt to a canonical stop_id used for departure store
    // and schedule lookups, and find the mapped GTFS stop ID.
    let stop_id = &request.stop_ifopt;

    // Look up ALL mapped GTFS stop IDs for this stop.
    // A platform may have multiple stop_positions, each mapped to different GTFS stops
    // serving different lines (e.g., one for tram, one for bus at the same platform).
    let all_gtfs_ids: Vec<String> = if let Some(osm_id) = parse_osm_stop_id(stop_id) {
        sqlx::query_scalar(
            "SELECT DISTINCT gtfs_stop_id FROM osm_gtfs_stop_mapping WHERE osm_id = $1",
        )
        .bind(osm_id)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default()
    } else {
        let from_new: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT gtfs_stop_id FROM osm_gtfs_stop_mapping WHERE ref_ifopt = $1",
        )
        .bind(stop_id)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();

        if !from_new.is_empty() {
            from_new
        } else {
            sqlx::query_scalar(
                "SELECT gtfs_stop_id FROM ifopt_gtfs_mapping WHERE ifopt = $1",
            )
            .bind(stop_id)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default()
        }
    };

    let mapped_gtfs_stop_id = all_gtfs_ids.first().cloned();

    // Build stop IDs set including all GTFS stop IDs for this IFOPT.
    // A platform may have multiple stop_positions, each mapped to different GTFS stops.
    let mut stop_ids = HashSet::from([stop_id.clone()]);
    // Also add osm-based IDs so the schedule cache resolves all GTFS stops
    for gtfs_id in &all_gtfs_ids {
        // Find osm_ids that map to this gtfs_stop_id
        let osm_ids: Vec<i64> = sqlx::query_scalar(
            "SELECT osm_id FROM osm_gtfs_stop_mapping WHERE gtfs_stop_id = $1 AND ref_ifopt = $2",
        )
        .bind(gtfs_id)
        .bind(stop_id)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();
        for oid in osm_ids {
            stop_ids.insert(osm_stop_id(oid));
        }
    }

    let mut departures = if simulated_time.is_none() {
        // Start with real-time departure store (has estimated times and delays)
        let store = state.departure_store.read().await;
        // Collect from all matching stop IDs
        let mut deps = Vec::new();
        for sid in &stop_ids {
            if let Some(d) = store.get(sid) {
                deps.extend(d.clone());
            }
        }
        deps
    } else {
        Vec::new()
    };

    // Supplement with schedule-based departures using GTFS stop IDs directly.
    // This ensures all mapped GTFS stops are included (not just the first one).
    let gtfs_stop_set: HashSet<String> = all_gtfs_ids.iter().cloned().collect();
    let schedule_result = crate::providers::timetables::gtfs::static_data::db::build_schedule_from_db_by_gtfs_stop(
        &state.pool,
        &gtfs_stop_set,
    ).await;
    match schedule_result {
        Ok(schedule) => {
            let time_horizon = Duration::minutes(STOP_BOARD_HORIZON_MINUTES);
            // Include GTFS stop IDs themselves as lookup keys since
            // build_schedule_from_db_by_gtfs_stop keys departures by GTFS stop ID
            let mut combined_stop_ids = stop_ids.clone();
            for gtfs_id in &all_gtfs_ids {
                combined_stop_ids.insert(gtfs_id.clone());
            }
            let schedule_departures = realtime::compute_schedule_departures(
                &schedule,
                &combined_stop_ids,
                ref_time,
                time_horizon,
                state.timezone,
            );
            let mut schedule_deps: Vec<Departure> = Vec::new();
            for sid in &combined_stop_ids {
                if let Some(deps) = schedule_departures.get(sid.as_str()) {
                    schedule_deps.extend(deps.clone());
                }
            }

            // Collect trip_ids already in real-time data to avoid duplicates
            let rt_trip_ids: HashSet<String> = departures.iter()
                .filter_map(|d| d.trip_id.clone())
                .collect();

            for departure in schedule_deps {
                if let Some(ref tid) = departure.trip_id {
                    if !rt_trip_ids.contains(tid) {
                        departures.push(departure);
                    }
                } else {
                    departures.push(departure);
                }
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, stop_id = %stop_id, "Failed to build schedule from DB for stop departures");
        }
    }

    departures.sort_by(|a, b| a.planned_time.cmp(&b.planned_time));
    let departures = filter_past_departures(departures, ref_time);
    let departures = filter_same_station_destinations(departures, stop_id);
    let mut departures = filter_by_direction(departures, stop_id, &state.pool).await;

    // Fill in colors from OSM route data for departures without GTFS color.
    // Looks up the OSM route that serves this stop with the matching line number.
    fill_osm_route_colors(&mut departures, stop_id, &state.pool).await;

    Json(StopDeparturesResponse {
        stop_ifopt: request.stop_ifopt,
        mapped_gtfs_stop_id,
        departures,
    })
}

/// Get departures for a specific GTFS stop by its stop_id, bypassing IFOPT mapping
#[utoipa::path(
    post,
    path = "/api/departures/by-gtfs-stop",
    request_body = GtfsStopDeparturesRequest,
    responses(
        (status = 200, description = "Departures for the GTFS stop", body = GtfsStopDeparturesResponse),
        (status = 400, description = "Bad request", body = ErrorResponse)
    ),
    tag = "departures"
)]
pub async fn get_departures_by_gtfs_stop(
    State(state): State<AppState>,
    Json(request): Json<GtfsStopDeparturesRequest>,
) -> Json<GtfsStopDeparturesResponse> {
    let simulated_time = parse_reference_time(&request.reference_time);
    let ref_time = simulated_time.unwrap_or_else(Utc::now);

    let mut stop_ids = HashSet::new();
    stop_ids.insert(request.gtfs_stop_id.clone());

    // Always compute schedule-based departures with the longer stop board horizon
    let departures =
        match state.schedule_cache.get_or_build_by_gtfs_stop(&state.pool, &stop_ids).await {
            Ok(schedule) => {
                let time_horizon = Duration::minutes(STOP_BOARD_HORIZON_MINUTES);
                let all_departures = realtime::compute_schedule_departures(
                    &schedule,
                    &stop_ids,
                    ref_time,
                    time_horizon,
                    state.timezone,
                );
                all_departures
                    .get(&request.gtfs_stop_id)
                    .cloned()
                    .unwrap_or_default()
            }
            Err(e) => {
                tracing::warn!(error = %e, gtfs_stop_id = %request.gtfs_stop_id, "Failed to build schedule from DB for GTFS stop departures");
                Vec::new()
            }
        };

    let departures = filter_past_departures(departures, ref_time);

    Json(GtfsStopDeparturesResponse {
        gtfs_stop_id: request.gtfs_stop_id,
        departures,
    })
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CoordinateDeparturesRequest {
    pub lat: f64,
    pub lon: f64,
    pub reference_time: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct OsmIdDeparturesRequest {
    pub osm_id: i64,
    pub reference_time: Option<String>,
}

/// Find departures for an OSM stop position/platform by its osm_id.
///
/// Primary path: query `osm_gtfs_stop_mapping` directly for the GTFS stop ID.
/// This is the most efficient path and works for all mapped stops regardless of
/// whether they have IFOPT tags.
///
/// Fallback: if no mapping exists, look up coordinates from the OSM element and
/// use coordinate-based GTFS stop lookup.
#[utoipa::path(
    post,
    path = "/api/departures/by-osm-id",
    request_body = OsmIdDeparturesRequest,
    responses(
        (status = 200, description = "Departures for OSM stop", body = GtfsStopDeparturesResponse),
    ),
    tag = "departures"
)]
pub async fn get_departures_by_osm_id(
    State(state): State<AppState>,
    Json(request): Json<OsmIdDeparturesRequest>,
) -> Json<GtfsStopDeparturesResponse> {
    // Primary path: query osm_gtfs_stop_mapping directly for this OSM ID
    #[derive(sqlx::FromRow)]
    struct MappingRow {
        gtfs_stop_id: String,
        ref_ifopt: Option<String>,
    }

    let mapping: Option<MappingRow> = sqlx::query_as(
        "SELECT gtfs_stop_id, ref_ifopt FROM osm_gtfs_stop_mapping WHERE osm_id = $1 LIMIT 1",
    )
    .bind(request.osm_id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();

    if let Some(mapping) = mapping {
        // Use the osm:{id} stop identifier for the departure store and direction/color lookups
        let stop_id = osm_stop_id(request.osm_id);

        // Delegate to get_departures_by_stop which handles schedule cache, RT data,
        // direction filtering, and color filling. If the stop has an IFOPT, prefer that
        // as the departure store key since existing RT data is indexed by IFOPT.
        let lookup_id = mapping.ref_ifopt.clone().unwrap_or_else(|| stop_id.clone());

        let response = get_departures_by_stop(
            State(state.clone()),
            Json(StopDeparturesRequest {
                stop_ifopt: lookup_id,
                reference_time: request.reference_time.clone(),
            }),
        )
        .await;
        let data = response.0;

        // If the IFOPT-based lookup returned a GTFS stop ID, use it; otherwise use
        // the one from our direct mapping query.
        let gtfs_stop_id = data.mapped_gtfs_stop_id
            .unwrap_or(mapping.gtfs_stop_id);

        return Json(GtfsStopDeparturesResponse {
            gtfs_stop_id,
            departures: data.departures,
        });
    }

    // Fallback: no mapping found — look up coordinates from OSM element and use
    // coordinate-based GTFS stop lookup
    #[derive(sqlx::FromRow)]
    struct OsmStopCoords {
        lat: f64,
        lon: f64,
    }

    let coords: Option<OsmStopCoords> = sqlx::query_as(
        r#"
        SELECT lat, lon FROM stop_positions WHERE osm_id = $1
        UNION ALL
        SELECT lat, lon FROM platforms WHERE osm_id = $1
        LIMIT 1
        "#,
    )
    .bind(request.osm_id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();

    match coords {
        Some(coords) => {
            get_departures_by_coordinates(
                State(state),
                Json(CoordinateDeparturesRequest {
                    lat: coords.lat,
                    lon: coords.lon,
                    reference_time: request.reference_time,
                }),
            )
            .await
        }
        None => {
            tracing::debug!(osm_id = request.osm_id, "No OSM stop found for osm_id");
            Json(GtfsStopDeparturesResponse {
                gtfs_stop_id: String::new(),
                departures: vec![],
            })
        }
    }
}

/// Find the nearest GTFS stop by coordinates and return its departures.
/// Used for stops without ref:IFOPT in OSM (e.g. München U-Bahn).
#[utoipa::path(
    post,
    path = "/api/departures/by-coordinates",
    request_body = CoordinateDeparturesRequest,
    responses(
        (status = 200, description = "Departures for nearest stop", body = GtfsStopDeparturesResponse),
    ),
    tag = "departures"
)]
pub async fn get_departures_by_coordinates(
    State(state): State<AppState>,
    Json(request): Json<CoordinateDeparturesRequest>,
) -> Json<GtfsStopDeparturesResponse> {
    // Find the nearest GTFS stop that has actual departures (stop_times)
    let nearest: Option<(String,)> = sqlx::query_as(
        r#"
        SELECT stop_id FROM gtfs_stops
        WHERE geom IS NOT NULL
          AND EXISTS (SELECT 1 FROM gtfs_stop_times WHERE stop_id = gtfs_stops.stop_id LIMIT 1)
        ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
        LIMIT 1
        "#,
    )
    .bind(request.lon)
    .bind(request.lat)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();

    let gtfs_stop_id = match nearest {
        Some((id,)) => id,
        None => {
            return Json(GtfsStopDeparturesResponse {
                gtfs_stop_id: String::new(),
                departures: vec![],
            });
        }
    };

    // Reuse the existing GTFS stop departure logic
    let simulated_time = parse_reference_time(&request.reference_time);
    let ref_time = simulated_time.unwrap_or_else(Utc::now);

    let mut stop_ids = HashSet::new();
    stop_ids.insert(gtfs_stop_id.clone());

    let departures =
        match state.schedule_cache.get_or_build_by_gtfs_stop(&state.pool, &stop_ids).await {
            Ok(schedule) => {
                let time_horizon = Duration::minutes(STOP_BOARD_HORIZON_MINUTES);
                let all_departures = realtime::compute_schedule_departures(
                    &schedule,
                    &stop_ids,
                    ref_time,
                    time_horizon,
                    state.timezone,
                );
                let mut deps = all_departures.get(&gtfs_stop_id).cloned().unwrap_or_default();
                deps.sort_by(|a, b| a.planned_time.cmp(&b.planned_time));
                filter_past_departures(deps, ref_time)
            }
            Err(e) => {
                tracing::warn!(error = %e, "Failed to build schedule for coordinate-based departures");
                vec![]
            }
        };

    // Fill colors from nearest OSM routes by geometry proximity
    let mut departures = departures;
    fill_osm_route_colors_by_coords(&mut departures, request.lat, request.lon, &state.pool).await;

    Json(GtfsStopDeparturesResponse {
        gtfs_stop_id,
        departures,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::EventType;
    fn parse_dt(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn make_departure(planned_time: &str, estimated_time: Option<&str>) -> Departure {
        Departure {
            stop_ifopt: "de:08111:6115".to_string(),
            event_type: EventType::Departure,
            line_number: "U1".to_string(),
            destination: "Central Station".to_string(),
            destination_id: None,
            planned_time: parse_dt(planned_time),
            estimated_time: estimated_time.map(|s| parse_dt(s)),
            delay_minutes: None,
            platform: None,
            trip_id: Some("trip_1".to_string()),
            cancelled: false,
            gtfs_route_type: Some(1),
            color: None,
        }
    }

    // --- filter_past_departures tests ---

    #[test]
    fn test_filter_past_departures_removes_past() {
        let reference = DateTime::parse_from_rfc3339("2026-03-10T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let departures = vec![
            make_departure("2026-03-10T11:00:00Z", None), // 1 hour in the past
            make_departure("2026-03-10T13:00:00Z", None), // 1 hour in the future
        ];

        let result = filter_past_departures(departures, reference);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].planned_time, parse_dt("2026-03-10T13:00:00Z"));
    }

    #[test]
    fn test_filter_past_departures_keeps_future() {
        let reference = DateTime::parse_from_rfc3339("2026-03-10T08:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let departures = vec![
            make_departure("2026-03-10T09:00:00Z", None),
            make_departure("2026-03-10T10:00:00Z", None),
            make_departure("2026-03-10T11:00:00Z", None),
        ];

        let result = filter_past_departures(departures, reference);
        assert_eq!(result.len(), 3);
    }

    #[test]
    fn test_filter_past_departures_uses_estimated_time_when_available() {
        let reference = DateTime::parse_from_rfc3339("2026-03-10T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        // Planned in the future, but estimated in the past
        let dep_past_estimated = make_departure(
            "2026-03-10T13:00:00Z",
            Some("2026-03-10T11:00:00Z"),
        );
        // Planned in the past, but estimated in the future
        let dep_future_estimated = make_departure(
            "2026-03-10T11:00:00Z",
            Some("2026-03-10T13:00:00Z"),
        );

        let departures = vec![dep_past_estimated, dep_future_estimated];
        let result = filter_past_departures(departures, reference);

        // Only the one with future estimated time should remain
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].estimated_time,
            Some(parse_dt("2026-03-10T13:00:00Z"))
        );
    }

    #[test]
    fn test_filter_past_departures_exact_reference_time_is_kept() {
        let reference = DateTime::parse_from_rfc3339("2026-03-10T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let departures = vec![
            make_departure("2026-03-10T12:00:00Z", None), // exactly at reference time
        ];

        let result = filter_past_departures(departures, reference);
        // time == reference_time is within the 5-minute grace period, so it's kept
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn test_filter_past_departures_within_grace_period_is_kept() {
        let reference = DateTime::parse_from_rfc3339("2026-03-10T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let departures = vec![
            make_departure("2026-03-10T11:57:00Z", None), // 3 minutes ago — within grace
            make_departure("2026-03-10T11:54:00Z", None), // 6 minutes ago — beyond grace
        ];

        let result = filter_past_departures(departures, reference);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].planned_time, parse_dt("2026-03-10T11:57:00Z"));
    }

    // --- filter_same_station_destinations tests ---

    #[test]
    fn test_filter_same_station_removes_loop_destination() {
        let mut departure = make_departure("2026-03-10T13:00:00Z", None);
        departure.stop_ifopt = "de:09761:10:1:A3".to_string();
        departure.destination_id = Some("de:09761:10:1:A4".to_string()); // same station, different platform

        let result = filter_same_station_destinations(vec![departure], "de:09761:10:1:A3");
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn test_filter_same_station_keeps_different_station() {
        let mut departure = make_departure("2026-03-10T13:00:00Z", None);
        departure.stop_ifopt = "de:09761:10:1:A3".to_string();
        departure.destination_id = Some("de:09761:20:1:B1".to_string()); // different station

        let result = filter_same_station_destinations(vec![departure], "de:09761:10:1:A3");
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn test_filter_same_station_keeps_no_destination_id() {
        let departure = make_departure("2026-03-10T13:00:00Z", None);
        // destination_id is None by default

        let result = filter_same_station_destinations(vec![departure], "de:09761:10:1:A3");
        assert_eq!(result.len(), 1);
    }
}
