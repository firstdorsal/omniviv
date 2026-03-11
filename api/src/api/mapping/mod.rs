mod error;

pub use error::MappingError;

use std::collections::HashSet;

use axum::{extract::State, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tracing::info;
use utoipa::ToSchema;

#[derive(Clone)]
pub struct MappingState {
    pub pool: PgPool,
}

// --- Request/Response types ---

#[derive(Debug, Deserialize, ToSchema)]
pub struct SetMappingRequest {
    /// The IFOPT identifier of the OSM stop
    pub ifopt: String,
    /// The GTFS stop ID to map to
    pub gtfs_stop_id: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SetMappingResponse {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct RemoveMappingRequest {
    /// The IFOPT identifier to remove the manual mapping for
    pub ifopt: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RemoveMappingResponse {
    pub removed_count: u64,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct MappingStatusRequest {
    /// Only return unmapped IFOPTs
    #[serde(default)]
    pub unmapped_only: bool,
    /// Include nearby GTFS candidate stops for each entry
    #[serde(default)]
    pub include_candidates: bool,
    /// Filter by manual-only or auto-only mappings
    pub filter: Option<MappingFilter>,
    /// Case-insensitive search on IFOPT name or identifier
    pub search: Option<String>,
    /// Maximum number of entries to return (default: 50, max: 200)
    #[serde(default = "default_limit")]
    pub limit: usize,
    /// Offset for pagination
    #[serde(default)]
    pub offset: usize,
}

fn default_limit() -> usize {
    50
}

const MAX_LIMIT: usize = 200;

#[derive(Debug, Deserialize, ToSchema, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MappingFilter {
    Manual,
    Auto,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct MappingStatusResponse {
    /// Total number of OSM stops with IFOPT identifiers
    pub total_ifopt_count: usize,
    /// Number of IFOPTs that have a mapping (manual or auto)
    pub mapped_count: usize,
    /// Number of manually set mappings
    pub manual_count: usize,
    /// Number of auto-generated mappings
    pub auto_count: usize,
    /// Number of IFOPTs without any mapping
    pub unmapped_count: usize,
    /// Paginated list of mapping entries
    pub entries: Vec<MappingEntry>,
    /// Whether there are more entries after this page
    pub has_more: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct MappingEntry {
    /// IFOPT identifier
    pub ifopt: String,
    /// Name of the OSM stop (from platforms or stop_positions)
    pub name: Option<String>,
    /// Latitude of the OSM stop
    pub lat: f64,
    /// Longitude of the OSM stop
    pub lon: f64,
    /// Current mapping status
    pub status: MappingStatus,
    /// Current mapped GTFS stop ID (if mapped)
    pub gtfs_stop_id: Option<String>,
    /// Current mapped GTFS stop name (if mapped)
    pub gtfs_stop_name: Option<String>,
    /// Latitude of the mapped GTFS stop (if mapped)
    pub gtfs_stop_lat: Option<f64>,
    /// Longitude of the mapped GTFS stop (if mapped)
    pub gtfs_stop_lon: Option<f64>,
    /// Combined matching score (if auto-mapped)
    pub combined_score: Option<f64>,
    /// Nearby GTFS candidate stops (only if include_candidates is true)
    pub candidates: Vec<CandidateStop>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum MappingStatus {
    Unmapped,
    Auto,
    Manual,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CandidateStop {
    /// GTFS stop ID
    pub stop_id: String,
    /// GTFS stop name
    pub stop_name: Option<String>,
    /// Latitude
    pub lat: f64,
    /// Longitude
    pub lon: f64,
    /// Approximate distance in meters from the OSM stop
    pub distance_meters: f64,
}

// --- Endpoints ---

/// Set a manual IFOPT-to-GTFS stop mapping
///
/// Creates or replaces a mapping for the given IFOPT with a user-curated
/// GTFS stop assignment. Manual mappings are preserved across auto-rebuild cycles.
#[utoipa::path(
    post,
    path = "/api/mapping/set",
    request_body = SetMappingRequest,
    responses(
        (status = 200, description = "Mapping set successfully", body = SetMappingResponse),
        (status = 400, description = "Invalid request"),
        (status = 404, description = "GTFS stop not found"),
        (status = 500, description = "Internal server error")
    ),
    tag = "mapping"
)]
pub async fn set_mapping(
    State(state): State<MappingState>,
    Json(req): Json<SetMappingRequest>,
) -> Result<Json<SetMappingResponse>, MappingError> {
    let ifopt = req.ifopt.trim();
    let gtfs_stop_id = req.gtfs_stop_id.trim();

    if ifopt.is_empty() || gtfs_stop_id.is_empty() {
        return Err(MappingError::EmptyFields);
    }

    // Validate that the GTFS stop exists
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM gtfs_stops WHERE stop_id = $1)",
    )
    .bind(gtfs_stop_id)
    .fetch_one(&state.pool)
    .await?;

    if !exists {
        return Err(MappingError::GtfsStopNotFound(gtfs_stop_id.to_string()));
    }

    // Delete any existing mapping for this IFOPT (auto or manual)
    sqlx::query("DELETE FROM ifopt_gtfs_mapping WHERE ifopt = $1")
        .bind(ifopt)
        .execute(&state.pool)
        .await?;

    // Evict any other IFOPT that was using this GTFS stop (enforce 1:1)
    let evicted = sqlx::query_scalar::<_, String>(
        "DELETE FROM ifopt_gtfs_mapping WHERE gtfs_stop_id = $1 RETURNING ifopt",
    )
    .bind(gtfs_stop_id)
    .fetch_optional(&state.pool)
    .await?;

    if let Some(ref evicted_ifopt) = evicted {
        info!(
            evicted_ifopt = %evicted_ifopt,
            gtfs_stop_id,
            "Evicted existing mapping for GTFS stop"
        );
    }

    // Insert the manual mapping
    sqlx::query(
        "INSERT INTO ifopt_gtfs_mapping (ifopt, gtfs_stop_id, combined_score, is_manual) \
         VALUES ($1, $2, 1.0, TRUE)",
    )
    .bind(ifopt)
    .bind(gtfs_stop_id)
    .execute(&state.pool)
    .await?;

    info!(ifopt, gtfs_stop_id, "Manual IFOPT mapping set");

    let message = match evicted {
        Some(evicted_ifopt) => format!(
            "Mapped {ifopt} -> {gtfs_stop_id} (evicted previous mapping from {evicted_ifopt})"
        ),
        None => format!("Mapped {ifopt} -> {gtfs_stop_id}"),
    };

    Ok(Json(SetMappingResponse {
        success: true,
        message,
    }))
}

/// Remove a manual IFOPT-to-GTFS stop mapping
///
/// Only removes manual (user-curated) mappings. The IFOPT will be
/// re-matched automatically on the next auto-rebuild cycle.
#[utoipa::path(
    post,
    path = "/api/mapping/remove",
    request_body = RemoveMappingRequest,
    responses(
        (status = 200, description = "Mapping removed", body = RemoveMappingResponse),
        (status = 500, description = "Internal server error")
    ),
    tag = "mapping"
)]
pub async fn remove_mapping(
    State(state): State<MappingState>,
    Json(req): Json<RemoveMappingRequest>,
) -> Result<Json<RemoveMappingResponse>, MappingError> {
    let result = sqlx::query(
        "DELETE FROM ifopt_gtfs_mapping WHERE ifopt = $1 AND is_manual = TRUE",
    )
    .bind(&req.ifopt)
    .execute(&state.pool)
    .await?;

    let removed_count = result.rows_affected();
    if removed_count > 0 {
        info!(ifopt = %req.ifopt, "Manual IFOPT mapping removed");
    }

    Ok(Json(RemoveMappingResponse { removed_count }))
}

/// Get mapping status overview with optional candidates
///
/// Returns a summary of IFOPT-to-GTFS mapping statistics and a paginated
/// list of mapping entries. Each entry includes the OSM stop info, current
/// mapping status, and optionally nearby GTFS candidate stops.
#[utoipa::path(
    post,
    path = "/api/mapping/status",
    request_body = MappingStatusRequest,
    responses(
        (status = 200, description = "Mapping status overview", body = MappingStatusResponse),
        (status = 500, description = "Internal server error")
    ),
    tag = "mapping"
)]
pub async fn mapping_status(
    State(state): State<MappingState>,
    Json(req): Json<MappingStatusRequest>,
) -> Result<Json<MappingStatusResponse>, MappingError> {
    let limit = req.limit.min(MAX_LIMIT);

    // Get summary counts
    let counts: (i64, i64, i64) = sqlx::query_as(
        "SELECT \
            COALESCE(COUNT(*), 0), \
            COALESCE(SUM(CASE WHEN is_manual THEN 1 ELSE 0 END), 0), \
            COALESCE(SUM(CASE WHEN NOT is_manual THEN 1 ELSE 0 END), 0) \
         FROM ifopt_gtfs_mapping",
    )
    .fetch_one(&state.pool)
    .await?;

    let mapped_count = counts.0 as usize;
    let manual_count = counts.1 as usize;
    let auto_count = counts.2 as usize;

    // Get total IFOPT count from OSM stops (platforms + stop_positions with ref_ifopt)
    let total_ifopt_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT ref_ifopt) FROM ( \
            SELECT TRIM(ref_ifopt) AS ref_ifopt FROM platforms WHERE ref_ifopt IS NOT NULL \
            UNION \
            SELECT TRIM(ref_ifopt) AS ref_ifopt FROM stop_positions WHERE ref_ifopt IS NOT NULL \
         ) sub",
    )
    .fetch_one(&state.pool)
    .await?;

    let total_ifopt_count = total_ifopt_count as usize;
    let unmapped_count = total_ifopt_count.saturating_sub(mapped_count);

    // Build main query for OSM stops with IFOPT
    // We use platforms as the primary source, falling back to stop_positions
    let entries: Vec<MappingEntry> = if req.unmapped_only {
        fetch_unmapped_entries(&state.pool, &req.search, limit, req.offset, req.include_candidates).await?
    } else {
        fetch_all_entries(&state.pool, &req.search, &req.filter, limit, req.offset, req.include_candidates).await?
    };

    let has_more = entries.len() == limit;

    Ok(Json(MappingStatusResponse {
        total_ifopt_count,
        mapped_count,
        manual_count,
        auto_count,
        unmapped_count,
        entries,
        has_more,
    }))
}

