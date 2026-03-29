use std::collections::{HashMap, HashSet};

use sqlx::PgPool;
use tracing::{debug, info};

use super::super::error::GtfsError;
use crate::config::TransportType;
use crate::sync::{transport_type_from_route, MatchCandidate};

// --- Matching algorithm constants ---

/// Maximum distance in meters for proximity pre-filter
pub(crate) const MAX_DISTANCE_METERS: f64 = 500.0;

/// OSM stop info for matching. Includes OSM identity (osm_id + osm_type),
/// optional IFOPT, name, and coordinates.
pub struct OsmStopInfo {
    /// OSM node ID
    pub osm_id: i64,
    /// "platform" or "stop_position"
    pub osm_type: String,
    /// IFOPT code if available (from `ref:IFOPT` tag)
    pub ifopt: Option<String>,
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
    pub(crate) osm_id: i64,
    pub(crate) osm_type: String,
    pub(crate) ifopt: Option<String>,
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

/// Bulk-load OSM route sets from the database, keyed by IFOPT.
/// Returns:
/// - route_sets: IFOPT -> set of RouteIdentifiers (for definitive match testing)
/// - directional_routes: IFOPT -> set of OSM route osm_ids (for direction disambiguation)
///
/// This is the legacy version that only returns stops with IFOPT codes.
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

/// Unique key for an OSM stop (osm_id + osm_type).
/// Used as HashMap key for the universal mapping algorithm.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct OsmStopKey {
    pub(crate) osm_id: i64,
    pub(crate) osm_type: String,
}

impl std::fmt::Display for OsmStopKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}", self.osm_type, self.osm_id)
    }
}

/// Bulk-load OSM route sets from the database, keyed by OSM stop ID.
/// Works with ALL stops (including those without IFOPT codes).
/// Returns:
/// - route_sets: OsmStopKey -> set of RouteIdentifiers
/// - directional_routes: OsmStopKey -> set of OSM route osm_ids
pub(crate) async fn load_osm_route_sets_by_osm_id(
    pool: &PgPool,
) -> Result<
    (
        HashMap<OsmStopKey, HashSet<RouteIdentifier>>,
        HashMap<OsmStopKey, HashSet<i64>>,
    ),
    GtfsError,
