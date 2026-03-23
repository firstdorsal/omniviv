use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use chrono::{Datelike, NaiveDate, Weekday};
use futures::StreamExt;
use sqlx::PgPool;
use tokio::io::AsyncWriteExt;
use tracing::{debug, info, warn};

use super::error::GtfsError;
use crate::config::TransportType;
use crate::sync::{transport_type_from_route, MatchCandidate};

// --- Matching algorithm constants ---

/// Maximum distance in meters for proximity pre-filter
const MAX_DISTANCE_METERS: f64 = 500.0;

/// Maximum allowed download size for GTFS zip (500 MB)
const MAX_DOWNLOAD_SIZE: u64 = 500 * 1024 * 1024;
/// Maximum allowed total decompressed size for GTFS zip (2 GB)
const MAX_DECOMPRESSED_SIZE: u64 = 2 * 1024 * 1024 * 1024;
/// Maximum length for cached HTTP header values (ETag, Last-Modified)
const MAX_HEADER_LENGTH: usize = 1024;

// --- Types for the in-memory schedule ---

/// OSM stop info for matching (IFOPT, name, lat, lon)
pub struct OsmStopInfo {
    pub ifopt: String,
    pub name: Option<String>,
    pub lat: f64,
    pub lon: f64,
}

/// A route identifier combining line reference and transport type.
/// Used for comparing which routes serve a given stop in OSM vs GTFS.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct RouteIdentifier {
    /// Normalized line number (e.g., "1", "3", "N5")
    pub(crate) line_ref: String,
    /// Transport type to disambiguate same line number across modes
    pub(crate) transport_type: TransportType,
}

/// Check if two route sets form a definitive match.
/// Returns (is_definitive, shared_routes) where is_definitive is true
/// when the intersection is non-empty AND one set is a subset of the other.
fn is_definitive_match(
    osm: &HashSet<RouteIdentifier>,
    gtfs: &HashSet<RouteIdentifier>,
) -> (bool, Vec<RouteIdentifier>) {
    let intersection: Vec<_> = osm.intersection(gtfs).cloned().collect();
    if intersection.is_empty() {
        return (false, vec![]);
    }
    // Any non-empty intersection is a match. OSM and GTFS often have
    // different data quality (seasonal trams, agency-specific bus lines),
    // so requiring strict subset is too restrictive. The proximity pre-filter
    // (500m) already limits candidates, and shared routes confirm identity.
    (true, intersection)
}

/// Bulk-load OSM route sets from the database.
/// Returns:
/// - route_sets: IFOPT → set of RouteIdentifiers (for definitive match testing)
/// - directional_routes: IFOPT → set of OSM route osm_ids (for direction disambiguation)
async fn load_osm_route_sets(
    pool: &PgPool,
) -> Result<
    (
        HashMap<String, HashSet<RouteIdentifier>>,
        HashMap<String, HashSet<i64>>,
    ),
    GtfsError,
> {
    let rows: Vec<(String, String, String, i64)> = sqlx::query_as(
        r#"
        SELECT DISTINCT
            COALESCE(p.ref_ifopt, sp.ref_ifopt) AS ifopt,
            r.ref AS line_ref,
            r.route_type,
            r.osm_id
        FROM route_stops rs
        JOIN routes r ON r.osm_id = rs.route_id
        LEFT JOIN platforms p ON p.osm_id = rs.platform_id
        LEFT JOIN stop_positions sp ON sp.osm_id = rs.stop_position_id
        WHERE r.ref IS NOT NULL
        AND (p.ref_ifopt IS NOT NULL OR sp.ref_ifopt IS NOT NULL)
        "#,
    )
    .fetch_all(pool)
    .await?;

    let mut route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
    let mut directional_routes: HashMap<String, HashSet<i64>> = HashMap::new();
    for (ifopt, line_ref, route_type, osm_id) in rows {
        let transport_type = transport_type_from_route(&route_type);
        route_sets
            .entry(ifopt.clone())
            .or_default()
            .insert(RouteIdentifier {
                line_ref,
                transport_type,
            });
        directional_routes
            .entry(ifopt)
            .or_default()
            .insert(osm_id);
    }

    info!(
        ifopts_with_routes = route_sets.len(),
        "Loaded OSM route sets for matching"
    );
    Ok((route_sets, directional_routes))
}

/// Load OSM route destination names per IFOPT.
/// Extracts the destination from OSM route names like "Straßenbahn 1: Göggingen => Lechhausen"
/// → destination "Lechhausen" for the IFOPT on this route.
/// Returns IFOPT → set of normalized destination keywords.
async fn load_osm_destinations(
    pool: &PgPool,
) -> Result<HashMap<String, HashSet<String>>, GtfsError> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        r#"
        SELECT DISTINCT
            COALESCE(p.ref_ifopt, sp.ref_ifopt) AS ifopt,
            r.name AS route_name
        FROM route_stops rs
        JOIN routes r ON r.osm_id = rs.route_id
        LEFT JOIN platforms p ON p.osm_id = rs.platform_id
        LEFT JOIN stop_positions sp ON sp.osm_id = rs.stop_position_id
        WHERE r.name IS NOT NULL
        AND (p.ref_ifopt IS NOT NULL OR sp.ref_ifopt IS NOT NULL)
        "#,
    )
    .fetch_all(pool)
    .await?;

    let mut result: HashMap<String, HashSet<String>> = HashMap::new();
    for (ifopt, route_name) in rows {
        // Parse "Straßenbahn 1: Göggingen => Lechhausen Neuer Ostfriedhof"
        // The part after "=>" is the destination
        if let Some(arrow_pos) = route_name.find("=>") {
            let dest = route_name[arrow_pos + 2..].trim();
            // Normalize: extract significant words, lowercase
            for word in dest.split_whitespace() {
                let normalized = word.trim_matches(|c: char| !c.is_alphanumeric())
                    .to_lowercase();
                if normalized.len() >= 3 {
                    result.entry(ifopt.clone()).or_default().insert(normalized);
                }
            }
        }
    }

    info!(
        ifopts_with_destinations = result.len(),
        "Loaded OSM route destinations for direction matching"
    );
    Ok(result)
}

/// Load the dominant last-stop names per GTFS stop + line.
/// For each GTFS stop, finds what the last stop of most trips is (per route),
/// giving us the direction the vehicle is heading.
/// Returns gtfs_stop_id → set of normalized last-stop keywords.
async fn load_gtfs_directions(
    pool: &PgPool,
    stop_ids: &[&str],
) -> Result<HashMap<String, HashSet<String>>, GtfsError> {
    if stop_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let mut result: HashMap<String, HashSet<String>> = HashMap::new();

    for chunk in stop_ids.chunks(500) {
        let chunk_vec: Vec<&str> = chunk.to_vec();
        // For each stop, find the last stop name of each trip visiting it (grouped by route)
        let rows: Vec<(String, String, i64)> = sqlx::query_as(
            r#"
            WITH trip_last_stops AS (
                SELECT st.stop_id, r.route_short_name,
                    (SELECT gs.stop_name FROM gtfs_stop_times lst
                     JOIN gtfs_stops gs ON lst.stop_id = gs.stop_id
                     WHERE lst.trip_id = t.trip_id
                     ORDER BY lst.stop_sequence DESC LIMIT 1) as last_stop
                FROM gtfs_stop_times st
                JOIN gtfs_trips t ON st.trip_id = t.trip_id
                JOIN gtfs_routes r ON t.route_id = r.route_id
                WHERE st.stop_id = ANY($1::text[])
                  AND r.route_short_name ~ '^\d+$'
            )
            SELECT stop_id, last_stop, COUNT(*) as trips
            FROM trip_last_stops
            WHERE last_stop IS NOT NULL
            GROUP BY stop_id, last_stop
            HAVING COUNT(*) > 5
            "#,
        )
        .bind(&chunk_vec)
        .fetch_all(pool)
        .await?;

        for (stop_id, last_stop, _trips) in rows {
            // Normalize: extract significant words, lowercase
            for word in last_stop.split_whitespace() {
                let normalized = word.trim_matches(|c: char| !c.is_alphanumeric())
                    .to_lowercase();
                if normalized.len() >= 3 {
                    result.entry(stop_id.clone()).or_default().insert(normalized);
                }
            }
        }
    }

    info!(
        gtfs_stops_with_directions = result.len(),
        "Loaded GTFS trip directions for matching"
    );
    Ok(result)
}

/// Batch-load GTFS trip sets for given stop IDs.
/// Returns stop_id → set of trip_ids that visit that stop.
async fn load_gtfs_trip_sets(
    pool: &PgPool,
    stop_ids: &[&str],
) -> Result<HashMap<String, HashSet<String>>, GtfsError> {
    if stop_ids.is_empty() {
        return Ok(HashMap::new());
    }

    // Batch in chunks to avoid SQL parameter limits
    let mut result: HashMap<String, HashSet<String>> = HashMap::new();
    for chunk in stop_ids.chunks(500) {
        let placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("${i}")).collect();
        let query = format!(
            "SELECT stop_id, trip_id FROM gtfs_stop_times WHERE stop_id IN ({})",
            placeholders.join(", ")
        );

        let mut q = sqlx::query_as::<_, (String, String)>(&query);
        for &id in chunk {
            q = q.bind(id);
        }

        let rows = q.fetch_all(pool).await?;
        for (stop_id, trip_id) in rows {
            result.entry(stop_id).or_default().insert(trip_id);
        }
    }

    info!(
        gtfs_stops_with_trips = result.len(),
        "Loaded GTFS trip sets for direction matching"
    );
    Ok(result)
}

/// Batch-load GTFS route sets for given stop IDs.
/// Returns a map from GTFS stop_id to the set of routes serving that stop.
async fn load_gtfs_route_sets(
    pool: &PgPool,
    stop_ids: &[&str],
) -> Result<HashMap<String, HashSet<RouteIdentifier>>, GtfsError> {
    let mut result: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();

    // Process in batches of 5000
    for batch in stop_ids.chunks(5000) {
        let batch_vec: Vec<&str> = batch.to_vec();
        let rows: Vec<(String, String, i32)> = sqlx::query_as(
            r#"
            SELECT DISTINCT st.stop_id, gr.route_short_name, gr.route_type
            FROM gtfs_stop_times st
            JOIN gtfs_trips gt ON gt.trip_id = st.trip_id
            JOIN gtfs_routes gr ON gr.route_id = gt.route_id
            WHERE st.stop_id = ANY($1::text[])
            AND gr.route_short_name IS NOT NULL
            "#,
        )
        .bind(&batch_vec)
        .fetch_all(pool)
        .await?;

        for (stop_id, route_short_name, route_type) in rows {
            let transport_type = TransportType::from_gtfs_route_type(route_type);
            result
                .entry(stop_id)
                .or_default()
                .insert(RouteIdentifier {
                    line_ref: route_short_name,
                    transport_type,
                });
        }
    }

    info!(
        gtfs_stops_with_routes = result.len(),
        "Loaded GTFS route sets for matching"
    );
    Ok(result)
}

/// Statistics from the IFOPT <-> GTFS stop ID mapping operation.
/// Used for issue reporting and monitoring.
#[derive(Debug, Clone)]
pub(crate) struct MappingStats {
    pub(crate) total_db_stops: usize,
    pub(crate) total_gtfs_stops: usize,
    pub(crate) matched: usize,
    /// Number of manual (user-curated) mappings preserved during rebuild
    pub(crate) manual_count: usize,
    /// OSM stops that had no good matching GTFS stop
    pub(crate) unmatched_osm: Vec<UnmatchedOsmStop>,
    /// GTFS stops that weren't matched to any IFOPT
    pub(crate) unmatched_gtfs: Vec<UnmatchedGtfsStop>,
}

/// An OSM stop that wasn't matched to any GTFS stop
#[derive(Debug, Clone)]
pub(crate) struct UnmatchedOsmStop {
    pub(crate) ifopt: String,
    pub(crate) name: Option<String>,
    pub(crate) lat: f64,
    pub(crate) lon: f64,
    /// Candidate matches for diagnostics (may be empty if no candidates within range)
    pub(crate) candidates: Vec<MatchCandidate>,
    /// Reason why no match was made
    pub(crate) reason: UnmatchedReason,
}

/// Reason why an OSM stop could not be matched
#[derive(Debug, Clone)]
pub enum UnmatchedReason {
    /// No route data available for this OSM stop
    NoRouteData,
    /// No definitive candidate found (0 candidates passed subset test)
    NoDefinitiveCandidate,
    /// Multiple definitive candidates found (ambiguous)
    AmbiguousMatch,
}

/// A GTFS stop that wasn't matched to any OSM/DB stop
#[derive(Debug, Clone)]
pub(crate) struct UnmatchedGtfsStop {
    pub(crate) gtfs_stop_id: String,
    pub(crate) gtfs_stop_name: Option<String>,
    pub(crate) lat: f64,
    pub(crate) lon: f64,
}

/// A GTFS stop (from stops.txt).
///
/// Some fields (e.g. `parent_station`) are parsed from the feed but not
/// directly read in the current codebase. They are retained for debugging,
/// future use (e.g. parent-child stop grouping), and completeness of the
/// in-memory GTFS model.
#[derive(Debug, Clone)]
pub struct GtfsStop {
    pub stop_id: String,
    pub stop_name: Option<String>,
    /// Used for IFOPT mapping: leaf stops have a parent_station.
    pub parent_station: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
}

/// A GTFS route (from routes.txt).
///
/// Fields like `route_id`, `route_long_name`, and `route_type` are parsed
/// for completeness and future use (e.g. filtering by route type). Currently
/// `route_short_name` is the primary field used for line number display.
#[derive(Debug, Clone)]
pub struct GtfsRoute {
    pub route_id: String,
    pub route_short_name: Option<String>,
    pub route_long_name: Option<String>,
    pub route_type: Option<i32>,
}

/// A GTFS trip (from trips.txt).
///
/// `trip_id` and `direction_id` are parsed for completeness and used as
/// HashMap keys and for potential future direction-based filtering.
#[derive(Debug, Clone)]
pub struct GtfsTrip {
    pub trip_id: String,
    pub route_id: String,
    pub service_id: String,
    pub trip_headsign: Option<String>,
    pub direction_id: Option<i32>,
}

#[derive(Debug, Clone)]
pub struct GtfsStopTime {
    pub stop_sequence: i32,
    pub stop_id: String,
    /// Seconds since midnight (can exceed 86400 for trips crossing midnight)
    pub arrival_time: Option<i32>,
    /// Seconds since midnight
    pub departure_time: Option<i32>,
}

/// A GTFS calendar entry (from calendar.txt).
///
/// `service_id` is stored alongside the HashMap key for self-contained
/// debug printing and test construction.
#[derive(Debug, Clone)]
pub struct GtfsCalendar {
    pub service_id: String,
    pub days: [bool; 7], // mon, tue, wed, thu, fri, sat, sun
    pub start_date: NaiveDate,
    pub end_date: NaiveDate,
}

#[derive(Debug, Clone)]
pub struct GtfsCalendarDate {
    pub date: NaiveDate,
    /// 1 = service added, 2 = service removed
    pub exception_type: i32,
}

/// The full in-memory GTFS schedule.
///
/// `loaded_at` tracks when the schedule was parsed, used by the health
/// endpoint and for cache freshness logging.
pub struct GtfsSchedule {
    pub stops: HashMap<String, GtfsStop>,
    pub routes: HashMap<String, GtfsRoute>,
    pub trips: HashMap<String, GtfsTrip>,
    /// trip_id -> ordered stop_times
    pub stop_times: HashMap<String, Vec<GtfsStopTime>>,
    pub calendars: HashMap<String, GtfsCalendar>,
    /// service_id -> list of exceptions
    pub calendar_dates: HashMap<String, Vec<GtfsCalendarDate>>,
    /// GTFS stop_id -> set of trip_ids visiting that stop (for fast filtering)
    pub trips_by_stop: HashMap<String, HashSet<String>>,
    /// IFOPT -> list of matching GTFS stop_ids (built after loading via spatial matching)
    pub ifopt_to_gtfs: HashMap<String, Vec<String>>,
    /// GTFS stop_id -> IFOPTs (reverse mapping, multiple IFOPTs can share a GTFS stop)
    pub gtfs_to_ifopt: HashMap<String, Vec<String>>,
    pub loaded_at: chrono::DateTime<chrono::Utc>,
}

impl GtfsSchedule {
    /// Create an empty schedule, optionally carrying IFOPT↔GTFS mappings.
    pub fn empty_with_mappings(
        ifopt_to_gtfs: HashMap<String, Vec<String>>,
        gtfs_to_ifopt: HashMap<String, Vec<String>>,
    ) -> Self {
        Self {
            stops: HashMap::new(),
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            trips_by_stop: HashMap::new(),
            ifopt_to_gtfs,
            gtfs_to_ifopt,
            loaded_at: chrono::Utc::now(),
        }
    }

    /// Check if a service is active on the given date.
    pub fn is_service_active(&self, service_id: &str, date: NaiveDate) -> bool {
        // Check calendar_dates exceptions first (they override regular calendar)
        if let Some(exceptions) = self.calendar_dates.get(service_id) {
            for exc in exceptions {
                if exc.date == date {
                    return exc.exception_type == 1;
                }
            }
        }

        // Check regular calendar
        if let Some(cal) = self.calendars.get(service_id) {
            if date < cal.start_date || date > cal.end_date {
                return false;
            }
            let day_index = match date.weekday() {
                Weekday::Mon => 0,
                Weekday::Tue => 1,
                Weekday::Wed => 2,
                Weekday::Thu => 3,
                Weekday::Fri => 4,
                Weekday::Sat => 5,
                Weekday::Sun => 6,
            };
            return cal.days[day_index];
        }

        // If only calendar_dates exist (no calendar entry), service is active
        // only on dates explicitly listed with exception_type=1.
        // We already checked above and found no matching date, so inactive.
        false
    }

    /// Get the last stop_id of a trip (useful for destination_id).
    /// Returns IFOPT if a mapping exists, otherwise the raw GTFS stop_id.
    pub fn last_stop_of_trip(&self, trip_id: &str) -> Option<String> {
        let last_stop = self.stop_times.get(trip_id)?.last()?;
        Some(
            self.gtfs_to_ifopt
                .get(&last_stop.stop_id)
                .and_then(|ifopts| ifopts.first().cloned())
                .unwrap_or_else(|| last_stop.stop_id.clone()),
        )
    }

    /// Get the name of the last stop of a trip (useful for headsign fallback).
    pub fn last_stop_name_of_trip(&self, trip_id: &str) -> Option<String> {
        let last_stop = self.stop_times.get(trip_id)?.last()?;
        self.stops
            .get(&last_stop.stop_id)
            .and_then(|s| s.stop_name.clone())
    }

    /// Build the IFOPT <-> GTFS stop ID mapping using deterministic route-set comparison.
    ///
    /// For each OSM stop with route data, finds GTFS stops within MAX_DISTANCE_METERS
    /// and checks if route sets form a definitive match (one is a subset of the other
    /// with non-empty intersection). When multiple definitive candidates exist (common
    /// for stations with multiple platforms serving the same routes), the closest one
    /// by distance is chosen. Stops without route data are left unmatched.
    ///
    /// Returns statistics about the mapping for issue reporting.
    #[cfg(test)]
    pub(crate) fn build_ifopt_mapping(
        &mut self,
        osm_stops: &[OsmStopInfo],
        osm_route_sets: &HashMap<String, HashSet<RouteIdentifier>>,
        gtfs_route_sets: &HashMap<String, HashSet<RouteIdentifier>>,
    ) -> MappingStats {
        self.build_ifopt_mapping_with_direction(
            osm_stops,
            osm_route_sets,
            gtfs_route_sets,
            &HashMap::new(),
        )
    }