/// Fetch entries for unmapped IFOPTs only
async fn fetch_unmapped_entries(
    pool: &PgPool,
    search: &Option<String>,
    limit: usize,
    offset: usize,
    include_candidates: bool,
) -> Result<Vec<MappingEntry>, MappingError> {
    // Get all distinct IFOPTs from OSM data that don't have a mapping
    // Platforms are prioritized over stop_positions (source_priority=1 vs 2)
    // TRIM() normalizes whitespace to prevent near-duplicate IFOPTs
    let mut qb = sqlx::QueryBuilder::new(
        "SELECT sub.ref_ifopt, sub.name, sub.lat, sub.lon FROM ( \
            SELECT DISTINCT ON (ref_ifopt) ref_ifopt, name, lat, lon \
            FROM ( \
                SELECT TRIM(ref_ifopt) AS ref_ifopt, name, lat, lon, 1 AS source_priority FROM platforms WHERE ref_ifopt IS NOT NULL \
                UNION ALL \
                SELECT TRIM(ref_ifopt) AS ref_ifopt, name, lat, lon, 2 AS source_priority FROM stop_positions WHERE ref_ifopt IS NOT NULL \
            ) all_stops \
            ORDER BY ref_ifopt, source_priority, name NULLS LAST \
         ) sub \
         WHERE sub.ref_ifopt NOT IN (SELECT ifopt FROM ifopt_gtfs_mapping)",
    );

    if let Some(term) = search {
        qb.push(" AND (sub.ref_ifopt ILIKE ");
        qb.push_bind(format!("%{term}%"));
        qb.push(" OR sub.name ILIKE ");
        qb.push_bind(format!("%{term}%"));
        qb.push(")");
    }

    qb.push(" ORDER BY sub.name NULLS LAST, sub.ref_ifopt");
    qb.push(" LIMIT ");
    qb.push_bind(limit as i64);
    qb.push(" OFFSET ");
    qb.push_bind(offset as i64);

    let rows: Vec<(String, Option<String>, f64, f64)> =
        qb.build_query_as().fetch_all(pool).await?;

    // Deduplicate rows
    let mut deduped_rows = Vec::with_capacity(rows.len());
    let mut seen_ifopts = HashSet::new();
    for row in rows {
        if seen_ifopts.insert(ifopt_dedup_key(&row.0)) {
            deduped_rows.push(row);
        }
    }

    // Batch-fetch candidates in a single query instead of N+1
    let candidates_per_entry = if include_candidates {
        let coordinates: Vec<(f64, f64)> = deduped_rows.iter().map(|(_, _, lat, lon)| (*lat, *lon)).collect();
        fetch_candidates_batch(pool, &coordinates).await?
    } else {
        (0..deduped_rows.len()).map(|_| Vec::new()).collect()
    };

    let entries = deduped_rows
        .into_iter()
        .zip(candidates_per_entry)
        .map(|((ifopt, name, lat, lon), candidates)| MappingEntry {
            ifopt,
            name,
            lat,
            lon,
            status: MappingStatus::Unmapped,
            gtfs_stop_id: None,
            gtfs_stop_name: None,
            gtfs_stop_lat: None,
            gtfs_stop_lon: None,
            combined_score: None,
            candidates,
        })
        .collect();

    Ok(entries)
}

