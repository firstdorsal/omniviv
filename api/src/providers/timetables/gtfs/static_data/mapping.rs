use std::collections::{HashMap, HashSet};

use sqlx::PgPool;
use tracing::info;

use super::super::error::GtfsError;
use super::utils::station_level_ifopt;
use crate::config::TransportType;
use crate::sync::{transport_type_from_route, MatchCandidate};

// --- Matching algorithm constants ---

/// Maximum distance in meters for proximity pre-filter
pub(crate) const MAX_DISTANCE_METERS: f64 = 500.0;

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
pub(crate) fn is_definitive_match(
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

/// Bulk-load OSM route sets from the database.
/// Returns:
/// - route_sets: IFOPT → set of RouteIdentifiers (for definitive match testing)
/// - directional_routes: IFOPT → set of OSM route osm_ids (for direction disambiguation)
pub(crate) async fn load_osm_route_sets(
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
pub(crate) async fn load_osm_destinations(
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
pub(crate) async fn load_gtfs_directions(
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
pub(crate) async fn load_gtfs_trip_sets(
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
pub(crate) async fn load_gtfs_route_sets(
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
    /// Maximum rows per batch for bulk INSERT into PostgreSQL.
    const DB_BATCH_SIZE: usize = 10_000;

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
