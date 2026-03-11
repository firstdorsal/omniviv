//! GTFS-based timetable provider.
//!
//! Downloads and caches a static GTFS schedule (ZIP), loads it into PostgreSQL,
//! polls a GTFS-RT protobuf feed for real-time trip updates, and produces
//! `Departure` structs keyed by IFOPT stop identifiers.

pub mod error;
pub mod realtime;
pub mod static_data;

use std::collections::{HashMap, HashSet};

use chrono::{Duration, Utc};
use sqlx::PgPool;
use tracing::info;

use crate::config::GtfsSyncConfig;
use crate::sync::Departure;

use error::GtfsError;

pub struct GtfsProvider {
    client: reqwest::Client,
    config: GtfsSyncConfig,
    timezone: chrono_tz::Tz,
    pool: PgPool,
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
        })
    }

    /// Download (if needed) and load the static GTFS schedule into PostgreSQL.
    ///
    /// Skips database loading if the feed hasn't changed (HTTP 304) and data
    /// is already present in the database. This avoids the ~12 minute reload
    /// of 31.5M stop_times on every restart during development.
    pub async fn refresh_static_schedule(&self) -> Result<(), GtfsError> {
        info!("Refreshing static GTFS schedule...");

        let result = static_data::download_feed(
            &self.client,
            &self.config.static_feed_url,
            &self.config.cache_dir,
        )
        .await?;

        if !result.was_updated && self.is_schedule_loaded().await {
            info!("GTFS feed unchanged and database already populated, skipping reload");
            return Ok(());
        }

        // Load into PostgreSQL for persistence and query access
        static_data::load_schedule_to_db(&self.pool, &result.zip_path).await?;
        info!("GTFS schedule loaded into PostgreSQL");

        Ok(())
    }

    /// Fetch GTFS-RT and produce departures for all relevant stops.
    ///
    /// Builds a partial schedule from PostgreSQL containing only data relevant
    /// to the monitored stops, then processes the RT feed against it.
    pub async fn fetch_departures(
        &self,
        relevant_stop_ids: &HashSet<String>,
    ) -> Result<HashMap<String, Vec<Departure>>, GtfsError> {
        // Build a lightweight schedule from PG for just the monitored stops
        let schedule =
            static_data::build_schedule_from_db(&self.pool, relevant_stop_ids).await?;

        let feed = realtime::fetch_feed(&self.client, &self.config.realtime_feed_url).await?;

        let now = Utc::now();
        let time_horizon = Duration::minutes(self.config.time_horizon_minutes as i64);

        let departures = realtime::process_trip_updates(
            &feed,
            &schedule,
            relevant_stop_ids,
            now,
            time_horizon,
            self.timezone,
        );

        Ok(departures)
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