/// Fetch all entries (mapped + unmapped) with optional filter
async fn fetch_all_entries(
    pool: &PgPool,
    search: &Option<String>,
    filter: &Option<MappingFilter>,
    limit: usize,
    offset: usize,
    include_candidates: bool,
) -> Result<Vec<MappingEntry>, MappingError> {
    // Get all distinct IFOPTs from OSM data with optional mapping info
    // Platforms are prioritized over stop_positions (source_priority=1 vs 2)
    // so that mapping lines connect to the platform indicators shown on the map.
    // TRIM() normalizes whitespace to prevent near-duplicate IFOPTs
    let mut qb = sqlx::QueryBuilder::new(
        "SELECT osm.ref_ifopt, osm.name, osm.lat, osm.lon, \
                m.gtfs_stop_id, gs.stop_name AS gtfs_stop_name, \
                gs.lat AS gtfs_lat, gs.lon AS gtfs_lon, \
                m.combined_score, m.is_manual \
         FROM ( \
            SELECT DISTINCT ON (ref_ifopt) ref_ifopt, name, lat, lon \
            FROM ( \
                SELECT TRIM(ref_ifopt) AS ref_ifopt, name, lat, lon, 1 AS source_priority FROM platforms WHERE ref_ifopt IS NOT NULL \
                UNION ALL \
                SELECT TRIM(ref_ifopt) AS ref_ifopt, name, lat, lon, 2 AS source_priority FROM stop_positions WHERE ref_ifopt IS NOT NULL \
            ) all_stops \
            ORDER BY ref_ifopt, source_priority, name NULLS LAST \
         ) osm \
         LEFT JOIN ifopt_gtfs_mapping m ON m.ifopt = osm.ref_ifopt \
         LEFT JOIN gtfs_stops gs ON gs.stop_id = m.gtfs_stop_id \
         WHERE TRUE",
    );

    // Apply filter
    match filter {
        Some(MappingFilter::Manual) => {
            qb.push(" AND m.is_manual = TRUE");
        }
        Some(MappingFilter::Auto) => {
            qb.push(" AND m.is_manual = FALSE AND m.ifopt IS NOT NULL");
        }
        None => {}
    }

    if let Some(term) = search {
        qb.push(" AND (osm.ref_ifopt ILIKE ");
        qb.push_bind(format!("%{term}%"));
        qb.push(" OR osm.name ILIKE ");
        qb.push_bind(format!("%{term}%"));
        qb.push(")");
    }

    qb.push(" ORDER BY osm.name NULLS LAST, osm.ref_ifopt");
    qb.push(" LIMIT ");
    qb.push_bind(limit as i64);
    qb.push(" OFFSET ");
    qb.push_bind(offset as i64);

    let rows: Vec<(
        String,
        Option<String>,
        f64,
        f64,
        Option<String>,
        Option<String>,
        Option<f64>,
        Option<f64>,
        Option<f64>,
        Option<bool>,
    )> = qb.build_query_as().fetch_all(pool).await?;

    // Deduplicate rows
    type AllEntryRow = (String, Option<String>, f64, f64, Option<String>, Option<String>, Option<f64>, Option<f64>, Option<f64>, Option<bool>);
    let mut deduped_rows: Vec<AllEntryRow> = Vec::with_capacity(rows.len());
    let mut seen_ifopts = HashSet::new();
    for row in rows {
        if seen_ifopts.insert(ifopt_dedup_key(&row.0)) {
            deduped_rows.push(row);
        }
    }

    // Batch-fetch candidates in a single query instead of N+1
    let candidates_per_entry = if include_candidates {
        let coordinates: Vec<(f64, f64)> = deduped_rows.iter().map(|r| (r.2, r.3)).collect();
        fetch_candidates_batch(pool, &coordinates).await?
    } else {
        (0..deduped_rows.len()).map(|_| Vec::new()).collect()
    };

    let entries = deduped_rows
        .into_iter()
        .zip(candidates_per_entry)
        .map(|((ifopt, name, lat, lon, gtfs_stop_id, gtfs_stop_name, gtfs_lat, gtfs_lon, combined_score, is_manual), candidates)| {
            let status = match is_manual {
                Some(true) => MappingStatus::Manual,
                Some(false) => MappingStatus::Auto,
                None => MappingStatus::Unmapped,
            };
            MappingEntry {
                ifopt,
                name,
                lat,
                lon,
                status,
                gtfs_stop_id,
                gtfs_stop_name,
                gtfs_stop_lat: gtfs_lat,
                gtfs_stop_lon: gtfs_lon,
                combined_score,
                candidates,
            }
        })
        .collect();

    Ok(entries)
}