    /// Direction-aware IFOPT mapping for tests that need to verify direction disambiguation.
    /// Uses trip overlap from `self.trips_by_stop` to determine direction.
    #[cfg(test)]
    pub(crate) fn build_ifopt_mapping_with_direction(
        &mut self,
        osm_stops: &[OsmStopInfo],
        osm_route_sets: &HashMap<String, HashSet<RouteIdentifier>>,
        gtfs_route_sets: &HashMap<String, HashSet<RouteIdentifier>>,
        osm_directional_routes: &HashMap<String, HashSet<i64>>,
    ) -> MappingStats {
        self.ifopt_to_gtfs.clear();
        self.gtfs_to_ifopt.clear();

        // Collect leaf GTFS stops (those that appear in stop_times or have a parent_station)
        // with coordinates
        let gtfs_leaf_stops: Vec<(&str, f64, f64, Option<&str>)> = self
            .stops
            .values()
            .filter(|s| {
                (s.parent_station.is_some() || self.trips_by_stop.contains_key(&s.stop_id))
                    && s.lat.is_some()
                    && s.lon.is_some()
            })
            .map(|s| {
                (
                    s.stop_id.as_str(),
                    s.lat.unwrap(),
                    s.lon.unwrap(),
                    s.stop_name.as_deref(),
                )
            })
            .collect();

        let max_dist_deg = MAX_DISTANCE_METERS / 111_000.0;
        let max_dist_sq = max_dist_deg * max_dist_deg;
        let empty_route_set = HashSet::new();
        let empty_osm_id_set: HashSet<i64> = HashSet::new();

        // Build reverse index: OSM route osm_id → IFOPTs on that route
        let mut osm_route_to_ifopts: HashMap<i64, Vec<String>> = HashMap::new();
        for (ifopt, osm_ids) in osm_directional_routes {
            for &osm_id in osm_ids {
                osm_route_to_ifopts
                    .entry(osm_id)
                    .or_default()
                    .push(ifopt.clone());
            }
        }

        struct IfoptEntry<'a> {
            ifopt: &'a str,
            name: &'a Option<String>,
            lat: f64,
            lon: f64,
            candidates: Vec<MatchCandidate>,
            reason: UnmatchedReason,
        }

        // Pass 1: Collect all candidates for each OSM stop
        struct PendingMatch<'a> {
            ifopt: &'a str,
            name: &'a Option<String>,
            lat: f64,
            lon: f64,
            candidates: Vec<MatchCandidate>,
            /// Distance to closest definitive candidate (for processing order)
            best_distance: f64,
        }

        let mut no_route_entries: Vec<IfoptEntry> = Vec::new();
        let mut pending: Vec<PendingMatch> = Vec::new();
        let mut seen_ifopts: HashSet<&str> = HashSet::new();

        for osm_stop in osm_stops {
            // Skip duplicate IFOPT entries (same IFOPT may appear from both platforms and stop_positions)
            if !seen_ifopts.insert(&osm_stop.ifopt) {
                continue;
            }
            let osm_routes = osm_route_sets
                .get(&osm_stop.ifopt)
                .unwrap_or(&empty_route_set);

            if osm_routes.is_empty() {
                no_route_entries.push(IfoptEntry {
                    ifopt: &osm_stop.ifopt,
                    name: &osm_stop.name,
                    lat: osm_stop.lat,
                    lon: osm_stop.lon,
                    candidates: vec![],
                    reason: UnmatchedReason::NoRouteData,
                });
                continue;
            }

            let mut candidates: Vec<MatchCandidate> = Vec::new();

            for &(gtfs_id, glat, glon, gtfs_name) in &gtfs_leaf_stops {
                let dlat = osm_stop.lat - glat;
                let dlon = (osm_stop.lon - glon) * (osm_stop.lat.to_radians().cos());
                let dist_sq = dlat * dlat + dlon * dlon;

                if dist_sq < max_dist_sq {
                    let distance_meters = (dist_sq.sqrt()) * 111_000.0;

                    let gtfs_routes = gtfs_route_sets
                        .get(gtfs_id)
                        .unwrap_or(&empty_route_set);
                    let (definitive, shared) = is_definitive_match(osm_routes, gtfs_routes);

                    let shared_routes: Vec<String> = shared
                        .iter()
                        .map(|r| format!("{:?} {}", r.transport_type, r.line_ref))
                        .collect();

                    candidates.push(MatchCandidate {
                        gtfs_stop_id: gtfs_id.to_string(),
                        gtfs_stop_name: gtfs_name.map(String::from),
                        distance_meters,
                        shared_routes,
                        is_definitive: definitive,
                    });
                }
            }

            let best_distance = candidates
                .iter()
                .filter(|c| c.is_definitive)
                .map(|c| c.distance_meters)
                .fold(f64::MAX, f64::min);

            pending.push(PendingMatch {
                ifopt: &osm_stop.ifopt,
                name: &osm_stop.name,
                lat: osm_stop.lat,
                lon: osm_stop.lon,
                candidates,
                best_distance,
            });
        }

        // Pass 2: Sort by distance to closest definitive candidate (ascending).
        // Stops nearest their best GTFS match get first pick, preventing a farther
        // stop from stealing a closer stop's optimal match.
        pending.sort_by(|a, b| {
            a.best_distance
                .partial_cmp(&b.best_distance)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let mut all_entries: Vec<IfoptEntry> = Vec::new();
        let mut claimed_ifopts: HashSet<String> = HashSet::new();
        let mut claimed_gtfs: HashSet<String> = HashSet::new();

        // Direction-aware matching with cascading peer propagation.
        // Each iteration picks the platform with the most matched peers, matches it,
        // then re-sorts. Correct direction signal cascades from cross-line seed stations.
        let mut to_process: Vec<PendingMatch> = pending;

        loop {
            if to_process.is_empty() {
                break;
            }

            // Sort: most peers first, then distance
            to_process.sort_by(|a, b| {
                let a_peers = osm_directional_routes
                    .get(a.ifopt)
                    .unwrap_or(&empty_osm_id_set)
                    .iter()
                    .flat_map(|rid| osm_route_to_ifopts.get(rid).into_iter().flatten())
                    .filter(|pi| self.ifopt_to_gtfs.contains_key(pi.as_str()))
                    .count();
                let b_peers = osm_directional_routes
                    .get(b.ifopt)
                    .unwrap_or(&empty_osm_id_set)
                    .iter()
                    .flat_map(|rid| osm_route_to_ifopts.get(rid).into_iter().flatten())
                    .filter(|pi| self.ifopt_to_gtfs.contains_key(pi.as_str()))
                    .count();
                b_peers.cmp(&a_peers).then_with(|| {
                    a.best_distance
                        .partial_cmp(&b.best_distance)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
            });

            let entry = to_process.remove(0);

            let platform_osm_ids = osm_directional_routes
                .get(entry.ifopt)
                .unwrap_or(&empty_osm_id_set);

            let mut peer_gtfs_ids: Vec<String> = Vec::new();
            for &route_id in platform_osm_ids {
                if let Some(peer_ifopts) = osm_route_to_ifopts.get(&route_id) {
                    for peer_ifopt in peer_ifopts {
                        if let Some(gtfs_ids) = self.ifopt_to_gtfs.get(peer_ifopt.as_str()) {
                            for peer_gtfs_id in gtfs_ids {
                                peer_gtfs_ids.push(peer_gtfs_id.clone());
                            }
                        }
                    }
                }
            }
            peer_gtfs_ids.sort();
            peer_gtfs_ids.dedup();

            let mut definitive_candidates: Vec<&MatchCandidate> = entry
                .candidates
                .iter()
                .filter(|c| c.is_definitive)
                .collect();

            if !definitive_candidates.is_empty() {
                let nearest_distance = definitive_candidates
                    .iter()
                    .map(|c| c.distance_meters)
                    .fold(f64::MAX, f64::min);
                let max_fallback = (nearest_distance * 3.0).max(100.0).min(200.0);

                // Specificity: prefer GTFS stops whose route set closely matches
                // the OSM platform's routes (fewer extra lines = better match).
                let specificity_for = |c: &MatchCandidate| -> f64 {
                    let gtfs_routes = gtfs_route_sets
                        .get(&c.gtfs_stop_id)
                        .map(|s| s.len())
                        .unwrap_or(1)
                        .max(1);
                    c.shared_routes.len() as f64 / gtfs_routes as f64
                };

                // Sort by: specificity → trip overlap sum → distance → shared_routes
                definitive_candidates.sort_by(|a, b| {
                    let a_spec = specificity_for(a);
                    let b_spec = specificity_for(b);
                    let spec_cmp = b_spec
                        .partial_cmp(&a_spec)
                        .unwrap_or(std::cmp::Ordering::Equal);

                    let trip_cmp = if peer_gtfs_ids.is_empty() {
                        std::cmp::Ordering::Equal
                    } else {
                        let empty_trips: HashSet<String> = HashSet::new();
                        let a_overlap: usize = peer_gtfs_ids
                            .iter()
                            .map(|peer_id| {
                                let peer_trips = self
                                    .trips_by_stop
                                    .get(peer_id)
                                    .unwrap_or(&empty_trips);
                                self.trips_by_stop
                                    .get(&a.gtfs_stop_id)
                                    .map(|ct| {
                                        ct.iter()
                                            .filter(|t| peer_trips.contains(*t))
                                            .count()
                                    })
                                    .unwrap_or(0)
                            })
                            .sum();
                        let b_overlap: usize = peer_gtfs_ids
                            .iter()
                            .map(|peer_id| {
                                let peer_trips = self
                                    .trips_by_stop
                                    .get(peer_id)
                                    .unwrap_or(&empty_trips);
                                self.trips_by_stop
                                    .get(&b.gtfs_stop_id)
                                    .map(|ct| {
                                        ct.iter()
                                            .filter(|t| peer_trips.contains(*t))
                                            .count()
                                    })
                                    .unwrap_or(0)
                            })
                            .sum();
                        b_overlap.cmp(&a_overlap)
                    };
                    spec_cmp
                        .then(trip_cmp)
                        .then_with(|| {
                            a.distance_meters
                                .partial_cmp(&b.distance_meters)
                                .unwrap_or(std::cmp::Ordering::Equal)
                        })
                        .then_with(|| b.shared_routes.len().cmp(&a.shared_routes.len()))
                });

                let mut matched = false;
                for winner in &definitive_candidates {
                    if winner.distance_meters > max_fallback {
                        continue;
                    }
                    if !claimed_gtfs.contains(&winner.gtfs_stop_id) {
                        self.ifopt_to_gtfs.insert(
                            entry.ifopt.to_string(),
                            vec![winner.gtfs_stop_id.clone()],
                        );
                        self.gtfs_to_ifopt
                            .entry(winner.gtfs_stop_id.clone())
                            .or_default()
                            .push(entry.ifopt.to_string());
                        claimed_ifopts.insert(entry.ifopt.to_string());
                        claimed_gtfs.insert(winner.gtfs_stop_id.clone());
                        matched = true;
                        break;
                    }
                }
                if matched {
                    continue; // Re-sort remaining with updated peers
                }
            }

            let reason = if definitive_candidates.is_empty() {
                UnmatchedReason::NoDefinitiveCandidate
            } else {
                UnmatchedReason::AmbiguousMatch
            };

            all_entries.push(IfoptEntry {
                ifopt: entry.ifopt,
                name: entry.name,
                lat: entry.lat,
                lon: entry.lon,
                candidates: entry.candidates,
                reason,
            });
        }

        // Station-level fallback: when the GTFS feed has a single stop for both
        // directions at a station, allow unmapped sibling platforms to share it.
        let mut station_fallback_matched = Vec::new();
        for entry in &all_entries {
            let station = station_level_ifopt(entry.ifopt);
            // Find if a sibling platform at this station is already mapped
            let sibling_gtfs: Option<String> = claimed_ifopts
                .iter()
                .filter(|ci| station_level_ifopt(ci) == station && *ci != entry.ifopt)
                .find_map(|ci| self.ifopt_to_gtfs.get(ci.as_str()).and_then(|v| v.first().cloned()));

            if let Some(sibling_gtfs_id) = sibling_gtfs {
                // Only allow if this GTFS stop is a definitive (route-matching) candidate
                if entry.candidates.iter().any(|c| c.gtfs_stop_id == sibling_gtfs_id && c.is_definitive) {
                    station_fallback_matched.push((entry.ifopt.to_string(), sibling_gtfs_id));
                }
            }
        }
        for (ifopt, gtfs_id) in &station_fallback_matched {
            self.ifopt_to_gtfs
                .insert(ifopt.clone(), vec![gtfs_id.clone()]);
            self.gtfs_to_ifopt
                .entry(gtfs_id.clone())
                .or_default()
                .push(ifopt.clone());
            claimed_ifopts.insert(ifopt.clone());
        }
        // Remove matched entries from unmatched list
        all_entries.retain(|e| !station_fallback_matched.iter().any(|(ifopt, _)| ifopt == e.ifopt));
        if !station_fallback_matched.is_empty() {
            info!(
                count = station_fallback_matched.len(),
                "Station-level fallback: shared GTFS stops for sibling platforms"
            );
        }

        all_entries.extend(no_route_entries);

        let matched = claimed_ifopts.len();

        // Build unmatched lists from entries that weren't matched
        let unmatched_osm: Vec<UnmatchedOsmStop> = all_entries
            .iter()
            .map(|entry| UnmatchedOsmStop {
                ifopt: entry.ifopt.to_string(),
                name: entry.name.clone(),
                lat: entry.lat,
                lon: entry.lon,
                candidates: entry.candidates.iter().take(5).cloned().collect(),
                reason: entry.reason.clone(),
            })
            .collect();

        let unmatched_gtfs: Vec<UnmatchedGtfsStop> = gtfs_leaf_stops
            .iter()
            .filter(|(gtfs_id, _, _, _)| !claimed_gtfs.contains(*gtfs_id))
            .map(|(gtfs_id, lat, lon, name)| UnmatchedGtfsStop {
                gtfs_stop_id: gtfs_id.to_string(),
                gtfs_stop_name: name.map(String::from),
                lat: *lat,
                lon: *lon,
            })
            .collect();

        info!(
            osm_stops = osm_stops.len(),
            gtfs_leaf_stops = gtfs_leaf_stops.len(),
            matched,
            unmatched_osm = unmatched_osm.len(),
            unmatched_gtfs = unmatched_gtfs.len(),
            "Built IFOPT <-> GTFS stop mapping (deterministic route-based)"
        );

        MappingStats {
            total_db_stops: osm_stops.len(),
            total_gtfs_stops: gtfs_leaf_stops.len(),
            matched,
            manual_count: 0,
            unmatched_osm,
            unmatched_gtfs,
        }
    }

    /// Look up trip_ids for an IFOPT via the mapping.
    /// Returns trips that visit any GTFS stop mapped to this IFOPT.
    pub fn trips_for_ifopt(&self, ifopt: &str) -> HashSet<&String> {
        let mut result = HashSet::new();
        if let Some(gtfs_ids) = self.ifopt_to_gtfs.get(ifopt) {
            for gid in gtfs_ids {
                if let Some(trips) = self.trips_by_stop.get(gid) {
                    result.extend(trips);
                }
            }
        }
        result
    }

    /// Check if a GTFS stop_id maps to any of the given IFOPTs.
    pub fn is_gtfs_stop_relevant(&self, gtfs_stop_id: &str, ifopt_set: &HashSet<String>) -> bool {
        if let Some(ifopts) = self.gtfs_to_ifopt.get(gtfs_stop_id) {
            ifopts.iter().any(|ifopt| ifopt_set.contains(ifopt))
        } else {
            false
        }
    }

    /// Get the first IFOPT for a GTFS stop_id, falling back to the raw stop_id.
    pub fn ifopt_for_gtfs_stop(&self, gtfs_stop_id: &str) -> String {
        self.gtfs_to_ifopt
            .get(gtfs_stop_id)
            .and_then(|ifopts| ifopts.first().cloned())
            .unwrap_or_else(|| gtfs_stop_id.to_string())
    }

    /// Get all IFOPTs for a GTFS stop_id (shared stops map to multiple platforms).
    pub fn ifopts_for_gtfs_stop(&self, gtfs_stop_id: &str) -> Vec<String> {
        self.gtfs_to_ifopt
            .get(gtfs_stop_id)
            .cloned()
            .unwrap_or_default()
    }
}

// --- Download and loading ---

/// Known files in the cache directory. Everything else is cleaned up.
const CACHE_KNOWN_FILES: &[&str] = &["latest.zip", "metadata.json"];

/// Remove unexpected files from the cache directory and log disk usage.
async fn cleanup_cache(cache_dir: &Path) {
    let mut total_size: u64 = 0;
    let mut removed = 0usize;

    let mut entries = match tokio::fs::read_dir(cache_dir).await {
        Ok(entries) => entries,
        Err(_) => return,
    };

    while let Ok(Some(entry)) = entries.next_entry().await {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();

        if let Ok(meta) = entry.metadata().await {
            if CACHE_KNOWN_FILES.contains(&name.as_ref()) {
                total_size += meta.len();
            } else if meta.is_file() {
                // Remove unknown files (e.g., stale temp files from interrupted downloads)
                if let Err(e) = tokio::fs::remove_file(entry.path()).await {
                    warn!(file = %name, error = %e, "Failed to clean up unknown cache file");
                } else {
                    info!(file = %name, size_bytes = meta.len(), "Removed unknown file from GTFS cache");
                    removed += 1;
                }
            }
        }
    }

    if removed > 0 {
        info!(removed, "Cleaned up GTFS cache directory");
    }
    debug!(total_size_mb = total_size / (1024 * 1024), "GTFS cache disk usage");
}

/// Download the static GTFS feed to the cache directory.
/// Result of a feed download attempt.
pub struct DownloadResult {
    /// Path to the zip file (cached or freshly downloaded).
    pub zip_path: PathBuf,
    /// Whether the feed was freshly downloaded (true) or served from cache (false).
    pub was_updated: bool,
}

pub async fn download_feed(
    client: &reqwest::Client,
    url: &str,
    cache_dir: &str,
) -> Result<DownloadResult, GtfsError> {
    let cache_path = Path::new(cache_dir);
    tokio::fs::create_dir_all(cache_path).await?;

    // Clean up stale/unknown files before downloading
    cleanup_cache(cache_path).await;

    let zip_path = cache_path.join("latest.zip");
    let metadata_path = cache_path.join("metadata.json");

    // Conditional request with ETag/Last-Modified
    let mut request = client.get(url);
    if let Ok(meta_content) = tokio::fs::read_to_string(&metadata_path).await {
        if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&meta_content) {
            if let Some(etag) = meta.get("etag").and_then(|v| v.as_str()) {
                request = request.header("If-None-Match", etag);
            }
            if let Some(last_modified) = meta.get("last_modified").and_then(|v| v.as_str()) {
                request = request.header("If-Modified-Since", last_modified);
            }
        }
    }

    let response = request
        .timeout(std::time::Duration::from_secs(600))
        .send()
        .await?;

    if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        info!("Static GTFS feed not modified, using cached version");
        return Ok(DownloadResult {
            zip_path,
            was_updated: false,
        });
    }

    if !response.status().is_success() {
        return Err(GtfsError::NetworkMessage(format!(
            "GTFS download HTTP {}",
            response.status()
        )));
    }

    // Check Content-Length before downloading
    if let Some(content_length) = response.content_length() {
        if content_length > MAX_DOWNLOAD_SIZE {
            return Err(GtfsError::NetworkMessage(format!(
                "GTFS download too large: {} bytes (max {} bytes)",
                content_length, MAX_DOWNLOAD_SIZE
            )));
        }
    }

    // Save headers for future conditional requests (limited to MAX_HEADER_LENGTH)
    let etag = response
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .filter(|s| s.len() <= MAX_HEADER_LENGTH)
        .map(|s| s.to_string());
    let last_modified = response
        .headers()
        .get("last-modified")
        .and_then(|v| v.to_str().ok())
        .filter(|s| s.len() <= MAX_HEADER_LENGTH)
        .map(|s| s.to_string());

    // Stream download with size limit
    let mut total_bytes: u64 = 0;
    let mut file = tokio::fs::File::create(&zip_path).await?;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        total_bytes += chunk.len() as u64;
        if total_bytes > MAX_DOWNLOAD_SIZE {
            drop(file);
            let _ = tokio::fs::remove_file(&zip_path).await;
            return Err(GtfsError::NetworkMessage(format!(
                "GTFS download exceeded size limit at {} bytes (max {} bytes)",
                total_bytes, MAX_DOWNLOAD_SIZE
            )));
        }
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    drop(file);

    info!(size_mb = total_bytes / (1024 * 1024), "Downloaded static GTFS feed");

    let meta = serde_json::json!({
        "etag": etag,
        "last_modified": last_modified,
        "downloaded_at": chrono::Utc::now().to_rfc3339(),
    });
    let _ = tokio::fs::write(&metadata_path, meta.to_string()).await;

    Ok(DownloadResult {
        zip_path,
        was_updated: true,
    })
}

