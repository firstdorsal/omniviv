mod error;

pub use error::MappingError;

use std::collections::HashSet;

use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use subtle::ConstantTimeEq;
use tracing::info;
use utoipa::ToSchema;

#[derive(Clone)]
pub struct MappingState {
    pub pool: PgPool,
}

// --- Request/Response types ---

#[derive(Debug, Deserialize, ToSchema)]
pub struct SetMappingRequest {
    /// The OSM ID of the stop (primary identifier for the new mapping system)
    pub osm_id: Option<i64>,
    /// The IFOPT identifier of the OSM stop (for backwards compatibility)
    pub ifopt: Option<String>,
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
    /// The OSM ID to remove the manual mapping for (primary identifier)
    pub osm_id: Option<i64>,
    /// The IFOPT identifier to remove the manual mapping for (backwards compatibility)
    pub ifopt: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RemoveMappingResponse {
    pub removed_count: u64,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct MappingStatusRequest {
    /// Only return unmapped OSM stops (those without a mapping in osm_gtfs_stop_mapping)
    #[serde(default)]
    pub unmapped_only: bool,
    /// Include nearby GTFS candidate stops for each entry
    #[serde(default)]
    pub include_candidates: bool,
    /// Filter by manual-only or auto-only mappings
    pub filter: Option<MappingFilter>,
    /// Case-insensitive search on IFOPT, name, or OSM ID
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
    /// Total number of OSM stops (platforms + stop_positions)
    pub total_osm_stop_count: usize,
    /// Total number of OSM stops with IFOPT identifiers (subset of total)
    pub total_ifopt_count: usize,
    /// Number of OSM stops that have a mapping (manual or auto) in osm_gtfs_stop_mapping
    pub mapped_count: usize,
    /// Number of manually set mappings
    pub manual_count: usize,
    /// Number of auto-generated mappings
    pub auto_count: usize,
    /// Number of OSM stops without any mapping
    pub unmapped_count: usize,
    /// Paginated list of mapping entries
    pub entries: Vec<MappingEntry>,
    /// Whether there are more entries after this page
    pub has_more: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct MappingEntry {
    /// OSM ID of the stop
    pub osm_id: i64,
    /// OSM type (platform or stop_position)
    pub osm_type: String,
    /// IFOPT identifier (if available)
    pub ifopt: Option<String>,
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
    /// Match method used (ifopt, geographic, manual)
    pub match_method: Option<String>,
    /// Matching score (if auto-mapped)
    pub match_score: Option<f64>,
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

/// Set a manual OSM-to-GTFS stop mapping
///
/// Creates or replaces a mapping for the given OSM stop (by osm_id or IFOPT)
/// with a user-curated GTFS stop assignment. Manual mappings are preserved
/// across auto-rebuild cycles. At least one of osm_id or ifopt must be provided.
/// Dual-writes to both osm_gtfs_stop_mapping and the legacy ifopt_gtfs_mapping table.
#[utoipa::path(
    post,
    path = "/api/mapping/set",
    request_body = SetMappingRequest,
    responses(
        (status = 200, description = "Mapping set successfully", body = SetMappingResponse),
        (status = 400, description = "Invalid request"),
        (status = 404, description = "GTFS stop or OSM stop not found"),
        (status = 500, description = "Internal server error")
    ),
    tag = "mapping"
)]
pub async fn set_mapping(
    State(state): State<MappingState>,
    Json(req): Json<SetMappingRequest>,
) -> Result<Json<SetMappingResponse>, MappingError> {
    let gtfs_stop_id = req.gtfs_stop_id.trim();
    let ifopt = req.ifopt.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let osm_id = req.osm_id;

    if osm_id.is_none() && ifopt.is_none() {
        return Err(MappingError::NoIdentifierProvided);
    }

    if gtfs_stop_id.is_empty() {
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

    // Resolve the OSM stop: we need osm_id, osm_type, and optionally ref_ifopt
    let (resolved_osm_id, resolved_osm_type, resolved_ifopt) = if let Some(oid) = osm_id {
        // Look up the OSM stop by osm_id (try platforms first, then stop_positions)
        let osm_stop: Option<(i64, String, Option<String>)> = sqlx::query_as(
            "SELECT osm_id, 'platform' AS osm_type, ref_ifopt FROM platforms WHERE osm_id = $1 \
             UNION ALL \
             SELECT osm_id, 'stop_position' AS osm_type, ref_ifopt FROM stop_positions WHERE osm_id = $1 \
             LIMIT 1",
        )
        .bind(oid)
        .fetch_optional(&state.pool)
        .await?;

        match osm_stop {
            Some((id, osm_type, ref_ifopt)) => {
                // Use provided ifopt if given, otherwise use the one from the OSM data
                let final_ifopt = ifopt.map(|s| s.to_string()).or(ref_ifopt);
                (id, osm_type, final_ifopt)
            }
            None => {
                // osm_id not found in platforms or stop_positions — still allow the mapping
                // Default to "platform" type; the caller knows the OSM ID
                let final_ifopt = ifopt.map(|s| s.to_string());
                (oid, "platform".to_string(), final_ifopt)
            }
        }
    } else if let Some(ifopt_val) = ifopt {
        // Only ifopt provided — look up the osm_id from platforms/stop_positions
        let osm_stop: Option<(i64, String, Option<String>)> = sqlx::query_as(
            "SELECT osm_id, 'platform' AS osm_type, ref_ifopt FROM platforms WHERE ref_ifopt = $1 \
             UNION ALL \
             SELECT osm_id, 'stop_position' AS osm_type, ref_ifopt FROM stop_positions WHERE ref_ifopt = $1 \
             ORDER BY osm_type LIMIT 1",
        )
        .bind(ifopt_val)
        .fetch_optional(&state.pool)
        .await?;

        match osm_stop {
            Some((id, osm_type, ref_ifopt)) => (id, osm_type, ref_ifopt),
            None => return Err(MappingError::OsmStopNotFoundForIfopt(ifopt_val.to_string())),
        }
    } else {
        // Both osm_id and ifopt are None — unreachable due to guard above
        return Err(MappingError::NoIdentifierProvided);
    };

    // --- Write to NEW table: osm_gtfs_stop_mapping ---

    // Delete any existing mapping for this OSM stop
    sqlx::query("DELETE FROM osm_gtfs_stop_mapping WHERE osm_id = $1 AND osm_type = $2")
        .bind(resolved_osm_id)
        .bind(&resolved_osm_type)
        .execute(&state.pool)
        .await?;

    // Evict any other OSM stop that was using this GTFS stop (enforce 1:1)
    let evicted_osm = sqlx::query_scalar::<_, i64>(
        "DELETE FROM osm_gtfs_stop_mapping WHERE gtfs_stop_id = $1 RETURNING osm_id",
    )
    .bind(gtfs_stop_id)
    .fetch_optional(&state.pool)
    .await?;

    if let Some(evicted_id) = evicted_osm {
        info!(
            evicted_osm_id = evicted_id,
            gtfs_stop_id,
            "Evicted existing osm_gtfs_stop_mapping for GTFS stop"
        );
    }

    // Insert the manual mapping into the new table
    sqlx::query(
        "INSERT INTO osm_gtfs_stop_mapping (osm_id, osm_type, gtfs_stop_id, ref_ifopt, match_method, match_score, is_manual) \
         VALUES ($1, $2, $3, $4, 'manual', 1.0, TRUE)",
    )
    .bind(resolved_osm_id)
    .bind(&resolved_osm_type)
    .bind(gtfs_stop_id)
    .bind(&resolved_ifopt)
    .execute(&state.pool)
    .await?;

    // --- Dual-write to OLD table: ifopt_gtfs_mapping (transition period) ---
    if let Some(ref ifopt_val) = resolved_ifopt {
        sqlx::query("DELETE FROM ifopt_gtfs_mapping WHERE ifopt = $1")
            .bind(ifopt_val)
            .execute(&state.pool)
            .await?;

        sqlx::query("DELETE FROM ifopt_gtfs_mapping WHERE gtfs_stop_id = $1")
            .bind(gtfs_stop_id)
            .execute(&state.pool)
            .await?;

        sqlx::query(
            "INSERT INTO ifopt_gtfs_mapping (ifopt, gtfs_stop_id, combined_score, is_manual) \
             VALUES ($1, $2, 1.0, TRUE)",
        )
        .bind(ifopt_val)
        .bind(gtfs_stop_id)
        .execute(&state.pool)
        .await?;
    }

    info!(
        osm_id = resolved_osm_id,
        osm_type = %resolved_osm_type,
        ifopt = ?resolved_ifopt,
        gtfs_stop_id,
        "Manual mapping set"
    );

    let identifier = resolved_ifopt
        .as_deref()
        .map(|i| format!("osm:{resolved_osm_id} (IFOPT: {i})"))
        .unwrap_or_else(|| format!("osm:{resolved_osm_id}"));

    let message = match evicted_osm {
        Some(evicted_id) => format!(
            "Mapped {identifier} -> {gtfs_stop_id} (evicted previous mapping from osm:{evicted_id})"
        ),
        None => format!("Mapped {identifier} -> {gtfs_stop_id}"),
    };

    Ok(Json(SetMappingResponse {
        success: true,
        message,
    }))
}

/// Remove a manual OSM-to-GTFS stop mapping
///
/// Only removes manual (user-curated) mappings. The stop will be
/// re-matched automatically on the next auto-rebuild cycle.
/// At least one of osm_id or ifopt must be provided.
/// Removes from both osm_gtfs_stop_mapping and the legacy ifopt_gtfs_mapping table.
#[utoipa::path(
    post,
    path = "/api/mapping/remove",
    request_body = RemoveMappingRequest,
    responses(
        (status = 200, description = "Mapping removed", body = RemoveMappingResponse),
        (status = 400, description = "Invalid request"),
        (status = 500, description = "Internal server error")
    ),
    tag = "mapping"
)]
pub async fn remove_mapping(
    State(state): State<MappingState>,
    Json(req): Json<RemoveMappingRequest>,
) -> Result<Json<RemoveMappingResponse>, MappingError> {
    let ifopt = req.ifopt.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let osm_id = req.osm_id;

    if osm_id.is_none() && ifopt.is_none() {
        return Err(MappingError::NoIdentifierProvided);
    }

    let mut total_removed: u64 = 0;

    if let Some(oid) = osm_id {
        // Remove from NEW table by osm_id
        let result = sqlx::query(
            "DELETE FROM osm_gtfs_stop_mapping WHERE osm_id = $1 AND is_manual = TRUE",
        )
        .bind(oid)
        .execute(&state.pool)
        .await?;
        total_removed += result.rows_affected();

        if result.rows_affected() > 0 {
            info!(osm_id = oid, "Manual mapping removed from osm_gtfs_stop_mapping");
        }

        // Also look up the ref_ifopt for this osm_id to dual-remove from legacy table
        let legacy_ifopt: Option<String> = sqlx::query_scalar(
            "SELECT COALESCE(ref_ifopt, '') FROM ( \
                SELECT ref_ifopt FROM platforms WHERE osm_id = $1 \
                UNION ALL \
                SELECT ref_ifopt FROM stop_positions WHERE osm_id = $1 \
                LIMIT 1 \
             ) sub",
        )
        .bind(oid)
        .fetch_optional(&state.pool)
        .await?;

        if let Some(ref legacy_ifopt_val) = legacy_ifopt {
            if !legacy_ifopt_val.is_empty() {
                sqlx::query(
                    "DELETE FROM ifopt_gtfs_mapping WHERE ifopt = $1 AND is_manual = TRUE",
                )
                .bind(legacy_ifopt_val)
                .execute(&state.pool)
                .await?;
            }
        }
    }

    if let Some(ifopt_val) = ifopt {
        // Remove from NEW table by ref_ifopt
        let result = sqlx::query(
            "DELETE FROM osm_gtfs_stop_mapping WHERE ref_ifopt = $1 AND is_manual = TRUE",
        )
        .bind(ifopt_val)
        .execute(&state.pool)
        .await?;
        total_removed += result.rows_affected();

        if result.rows_affected() > 0 {
            info!(ifopt = %ifopt_val, "Manual mapping removed from osm_gtfs_stop_mapping by IFOPT");
        }

        // Dual-remove from OLD table
        let legacy_result = sqlx::query(
            "DELETE FROM ifopt_gtfs_mapping WHERE ifopt = $1 AND is_manual = TRUE",
        )
        .bind(ifopt_val)
        .execute(&state.pool)
        .await?;

        if legacy_result.rows_affected() > 0 {
            info!(ifopt = %ifopt_val, "Manual mapping removed from ifopt_gtfs_mapping");
        }
    }

    Ok(Json(RemoveMappingResponse {
        removed_count: total_removed,
    }))
}

/// Get mapping status overview with optional candidates
///
/// Returns a summary of OSM-to-GTFS mapping statistics and a paginated
/// list of mapping entries. Each entry includes the OSM stop info, current
/// mapping status, and optionally nearby GTFS candidate stops.
/// Queries from `osm_gtfs_stop_mapping` as the primary source.
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