/// ~200m bounding box deltas: ±0.002° lat, ±0.003° lon (at ~48° latitude)
const LAT_DELTA: f64 = 0.002;
const LON_DELTA: f64 = 0.003;

/// Compute the distance in meters between two coordinates (approximate)
fn distance_meters(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let dlat = (lat1 - lat2) * 111_000.0;
    let dlon = (lon1 - lon2) * 111_000.0 * lat1.to_radians().cos();
    (dlat * dlat + dlon * dlon).sqrt()
}

/// Fetch GTFS candidate stops for multiple coordinates in a single query.
///
/// Computes an overall bounding box covering all coordinates (with ~200m padding),
/// fetches all matching stops in one query, then distributes them to each coordinate
/// based on proximity. Returns candidates indexed by position in the input slice.
async fn fetch_candidates_batch(
    pool: &PgPool,
    coordinates: &[(f64, f64)],
) -> Result<Vec<Vec<CandidateStop>>, MappingError> {
    if coordinates.is_empty() {
        return Ok(Vec::new());
    }

    // Compute overall bounding box with padding
    let mut min_lat = f64::MAX;
    let mut max_lat = f64::MIN;
    let mut min_lon = f64::MAX;
    let mut max_lon = f64::MIN;
    for &(lat, lon) in coordinates {
        min_lat = min_lat.min(lat);
        max_lat = max_lat.max(lat);
        min_lon = min_lon.min(lon);
        max_lon = max_lon.max(lon);
    }
    min_lat -= LAT_DELTA;
    max_lat += LAT_DELTA;
    min_lon -= LON_DELTA;
    max_lon += LON_DELTA;

    // Single query fetching all candidate stops within the overall bounding box
    let all_stops: Vec<(String, Option<String>, f64, f64)> = sqlx::query_as(
        "SELECT s.stop_id, s.stop_name, s.lat, s.lon \
         FROM gtfs_stops s \
         WHERE s.lat IS NOT NULL AND s.lon IS NOT NULL \
           AND s.lat BETWEEN $1 AND $2 \
           AND s.lon BETWEEN $3 AND $4 \
           AND (s.parent_station IS NOT NULL \
                OR s.stop_id IN (SELECT DISTINCT stop_id FROM gtfs_stop_times WHERE stop_id = s.stop_id))",
    )
    .bind(min_lat)
    .bind(max_lat)
    .bind(min_lon)
    .bind(max_lon)
    .fetch_all(pool)
    .await?;

    // Distribute stops to each coordinate based on per-entry bounding box proximity
    let mut result = Vec::with_capacity(coordinates.len());
    for &(lat, lon) in coordinates {
        let entry_min_lat = lat - LAT_DELTA;
        let entry_max_lat = lat + LAT_DELTA;
        let entry_min_lon = lon - LON_DELTA;
        let entry_max_lon = lon + LON_DELTA;

        let mut candidates: Vec<CandidateStop> = all_stops
            .iter()
            .filter(|(_, _, slat, slon)| {
                *slat >= entry_min_lat
                    && *slat <= entry_max_lat
                    && *slon >= entry_min_lon
                    && *slon <= entry_max_lon
            })
            .map(|(stop_id, stop_name, slat, slon)| CandidateStop {
                stop_id: stop_id.clone(),
                stop_name: stop_name.clone(),
                lat: *slat,
                lon: *slon,
                distance_meters: distance_meters(lat, lon, *slat, *slon),
            })
            .collect();

        // Sort by distance and keep top 10, matching the original per-entry behavior
        candidates.sort_by(|a, b| a.distance_meters.partial_cmp(&b.distance_meters).unwrap());
        candidates.truncate(10);
        result.push(candidates);
    }

    Ok(result)
}

