//! Background synchronization of OSM and GTFS data.
//!
//! This module handles:
//! - Periodic synchronization of OSM transit data (stations, platforms, routes)
//! - Real-time departure/arrival data from GTFS-RT feed
//! - OSM data quality issue detection

pub mod issues; // pub for utoipauto auto-discovery
pub mod types; // pub for utoipauto auto-discovery

// Re-export types for API compatibility
pub use issues::{
    transport_type_from_route, IssueCategory, MatchCandidate, OsmIssue,
    OsmIssueStore, OsmIssueType,
};
pub use types::{
    Departure, DepartureStore, EventType, StopId, VehicleUpdate, VehicleUpdateSender,
    is_osm_stop_id, osm_stop_id, parse_osm_stop_id,
};

use crate::config::{Config, TransportType};
use crate::providers::timetables::gtfs::static_data::OsmStopInfo;
use crate::providers::timetables::gtfs::GtfsProvider;
use chrono::Utc;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use tracing::{error, info, warn};

/// Manages background synchronization of OSM and GTFS data
pub struct SyncManager {
    pool: PgPool,
    gtfs_provider: GtfsProvider,
    config: Arc<RwLock<Config>>,
    departures: DepartureStore,
    issues: OsmIssueStore,
    vehicle_updates_tx: VehicleUpdateSender,
    time_horizon_minutes: u32,
    schedule_cache: crate::api::schedule_cache::ScheduleCache,
}

impl SyncManager {
    pub fn new(
        pool: PgPool,
        config: Config,
        schedule_cache: crate::api::schedule_cache::ScheduleCache,
    ) -> Result<Self, SyncError> {
        let gtfs_provider = GtfsProvider::new(config.gtfs_sync.clone(), pool.clone())?;

        let time_horizon_minutes = config.gtfs_sync.time_horizon_minutes;

        // Create broadcast channel for vehicle updates.
        // Higher capacity prevents Lagged errors that silently drop updates for slow clients.
        let (vehicle_updates_tx, _) = broadcast::channel(128);

        Ok(Self {
            pool,
            gtfs_provider,
            config: Arc::new(RwLock::new(config)),
            departures: Arc::new(RwLock::new(HashMap::new())),
            issues: Arc::new(RwLock::new(Vec::new())),
            vehicle_updates_tx,
            time_horizon_minutes,
            schedule_cache,
        })
    }

    /// Get a reference to the departure store for API access
    pub fn departure_store(&self) -> DepartureStore {
        self.departures.clone()
    }

    /// Get a reference to the OSM issue store for API access
    pub fn issue_store(&self) -> OsmIssueStore {
        self.issues.clone()
    }

    /// Get the departure time horizon in minutes
    pub fn time_horizon_minutes(&self) -> u32 {
        self.time_horizon_minutes
    }

    /// Get the configured GTFS timezone
    pub fn timezone(&self) -> chrono_tz::Tz {
        self.gtfs_provider.timezone()
    }

    /// Get the vehicle updates sender for passing to API handlers
    pub fn vehicle_updates_sender(&self) -> VehicleUpdateSender {
        self.vehicle_updates_tx.clone()
    }