    // Get summary counts from the new osm_gtfs_stop_mapping table
    let counts: (i64, i64, i64) = sqlx::query_as(
        "SELECT \
            COALESCE(COUNT(*), 0), \
            COALESCE(SUM(CASE WHEN is_manual THEN 1 ELSE 0 END), 0), \
            COALESCE(SUM(CASE WHEN NOT is_manual THEN 1 ELSE 0 END), 0) \
         FROM osm_gtfs_stop_mapping",
    )
    .fetch_one(&state.pool)
    .await?;

    let mapped_count = counts.0 as usize;
    let manual_count = counts.1 as usize;
    let auto_count = counts.2 as usize;

    // Get total OSM stop count (all platforms + stop_positions, deduplicated by osm_id)
    let total_osm_stop_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ( \
            SELECT osm_id FROM platforms \
            UNION \
            SELECT osm_id FROM stop_positions \
         ) sub",
    )
    .fetch_one(&state.pool)
    .await?;

    let total_osm_stop_count = total_osm_stop_count as usize;

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
    let unmapped_count = total_osm_stop_count.saturating_sub(mapped_count);

    // Build main query for OSM stops
    let entries: Vec<MappingEntry> = if req.unmapped_only {
        fetch_unmapped_entries(&state.pool, &req.search, limit, req.offset, req.include_candidates).await?
    } else {
        fetch_all_entries(&state.pool, &req.search, &req.filter, limit, req.offset, req.include_candidates).await?
    };

    let has_more = entries.len() == limit;

    Ok(Json(MappingStatusResponse {
        total_osm_stop_count,
        total_ifopt_count,
        mapped_count,
        manual_count,
        auto_count,
        unmapped_count,
        entries,
        has_more,
    }))
}