/// Load the GTFS zip into an in-memory schedule (blocking — call on spawn_blocking).
#[cfg(test)]
pub fn load_schedule(zip_path: &Path) -> Result<GtfsSchedule, GtfsError> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;

    // ZIP bomb protection: check total uncompressed size
    let mut total_uncompressed: u64 = 0;
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            total_uncompressed += entry.size();
        }
    }
    if total_uncompressed > MAX_DECOMPRESSED_SIZE {
        return Err(GtfsError::ParseError(format!(
            "GTFS zip decompressed size {} bytes exceeds limit {} bytes",
            total_uncompressed, MAX_DECOMPRESSED_SIZE
        )));
    }
    info!(
        compressed_mb = std::fs::metadata(zip_path).map(|m| m.len() / (1024 * 1024)).unwrap_or(0),
        decompressed_mb = total_uncompressed / (1024 * 1024),
        "Verified GTFS zip size within limits"
    );

    let stops = parse_stops(&mut archive)?;
    info!(count = stops.len(), "Parsed GTFS stops");

    let routes = parse_routes(&mut archive)?;
    info!(count = routes.len(), "Parsed GTFS routes");

    let trips = parse_trips(&mut archive)?;
    info!(count = trips.len(), "Parsed GTFS trips");

    let stop_times = parse_stop_times(&mut archive)?;
    let total_st: usize = stop_times.values().map(|v| v.len()).sum();
    info!(trips_with_times = stop_times.len(), total_stop_times = total_st, "Parsed GTFS stop_times");

    let calendars = parse_calendar(&mut archive);
    info!(count = calendars.len(), "Parsed GTFS calendar");

    let calendar_dates = parse_calendar_dates(&mut archive);
    let total_cd: usize = calendar_dates.values().map(|v| v.len()).sum();
    info!(services = calendar_dates.len(), total_exceptions = total_cd, "Parsed GTFS calendar_dates");

    // Build reverse index: stop_id -> trip_ids
    let mut trips_by_stop: HashMap<String, HashSet<String>> = HashMap::new();
    for (trip_id, sts) in &stop_times {
        for st in sts {
            trips_by_stop
                .entry(st.stop_id.clone())
                .or_default()
                .insert(trip_id.clone());
        }
    }
    info!(stops_indexed = trips_by_stop.len(), "Built trips-by-stop index");

    Ok(GtfsSchedule {
        stops,
        routes,
        trips,
        stop_times,
        calendars,
        calendar_dates,
        trips_by_stop,
        ifopt_to_gtfs: HashMap::new(),
        gtfs_to_ifopt: HashMap::new(),
        loaded_at: chrono::Utc::now(),
    })
}

/// Maximum rows per batch for bulk INSERT into PostgreSQL.
/// PostgreSQL supports max 65535 bind parameters per query.
/// With 5 columns per row: 65535 / 5 = 13107 max.
const DB_BATCH_SIZE: usize = 10_000;
/// Calendar has 10 columns: 65535 / 10 = 6553 max.
const DB_BATCH_SIZE_CALENDAR: usize = 5_000;

/// A single stop_time row for streaming insertion (avoids holding all 31.5M rows in memory).
struct StopTimeRow {
    trip_id: String,
    stop_sequence: i32,
    stop_id: String,
    arrival_time: Option<i32>,
    departure_time: Option<i32>,
}

/// Load GTFS data from a zip file into PostgreSQL tables.
///
/// Parses CSV files from the zip, truncates existing GTFS data,
/// and bulk-inserts all records into the database. Stop times (the largest
/// table at ~31.5M rows) are streamed via a channel to avoid holding them
/// all in memory at once.
pub async fn load_schedule_to_db(pool: &PgPool, zip_path: &Path) -> Result<(), GtfsError> {
    info!("Parsing GTFS zip for database loading...");

    // Phase 1: Parse everything except stop_times (all fit in memory)
    let path = zip_path.to_path_buf();
    let (stops, routes, trips, calendars, calendar_dates) =
        tokio::task::spawn_blocking({
            let path = path.clone();
            move || -> Result<_, GtfsError> {
                let file = std::fs::File::open(&path)?;
                let mut archive = zip::ZipArchive::new(file)?;

                // ZIP bomb protection
                let mut total_uncompressed: u64 = 0;
                for i in 0..archive.len() {
                    if let Ok(entry) = archive.by_index(i) {
                        total_uncompressed += entry.size();
                    }
                }
                if total_uncompressed > MAX_DECOMPRESSED_SIZE {
                    return Err(GtfsError::ParseError(format!(
                        "GTFS zip decompressed size {} bytes exceeds limit {} bytes",
                        total_uncompressed, MAX_DECOMPRESSED_SIZE
                    )));
                }

                let stops = parse_stops(&mut archive)?;
                let routes = parse_routes(&mut archive)?;
                let trips = parse_trips(&mut archive)?;
                let calendars = parse_calendar(&mut archive);
                let calendar_dates = parse_calendar_dates(&mut archive);

                Ok((stops, routes, trips, calendars, calendar_dates))
            }
        })
        .await??;

    let stop_count = stops.len();
    let route_count = routes.len();
    let trip_count = trips.len();

    info!(
        stops = stop_count,
        routes = route_count,
        trips = trip_count,
        "Parsed GTFS data (except stop_times), loading into database..."
    );

    // Truncate all GTFS tables (fast, DDL-level reset)
    sqlx::query(
        "TRUNCATE gtfs_stop_times, gtfs_trips, gtfs_routes, gtfs_stops, \
         gtfs_calendar, gtfs_calendar_dates, ifopt_gtfs_mapping, gtfs_feed_meta",
    )
    .execute(pool)
    .await?;
    info!("Truncated existing GTFS tables");

    // --- Insert stops ---
    let stop_values: Vec<_> = stops.values().collect();
    for (batch_idx, batch) in stop_values.chunks(DB_BATCH_SIZE).enumerate() {
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO gtfs_stops (stop_id, stop_name, parent_station, lat, lon) ",
        );
        qb.push_values(batch.iter(), |mut b, stop| {
            b.push_bind(&stop.stop_id)
                .push_bind(&stop.stop_name)
                .push_bind(&stop.parent_station)
                .push_bind(stop.lat)
                .push_bind(stop.lon);
        });
        qb.build().execute(pool).await?;
        if (batch_idx + 1) % 10 == 0 {
            debug!(batch = batch_idx + 1, "Inserted stops batch");
        }
    }
    info!(count = stop_count, "Inserted GTFS stops");

    // --- Insert routes ---
    let route_values: Vec<_> = routes.values().collect();
    for batch in route_values.chunks(DB_BATCH_SIZE) {
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO gtfs_routes (route_id, route_short_name, route_long_name, route_type) ",
        );
        qb.push_values(batch.iter(), |mut b, route| {
            b.push_bind(&route.route_id)
                .push_bind(&route.route_short_name)
                .push_bind(&route.route_long_name)
                .push_bind(route.route_type);
        });
        qb.build().execute(pool).await?;
    }
    info!(count = route_count, "Inserted GTFS routes");

    // --- Insert trips ---
    let trip_values: Vec<_> = trips.values().collect();
    for batch in trip_values.chunks(DB_BATCH_SIZE) {
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO gtfs_trips (trip_id, route_id, service_id, trip_headsign, direction_id) ",
        );
        qb.push_values(batch.iter(), |mut b, trip| {
            b.push_bind(&trip.trip_id)
                .push_bind(&trip.route_id)
                .push_bind(&trip.service_id)
                .push_bind(&trip.trip_headsign)
                .push_bind(trip.direction_id);
        });
        qb.build().execute(pool).await?;
    }
    info!(count = trip_count, "Inserted GTFS trips");

    // --- Stream stop_times (largest table: ~31.5M rows) ---
    // Instead of loading all rows into memory (which would use ~2.5GB),
    // we stream batches through a channel from a blocking CSV reader.
    let (tx, mut rx) =
        tokio::sync::mpsc::channel::<Result<Vec<StopTimeRow>, GtfsError>>(4);

    let producer = tokio::task::spawn_blocking(move || -> Result<usize, GtfsError> {
        let file = std::fs::File::open(&path)?;
        let mut archive = zip::ZipArchive::new(file)?;

        info!("Parsing stop_times.txt (streaming)");
        let csv_file = archive.by_name("stop_times.txt")?;
        let mut rdr = csv::Reader::from_reader(csv_file);
        let headers = rdr.headers()?.clone();

        let idx_trip = headers
            .iter()
            .position(|h| h == "trip_id")
            .ok_or_else(|| GtfsError::ParseError("stop_times.txt missing trip_id".into()))?;
        let idx_seq = headers
            .iter()
            .position(|h| h == "stop_sequence")
            .ok_or_else(|| {
                GtfsError::ParseError("stop_times.txt missing stop_sequence".into())
            })?;
        let idx_stop = headers
            .iter()
            .position(|h| h == "stop_id")
            .ok_or_else(|| GtfsError::ParseError("stop_times.txt missing stop_id".into()))?;
        let idx_arr = headers.iter().position(|h| h == "arrival_time");
        let idx_dep = headers.iter().position(|h| h == "departure_time");

        let mut batch = Vec::with_capacity(DB_BATCH_SIZE);
        let mut total_rows = 0usize;
        let mut skipped = 0usize;

        for result in rdr.records() {
            let record = result?;
            let trip_id = record.get(idx_trip).unwrap_or("").to_string();
            if trip_id.is_empty() {
                skipped += 1;
                continue;
            }
            batch.push(StopTimeRow {
                trip_id,
                stop_sequence: record
                    .get(idx_seq)
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0),
                stop_id: record.get(idx_stop).unwrap_or("").to_string(),
                arrival_time: idx_arr
                    .and_then(|i| record.get(i))
                    .and_then(parse_gtfs_time),
                departure_time: idx_dep
                    .and_then(|i| record.get(i))
                    .and_then(parse_gtfs_time),
            });
            total_rows += 1;

            if batch.len() >= DB_BATCH_SIZE {
                if tx.blocking_send(Ok(std::mem::take(&mut batch))).is_err() {
                    return Err(GtfsError::ParseError(
                        "stop_times receiver dropped".into(),
                    ));
                }
                batch = Vec::with_capacity(DB_BATCH_SIZE);
            }
        }

        // Send remaining rows
        if !batch.is_empty() {
            let _ = tx.blocking_send(Ok(batch));
        }

        if skipped > 0 {
            warn!(skipped, "Skipped stop_times.txt records with empty trip_id");
        }

        Ok(total_rows)
    });

    // Receive and insert batches as they arrive
    let mut stop_time_count = 0usize;
    let mut batch_idx = 0usize;
    while let Some(batch_result) = rx.recv().await {
        let batch = batch_result?;
        stop_time_count += batch.len();
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO gtfs_stop_times (trip_id, stop_sequence, stop_id, arrival_time, departure_time) ",
        );
        qb.push_values(batch.iter(), |mut b, st| {
            b.push_bind(&st.trip_id)
                .push_bind(st.stop_sequence)
                .push_bind(&st.stop_id)
                .push_bind(st.arrival_time)
                .push_bind(st.departure_time);
        });
        qb.build().execute(pool).await?;
        batch_idx += 1;
        if batch_idx % 100 == 0 {
            info!(
                batch = batch_idx,
                rows = stop_time_count,
                "Inserting stop_times..."
            );
        }
    }

    // Wait for the producer to finish and check for errors
    let producer_count = producer.await??;
    debug_assert_eq!(stop_time_count, producer_count);
    info!(count = stop_time_count, "Inserted GTFS stop_times");

    // --- Insert calendar ---
    let cal_values: Vec<_> = calendars.values().collect();
    for batch in cal_values.chunks(DB_BATCH_SIZE_CALENDAR) {
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO gtfs_calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) ",
        );
        qb.push_values(batch.iter(), |mut b, cal| {
            b.push_bind(&cal.service_id)
                .push_bind(cal.days[0])
                .push_bind(cal.days[1])
                .push_bind(cal.days[2])
                .push_bind(cal.days[3])
                .push_bind(cal.days[4])
                .push_bind(cal.days[5])
                .push_bind(cal.days[6])
                .push_bind(cal.start_date)
                .push_bind(cal.end_date);
        });
        qb.build().execute(pool).await?;
    }
    info!(count = calendars.len(), "Inserted GTFS calendar");

    // --- Insert calendar_dates ---
    let flat_cal_dates: Vec<(&String, &GtfsCalendarDate)> = calendar_dates
        .iter()
        .flat_map(|(service_id, dates)| dates.iter().map(move |d| (service_id, d)))
        .collect();
    for batch in flat_cal_dates.chunks(DB_BATCH_SIZE) {
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO gtfs_calendar_dates (service_id, date, exception_type) ",
        );
        qb.push_values(batch.iter(), |mut b, (service_id, cd)| {
            b.push_bind(service_id.as_str())
                .push_bind(cd.date)
                .push_bind(cd.exception_type);
        });
        qb.build().execute(pool).await?;
    }
    info!(count = flat_cal_dates.len(), "Inserted GTFS calendar_dates");

    // --- Update feed metadata ---
    sqlx::query(
        "INSERT INTO gtfs_feed_meta (id, loaded_at, stop_count, route_count, trip_count, stop_time_count) \
         VALUES (1, now(), $1, $2, $3, $4) \
         ON CONFLICT (id) DO UPDATE SET \
         loaded_at = now(), stop_count = $1, route_count = $2, trip_count = $3, stop_time_count = $4",
    )
    .bind(stop_count as i64)
    .bind(route_count as i64)
    .bind(trip_count as i64)
    .bind(stop_time_count as i64)
    .execute(pool)
    .await?;

    info!(
        stops = stop_count,
        routes = route_count,
        trips = trip_count,
        stop_times = stop_time_count,
        "GTFS data loaded into database"
    );
    Ok(())
}

