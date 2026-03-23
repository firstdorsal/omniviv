use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use sqlx::PgPool;
use tokio::sync::RwLock;

use crate::providers::timetables::gtfs::error::GtfsError;
use crate::providers::timetables::gtfs::static_data::{self, GtfsSchedule};

/// TTL-based cache for GTFS schedules built from the database.
///
/// The underlying GTFS data in PostgreSQL only changes every 6–24 hours
/// (when the static schedule is refreshed), so caching schedules for a few
/// minutes dramatically reduces database load from HTTP and WebSocket handlers.
#[derive(Clone)]
pub struct ScheduleCache {
    entries: Arc<RwLock<Vec<CacheEntry>>>,
    ttl: Duration,
}

struct CacheEntry {
    key: String,
    inserted_at: Instant,
    schedule: Arc<GtfsSchedule>,
}

impl ScheduleCache {
    pub fn new(ttl: Duration) -> Self {
        Self {
            entries: Arc::new(RwLock::new(Vec::new())),
            ttl,
        }
    }

    /// Build a deterministic cache key from a set of stop IDs.
    fn cache_key(stop_ids: &HashSet<String>) -> String {
        let mut sorted: Vec<&str> = stop_ids.iter().map(|s| s.as_str()).collect();
        sorted.sort_unstable();
        sorted.join(",")
    }

    /// Get a cached schedule for the given stop IDs, or build one from the database.
    pub async fn get_or_build(
        &self,
        pool: &PgPool,
        relevant_ifopt_ids: &HashSet<String>,
    ) -> Result<Arc<GtfsSchedule>, GtfsError> {
        let key = Self::cache_key(relevant_ifopt_ids);

        // Check cache first
        {
            let entries = self.entries.read().await;
            if let Some(entry) = entries
                .iter()
                .find(|e| e.key == key && e.inserted_at.elapsed() < self.ttl)
            {
                return Ok(Arc::clone(&entry.schedule));
            }
        }

        // Cache miss — build from database
        let schedule = static_data::build_schedule_from_db(pool, relevant_ifopt_ids).await?;
        let arc = Arc::new(schedule);

        // Insert into cache, evicting expired entries and duplicates
        {
            let mut entries = self.entries.write().await;
            let ttl = self.ttl;
            entries.retain(|e| e.key != key && e.inserted_at.elapsed() < ttl);
            entries.push(CacheEntry {
                key,
                inserted_at: Instant::now(),
                schedule: Arc::clone(&arc),
            });
        }

        Ok(arc)
    }

    /// Get a cached schedule for GTFS stop IDs (bypassing IFOPT mapping).
    pub async fn get_or_build_by_gtfs_stop(
        &self,
        pool: &PgPool,
        gtfs_stop_ids: &HashSet<String>,
    ) -> Result<Arc<GtfsSchedule>, GtfsError> {
        // Prefix key to avoid collisions with IFOPT-based lookups
        let mut key = String::from("gtfs:");
        let mut sorted: Vec<&str> = gtfs_stop_ids.iter().map(|s| s.as_str()).collect();
        sorted.sort_unstable();
        key.push_str(&sorted.join(","));

        // Check cache
        {
            let entries = self.entries.read().await;
            if let Some(entry) = entries
                .iter()
                .find(|e| e.key == key && e.inserted_at.elapsed() < self.ttl)
            {
                return Ok(Arc::clone(&entry.schedule));
            }
        }

        // Build from database
        let schedule =
            static_data::build_schedule_from_db_by_gtfs_stop(pool, gtfs_stop_ids).await?;
        let arc = Arc::new(schedule);

        {
            let mut entries = self.entries.write().await;
            let ttl = self.ttl;
            entries.retain(|e| e.key != key && e.inserted_at.elapsed() < ttl);
            entries.push(CacheEntry {
                key,
                inserted_at: Instant::now(),
                schedule: Arc::clone(&arc),
            });
        }

        Ok(arc)
    }

    /// Invalidate all cached entries. Call after GTFS schedule refresh or mapping changes.
    pub async fn invalidate(&self) {
        let mut entries = self.entries.write().await;
        entries.clear();
    }
}
