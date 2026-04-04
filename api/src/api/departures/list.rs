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
use crate::sync::{Departure, EventType, osm_stop_id, parse_osm_stop_id};

/// How many minutes of past departures to keep so that recent arrivals remain visible.
/// See also: `SCHEDULE_PAST_WINDOW_MINUTES` in `realtime.rs` (10 min for schedule building).
const PAST_GRACE_MINUTES: i64 = 5;

/// Words to ignore when extracting origin keywords from route names.
/// These appear in both directions and should not be used as direction discriminators.
const IGNORE_WORDS: &[&str] = &[
    // City names that appear as origin in one direction and destination in another
    "augsburg", "münchen", "munich", "nürnberg", "regensburg",
    "frankfurt", "stuttgart", "berlin", "hamburg", "köln",
    // Common directional suffixes that appear in both directions
    "nord", "süd", "west", "zentrum",
    // Transport mode words that appear in route names
    "straßenbahn", "stadtbus", "nachtbus", "regionalbahn",
    "tram", "linie", "line",
];

/// Extract origin keywords from an OSM route name.
/// Route names follow the pattern "Straßenbahn 4: Hauptbahnhof => Oberhausen Nord P+R"
/// The origin is "Hauptbahnhof" (before =>), the destination is "Oberhausen Nord P+R" (after =>).
/// Returns keywords from the origin part, normalized to lowercase, excluding IGNORE_WORDS.
fn extract_origin_keywords(route_name: &str) -> HashSet<String> {
    let mut keywords = HashSet::new();
    if let Some(arrow_pos) = route_name.find("=>") {
        let before_arrow = route_name[..arrow_pos].trim();
        let origin_part = if let Some(colon_pos) = before_arrow.find(':') {
            before_arrow[colon_pos + 1..].trim()
        } else {
            before_arrow
        };

        for word in origin_part.split_whitespace() {
            let normalized = word
                .trim_matches(|c: char| !c.is_alphanumeric())
                .to_lowercase();
            if normalized.len() >= 4 && !IGNORE_WORDS.contains(&normalized.as_str()) {
                keywords.insert(normalized);
            }
        }
    }
    keywords
}

/// Convert GTFS route_type integer to OSM route type string.
fn gtfs_to_osm_route_type(gtfs_type: i32) -> &'static str {
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

/// Filter departures by direction using OSM route data.
///
/// For lines that have an OSM route at this platform, only keep departures
/// whose destination matches the OSM route's direction (extracted from the
/// route name after "=>"). Lines NOT in OSM routes are let through (they
/// may be temporary reroutes due to construction).
///
/// Example: A1 has OSM route "Straßenbahn 1: Göggingen => Lechhausen"
/// → Tram 1 departures must have "lechhausen" in destination
/// → Tram 2 departures (reroute) are let through (no OSM route to filter against)
async fn filter_by_direction(
    departures: Vec<Departure>,
    stop_id: &str,
    pool: &PgPool,
) -> Vec<Departure> {
    // Load OSM route refs + direction keywords for this platform.
    // Each row: (route_ref, route_type, route_name)
    let rows: Vec<(String, String, Option<String>)> = if let Some(osm_id) = parse_osm_stop_id(stop_id) {
        match sqlx::query_as(
            r#"
            SELECT DISTINCT r.ref, r.route_type, r.name
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
            SELECT DISTINCT r.ref, r.route_type, r.name
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

    // Build origin keywords (= Gegenrichtung) per (line, type).
    // From route name "Straßenbahn 4: Hauptbahnhof => Oberhausen Nord P+R":
    //   origin = "Hauptbahnhof" (before =>)  = where the tram COMES FROM
    //   dest   = "Oberhausen Nord P+R" (after =>) = where the tram GOES TO
    //
    // A departure whose destination matches the ORIGIN is going the WRONG way
    // (it's heading back to where this route starts from).
    // We REJECT departures whose destination contains origin keywords.
    // This correctly handles:
    //   - "Königsplatz" as short-turn destination (no origin keyword → let through)
    //   - "Göggingen" at A1 which has origin "Göggingen" → blocked (wrong direction)
    let mut origin_keywords: HashMap<(String, String), HashSet<String>> = HashMap::new();
    let mut known_lines_by_type: HashMap<String, HashSet<String>> = HashMap::new();

    for (route_ref, route_type, route_name) in &rows {
        known_lines_by_type
            .entry(route_type.clone())
            .or_default()
            .insert(route_ref.clone());

        if let Some(name) = route_name {
            let keywords_set = extract_origin_keywords(name);
            if !keywords_set.is_empty() {
                origin_keywords
                    .entry((route_ref.clone(), route_type.clone()))
                    .or_default()
                    .extend(keywords_set);
            }
        }
    }

    // Filter departures by direction:
    // - For lines WITH an OSM route at this platform: reject wrong direction
    //   (destination matches the route's origin = going backwards)
    // - For lines WITHOUT an OSM route: let through (GTFS has them here,
    //   could be temporary reroute due to construction)
    // - If no OSM routes of this transport type exist at all: no filtering
    departures
        .into_iter()
        .filter(|d| {
            let osm_type = match d.gtfs_route_type {
                Some(t) => gtfs_to_osm_route_type(t),
                None => return true, // Unknown transport type → no filtering
            };

            // No OSM routes of this type at this platform → no filtering possible
            if !known_lines_by_type.contains_key(osm_type) {
                return true;
            }

            // Check if this specific line has OSM route data
            let key = (d.line_number.clone(), osm_type.to_string());
            match origin_keywords.get(&key) {
                Some(keywords) if !keywords.is_empty() => {
                    // This line has OSM routes → filter by direction
                    let dest_lower = d.destination.to_lowercase();
                    // REJECT if destination contains origin keyword (wrong direction)
                    !keywords.iter().any(|kw| dest_lower.contains(kw))
                }
                _ => true, // No OSM route for this line → let through
            }
        })
        .collect()
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
    if !departures.iter().any(|d| d.color.is_none()) {
        return;
    }

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
        .unwrap_or_else(|e| { tracing::warn!("Failed to fetch route colors by OSM ID: {e}"); vec![] })
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
              AND (p.ref_ifopt = $1 OR sp.ref_ifopt = $1)
            "#,
        )
        .bind(stop_id)
        .fetch_all(pool)
        .await
        .unwrap_or_else(|e| { tracing::warn!("Failed to fetch route colors by IFOPT: {e}"); vec![] })
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
        let osm_type = dep.gtfs_route_type.map(|t| gtfs_to_osm_route_type(t)).unwrap_or("bus");
        if let Some(color) = color_map.get(&(dep.line_number.as_str(), osm_type)) {
            dep.color = Some((*color).clone());
        }
    }
}

