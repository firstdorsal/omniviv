use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use chrono::{Datelike, NaiveDate, Weekday};
use futures::StreamExt;
use sqlx::PgPool;
use strsim::jaro_winkler;
use tokio::io::AsyncWriteExt;
use tracing::{debug, info, warn};

use super::error::GtfsError;
use crate::sync::MatchCandidate;

// --- Matching algorithm constants ---

/// Maximum distance in meters for matching OSM stops to GTFS stops
const MAX_DISTANCE_METERS: f64 = 200.0;
/// Minimum combined score for a match to be considered valid
const MIN_COMBINED_SCORE: f64 = 0.5;
/// Weight for distance score in combined score (0.0-1.0)
const DISTANCE_WEIGHT: f64 = 0.4;
/// Weight for name similarity in combined score (0.0-1.0)
const NAME_WEIGHT: f64 = 0.6;

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

/// An OSM stop that wasn't matched to any GTFS stop (or had low confidence)
#[derive(Debug, Clone)]
pub(crate) struct UnmatchedOsmStop {
    pub(crate) ifopt: String,
    pub(crate) name: Option<String>,
    pub(crate) lat: f64,
    pub(crate) lon: f64,
    /// Candidate matches with scores (may be empty if no candidates within range)
    pub(crate) candidates: Vec<MatchCandidate>,
    /// Whether this is a no-match (no candidates) or low-confidence match
    pub(crate) is_low_confidence: bool,
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
    /// GTFS stop_id -> IFOPT (reverse mapping)
    pub gtfs_to_ifopt: HashMap<String, String>,
    pub loaded_at: chrono::DateTime<chrono::Utc>,
}

impl GtfsSchedule {
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
                .cloned()
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

    /// Build the IFOPT <-> GTFS stop ID mapping using spatial and name-based matching.
    ///
    /// For each provided OSM stop (with IFOPT, name, lat/lon), finds matching GTFS stops
    /// within MAX_DISTANCE_METERS using a combined score of distance and name similarity.
    /// Only matches leaf stops (those with a parent_station or appearing in stop_times).
    ///
    /// Returns statistics about the mapping for issue reporting.
    #[cfg(test)]
    pub(crate) fn build_ifopt_mapping(&mut self, osm_stops: &[OsmStopInfo]) -> MappingStats {
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

        // Pass 1: Compute all candidates per IFOPT
        struct IfoptEntry<'a> {
            ifopt: &'a str,
            name: &'a Option<String>,
            lat: f64,
            lon: f64,
            candidates: Vec<MatchCandidate>,
        }

        let mut all_entries: Vec<IfoptEntry> = Vec::new();
        // (entry_idx, candidate_idx, score)
        let mut scored_pairs: Vec<(usize, usize, f64)> = Vec::new();