    /// Merge osm2pgsql staging tables into application schema if they exist.
    /// This runs on every API startup to pick up any PBF import that completed
    /// while the API was not running.
    /// Returns true if staging data was merged (new OSM data available).
    async fn merge_osm_import_staging(&self) -> bool {
        let has_staging = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '_osm_transit_routes')"
        )
        .fetch_one(&self.pool)
        .await
        .unwrap_or(false);

        if !has_staging {
            return false;
        }

        info!("Found osm2pgsql staging tables, merging into application schema...");
        let merge_start = std::time::Instant::now();

        // osm2pgsql flex tables use node_id/relation_id (not osm_id) and SRID 3857.
        // We transform to 4326 and extract lat/lon for the application schema.
        let wgs = "ST_Transform(geom, 4326)";

        // --- Stations ---
        match sqlx::query(&format!(r#"
            INSERT INTO stations (osm_id, osm_type, name, ref_ifopt, lat, lon, geom, tags, updated_at)
            SELECT node_id, 'node', name, ref_ifopt, ST_Y({wgs}), ST_X({wgs}), {wgs}, tags, NOW()
            FROM _osm_transit_stations
            ON CONFLICT (osm_id) DO UPDATE SET
                name = EXCLUDED.name, ref_ifopt = EXCLUDED.ref_ifopt,
                lat = EXCLUDED.lat, lon = EXCLUDED.lon, geom = EXCLUDED.geom,
                tags = EXCLUDED.tags, updated_at = NOW()
        "#)).execute(&self.pool).await {
            Ok(r) => info!(rows = r.rows_affected(), "Merged stations"),
            Err(e) => error!("Failed to merge stations: {}", e),
        }

        // --- Platform nodes ---
        match sqlx::query(&format!(r#"
            INSERT INTO platforms (osm_id, osm_type, name, ref, ref_ifopt, lat, lon, geom, tags, updated_at)
            SELECT node_id, 'node', name, ref, ref_ifopt, ST_Y({wgs}), ST_X({wgs}), {wgs}, tags, NOW()
            FROM _osm_transit_platforms
            ON CONFLICT (osm_id) DO UPDATE SET
                name = EXCLUDED.name, ref = EXCLUDED.ref, ref_ifopt = EXCLUDED.ref_ifopt,
                lat = EXCLUDED.lat, lon = EXCLUDED.lon, geom = EXCLUDED.geom,
                tags = EXCLUDED.tags, updated_at = NOW()
        "#)).execute(&self.pool).await {
            Ok(r) => info!(rows = r.rows_affected(), "Merged platforms"),
            Err(e) => error!("Failed to merge platforms: {}", e),
        }

        // --- Platform ways (physical outlines with centroid, separate table) ---
        match sqlx::query(&format!(r#"
            INSERT INTO platform_ways (osm_id, name, ref, ref_ifopt, lat, lon, geom, line_geom, tags, station_id, updated_at)
            SELECT way_id, name, ref, ref_ifopt,
                   ST_Y(ST_Centroid({wgs})), ST_X(ST_Centroid({wgs})), ST_Centroid({wgs}), {wgs}, tags, NULL, NOW()
            FROM _osm_transit_platform_ways
            ON CONFLICT (osm_id) DO UPDATE SET
                name = EXCLUDED.name, ref = EXCLUDED.ref, ref_ifopt = EXCLUDED.ref_ifopt,
                lat = EXCLUDED.lat, lon = EXCLUDED.lon, geom = EXCLUDED.geom,
                line_geom = EXCLUDED.line_geom,
                tags = EXCLUDED.tags, updated_at = NOW()
        "#)).execute(&self.pool).await {
            Ok(r) => info!(rows = r.rows_affected(), "Merged platform ways"),
            Err(e) => error!("Failed to merge platform ways: {}", e),
        }

        // --- Stop positions ---
        match sqlx::query(&format!(r#"
            INSERT INTO stop_positions (osm_id, osm_type, name, ref, ref_ifopt, lat, lon, tags, updated_at)
            SELECT node_id, 'node', name, ref, ref_ifopt, ST_Y({wgs}), ST_X({wgs}), tags, NOW()
            FROM _osm_transit_stops
            ON CONFLICT (osm_id) DO UPDATE SET
                name = EXCLUDED.name, ref = EXCLUDED.ref, ref_ifopt = EXCLUDED.ref_ifopt,
                lat = EXCLUDED.lat, lon = EXCLUDED.lon,
                tags = EXCLUDED.tags, updated_at = NOW()
        "#)).execute(&self.pool).await {
            Ok(r) => info!(rows = r.rows_affected(), "Merged stop positions"),
            Err(e) => error!("Failed to merge stop positions: {}", e),
        }

        // --- Link platforms/stops to stations via stop_area membership ---
        //
        // For each stop_area relation, find the station it belongs to:
        // 1. If the stop_area contains a station node → use that
        // 2. If not → insert the stop_area itself as a station (using centroid of its members)
        //
        // This matches the old Overpass-based pipeline where stop_area relations
        // were treated as stations directly.
        let _ = sqlx::query("DROP TABLE IF EXISTS _stop_area_stations").execute(&self.pool).await;
        match sqlx::query(r#"
            CREATE TABLE _stop_area_stations AS
            -- For each stop_area, find the station node if it has one
            SELECT DISTINCT ON (m.relation_id) m.relation_id, m.member_id AS station_id
            FROM _osm_stop_area_members m
            WHERE m.member_type = 'node'
              AND EXISTS (SELECT 1 FROM stations WHERE osm_id = m.member_id)
        "#).execute(&self.pool).await {
            Ok(_) => {
                // For stop_areas WITHOUT a station member, create a synthetic station
                // from the stop_area name and centroid of its stop_position members
                match sqlx::query(r#"
                    INSERT INTO stations (osm_id, osm_type, name, lat, lon, geom, tags, updated_at)
                    SELECT DISTINCT ON (sa.relation_id)
                        sa.relation_id,
                        'relation',
                        sa.station_name,
                        AVG(sp.lat),
                        AVG(sp.lon),
                        ST_SetSRID(ST_MakePoint(AVG(sp.lon), AVG(sp.lat)), 4326),
                        '{}'::jsonb,
                        NOW()
                    FROM (SELECT DISTINCT relation_id, station_name FROM _osm_stop_area_members) sa
                    JOIN _osm_stop_area_members m ON m.relation_id = sa.relation_id AND m.member_type = 'node'
                    JOIN stop_positions sp ON sp.osm_id = m.member_id
                    WHERE NOT EXISTS (SELECT 1 FROM _stop_area_stations sas WHERE sas.relation_id = sa.relation_id)
                      AND sa.station_name IS NOT NULL
                    GROUP BY sa.relation_id, sa.station_name
                    ON CONFLICT (osm_id) DO UPDATE SET
                        name = EXCLUDED.name, lat = EXCLUDED.lat, lon = EXCLUDED.lon, geom = EXCLUDED.geom, updated_at = NOW()
                "#).execute(&self.pool).await {
                    Ok(r) => {
                        info!(rows = r.rows_affected(), "Created synthetic stations from stop_areas without station nodes");
                        // Add these to the lookup table
                        let _ = sqlx::query(r#"
                            INSERT INTO _stop_area_stations (relation_id, station_id)
                            SELECT sa.relation_id, sa.relation_id
                            FROM (SELECT DISTINCT relation_id FROM _osm_stop_area_members) sa
                            WHERE NOT EXISTS (SELECT 1 FROM _stop_area_stations sas WHERE sas.relation_id = sa.relation_id)
                              AND EXISTS (SELECT 1 FROM stations WHERE osm_id = sa.relation_id)
                        "#).execute(&self.pool).await;
                    }
                    Err(e) => error!("Failed to create synthetic stations: {}", e),
                }

                // Link platforms
                match sqlx::query(r#"
                    UPDATE platforms p SET station_id = sas.station_id
                    FROM _osm_stop_area_members m
                    JOIN _stop_area_stations sas ON sas.relation_id = m.relation_id
                    WHERE m.member_type = 'node' AND m.member_id = p.osm_id
                      AND p.station_id IS NULL
                "#).execute(&self.pool).await {
                    Ok(r) => info!(rows = r.rows_affected(), "Linked platforms to stations via stop_area"),
                    Err(e) => error!("Failed to link platforms: {}", e),
                }
                // Link stop positions
                match sqlx::query(r#"
                    UPDATE stop_positions sp SET station_id = sas.station_id
                    FROM _osm_stop_area_members m
                    JOIN _stop_area_stations sas ON sas.relation_id = m.relation_id
                    WHERE m.member_type = 'node' AND m.member_id = sp.osm_id
                      AND sp.station_id IS NULL
                "#).execute(&self.pool).await {
                    Ok(r) => info!(rows = r.rows_affected(), "Linked stop positions to stations via stop_area"),
                    Err(e) => error!("Failed to link stop positions: {}", e),
                }
                // Link platform ways (member_type = 'way' in stop_area)
                match sqlx::query(r#"
                    UPDATE platform_ways pw SET station_id = sas.station_id
                    FROM _osm_stop_area_members m
                    JOIN _stop_area_stations sas ON sas.relation_id = m.relation_id
                    WHERE m.member_type = 'way' AND m.member_id = pw.osm_id
                      AND pw.station_id IS NULL
                "#).execute(&self.pool).await {
                    Ok(r) => info!(rows = r.rows_affected(), "Linked platform ways to stations via stop_area"),
                    Err(e) => error!("Failed to link platform ways: {}", e),
                }
                let _ = sqlx::query("DROP TABLE IF EXISTS _stop_area_stations").execute(&self.pool).await;
            }
            Err(e) => error!("Failed to build station lookup from stop_area: {}", e),
        }

        // --- Routes (metadata first, geometry built from non-platform ways) ---
        match sqlx::query(r#"
            INSERT INTO routes (osm_id, osm_type, name, ref, route_type, color, operator, network, min_zoom, tags, updated_at)
            SELECT relation_id, 'relation', name, ref, route_type, color, operator, network,
                   min_zoom, tags, NOW()
            FROM _osm_transit_routes
            ON CONFLICT (osm_id) DO UPDATE SET
                name = EXCLUDED.name, ref = EXCLUDED.ref, route_type = EXCLUDED.route_type,
                color = EXCLUDED.color, operator = EXCLUDED.operator, network = EXCLUDED.network,
                min_zoom = EXCLUDED.min_zoom, tags = EXCLUDED.tags,
                updated_at = NOW()
        "#).execute(&self.pool).await {
            Ok(r) => info!(rows = r.rows_affected(), "Merged route metadata"),
            Err(e) => error!("Failed to merge route metadata: {}", e),
        }

        // Build route geometry from non-platform way members only
        info!("Building route geometry from way members (excluding platforms, this may take ~1 minute)...");
        let geom_start = std::time::Instant::now();
        match sqlx::query(r#"
            UPDATE routes r SET geom = sub.geom
            FROM (
                SELECT m.route_id,
                       ST_Multi(ST_Transform(ST_Collect(w.geom ORDER BY m.sequence), 4326))::geometry(MultiLineString, 4326) AS geom
                FROM _osm_route_way_members m
                JOIN _osm_transit_ways w ON w.way_id = m.way_id
                WHERE m.member_role NOT IN ('platform', 'platform_entry_only', 'platform_exit_only')
                GROUP BY m.route_id
            ) sub
            WHERE r.osm_id = sub.route_id
        "#).execute(&self.pool).await {
            Ok(r) => info!(rows = r.rows_affected(), elapsed_secs = geom_start.elapsed().as_secs(), "Built route geometry (excluding platform ways)"),
            Err(e) => error!(elapsed_secs = geom_start.elapsed().as_secs(), "Failed to build route geometry: {}", e),
        }

        // --- Route stops (link stops/platforms to routes) ---
        match sqlx::query(r#"
            INSERT INTO route_stops (route_id, stop_position_id, platform_id, station_id, sequence, role)
            SELECT
                m.route_id,
                CASE WHEN m.member_role = 'stop' AND EXISTS (SELECT 1 FROM stop_positions WHERE osm_id = m.member_id)
                     THEN m.member_id END,
                CASE WHEN m.member_role = 'platform' AND EXISTS (SELECT 1 FROM platforms WHERE osm_id = m.member_id)
                     THEN m.member_id END,
                COALESCE(
                    (SELECT station_id FROM stop_positions WHERE osm_id = m.member_id),
                    (SELECT station_id FROM platforms WHERE osm_id = m.member_id)
                ),
                m.sequence,
                m.member_role
            FROM _osm_route_stop_members m
            WHERE EXISTS (SELECT 1 FROM routes WHERE osm_id = m.route_id)
            ON CONFLICT DO NOTHING
        "#).execute(&self.pool).await {
            Ok(r) => info!(rows = r.rows_affected(), "Merged route stops"),
            Err(e) => error!("Failed to merge route stops: {}", e),
        }

        // Spatial indexes
        let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_routes_geom ON routes USING GIST (geom)").execute(&self.pool).await;
        let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_routes_min_zoom ON routes (min_zoom)").execute(&self.pool).await;

        // --- Materialize Stop Marker and Connection Geometries ---
        info!("Materializing stop marker and connection geometries...");
        let mat_start = std::time::Instant::now();
        
        // 1. Identify the BEST physical marker for every stop position
        let _ = sqlx::query(r#"
            WITH best_markers AS (
                SELECT DISTINCT ON (sp.osm_id)
                    sp.osm_id,
                    COALESCE(p.geom, pw.geom, sp.geom) as m_geom
                FROM stop_positions sp
                LEFT JOIN platforms p ON (p.station_id = sp.station_id AND sp.ref_ifopt IS NOT NULL AND p.ref_ifopt IS NOT NULL AND (
                    LOWER(p.ref_ifopt) = LOWER(sp.ref_ifopt) OR 
                    split_part(LOWER(p.ref_ifopt), ':', array_length(string_to_array(p.ref_ifopt, ':'), 1)) = split_part(LOWER(sp.ref_ifopt), ':', array_length(string_to_array(sp.ref_ifopt, ':'), 1))
                ))
                LEFT JOIN platform_ways pw ON (pw.station_id = sp.station_id AND sp.ref_ifopt IS NOT NULL AND pw.ref_ifopt IS NOT NULL AND (
                    LOWER(pw.ref_ifopt) = LOWER(sp.ref_ifopt) OR 
                    split_part(LOWER(pw.ref_ifopt), ':', array_length(string_to_array(pw.ref_ifopt, ':'), 1)) = split_part(LOWER(sp.ref_ifopt), ':', array_length(string_to_array(sp.ref_ifopt, ':'), 1))
                ))
                ORDER BY sp.osm_id, (p.osm_id IS NOT NULL OR pw.osm_id IS NOT NULL) DESC
            )
            UPDATE stop_positions sp
            SET marker_geom = bm.m_geom
            FROM best_markers bm
            WHERE sp.osm_id = bm.osm_id
        "#).execute(&self.pool).await;

        // 2. Materialize the connection lines to the parent station
        let _ = sqlx::query(r#"
            UPDATE stop_positions sp
            SET connection_geom = ST_MakeLine(sp.marker_geom, s.geom)
            FROM stations s
            WHERE sp.station_id = s.osm_id
              AND sp.marker_geom IS NOT NULL
              AND s.geom IS NOT NULL
              AND ST_Distance(sp.marker_geom, s.geom) > 0.00001
        "#).execute(&self.pool).await;
        
        info!(elapsed_secs = mat_start.elapsed().as_secs(), "Materialized stop geometries complete");

        // Drop all staging tables
        for table in &[
            "_osm_transit_routes", "_osm_transit_ways", "_osm_route_way_members",
            "_osm_transit_stations", "_osm_transit_platforms", "_osm_transit_platform_ways",
            "_osm_transit_stops", "_osm_stop_area_members", "_osm_route_stop_members",
        ] {
            let _ = sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(&self.pool).await;
        }

        info!(elapsed_secs = merge_start.elapsed().as_secs(), "PBF import merge complete");
        true
    }

    /// Ensure stop position marker_geom and connection_geom are materialized.
    /// These are needed for the transit_stations() MVT function.
    /// Runs on every startup to fix NULL values from prior incomplete imports.
    async fn ensure_marker_geometries(&self) {
        let null_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM stop_positions WHERE marker_geom IS NULL AND geom IS NOT NULL"
        )
        .fetch_one(&self.pool)
        .await
        .unwrap_or(0);

        if null_count == 0 {
            return;
        }

        info!(null_markers = null_count, "Materializing missing stop marker geometries...");
        let start = std::time::Instant::now();

        // Best physical marker: prefer platform/platform_way geom, fall back to stop_position geom
        let _ = sqlx::query(r#"
            WITH best_markers AS (
                SELECT DISTINCT ON (sp.osm_id)
                    sp.osm_id,
                    COALESCE(p.geom, pw.geom, sp.geom) as m_geom
                FROM stop_positions sp
                LEFT JOIN platforms p ON (p.station_id = sp.station_id AND sp.ref_ifopt IS NOT NULL AND p.ref_ifopt IS NOT NULL AND (
                    LOWER(p.ref_ifopt) = LOWER(sp.ref_ifopt) OR
                    split_part(LOWER(p.ref_ifopt), ':', array_length(string_to_array(p.ref_ifopt, ':'), 1)) = split_part(LOWER(sp.ref_ifopt), ':', array_length(string_to_array(sp.ref_ifopt, ':'), 1))
                ))
                LEFT JOIN platform_ways pw ON (pw.station_id = sp.station_id AND sp.ref_ifopt IS NOT NULL AND pw.ref_ifopt IS NOT NULL AND (
                    LOWER(pw.ref_ifopt) = LOWER(sp.ref_ifopt) OR
                    split_part(LOWER(pw.ref_ifopt), ':', array_length(string_to_array(pw.ref_ifopt, ':'), 1)) = split_part(LOWER(sp.ref_ifopt), ':', array_length(string_to_array(sp.ref_ifopt, ':'), 1))
                ))
                WHERE sp.marker_geom IS NULL
                ORDER BY sp.osm_id, (p.osm_id IS NOT NULL OR pw.osm_id IS NOT NULL) DESC
            )
            UPDATE stop_positions sp
            SET marker_geom = bm.m_geom
            FROM best_markers bm
            WHERE sp.osm_id = bm.osm_id
        "#).execute(&self.pool).await;

        // Connection lines to parent station
        let _ = sqlx::query(r#"
            UPDATE stop_positions sp
            SET connection_geom = ST_MakeLine(sp.marker_geom, s.geom)
            FROM stations s
            WHERE sp.station_id = s.osm_id
              AND sp.marker_geom IS NOT NULL
              AND sp.connection_geom IS NULL
              AND s.geom IS NOT NULL
              AND ST_Distance(sp.marker_geom, s.geom) > 0.00001
        "#).execute(&self.pool).await;

        info!(elapsed_secs = start.elapsed().as_secs(), "Marker geometry materialization complete");
    }

    /// Start the background sync loops
    pub async fn start(self: Arc<Self>) {
        info!("Starting sync manager");

        // Merge any pending osm2pgsql PBF import data (stations, platforms, stops, routes)
        let pbf_merged = self.merge_osm_import_staging().await;

        // Ensure stop marker geometries are materialized (needed for MVT tiles).
        // They may be NULL if the DB was populated before geom materialization was added,
        // or if the API restarted without a new PBF import.
        self.ensure_marker_geometries().await;

        // Spawn GTFS sync as a background task so the API can serve requests immediately.
        // The GTFS mapping with Germany-wide data can take minutes.
        let gtfs_self = self.clone();
        tokio::spawn(async move {
            gtfs_self.run_gtfs_sync_loop(pbf_merged).await;
        });
    }

    /// Load all platforms and stop_positions from the database for GTFS mapping.
    /// Includes ALL stops (not just those with `ref:IFOPT`), using OSM ID as the
    /// primary key. Platforms are preferred over stop_positions when both exist
    /// for the same OSM node.
    async fn load_stop_info(&self) -> Vec<OsmStopInfo> {
        // Load all platforms and stop_positions. Use UNION ALL with a priority
        // column so DISTINCT ON (osm_id) picks platforms first.
        let rows: Vec<(i64, String, Option<String>, Option<String>, f64, f64)> = match sqlx::query_as(
            r#"
            SELECT DISTINCT ON (osm_id) osm_id, osm_type, ref_ifopt, name, lat, lon
            FROM (
                SELECT osm_id, 'platform' AS osm_type, ref_ifopt, name, lat, lon, 1 AS priority
                FROM platforms
                UNION ALL
                SELECT osm_id, 'stop_position' AS osm_type, ref_ifopt, name, lat, lon, 2 AS priority
                FROM stop_positions
            ) combined
            ORDER BY osm_id, priority, lat, lon
            "#,
        )
        .fetch_all(&self.pool)
        .await
        {
            Ok(rows) => rows,
            Err(e) => {
                error!(error = %e, "Failed to fetch stop info for GTFS mapping");
                Vec::new()
            }
        };

        rows.into_iter()
            .map(|(osm_id, osm_type, ifopt, name, lat, lon)| OsmStopInfo {
                osm_id,
                osm_type,
                ifopt,
                name,
                lat,
                lon,
            })
            .collect()
    }

    /// Build the OSM <-> GTFS stop and route mappings after schedule load.
    ///
    /// Stores stop mapping in PostgreSQL via `build_osm_gtfs_mapping_to_db` (writes
    /// to both `ifopt_gtfs_mapping` and `osm_gtfs_stop_mapping`).
    async fn build_gtfs_mapping(&self) {
        use crate::providers::timetables::gtfs::static_data;

        let osm_stops = self.load_stop_info().await;
        if osm_stops.is_empty() {
            warn!("No stop info in DB, skipping GTFS mapping");
            let mut issues = self.issues.write().await;
            issues.push(OsmIssue::data_processing_issue(
                OsmIssueType::GtfsLoadFailed,
                "No stop coordinates found in database, cannot map GTFS to OSM".to_string(),
                None,
            ));
            return;
        }

        // Build stop mapping and store in PostgreSQL
        let stats = match static_data::build_osm_gtfs_mapping_to_db(
            self.gtfs_provider.pool(),
            &osm_stops,
        )
        .await
        {
            Ok(stats) => stats,
            Err(e) => {
                error!(error = %e, "Failed to build GTFS stop mapping in DB");
                return;
            }
        };

        // Validate mappings against known-correct assignments
        static_data::validate_mappings(self.gtfs_provider.pool()).await;

        // Build route-level mapping (OSM route ↔ GTFS route by ref + transport type)
        match static_data::build_route_mapping_to_db(self.gtfs_provider.pool()).await {
            Ok(count) => info!(route_mappings = count, "Built route-level mapping"),
            Err(e) => tracing::error!("Failed to build route mapping: {}", e),
        }

        // Inject OSM route colors into gtfs_routes.route_color via the route mapping.
        // This fills in colors where GTFS has none, using OSM route data as the source.
        // The enriched colors are then available for:
        //   1. Per-departure color lookups in the API
        //   2. GTFS feed enrichment for MOTIS (via enrich-gtfs-colors.sh)
        match sqlx::query(
            r#"
            UPDATE gtfs_routes gr
            SET route_color = r.color
            FROM osm_gtfs_route_mapping m
            JOIN routes r ON r.osm_id = m.osm_route_id
            WHERE gr.route_id = m.gtfs_route_id
              AND r.color IS NOT NULL AND r.color != ''
              AND (gr.route_color IS NULL OR gr.route_color = '')
            "#,
        )
        .execute(self.gtfs_provider.pool())
        .await
        {
            Ok(result) => {
                info!(
                    rows = result.rows_affected(),
                    "Injected OSM route colors into gtfs_routes"
                );
            }
            Err(e) => {
                tracing::error!("Failed to inject OSM route colors: {}", e);
            }
        }

        // Report issues from the DB-based mapping stats
        self.report_mapping_issues(&stats).await;
    }

    /// Report mapping statistics as issues for the issues API.
    async fn report_mapping_issues(&self, stats: &crate::providers::timetables::gtfs::static_data::MappingStats) {
        let mut issues = self.issues.write().await;

        // Clear old mapping issues before adding new ones
        issues.retain(|i| {
            !matches!(
                i.issue_type,
                OsmIssueType::NoGtfsMatch
                    | OsmIssueType::AmbiguousGtfsMatch
                    | OsmIssueType::UnmappedGtfsStop
            )
        });

        // Report OSM stops that couldn't be matched
        use crate::providers::timetables::gtfs::static_data::UnmatchedReason;
        for osm_stop in stats.unmatched_osm.iter().take(100) {
            let osm_id_label = format!("osm:{}", osm_stop.osm_id);
            let stop_label = osm_stop
                .name
                .as_deref()
                .or(osm_stop.ifopt.as_deref())
                .unwrap_or(&osm_id_label);
            let (issue_type, description) = match &osm_stop.reason {
                UnmatchedReason::NoRouteData => (
                    OsmIssueType::NoGtfsMatch,
                    format!(
                        "No route data available for {} — cannot match automatically",
                        stop_label
                    ),
                ),
                UnmatchedReason::NoDefinitiveCandidate => (
                    OsmIssueType::NoGtfsMatch,
                    format!(
                        "No definitive route-based match for {}",
                        stop_label
                    ),
                ),
                UnmatchedReason::AmbiguousMatch => (
                    OsmIssueType::AmbiguousGtfsMatch,
                    format!(
                        "Multiple definitive route-based matches for {} — ambiguous",
                        stop_label
                    ),
                ),
            };

            let mut issue = OsmIssue::new(
                osm_stop.osm_id,
                &osm_stop.osm_type,
                "stop",
                issue_type,
                TransportType::Unknown,
                description,
                osm_stop.name.clone(),
                osm_stop.ifopt.clone(),
                Some(osm_stop.lat),
                Some(osm_stop.lon),
            );

            if !osm_stop.candidates.is_empty() {
                issue = issue.with_match_candidates(osm_stop.candidates.clone());
            }

            issues.push(issue);
        }

        if stats.unmatched_osm.len() > 100 {
            info!(
                total = stats.unmatched_osm.len(),
                reported = 100,
                "Additional unmatched OSM stops not reported to avoid flooding"
            );
        }

        // Report unmatched GTFS stops
        for gtfs_stop in stats.unmatched_gtfs.iter().take(100) {
            issues.push(OsmIssue::unmapped_gtfs_stop(
                &gtfs_stop.gtfs_stop_id,
                gtfs_stop.gtfs_stop_name.as_deref(),
                gtfs_stop.lat,
                gtfs_stop.lon,
            ));
        }

        if stats.unmatched_gtfs.len() > 100 {
            info!(
                total = stats.unmatched_gtfs.len(),
                reported = 100,
                "Additional unmatched GTFS stops not reported to avoid flooding"
            );
        }

        info!(
            total_osm_stops = stats.total_db_stops,
            total_gtfs_stops = stats.total_gtfs_stops,
            matched = stats.matched,
            manual = stats.manual_count,
            unmatched_osm = stats.unmatched_osm.len(),
            unmatched_gtfs = stats.unmatched_gtfs.len(),
            "GTFS-OSM mapping complete"
        );
    }

    /// Run the GTFS departure sync loop
    async fn run_gtfs_sync_loop(&self, osm_data_changed: bool) {
        // Step 1: Load static GTFS schedule
        info!("Loading static GTFS schedule...");
        let mut retries = 0u64;
        let gtfs_feed_loaded;
        loop {
            match self.gtfs_provider.refresh_static_schedule().await {
                Ok(loaded) => {
                    gtfs_feed_loaded = loaded;
                    break;
                }
                Err(e) => {
                    retries += 1;
                    // Cap backoff at 5 minutes
                    let wait = (30 * retries).min(300);
                    if retries <= 5 {
                        error!(error = %e, retry = retries, wait_secs = wait, "Failed to load static GTFS, retrying...");
                    } else {
                        error!(error = %e, retry = retries, wait_secs = wait, "Failed to load static GTFS after {} retries, will keep retrying...", retries);
                    }
                    tokio::time::sleep(tokio::time::Duration::from_secs(wait)).await;
                }
            }
        }

        // Step 1b: Build IFOPT <-> GTFS stop mapping — only if data changed
        if osm_data_changed || gtfs_feed_loaded {
            // Check if mapping already exists and neither data source changed
            let mapping_count = sqlx::query_scalar::<_, i64>(
                "SELECT COALESCE(mapping_count, 0) FROM gtfs_feed_meta WHERE id = 1"
            )
            .fetch_one(&self.pool)
            .await
            .unwrap_or(-1);

            // Only skip if mapping already has matches AND no data changed.
            // mapping_count = 0 means previous run found nothing — always retry.
            if mapping_count > 0 && !osm_data_changed {
                info!(mapping_count, "GTFS mapping already exists and OSM data unchanged, skipping rebuild");
            } else {
                info!(osm_data_changed, "Building IFOPT <-> GTFS stop mapping (this may take a few minutes with Germany-wide data)...");
                let mapping_start = std::time::Instant::now();
                self.build_gtfs_mapping().await;
                info!(elapsed_secs = mapping_start.elapsed().as_secs(), "GTFS mapping complete");
            }
        } else {
            info!("Neither GTFS feed nor OSM data changed, skipping mapping rebuild");
        }

        // Step 1c: Build the cached Germany-wide schedule used by the realtime
        // sync loop. This is expensive (walks the full mapping + every
        // referenced trip/stop_time/route/calendar) but only runs here and on
        // subsequent static refreshes.
        if let Err(e) = self.gtfs_provider.refresh_cached_schedule().await {
            error!(error = %e, "Failed to build cached Germany-wide GTFS schedule");
        }

        let config = self.config.read().await;
        let rt_interval_secs = config.gtfs_sync.realtime_interval_secs;
        let static_refresh_hours = config.gtfs_sync.static_refresh_hours;
        drop(config);

        info!(
            realtime_interval_secs = rt_interval_secs,
            static_refresh_hours,
            "Starting GTFS sync loops"
        );

        let mut rt_interval =
            tokio::time::interval(tokio::time::Duration::from_secs(rt_interval_secs));
        let mut static_refresh_interval = tokio::time::interval(
            tokio::time::Duration::from_secs(static_refresh_hours * 3600),
        );
        // Skip first tick (we already loaded)
        static_refresh_interval.tick().await;

        loop {
            tokio::select! {
                _ = rt_interval.tick() => {
                    self.sync_departures_gtfs().await;
                }
                _ = static_refresh_interval.tick() => {
                    info!("Refreshing static GTFS schedule...");
                    match self.gtfs_provider.refresh_static_schedule().await {
                        Err(e) => {
                            error!(error = %e, "Failed to refresh static GTFS schedule");
                        }
                        Ok(false) => {
                            info!("Static GTFS feed unchanged, skipping mapping rebuild");
                        }
                        Ok(true) => {
                            // Rebuild IFOPT mapping after schedule refresh
                            self.build_gtfs_mapping().await;
                            // Invalidate cached schedules so handlers pick up the new data
                            self.schedule_cache.invalidate().await;
                            // Drop the old cached full schedule before rebuilding
                            // (frees memory before we allocate the replacement).
                            self.gtfs_provider.invalidate_cached_schedule().await;
                            if let Err(e) = self.gtfs_provider.refresh_cached_schedule().await {
                                error!(error = %e, "Failed to rebuild cached Germany-wide GTFS schedule");
                            }
                        }
                    }
                }
            }
        }
    }

    /// Fetch GTFS-RT departures and update the store.
    ///
    /// Uses the Germany-wide schedule cached by
    /// `GtfsProvider::refresh_cached_schedule` — there is no per-tick
    /// filtering by area.
    async fn sync_departures_gtfs(&self) {
        match self.gtfs_provider.fetch_departures().await {
            Ok(new_departures) => {
                let total_events: usize = new_departures.values().map(|v| v.len()).sum();
                let total_stops = new_departures.len();

                let mut store = self.departures.write().await;
                *store = new_departures;
                drop(store);

                // Broadcast vehicle update notification
                let update = VehicleUpdate {
                    timestamp: Utc::now().to_rfc3339(),
                    is_initial: false,
                };
                let _ = self.vehicle_updates_tx.send(update);

                info!(stops = total_stops, events = total_events, "Completed GTFS-RT departure sync");
            }
            Err(e) => {
                warn!(error = %e, "Failed to sync GTFS-RT departures, keeping existing data");
            }
        }
    }

}

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("GTFS error: {0}")]
    GtfsError(#[from] crate::providers::timetables::gtfs::error::GtfsError),
    #[error("Database error: {0}")]
    DatabaseError(#[from] sqlx::Error),
}
