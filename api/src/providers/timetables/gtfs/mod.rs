//! GTFS-based timetable provider.
//!
//! Downloads and caches a static GTFS schedule (ZIP), loads it into PostgreSQL,
//! polls a GTFS-RT protobuf feed for real-time trip updates, and produces
//! `Departure` structs keyed by IFOPT stop identifiers.

pub mod error;
pub mod realtime;
pub mod static_data;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use chrono::{Duration, Utc};
use sqlx::PgPool;
use tokio::sync::RwLock;
use tracing::{info, warn};

use crate::config::GtfsSyncConfig;
use crate::sync::Departure;

use error::GtfsError;
use static_data::GtfsSchedule;

/// Full Germany-wide schedule cached between static GTFS refreshes.
///
/// Built once by `refresh_cached_schedule()` after each successful static
/// refresh, then reused by every 15-second realtime tick. Rebuilding from
/// scratch on every tick would be infeasible at Germany scale.
struct CachedFullSchedule {
    schedule: Arc<GtfsSchedule>,
    /// All OSM/IFOPT stop keys that should be treated as "relevant" by
    /// `realtime::process_trip_updates`. Derived from the schedule's
    /// `stop_to_gtfs` mapping so the filter matches every mapped stop.
    all_stop_ids: Arc<HashSet<String>>,
}

pub struct GtfsProvider {
    client: reqwest::Client,
    config: GtfsSyncConfig,
    timezone: chrono_tz::Tz,
    pool: PgPool,
    cached_schedule: Arc<RwLock<Option<CachedFullSchedule>>>,
}

impl GtfsProvider {
    pub fn new(config: GtfsSyncConfig, pool: PgPool) -> Result<Self, GtfsError> {
        let client = reqwest::Client::builder()
            .user_agent("omniviv/0.2 (https://github.com/firstdorsal/omniviv)")
            .build()?;
        let timezone = config.parsed_timezone();

        Ok(Self {
            client,
            config,
            timezone,
            pool,
            cached_schedule: Arc::new(RwLock::new(None)),
        })
    }

    /// Download (if needed) and load the static GTFS schedule into PostgreSQL.
    ///
    /// Skips database loading if the feed hasn't changed (HTTP 304) and data
    /// is already present in the database. This avoids the ~12 minute reload
    /// of 31.5M stop_times on every restart during development.
    ///
    /// Returns `true` if the feed was freshly loaded, `false` if skipped.
    pub async fn refresh_static_schedule(&self) -> Result<bool, GtfsError> {
        info!("Refreshing static GTFS schedule...");

        let result = static_data::download_feed(
            &self.client,
            &self.config.static_feed_url,
            &self.config.cache_dir,
        )
        .await?;

        if !result.was_updated && self.is_schedule_loaded().await {
            info!("GTFS feed unchanged and database already populated, skipping reload");
            return Ok(false);
        }

        // Load into PostgreSQL for persistence and query access
        static_data::load_schedule_to_db(&self.pool, &result.zip_path).await?;
        info!("GTFS schedule loaded into PostgreSQL");

        Ok(true)
    }

    /// Fetch GTFS-RT and produce departures for every mapped stop in Germany.
    ///
    /// Reuses the schedule cached by [`refresh_cached_schedule`]; returns an
    /// empty map if the cache hasn't been populated yet (the first tick after
    /// startup may arrive before the initial build finishes).
    pub async fn fetch_departures(
        &self,
    ) -> Result<HashMap<String, Vec<Departure>>, GtfsError> {
        let cached_guard = self.cached_schedule.read().await;
        let Some(cached) = cached_guard.as_ref() else {
            warn!("GTFS realtime tick skipped: full schedule not yet cached");
            return Ok(HashMap::new());
        };
        let schedule = Arc::clone(&cached.schedule);
        let all_stop_ids = Arc::clone(&cached.all_stop_ids);
        drop(cached_guard);

        let feed = realtime::fetch_feed(&self.client, &self.config.realtime_feed_url).await?;

        let now = Utc::now();
        let time_horizon = Duration::minutes(self.config.time_horizon_minutes as i64);

        let departures = realtime::process_trip_updates(
            &feed,
            &schedule,
            &all_stop_ids,
            now,
            time_horizon,
            self.timezone,
        );

        Ok(departures)
    }

    /// Rebuild the cached Germany-wide schedule from PostgreSQL.
    ///
    /// Call after a successful static GTFS refresh (and on startup). The
    /// build is expensive — it walks the full `osm_gtfs_stop_mapping` plus
    /// every trip/stop_time/route/calendar referenced by those mappings —
    /// but the result is reused by every realtime tick until the next
    /// refresh invalidates it.
    pub async fn refresh_cached_schedule(&self) -> Result<(), GtfsError> {
        info!("Building cached Germany-wide GTFS schedule...");
        let start = std::time::Instant::now();

        let schedule = static_data::build_full_schedule_from_db(&self.pool).await?;

        let all_stop_ids: HashSet<String> = schedule.stop_to_gtfs.keys().cloned().collect();
        info!(
            elapsed_secs = start.elapsed().as_secs(),
            mapped_stops = all_stop_ids.len(),
            trips = schedule.trips.len(),
            stop_times_trips = schedule.stop_times.len(),
            "Cached Germany-wide GTFS schedule built"
        );

        let cached = CachedFullSchedule {
            schedule: Arc::new(schedule),
            all_stop_ids: Arc::new(all_stop_ids),
        };

        *self.cached_schedule.write().await = Some(cached);
        Ok(())
    }

    /// Drop the cached full schedule. Use before rebuilding to free memory.
    pub async fn invalidate_cached_schedule(&self) {
        *self.cached_schedule.write().await = None;
    }

    /// Check if the GTFS schedule has been loaded into PostgreSQL.
    pub async fn is_schedule_loaded(&self) -> bool {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM gtfs_feed_meta WHERE id = 1")
            .fetch_one(&self.pool)
            .await
            .unwrap_or(0)
            > 0
    }

    /// Get a reference to the database pool.
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Get the configured timezone.
    pub fn timezone(&self) -> chrono_tz::Tz {
        self.timezone
    }
}