/// Build the IFOPT <-> GTFS stop ID mapping and store it in PostgreSQL.
///
/// Uses deterministic route-set comparison: matches only when route sets
/// form a subset relationship with non-empty intersection, and exactly one
/// such candidate exists. Stops without OSM route data are left unmatched.
///
/// Fetches GTFS leaf stops from the database, runs the matching algorithm
/// against provided OSM stops, and stores results in `ifopt_gtfs_mapping`.
/// Returns mapping statistics for issue reporting.
pub(crate) async fn build_ifopt_mapping_to_db(
    pool: &PgPool,
    osm_stops: &[OsmStopInfo],
) -> Result<MappingStats, GtfsError> {
    // Fetch GTFS leaf stops from DB: those with parent_station OR that appear in stop_times
    let gtfs_leaf_stops: Vec<(String, Option<String>, Option<f64>, Option<f64>)> = sqlx::query_as(
        r#"
        SELECT DISTINCT s.stop_id, s.stop_name, s.lat, s.lon
        FROM gtfs_stops s
        WHERE (s.parent_station IS NOT NULL
               OR s.stop_id IN (SELECT DISTINCT stop_id FROM gtfs_stop_times))
          AND s.lat IS NOT NULL
          AND s.lon IS NOT NULL
        "#,
    )
    .fetch_all(pool)
    .await?;

    info!(
        gtfs_leaf_stops = gtfs_leaf_stops.len(),
        osm_stops = osm_stops.len(),
        "Fetched GTFS leaf stops for mapping"
    );

    // Build candidate list with coordinates
    let gtfs_candidates: Vec<(&str, f64, f64, Option<&str>)> = gtfs_leaf_stops
        .iter()
        .filter_map(|(id, name, lat, lon)| {
            Some((id.as_str(), (*lat)?, (*lon)?, name.as_deref()))
        })
        .collect();

    // Fetch existing manual mappings to preserve them across rebuild
    let manual_rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT ifopt, gtfs_stop_id FROM ifopt_gtfs_mapping WHERE is_manual = TRUE",
    )
    .fetch_all(pool)
    .await?;

    let manual_ifopts: HashSet<String> = manual_rows.iter().map(|(i, _)| i.clone()).collect();
    let manual_gtfs_ids: HashSet<String> = manual_rows.iter().map(|(_, g)| g.clone()).collect();

    let manual_count = manual_ifopts.len();
    if manual_count > 0 {
        info!(manual_count, "Preserving manual IFOPT mappings");
    }

    // Load OSM route sets (bulk, all IFOPTs) and directional route IDs
    let (osm_route_sets, osm_directional_routes) = load_osm_route_sets(pool).await?;
    let osm_destinations = load_osm_destinations(pool).await?;

    let max_dist_deg = MAX_DISTANCE_METERS / 111_000.0;
    let max_dist_sq = max_dist_deg * max_dist_deg;
    let empty_route_set: HashSet<RouteIdentifier> = HashSet::new();
    let empty_osm_id_set: HashSet<i64> = HashSet::new();
    let empty_trip_set: HashSet<String> = HashSet::new();
    let empty_string_set: HashSet<String> = HashSet::new();

    // Proximity pre-filter: collect all GTFS stop IDs within range of any OSM stop
    let mut proximity_gtfs_ids: HashSet<&str> = HashSet::new();
    for osm_stop in osm_stops {
        if manual_ifopts.contains(&osm_stop.ifopt) {
            continue;
        }
        for &(gtfs_id, glat, glon, _) in &gtfs_candidates {
            if manual_gtfs_ids.contains(gtfs_id) {
                continue;
            }
            let dlat = osm_stop.lat - glat;
            let dlon = (osm_stop.lon - glon) * (osm_stop.lat.to_radians().cos());
            let dist_sq = dlat * dlat + dlon * dlon;
            if dist_sq < max_dist_sq {
                proximity_gtfs_ids.insert(gtfs_id);
            }
        }
    }

    // Load GTFS route sets only for stops that passed proximity pre-filter
    let proximity_gtfs_vec: Vec<&str> = proximity_gtfs_ids.into_iter().collect();
    let gtfs_route_sets = load_gtfs_route_sets(pool, &proximity_gtfs_vec).await?;

    // Load GTFS trip sets for direction-aware matching via trip overlap
    let gtfs_trip_sets = load_gtfs_trip_sets(pool, &proximity_gtfs_vec).await?;

    // Load GTFS direction info (last stop names) for direction-based matching
    let gtfs_directions = load_gtfs_directions(pool, &proximity_gtfs_vec).await?;

    // Build reverse index: OSM route osm_id → IFOPTs on that route
    let mut osm_route_to_ifopts: HashMap<i64, Vec<String>> = HashMap::new();
    for (ifopt, osm_ids) in &osm_directional_routes {
        for &osm_id in osm_ids {
            osm_route_to_ifopts
                .entry(osm_id)
                .or_default()
                .push(ifopt.clone());
        }
    }

    // Deterministic route-based matching
    struct IfoptCandidates {
        ifopt: String,
        name: Option<String>,
        lat: f64,
        lon: f64,
        candidates: Vec<MatchCandidate>,
        reason: UnmatchedReason,
    }

    // Pass 1: Collect all candidates for each OSM stop
    struct PendingDbMatch {
        ifopt: String,
        name: Option<String>,
        lat: f64,
        lon: f64,
        candidates: Vec<MatchCandidate>,
        best_distance: f64,
    }

    let mut no_route_entries: Vec<IfoptCandidates> = Vec::new();
    let mut pending: Vec<PendingDbMatch> = Vec::new();
    let mut seen_ifopts: HashSet<String> = HashSet::new();

    for osm_stop in osm_stops {
        if manual_ifopts.contains(&osm_stop.ifopt) {
            continue;
        }
        // Skip duplicate IFOPT entries (same IFOPT may appear from both platforms and stop_positions)
        if !seen_ifopts.insert(osm_stop.ifopt.clone()) {
            continue;
        }

        let osm_routes = osm_route_sets
            .get(&osm_stop.ifopt)
            .unwrap_or(&empty_route_set);

        if osm_routes.is_empty() {
            no_route_entries.push(IfoptCandidates {
                ifopt: osm_stop.ifopt.clone(),
                name: osm_stop.name.clone(),
                lat: osm_stop.lat,
                lon: osm_stop.lon,
                candidates: vec![],
                reason: UnmatchedReason::NoRouteData,
            });
            continue;
        }

        let mut candidates: Vec<MatchCandidate> = Vec::new();

        for &(gtfs_id, glat, glon, gtfs_name) in &gtfs_candidates {
            if manual_gtfs_ids.contains(gtfs_id) {
                continue;
            }

            let dlat = osm_stop.lat - glat;
            let dlon = (osm_stop.lon - glon) * (osm_stop.lat.to_radians().cos());
            let dist_sq = dlat * dlat + dlon * dlon;

            if dist_sq < max_dist_sq {
                let distance_meters = (dist_sq.sqrt()) * 111_000.0;

                let gtfs_routes = gtfs_route_sets
                    .get(gtfs_id)
                    .unwrap_or(&empty_route_set);
                let (definitive, shared) = is_definitive_match(osm_routes, gtfs_routes);

                let shared_routes: Vec<String> = shared
                    .iter()
                    .map(|r| format!("{:?} {}", r.transport_type, r.line_ref))
                    .collect();

                candidates.push(MatchCandidate {
                    gtfs_stop_id: gtfs_id.to_string(),
                    gtfs_stop_name: gtfs_name.map(String::from),
                    distance_meters,
                    shared_routes,
                    is_definitive: definitive,
                });
            }
        }

        let best_distance = candidates
            .iter()
            .filter(|c| c.is_definitive)
            .map(|c| c.distance_meters)
            .fold(f64::MAX, f64::min);

        pending.push(PendingDbMatch {
            ifopt: osm_stop.ifopt.clone(),
            name: osm_stop.name.clone(),
            lat: osm_stop.lat,
            lon: osm_stop.lon,
            candidates,
            best_distance,
        });
    }

    // Pass 2: Sort by distance to closest definitive candidate (ascending).
    // Stops nearest their best GTFS match get first pick.
    pending.sort_by(|a, b| {
        a.best_distance
            .partial_cmp(&b.best_distance)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut mapping_results: HashMap<String, String> = HashMap::new();
    let mut claimed_gtfs: HashSet<String> = HashSet::new();
    let mut unmatched_entries: Vec<IfoptCandidates> = Vec::new();

    // Direction-aware matching with cascading peer propagation.
    // Each iteration picks the platform with the most matched peers, matches it using
    // per-peer trip overlap voting, then re-sorts. This ensures correct direction signal
    // propagates outward from cross-line seed stations (e.g., a station on both Line 2
    // and Line 4 gets matched via Line 2 peers, then its Line 4 neighbors benefit).
    let mut to_process: Vec<PendingDbMatch> = pending;

    let peer_count_for = |ifopt: &str, results: &HashMap<String, String>| -> usize {
        osm_directional_routes
            .get(ifopt)
            .unwrap_or(&empty_osm_id_set)
            .iter()
            .flat_map(|rid| osm_route_to_ifopts.get(rid).into_iter().flatten())
            .filter(|peer_ifopt| results.contains_key(*peer_ifopt))
            .count()
    };

    loop {
        if to_process.is_empty() {
            break;
        }

        // Sort: fewest unclaimed definitive candidates first (most constrained
        // platforms get priority to avoid being blocked), then most peers
        // (direction-seeded platforms go next), then distance.
        to_process.sort_by(|a, b| {
            let a_unclaimed = a.candidates.iter()
                .filter(|c| c.is_definitive && !claimed_gtfs.contains(&c.gtfs_stop_id))
                .count();
            let b_unclaimed = b.candidates.iter()
                .filter(|c| c.is_definitive && !claimed_gtfs.contains(&c.gtfs_stop_id))
                .count();
            let a_peers = peer_count_for(&a.ifopt, &mapping_results);
            let b_peers = peer_count_for(&b.ifopt, &mapping_results);
            a_unclaimed.cmp(&b_unclaimed)
                .then_with(|| b_peers.cmp(&a_peers))
                .then_with(|| {
                    a.best_distance
                        .partial_cmp(&b.best_distance)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
        });

        let entry = to_process.remove(0);

        let platform_osm_ids = osm_directional_routes
            .get(&entry.ifopt)
            .unwrap_or(&empty_osm_id_set);

        let mut peer_gtfs_ids: Vec<String> = Vec::new();
        for &route_id in platform_osm_ids {
            if let Some(peer_ifopts) = osm_route_to_ifopts.get(&route_id) {
                for peer_ifopt in peer_ifopts {
                    if let Some(peer_gtfs_id) = mapping_results.get(peer_ifopt) {
                        peer_gtfs_ids.push(peer_gtfs_id.clone());
                    }
                }
            }
        }
        peer_gtfs_ids.sort();
        peer_gtfs_ids.dedup();

        let mut definitive_candidates: Vec<&MatchCandidate> = entry
            .candidates
            .iter()
            .filter(|c| c.is_definitive)
            .collect();

        if !definitive_candidates.is_empty() {
            let nearest_distance = definitive_candidates
                .iter()
                .map(|c| c.distance_meters)
                .fold(f64::MAX, f64::min);
            let max_fallback = (nearest_distance * 3.0).max(100.0).min(200.0);

            // Direction overlap: how many destination keywords from the OSM route
            // name match the GTFS stop's last-stop keywords. This is the strongest
            // signal for matching platforms at stations like Königsplatz where all
            // GTFS stops share the same name but serve different directions.
            let osm_dest = osm_destinations
                .get(&entry.ifopt)
                .unwrap_or(&empty_string_set);
            let direction_score_for = |c: &MatchCandidate| -> usize {
                if osm_dest.is_empty() {
                    return 0;
                }
                let gtfs_dir = gtfs_directions
                    .get(&c.gtfs_stop_id)
                    .unwrap_or(&empty_string_set);
                osm_dest.intersection(gtfs_dir).count()
            };

            // Specificity: prefer GTFS stops whose route set closely matches
            // the OSM platform's routes.
            let specificity_for = |c: &MatchCandidate| -> f64 {
                let gtfs_routes = gtfs_route_sets
                    .get(&c.gtfs_stop_id)
                    .map(|s| s.len())
                    .unwrap_or(1)
                    .max(1);
                c.shared_routes.len() as f64 / gtfs_routes as f64
            };

            // Sort by: direction match (primary) → specificity → trip overlap
            // (when peers exist) → distance → shared_routes count.
            definitive_candidates.sort_by(|a, b| {
                let a_dir = direction_score_for(a);
                let b_dir = direction_score_for(b);
                let dir_cmp = b_dir.cmp(&a_dir);

                let a_spec = specificity_for(a);
                let b_spec = specificity_for(b);
                let spec_cmp = b_spec
                    .partial_cmp(&a_spec)
                    .unwrap_or(std::cmp::Ordering::Equal);

                let trip_cmp = if peer_gtfs_ids.is_empty() {
                    std::cmp::Ordering::Equal
                } else {
                    let a_overlap: usize = peer_gtfs_ids
                        .iter()
                        .map(|peer_id| {
                            let peer_trips =
                                gtfs_trip_sets.get(peer_id).unwrap_or(&empty_trip_set);
                            gtfs_trip_sets
                                .get(&a.gtfs_stop_id)
                                .map(|candidate_trips| {
                                    candidate_trips
                                        .iter()
                                        .filter(|t| peer_trips.contains(*t))
                                        .count()
                                })
                                .unwrap_or(0)
                        })
                        .sum();
                    let b_overlap: usize = peer_gtfs_ids
                        .iter()
                        .map(|peer_id| {
                            let peer_trips =
                                gtfs_trip_sets.get(peer_id).unwrap_or(&empty_trip_set);
                            gtfs_trip_sets
                                .get(&b.gtfs_stop_id)
                                .map(|candidate_trips| {
                                    candidate_trips
                                        .iter()
                                        .filter(|t| peer_trips.contains(*t))
                                        .count()
                                })
                                .unwrap_or(0)
                        })
                        .sum();
                    b_overlap.cmp(&a_overlap)
                };
                dir_cmp
                    .then(spec_cmp)
                    .then(trip_cmp)
                    .then_with(|| {
                        a.distance_meters
                            .partial_cmp(&b.distance_meters)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
                    .then_with(|| b.shared_routes.len().cmp(&a.shared_routes.len()))
            });

            let mut matched = false;
            for winner in &definitive_candidates {
                if winner.distance_meters > max_fallback {
                    continue;
                }
                if !claimed_gtfs.contains(&winner.gtfs_stop_id) {
                    mapping_results
                        .insert(entry.ifopt.clone(), winner.gtfs_stop_id.clone());
                    claimed_gtfs.insert(winner.gtfs_stop_id.clone());
                    matched = true;
                    break;
                }
            }
            if matched {
                continue; // Re-sort remaining with updated peers
            }
        }

        let reason = if definitive_candidates.is_empty() {
            UnmatchedReason::NoDefinitiveCandidate
        } else {
            UnmatchedReason::AmbiguousMatch
        };

        unmatched_entries.push(IfoptCandidates {
            ifopt: entry.ifopt,
            name: entry.name,
            lat: entry.lat,
            lon: entry.lon,
            candidates: entry.candidates,
            reason,
        });
    }

    // Station-level fallback: when the GTFS feed has a single stop for both
    // directions at a station, allow unmapped sibling platforms to share it.
    let mut station_fallback_matched = Vec::new();
    for entry in &unmatched_entries {
        let station = station_level_ifopt(&entry.ifopt);
        // Find if a sibling platform at this station is already mapped
        let sibling_gtfs: Option<String> = mapping_results
            .iter()
            .find(|(ifopt, _)| station_level_ifopt(ifopt) == station && *ifopt != &entry.ifopt)
            .map(|(_, gtfs_id)| gtfs_id.clone());

        if let Some(sibling_gtfs_id) = sibling_gtfs {
            // Only allow if this GTFS stop is a definitive (route-matching) candidate
            if entry.candidates.iter().any(|c| c.gtfs_stop_id == sibling_gtfs_id && c.is_definitive) {
                station_fallback_matched.push((entry.ifopt.clone(), sibling_gtfs_id));
            }
        }
    }
    for (ifopt, gtfs_id) in &station_fallback_matched {
        mapping_results.insert(ifopt.clone(), gtfs_id.clone());
    }
    // Remove matched entries from unmatched list
    unmatched_entries.retain(|e| !station_fallback_matched.iter().any(|(ifopt, _)| ifopt == &e.ifopt));
    if !station_fallback_matched.is_empty() {
        info!(
            count = station_fallback_matched.len(),
            "Station-level fallback: shared GTFS stops for sibling platforms"
        );
    }

    unmatched_entries.extend(no_route_entries);

    let matched = mapping_results.len();

    // Build unmatched lists
    let unmatched_osm: Vec<UnmatchedOsmStop> = unmatched_entries
        .iter()
        .map(|entry| UnmatchedOsmStop {
            ifopt: entry.ifopt.clone(),
            name: entry.name.clone(),
            lat: entry.lat,
            lon: entry.lon,
            candidates: entry.candidates.iter().take(5).cloned().collect(),
            reason: entry.reason.clone(),
        })
        .collect();

    // Find unmatched GTFS stops (not claimed by auto or manual)
    let unmatched_gtfs: Vec<UnmatchedGtfsStop> = gtfs_candidates
        .iter()
        .filter(|(gtfs_id, _, _, _)| {
            !claimed_gtfs.contains(*gtfs_id) && !manual_gtfs_ids.contains(*gtfs_id)
        })
        .map(|(gtfs_id, lat, lon, name)| UnmatchedGtfsStop {
            gtfs_stop_id: gtfs_id.to_string(),
            gtfs_stop_name: name.map(String::from),
            lat: *lat,
            lon: *lon,
        })
        .collect();

    // Delete only auto-generated mappings (preserve manual ones)
    sqlx::query("DELETE FROM ifopt_gtfs_mapping WHERE is_manual = FALSE")
        .execute(pool)
        .await?;

    let mapping_entries: Vec<_> = mapping_results.iter().collect();
    for batch in mapping_entries.chunks(DB_BATCH_SIZE) {
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO ifopt_gtfs_mapping (ifopt, gtfs_stop_id, combined_score, is_manual) ",
        );
        qb.push_values(batch.iter(), |mut b, (ifopt, gtfs_stop_id)| {
            b.push_bind(ifopt.as_str())
                .push_bind(gtfs_stop_id.as_str())
                .push_bind(1.0_f64) // Deterministic match always gets 1.0
                .push_bind(false);
        });
        qb.build().execute(pool).await?;
    }

    // Update mapping count in feed metadata (manual + auto)
    let total_mapping_count = mapping_results.len() + manual_count;
    sqlx::query("UPDATE gtfs_feed_meta SET mapping_count = $1 WHERE id = 1")
        .bind(total_mapping_count as i64)
        .execute(pool)
        .await?;

    info!(
        osm_stops = osm_stops.len(),
        gtfs_leaf_stops = gtfs_candidates.len(),
        matched,
        manual_preserved = manual_count,
        unmatched_osm = unmatched_osm.len(),
        unmatched_gtfs = unmatched_gtfs.len(),
        "Built and stored IFOPT <-> GTFS stop mapping in database (deterministic route-based)"
    );

    Ok(MappingStats {
        total_db_stops: osm_stops.len(),
        total_gtfs_stops: gtfs_candidates.len(),
        matched,
        manual_count,
        unmatched_osm,
        unmatched_gtfs,
    })
}

/// Validate IFOPT-to-GTFS mappings against known-correct assignments.
/// Logs warnings for any mismatches. This runs after every mapping rebuild
/// to catch regressions in the matching algorithm.
///
/// Expected mappings are based on official AVV platform assignments and verified
/// GTFS stop directions. New stations can be added to the `expected` list.
pub async fn validate_mappings(pool: &PgPool) {
    // Each entry: (IFOPT, expected primary tram line, expected direction keyword)
    // The GTFS stop must serve the expected line AND have trips ending at stops
    // whose names contain the direction keyword.
    let expected: Vec<(&str, &str, &str)> = vec![
        // Königsplatz (official AVV platform assignments)
        ("de:09761:101:31:A1", "1", "lechhausen"),
        ("de:09761:101:31:A2", "1", "göggingen"),
        ("de:09761:101:31:A3", "4", "oberhausen"),
        ("de:09761:101:31:A4", "4", "hauptbahnhof"),
        ("de:09761:101:41:B1", "2", "haunstetten"),
        ("de:09761:101:41:B2", "2", "augsburg"),  // "Augsburg West P+R"
        ("de:09761:101:51:C1", "6", "stadtbergen"),
        ("de:09761:101:51:C2", "6", "friedberg"),
        ("de:09761:101:51:C3", "3", "hauptbahnhof"),
        ("de:09761:101:51:C4", "3", "inninger"),  // "Inninger Straße P+R"
        // Kulturstraße (single GTFS stop for both directions, direction filtering in API)
        ("de:09761:691:0:a", "1", "lechhausen"),
        ("de:09761:691:0:e", "1", "göggingen"),
        // Maria Stern
        ("de:09761:715:31:A", "1", "göggingen"),
        ("de:09761:715:31:B", "1", "lechhausen"),
    ];

    let mut failures = 0;
    let mut checked = 0;

    for (ifopt, expected_line, expected_direction) in &expected {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT gtfs_stop_id FROM ifopt_gtfs_mapping WHERE ifopt = $1",
        )
        .bind(ifopt)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);

        let Some((gtfs_id,)) = row else {
            tracing::warn!(
                ifopt,
                expected_line,
                expected_direction,
                "Mapping validation FAILED: IFOPT not mapped"
            );
            failures += 1;
            continue;
        };

        // Check: does this GTFS stop serve the expected line?
        let has_line: Option<(i64,)> = sqlx::query_as(
            r#"
            SELECT COUNT(DISTINCT t.trip_id)
            FROM gtfs_stop_times st
            JOIN gtfs_trips t ON st.trip_id = t.trip_id
            JOIN gtfs_routes r ON t.route_id = r.route_id
            WHERE st.stop_id = $1 AND r.route_short_name = $2
            "#,
        )
        .bind(&gtfs_id)
        .bind(expected_line)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);

        let line_ok = has_line.map(|(c,)| c > 0).unwrap_or(false);

        // Check: do trips at this stop end at a destination matching the keyword?
        let has_direction: Option<(i64,)> = sqlx::query_as(
            r#"
            WITH last_stops AS (
                SELECT DISTINCT
                    (SELECT gs.stop_name FROM gtfs_stop_times lst
                     JOIN gtfs_stops gs ON lst.stop_id = gs.stop_id
                     WHERE lst.trip_id = t.trip_id
                     ORDER BY lst.stop_sequence DESC LIMIT 1) as last_stop
                FROM gtfs_stop_times st
                JOIN gtfs_trips t ON st.trip_id = t.trip_id
                JOIN gtfs_routes r ON t.route_id = r.route_id
                WHERE st.stop_id = $1 AND r.route_short_name = $2
                LIMIT 100
            )
            SELECT COUNT(*) FROM last_stops WHERE LOWER(last_stop) LIKE '%' || $3 || '%'
            "#,
        )
        .bind(&gtfs_id)
        .bind(expected_line)
        .bind(expected_direction)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);

        let dir_ok = has_direction.map(|(c,)| c > 0).unwrap_or(false);

        checked += 1;
        if !line_ok || !dir_ok {
            tracing::warn!(
                ifopt,
                gtfs_stop_id = %gtfs_id,
                expected_line,
                expected_direction,
                line_ok,
                dir_ok,
                "Mapping validation FAILED: wrong GTFS stop assigned"
            );
            failures += 1;
        }
    }

    if failures == 0 {
        tracing::info!(checked, "Mapping validation passed: all expected assignments correct");
    } else {
        tracing::error!(
            failures,
            checked,
            "Mapping validation FAILED: some expected assignments are wrong"
        );
    }
}