/// Fetch entries for unmapped OSM stops (those not in osm_gtfs_stop_mapping)
async fn fetch_unmapped_entries(
    pool: &PgPool,
    search: &Option<String>,
    limit: usize,
    offset: usize,
    include_candidates: bool,
) -> Result<Vec<MappingEntry>, MappingError> {
    // Get all OSM stops (platforms + stop_positions) that don't have a mapping
    // in osm_gtfs_stop_mapping. Platforms are prioritized (source_priority=1).
    let mut qb = sqlx::QueryBuilder::new(
        "SELECT DISTINCT ON (sub.osm_id) sub.osm_id, sub.osm_type, sub.ref_ifopt, sub.name, sub.lat, sub.lon FROM ( \
            SELECT osm_id, 'platform' AS osm_type, TRIM(ref_ifopt) AS ref_ifopt, name, lat, lon, 1 AS source_priority FROM platforms \
            UNION ALL \
            SELECT osm_id, 'stop_position' AS osm_type, TRIM(ref_ifopt) AS ref_ifopt, name, lat, lon, 2 AS source_priority FROM stop_positions \
         ) sub \
         WHERE sub.osm_id NOT IN (SELECT osm_id FROM osm_gtfs_stop_mapping)",
    );

    if let Some(term) = search {
        qb.push(" AND (sub.ref_ifopt ILIKE ");
        qb.push_bind(format!("%{term}%"));
        qb.push(" OR sub.name ILIKE ");
        qb.push_bind(format!("%{term}%"));
        qb.push(" OR CAST(sub.osm_id AS TEXT) ILIKE ");
        qb.push_bind(format!("%{term}%"));
        qb.push(")");
    }

    qb.push(" ORDER BY sub.osm_id, sub.source_priority, sub.name NULLS LAST");
    qb.push(" LIMIT ");
    qb.push_bind(limit as i64);
    qb.push(" OFFSET ");
    qb.push_bind(offset as i64);

    let rows: Vec<(i64, String, Option<String>, Option<String>, f64, f64)> =
        qb.build_query_as().fetch_all(pool).await?;

    // Deduplicate by osm_id (platforms take priority over stop_positions)
    let mut deduped_rows = Vec::with_capacity(rows.len());
    let mut seen_osm_ids = HashSet::new();
    for row in rows {
        if seen_osm_ids.insert(row.0) {
            deduped_rows.push(row);
        }
    }

    // Batch-fetch candidates in a single query instead of N+1
    let candidates_per_entry = if include_candidates {
        let coordinates: Vec<(f64, f64)> = deduped_rows.iter().map(|(_, _, _, _, lat, lon)| (*lat, *lon)).collect();
        fetch_candidates_batch(pool, &coordinates).await?
    } else {
        (0..deduped_rows.len()).map(|_| Vec::new()).collect()
    };

    let entries = deduped_rows
        .into_iter()
        .zip(candidates_per_entry)
        .map(|((osm_id, osm_type, ref_ifopt, name, lat, lon), candidates)| MappingEntry {
            osm_id,
            osm_type,
            ifopt: ref_ifopt,
            name,
            lat,
            lon,
            status: MappingStatus::Unmapped,
            gtfs_stop_id: None,
            gtfs_stop_name: None,
            gtfs_stop_lat: None,
            gtfs_stop_lon: None,
            match_method: None,
            match_score: None,
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
    // Get all OSM stops (platforms + stop_positions) with optional mapping info
    // from osm_gtfs_stop_mapping. Platforms are prioritized (source_priority=1)
    // so that mapping lines connect to the platform indicators shown on the map.
    let mut qb = sqlx::QueryBuilder::new(
        "SELECT osm.osm_id, osm.osm_type, osm.ref_ifopt, osm.name, osm.lat, osm.lon, \
                m.gtfs_stop_id, gs.stop_name AS gtfs_stop_name, \
                gs.lat AS gtfs_lat, gs.lon AS gtfs_lon, \
                m.match_method, m.match_score, m.is_manual \
         FROM ( \
            SELECT DISTINCT ON (osm_id) osm_id, osm_type, TRIM(ref_ifopt) AS ref_ifopt, name, lat, lon \
            FROM ( \
                SELECT osm_id, 'platform' AS osm_type, ref_ifopt, name, lat, lon, 1 AS source_priority FROM platforms \
                UNION ALL \
                SELECT osm_id, 'stop_position' AS osm_type, ref_ifopt, name, lat, lon, 2 AS source_priority FROM stop_positions \
            ) all_stops \
            ORDER BY osm_id, source_priority, name NULLS LAST \
         ) osm \
         LEFT JOIN osm_gtfs_stop_mapping m ON m.osm_id = osm.osm_id AND m.osm_type = osm.osm_type \
         LEFT JOIN gtfs_stops gs ON gs.stop_id = m.gtfs_stop_id \
         WHERE TRUE",
    );

    // Apply filter
    match filter {
        Some(MappingFilter::Manual) => {
            qb.push(" AND m.is_manual = TRUE");
        }
        Some(MappingFilter::Auto) => {
            qb.push(" AND m.is_manual = FALSE AND m.osm_id IS NOT NULL");
        }
        None => {}
    }

    if let Some(term) = search {
        qb.push(" AND (osm.ref_ifopt ILIKE ");
        qb.push_bind(format!("%{term}%"));
        qb.push(" OR osm.name ILIKE ");
        qb.push_bind(format!("%{term}%"));
        qb.push(" OR CAST(osm.osm_id AS TEXT) ILIKE ");
        qb.push_bind(format!("%{term}%"));
        qb.push(")");
    }

    qb.push(" ORDER BY osm.name NULLS LAST, osm.osm_id");
    qb.push(" LIMIT ");
    qb.push_bind(limit as i64);
    qb.push(" OFFSET ");
    qb.push_bind(offset as i64);

    #[derive(sqlx::FromRow)]
    struct AllEntryRow {
        osm_id: i64,
        osm_type: String,
        ref_ifopt: Option<String>,
        name: Option<String>,
        lat: f64,
        lon: f64,
        gtfs_stop_id: Option<String>,
        gtfs_stop_name: Option<String>,
        gtfs_lat: Option<f64>,
        gtfs_lon: Option<f64>,
        match_method: Option<String>,
        match_score: Option<f64>,
        is_manual: Option<bool>,
    }

    let rows: Vec<AllEntryRow> = qb.build_query_as().fetch_all(pool).await?;

    // Deduplicate by osm_id (platforms take priority over stop_positions)
    let mut deduped_rows: Vec<AllEntryRow> = Vec::with_capacity(rows.len());
    let mut seen_osm_ids = HashSet::new();
    for row in rows {
        if seen_osm_ids.insert(row.osm_id) {
            deduped_rows.push(row);
        }
    }

    // Batch-fetch candidates in a single query instead of N+1
    let candidates_per_entry = if include_candidates {
        let coordinates: Vec<(f64, f64)> = deduped_rows.iter().map(|r| (r.lat, r.lon)).collect();
        fetch_candidates_batch(pool, &coordinates).await?
    } else {
        (0..deduped_rows.len()).map(|_| Vec::new()).collect()
    };

    let entries = deduped_rows
        .into_iter()
        .zip(candidates_per_entry)
        .map(|(row, candidates)| {
            let status = match row.is_manual {
                Some(true) => MappingStatus::Manual,
                Some(false) => MappingStatus::Auto,
                None => MappingStatus::Unmapped,
            };
            MappingEntry {
                osm_id: row.osm_id,
                osm_type: row.osm_type,
                ifopt: row.ref_ifopt,
                name: row.name,
                lat: row.lat,
                lon: row.lon,
                status,
                gtfs_stop_id: row.gtfs_stop_id,
                gtfs_stop_name: row.gtfs_stop_name,
                gtfs_stop_lat: row.gtfs_lat,
                gtfs_stop_lon: row.gtfs_lon,
                match_method: row.match_method,
                match_score: row.match_score,
                candidates,
            }
        })
        .collect();

    Ok(entries)
}

/// ~200m bounding box deltas: ±0.002° lat, ±0.003° lon (at ~48° latitude)
const LAT_DELTA: f64 = 0.002;
const LON_DELTA: f64 = 0.003;

use crate::api::utils::distance_meters;

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
        candidates.sort_by(|a, b| {
            a.distance_meters
                .partial_cmp(&b.distance_meters)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
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
#[cfg(test)]
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

/// Middleware that checks for a valid admin API key in the request headers.
/// Accepts `Authorization: Bearer <key>` or `X-Api-Key: <key>`.
async fn require_admin_key(
    axum::extract::State(expected_key): axum::extract::State<String>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, StatusCode> {
    let auth_header = request.headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));

    let api_key_header = request.headers()
        .get("x-api-key")
        .and_then(|v| v.to_str().ok());

    let provided = auth_header.or(api_key_header);

    match provided {
        Some(key) if key.as_bytes().ct_eq(expected_key.as_bytes()).into() => Ok(next.run(request).await),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

pub fn router(pool: PgPool, admin_api_key: Option<String>) -> Router {
    let state = MappingState { pool };

    // Read-only status endpoint is always accessible
    let read_routes = Router::new()
        .route("/status", post(mapping_status))
        .with_state(state.clone());

    // Write endpoints require admin authentication
    let write_routes = match admin_api_key {
        Some(key) => {
            Router::new()
                .route("/set", post(set_mapping))
                .route("/remove", post(remove_mapping))
                .with_state(state)
                .layer(axum::middleware::from_fn_with_state(key, require_admin_key))
        }
        None => {
            tracing::warn!("ADMIN_API_KEY not set — mapping write endpoints are disabled");
            Router::new()
                .route("/set", post(|| async { StatusCode::FORBIDDEN }))
                .route("/remove", post(|| async { StatusCode::FORBIDDEN }))
        }
    };

    read_routes.merge(write_routes)
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