> {
    // Load route sets for platforms
    let platform_rows: Vec<(i64, String, String, i64)> = sqlx::query_as(
        r#"
        SELECT DISTINCT
            p.osm_id AS stop_osm_id,
            r.ref AS line_ref,
            r.route_type,
            r.osm_id AS route_osm_id
        FROM route_stops rs
        JOIN routes r ON r.osm_id = rs.route_id
        JOIN platforms p ON p.osm_id = rs.platform_id
        WHERE r.ref IS NOT NULL
        "#,
    )
    .fetch_all(pool)
    .await?;

    // Load route sets for stop positions
    let stop_rows: Vec<(i64, String, String, i64)> = sqlx::query_as(
        r#"
        SELECT DISTINCT
            sp.osm_id AS stop_osm_id,
            r.ref AS line_ref,
            r.route_type,
            r.osm_id AS route_osm_id
        FROM route_stops rs
        JOIN routes r ON r.osm_id = rs.route_id
        JOIN stop_positions sp ON sp.osm_id = rs.stop_position_id
        WHERE r.ref IS NOT NULL
        "#,
    )
    .fetch_all(pool)
    .await?;

    let mut route_sets: HashMap<OsmStopKey, HashSet<RouteIdentifier>> = HashMap::new();
    let mut directional_routes: HashMap<OsmStopKey, HashSet<i64>> = HashMap::new();

    for (stop_osm_id, line_ref, route_type, route_osm_id) in platform_rows {
        let key = OsmStopKey {
            osm_id: stop_osm_id,
            osm_type: "platform".to_string(),
        };
        let transport_type = transport_type_from_route(&route_type);
        route_sets
            .entry(key.clone())
            .or_default()
            .insert(RouteIdentifier {
                line_ref,
                transport_type,
            });
        directional_routes
            .entry(key)
            .or_default()
            .insert(route_osm_id);
    }

    for (stop_osm_id, line_ref, route_type, route_osm_id) in stop_rows {
        let key = OsmStopKey {
            osm_id: stop_osm_id,
            osm_type: "stop_position".to_string(),
        };
        let transport_type = transport_type_from_route(&route_type);
        route_sets
            .entry(key.clone())
            .or_default()
            .insert(RouteIdentifier {
                line_ref,
                transport_type,
            });
        directional_routes
            .entry(key)
            .or_default()
            .insert(route_osm_id);
    }

    info!(
        stops_with_routes = route_sets.len(),
        "Loaded OSM route sets by osm_id for matching"
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

/// Load OSM route destination names per OSM stop ID.
/// Works with ALL stops including those without IFOPT.
/// Returns OsmStopKey -> set of normalized destination keywords.
pub(crate) async fn load_osm_destinations_by_osm_id(
    pool: &PgPool,
) -> Result<HashMap<OsmStopKey, HashSet<String>>, GtfsError> {
    // Platforms
    let platform_rows: Vec<(i64, String)> = sqlx::query_as(
        r#"
        SELECT DISTINCT
            p.osm_id AS stop_osm_id,
            r.name AS route_name
        FROM route_stops rs
        JOIN routes r ON r.osm_id = rs.route_id
        JOIN platforms p ON p.osm_id = rs.platform_id
        WHERE r.name IS NOT NULL
        "#,
    )
    .fetch_all(pool)
    .await?;

    // Stop positions
    let stop_rows: Vec<(i64, String)> = sqlx::query_as(
        r#"
        SELECT DISTINCT
            sp.osm_id AS stop_osm_id,
            r.name AS route_name
        FROM route_stops rs
        JOIN routes r ON r.osm_id = rs.route_id
        JOIN stop_positions sp ON sp.osm_id = rs.stop_position_id
        WHERE r.name IS NOT NULL
        "#,
    )
    .fetch_all(pool)
    .await?;

    let mut result: HashMap<OsmStopKey, HashSet<String>> = HashMap::new();

    let process_row = |result: &mut HashMap<OsmStopKey, HashSet<String>>, key: OsmStopKey, route_name: &str| {
        if let Some(arrow_pos) = route_name.find("=>") {
            let dest = route_name[arrow_pos + 2..].trim();
            for word in dest.split_whitespace() {
                let normalized = word
                    .trim_matches(|c: char| !c.is_alphanumeric())
                    .to_lowercase();
                if normalized.len() >= 3 {
                    result.entry(key.clone()).or_default().insert(normalized);
                }
            }
        }
    };

    for (osm_id, route_name) in &platform_rows {
        let key = OsmStopKey {
            osm_id: *osm_id,
            osm_type: "platform".to_string(),
        };
        process_row(&mut result, key, route_name);
    }

    for (osm_id, route_name) in &stop_rows {
        let key = OsmStopKey {
            osm_id: *osm_id,
            osm_type: "stop_position".to_string(),
        };
        process_row(&mut result, key, route_name);
    }

    info!(
        stops_with_destinations = result.len(),
        "Loaded OSM route destinations by osm_id for direction matching"
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

    // Insert proximity stop IDs into a staging table for efficient joining
    // (not TEMP table — sqlx connection pool doesn't guarantee same connection)
    sqlx::query("DROP TABLE IF EXISTS _proximity_stops").execute(pool).await?;
    sqlx::query("CREATE TABLE _proximity_stops (stop_id TEXT PRIMARY KEY)")
        .execute(pool).await?;

    for batch in stop_ids.chunks(10_000) {
        let batch_vec: Vec<&str> = batch.to_vec();
        sqlx::query("INSERT INTO _proximity_stops (stop_id) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING")
            .bind(&batch_vec)
            .execute(pool).await?;
    }

    // Create index for efficient join
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_proximity_stops ON _proximity_stops(stop_id)")
        .execute(pool).await?;

    // Use a subquery with LATERAL to limit per-stop results and avoid exploding result sets
    let rows: Vec<(String, String, i32)> = sqlx::query_as(
        r#"
        SELECT DISTINCT st.stop_id, gr.route_short_name, gr.route_type
        FROM _proximity_stops ps
        JOIN gtfs_stop_times st ON st.stop_id = ps.stop_id
        JOIN gtfs_trips gt ON gt.trip_id = st.trip_id
        JOIN gtfs_routes gr ON gr.route_id = gt.route_id
        WHERE gr.route_short_name IS NOT NULL
        "#,
    )
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

    let _ = sqlx::query("DROP TABLE IF EXISTS _proximity_stops").execute(pool).await;

    info!(
        gtfs_stops_with_routes = result.len(),
        "Loaded GTFS route sets for matching"
    );
    Ok(result)
}

/// A single resolved stop mapping result, used for writing to both tables.
struct StopMappingResult {
    osm_id: i64,
    osm_type: String,
    gtfs_stop_id: String,
    ref_ifopt: Option<String>,
    match_method: String,
    match_score: f64,
}

/// Build the OSM <-> GTFS stop mapping and store it in PostgreSQL.
///
/// Route-based matching algorithm:
/// 1. Load all OSM routes with their stops (from `route_stops`)
/// 2. Find matching GTFS routes by ref + transport type
/// 3. For each OSM route, get its GTFS route's stops
/// 4. Match OSM stops to GTFS stops by nearest distance within the same route
///
/// This is O(routes × stops_per_route) — fast because each route has few stops.
///
/// Results are written to:
/// - `osm_gtfs_stop_mapping` (universal table, keyed by osm_id)
/// - `ifopt_gtfs_mapping` (legacy table, keyed by IFOPT — for backward compatibility)
///
/// Returns mapping statistics for issue reporting.
pub(crate) async fn build_ifopt_mapping_to_db(
    pool: &PgPool,
    osm_stops: &[OsmStopInfo],
) -> Result<MappingStats, GtfsError> {
    /// Maximum rows per batch for bulk INSERT into PostgreSQL.
    /// sqlx has a ~65535 parameter limit; osm_gtfs_stop_mapping has 7 columns -> max ~9000 rows.
    const DB_BATCH_SIZE: usize = 5_000;

    let total_start = std::time::Instant::now();

    // --- Step 0: Count GTFS leaf stops for stats ---
    let total_gtfs_stops: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(DISTINCT s.stop_id)
        FROM gtfs_stops s
        WHERE (s.parent_station IS NOT NULL
               OR s.stop_id IN (SELECT DISTINCT stop_id FROM gtfs_stop_times))
          AND s.lat IS NOT NULL AND s.lon IS NOT NULL
        "#,
    )
    .fetch_one(pool)
    .await?;
    let total_gtfs_stops = total_gtfs_stops as usize;

    info!(
        osm_stops = osm_stops.len(),
        total_gtfs_stops,
        "Starting route-based IFOPT mapping"
    );

    // --- Step 1: Preserve manual mappings ---
    let manual_ifopt_rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT ifopt, gtfs_stop_id FROM ifopt_gtfs_mapping WHERE is_manual = TRUE",
    )
    .fetch_all(pool)
    .await?;
    let manual_ifopts: HashSet<String> = manual_ifopt_rows.iter().map(|(i, _)| i.clone()).collect();

    let manual_osm_rows: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT osm_id, osm_type, gtfs_stop_id FROM osm_gtfs_stop_mapping WHERE is_manual = TRUE",
    )
    .fetch_all(pool)
    .await?;
    let manual_osm_keys: HashSet<OsmStopKey> = manual_osm_rows
        .iter()
        .map(|(id, tp, _)| OsmStopKey {
            osm_id: *id,
            osm_type: tp.clone(),
        })
        .collect();

    let manual_count = manual_ifopts.len() + manual_osm_keys.len();
    if manual_count > 0 {
        info!(
            manual_ifopt = manual_ifopts.len(),
            manual_osm = manual_osm_keys.len(),
            "Preserving manual mappings"
        );
    }

    // --- Step 2: Load OSM route->stop relationships ---
    // Each row: (osm_route_id, route_ref, route_type, stop_osm_id, stop_osm_type, stop_lat, stop_lon)
    info!("Loading OSM route->stop relationships...");
    let osm_route_stop_rows: Vec<(i64, String, String, i64, String, f64, f64)> = sqlx::query_as(
        r#"
        SELECT
            r.osm_id AS route_osm_id,
            r.ref AS route_ref,
            r.route_type,
            p.osm_id AS stop_osm_id,
            'platform' AS stop_osm_type,
            p.lat, p.lon
        FROM route_stops rs
        JOIN routes r ON r.osm_id = rs.route_id
        JOIN platforms p ON p.osm_id = rs.platform_id
        WHERE r.ref IS NOT NULL AND p.lat IS NOT NULL AND p.lon IS NOT NULL
        UNION ALL
        SELECT
            r.osm_id AS route_osm_id,
            r.ref AS route_ref,
            r.route_type,
            sp.osm_id AS stop_osm_id,
            'stop_position' AS stop_osm_type,
            sp.lat, sp.lon
        FROM route_stops rs
        JOIN routes r ON r.osm_id = rs.route_id
        JOIN stop_positions sp ON sp.osm_id = rs.stop_position_id
        WHERE r.ref IS NOT NULL AND sp.lat IS NOT NULL AND sp.lon IS NOT NULL
        "#,
    )
    .fetch_all(pool)
    .await?;

    // Group OSM stops by route key (ref, transport_type)
    // Each entry: list of (osm_id, osm_type, lat, lon)
    struct OsmRouteStop {
        osm_id: i64,
        osm_type: String,
        lat: f64,
        lon: f64,
    }

    let mut osm_routes_grouped: HashMap<RouteIdentifier, Vec<OsmRouteStop>> = HashMap::new();
    let mut osm_stop_seen: HashSet<(i64, String, String, TransportType)> = HashSet::new();

    for (_, route_ref, route_type, stop_osm_id, stop_osm_type, lat, lon) in &osm_route_stop_rows {
        let transport_type = transport_type_from_route(route_type);
        let route_key = RouteIdentifier {
            line_ref: route_ref.clone(),
            transport_type,
        };
        // Deduplicate: same stop can appear multiple times on the same logical route
        // (e.g. from multiple OSM route relations for same line+direction)
        if osm_stop_seen.insert((*stop_osm_id, stop_osm_type.clone(), route_ref.clone(), transport_type)) {
            osm_routes_grouped.entry(route_key).or_default().push(OsmRouteStop {
                osm_id: *stop_osm_id,
                osm_type: stop_osm_type.clone(),
                lat: *lat,
                lon: *lon,
            });
        }
    }

    info!(
        osm_route_keys = osm_routes_grouped.len(),
        osm_route_stop_rows = osm_route_stop_rows.len(),
        "Loaded OSM route->stop relationships"
    );

    // --- Step 3: Load GTFS route->stop relationships ---
    info!("Loading GTFS route->stop relationships...");
    let gtfs_route_stop_rows: Vec<(String, String, i32, String, Option<String>, f64, f64)> = sqlx::query_as(
        r#"
        SELECT DISTINCT
            gr.route_id,
            gr.route_short_name,
            gr.route_type,
            gs.stop_id,
            gs.stop_name,
            gs.lat,
            gs.lon
        FROM gtfs_stop_times st
        JOIN gtfs_trips gt ON gt.trip_id = st.trip_id
        JOIN gtfs_routes gr ON gr.route_id = gt.route_id
        JOIN gtfs_stops gs ON gs.stop_id = st.stop_id
        JOIN gtfs_calendar gc ON gc.service_id = gt.service_id
        WHERE gr.route_short_name IS NOT NULL
          AND gs.lat IS NOT NULL AND gs.lon IS NOT NULL
          AND gc.start_date <= CURRENT_DATE AND gc.end_date >= CURRENT_DATE
        "#,
    )
    .fetch_all(pool)
    .await?;

    struct GtfsRouteStop {
        stop_id: String,
        #[allow(dead_code)]
        stop_name: Option<String>,
        lat: f64,
        lon: f64,
    }

    let mut gtfs_routes_grouped: HashMap<RouteIdentifier, Vec<GtfsRouteStop>> = HashMap::new();
    let mut gtfs_stop_seen: HashSet<(String, String, TransportType)> = HashSet::new();

    for (_, route_short_name, route_type, stop_id, stop_name, lat, lon) in &gtfs_route_stop_rows {
        let transport_type = TransportType::from_gtfs_route_type(*route_type);
        let route_key = RouteIdentifier {
            line_ref: route_short_name.clone(),
            transport_type,
        };
        if gtfs_stop_seen.insert((stop_id.clone(), route_short_name.clone(), transport_type)) {
            gtfs_routes_grouped.entry(route_key).or_default().push(GtfsRouteStop {
                stop_id: stop_id.clone(),
                stop_name: stop_name.clone(),
                lat: *lat,
                lon: *lon,
            });
        }
    }

    info!(
        gtfs_route_keys = gtfs_routes_grouped.len(),
        gtfs_route_stop_rows = gtfs_route_stop_rows.len(),
        "Loaded GTFS route->stop relationships"
    );

    // --- Step 4: Match stops within each route pair ---
    info!("Matching OSM stops to GTFS stops per route...");

    // mapping_results: OsmStopKey -> (gtfs_stop_id, match_method, distance_meters)
    // We store distance so that if a stop appears on multiple routes, we keep the closest match.
    let mut mapping_results: HashMap<OsmStopKey, (String, String, f64)> = HashMap::new();
    let mut ifopt_mapping_results: HashMap<String, String> = HashMap::new();
    let mut matched_gtfs_ids: HashSet<String> = HashSet::new();

    // Build OSM stop info lookup for IFOPT resolution
    let osm_stop_info_map: HashMap<(i64, &str), &OsmStopInfo> = osm_stops
        .iter()
        .map(|s| ((s.osm_id, s.osm_type.as_str()), s))
        .collect();

    let max_distance_deg = MAX_DISTANCE_METERS / 111_000.0;
    let mut routes_matched = 0usize;
    let mut routes_unmatched = 0usize;

    for (route_key, osm_stops_on_route) in &osm_routes_grouped {
        let gtfs_stops_on_route = match gtfs_routes_grouped.get(route_key) {
            Some(stops) => stops,
            None => {
                routes_unmatched += 1;
                continue;
            }
        };
        routes_matched += 1;

        // For each OSM stop on this route, find the nearest GTFS stop on the same route
        for osm_stop in osm_stops_on_route {
            let stop_key = OsmStopKey {
                osm_id: osm_stop.osm_id,
                osm_type: osm_stop.osm_type.clone(),
            };

            // Skip manual mappings
            if manual_osm_keys.contains(&stop_key) {
                continue;
            }
            // Check IFOPT manual too
            let osm_info = osm_stop_info_map.get(&(osm_stop.osm_id, osm_stop.osm_type.as_str()));
            if let Some(info) = osm_info {
                if let Some(ref ifopt) = info.ifopt {
                    if manual_ifopts.contains(ifopt) {
                        continue;
                    }
                }
            }

            // Find nearest GTFS stop within MAX_DISTANCE_METERS
            let mut best_gtfs: Option<(&GtfsRouteStop, f64)> = None;
            for gtfs_stop in gtfs_stops_on_route {
                let dlat = osm_stop.lat - gtfs_stop.lat;
                let dlon = (osm_stop.lon - gtfs_stop.lon) * osm_stop.lat.to_radians().cos();
                let dist_deg = (dlat * dlat + dlon * dlon).sqrt();

                if dist_deg > max_distance_deg {
                    continue;
                }
                let distance_meters = dist_deg * 111_000.0;

                if best_gtfs.is_none() || distance_meters < best_gtfs.unwrap().1 {
                    best_gtfs = Some((gtfs_stop, distance_meters));
                }
            }

            if let Some((gtfs_stop, distance_meters)) = best_gtfs {
                // Only update if this is a closer match than a previous route's match
                let should_update = match mapping_results.get(&stop_key) {
                    Some((_, _, prev_dist)) => distance_meters < *prev_dist,
                    None => true,
                };

                if should_update {
                    let method = if osm_info.and_then(|i| i.ifopt.as_ref()).is_some() {
                        "ifopt"
                    } else {
                        "geographic"
                    };
                    mapping_results.insert(
                        stop_key.clone(),
                        (gtfs_stop.stop_id.clone(), method.to_string(), distance_meters),
                    );
                    matched_gtfs_ids.insert(gtfs_stop.stop_id.clone());

                    if let Some(info) = osm_info {
                        if let Some(ref ifopt) = info.ifopt {
                            ifopt_mapping_results.insert(ifopt.clone(), gtfs_stop.stop_id.clone());
                        }
                    }
                }
            }
        }
    }

    info!(
        routes_matched,
        routes_unmatched,
        stop_matches = mapping_results.len(),
        elapsed_ms = total_start.elapsed().as_millis() as u64,
        "Route-based matching complete"
    );

    let matched = mapping_results.len();

    // --- Step 5: Build unmatched lists ---
    // Build set of matched OSM stop keys for quick lookup
    let matched_osm_keys: HashSet<&OsmStopKey> = mapping_results.keys().collect();

    let unmatched_osm: Vec<UnmatchedOsmStop> = osm_stops
        .iter()
        .filter(|s| {
            let key = OsmStopKey {
                osm_id: s.osm_id,
                osm_type: s.osm_type.clone(),
            };
            !matched_osm_keys.contains(&key)
                && !manual_osm_keys.contains(&key)
                && !s.ifopt.as_ref().map_or(false, |i| manual_ifopts.contains(i))
        })
        .map(|s| {
            // Determine reason: does this stop appear on any OSM route?
            let on_route = osm_routes_grouped.values().any(|stops| {
                stops.iter().any(|rs| rs.osm_id == s.osm_id && rs.osm_type == s.osm_type)
            });
            let reason = if !on_route {
                UnmatchedReason::NoRouteData
            } else {
                UnmatchedReason::NoDefinitiveCandidate
            };
            UnmatchedOsmStop {
                osm_id: s.osm_id,
                osm_type: s.osm_type.clone(),
                ifopt: s.ifopt.clone(),
                name: s.name.clone(),
                lat: s.lat,
                lon: s.lon,
                candidates: vec![],
                reason,
            }
        })
        .collect();

    // Collect all matched GTFS IDs (auto + manual)
    let manual_gtfs_ids: HashSet<String> = manual_ifopt_rows
        .iter()
        .map(|(_, g)| g.clone())
        .chain(manual_osm_rows.iter().map(|(_, _, g)| g.clone()))
        .collect();

    let all_matched_gtfs: HashSet<&str> = matched_gtfs_ids
        .iter()
        .map(|s| s.as_str())
        .chain(manual_gtfs_ids.iter().map(|s| s.as_str()))
        .collect();

    // For unmatched GTFS, query leaf stops that were not matched
    let unmatched_gtfs_rows: Vec<(String, Option<String>, f64, f64)> = sqlx::query_as(
        r#"
        SELECT s.stop_id, s.stop_name, s.lat, s.lon
        FROM gtfs_stops s
        WHERE (s.parent_station IS NOT NULL
               OR s.stop_id IN (SELECT DISTINCT stop_id FROM gtfs_stop_times))
          AND s.lat IS NOT NULL AND s.lon IS NOT NULL
        "#,
    )
    .fetch_all(pool)
    .await?;

    let unmatched_gtfs: Vec<UnmatchedGtfsStop> = unmatched_gtfs_rows
        .iter()
        .filter(|(id, _, _, _)| !all_matched_gtfs.contains(id.as_str()))
        .map(|(id, name, lat, lon)| UnmatchedGtfsStop {
            gtfs_stop_id: id.clone(),
            gtfs_stop_name: name.clone(),
            lat: *lat,
            lon: *lon,
        })
        .collect();

    // --- Step 6: Write to ifopt_gtfs_mapping (legacy) ---
    sqlx::query("DELETE FROM ifopt_gtfs_mapping WHERE is_manual = FALSE")
        .execute(pool)
        .await?;

    let ifopt_entries: Vec<_> = ifopt_mapping_results.iter().collect();
    for batch in ifopt_entries.chunks(DB_BATCH_SIZE) {
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO ifopt_gtfs_mapping (ifopt, gtfs_stop_id, combined_score, is_manual) ",
        );
        qb.push_values(batch.iter(), |mut b, (ifopt, gtfs_stop_id)| {
            b.push_bind(ifopt.as_str())
                .push_bind(gtfs_stop_id.as_str())
                .push_bind(1.0_f64)
                .push_bind(false);
        });
        qb.build().execute(pool).await?;
    }

    info!(
        ifopt_mappings = ifopt_mapping_results.len(),
        "Written IFOPT mappings to legacy ifopt_gtfs_mapping table"
    );

    // --- Step 7: Write to osm_gtfs_stop_mapping ---
    sqlx::query("DELETE FROM osm_gtfs_stop_mapping WHERE is_manual = FALSE")
        .execute(pool)
        .await?;

    // Build the OSM stop -> IFOPT lookup for populating ref_ifopt
    let osm_id_to_ifopt: HashMap<OsmStopKey, String> = osm_stops
        .iter()
        .filter_map(|s| {
            s.ifopt.as_ref().map(|ifopt| {
                (
                    OsmStopKey {
                        osm_id: s.osm_id,
                        osm_type: s.osm_type.clone(),
                    },
                    ifopt.clone(),
                )
            })
        })
        .collect();

    let osm_mapping_entries: Vec<StopMappingResult> = mapping_results
        .iter()
        .map(|(key, (gtfs_stop_id, method, score))| {
            let ref_ifopt = osm_id_to_ifopt.get(key).cloned();
            StopMappingResult {
                osm_id: key.osm_id,
                osm_type: key.osm_type.clone(),
                gtfs_stop_id: gtfs_stop_id.clone(),
                ref_ifopt,
                match_method: method.clone(),
                match_score: *score,
            }
        })
        .collect();

    for batch in osm_mapping_entries.chunks(DB_BATCH_SIZE) {
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO osm_gtfs_stop_mapping (osm_id, osm_type, gtfs_stop_id, ref_ifopt, match_method, match_score, is_manual) ",
        );
        qb.push_values(batch.iter(), |mut b, entry| {
            b.push_bind(entry.osm_id)
                .push_bind(&entry.osm_type)
                .push_bind(&entry.gtfs_stop_id)
                .push_bind(&entry.ref_ifopt)
                .push_bind(&entry.match_method)
                .push_bind(entry.match_score)
                .push_bind(false);
        });
        qb.push(" ON CONFLICT (osm_id, osm_type) DO UPDATE SET gtfs_stop_id = EXCLUDED.gtfs_stop_id, ref_ifopt = EXCLUDED.ref_ifopt, match_method = EXCLUDED.match_method, match_score = EXCLUDED.match_score, is_manual = EXCLUDED.is_manual");
        qb.build().execute(pool).await?;
    }

    info!(
        osm_mappings = osm_mapping_entries.len(),
        "Written mappings to osm_gtfs_stop_mapping table"
    );

    // Update mapping count in feed metadata
    let total_mapping_count = mapping_results.len() + manual_count;
    sqlx::query("UPDATE gtfs_feed_meta SET mapping_count = $1 WHERE id = 1")
        .bind(total_mapping_count as i64)
        .execute(pool)
        .await?;

    info!(
        osm_stops = osm_stops.len(),
        total_gtfs_stops,
        matched,
        ifopt_matched = ifopt_mapping_results.len(),
        manual_preserved = manual_count,
        unmatched_osm = unmatched_osm.len(),
        unmatched_gtfs = unmatched_gtfs.len(),
        elapsed_ms = total_start.elapsed().as_millis() as u64,
        "Built and stored OSM <-> GTFS stop mapping (route-based)"
    );

    Ok(MappingStats {
        total_db_stops: osm_stops.len(),
        total_gtfs_stops,
        matched,
        manual_count,
        unmatched_osm,
        unmatched_gtfs,
    })
}