/// Build a partial GtfsSchedule from PostgreSQL containing only data relevant
/// to the given IFOPT stop IDs. Used by the realtime processing cycle to avoid
/// holding the full schedule (~1GB) in memory.
///
/// Executes 7 batch queries to load:
/// 1. IFOPT <-> GTFS mapping for the given stops
/// 2. Trip IDs visiting those stops
/// 3. Trip details, stop_times, routes, calendars, stop names
pub async fn build_schedule_from_db(
    pool: &PgPool,
    relevant_ifopt_ids: &HashSet<String>,
) -> Result<GtfsSchedule, GtfsError> {
    let ifopt_list: Vec<&str> = relevant_ifopt_ids.iter().map(|s| s.as_str()).collect();

    // 1. Get IFOPT -> GTFS mapping for our monitored stops
    // Order by is_manual DESC so manual mappings take priority in reverse map
    let mapping_rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT ifopt, gtfs_stop_id FROM ifopt_gtfs_mapping \
         WHERE ifopt = ANY($1::text[]) \
         ORDER BY is_manual DESC, combined_score DESC",
    )
    .bind(&ifopt_list)
    .fetch_all(pool)
    .await?;

    let mut ifopt_to_gtfs: HashMap<String, Vec<String>> = HashMap::new();
    let mut gtfs_to_ifopt: HashMap<String, Vec<String>> = HashMap::new();
    for (ifopt, gtfs_id) in &mapping_rows {
        ifopt_to_gtfs
            .entry(ifopt.clone())
            .or_default()
            .push(gtfs_id.clone());
        gtfs_to_ifopt
            .entry(gtfs_id.clone())
            .or_default()
            .push(ifopt.clone());
    }

    let gtfs_stop_ids: Vec<&str> = gtfs_to_ifopt.keys().map(|s| s.as_str()).collect();
    if gtfs_stop_ids.is_empty() {
        debug!("No GTFS mapping found for relevant stops, returning empty schedule");
        return Ok(GtfsSchedule::empty_with_mappings(ifopt_to_gtfs, gtfs_to_ifopt));
    }

    // 2. Get trip IDs that visit our monitored GTFS stops
    let trip_ids: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT trip_id FROM gtfs_stop_times WHERE stop_id = ANY($1::text[])",
    )
    .bind(&gtfs_stop_ids)
    .fetch_all(pool)
    .await?;

    info!(
        gtfs_stops = gtfs_stop_ids.len(),
        relevant_trips = trip_ids.len(),
        "Found trips visiting monitored stops"
    );

    if trip_ids.is_empty() {
        return Ok(GtfsSchedule::empty_with_mappings(ifopt_to_gtfs, gtfs_to_ifopt));
    }

    // 3. Load trip details
    let trip_rows: Vec<(String, String, String, Option<String>, Option<i32>)> = sqlx::query_as(
        "SELECT trip_id, route_id, service_id, trip_headsign, direction_id \
         FROM gtfs_trips WHERE trip_id = ANY($1::text[])",
    )
    .bind(&trip_ids)
    .fetch_all(pool)
    .await?;

    let mut trips = HashMap::with_capacity(trip_rows.len());
    let mut route_ids: HashSet<String> = HashSet::new();
    let mut service_ids: HashSet<String> = HashSet::new();
    for (trip_id, route_id, service_id, headsign, direction_id) in trip_rows {
        route_ids.insert(route_id.clone());
        service_ids.insert(service_id.clone());
        trips.insert(
            trip_id.clone(),
            GtfsTrip {
                trip_id,
                route_id,
                service_id,
                trip_headsign: headsign,
                direction_id,
            },
        );
    }

    // 4. Load stop_times for those trips (ordered for correct sequencing)
    let st_rows: Vec<(String, i32, String, Option<i32>, Option<i32>)> = sqlx::query_as(
        "SELECT trip_id, stop_sequence, stop_id, arrival_time, departure_time \
         FROM gtfs_stop_times WHERE trip_id = ANY($1::text[]) \
         ORDER BY trip_id, stop_sequence",
    )
    .bind(&trip_ids)
    .fetch_all(pool)
    .await?;

    let mut stop_times: HashMap<String, Vec<GtfsStopTime>> = HashMap::new();
    let mut all_stop_ids: HashSet<String> = HashSet::new();
    for (trip_id, seq, stop_id, arr, dep) in st_rows {
        all_stop_ids.insert(stop_id.clone());
        stop_times
            .entry(trip_id)
            .or_default()
            .push(GtfsStopTime {
                stop_sequence: seq,
                stop_id,
                arrival_time: arr,
                departure_time: dep,
            });
    }

    // Build trips_by_stop reverse index
    let mut trips_by_stop: HashMap<String, HashSet<String>> = HashMap::new();
    for (trip_id, sts) in &stop_times {
        for st in sts {
            trips_by_stop
                .entry(st.stop_id.clone())
                .or_default()
                .insert(trip_id.clone());
        }
    }

    // 5. Load routes
    let route_id_list: Vec<String> = route_ids.into_iter().collect();
    let route_rows: Vec<(String, Option<String>, Option<String>, Option<i32>)> = sqlx::query_as(
        "SELECT route_id, route_short_name, route_long_name, route_type \
         FROM gtfs_routes WHERE route_id = ANY($1::text[])",
    )
    .bind(&route_id_list)
    .fetch_all(pool)
    .await?;

    let mut routes = HashMap::with_capacity(route_rows.len());
    for (route_id, short, long, rtype) in route_rows {
        routes.insert(
            route_id.clone(),
            GtfsRoute {
                route_id,
                route_short_name: short,
                route_long_name: long,
                route_type: rtype,
            },
        );
    }

    // 6. Load calendars and calendar_dates for relevant services
    let service_id_list: Vec<String> = service_ids.into_iter().collect();

    let cal_rows: Vec<(
        String,
        bool,
        bool,
        bool,
        bool,
        bool,
        bool,
        bool,
        NaiveDate,
        NaiveDate,
    )> = sqlx::query_as(
        "SELECT service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, \
         start_date, end_date FROM gtfs_calendar WHERE service_id = ANY($1::text[])",
    )
    .bind(&service_id_list)
    .fetch_all(pool)
    .await?;

    let mut calendars = HashMap::with_capacity(cal_rows.len());
    for (sid, mon, tue, wed, thu, fri, sat, sun, start, end_d) in cal_rows {
        calendars.insert(
            sid.clone(),
            GtfsCalendar {
                service_id: sid,
                days: [mon, tue, wed, thu, fri, sat, sun],
                start_date: start,
                end_date: end_d,
            },
        );
    }

    let cd_rows: Vec<(String, NaiveDate, i32)> = sqlx::query_as(
        "SELECT service_id, date, exception_type \
         FROM gtfs_calendar_dates WHERE service_id = ANY($1::text[])",
    )
    .bind(&service_id_list)
    .fetch_all(pool)
    .await?;

    let mut calendar_dates: HashMap<String, Vec<GtfsCalendarDate>> = HashMap::new();
    for (sid, date, exc_type) in cd_rows {
        calendar_dates
            .entry(sid)
            .or_default()
            .push(GtfsCalendarDate {
                date,
                exception_type: exc_type,
            });
    }

    // 7. Load stop names (for headsign fallback — last stop name)
    let stop_id_list: Vec<String> = all_stop_ids.into_iter().collect();
    let stop_rows: Vec<(String, Option<String>, Option<String>, Option<f64>, Option<f64>)> =
        sqlx::query_as(
            "SELECT stop_id, stop_name, parent_station, lat, lon \
             FROM gtfs_stops WHERE stop_id = ANY($1::text[])",
        )
        .bind(&stop_id_list)
        .fetch_all(pool)
        .await?;

    let mut stops = HashMap::with_capacity(stop_rows.len());
    for (stop_id, name, parent, lat, lon) in stop_rows {
        stops.insert(
            stop_id.clone(),
            GtfsStop {
                stop_id,
                stop_name: name,
                parent_station: parent,
                lat,
                lon,
            },
        );
    }

    info!(
        trips = trips.len(),
        stop_times_trips = stop_times.len(),
        routes = routes.len(),
        stops = stops.len(),
        mapping = ifopt_to_gtfs.len(),
        "Built realtime cache from PostgreSQL"
    );

    Ok(GtfsSchedule {
        stops,
        routes,
        trips,
        stop_times,
        calendars,
        calendar_dates,
        trips_by_stop,
        ifopt_to_gtfs,
        gtfs_to_ifopt,
        loaded_at: chrono::Utc::now(),
    })
}

/// Build a GTFS schedule from the database using GTFS stop IDs directly,
/// bypassing the IFOPT mapping. Used for querying departures at GTFS stops
/// that may not have an IFOPT mapping.
pub async fn build_schedule_from_db_by_gtfs_stop(
    pool: &PgPool,
    gtfs_stop_ids: &HashSet<String>,
) -> Result<GtfsSchedule, GtfsError> {
    let gtfs_id_list: Vec<&str> = gtfs_stop_ids.iter().map(|s| s.as_str()).collect();

    if gtfs_id_list.is_empty() {
        return Ok(GtfsSchedule::empty_with_mappings(HashMap::new(), HashMap::new()));
    }

    // 1. Get trip IDs that visit our GTFS stops
    let trip_ids: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT trip_id FROM gtfs_stop_times WHERE stop_id = ANY($1::text[])",
    )
    .bind(&gtfs_id_list)
    .fetch_all(pool)
    .await?;

    if trip_ids.is_empty() {
        return Ok(GtfsSchedule::empty_with_mappings(HashMap::new(), HashMap::new()));
    }

    // 2. Load trip details
    let trip_rows: Vec<(String, String, String, Option<String>, Option<i32>)> = sqlx::query_as(
        "SELECT trip_id, route_id, service_id, trip_headsign, direction_id \
         FROM gtfs_trips WHERE trip_id = ANY($1::text[])",
    )
    .bind(&trip_ids)
    .fetch_all(pool)
    .await?;

    let mut trips = HashMap::with_capacity(trip_rows.len());
    let mut route_ids: HashSet<String> = HashSet::new();
    let mut service_ids: HashSet<String> = HashSet::new();
    for (trip_id, route_id, service_id, headsign, direction_id) in trip_rows {
        route_ids.insert(route_id.clone());
        service_ids.insert(service_id.clone());
        trips.insert(
            trip_id.clone(),
            GtfsTrip {
                trip_id,
                route_id,
                service_id,
                trip_headsign: headsign,
                direction_id,
            },
        );
    }

    // 3. Load stop_times
    let st_rows: Vec<(String, i32, String, Option<i32>, Option<i32>)> = sqlx::query_as(
        "SELECT trip_id, stop_sequence, stop_id, arrival_time, departure_time \
         FROM gtfs_stop_times WHERE trip_id = ANY($1::text[]) \
         ORDER BY trip_id, stop_sequence",
    )
    .bind(&trip_ids)
    .fetch_all(pool)
    .await?;

    let mut stop_times: HashMap<String, Vec<GtfsStopTime>> = HashMap::new();
    let mut all_stop_ids: HashSet<String> = HashSet::new();
    for (trip_id, seq, stop_id, arr, dep) in st_rows {
        all_stop_ids.insert(stop_id.clone());
        stop_times
            .entry(trip_id)
            .or_default()
            .push(GtfsStopTime {
                stop_sequence: seq,
                stop_id,
                arrival_time: arr,
                departure_time: dep,
            });
    }

    let mut trips_by_stop: HashMap<String, HashSet<String>> = HashMap::new();
    for (trip_id, sts) in &stop_times {
        for st in sts {
            trips_by_stop
                .entry(st.stop_id.clone())
                .or_default()
                .insert(trip_id.clone());
        }
    }

    // 4. Load routes
    let route_id_list: Vec<String> = route_ids.into_iter().collect();
    let route_rows: Vec<(String, Option<String>, Option<String>, Option<i32>)> = sqlx::query_as(
        "SELECT route_id, route_short_name, route_long_name, route_type \
         FROM gtfs_routes WHERE route_id = ANY($1::text[])",
    )
    .bind(&route_id_list)
    .fetch_all(pool)
    .await?;

    let mut routes = HashMap::with_capacity(route_rows.len());
    for (route_id, short, long, rtype) in route_rows {
        routes.insert(
            route_id.clone(),
            GtfsRoute {
                route_id,
                route_short_name: short,
                route_long_name: long,
                route_type: rtype,
            },
        );
    }

    // 5. Load calendars
    let service_id_list: Vec<String> = service_ids.into_iter().collect();
    let cal_rows: Vec<(
        String, bool, bool, bool, bool, bool, bool, bool, NaiveDate, NaiveDate,
    )> = sqlx::query_as(
        "SELECT service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, \
         start_date, end_date FROM gtfs_calendar WHERE service_id = ANY($1::text[])",
    )
    .bind(&service_id_list)
    .fetch_all(pool)
    .await?;

    let mut calendars = HashMap::with_capacity(cal_rows.len());
    for (sid, mon, tue, wed, thu, fri, sat, sun, start, end_d) in cal_rows {
        calendars.insert(
            sid.clone(),
            GtfsCalendar {
                service_id: sid,
                days: [mon, tue, wed, thu, fri, sat, sun],
                start_date: start,
                end_date: end_d,
            },
        );
    }

    let cd_rows: Vec<(String, NaiveDate, i32)> = sqlx::query_as(
        "SELECT service_id, date, exception_type \
         FROM gtfs_calendar_dates WHERE service_id = ANY($1::text[])",
    )
    .bind(&service_id_list)
    .fetch_all(pool)
    .await?;

    let mut calendar_dates: HashMap<String, Vec<GtfsCalendarDate>> = HashMap::new();
    for (sid, date, exc_type) in cd_rows {
        calendar_dates
            .entry(sid)
            .or_default()
            .push(GtfsCalendarDate {
                date,
                exception_type: exc_type,
            });
    }

    // 6. Load stop names
    let stop_id_list: Vec<String> = all_stop_ids.into_iter().collect();
    let stop_rows: Vec<(String, Option<String>, Option<String>, Option<f64>, Option<f64>)> =
        sqlx::query_as(
            "SELECT stop_id, stop_name, parent_station, lat, lon \
             FROM gtfs_stops WHERE stop_id = ANY($1::text[])",
        )
        .bind(&stop_id_list)
        .fetch_all(pool)
        .await?;

    let mut stops = HashMap::with_capacity(stop_rows.len());
    for (stop_id, name, parent, lat, lon) in stop_rows {
        stops.insert(
            stop_id.clone(),
            GtfsStop {
                stop_id,
                stop_name: name,
                parent_station: parent,
                lat,
                lon,
            },
        );
    }

    Ok(GtfsSchedule {
        stops,
        routes,
        trips,
        stop_times,
        calendars,
        calendar_dates,
        trips_by_stop,
        ifopt_to_gtfs: HashMap::new(),
        gtfs_to_ifopt: HashMap::new(),
        loaded_at: chrono::Utc::now(),
    })
}

// --- Helper functions ---

/// Extract station-level IFOPT (first 3 colon-separated parts).
/// e.g., "de:09761:691:0:a" -> "de:09761:691"
pub fn station_level_ifopt(ifopt: &str) -> String {
    let parts: Vec<&str> = ifopt.split(':').collect();
    if parts.len() >= 3 {
        format!("{}:{}:{}", parts[0], parts[1], parts[2])
    } else {
        ifopt.to_string()
    }
}

/// Extract platform identifier from IFOPT (5th part).
/// e.g., "de:09761:691:0:a" -> Some("a")
pub fn extract_platform_from_ifopt(ifopt: &str) -> Option<String> {
    let parts: Vec<&str> = ifopt.split(':').collect();
    if parts.len() >= 5 {
        Some(parts[4].to_string())
    } else {
        None
    }
}

/// Parse GTFS time string "HH:MM:SS" to seconds since midnight.
/// Supports hours >= 24 for trips crossing midnight.
pub fn parse_gtfs_time(time_str: &str) -> Option<i32> {
    let parts: Vec<&str> = time_str.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let hours: i32 = parts[0].parse().ok()?;
    let minutes: i32 = parts[1].parse().ok()?;
    let seconds: i32 = parts[2].parse().ok()?;
    Some(hours * 3600 + minutes * 60 + seconds)
}

/// Parse GTFS date string "YYYYMMDD" to NaiveDate.
fn parse_gtfs_date(s: &str) -> Option<NaiveDate> {
    if s.len() != 8 {
        return None;
    }
    let year: i32 = s[0..4].parse().ok()?;
    let month: u32 = s[4..6].parse().ok()?;
    let day: u32 = s[6..8].parse().ok()?;
    NaiveDate::from_ymd_opt(year, month, day)
}

fn non_empty(s: &str) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

// --- CSV parsing ---

fn parse_stops(
    archive: &mut zip::ZipArchive<std::fs::File>,
) -> Result<HashMap<String, GtfsStop>, GtfsError> {
    info!("Parsing stops.txt");
    let file = archive.by_name("stops.txt")?;
    let mut rdr = csv::Reader::from_reader(file);
    let headers = rdr.headers()?.clone();

    let idx_id = headers
        .iter()
        .position(|h| h == "stop_id")
        .ok_or_else(|| GtfsError::ParseError("stops.txt missing stop_id".into()))?;
    let idx_name = headers.iter().position(|h| h == "stop_name");
    let idx_parent = headers.iter().position(|h| h == "parent_station");
    let idx_lat = headers.iter().position(|h| h == "stop_lat");
    let idx_lon = headers.iter().position(|h| h == "stop_lon");

    let mut stops = HashMap::new();
    let mut skipped = 0usize;
    for result in rdr.records() {
        let record = result?;
        let stop_id = record.get(idx_id).unwrap_or("").to_string();
        if stop_id.is_empty() {
            skipped += 1;
            continue;
        }
        stops.insert(
            stop_id.clone(),
            GtfsStop {
                stop_id,
                stop_name: idx_name.and_then(|i| record.get(i)).and_then(non_empty),
                parent_station: idx_parent
                    .and_then(|i| record.get(i))
                    .and_then(non_empty),
                lat: idx_lat
                    .and_then(|i| record.get(i))
                    .and_then(|s| s.parse().ok()),
                lon: idx_lon
                    .and_then(|i| record.get(i))
                    .and_then(|s| s.parse().ok()),
            },
        );
    }
    if skipped > 0 {
        warn!(skipped, "Skipped stops.txt records with empty stop_id");
    }
    Ok(stops)
}

fn parse_routes(
    archive: &mut zip::ZipArchive<std::fs::File>,
) -> Result<HashMap<String, GtfsRoute>, GtfsError> {
    info!("Parsing routes.txt");
    let file = archive.by_name("routes.txt")?;
    let mut rdr = csv::Reader::from_reader(file);
    let headers = rdr.headers()?.clone();

    let idx_id = headers
        .iter()
        .position(|h| h == "route_id")
        .ok_or_else(|| GtfsError::ParseError("routes.txt missing route_id".into()))?;
    let idx_short = headers.iter().position(|h| h == "route_short_name");
    let idx_long = headers.iter().position(|h| h == "route_long_name");
    let idx_type = headers.iter().position(|h| h == "route_type");

    let mut routes = HashMap::new();
    let mut skipped = 0usize;
    for result in rdr.records() {
        let record = result?;
        let route_id = record.get(idx_id).unwrap_or("").to_string();
        if route_id.is_empty() {
            skipped += 1;
            continue;
        }
        routes.insert(
            route_id.clone(),
            GtfsRoute {
                route_id,
                route_short_name: idx_short
                    .and_then(|i| record.get(i))
                    .and_then(non_empty),
                route_long_name: idx_long
                    .and_then(|i| record.get(i))
                    .and_then(non_empty),
                route_type: idx_type
                    .and_then(|i| record.get(i))
                    .and_then(|s| s.parse().ok()),
            },
        );
    }
    if skipped > 0 {
        warn!(skipped, "Skipped routes.txt records with empty route_id");
    }
    Ok(routes)
}

fn parse_trips(
    archive: &mut zip::ZipArchive<std::fs::File>,
) -> Result<HashMap<String, GtfsTrip>, GtfsError> {
    info!("Parsing trips.txt");
    let file = archive.by_name("trips.txt")?;
    let mut rdr = csv::Reader::from_reader(file);
    let headers = rdr.headers()?.clone();

    let idx_trip = headers
        .iter()
        .position(|h| h == "trip_id")
        .ok_or_else(|| GtfsError::ParseError("trips.txt missing trip_id".into()))?;
    let idx_route = headers
        .iter()
        .position(|h| h == "route_id")
        .ok_or_else(|| GtfsError::ParseError("trips.txt missing route_id".into()))?;
    let idx_service = headers
        .iter()
        .position(|h| h == "service_id")
        .ok_or_else(|| GtfsError::ParseError("trips.txt missing service_id".into()))?;
    let idx_headsign = headers.iter().position(|h| h == "trip_headsign");
    let idx_dir = headers.iter().position(|h| h == "direction_id");

    let mut trips = HashMap::new();
    let mut skipped = 0usize;
    for result in rdr.records() {
        let record = result?;
        let trip_id = record.get(idx_trip).unwrap_or("").to_string();
        if trip_id.is_empty() {
            skipped += 1;
            continue;
        }
        trips.insert(
            trip_id.clone(),
            GtfsTrip {
                trip_id,
                route_id: record.get(idx_route).unwrap_or("").to_string(),
                service_id: record.get(idx_service).unwrap_or("").to_string(),
                trip_headsign: idx_headsign
                    .and_then(|i| record.get(i))
                    .and_then(non_empty),
                direction_id: idx_dir
                    .and_then(|i| record.get(i))
                    .and_then(|s| s.parse().ok()),
            },
        );
    }
    if skipped > 0 {
        warn!(skipped, "Skipped trips.txt records with empty trip_id");
    }
    Ok(trips)
}

#[cfg(test)]
fn parse_stop_times(
    archive: &mut zip::ZipArchive<std::fs::File>,
) -> Result<HashMap<String, Vec<GtfsStopTime>>, GtfsError> {
    info!("Parsing stop_times.txt");
    let file = archive.by_name("stop_times.txt")?;
    let mut rdr = csv::Reader::from_reader(file);
    let headers = rdr.headers()?.clone();

    let idx_trip = headers
        .iter()
        .position(|h| h == "trip_id")
        .ok_or_else(|| GtfsError::ParseError("stop_times.txt missing trip_id".into()))?;
    let idx_seq = headers
        .iter()
        .position(|h| h == "stop_sequence")
        .ok_or_else(|| GtfsError::ParseError("stop_times.txt missing stop_sequence".into()))?;
    let idx_stop = headers
        .iter()
        .position(|h| h == "stop_id")
        .ok_or_else(|| GtfsError::ParseError("stop_times.txt missing stop_id".into()))?;
    let idx_arr = headers.iter().position(|h| h == "arrival_time");
    let idx_dep = headers.iter().position(|h| h == "departure_time");

    let mut stop_times: HashMap<String, Vec<GtfsStopTime>> = HashMap::new();
    let mut skipped = 0usize;
    for result in rdr.records() {
        let record = result?;
        let trip_id = record.get(idx_trip).unwrap_or("").to_string();
        if trip_id.is_empty() {
            skipped += 1;
            continue;
        }
        let st = GtfsStopTime {
            stop_sequence: record
                .get(idx_seq)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0),
            stop_id: record.get(idx_stop).unwrap_or("").to_string(),
            arrival_time: idx_arr
                .and_then(|i| record.get(i))
                .and_then(parse_gtfs_time),
            departure_time: idx_dep
                .and_then(|i| record.get(i))
                .and_then(parse_gtfs_time),
        };
        stop_times.entry(trip_id).or_default().push(st);
    }
    if skipped > 0 {
        warn!(skipped, "Skipped stop_times.txt records with empty trip_id");
    }

    // Sort each trip's stop_times by stop_sequence
    for sts in stop_times.values_mut() {
        sts.sort_by_key(|st| st.stop_sequence);
    }

    Ok(stop_times)
}