        for osm_stop in osm_stops {
            let mut candidates: Vec<MatchCandidate> = Vec::new();

            for &(gtfs_id, glat, glon, gtfs_name) in &gtfs_leaf_stops {
                let dlat = osm_stop.lat - glat;
                let dlon = (osm_stop.lon - glon) * (osm_stop.lat.to_radians().cos());
                let dist_sq = dlat * dlat + dlon * dlon;

                if dist_sq < max_dist_sq {
                    let distance_meters = (dist_sq.sqrt()) * 111_000.0;
                    let distance_score = 1.0 - (distance_meters / MAX_DISTANCE_METERS).min(1.0);

                    let name_similarity = match (&osm_stop.name, gtfs_name) {
                        (Some(osm_name), Some(gtfs_name_str)) => {
                            let osm_normalized = normalize_stop_name(osm_name);
                            let gtfs_normalized = normalize_stop_name(gtfs_name_str);
                            jaro_winkler(&osm_normalized, &gtfs_normalized)
                        }
                        _ => 0.5,
                    };

                    let combined_score =
                        DISTANCE_WEIGHT * distance_score + NAME_WEIGHT * name_similarity;

                    if combined_score >= MIN_COMBINED_SCORE {
                        candidates.push(MatchCandidate {
                            gtfs_stop_id: gtfs_id.to_string(),
                            gtfs_stop_name: gtfs_name.map(String::from),
                            distance_meters,
                            distance_score,
                            name_similarity,
                            combined_score,
                        });
                    }
                }
            }

            candidates.sort_by(|a, b| {
                b.combined_score
                    .partial_cmp(&a.combined_score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });

            // Record scored_pairs AFTER sort so indices remain valid
            let entry_idx = all_entries.len();
            for (cidx, c) in candidates.iter().enumerate() {
                scored_pairs.push((entry_idx, cidx, c.combined_score));
            }

            all_entries.push(IfoptEntry {
                ifopt: &osm_stop.ifopt,
                name: &osm_stop.name,
                lat: osm_stop.lat,
                lon: osm_stop.lon,
                candidates,
            });
        }

        // Pass 2: Greedy 1:1 assignment — best score wins, with deterministic tiebreaking
        scored_pairs.sort_by(|a, b| {
            b.2.partial_cmp(&a.2)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    // Tiebreak: prefer lower IFOPT, then lower GTFS stop ID
                    let a_entry = &all_entries[a.0];
                    let b_entry = &all_entries[b.0];
                    a_entry.ifopt.cmp(b_entry.ifopt).then_with(|| {
                        a_entry.candidates[a.1]
                            .gtfs_stop_id
                            .cmp(&b_entry.candidates[b.1].gtfs_stop_id)
                    })
                })
        });

        let mut claimed_ifopts: HashSet<String> = HashSet::new();
        let mut claimed_gtfs: HashSet<String> = HashSet::new();

        for (entry_idx, cand_idx, _) in &scored_pairs {
            let entry = &all_entries[*entry_idx];
            let candidate = &entry.candidates[*cand_idx];

            if claimed_ifopts.contains(entry.ifopt) || claimed_gtfs.contains(&candidate.gtfs_stop_id) {
                continue;
            }

            self.ifopt_to_gtfs
                .insert(entry.ifopt.to_string(), vec![candidate.gtfs_stop_id.clone()]);
            self.gtfs_to_ifopt
                .insert(candidate.gtfs_stop_id.clone(), entry.ifopt.to_string());

            claimed_ifopts.insert(entry.ifopt.to_string());
            claimed_gtfs.insert(candidate.gtfs_stop_id.clone());
        }

        let matched = claimed_ifopts.len();

        // Build unmatched lists
        let mut unmatched_osm: Vec<UnmatchedOsmStop> = Vec::new();
        for entry in &all_entries {
            if claimed_ifopts.contains(entry.ifopt) {
                continue;
            }
            let is_low_confidence = !entry.candidates.is_empty();
            unmatched_osm.push(UnmatchedOsmStop {
                ifopt: entry.ifopt.to_string(),
                name: entry.name.clone(),
                lat: entry.lat,
                lon: entry.lon,
                candidates: entry.candidates.iter().take(5).cloned().collect(),
                is_low_confidence,
            });
        }

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
            "Built IFOPT <-> GTFS stop mapping (1:1 greedy)"
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
        if let Some(ifopt) = self.gtfs_to_ifopt.get(gtfs_stop_id) {
            ifopt_set.contains(ifopt)
        } else {
            false
        }
    }

    /// Get the IFOPT for a GTFS stop_id, falling back to the raw stop_id.
    pub fn ifopt_for_gtfs_stop(&self, gtfs_stop_id: &str) -> String {
        self.gtfs_to_ifopt
            .get(gtfs_stop_id)
            .cloned()
            .unwrap_or_else(|| gtfs_stop_id.to_string())
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
/// Fetches GTFS leaf stops from the database, runs the spatial + name matching
/// algorithm against provided OSM stops, and stores results in `ifopt_gtfs_mapping`.
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

    // Two-pass greedy matching algorithm enforcing 1:1 IFOPT<->GTFS mapping
    let max_dist_deg = MAX_DISTANCE_METERS / 111_000.0;
    let max_dist_sq = max_dist_deg * max_dist_deg;

    // Pass 1: Compute all (IFOPT, candidates) pairs
    // Store per-IFOPT candidates for later reporting of unmatched stops
    struct IfoptCandidates {
        ifopt: String,
        name: Option<String>,
        lat: f64,
        lon: f64,
        candidates: Vec<MatchCandidate>,
    }

    let mut all_ifopt_candidates: Vec<IfoptCandidates> = Vec::new();
    // Flat list of (ifopt_index, candidate_index, score) for global sorting
    let mut scored_pairs: Vec<(usize, usize, f64)> = Vec::new();

    for osm_stop in osm_stops {
        // Skip IFOPTs that have manual mappings
        if manual_ifopts.contains(&osm_stop.ifopt) {
            continue;
        }

        let mut candidates: Vec<MatchCandidate> = Vec::new();

        for &(gtfs_id, glat, glon, gtfs_name) in &gtfs_candidates {
            // Skip GTFS stops already claimed by manual mappings
            if manual_gtfs_ids.contains(gtfs_id) {
                continue;
            }

            let dlat = osm_stop.lat - glat;
            let dlon = (osm_stop.lon - glon) * (osm_stop.lat.to_radians().cos());
            let dist_sq = dlat * dlat + dlon * dlon;

            if dist_sq < max_dist_sq {
                let distance_meters = (dist_sq.sqrt()) * 111_000.0;
                let distance_score = 1.0 - (distance_meters / MAX_DISTANCE_METERS).min(1.0);

                let name_similarity = match (&osm_stop.name, gtfs_name) {
                    (Some(osm_name), Some(gtfs_name_str)) => {
                        let osm_normalized = normalize_stop_name(osm_name);
                        let gtfs_normalized = normalize_stop_name(gtfs_name_str);
                        jaro_winkler(&osm_normalized, &gtfs_normalized)
                    }
                    _ => 0.5,
                };

                let combined_score =
                    DISTANCE_WEIGHT * distance_score + NAME_WEIGHT * name_similarity;

                if combined_score >= MIN_COMBINED_SCORE {
                    candidates.push(MatchCandidate {
                        gtfs_stop_id: gtfs_id.to_string(),
                        gtfs_stop_name: gtfs_name.map(String::from),
                        distance_meters,
                        distance_score,
                        name_similarity,
                        combined_score,
                    });
                }
            }
        }

        candidates.sort_by(|a, b| {
            b.combined_score
                .partial_cmp(&a.combined_score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        // Record scored_pairs AFTER sort so indices remain valid
        let entry_idx = all_ifopt_candidates.len();
        for (cidx, c) in candidates.iter().enumerate() {
            scored_pairs.push((entry_idx, cidx, c.combined_score));
        }

        all_ifopt_candidates.push(IfoptCandidates {
            ifopt: osm_stop.ifopt.clone(),
            name: osm_stop.name.clone(),
            lat: osm_stop.lat,
            lon: osm_stop.lon,
            candidates,
        });
    }

    // Pass 2: Greedy assignment — sort all pairs by score descending, assign best-first
    scored_pairs.sort_by(|a, b| {
        b.2.partial_cmp(&a.2)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                // Deterministic tiebreak: prefer lower IFOPT, then lower GTFS stop ID
                let a_entry = &all_ifopt_candidates[a.0];
                let b_entry = &all_ifopt_candidates[b.0];
                a_entry.ifopt.cmp(&b_entry.ifopt).then_with(|| {
                    a_entry.candidates[a.1]
                        .gtfs_stop_id
                        .cmp(&b_entry.candidates[b.1].gtfs_stop_id)
                })
            })
    });

    // ifopt -> (gtfs_stop_id, combined_score)
    let mut mapping_results: HashMap<String, (String, f64)> = HashMap::new();
    let mut claimed_gtfs: HashSet<String> = HashSet::new();
    let mut claimed_ifopts: HashSet<String> = HashSet::new();

    for (ifopt_idx, cand_idx, _score) in &scored_pairs {
        let entry = &all_ifopt_candidates[*ifopt_idx];
        let candidate = &entry.candidates[*cand_idx];

        // Skip if either side is already claimed
        if claimed_ifopts.contains(&entry.ifopt) || claimed_gtfs.contains(&candidate.gtfs_stop_id) {
            continue;
        }

        mapping_results.insert(
            entry.ifopt.clone(),
            (candidate.gtfs_stop_id.clone(), candidate.combined_score),
        );
        claimed_ifopts.insert(entry.ifopt.clone());
        claimed_gtfs.insert(candidate.gtfs_stop_id.clone());
    }

    let matched = mapping_results.len();

    // Build unmatched lists
    let mut unmatched_osm: Vec<UnmatchedOsmStop> = Vec::new();
    for entry in &all_ifopt_candidates {
        if claimed_ifopts.contains(&entry.ifopt) {
            continue;
        }
        let is_low_confidence = !entry.candidates.is_empty();
        unmatched_osm.push(UnmatchedOsmStop {
            ifopt: entry.ifopt.clone(),
            name: entry.name.clone(),
            lat: entry.lat,
            lon: entry.lon,
            candidates: entry.candidates.iter().take(5).cloned().collect(),
            is_low_confidence,
        });
    }

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
        qb.push_values(batch.iter(), |mut b, (ifopt, (gtfs_stop_id, score))| {
            b.push_bind(ifopt.as_str())
                .push_bind(gtfs_stop_id.as_str())
                .push_bind(*score)
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
        "Built and stored IFOPT <-> GTFS stop mapping in database"
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
    let mut gtfs_to_ifopt: HashMap<String, String> = HashMap::new();
    for (ifopt, gtfs_id) in &mapping_rows {
        ifopt_to_gtfs
            .entry(ifopt.clone())
            .or_default()
            .push(gtfs_id.clone());
        gtfs_to_ifopt
            .entry(gtfs_id.clone())
            .or_insert_with(|| ifopt.clone());
    }

    let gtfs_stop_ids: Vec<&str> = gtfs_to_ifopt.keys().map(|s| s.as_str()).collect();
    if gtfs_stop_ids.is_empty() {
        debug!("No GTFS mapping found for relevant stops, returning empty schedule");
        return Ok(GtfsSchedule {
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
        });
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
        return Ok(GtfsSchedule {
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
        });
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
        return Ok(GtfsSchedule {
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
        });
    }

    // 1. Get trip IDs that visit our GTFS stops
    let trip_ids: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT trip_id FROM gtfs_stop_times WHERE stop_id = ANY($1::text[])",
    )
    .bind(&gtfs_id_list)
    .fetch_all(pool)
    .await?;

    if trip_ids.is_empty() {
        return Ok(GtfsSchedule {
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
        });
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
        schedule.gtfs_to_ifopt.insert("stop_B".to_string(), "de:09761:691".to_string());
        assert_eq!(schedule.last_stop_of_trip("trip1"), Some("de:09761:691".to_string()));

        // Unknown trip returns None
        assert_eq!(schedule.last_stop_of_trip("nonexistent"), None);
    }

    #[test]
    fn test_build_ifopt_mapping() {
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

        // Add GTFS stops with coordinates
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

        // Add the stop to trips_by_stop so it counts as a leaf
        schedule.trips_by_stop.insert(
            "1001".to_string(),
            std::iter::once("trip1".to_string()).collect(),
        );

        // OSM stops with IFOPT, name, and coordinates very close to GTFS stop
        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:691:0:1".to_string(),
            name: Some("Test Stop".to_string()),
            lat: 48.3706,
            lon: 10.8979,
        }];

        schedule.build_ifopt_mapping(&osm_stops);

        assert!(schedule.ifopt_to_gtfs.contains_key("de:09761:691:0:1"));
        assert_eq!(
            schedule.gtfs_to_ifopt.get("1001"),
            Some(&"de:09761:691:0:1".to_string())
        );
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

        schedule.build_ifopt_mapping(&osm_stops);

        assert!(schedule.ifopt_to_gtfs.is_empty());
        assert!(schedule.gtfs_to_ifopt.is_empty());
    }

    #[test]
    fn test_build_ifopt_mapping_name_similarity() {
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

        // Add two GTFS stops at similar distances
        schedule.stops.insert(
            "stop1".to_string(),
            GtfsStop {
                stop_id: "stop1".to_string(),
                stop_name: Some("Hauptbahnhof".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.3705),
                lon: Some(10.8978),
            },
        );
        schedule.stops.insert(
            "stop2".to_string(),
            GtfsStop {
                stop_id: "stop2".to_string(),
                stop_name: Some("Rathaus".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.3706),
                lon: Some(10.8979),
            },
        );

        schedule.trips_by_stop.insert(
            "stop1".to_string(),
            std::iter::once("trip1".to_string()).collect(),
        );
        schedule.trips_by_stop.insert(
            "stop2".to_string(),
            std::iter::once("trip2".to_string()).collect(),
        );

        // OSM stop with "Hbf" abbreviation should match "Hauptbahnhof" due to name normalization
        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:691:0:1".to_string(),
            name: Some("Hbf".to_string()),
            lat: 48.3706,
            lon: 10.8978,
        }];

        schedule.build_ifopt_mapping(&osm_stops);

        // Should match the stop with similar name despite slightly farther
        assert!(schedule.ifopt_to_gtfs.contains_key("de:09761:691:0:1"));
        assert_eq!(
            schedule.ifopt_to_gtfs["de:09761:691:0:1"],
            vec!["stop1".to_string()],
            "Should match Hauptbahnhof (stop1) due to name similarity with Hbf"
        );
        assert_eq!(
            schedule.gtfs_to_ifopt.get("stop1"),
            Some(&"de:09761:691:0:1".to_string())
        );
    }

    #[test]
    fn test_build_ifopt_mapping_duplicate_ifopt_keeps_best() {
        // Regression test: multiple OSM elements with same IFOPT but different coords
        // should only keep the best match (highest combined score), not accumulate multiple
        let mut schedule = GtfsSchedule {
            stops: HashMap::new(),
            routes: HashMap::new(),
            trips: HashMap::new(),
            stop_times: HashMap::new(),
            calendars: HashMap::new(),
            calendar_dates: HashMap::new(),
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            trips_by_stop: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        };

        // Two GTFS stops at different locations
        schedule.stops.insert(
            "gtfs_stop_1".to_string(),
            GtfsStop {
                stop_id: "gtfs_stop_1".to_string(),
                stop_name: Some("Königsplatz".to_string()),
                lat: Some(48.3655),
                lon: Some(10.8941),
                parent_station: Some("parent".to_string()),
            },
        );
        schedule.stops.insert(
            "gtfs_stop_2".to_string(),
            GtfsStop {
                stop_id: "gtfs_stop_2".to_string(),
                stop_name: Some("Königsplatz".to_string()),
                lat: Some(48.3653),
                lon: Some(10.8940), // ~25m away from stop 1
                parent_station: Some("parent".to_string()),
            },
        );

        schedule
            .trips_by_stop
            .insert("gtfs_stop_1".to_string(), HashSet::new());
        schedule
            .trips_by_stop
            .insert("gtfs_stop_2".to_string(), HashSet::new());

        // Two OSM elements with the SAME IFOPT but slightly different coordinates
        // (like a platform and a stop_position for the same physical stop)
        let osm_stops = vec![
            OsmStopInfo {
                ifopt: "de:09761:101:31:A2".to_string(),
                name: Some("Königsplatz A2".to_string()),
                lat: 48.36552, // Closer to gtfs_stop_1
                lon: 10.8941,
            },
            OsmStopInfo {
                ifopt: "de:09761:101:31:A2".to_string(), // SAME IFOPT!
                name: Some("Königsplatz".to_string()),
                lat: 48.36528, // Closer to gtfs_stop_2
                lon: 10.8940,
            },
        ];

        schedule.build_ifopt_mapping(&osm_stops);

        // Should only have ONE GTFS stop mapped to this IFOPT (the best match)
        let mapped_stops = schedule
            .ifopt_to_gtfs
            .get("de:09761:101:31:A2")
            .expect("IFOPT should be mapped");
        assert_eq!(
            mapped_stops.len(),
            1,
            "Should only have one GTFS stop per IFOPT, got {:?}",
            mapped_stops
        );
    }

    #[test]
    fn test_build_ifopt_mapping_one_to_one_constraint() {
        // Two IFOPTs near the same single GTFS stop — only one should be matched
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

        let stats = schedule.build_ifopt_mapping(&osm_stops);

        // Exactly one IFOPT should be matched (1:1 constraint)
        assert_eq!(stats.matched, 1, "Only one IFOPT should claim the GTFS stop");

        // The GTFS stop should appear in exactly one forward mapping
        let mapped_ifopts: Vec<_> = schedule
            .ifopt_to_gtfs
            .iter()
            .filter(|(_, stops)| stops.contains(&"gtfs_only".to_string()))
            .map(|(ifopt, _)| ifopt.clone())
            .collect();
        assert_eq!(
            mapped_ifopts.len(),
            1,
            "GTFS stop should be claimed by exactly one IFOPT, got {:?}",
            mapped_ifopts
        );

        // Reverse mapping should have exactly one entry
        assert_eq!(schedule.gtfs_to_ifopt.len(), 1);
        assert!(schedule.gtfs_to_ifopt.contains_key("gtfs_only"));

        // The other IFOPT should be in unmatched
        assert_eq!(stats.unmatched_osm.len(), 1);
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

        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:100".to_string(),
            name: Some("Königsplatz".to_string()),
            lat: 48.3651,
            lon: 10.8981,
        }];

        let stats = schedule.build_ifopt_mapping(&osm_stops);
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

        // Stop far from any GTFS stop (>200m away)
        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:999".to_string(),
            name: Some("Far Away".to_string()),
            lat: 48.400,
            lon: 10.950,
        }];

        let stats = schedule.build_ifopt_mapping(&osm_stops);
        assert_eq!(stats.matched, 0);
        assert_eq!(stats.unmatched_osm.len(), 1);
        assert_eq!(stats.manual_count, 0);
    }

    #[test]
    fn test_build_ifopt_mapping_picks_best_candidate() {
        let mut schedule = make_schedule_for_mapping();

        // OSM stop closer to Königsplatz than Moritzplatz, with matching name
        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:100".to_string(),
            name: Some("Königsplatz".to_string()),
            lat: 48.3651,
            lon: 10.8981,
        }];

        let stats = schedule.build_ifopt_mapping(&osm_stops);
        assert_eq!(stats.matched, 1);
        // Should match Königsplatz, not Moritzplatz
        assert_eq!(
            schedule.ifopt_to_gtfs["de:09761:100"],
            vec!["gtfs_kp".to_string()]
        );
    }

    #[test]
    fn test_build_ifopt_mapping_multiple_osm_stops() {
        let mut schedule = make_schedule_for_mapping();

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

        let stats = schedule.build_ifopt_mapping(&osm_stops);
        assert_eq!(stats.matched, 2);
        assert_eq!(stats.manual_count, 0);
        assert!(schedule.ifopt_to_gtfs.contains_key("de:09761:100"));
        assert!(schedule.ifopt_to_gtfs.contains_key("de:09761:200"));
    }

    #[test]
    fn test_mapping_stats_manual_count_zero_for_in_memory() {
        let mut schedule = make_schedule_for_mapping();

        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:100".to_string(),
            name: Some("Königsplatz".to_string()),
            lat: 48.3651,
            lon: 10.8981,
        }];

        let stats = schedule.build_ifopt_mapping(&osm_stops);
        // In-memory matching always returns 0 manual mappings
        assert_eq!(stats.manual_count, 0);
    }
}