/// Build OSM route <-> GTFS route mapping and store in PostgreSQL.
///
/// Matches by:
/// 1. `route_short_name = ref` (exact string match)
/// 2. Compatible transport type (GTFS route_type maps to OSM route_type)
/// 3. Stop overlap verification: OSM route's mapped stops overlap with GTFS route's stops
///
/// Writes results to `osm_gtfs_route_mapping`.
pub(crate) async fn build_route_mapping_to_db(
    pool: &PgPool,
) -> Result<usize, GtfsError> {
    /// Maximum rows per batch for bulk INSERT.
    const DB_BATCH_SIZE: usize = 10_000;

    info!("Building OSM route <-> GTFS route mapping...");
    let route_start = std::time::Instant::now();

    // Load OSM routes with their ref and route_type
    let osm_routes: Vec<(i64, String, String)> = sqlx::query_as(
        r#"
        SELECT osm_id, ref, route_type
        FROM routes
        WHERE ref IS NOT NULL
        "#,
    )
    .fetch_all(pool)
    .await?;

    // Load GTFS routes
    let gtfs_routes: Vec<(String, Option<String>, Option<i32>)> = sqlx::query_as(
        r#"
        SELECT route_id, route_short_name, route_type
        FROM gtfs_routes
        WHERE route_short_name IS NOT NULL
        "#,
    )
    .fetch_all(pool)
    .await?;

    info!(
        osm_routes = osm_routes.len(),
        gtfs_routes = gtfs_routes.len(),
        "Loaded routes for mapping"
    );

    // Build GTFS route lookup: (route_short_name, transport_type) -> Vec<route_id>
    let mut gtfs_by_ref: HashMap<(String, TransportType), Vec<String>> = HashMap::new();
    for (route_id, short_name, route_type) in &gtfs_routes {
        if let Some(ref name) = short_name {
            let tt = route_type.map(|rt| TransportType::from_gtfs_route_type(rt)).unwrap_or(TransportType::Unknown);
            gtfs_by_ref
                .entry((name.clone(), tt))
                .or_default()
                .push(route_id.clone());
        }
    }

    // For each OSM route, find candidate GTFS routes by ref + transport type
    struct RouteMatch {
        osm_route_id: i64,
        gtfs_route_id: String,
        match_method: String,
        match_score: f64,
    }

    let mut route_matches: Vec<RouteMatch> = Vec::new();

    // Load the stop mapping for overlap verification
    let stop_mapping_rows: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT osm_id, osm_type, gtfs_stop_id FROM osm_gtfs_stop_mapping",
    )
    .fetch_all(pool)
    .await?;

    // osm_stop_id -> set of gtfs_stop_ids
    let mut osm_to_gtfs_stops: HashMap<i64, HashSet<String>> = HashMap::new();
    for (osm_id, _osm_type, gtfs_stop_id) in &stop_mapping_rows {
        osm_to_gtfs_stops
            .entry(*osm_id)
            .or_default()
            .insert(gtfs_stop_id.clone());
    }

    // Load which OSM stops belong to each OSM route
    let route_stop_rows: Vec<(i64, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT route_id, stop_position_id, platform_id FROM route_stops",
    )
    .fetch_all(pool)
    .await?;

    // osm_route_id -> set of osm_stop_ids (both platforms and stop_positions)
    let mut route_osm_stops: HashMap<i64, HashSet<i64>> = HashMap::new();
    for (route_id, stop_pos_id, platform_id) in &route_stop_rows {
        let stops = route_osm_stops.entry(*route_id).or_default();
        if let Some(sp) = stop_pos_id {
            stops.insert(*sp);
        }
        if let Some(p) = platform_id {
            stops.insert(*p);
        }
    }

    // Load GTFS route -> set of gtfs_stop_ids
    let gtfs_route_stop_rows: Vec<(String, String)> = sqlx::query_as(
        r#"
        SELECT DISTINCT t.route_id, st.stop_id
        FROM gtfs_trips t
        JOIN gtfs_stop_times st ON st.trip_id = t.trip_id
        "#,
    )
    .fetch_all(pool)
    .await?;

    let mut gtfs_route_stops: HashMap<String, HashSet<String>> = HashMap::new();
    for (route_id, stop_id) in &gtfs_route_stop_rows {
        gtfs_route_stops
            .entry(route_id.clone())
            .or_default()
            .insert(stop_id.clone());
    }

    for (osm_route_id, osm_ref, osm_route_type) in &osm_routes {
        let osm_tt = transport_type_from_route(osm_route_type);

        // Find GTFS routes with same ref and compatible transport type
        let candidates = gtfs_by_ref.get(&(osm_ref.clone(), osm_tt));
        let Some(candidates) = candidates else {
            continue;
        };

        // Get OSM stop IDs on this route
        let osm_stop_ids = match route_osm_stops.get(osm_route_id) {
            Some(ids) => ids,
            None => continue,
        };

        // Map OSM stop IDs to GTFS stop IDs via osm_gtfs_stop_mapping
        let mapped_gtfs_stops: HashSet<String> = osm_stop_ids
            .iter()
            .flat_map(|osm_id| osm_to_gtfs_stops.get(osm_id).into_iter().flatten().cloned())
            .collect();

        if mapped_gtfs_stops.is_empty() {
            continue;
        }

        for gtfs_route_id in candidates {
            // Get GTFS stops on this route
            let gtfs_stops = match gtfs_route_stops.get(gtfs_route_id) {
                Some(stops) => stops,
                None => continue,
            };

            // Calculate stop overlap
            let overlap: usize = mapped_gtfs_stops.intersection(gtfs_stops).count();

            if overlap == 0 {
                continue;
            }

            // Score: fraction of mapped OSM stops that overlap with this GTFS route
            let score = overlap as f64 / mapped_gtfs_stops.len().max(1) as f64;

            // Require at least some meaningful overlap (>= 2 stops or 100% if few stops)
            if overlap < 2 && score < 1.0 {
                continue;
            }

            let method = if score >= 0.5 {
                "ref_match"
            } else {
                "stop_overlap"
            };

            route_matches.push(RouteMatch {
                osm_route_id: *osm_route_id,
                gtfs_route_id: gtfs_route_id.clone(),
                match_method: method.to_string(),
                match_score: score,
            });

            debug!(
                osm_route_id,
                gtfs_route_id,
                osm_ref,
                overlap,
                score,
                "Route match"
            );
        }
    }

    // Write to osm_gtfs_route_mapping
    sqlx::query("DELETE FROM osm_gtfs_route_mapping WHERE is_manual = FALSE")
        .execute(pool)
        .await?;

    let total_matches = route_matches.len();
    for batch in route_matches.chunks(DB_BATCH_SIZE) {
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO osm_gtfs_route_mapping (osm_route_id, gtfs_route_id, match_method, match_score, is_manual) ",
        );
        qb.push_values(batch.iter(), |mut b, m| {
            b.push_bind(m.osm_route_id)
                .push_bind(&m.gtfs_route_id)
                .push_bind(&m.match_method)
                .push_bind(m.match_score)
                .push_bind(false);
        });
        qb.push(" ON CONFLICT (osm_route_id, gtfs_route_id) DO UPDATE SET match_method = EXCLUDED.match_method, match_score = EXCLUDED.match_score, is_manual = EXCLUDED.is_manual");
        qb.build().execute(pool).await?;
    }

    info!(
        route_matches = total_matches,
        elapsed_secs = route_start.elapsed().as_secs(),
        "Built and stored OSM <-> GTFS route mapping"
    );

    Ok(total_matches)
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