fn parse_calendar(
    archive: &mut zip::ZipArchive<std::fs::File>,
) -> HashMap<String, GtfsCalendar> {
    info!("Parsing calendar.txt");
    let file = match archive.by_name("calendar.txt") {
        Ok(f) => f,
        Err(_) => {
            info!("No calendar.txt in GTFS zip (optional file)");
            return HashMap::new();
        }
    };
    let mut rdr = csv::Reader::from_reader(file);
    let headers = match rdr.headers() {
        Ok(h) => h.clone(),
        Err(_) => return HashMap::new(),
    };

    let idx_service = headers.iter().position(|h| h == "service_id");
    let idx_mon = headers.iter().position(|h| h == "monday");
    let idx_tue = headers.iter().position(|h| h == "tuesday");
    let idx_wed = headers.iter().position(|h| h == "wednesday");
    let idx_thu = headers.iter().position(|h| h == "thursday");
    let idx_fri = headers.iter().position(|h| h == "friday");
    let idx_sat = headers.iter().position(|h| h == "saturday");
    let idx_sun = headers.iter().position(|h| h == "sunday");
    let idx_start = headers.iter().position(|h| h == "start_date");
    let idx_end = headers.iter().position(|h| h == "end_date");

    let Some(idx_service) = idx_service else {
        return HashMap::new();
    };

    let mut calendars = HashMap::new();
    let mut skipped = 0usize;
    for result in rdr.records() {
        let Ok(record) = result else {
            skipped += 1;
            continue;
        };
        let service_id = record.get(idx_service).unwrap_or("").to_string();
        if service_id.is_empty() {
            skipped += 1;
            continue;
        }

        let get_bool = |idx: Option<usize>| -> bool {
            idx.and_then(|i| record.get(i))
                .and_then(|s| s.parse::<i32>().ok())
                .map(|v| v == 1)
                .unwrap_or(false)
        };

        let start_date = idx_start
            .and_then(|i| record.get(i))
            .and_then(parse_gtfs_date);
        let end_date = idx_end
            .and_then(|i| record.get(i))
            .and_then(parse_gtfs_date);

        let (Some(start_date), Some(end_date)) = (start_date, end_date) else {
            skipped += 1;
            continue;
        };

        calendars.insert(
            service_id.clone(),
            GtfsCalendar {
                service_id,
                days: [
                    get_bool(idx_mon),
                    get_bool(idx_tue),
                    get_bool(idx_wed),
                    get_bool(idx_thu),
                    get_bool(idx_fri),
                    get_bool(idx_sat),
                    get_bool(idx_sun),
                ],
                start_date,
                end_date,
            },
        );
    }
    if skipped > 0 {
        warn!(skipped, "Skipped calendar.txt records (empty/unparseable)");
    }
    calendars
}

fn parse_calendar_dates(
    archive: &mut zip::ZipArchive<std::fs::File>,
) -> HashMap<String, Vec<GtfsCalendarDate>> {
    info!("Parsing calendar_dates.txt");
    let file = match archive.by_name("calendar_dates.txt") {
        Ok(f) => f,
        Err(_) => {
            info!("No calendar_dates.txt in GTFS zip (optional file)");
            return HashMap::new();
        }
    };
    let mut rdr = csv::Reader::from_reader(file);
    let headers = match rdr.headers() {
        Ok(h) => h.clone(),
        Err(_) => return HashMap::new(),
    };

    let idx_service = headers.iter().position(|h| h == "service_id");
    let idx_date = headers.iter().position(|h| h == "date");
    let idx_type = headers.iter().position(|h| h == "exception_type");

    let (Some(idx_service), Some(idx_date), Some(idx_type)) = (idx_service, idx_date, idx_type)
    else {
        return HashMap::new();
    };

    let mut dates: HashMap<String, Vec<GtfsCalendarDate>> = HashMap::new();
    let mut skipped = 0usize;
    for result in rdr.records() {
        let Ok(record) = result else {
            skipped += 1;
            continue;
        };
        let service_id = record.get(idx_service).unwrap_or("").to_string();
        if service_id.is_empty() {
            skipped += 1;
            continue;
        }
        let Some(date) = record.get(idx_date).and_then(parse_gtfs_date) else {
            skipped += 1;
            continue;
        };
        let exception_type = record
            .get(idx_type)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);

        dates.entry(service_id).or_default().push(GtfsCalendarDate {
            date,
            exception_type,
        });
    }
    if skipped > 0 {
        warn!(skipped, "Skipped calendar_dates.txt records (empty/unparseable)");
    }
    dates
}