/// Fill colors from OSM routes nearest to the given coordinates.
/// Used for stops without IFOPT (e.g. München U-Bahn).
async fn fill_osm_route_colors_by_coords(departures: &mut [Departure], lat: f64, lon: f64, pool: &PgPool) {
    if !departures.iter().any(|d| d.color.is_none()) {
        return;
    }

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
        let osm_type = dep.gtfs_route_type.map(|t| gtfs_to_osm_route_type(t)).unwrap_or("bus");
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

/// Deduplicate departures by (trip_id, event_type, planned_time).
/// This prevents seeing the same trip multiple times when a platform is mapped to multiple stop IDs.
fn deduplicate_departures(departures: Vec<Departure>) -> Vec<Departure> {
    let mut unique_map: HashMap<(String, EventType, String), Departure> = HashMap::new();
    for dep in departures {
        // Key by trip_id, event_type, and time.
        // We use string representation of time for the key.
        let key = (
            dep.trip_id.clone().unwrap_or_default(),
            dep.event_type,
            dep.planned_time.to_rfc3339(),
        );
        
        // If we have a duplicate, prefer the one with a platform name or an IFOPT stop ID
        let is_better = match unique_map.get(&key) {
            Some(existing) => {
                (!dep.stop_ifopt.starts_with("osm:") && existing.stop_ifopt.starts_with("osm:"))
                    || (dep.platform.is_some() && existing.platform.is_none())
            }
            None => true,
        };

        if is_better {
            unique_map.insert(key, dep);
        }
    }
    unique_map.into_values().collect()
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
    // Batch lookup: find all osm_ids mapped to any of these gtfs_stop_ids
    let mapped_osm_ids: Vec<i64> = sqlx::query_scalar(
        "SELECT osm_id FROM osm_gtfs_stop_mapping WHERE gtfs_stop_id = ANY($1) AND ref_ifopt = $2",
    )
    .bind(&all_gtfs_ids)
    .bind(stop_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    for oid in mapped_osm_ids {
        stop_ids.insert(osm_stop_id(oid));
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
    let departures = deduplicate_departures(departures);
    let departures = filter_past_departures(departures, ref_time);
    
    // Filter out terminating departures (last stop of a trip)
    // unless it's an Arrival event (we still want to see it coming in)
    let departures: Vec<Departure> = departures
        .into_iter()
        .filter(|d| !(d.event_type == EventType::Departure && d.is_last_stop))
        .collect();

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
            let mut response = get_departures_by_coordinates(
                State(state.clone()),
                Json(CoordinateDeparturesRequest {
                    lat: coords.lat,
                    lon: coords.lon,
                    reference_time: request.reference_time,
                }),
            )
            .await;

            // Apply direction filtering using the OSM ID
            let stop_id = osm_stop_id(request.osm_id);
            response.0.departures = filter_by_direction(response.0.departures, &stop_id, &state.pool).await;

            response
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
    // Find nearest GTFS stop within 1km (~0.01 degrees)
    let nearest: Option<(String,)> = sqlx::query_as(
        r#"
        SELECT stop_id FROM gtfs_stops
        WHERE geom IS NOT NULL
          AND ST_DWithin(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326), 0.01)
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

    let mut departures =
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
            operator: None,
            is_first_stop: false,
            is_last_stop: false,
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

    // --- extract_origin_keywords tests ---

    #[test]
    fn test_extract_origin_keywords_basic() {
        let keywords = extract_origin_keywords("Straßenbahn 4: Hauptbahnhof => Oberhausen Nord P+R");
        assert!(keywords.contains("hauptbahnhof"));
        // "Nord" is in IGNORE_WORDS, "P+R" is <4 chars
        assert!(!keywords.contains("nord"));
        assert!(!keywords.contains("p+r"));
    }

    #[test]
    fn test_extract_origin_keywords_no_arrow() {
        let keywords = extract_origin_keywords("Straßenbahn 4: Hauptbahnhof - Oberhausen");
        assert!(keywords.is_empty());
    }

    #[test]
    fn test_extract_origin_keywords_no_colon_prefix() {
        let keywords = extract_origin_keywords("Göggingen => Lechhausen");
        assert!(keywords.contains("göggingen"));
        assert!(!keywords.contains("lechhausen"));
    }

    #[test]
    fn test_extract_origin_keywords_ignores_city_names() {
        let keywords = extract_origin_keywords("Tram 1: Augsburg Göggingen => Lechhausen");
        assert!(!keywords.contains("augsburg"));
        assert!(keywords.contains("göggingen"));
    }

    #[test]
    fn test_extract_origin_keywords_ignores_short_words() {
        let keywords = extract_origin_keywords("S1: P+R Hbf => Zentrum");
        // "P+R" → "p+r" (3 chars), "Hbf" → "hbf" (3 chars) — both < 4 chars
        assert!(keywords.is_empty());
    }

    #[test]
    fn test_extract_origin_keywords_ignores_transport_words() {
        let keywords = extract_origin_keywords("Straßenbahn Linie: Something => Else");
        assert!(!keywords.contains("straßenbahn"));
        assert!(!keywords.contains("linie"));
        assert!(keywords.contains("something"));
    }

    // --- deduplicate_departures tests ---

    #[test]
    fn test_deduplicate_keeps_single() {
        let deps = vec![make_departure("2026-03-10T12:00:00Z", None)];
        let result = deduplicate_departures(deps);
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn test_deduplicate_removes_exact_duplicate() {
        let d1 = make_departure("2026-03-10T12:00:00Z", None);
        let d2 = make_departure("2026-03-10T12:00:00Z", None);
        let result = deduplicate_departures(vec![d1, d2]);
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn test_deduplicate_prefers_ifopt_over_osm() {
        let mut d1 = make_departure("2026-03-10T12:00:00Z", None);
        d1.stop_ifopt = "osm:12345".to_string();
        let mut d2 = make_departure("2026-03-10T12:00:00Z", None);
        d2.stop_ifopt = "de:09761:101:31:A1".to_string();
        let result = deduplicate_departures(vec![d1, d2]);
        assert_eq!(result.len(), 1);
        assert!(!result[0].stop_ifopt.starts_with("osm:"));
    }

    #[test]
    fn test_deduplicate_prefers_platform_name() {
        let mut d1 = make_departure("2026-03-10T12:00:00Z", None);
        d1.platform = None;
        let mut d2 = make_departure("2026-03-10T12:00:00Z", None);
        d2.platform = Some("A1".to_string());
        let result = deduplicate_departures(vec![d1, d2]);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].platform, Some("A1".to_string()));
    }

    #[test]
    fn test_deduplicate_different_times_kept() {
        let d1 = make_departure("2026-03-10T12:00:00Z", None);
        let d2 = make_departure("2026-03-10T12:05:00Z", None);
        let result = deduplicate_departures(vec![d1, d2]);
        assert_eq!(result.len(), 2);
    }

    // --- gtfs_to_osm_route_type tests ---

    #[test]
    fn test_gtfs_to_osm_route_type_mapping() {
        assert_eq!(gtfs_to_osm_route_type(0), "tram");
        assert_eq!(gtfs_to_osm_route_type(1), "subway");
        assert_eq!(gtfs_to_osm_route_type(2), "train");
        assert_eq!(gtfs_to_osm_route_type(3), "bus");
        assert_eq!(gtfs_to_osm_route_type(4), "ferry");
        assert_eq!(gtfs_to_osm_route_type(7), "bus");
        assert_eq!(gtfs_to_osm_route_type(99), "bus");
    }
}