/// Build a deduplication key from an IFOPT identifier.
///
/// Handles inconsistent formats in OSM data where the same physical stop
/// may appear with different IFOPT segment counts, e.g.:
/// - `de:09761:770:0:e` (5 segments: country:region:stop:platform:quay)
/// - `de:09761:770:e`   (4 segments: missing platform number)
///
/// Both normalize to `de:09761:770:e` (station prefix + last segment).
fn ifopt_dedup_key(ifopt: &str) -> String {
    let parts: Vec<&str> = ifopt.split(':').collect();
    if parts.len() >= 4 {
        // Station prefix = first 3 segments, identifier = last segment
        let station = parts[..3].join(":");
        let last = parts[parts.len() - 1];
        format!("{station}:{last}")
    } else {
        ifopt.to_string()
    }
}

pub fn router(pool: PgPool) -> Router {
    let state = MappingState { pool };
    Router::new()
        .route("/set", post(set_mapping))
        .route("/remove", post(remove_mapping))
        .route("/status", post(mapping_status))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ifopt_dedup_key_normalizes_variants() {
        // 5-segment and 4-segment variants of the same stop should produce the same key
        assert_eq!(
            ifopt_dedup_key("de:09761:770:0:e"),
            ifopt_dedup_key("de:09761:770:e")
        );
        assert_eq!(ifopt_dedup_key("de:09761:770:0:e"), "de:09761:770:e");
        assert_eq!(ifopt_dedup_key("de:09761:770:e"), "de:09761:770:e");
    }

    #[test]
    fn test_ifopt_dedup_key_distinguishes_different_quays() {
        // Different quay identifiers at the same station must remain distinct
        assert_ne!(
            ifopt_dedup_key("de:09761:770:0:a"),
            ifopt_dedup_key("de:09761:770:0:e")
        );
    }

    #[test]
    fn test_ifopt_dedup_key_short_ifopt_unchanged() {
        // 3-segment or shorter IFOPTs are returned as-is
        assert_eq!(ifopt_dedup_key("de:09761:770"), "de:09761:770");
        assert_eq!(ifopt_dedup_key("de:09761"), "de:09761");
    }

    #[test]
    fn test_ifopt_dedup_key_4_segment_platform_level() {
        // 4-segment IFOPT (stop:platform) normalizes to station:platform
        assert_eq!(ifopt_dedup_key("de:09761:770:0"), "de:09761:770:0");
    }
}