/// Normalize a stop name for comparison.
/// Handles common German abbreviations and formatting differences.
#[cfg(test)]
fn normalize_stop_name(name: &str) -> String {
    let normalized = name
        .to_lowercase()
        // Common German abbreviations
        .replace("hbf", "hauptbahnhof")
        .replace("bf", "bahnhof")
        .replace("str.", "straße")
        .replace("str ", "straße ")
        .replace("pl.", "platz")
        .replace("pl ", "platz ")
        // Remove common suffixes/prefixes
        .replace(" (u)", "")
        .replace(" (s)", "")
        .replace(" (bus)", "")
        .replace(" (tram)", "")
        // Normalize whitespace
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_gtfs_time() {
        assert_eq!(parse_gtfs_time("08:30:00"), Some(30600));
        assert_eq!(parse_gtfs_time("00:00:00"), Some(0));
        assert_eq!(parse_gtfs_time("24:00:00"), Some(86400));
        assert_eq!(parse_gtfs_time("25:30:00"), Some(91800));
        assert_eq!(parse_gtfs_time("invalid"), None);
        assert_eq!(parse_gtfs_time(""), None);
    }

    #[test]
    fn test_parse_gtfs_date() {
        assert_eq!(
            parse_gtfs_date("20260201"),
            Some(NaiveDate::from_ymd_opt(2026, 2, 1).unwrap())
        );
        assert_eq!(parse_gtfs_date("invalid"), None);
        assert_eq!(parse_gtfs_date(""), None);
    }

    #[test]
    fn test_station_level_ifopt() {
        assert_eq!(station_level_ifopt("de:09761:691:0:a"), "de:09761:691");
        assert_eq!(station_level_ifopt("de:09761:691"), "de:09761:691");
        assert_eq!(station_level_ifopt("de:09761:691:0"), "de:09761:691");
        assert_eq!(station_level_ifopt("short"), "short");
    }

    #[test]
    fn test_extract_platform_from_ifopt() {
        assert_eq!(
            extract_platform_from_ifopt("de:09761:691:0:a"),
            Some("a".to_string())
        );
        assert_eq!(extract_platform_from_ifopt("de:09761:691:0"), None);
        assert_eq!(extract_platform_from_ifopt("de:09761:691"), None);
    }

    #[test]
    fn test_is_service_active() {
        let mut schedule = GtfsSchedule {
            stops: HashMap::new(),
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            trips_by_stop: HashMap::new(),
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        };

        // Monday 2026-02-02
        let monday = NaiveDate::from_ymd_opt(2026, 2, 2).unwrap();
        // Saturday 2026-02-07
        let saturday = NaiveDate::from_ymd_opt(2026, 2, 7).unwrap();

        // Service runs Mon-Fri
        schedule.calendars.insert(
            "weekday".into(),
            GtfsCalendar {
                service_id: "weekday".into(),
                days: [true, true, true, true, true, false, false],
                start_date: NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
                end_date: NaiveDate::from_ymd_opt(2026, 12, 31).unwrap(),
            },
        );

        assert!(schedule.is_service_active("weekday", monday));
        assert!(!schedule.is_service_active("weekday", saturday));

        // Exception: add service on a Saturday
        schedule
            .calendar_dates
            .insert("weekday".into(), vec![GtfsCalendarDate {
                date: saturday,
                exception_type: 1,
            }]);
        assert!(schedule.is_service_active("weekday", saturday));

        // Unknown service
        assert!(!schedule.is_service_active("unknown", monday));
    }

    #[test]
    fn test_is_service_active_exception_type_2_removes_service() {
        let mut schedule = GtfsSchedule {
            stops: HashMap::new(),
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            trips_by_stop: HashMap::new(),
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        };

        let monday = NaiveDate::from_ymd_opt(2026, 2, 2).unwrap();

        // Regular weekday service
        schedule.calendars.insert(
            "weekday".into(),
            GtfsCalendar {
                service_id: "weekday".into(),
                days: [true, true, true, true, true, false, false],
                start_date: NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
                end_date: NaiveDate::from_ymd_opt(2026, 12, 31).unwrap(),
            },
        );

        assert!(schedule.is_service_active("weekday", monday));

        // Exception type 2: remove service on this Monday (e.g., holiday)
        schedule.calendar_dates.insert(
            "weekday".into(),
            vec![GtfsCalendarDate {
                date: monday,
                exception_type: 2,
            }],
        );

        assert!(!schedule.is_service_active("weekday", monday));
    }

    #[test]
    fn test_is_service_active_before_start_date() {
        let mut schedule = GtfsSchedule {
            stops: HashMap::new(),
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            trips_by_stop: HashMap::new(),
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        };

        // Service starts in the future
        schedule.calendars.insert(
            "future".into(),
            GtfsCalendar {
                service_id: "future".into(),
                days: [true; 7],
                start_date: NaiveDate::from_ymd_opt(2027, 1, 1).unwrap(),
                end_date: NaiveDate::from_ymd_opt(2027, 12, 31).unwrap(),
            },
        );

        let today = NaiveDate::from_ymd_opt(2026, 6, 15).unwrap();
        assert!(!schedule.is_service_active("future", today));
    }

    #[test]
    fn test_is_service_active_after_end_date() {
        let mut schedule = GtfsSchedule {
            stops: HashMap::new(),
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            trips_by_stop: HashMap::new(),
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        };

        // Service ended in the past
        schedule.calendars.insert(
            "past".into(),
            GtfsCalendar {
                service_id: "past".into(),
                days: [true; 7],
                start_date: NaiveDate::from_ymd_opt(2025, 1, 1).unwrap(),
                end_date: NaiveDate::from_ymd_opt(2025, 12, 31).unwrap(),
            },
        );

        let today = NaiveDate::from_ymd_opt(2026, 6, 15).unwrap();
        assert!(!schedule.is_service_active("past", today));
    }

    #[test]
    fn test_is_service_active_calendar_dates_only() {
        let mut schedule = GtfsSchedule {
            stops: HashMap::new(),
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            trips_by_stop: HashMap::new(),
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        };

        // Some GTFS feeds use only calendar_dates without calendar.txt
        let special_day = NaiveDate::from_ymd_opt(2026, 12, 25).unwrap();
        let normal_day = NaiveDate::from_ymd_opt(2026, 12, 26).unwrap();

        schedule.calendar_dates.insert(
            "holiday_only".into(),
            vec![GtfsCalendarDate {
                date: special_day,
                exception_type: 1,
            }],
        );

        assert!(schedule.is_service_active("holiday_only", special_day));
        assert!(!schedule.is_service_active("holiday_only", normal_day));
    }

    #[test]
    fn test_parse_gtfs_time_edge_cases() {
        assert_eq!(parse_gtfs_time("23:59:59"), Some(86399));
        assert_eq!(parse_gtfs_time("48:00:00"), Some(172800));
        assert_eq!(parse_gtfs_time("00:00:01"), Some(1));
        // Invalid formats
        assert_eq!(parse_gtfs_time("8:30:00"), Some(30600)); // single digit hours still parse
        assert_eq!(parse_gtfs_time("08:30"), None); // missing seconds
        assert_eq!(parse_gtfs_time("08:30:00:00"), None); // too many parts
    }

    #[test]
    fn test_parse_gtfs_date_edge_cases() {
        assert_eq!(parse_gtfs_date("20260229"), None); // 2026 is not leap year
        assert_eq!(parse_gtfs_date("20240229"), Some(NaiveDate::from_ymd_opt(2024, 2, 29).unwrap())); // 2024 is leap year
        assert_eq!(parse_gtfs_date("20260101"), Some(NaiveDate::from_ymd_opt(2026, 1, 1).unwrap()));
        assert_eq!(parse_gtfs_date("20261231"), Some(NaiveDate::from_ymd_opt(2026, 12, 31).unwrap()));
        assert_eq!(parse_gtfs_date("00000101"), Some(NaiveDate::from_ymd_opt(0, 1, 1).unwrap()));
    }

    #[test]
    fn test_station_level_ifopt_empty() {
        assert_eq!(station_level_ifopt(""), "");
        assert_eq!(station_level_ifopt("a"), "a");
        assert_eq!(station_level_ifopt("a:b"), "a:b");
    }

    #[test]
    fn test_extract_platform_from_ifopt_various() {
        assert_eq!(extract_platform_from_ifopt(""), None);
        assert_eq!(extract_platform_from_ifopt("a:b:c:d:e"), Some("e".to_string()));
        assert_eq!(
            extract_platform_from_ifopt("de:09761:691:0:Gleis 1"),
            Some("Gleis 1".to_string())
        );
        // Exactly 5 parts
        assert_eq!(
            extract_platform_from_ifopt("a:b:c:d:e"),
            Some("e".to_string())
        );
        // More than 5 parts - still returns 5th
        assert_eq!(
            extract_platform_from_ifopt("a:b:c:d:e:f"),
            Some("e".to_string())
        );
    }

    #[test]
    fn test_non_empty() {
        assert_eq!(non_empty("hello"), Some("hello".to_string()));
        assert_eq!(non_empty(""), None);
        assert_eq!(non_empty(" "), Some(" ".to_string())); // whitespace is not empty
    }

    #[test]
    fn test_last_stop_of_trip() {
        let mut schedule = GtfsSchedule {
            stops: HashMap::new(),
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            trips_by_stop: HashMap::new(),
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        };

        schedule.stop_times.insert(
            "trip1".to_string(),
            vec![
                GtfsStopTime {
                    stop_sequence: 1,
                    stop_id: "stop_A".to_string(),
                    arrival_time: Some(28800),
                    departure_time: Some(28800),
                },
                GtfsStopTime {
                    stop_sequence: 2,
                    stop_id: "stop_B".to_string(),
                    arrival_time: Some(29700),
                    departure_time: None,
                },
            ],
        );

        // Without IFOPT mapping, returns raw stop_id
        assert_eq!(schedule.last_stop_of_trip("trip1"), Some("stop_B".to_string()));

        // With IFOPT mapping, returns IFOPT
        schedule.gtfs_to_ifopt.insert("stop_B".to_string(), vec!["de:09761:691".to_string()]);
        assert_eq!(schedule.last_stop_of_trip("trip1"), Some("de:09761:691".to_string()));

        // Unknown trip returns None
        assert_eq!(schedule.last_stop_of_trip("nonexistent"), None);
    }

    #[test]
    fn test_build_ifopt_mapping_with_routes() {
        let mut schedule = GtfsSchedule {
            stops: HashMap::new(),
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            trips_by_stop: HashMap::new(),
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        };

        // Add GTFS stop with coordinates
        schedule.stops.insert(
            "1001".to_string(),
            GtfsStop {
                stop_id: "1001".to_string(),
                stop_name: Some("Test Stop".to_string()),
                parent_station: Some("100".to_string()),
                lat: Some(48.3705),
                lon: Some(10.8978),
            },
        );

        schedule.trips_by_stop.insert(
            "1001".to_string(),
            std::iter::once("trip1".to_string()).collect(),
        );

        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:691:0:1".to_string(),
            name: Some("Test Stop".to_string()),
            lat: 48.3706,
            lon: 10.8979,
        }];

        // Both serve Tram 1 → definitive match
        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert(
            "de:09761:691:0:1".to_string(),
            [make_route("1", TransportType::Tram)].into_iter().collect(),
        );
        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        gtfs_route_sets.insert(
            "1001".to_string(),
            [make_route("1", TransportType::Tram)].into_iter().collect(),
        );

        schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);

        assert!(schedule.ifopt_to_gtfs.contains_key("de:09761:691:0:1"));
        assert_eq!(
            schedule.gtfs_to_ifopt.get("1001"),
            Some(&vec!["de:09761:691:0:1".to_string()])
        );
    }

    #[test]
    fn test_no_match_without_route_data() {
        let mut schedule = GtfsSchedule {
            stops: HashMap::new(),
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            trips_by_stop: HashMap::new(),
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        };

        schedule.stops.insert(
            "1001".to_string(),
            GtfsStop {
                stop_id: "1001".to_string(),
                stop_name: Some("Test Stop".to_string()),
                parent_station: Some("100".to_string()),
                lat: Some(48.3705),
                lon: Some(10.8978),
            },
        );

        schedule.trips_by_stop.insert(
            "1001".to_string(),
            std::iter::once("trip1".to_string()).collect(),
        );

        // OSM stop very close but NO route data → no match
        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:691:0:1".to_string(),
            name: Some("Test Stop".to_string()),
            lat: 48.3706,
            lon: 10.8979,
        }];

        let stats = schedule.build_ifopt_mapping(&osm_stops, &HashMap::new(), &HashMap::new());

        assert!(schedule.ifopt_to_gtfs.is_empty());
        assert_eq!(stats.matched, 0);
        assert_eq!(stats.unmatched_osm.len(), 1);
    }

    #[test]
    fn test_build_ifopt_mapping_no_match_beyond_distance() {
        let mut schedule = GtfsSchedule {
            stops: HashMap::new(),
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            trips_by_stop: HashMap::new(),
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        };

        schedule.stops.insert(
            "far_stop".to_string(),
            GtfsStop {
                stop_id: "far_stop".to_string(),
                stop_name: Some("Far Stop".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(49.0), // ~70km away
                lon: Some(11.0),
            },
        );

        schedule.trips_by_stop.insert(
            "far_stop".to_string(),
            std::iter::once("trip1".to_string()).collect(),
        );

        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:691:0:1".to_string(),
            name: Some("Test Stop".to_string()),
            lat: 48.37,
            lon: 10.89,
        }];

        // Even with matching routes, too far away → no match
        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert(
            "de:09761:691:0:1".to_string(),
            [make_route("1", TransportType::Tram)].into_iter().collect(),
        );
        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        gtfs_route_sets.insert(
            "far_stop".to_string(),
            [make_route("1", TransportType::Tram)].into_iter().collect(),
        );

        schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);

        assert!(schedule.ifopt_to_gtfs.is_empty());
        assert!(schedule.gtfs_to_ifopt.is_empty());
    }

    #[test]
    fn test_multiple_definitive_picks_closest() {
        // Two definitive candidates (same routes) → picks the closest by distance
        // This is the common case: multiple GTFS leaf stops at one station (per platform/direction)
        let mut schedule = GtfsSchedule {
            stops: HashMap::new(),
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            trips_by_stop: HashMap::new(),
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        };

        // Two GTFS stops nearby, both serving the same routes (different platforms)
        schedule.stops.insert(
            "gtfs_far".to_string(),
            GtfsStop {
                stop_id: "gtfs_far".to_string(),
                stop_name: Some("Stop A".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.3660),
                lon: Some(10.8941),
            },
        );
        schedule.stops.insert(
            "gtfs_close".to_string(),
            GtfsStop {
                stop_id: "gtfs_close".to_string(),
                stop_name: Some("Stop A".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.3654),
                lon: Some(10.8941),
            },
        );
        schedule.trips_by_stop.insert("gtfs_far".to_string(), HashSet::new());
        schedule.trips_by_stop.insert("gtfs_close".to_string(), HashSet::new());

        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:100".to_string(),
            name: Some("Stop A".to_string()),
            lat: 48.3654,
            lon: 10.8941,
        }];

        // Both GTFS stops and OSM stop serve the same route
        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert(
            "de:09761:100".to_string(),
            [make_route("1", TransportType::Tram)].into_iter().collect(),
        );
        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        gtfs_route_sets.insert(
            "gtfs_far".to_string(),
            [make_route("1", TransportType::Tram)].into_iter().collect(),
        );
        gtfs_route_sets.insert(
            "gtfs_close".to_string(),
            [make_route("1", TransportType::Tram)].into_iter().collect(),
        );

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);

        assert_eq!(stats.matched, 1, "Should match to the closest definitive candidate");
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:09761:100"),
            Some(&vec!["gtfs_close".to_string()]),
            "Should pick the closest GTFS stop when multiple are definitive"
        );
    }

    #[test]
    fn test_closer_osm_stop_gets_priority_over_farther() {
        // Moritzplatz scenario: Two OSM platforms (A closer, B farther) compete for
        // two GTFS stops that both serve the same routes. A should get the closest
        // GTFS stop, B should get the next one.
        let mut schedule = GtfsSchedule {
            stops: HashMap::new(),
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            trips_by_stop: HashMap::new(),
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        };

        // GTFS stop 1: closer to platform A (7m), farther from B (41m)
        schedule.stops.insert(
            "gtfs_1".to_string(),
            GtfsStop {
                stop_id: "gtfs_1".to_string(),
                stop_name: Some("Moritzplatz".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.367233),
                lon: Some(10.898002),
            },
        );
        // GTFS stop 2: a bit farther from A (12m), even farther from B (49m)
        schedule.stops.insert(
            "gtfs_2".to_string(),
            GtfsStop {
                stop_id: "gtfs_2".to_string(),
                stop_name: Some("Moritzplatz".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.36725),
                lon: Some(10.898109),
            },
        );
        schedule
            .trips_by_stop
            .insert("gtfs_1".to_string(), HashSet::new());
        schedule
            .trips_by_stop
            .insert("gtfs_2".to_string(), HashSet::new());

        // Platform A (closer to both GTFS stops)
        // Platform B (farther from both GTFS stops)
        let osm_stops = vec![
            OsmStopInfo {
                ifopt: "de:09761:617:0:B".to_string(),
                name: Some("Moritzplatz".to_string()),
                lat: 48.3670998,
                lon: 10.8974858,
            },
            OsmStopInfo {
                ifopt: "de:09761:617:0:A".to_string(),
                name: Some("Moritzplatz".to_string()),
                lat: 48.367171,
                lon: 10.8979903,
            },
        ];

        // Both serve the same routes
        let tram_routes: HashSet<RouteIdentifier> = [
            make_route("1", TransportType::Tram),
            make_route("2", TransportType::Tram),
        ]
        .into_iter()
        .collect();

        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert("de:09761:617:0:A".to_string(), tram_routes.clone());
        osm_route_sets.insert("de:09761:617:0:B".to_string(), tram_routes.clone());

        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        gtfs_route_sets.insert("gtfs_1".to_string(), tram_routes.clone());
        gtfs_route_sets.insert("gtfs_2".to_string(), tram_routes);

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);

        assert_eq!(stats.matched, 2, "Both platforms should be matched");
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:09761:617:0:A"),
            Some(&vec!["gtfs_1".to_string()]),
            "Platform A (closer) should get gtfs_1"
        );
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:09761:617:0:B"),
            Some(&vec!["gtfs_2".to_string()]),
            "Platform B (farther) should get gtfs_2"
        );
    }

    #[test]
    fn test_prefers_specific_match_over_closer_distance() {
        // A GTFS stop that exactly matches the OSM platform's routes (high specificity)
        // should be preferred over a closer but less specific stop.
        let mut schedule = GtfsSchedule {
            stops: HashMap::new(),
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            trips_by_stop: HashMap::new(),
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        };

        // Close stop shares only 1 route
        schedule.stops.insert(
            "gtfs_close".to_string(),
            GtfsStop {
                stop_id: "gtfs_close".to_string(),
                stop_name: Some("Stop A".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.3654),
                lon: Some(10.8941),
            },
        );
        // Farther stop shares 2 routes
        schedule.stops.insert(
            "gtfs_far".to_string(),
            GtfsStop {
                stop_id: "gtfs_far".to_string(),
                stop_name: Some("Stop A".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.3660),
                lon: Some(10.8941),
            },
        );
        schedule
            .trips_by_stop
            .insert("gtfs_close".to_string(), HashSet::new());
        schedule
            .trips_by_stop
            .insert("gtfs_far".to_string(), HashSet::new());

        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:100".to_string(),
            name: Some("Stop A".to_string()),
            lat: 48.3654,
            lon: 10.8941,
        }];

        // OSM stop serves Tram 1 and Tram 3
        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert(
            "de:09761:100".to_string(),
            [
                make_route("1", TransportType::Tram),
                make_route("3", TransportType::Tram),
            ]
            .into_iter()
            .collect(),
        );

        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        // Close GTFS stop shares only Tram 1
        gtfs_route_sets.insert(
            "gtfs_close".to_string(),
            [
                make_route("1", TransportType::Tram),
                make_route("99", TransportType::Bus),
            ]
            .into_iter()
            .collect(),
        );
        // Far GTFS stop shares both Tram 1 and Tram 3
        gtfs_route_sets.insert(
            "gtfs_far".to_string(),
            [
                make_route("1", TransportType::Tram),
                make_route("3", TransportType::Tram),
            ]
            .into_iter()
            .collect(),
        );

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);

        assert_eq!(stats.matched, 1);
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:09761:100"),
            Some(&vec!["gtfs_far".to_string()]),
            "Should prefer the more specific GTFS stop (exact route match) over a closer but less specific one"
        );
    }

    #[test]
    fn test_build_ifopt_mapping_one_to_one_constraint() {
        // Two IFOPTs near the same single GTFS stop — only the first should be matched
        let mut schedule = GtfsSchedule {
            stops: HashMap::new(),
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            trips_by_stop: HashMap::new(),
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        };

        // Single GTFS stop
        schedule.stops.insert(
            "gtfs_only".to_string(),
            GtfsStop {
                stop_id: "gtfs_only".to_string(),
                stop_name: Some("Königsplatz".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.3655),
                lon: Some(10.8944),
            },
        );
        schedule
            .trips_by_stop
            .insert("gtfs_only".to_string(), HashSet::new());

        // Two OSM platforms very close, both wanting the same GTFS stop
        let osm_stops = vec![
            OsmStopInfo {
                ifopt: "de:09761:101:31:A1".to_string(),
                name: Some("Königsplatz A1".to_string()),
                lat: 48.3655,
                lon: 10.8943,
            },
            OsmStopInfo {
                ifopt: "de:09761:101:31:A2".to_string(),
                name: Some("Königsplatz A2".to_string()),
                lat: 48.3656,
                lon: 10.8942,
            },
        ];

        // Both OSM stops and the GTFS stop serve the same route
        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert(
            "de:09761:101:31:A1".to_string(),
            [make_route("1", TransportType::Tram)].into_iter().collect(),
        );
        osm_route_sets.insert(
            "de:09761:101:31:A2".to_string(),
            [make_route("1", TransportType::Tram)].into_iter().collect(),
        );
        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        gtfs_route_sets.insert(
            "gtfs_only".to_string(),
            [make_route("1", TransportType::Tram)].into_iter().collect(),
        );

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);

        // Both platforms at the same station share the single GTFS stop
        // (station-level fallback allows sibling platforms to reuse a GTFS stop)
        assert_eq!(stats.matched, 2, "Both sibling platforms should share the GTFS stop");

        // Both IFOPTs should map to the same GTFS stop
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:09761:101:31:A1"),
            Some(&vec!["gtfs_only".to_string()])
        );
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:09761:101:31:A2"),
            Some(&vec!["gtfs_only".to_string()])
        );

        assert_eq!(stats.unmatched_osm.len(), 0);
    }

    #[test]
    fn test_normalize_stop_name() {
        assert_eq!(normalize_stop_name("Hbf"), "hauptbahnhof");
        assert_eq!(normalize_stop_name("Str. 5"), "straße 5");
        assert_eq!(normalize_stop_name("Rathaus (U)"), "rathaus");
        assert_eq!(
            normalize_stop_name("  Multiple   Spaces  "),
            "multiple spaces"
        );
    }

    #[test]
    fn test_stop_times_sorted_with_gaps_in_sequence() {
        // Verify that stop_times with non-contiguous sequence numbers sort correctly
        let mut schedule = GtfsSchedule {
            stops: HashMap::new(),
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            trips_by_stop: HashMap::new(),
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        };

        // Insert stop_times out of order with gaps in sequence
        schedule.stop_times.insert(
            "trip_gap".to_string(),
            vec![
                GtfsStopTime {
                    stop_sequence: 10,
                    stop_id: "stop_C".to_string(),
                    arrival_time: Some(30600),
                    departure_time: Some(30600),
                },
                GtfsStopTime {
                    stop_sequence: 1,
                    stop_id: "stop_A".to_string(),
                    arrival_time: Some(28800),
                    departure_time: Some(28800),
                },
                GtfsStopTime {
                    stop_sequence: 5,
                    stop_id: "stop_B".to_string(),
                    arrival_time: Some(29700),
                    departure_time: Some(29700),
                },
            ],
        );

        // Sort like load_schedule does
        for sts in schedule.stop_times.values_mut() {
            sts.sort_by_key(|st| st.stop_sequence);
        }

        let times = &schedule.stop_times["trip_gap"];
        assert_eq!(times[0].stop_sequence, 1);
        assert_eq!(times[0].stop_id, "stop_A");
        assert_eq!(times[1].stop_sequence, 5);
        assert_eq!(times[1].stop_id, "stop_B");
        assert_eq!(times[2].stop_sequence, 10);
        assert_eq!(times[2].stop_id, "stop_C");

        // last_stop_of_trip should return the highest sequence stop
        assert_eq!(schedule.last_stop_of_trip("trip_gap"), Some("stop_C".to_string()));
    }

    #[test]
    fn test_stop_times_duplicate_sequence_numbers() {
        // Duplicate sequence numbers shouldn't crash — they'll be adjacent after sort
        let mut stop_times: HashMap<String, Vec<GtfsStopTime>> = HashMap::new();
        stop_times.insert(
            "trip_dup".to_string(),
            vec![
                GtfsStopTime {
                    stop_sequence: 1,
                    stop_id: "stop_A".to_string(),
                    arrival_time: Some(28800),
                    departure_time: Some(28800),
                },
                GtfsStopTime {
                    stop_sequence: 1, // duplicate
                    stop_id: "stop_B".to_string(),
                    arrival_time: Some(29000),
                    departure_time: Some(29000),
                },
                GtfsStopTime {
                    stop_sequence: 2,
                    stop_id: "stop_C".to_string(),
                    arrival_time: Some(29700),
                    departure_time: Some(29700),
                },
            ],
        );

        for sts in stop_times.values_mut() {
            sts.sort_by_key(|st| st.stop_sequence);
        }

        let times = &stop_times["trip_dup"];
        assert_eq!(times.len(), 3);
        assert_eq!(times[0].stop_sequence, 1);
        assert_eq!(times[1].stop_sequence, 1);
        assert_eq!(times[2].stop_sequence, 2);
    }

    /// Helper to create route sets for the two-stop schedule used in mapping tests.
    /// Königsplatz serves Tram 1 and Tram 3, Moritzplatz serves Bus 5.
    fn make_route_sets_for_mapping() -> (
        HashMap<String, HashSet<RouteIdentifier>>,
        HashMap<String, HashSet<RouteIdentifier>>,
    ) {
        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert(
            "de:09761:100".to_string(),
            [
                make_route("1", TransportType::Tram),
                make_route("3", TransportType::Tram),
            ]
            .into_iter()
            .collect(),
        );
        osm_route_sets.insert(
            "de:09761:200".to_string(),
            [make_route("5", TransportType::Bus)].into_iter().collect(),
        );

        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        gtfs_route_sets.insert(
            "gtfs_kp".to_string(),
            [
                make_route("1", TransportType::Tram),
                make_route("3", TransportType::Tram),
            ]
            .into_iter()
            .collect(),
        );
        gtfs_route_sets.insert(
            "gtfs_mp".to_string(),
            [make_route("5", TransportType::Bus)].into_iter().collect(),
        );

        (osm_route_sets, gtfs_route_sets)
    }

    /// Helper to create a minimal schedule with GTFS stops for mapping tests.
    fn make_schedule_for_mapping() -> GtfsSchedule {
        let mut stops = HashMap::new();
        let mut trips_by_stop = HashMap::new();

        // GTFS stop at Königsplatz (~48.365, 10.898)
        stops.insert(
            "gtfs_kp".to_string(),
            GtfsStop {
                stop_id: "gtfs_kp".to_string(),
                stop_name: Some("Königsplatz".to_string()),
                parent_station: Some("parent_kp".to_string()),
                lat: Some(48.365),
                lon: Some(10.898),
            },
        );
        trips_by_stop.insert(
            "gtfs_kp".to_string(),
            HashSet::from(["trip1".to_string()]),
        );

        // GTFS stop at Moritzplatz (~48.363, 10.897)
        stops.insert(
            "gtfs_mp".to_string(),
            GtfsStop {
                stop_id: "gtfs_mp".to_string(),
                stop_name: Some("Moritzplatz".to_string()),
                parent_station: Some("parent_mp".to_string()),
                lat: Some(48.363),
                lon: Some(10.897),
            },
        );
        trips_by_stop.insert(
            "gtfs_mp".to_string(),
            HashSet::from(["trip2".to_string()]),
        );

        GtfsSchedule {
            stops,
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            trips_by_stop,
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        }
    }

    #[test]
    fn test_build_ifopt_mapping_basic_match() {
        let mut schedule = make_schedule_for_mapping();
        let (osm_route_sets, gtfs_route_sets) = make_route_sets_for_mapping();

        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:100".to_string(),
            name: Some("Königsplatz".to_string()),
            lat: 48.3651,
            lon: 10.8981,
        }];

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);
        assert_eq!(stats.matched, 1);
        assert_eq!(stats.manual_count, 0);
        assert!(schedule.ifopt_to_gtfs.contains_key("de:09761:100"));
        assert_eq!(
            schedule.ifopt_to_gtfs["de:09761:100"],
            vec!["gtfs_kp".to_string()]
        );
    }

    #[test]
    fn test_build_ifopt_mapping_no_match_when_too_far() {
        let mut schedule = make_schedule_for_mapping();

        // Stop far from any GTFS stop (>500m away), with route data
        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:999".to_string(),
            name: Some("Far Away".to_string()),
            lat: 48.400,
            lon: 10.950,
        }];

        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert(
            "de:09761:999".to_string(),
            [make_route("1", TransportType::Tram)].into_iter().collect(),
        );

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &HashMap::new());
        assert_eq!(stats.matched, 0);
        assert_eq!(stats.unmatched_osm.len(), 1);
        assert_eq!(stats.manual_count, 0);
    }

    #[test]
    fn test_build_ifopt_mapping_picks_correct_by_routes() {
        let mut schedule = make_schedule_for_mapping();
        let (osm_route_sets, gtfs_route_sets) = make_route_sets_for_mapping();

        // OSM stop with Königsplatz routes — should match gtfs_kp, not gtfs_mp
        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:100".to_string(),
            name: Some("Königsplatz".to_string()),
            lat: 48.3651,
            lon: 10.8981,
        }];

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);
        assert_eq!(stats.matched, 1);
        assert_eq!(
            schedule.ifopt_to_gtfs["de:09761:100"],
            vec!["gtfs_kp".to_string()]
        );
    }

    #[test]
    fn test_build_ifopt_mapping_multiple_osm_stops() {
        let mut schedule = make_schedule_for_mapping();
        let (osm_route_sets, gtfs_route_sets) = make_route_sets_for_mapping();

        let osm_stops = vec![
            OsmStopInfo {
                ifopt: "de:09761:100".to_string(),
                name: Some("Königsplatz".to_string()),
                lat: 48.3651,
                lon: 10.8981,
            },
            OsmStopInfo {
                ifopt: "de:09761:200".to_string(),
                name: Some("Moritzplatz".to_string()),
                lat: 48.3631,
                lon: 10.8971,
            },
        ];

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);
        assert_eq!(stats.matched, 2);
        assert_eq!(stats.manual_count, 0);
        assert!(schedule.ifopt_to_gtfs.contains_key("de:09761:100"));
        assert!(schedule.ifopt_to_gtfs.contains_key("de:09761:200"));
    }

    #[test]
    fn test_mapping_stats_manual_count_zero_for_in_memory() {
        let mut schedule = make_schedule_for_mapping();
        let (osm_route_sets, gtfs_route_sets) = make_route_sets_for_mapping();

        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:100".to_string(),
            name: Some("Königsplatz".to_string()),
            lat: 48.3651,
            lon: 10.8981,
        }];

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);
        // In-memory matching always returns 0 manual mappings
        assert_eq!(stats.manual_count, 0);
    }

    // --- Route overlap scoring tests ---

    fn make_route(line: &str, tt: TransportType) -> RouteIdentifier {
        RouteIdentifier {
            line_ref: line.to_string(),
            transport_type: tt,
        }
    }

    #[test]
    fn test_definitive_match_identical() {
        let a: HashSet<RouteIdentifier> = [
            make_route("1", TransportType::Tram),
            make_route("3", TransportType::Tram),
        ]
        .into_iter()
        .collect();
        let b = a.clone();
        let (definitive, shared) = is_definitive_match(&a, &b);
        assert!(definitive);
        assert_eq!(shared.len(), 2);
    }

    #[test]
    fn test_definitive_match_subset() {
        // OSM has {Tram 1, Tram 3}, GTFS has {Tram 1, Tram 3, Bus N5}
        // OSM ⊆ GTFS → definitive
        let osm: HashSet<RouteIdentifier> = [
            make_route("1", TransportType::Tram),
            make_route("3", TransportType::Tram),
        ]
        .into_iter()
        .collect();
        let gtfs: HashSet<RouteIdentifier> = [
            make_route("1", TransportType::Tram),
            make_route("3", TransportType::Tram),
            make_route("N5", TransportType::Bus),
        ]
        .into_iter()
        .collect();
        let (definitive, shared) = is_definitive_match(&osm, &gtfs);
        assert!(definitive);
        assert_eq!(shared.len(), 2);
    }

    #[test]
    fn test_definitive_match_disjoint() {
        let a: HashSet<RouteIdentifier> = [
            make_route("1", TransportType::Tram),
        ]
        .into_iter()
        .collect();
        let b: HashSet<RouteIdentifier> = [
            make_route("5", TransportType::Bus),
        ]
        .into_iter()
        .collect();
        let (definitive, shared) = is_definitive_match(&a, &b);
        assert!(!definitive);
        assert!(shared.is_empty());
    }

    #[test]
    fn test_definitive_match_partial_overlap() {
        // Neither is a subset of the other, but they share Tram 1 → match
        // This handles data quality differences (e.g., seasonal trams in OSM,
        // agency-specific bus routes in GTFS)
        let a: HashSet<RouteIdentifier> = [
            make_route("1", TransportType::Tram),
            make_route("3", TransportType::Tram),
            make_route("5", TransportType::Bus),
        ]
        .into_iter()
        .collect();
        let b: HashSet<RouteIdentifier> = [
            make_route("1", TransportType::Tram),
            make_route("7", TransportType::Bus),
        ]
        .into_iter()
        .collect();
        let (definitive, shared) = is_definitive_match(&a, &b);
        assert!(definitive, "Partial overlap with shared routes should match");
        assert_eq!(shared.len(), 1);
    }

    #[test]
    fn test_definitive_match_asymmetric_data_quality() {
        // Real-world case: Platform C4 Königsplatz
        // OSM has {Tram 3, Tram 9}, GTFS has {Tram 3, Bus 43}
        // Tram 9 is a seasonal extra tram only in OSM, Bus 43 is only in GTFS
        // They share Tram 3 → should match
        let osm: HashSet<RouteIdentifier> = [
            make_route("3", TransportType::Tram),
            make_route("9", TransportType::Tram),
        ]
        .into_iter()
        .collect();
        let gtfs: HashSet<RouteIdentifier> = [
            make_route("3", TransportType::Tram),
            make_route("43", TransportType::Bus),
        ]
        .into_iter()
        .collect();
        let (definitive, shared) = is_definitive_match(&osm, &gtfs);
        assert!(
            definitive,
            "Stops sharing Tram 3 should match despite other routes differing"
        );
        assert_eq!(shared.len(), 1);
        assert_eq!(shared[0].line_ref, "3");
    }

    #[test]
    fn test_definitive_match_empty() {
        let a: HashSet<RouteIdentifier> = HashSet::new();
        let b: HashSet<RouteIdentifier> = HashSet::new();
        let (definitive, shared) = is_definitive_match(&a, &b);
        assert!(!definitive);
        assert!(shared.is_empty());
    }

    #[test]
    fn test_route_identifier_type_disambiguation() {
        // Bus "1" and Tram "1" should be different route identifiers
        let bus_1 = make_route("1", TransportType::Bus);
        let tram_1 = make_route("1", TransportType::Tram);
        assert_ne!(bus_1, tram_1);

        let a: HashSet<RouteIdentifier> = [bus_1].into_iter().collect();
        let b: HashSet<RouteIdentifier> = [tram_1].into_iter().collect();
        let (definitive, shared) = is_definitive_match(&a, &b);
        assert!(!definitive);
        assert!(shared.is_empty());
    }

    #[test]
    fn test_from_gtfs_route_type() {
        assert_eq!(TransportType::from_gtfs_route_type(0), TransportType::Tram);
        assert_eq!(TransportType::from_gtfs_route_type(900), TransportType::Tram);
        assert_eq!(TransportType::from_gtfs_route_type(1), TransportType::Subway);
        assert_eq!(TransportType::from_gtfs_route_type(400), TransportType::Subway);
        assert_eq!(TransportType::from_gtfs_route_type(2), TransportType::Train);
        assert_eq!(TransportType::from_gtfs_route_type(100), TransportType::Train);
        assert_eq!(TransportType::from_gtfs_route_type(3), TransportType::Bus);
        assert_eq!(TransportType::from_gtfs_route_type(700), TransportType::Bus);
        assert_eq!(TransportType::from_gtfs_route_type(800), TransportType::Bus);
        assert_eq!(TransportType::from_gtfs_route_type(4), TransportType::Ferry);
        assert_eq!(TransportType::from_gtfs_route_type(999), TransportType::Unknown);
    }

    #[test]
    fn test_route_overlap_matching_prefers_correct_stop() {
        // Scenario: Two GTFS stops near one OSM stop, but only one shares routes
        let mut schedule = GtfsSchedule {
            stops: HashMap::new(),
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            trips_by_stop: HashMap::new(),
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        };

        // Two GTFS stops at similar distances
        schedule.stops.insert(
            "gtfs_correct".to_string(),
            GtfsStop {
                stop_id: "gtfs_correct".to_string(),
                stop_name: Some("Stop A".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.3660),
                lon: Some(10.8970),
            },
        );
        schedule.stops.insert(
            "gtfs_wrong".to_string(),
            GtfsStop {
                stop_id: "gtfs_wrong".to_string(),
                stop_name: Some("Stop A".to_string()), // Same name!
                parent_station: Some("parent".to_string()),
                lat: Some(48.3658), // Slightly closer
                lon: Some(10.8972),
            },
        );

        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:100".to_string(),
            name: Some("Stop A".to_string()),
            lat: 48.3659,
            lon: 10.8971,
        }];

        // Route sets: OSM stop serves Tram 1 and Tram 3
        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert(
            "de:09761:100".to_string(),
            [
                make_route("1", TransportType::Tram),
                make_route("3", TransportType::Tram),
            ]
            .into_iter()
            .collect(),
        );

        // gtfs_correct also serves Tram 1 and Tram 3 (perfect match)
        // gtfs_wrong serves Bus 5 (no overlap)
        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        gtfs_route_sets.insert(
            "gtfs_correct".to_string(),
            [
                make_route("1", TransportType::Tram),
                make_route("3", TransportType::Tram),
            ]
            .into_iter()
            .collect(),
        );
        gtfs_route_sets.insert(
            "gtfs_wrong".to_string(),
            [make_route("5", TransportType::Bus)].into_iter().collect(),
        );

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);

        assert_eq!(stats.matched, 1);
        // Should match to gtfs_correct despite gtfs_wrong being slightly closer
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:09761:100"),
            Some(&vec!["gtfs_correct".to_string()])
        );
    }

    #[test]
    fn test_high_match_rate_with_multi_platform_stations() {
        // Simulates a realistic transit network where each station has multiple GTFS
        // leaf stops (one per platform/direction) all serving the same routes.
        // The matcher must achieve at least 90% match rate on OSM stops that have route data.
        let mut schedule = GtfsSchedule {
            stops: HashMap::new(),
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            trips_by_stop: HashMap::new(),
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        };

        let num_stations = 20;
        let mut osm_stops = Vec::new();
        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();

        for i in 0..num_stations {
            let base_lat = 48.36 + (i as f64) * 0.002;
            let base_lon = 10.89 + (i as f64) * 0.001;

            // Each station has a unique route set (simulating different lines)
            let route_set: HashSet<RouteIdentifier> = [
                make_route(&format!("{}", i * 2 + 1), TransportType::Tram),
                make_route(&format!("{}", i * 2 + 2), TransportType::Bus),
            ]
            .into_iter()
            .collect();

            // OSM stop (one per station)
            let ifopt = format!("de:09761:{}:0:1", 100 + i);
            osm_stops.push(OsmStopInfo {
                ifopt: ifopt.clone(),
                name: Some(format!("Station {}", i)),
                lat: base_lat,
                lon: base_lon,
            });
            osm_route_sets.insert(ifopt, route_set.clone());

            // GTFS: 3 leaf stops per station (e.g., platform A, B, C)
            // All serve the same routes — this is the common real-world pattern
            for platform in 0..3 {
                let gtfs_id = format!("gtfs_{}_{}", i, platform);
                let offset = (platform as f64) * 0.00005; // ~5m apart
                schedule.stops.insert(
                    gtfs_id.clone(),
                    GtfsStop {
                        stop_id: gtfs_id.clone(),
                        stop_name: Some(format!("Station {} Platform {}", i, platform)),
                        parent_station: Some(format!("parent_{}", i)),
                        lat: Some(base_lat + offset),
                        lon: Some(base_lon + offset),
                    },
                );
                schedule
                    .trips_by_stop
                    .insert(gtfs_id.clone(), HashSet::new());
                gtfs_route_sets.insert(gtfs_id, route_set.clone());
            }
        }

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);

        let match_rate = stats.matched as f64 / num_stations as f64;
        assert!(
            match_rate >= 0.9,
            "Match rate {:.1}% ({}/{}) is below 90% threshold",
            match_rate * 100.0,
            stats.matched,
            num_stations
        );
    }

    #[test]
    fn test_duplicate_ifopt_entries_do_not_overwrite_correct_match() {
        // Same IFOPT appearing multiple times with different coordinates (from platforms + stop_positions).
        // The first occurrence (closest) should win and not be overwritten by later duplicates.
        let mut schedule = GtfsSchedule {
            stops: HashMap::new(),
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            trips_by_stop: HashMap::new(),
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        };

        // Correct GTFS stop (2m away from first OSM entry)
        schedule.stops.insert(
            "gtfs_correct".to_string(),
            GtfsStop {
                stop_id: "gtfs_correct".to_string(),
                stop_name: Some("Barfüßerbrücke".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.3654),
                lon: Some(10.8941),
            },
        );
        // Wrong GTFS stop (farther away, at a different station)
        schedule.stops.insert(
            "gtfs_wrong".to_string(),
            GtfsStop {
                stop_id: "gtfs_wrong".to_string(),
                stop_name: Some("Pilgerhausstraße".to_string()),
                parent_station: Some("parent2".to_string()),
                lat: Some(48.3670),
                lon: Some(10.8941),
            },
        );
        schedule
            .trips_by_stop
            .insert("gtfs_correct".to_string(), HashSet::new());
        schedule
            .trips_by_stop
            .insert("gtfs_wrong".to_string(), HashSet::new());

        // Same IFOPT appears 3 times with slightly different coordinates
        let osm_stops = vec![
            OsmStopInfo {
                ifopt: "de:09761:131:0:a".to_string(),
                name: Some("Barfüßerbrücke".to_string()),
                lat: 48.3654,
                lon: 10.89412, // closest to gtfs_correct
            },
            OsmStopInfo {
                ifopt: "de:09761:131:0:a".to_string(),
                name: Some("Barfüßerbrücke".to_string()),
                lat: 48.3658,
                lon: 10.8941, // slightly different coords
            },
            OsmStopInfo {
                ifopt: "de:09761:131:0:a".to_string(),
                name: Some("Barfüßerbrücke".to_string()),
                lat: 48.3662,
                lon: 10.8941, // even farther
            },
        ];

        let tram_routes: HashSet<RouteIdentifier> =
            [make_route("1", TransportType::Tram)].into_iter().collect();

        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert("de:09761:131:0:a".to_string(), tram_routes.clone());

        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        gtfs_route_sets.insert("gtfs_correct".to_string(), tram_routes.clone());
        gtfs_route_sets.insert("gtfs_wrong".to_string(), tram_routes);

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);

        // Only one match (duplicates are skipped)
        assert_eq!(stats.matched, 1);
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:09761:131:0:a"),
            Some(&vec!["gtfs_correct".to_string()]),
            "First IFOPT entry (closest to gtfs_correct) should be matched, duplicates skipped"
        );
    }

    // --- Cross-station theft and direction disambiguation tests ---

    #[test]
    fn test_cross_station_theft_prevented_by_fallback_distance_limit() {
        // Maria-Alber scenario: Station A has 5 OSM platforms (2 with Line 6 routes).
        // Station B (Rudolf-Diesel-Gymnasium, ~400m away) has 1 GTFS stop also serving Line 6.
        // Bug: without fallback distance limit, station A's 2nd platform would "steal" station B's
        // GTFS stop because its nearest candidate was claimed and it fell back to ANY unclaimed one.
        let mut schedule = GtfsSchedule {
            stops: HashMap::new(),
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            trips_by_stop: HashMap::new(),
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        };

        // Station A (Maria-Alber) center: 48.3565, 10.9850
        // GTFS stop at station A serving Line 6
        schedule.stops.insert(
            "gtfs_a_line6".to_string(),
            GtfsStop {
                stop_id: "gtfs_a_line6".to_string(),
                stop_name: Some("Friedberg Maria-Alber".to_string()),
                parent_station: Some("parent_a".to_string()),
                lat: Some(48.3565),
                lon: Some(10.9850),
            },
        );
        schedule
            .trips_by_stop
            .insert("gtfs_a_line6".to_string(), HashSet::from(["trip_a".to_string()]));

        // Station B (Rudolf-Diesel-Gymnasium) ~400m away: 48.3600, 10.9850
        // GTFS stop at station B also serving Line 6
        schedule.stops.insert(
            "gtfs_b_line6".to_string(),
            GtfsStop {
                stop_id: "gtfs_b_line6".to_string(),
                stop_name: Some("Rudolf-Diesel-Gymnasium".to_string()),
                parent_station: Some("parent_b".to_string()),
                lat: Some(48.3600),
                lon: Some(10.9850),
            },
        );
        schedule
            .trips_by_stop
            .insert("gtfs_b_line6".to_string(), HashSet::from(["trip_b".to_string()]));

        // Station A has 5 OSM platforms; 2 have Line 6 routes
        // Platform A is closest to gtfs_a_line6 (~5m)
        let osm_stops = vec![
            OsmStopInfo {
                ifopt: "de:maria:1:0:A".to_string(),
                name: Some("Maria-Alber A".to_string()),
                lat: 48.35654,
                lon: 10.98504,
            },
            OsmStopInfo {
                ifopt: "de:maria:1:0:B".to_string(),
                name: Some("Maria-Alber B".to_string()),
                lat: 48.3568,
                lon: 10.9853,
            },
            OsmStopInfo {
                ifopt: "de:maria:1:0:C".to_string(),
                name: Some("Maria-Alber C".to_string()),
                lat: 48.3563,
                lon: 10.9848,
            },
            OsmStopInfo {
                ifopt: "de:maria:1:0:D".to_string(),
                name: Some("Maria-Alber D".to_string()),
                lat: 48.3567,
                lon: 10.9852,
            },
            OsmStopInfo {
                ifopt: "de:maria:1:0:E".to_string(),
                name: Some("Maria-Alber E".to_string()),
                lat: 48.3565,
                lon: 10.9853,
            },
        ];

        // Only platforms A and B have Line 6 routes
        let line6_routes: HashSet<RouteIdentifier> =
            [make_route("6", TransportType::Bus)].into_iter().collect();
        let other_routes: HashSet<RouteIdentifier> =
            [make_route("3", TransportType::Bus)].into_iter().collect();

        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert("de:maria:1:0:A".to_string(), line6_routes.clone());
        osm_route_sets.insert("de:maria:1:0:B".to_string(), line6_routes.clone());
        osm_route_sets.insert("de:maria:1:0:C".to_string(), other_routes.clone());
        osm_route_sets.insert("de:maria:1:0:D".to_string(), other_routes.clone());
        osm_route_sets.insert("de:maria:1:0:E".to_string(), other_routes);

        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        gtfs_route_sets.insert("gtfs_a_line6".to_string(), line6_routes.clone());
        gtfs_route_sets.insert("gtfs_b_line6".to_string(), line6_routes);

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);

        // Platform A (closest to gtfs_a_line6) should claim it
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:maria:1:0:A"),
            Some(&vec!["gtfs_a_line6".to_string()]),
            "Closest Line 6 platform should claim station A's GTFS stop"
        );

        // Station B's GTFS stop (400m away) should NOT be claimed by any station A platform.
        // The fallback distance limit (max 200m) prevents this.
        assert!(
            !schedule.gtfs_to_ifopt.contains_key("gtfs_b_line6")
                || schedule.gtfs_to_ifopt.get("gtfs_b_line6")
                    .map(|ifopts| !ifopts.iter().any(|ifopt| ifopt.starts_with("de:maria:")))
                    .unwrap_or(true),
            "Station B's GTFS stop must NOT be stolen by any station A platform"
        );

        // Platform B shares gtfs_a_line6 via station-level fallback (same station sibling)
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:maria:1:0:B"),
            Some(&vec!["gtfs_a_line6".to_string()]),
            "Platform B should share station A's GTFS stop via station fallback"
        );

        // 2 matches at station A (platform A claims, platform B shares via fallback)
        assert_eq!(stats.matched, 2, "Two matches at station A via station fallback");
    }

    #[test]
    fn test_direction_disambiguation_via_trip_overlap() {
        // Two platforms at same station serve Line 6 in different directions.
        // Two GTFS stops at that station, each visited by different trips.
        // A third station ("anchor") on the same routes is already unambiguously matched,
        // establishing which trips belong to which directional route.
        // The anchor's trip overlap tells us which GTFS stop at the target station
        // serves the same direction as each platform.
        let mut schedule = GtfsSchedule {
            stops: HashMap::new(),
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            trips_by_stop: HashMap::new(),
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        };

        // Anchor GTFS stop at a different station, unambiguously close to one platform.
        // This stop's trips establish the direction fingerprint for osm_route 1001.
        schedule.stops.insert(
            "gtfs_anchor".to_string(),
            GtfsStop {
                stop_id: "gtfs_anchor".to_string(),
                stop_name: Some("Anchor Station".to_string()),
                parent_station: Some("parent_anchor".to_string()),
                lat: Some(48.360),
                lon: Some(10.985),
            },
        );
        // Trips T1,T2,T3 go through anchor and gtfs_north (same direction: osm_route 1001)
        // Trips T4,T5,T6 go through gtfs_south only (opposite direction: osm_route 1002)
        schedule.trips_by_stop.insert(
            "gtfs_anchor".to_string(),
            HashSet::from(["T1".to_string(), "T2".to_string(), "T3".to_string()]),
        );

        // Two GTFS stops at target station (equidistant from both platforms)
        schedule.stops.insert(
            "gtfs_north".to_string(),
            GtfsStop {
                stop_id: "gtfs_north".to_string(),
                stop_name: Some("Maria-Alber".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.3565),
                lon: Some(10.9850),
            },
        );
        schedule.stops.insert(
            "gtfs_south".to_string(),
            GtfsStop {
                stop_id: "gtfs_south".to_string(),
                stop_name: Some("Maria-Alber".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.3565),
                lon: Some(10.9850), // same position — only trips differ
            },
        );
        // gtfs_north shares trips with anchor (same direction)
        schedule.trips_by_stop.insert(
            "gtfs_north".to_string(),
            HashSet::from(["T1".to_string(), "T2".to_string(), "T3".to_string()]),
        );
        // gtfs_south has completely different trips (opposite direction)
        schedule.trips_by_stop.insert(
            "gtfs_south".to_string(),
            HashSet::from(["T4".to_string(), "T5".to_string(), "T6".to_string()]),
        );

        // Anchor platform: unambiguously on osm_route 1001, close to gtfs_anchor
        let osm_stops = vec![
            OsmStopInfo {
                ifopt: "de:anchor:1:0:X".to_string(),
                name: Some("Anchor".to_string()),
                lat: 48.360,
                lon: 10.985,
            },
            // Platform A: on osm_route 1001 (same as anchor)
            OsmStopInfo {
                ifopt: "de:maria:1:0:A".to_string(),
                name: Some("Maria-Alber A".to_string()),
                lat: 48.3565,
                lon: 10.9850,
            },
            // Platform B: on osm_route 1002 (opposite direction)
            OsmStopInfo {
                ifopt: "de:maria:1:0:B".to_string(),
                name: Some("Maria-Alber B".to_string()),
                lat: 48.3565,
                lon: 10.9850, // same position — only route differs
            },
        ];

        let line6_routes: HashSet<RouteIdentifier> =
            [make_route("6", TransportType::Bus)].into_iter().collect();

        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert("de:anchor:1:0:X".to_string(), line6_routes.clone());
        osm_route_sets.insert("de:maria:1:0:A".to_string(), line6_routes.clone());
        osm_route_sets.insert("de:maria:1:0:B".to_string(), line6_routes.clone());

        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        gtfs_route_sets.insert("gtfs_anchor".to_string(), line6_routes.clone());
        gtfs_route_sets.insert("gtfs_north".to_string(), line6_routes.clone());
        gtfs_route_sets.insert("gtfs_south".to_string(), line6_routes);

        // Directional routes: anchor + platform A on route 1001, platform B on route 1002
        let mut osm_directional_routes: HashMap<String, HashSet<i64>> = HashMap::new();
        osm_directional_routes
            .insert("de:anchor:1:0:X".to_string(), HashSet::from([1001]));
        osm_directional_routes
            .insert("de:maria:1:0:A".to_string(), HashSet::from([1001]));
        osm_directional_routes
            .insert("de:maria:1:0:B".to_string(), HashSet::from([1002]));

        let stats = schedule.build_ifopt_mapping_with_direction(
            &osm_stops,
            &osm_route_sets,
            &gtfs_route_sets,
            &osm_directional_routes,
        );

        assert_eq!(stats.matched, 3, "All three platforms should be matched");

        // Anchor gets gtfs_anchor (closest geographically)
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:anchor:1:0:X"),
            Some(&vec!["gtfs_anchor".to_string()]),
        );

        // Platform A (osm_route 1001, same as anchor) should get gtfs_north
        // because gtfs_north shares trips T1,T2,T3 with the anchor's gtfs_anchor
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:maria:1:0:A"),
            Some(&vec!["gtfs_north".to_string()]),
            "Platform A should match gtfs_north via trip overlap with anchor"
        );

        // Platform B (osm_route 1002) should get gtfs_south
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:maria:1:0:B"),
            Some(&vec!["gtfs_south".to_string()]),
            "Platform B should match gtfs_south (the remaining stop)"
        );
    }

    #[test]
    fn test_direction_fallback_without_trip_data() {
        // When no directional route data is available, matching should still work
        // using distance-first sorting (graceful degradation).
        let mut schedule = GtfsSchedule {
            stops: HashMap::new(),
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            trips_by_stop: HashMap::new(),
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        };

        schedule.stops.insert(
            "gtfs_1".to_string(),
            GtfsStop {
                stop_id: "gtfs_1".to_string(),
                stop_name: Some("Stop".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.3565),
                lon: Some(10.9850),
            },
        );
        schedule
            .trips_by_stop
            .insert("gtfs_1".to_string(), HashSet::from(["trip1".to_string()]));

        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:test:1:0:A".to_string(),
            name: Some("Stop A".to_string()),
            lat: 48.3566,
            lon: 10.9851,
        }];

        let line6: HashSet<RouteIdentifier> =
            [make_route("6", TransportType::Bus)].into_iter().collect();

        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert("de:test:1:0:A".to_string(), line6.clone());

        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        gtfs_route_sets.insert("gtfs_1".to_string(), line6);

        // No directional route data available
        let stats = schedule.build_ifopt_mapping_with_direction(
            &osm_stops,
            &osm_route_sets,
            &gtfs_route_sets,
            &HashMap::new(),
        );

        assert_eq!(stats.matched, 1, "Should still match without direction data");
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:test:1:0:A"),
            Some(&vec!["gtfs_1".to_string()]),
        );
    }
}
