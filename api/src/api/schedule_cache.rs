use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use sqlx::PgPool;
use tokio::sync::{Mutex, RwLock};

use crate::providers::timetables::gtfs::error::GtfsError;
use crate::providers::timetables::gtfs::static_data::{self, GtfsSchedule};

/// TTL-based cache for GTFS schedules built from the database.
///
/// The underlying GTFS data in PostgreSQL only changes every 6–24 hours
/// (when the static schedule is refreshed), so caching schedules for a few
/// minutes dramatically reduces database load from HTTP and WebSocket handlers.
///
/// Uses per-key mutexes to prevent concurrent cache misses from triggering
/// redundant database queries for the same stop set.
#[derive(Clone)]
pub struct ScheduleCache {
    entries: Arc<RwLock<Vec<CacheEntry>>>,
    /// Per-key build mutexes — prevents concurrent DB queries for the same key.
    in_flight: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
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
            in_flight: Arc::new(Mutex::new(HashMap::new())),
            ttl,
        }
    }

    /// Build a deterministic cache key from a set of stop IDs.
    fn cache_key(stop_ids: &HashSet<String>) -> String {
        let mut sorted: Vec<&str> = stop_ids.iter().map(|s| s.as_str()).collect();
        sorted.sort_unstable();
        sorted.join(",")
    }

    /// Look up a cached entry by key. Returns None on miss or expiry.
    async fn lookup(&self, key: &str) -> Option<Arc<GtfsSchedule>> {
        let entries = self.entries.read().await;
        entries
            .iter()
            .find(|e| e.key == key && e.inserted_at.elapsed() < self.ttl)
            .map(|e| Arc::clone(&e.schedule))
    }

    /// Insert a schedule into the cache, evicting expired entries and duplicates.
    async fn insert(&self, key: String, schedule: Arc<GtfsSchedule>) {
        let mut entries = self.entries.write().await;
        let ttl = self.ttl;
        entries.retain(|e| e.key != key && e.inserted_at.elapsed() < ttl);
        entries.push(CacheEntry {
            key,
            inserted_at: Instant::now(),
            schedule,
        });
    }

    /// Check cache, or build and insert using the provided async builder.
    /// Uses a per-key mutex to ensure only one concurrent build per key.
    async fn get_or_build_inner<F, Fut>(
        &self,
        key: String,
        build: F,
    ) -> Result<Arc<GtfsSchedule>, GtfsError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<GtfsSchedule, GtfsError>>,
    {
        // Fast path: check cache without locking the build mutex
        if let Some(cached) = self.lookup(&key).await {
            return Ok(cached);
        }

        // Acquire per-key build mutex to prevent concurrent DB queries
        let build_mutex = {
            let mut in_flight = self.in_flight.lock().await;
            in_flight
                .entry(key.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };

        let _build_guard = build_mutex.lock().await;

        // Re-check cache — another task may have populated it while we waited
        if let Some(cached) = self.lookup(&key).await {
            return Ok(cached);
        }

        // Cache miss confirmed — build from database
        let schedule = build().await?;
        let arc = Arc::new(schedule);

        self.insert(key.clone(), Arc::clone(&arc)).await;

        // Clean up the build mutex entry
        {
            let mut in_flight = self.in_flight.lock().await;
            in_flight.remove(&key);
        }

        Ok(arc)
    }

    /// Get a cached schedule for the given stop IDs, or build one from the database.
    pub async fn get_or_build(
        &self,
        pool: &PgPool,
        relevant_ifopt_ids: &HashSet<String>,
    ) -> Result<Arc<GtfsSchedule>, GtfsError> {
        let key = Self::cache_key(relevant_ifopt_ids);
        self.get_or_build_inner(key, || {
            static_data::build_schedule_from_db(pool, relevant_ifopt_ids)
        })
        .await
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
        self.get_or_build_inner(key, || {
            static_data::build_schedule_from_db_by_gtfs_stop(pool, gtfs_stop_ids)
        })
        .await
    }

    /// Invalidate all cached entries. Call after GTFS schedule refresh or mapping changes.
    pub async fn invalidate(&self) {
        let mut entries = self.entries.write().await;
        entries.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn empty_schedule() -> GtfsSchedule {
        GtfsSchedule::empty_with_mappings(HashMap::new(), HashMap::new())
    }

    #[test]
    fn cache_key_is_sorted_and_deterministic() {
        let mut set_a = HashSet::new();
        set_a.insert("z".to_string());
        set_a.insert("a".to_string());
        set_a.insert("m".to_string());

        let mut set_b = HashSet::new();
        set_b.insert("a".to_string());
        set_b.insert("m".to_string());
        set_b.insert("z".to_string());

        assert_eq!(ScheduleCache::cache_key(&set_a), "a,m,z");
        assert_eq!(ScheduleCache::cache_key(&set_a), ScheduleCache::cache_key(&set_b));
    }

    #[test]
    fn cache_key_empty_set() {
        assert_eq!(ScheduleCache::cache_key(&HashSet::new()), "");
    }

    #[test]
    fn cache_key_single_element() {
        let set = HashSet::from(["stop_1".to_string()]);
        assert_eq!(ScheduleCache::cache_key(&set), "stop_1");
    }

    #[tokio::test]
    async fn get_or_build_inner_caches_result() {
        let cache = ScheduleCache::new(Duration::from_secs(60));
        let mut call_count = 0u32;

        // First call — builder runs
        let result1 = cache
            .get_or_build_inner("key1".to_string(), || {
                call_count += 1;
                async { Ok(empty_schedule()) }
            })
            .await
            .unwrap();
        assert_eq!(call_count, 1);

        // Second call — served from cache (builder closure captures a new counter)
        let mut call_count2 = 0u32;
        let result2 = cache
            .get_or_build_inner("key1".to_string(), || {
                call_count2 += 1;
                async { Ok(empty_schedule()) }
            })
            .await
            .unwrap();
        assert_eq!(call_count2, 0, "Builder should not be called on cache hit");
        assert!(Arc::ptr_eq(&result1, &result2), "Should return same Arc");
    }

    #[tokio::test]
    async fn get_or_build_inner_different_keys_separate() {
        let cache = ScheduleCache::new(Duration::from_secs(60));

        let r1 = cache
            .get_or_build_inner("key_a".to_string(), || async { Ok(empty_schedule()) })
            .await
            .unwrap();
        let r2 = cache
            .get_or_build_inner("key_b".to_string(), || async { Ok(empty_schedule()) })
            .await
            .unwrap();

        assert!(!Arc::ptr_eq(&r1, &r2), "Different keys should produce different entries");
    }

    #[tokio::test]
    async fn expired_entries_are_evicted() {
        let cache = ScheduleCache::new(Duration::from_millis(1));

        cache
            .get_or_build_inner("key1".to_string(), || async { Ok(empty_schedule()) })
            .await
            .unwrap();

        // Wait for TTL to expire
        tokio::time::sleep(Duration::from_millis(10)).await;

        // New call should rebuild (old entry expired)
        let mut rebuilt = false;
        cache
            .get_or_build_inner("key1".to_string(), || {
                rebuilt = true;
                async { Ok(empty_schedule()) }
            })
            .await
            .unwrap();
        assert!(rebuilt, "Should rebuild after TTL expires");
    }

    #[tokio::test]
    async fn invalidate_clears_all_entries() {
        let cache = ScheduleCache::new(Duration::from_secs(60));

        cache
            .get_or_build_inner("key1".to_string(), || async { Ok(empty_schedule()) })
            .await
            .unwrap();

        cache.invalidate().await;

        // Should rebuild after invalidation
        let mut rebuilt = false;
        cache
            .get_or_build_inner("key1".to_string(), || {
                rebuilt = true;
                async { Ok(empty_schedule()) }
            })
            .await
            .unwrap();
        assert!(rebuilt, "Should rebuild after invalidation");
    }

    #[tokio::test]
    async fn concurrent_misses_only_build_once() {
        let cache = ScheduleCache::new(Duration::from_secs(60));
        let build_count = Arc::new(std::sync::atomic::AtomicU32::new(0));

        // Spawn 10 concurrent tasks that all miss the cache simultaneously
        let mut handles = Vec::new();
        for _ in 0..10 {
            let cache = cache.clone();
            let count = Arc::clone(&build_count);
            handles.push(tokio::spawn(async move {
                cache
                    .get_or_build_inner("same_key".to_string(), || {
                        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        async { Ok(empty_schedule()) }
                    })
                    .await
                    .unwrap()
            }));
        }

        let results: Vec<_> = futures::future::join_all(handles)
            .await
            .into_iter()
            .map(|r| r.unwrap())
            .collect();

        // Builder should have been called exactly once
        assert_eq!(
            build_count.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "Concurrent misses should only trigger one build"
        );

        // All tasks should get the same Arc
        for result in &results[1..] {
            assert!(Arc::ptr_eq(&results[0], result), "All should share same Arc");
        }
    }
}
