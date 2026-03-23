use std::collections::{HashMap, HashSet};

use chrono::{Datelike, NaiveDate, Weekday};
#[cfg(test)]
use tracing::info;

#[cfg(test)]
use super::mapping::{
    is_definitive_match, MappingStats, OsmStopInfo, RouteIdentifier, UnmatchedGtfsStop,
    UnmatchedOsmStop, UnmatchedReason, MAX_DISTANCE_METERS,
};
#[cfg(test)]
use super::utils::station_level_ifopt;
#[cfg(test)]
use crate::sync::MatchCandidate;

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
    /// GTFS stop_id -> IFOPTs (reverse mapping, multiple IFOPTs can share a GTFS stop)
    pub gtfs_to_ifopt: HashMap<String, Vec<String>>,
    pub loaded_at: chrono::DateTime<chrono::Utc>,
}

impl GtfsSchedule {
    /// Create an empty schedule, optionally carrying IFOPT↔GTFS mappings.
    pub fn empty_with_mappings(
        ifopt_to_gtfs: HashMap<String, Vec<String>>,
        gtfs_to_ifopt: HashMap<String, Vec<String>>,
    ) -> Self {
        Self {
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
        }
    }

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
                .and_then(|ifopts| ifopts.first().cloned())
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

    /// Build the IFOPT <-> GTFS stop ID mapping using deterministic route-set comparison.
    ///
    /// For each OSM stop with route data, finds GTFS stops within MAX_DISTANCE_METERS
    /// and checks if route sets form a definitive match (one is a subset of the other
    /// with non-empty intersection). When multiple definitive candidates exist (common
    /// for stations with multiple platforms serving the same routes), the closest one
    /// by distance is chosen. Stops without route data are left unmatched.
    ///
    /// Returns statistics about the mapping for issue reporting.
    #[cfg(test)]
    #[allow(clippy::too_many_lines)]
    pub(crate) fn build_ifopt_mapping(
        &mut self,
        osm_stops: &[OsmStopInfo],
        osm_route_sets: &HashMap<String, HashSet<RouteIdentifier>>,
        gtfs_route_sets: &HashMap<String, HashSet<RouteIdentifier>>,
    ) -> MappingStats {
        self.build_ifopt_mapping_with_direction(
            osm_stops,
            osm_route_sets,
            gtfs_route_sets,
            &HashMap::new(),
        )
    }

    /// Direction-aware IFOPT mapping for tests that need to verify direction disambiguation.
    /// Uses trip overlap from `self.trips_by_stop` to determine direction.
    #[cfg(test)]
    pub(crate) fn build_ifopt_mapping_with_direction(
        &mut self,
        osm_stops: &[OsmStopInfo],
        osm_route_sets: &HashMap<String, HashSet<RouteIdentifier>>,
        gtfs_route_sets: &HashMap<String, HashSet<RouteIdentifier>>,
        osm_directional_routes: &HashMap<String, HashSet<i64>>,
    ) -> MappingStats {
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
        let empty_route_set = HashSet::new();
        let empty_osm_id_set: HashSet<i64> = HashSet::new();

        // Build reverse index: OSM route osm_id → IFOPTs on that route
        let mut osm_route_to_ifopts: HashMap<i64, Vec<String>> = HashMap::new();
        for (ifopt, osm_ids) in osm_directional_routes {
            for &osm_id in osm_ids {
                osm_route_to_ifopts
                    .entry(osm_id)
                    .or_default()
                    .push(ifopt.clone());
            }
        }

        struct IfoptEntry<'a> {
            ifopt: &'a str,
            name: &'a Option<String>,
            lat: f64,
            lon: f64,
            candidates: Vec<MatchCandidate>,
            reason: UnmatchedReason,
        }

        // Pass 1: Collect all candidates for each OSM stop
        struct PendingMatch<'a> {
            ifopt: &'a str,
            name: &'a Option<String>,
            lat: f64,
            lon: f64,
            candidates: Vec<MatchCandidate>,
            /// Distance to closest definitive candidate (for processing order)
            best_distance: f64,
        }

        let mut no_route_entries: Vec<IfoptEntry> = Vec::new();
        let mut pending: Vec<PendingMatch> = Vec::new();
        let mut seen_ifopts: HashSet<&str> = HashSet::new();

        for osm_stop in osm_stops {
            // Skip duplicate IFOPT entries (same IFOPT may appear from both platforms and stop_positions)
            if !seen_ifopts.insert(&osm_stop.ifopt) {
                continue;
            }
            let osm_routes = osm_route_sets
                .get(&osm_stop.ifopt)
                .unwrap_or(&empty_route_set);

            if osm_routes.is_empty() {
                no_route_entries.push(IfoptEntry {
                    ifopt: &osm_stop.ifopt,
                    name: &osm_stop.name,
                    lat: osm_stop.lat,
                    lon: osm_stop.lon,
                    candidates: vec![],
                    reason: UnmatchedReason::NoRouteData,
                });
                continue;
            }

            let mut candidates: Vec<MatchCandidate> = Vec::new();

            for &(gtfs_id, glat, glon, gtfs_name) in &gtfs_leaf_stops {
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

            pending.push(PendingMatch {
                ifopt: &osm_stop.ifopt,
                name: &osm_stop.name,
                lat: osm_stop.lat,
                lon: osm_stop.lon,
                candidates,
                best_distance,
            });
        }

        // Pass 2: Sort by distance to closest definitive candidate (ascending).
        // Stops nearest their best GTFS match get first pick, preventing a farther
        // stop from stealing a closer stop's optimal match.
        pending.sort_by(|a, b| {
            a.best_distance
                .partial_cmp(&b.best_distance)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let mut all_entries: Vec<IfoptEntry> = Vec::new();
        let mut claimed_ifopts: HashSet<String> = HashSet::new();
        let mut claimed_gtfs: HashSet<String> = HashSet::new();

        // Direction-aware matching with cascading peer propagation.
        // Each iteration picks the platform with the most matched peers, matches it,
        // then re-sorts. Correct direction signal cascades from cross-line seed stations.
        let mut to_process: Vec<PendingMatch> = pending;

        loop {
            if to_process.is_empty() {
                break;
            }

            // Sort: most peers first, then distance
            to_process.sort_by(|a, b| {
                let a_peers = osm_directional_routes
                    .get(a.ifopt)
                    .unwrap_or(&empty_osm_id_set)
                    .iter()
                    .flat_map(|rid| osm_route_to_ifopts.get(rid).into_iter().flatten())
                    .filter(|pi| self.ifopt_to_gtfs.contains_key(pi.as_str()))
                    .count();
                let b_peers = osm_directional_routes
                    .get(b.ifopt)
                    .unwrap_or(&empty_osm_id_set)
                    .iter()
                    .flat_map(|rid| osm_route_to_ifopts.get(rid).into_iter().flatten())
                    .filter(|pi| self.ifopt_to_gtfs.contains_key(pi.as_str()))
                    .count();
                b_peers.cmp(&a_peers).then_with(|| {
                    a.best_distance
                        .partial_cmp(&b.best_distance)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
            });

            let entry = to_process.remove(0);

            let platform_osm_ids = osm_directional_routes
                .get(entry.ifopt)
                .unwrap_or(&empty_osm_id_set);

            let mut peer_gtfs_ids: Vec<String> = Vec::new();
            for &route_id in platform_osm_ids {
                if let Some(peer_ifopts) = osm_route_to_ifopts.get(&route_id) {
                    for peer_ifopt in peer_ifopts {
                        if let Some(gtfs_ids) = self.ifopt_to_gtfs.get(peer_ifopt.as_str()) {
                            for peer_gtfs_id in gtfs_ids {
                                peer_gtfs_ids.push(peer_gtfs_id.clone());
                            }
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

                // Specificity: prefer GTFS stops whose route set closely matches
                // the OSM platform's routes (fewer extra lines = better match).
                let specificity_for = |c: &MatchCandidate| -> f64 {
                    let gtfs_routes = gtfs_route_sets
                        .get(&c.gtfs_stop_id)
                        .map(|s| s.len())
                        .unwrap_or(1)
                        .max(1);
                    c.shared_routes.len() as f64 / gtfs_routes as f64
                };

                // Sort by: specificity → trip overlap sum → distance → shared_routes
                definitive_candidates.sort_by(|a, b| {
                    let a_spec = specificity_for(a);
                    let b_spec = specificity_for(b);
                    let spec_cmp = b_spec
                        .partial_cmp(&a_spec)
                        .unwrap_or(std::cmp::Ordering::Equal);

                    let trip_cmp = if peer_gtfs_ids.is_empty() {
                        std::cmp::Ordering::Equal
                    } else {
                        let empty_trips: HashSet<String> = HashSet::new();
                        let a_overlap: usize = peer_gtfs_ids
                            .iter()
                            .map(|peer_id| {
                                let peer_trips = self
                                    .trips_by_stop
                                    .get(peer_id)
                                    .unwrap_or(&empty_trips);
                                self.trips_by_stop
                                    .get(&a.gtfs_stop_id)
                                    .map(|ct| {
                                        ct.iter()
                                            .filter(|t| peer_trips.contains(*t))
                                            .count()
                                    })
                                    .unwrap_or(0)
                            })
                            .sum();
                        let b_overlap: usize = peer_gtfs_ids
                            .iter()
                            .map(|peer_id| {
                                let peer_trips = self
                                    .trips_by_stop
                                    .get(peer_id)
                                    .unwrap_or(&empty_trips);
                                self.trips_by_stop
                                    .get(&b.gtfs_stop_id)
                                    .map(|ct| {
                                        ct.iter()
                                            .filter(|t| peer_trips.contains(*t))
                                            .count()
                                    })
                                    .unwrap_or(0)
                            })
                            .sum();
                        b_overlap.cmp(&a_overlap)
                    };
                    spec_cmp
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
                        self.ifopt_to_gtfs.insert(
                            entry.ifopt.to_string(),
                            vec![winner.gtfs_stop_id.clone()],
                        );
                        self.gtfs_to_ifopt
                            .entry(winner.gtfs_stop_id.clone())
                            .or_default()
                            .push(entry.ifopt.to_string());
                        claimed_ifopts.insert(entry.ifopt.to_string());
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

            all_entries.push(IfoptEntry {
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
        for entry in &all_entries {
            let station = station_level_ifopt(entry.ifopt);
            // Find if a sibling platform at this station is already mapped
            let sibling_gtfs: Option<String> = claimed_ifopts
                .iter()
                .filter(|ci| station_level_ifopt(ci) == station && *ci != entry.ifopt)
                .find_map(|ci| self.ifopt_to_gtfs.get(ci.as_str()).and_then(|v| v.first().cloned()));

            if let Some(sibling_gtfs_id) = sibling_gtfs {
                // Only allow if this GTFS stop is a definitive (route-matching) candidate
                if entry.candidates.iter().any(|c| c.gtfs_stop_id == sibling_gtfs_id && c.is_definitive) {
                    station_fallback_matched.push((entry.ifopt.to_string(), sibling_gtfs_id));
                }
            }
        }
        for (ifopt, gtfs_id) in &station_fallback_matched {
            self.ifopt_to_gtfs
                .insert(ifopt.clone(), vec![gtfs_id.clone()]);
            self.gtfs_to_ifopt
                .entry(gtfs_id.clone())
                .or_default()
                .push(ifopt.clone());
            claimed_ifopts.insert(ifopt.clone());
        }
        // Remove matched entries from unmatched list
        all_entries.retain(|e| !station_fallback_matched.iter().any(|(ifopt, _)| ifopt == e.ifopt));
        if !station_fallback_matched.is_empty() {
            info!(
                count = station_fallback_matched.len(),
                "Station-level fallback: shared GTFS stops for sibling platforms"
            );
        }

        all_entries.extend(no_route_entries);

        let matched = claimed_ifopts.len();

        // Build unmatched lists from entries that weren't matched
        let unmatched_osm: Vec<UnmatchedOsmStop> = all_entries
            .iter()
            .map(|entry| UnmatchedOsmStop {
                ifopt: entry.ifopt.to_string(),
                name: entry.name.clone(),
                lat: entry.lat,
                lon: entry.lon,
                candidates: entry.candidates.iter().take(5).cloned().collect(),
                reason: entry.reason.clone(),
            })
            .collect();

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
            "Built IFOPT <-> GTFS stop mapping (deterministic route-based)"
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
        if let Some(ifopts) = self.gtfs_to_ifopt.get(gtfs_stop_id) {
            ifopts.iter().any(|ifopt| ifopt_set.contains(ifopt))
        } else {
            false
        }
    }

    /// Get the first IFOPT for a GTFS stop_id, falling back to the raw stop_id.
    pub fn ifopt_for_gtfs_stop(&self, gtfs_stop_id: &str) -> String {
        self.gtfs_to_ifopt
            .get(gtfs_stop_id)
            .and_then(|ifopts| ifopts.first().cloned())
            .unwrap_or_else(|| gtfs_stop_id.to_string())
    }

    /// Get all IFOPTs for a GTFS stop_id (shared stops map to multiple platforms).
    pub fn ifopts_for_gtfs_stop(&self, gtfs_stop_id: &str) -> Vec<String> {
        self.gtfs_to_ifopt
            .get(gtfs_stop_id)
            .cloned()
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::TransportType;

    fn make_route(line: &str, tt: TransportType) -> RouteIdentifier {
        RouteIdentifier {
            line_ref: line.to_string(),
            transport_type: tt,
        }
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
        schedule.gtfs_to_ifopt.insert("stop_B".to_string(), vec!["de:09761:691".to_string()]);
        assert_eq!(schedule.last_stop_of_trip("trip1"), Some("de:09761:691".to_string()));

        // Unknown trip returns None
        assert_eq!(schedule.last_stop_of_trip("nonexistent"), None);
    }

    #[test]
    fn test_build_ifopt_mapping_with_routes() {
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

        // Add GTFS stop with coordinates
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

        schedule.trips_by_stop.insert(
            "1001".to_string(),
            std::iter::once("trip1".to_string()).collect(),
        );

        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:691:0:1".to_string(),
            name: Some("Test Stop".to_string()),
            lat: 48.3706,
            lon: 10.8979,
        }];

        // Both serve Tram 1 → definitive match
        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert(
            "de:09761:691:0:1".to_string(),
            [make_route("1", TransportType::Tram)].into_iter().collect(),
        );
        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        gtfs_route_sets.insert(
            "1001".to_string(),
            [make_route("1", TransportType::Tram)].into_iter().collect(),
        );

        schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);

        assert!(schedule.ifopt_to_gtfs.contains_key("de:09761:691:0:1"));
        assert_eq!(
            schedule.gtfs_to_ifopt.get("1001"),
            Some(&vec!["de:09761:691:0:1".to_string()])
        );
    }

    #[test]
    fn test_no_match_without_route_data() {
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
            "1001".to_string(),
            GtfsStop {
                stop_id: "1001".to_string(),
                stop_name: Some("Test Stop".to_string()),
                parent_station: Some("100".to_string()),
                lat: Some(48.3705),
                lon: Some(10.8978),
            },
        );

        schedule.trips_by_stop.insert(
            "1001".to_string(),
            std::iter::once("trip1".to_string()).collect(),
        );

        // OSM stop very close but NO route data → no match
        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:691:0:1".to_string(),
            name: Some("Test Stop".to_string()),
            lat: 48.3706,
            lon: 10.8979,
        }];

        let stats = schedule.build_ifopt_mapping(&osm_stops, &HashMap::new(), &HashMap::new());

        assert!(schedule.ifopt_to_gtfs.is_empty());
        assert_eq!(stats.matched, 0);
        assert_eq!(stats.unmatched_osm.len(), 1);
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

        // Even with matching routes, too far away → no match
        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert(
            "de:09761:691:0:1".to_string(),
            [make_route("1", TransportType::Tram)].into_iter().collect(),
        );
        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        gtfs_route_sets.insert(
            "far_stop".to_string(),
            [make_route("1", TransportType::Tram)].into_iter().collect(),
        );

        schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);

        assert!(schedule.ifopt_to_gtfs.is_empty());
        assert!(schedule.gtfs_to_ifopt.is_empty());
    }

    #[test]
    fn test_multiple_definitive_picks_closest() {
        // Two definitive candidates (same routes) → picks the closest by distance
        // This is the common case: multiple GTFS leaf stops at one station (per platform/direction)
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

        // Two GTFS stops nearby, both serving the same routes (different platforms)
        schedule.stops.insert(
            "gtfs_far".to_string(),
            GtfsStop {
                stop_id: "gtfs_far".to_string(),
                stop_name: Some("Stop A".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.3660),
                lon: Some(10.8941),
            },
        );
        schedule.stops.insert(
            "gtfs_close".to_string(),
            GtfsStop {
                stop_id: "gtfs_close".to_string(),
                stop_name: Some("Stop A".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.3654),
                lon: Some(10.8941),
            },
        );
        schedule.trips_by_stop.insert("gtfs_far".to_string(), HashSet::new());
        schedule.trips_by_stop.insert("gtfs_close".to_string(), HashSet::new());

        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:100".to_string(),
            name: Some("Stop A".to_string()),
            lat: 48.3654,
            lon: 10.8941,
        }];

        // Both GTFS stops and OSM stop serve the same route
        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert(
            "de:09761:100".to_string(),
            [make_route("1", TransportType::Tram)].into_iter().collect(),
        );
        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        gtfs_route_sets.insert(
            "gtfs_far".to_string(),
            [make_route("1", TransportType::Tram)].into_iter().collect(),
        );
        gtfs_route_sets.insert(
            "gtfs_close".to_string(),
            [make_route("1", TransportType::Tram)].into_iter().collect(),
        );

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);

        assert_eq!(stats.matched, 1, "Should match to the closest definitive candidate");
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:09761:100"),
            Some(&vec!["gtfs_close".to_string()]),
            "Should pick the closest GTFS stop when multiple are definitive"
        );
    }

    #[test]
    fn test_closer_osm_stop_gets_priority_over_farther() {
        // Moritzplatz scenario: Two OSM platforms (A closer, B farther) compete for
        // two GTFS stops that both serve the same routes. A should get the closest
        // GTFS stop, B should get the next one.
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

        // GTFS stop 1: closer to platform A (7m), farther from B (41m)
        schedule.stops.insert(
            "gtfs_1".to_string(),
            GtfsStop {
                stop_id: "gtfs_1".to_string(),
                stop_name: Some("Moritzplatz".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.367233),
                lon: Some(10.898002),
            },
        );
        // GTFS stop 2: a bit farther from A (12m), even farther from B (49m)
        schedule.stops.insert(
            "gtfs_2".to_string(),
            GtfsStop {
                stop_id: "gtfs_2".to_string(),
                stop_name: Some("Moritzplatz".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.36725),
                lon: Some(10.898109),
            },
        );
        schedule
            .trips_by_stop
            .insert("gtfs_1".to_string(), HashSet::new());
        schedule
            .trips_by_stop
            .insert("gtfs_2".to_string(), HashSet::new());

        // Platform A (closer to both GTFS stops)
        // Platform B (farther from both GTFS stops)
        let osm_stops = vec![
            OsmStopInfo {
                ifopt: "de:09761:617:0:B".to_string(),
                name: Some("Moritzplatz".to_string()),
                lat: 48.3670998,
                lon: 10.8974858,
            },
            OsmStopInfo {
                ifopt: "de:09761:617:0:A".to_string(),
                name: Some("Moritzplatz".to_string()),
                lat: 48.367171,
                lon: 10.8979903,
            },
        ];

        // Both serve the same routes
        let tram_routes: HashSet<RouteIdentifier> = [
            make_route("1", TransportType::Tram),
            make_route("2", TransportType::Tram),
        ]
        .into_iter()
        .collect();

        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert("de:09761:617:0:A".to_string(), tram_routes.clone());
        osm_route_sets.insert("de:09761:617:0:B".to_string(), tram_routes.clone());

        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        gtfs_route_sets.insert("gtfs_1".to_string(), tram_routes.clone());
        gtfs_route_sets.insert("gtfs_2".to_string(), tram_routes);

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);

        assert_eq!(stats.matched, 2, "Both platforms should be matched");
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:09761:617:0:A"),
            Some(&vec!["gtfs_1".to_string()]),
            "Platform A (closer) should get gtfs_1"
        );
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:09761:617:0:B"),
            Some(&vec!["gtfs_2".to_string()]),
            "Platform B (farther) should get gtfs_2"
        );
    }

    #[test]
    fn test_prefers_specific_match_over_closer_distance() {
        // A GTFS stop that exactly matches the OSM platform's routes (high specificity)
        // should be preferred over a closer but less specific stop.
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

        // Close stop shares only 1 route
        schedule.stops.insert(
            "gtfs_close".to_string(),
            GtfsStop {
                stop_id: "gtfs_close".to_string(),
                stop_name: Some("Stop A".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.3654),
                lon: Some(10.8941),
            },
        );
        // Farther stop shares 2 routes
        schedule.stops.insert(
            "gtfs_far".to_string(),
            GtfsStop {
                stop_id: "gtfs_far".to_string(),
                stop_name: Some("Stop A".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.3660),
                lon: Some(10.8941),
            },
        );
        schedule
            .trips_by_stop
            .insert("gtfs_close".to_string(), HashSet::new());
        schedule
            .trips_by_stop
            .insert("gtfs_far".to_string(), HashSet::new());

        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:100".to_string(),
            name: Some("Stop A".to_string()),
            lat: 48.3654,
            lon: 10.8941,
        }];

        // OSM stop serves Tram 1 and Tram 3
        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert(
            "de:09761:100".to_string(),
            [
                make_route("1", TransportType::Tram),
                make_route("3", TransportType::Tram),
            ]
            .into_iter()
            .collect(),
        );

        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        // Close GTFS stop shares only Tram 1
        gtfs_route_sets.insert(
            "gtfs_close".to_string(),
            [
                make_route("1", TransportType::Tram),
                make_route("99", TransportType::Bus),
            ]
            .into_iter()
            .collect(),
        );
        // Far GTFS stop shares both Tram 1 and Tram 3
        gtfs_route_sets.insert(
            "gtfs_far".to_string(),
            [
                make_route("1", TransportType::Tram),
                make_route("3", TransportType::Tram),
            ]
            .into_iter()
            .collect(),
        );

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);

        assert_eq!(stats.matched, 1);
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:09761:100"),
            Some(&vec!["gtfs_far".to_string()]),
            "Should prefer the more specific GTFS stop (exact route match) over a closer but less specific one"
        );
    }

    #[test]
    fn test_build_ifopt_mapping_one_to_one_constraint() {
        // Two IFOPTs near the same single GTFS stop — only the first should be matched
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

        // Both OSM stops and the GTFS stop serve the same route
        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert(
            "de:09761:101:31:A1".to_string(),
            [make_route("1", TransportType::Tram)].into_iter().collect(),
        );
        osm_route_sets.insert(
            "de:09761:101:31:A2".to_string(),
            [make_route("1", TransportType::Tram)].into_iter().collect(),
        );
        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        gtfs_route_sets.insert(
            "gtfs_only".to_string(),
            [make_route("1", TransportType::Tram)].into_iter().collect(),
        );

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);

        // Both platforms at the same station share the single GTFS stop
        // (station-level fallback allows sibling platforms to reuse a GTFS stop)
        assert_eq!(stats.matched, 2, "Both sibling platforms should share the GTFS stop");

        // Both IFOPTs should map to the same GTFS stop
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:09761:101:31:A1"),
            Some(&vec!["gtfs_only".to_string()])
        );
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:09761:101:31:A2"),
            Some(&vec!["gtfs_only".to_string()])
        );

        assert_eq!(stats.unmatched_osm.len(), 0);
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
        for stop_time_list in schedule.stop_times.values_mut() {
            stop_time_list.sort_by_key(|stop_time| stop_time.stop_sequence);
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

        for stop_time_list in stop_times.values_mut() {
            stop_time_list.sort_by_key(|stop_time| stop_time.stop_sequence);
        }

        let times = &stop_times["trip_dup"];
        assert_eq!(times.len(), 3);
        assert_eq!(times[0].stop_sequence, 1);
        assert_eq!(times[1].stop_sequence, 1);
        assert_eq!(times[2].stop_sequence, 2);
    }

    /// Helper to create route sets for the two-stop schedule used in mapping tests.
    /// Königsplatz serves Tram 1 and Tram 3, Moritzplatz serves Bus 5.
    fn make_route_sets_for_mapping() -> (
        HashMap<String, HashSet<RouteIdentifier>>,
        HashMap<String, HashSet<RouteIdentifier>>,
    ) {
        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert(
            "de:09761:100".to_string(),
            [
                make_route("1", TransportType::Tram),
                make_route("3", TransportType::Tram),
            ]
            .into_iter()
            .collect(),
        );
        osm_route_sets.insert(
            "de:09761:200".to_string(),
            [make_route("5", TransportType::Bus)].into_iter().collect(),
        );

        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        gtfs_route_sets.insert(
            "gtfs_kp".to_string(),
            [
                make_route("1", TransportType::Tram),
                make_route("3", TransportType::Tram),
            ]
            .into_iter()
            .collect(),
        );
        gtfs_route_sets.insert(
            "gtfs_mp".to_string(),
            [make_route("5", TransportType::Bus)].into_iter().collect(),
        );

        (osm_route_sets, gtfs_route_sets)
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
        let (osm_route_sets, gtfs_route_sets) = make_route_sets_for_mapping();

        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:100".to_string(),
            name: Some("Königsplatz".to_string()),
            lat: 48.3651,
            lon: 10.8981,
        }];

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);
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

        // Stop far from any GTFS stop (>500m away), with route data
        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:999".to_string(),
            name: Some("Far Away".to_string()),
            lat: 48.400,
            lon: 10.950,
        }];

        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert(
            "de:09761:999".to_string(),
            [make_route("1", TransportType::Tram)].into_iter().collect(),
        );

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &HashMap::new());
        assert_eq!(stats.matched, 0);
        assert_eq!(stats.unmatched_osm.len(), 1);
        assert_eq!(stats.manual_count, 0);
    }

    #[test]
    fn test_build_ifopt_mapping_picks_correct_by_routes() {
        let mut schedule = make_schedule_for_mapping();
        let (osm_route_sets, gtfs_route_sets) = make_route_sets_for_mapping();

        // OSM stop with Königsplatz routes — should match gtfs_kp, not gtfs_mp
        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:100".to_string(),
            name: Some("Königsplatz".to_string()),
            lat: 48.3651,
            lon: 10.8981,
        }];

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);
        assert_eq!(stats.matched, 1);
        assert_eq!(
            schedule.ifopt_to_gtfs["de:09761:100"],
            vec!["gtfs_kp".to_string()]
        );
    }

    #[test]
    fn test_build_ifopt_mapping_multiple_osm_stops() {
        let mut schedule = make_schedule_for_mapping();
        let (osm_route_sets, gtfs_route_sets) = make_route_sets_for_mapping();

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

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);
        assert_eq!(stats.matched, 2);
        assert_eq!(stats.manual_count, 0);
        assert!(schedule.ifopt_to_gtfs.contains_key("de:09761:100"));
        assert!(schedule.ifopt_to_gtfs.contains_key("de:09761:200"));
    }

    #[test]
    fn test_mapping_stats_manual_count_zero_for_in_memory() {
        let mut schedule = make_schedule_for_mapping();
        let (osm_route_sets, gtfs_route_sets) = make_route_sets_for_mapping();

        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:100".to_string(),
            name: Some("Königsplatz".to_string()),
            lat: 48.3651,
            lon: 10.8981,
        }];

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);
        // In-memory matching always returns 0 manual mappings
        assert_eq!(stats.manual_count, 0);
    }

    #[test]
    fn test_route_overlap_matching_prefers_correct_stop() {
        // Scenario: Two GTFS stops near one OSM stop, but only one shares routes
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

        // Two GTFS stops at similar distances
        schedule.stops.insert(
            "gtfs_correct".to_string(),
            GtfsStop {
                stop_id: "gtfs_correct".to_string(),
                stop_name: Some("Stop A".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.3660),
                lon: Some(10.8970),
            },
        );
        schedule.stops.insert(
            "gtfs_wrong".to_string(),
            GtfsStop {
                stop_id: "gtfs_wrong".to_string(),
                stop_name: Some("Stop A".to_string()), // Same name!
                parent_station: Some("parent".to_string()),
                lat: Some(48.3658), // Slightly closer
                lon: Some(10.8972),
            },
        );

        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:09761:100".to_string(),
            name: Some("Stop A".to_string()),
            lat: 48.3659,
            lon: 10.8971,
        }];

        // Route sets: OSM stop serves Tram 1 and Tram 3
        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert(
            "de:09761:100".to_string(),
            [
                make_route("1", TransportType::Tram),
                make_route("3", TransportType::Tram),
            ]
            .into_iter()
            .collect(),
        );

        // gtfs_correct also serves Tram 1 and Tram 3 (perfect match)
        // gtfs_wrong serves Bus 5 (no overlap)
        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        gtfs_route_sets.insert(
            "gtfs_correct".to_string(),
            [
                make_route("1", TransportType::Tram),
                make_route("3", TransportType::Tram),
            ]
            .into_iter()
            .collect(),
        );
        gtfs_route_sets.insert(
            "gtfs_wrong".to_string(),
            [make_route("5", TransportType::Bus)].into_iter().collect(),
        );

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);

        assert_eq!(stats.matched, 1);
        // Should match to gtfs_correct despite gtfs_wrong being slightly closer
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:09761:100"),
            Some(&vec!["gtfs_correct".to_string()])
        );
    }

    #[test]
    fn test_high_match_rate_with_multi_platform_stations() {
        // Simulates a realistic transit network where each station has multiple GTFS
        // leaf stops (one per platform/direction) all serving the same routes.
        // The matcher must achieve at least 90% match rate on OSM stops that have route data.
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

        let num_stations = 20;
        let mut osm_stops = Vec::new();
        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();

        for i in 0..num_stations {
            let base_lat = 48.36 + (i as f64) * 0.002;
            let base_lon = 10.89 + (i as f64) * 0.001;

            // Each station has a unique route set (simulating different lines)
            let route_set: HashSet<RouteIdentifier> = [
                make_route(&format!("{}", i * 2 + 1), TransportType::Tram),
                make_route(&format!("{}", i * 2 + 2), TransportType::Bus),
            ]
            .into_iter()
            .collect();

            // OSM stop (one per station)
            let ifopt = format!("de:09761:{}:0:1", 100 + i);
            osm_stops.push(OsmStopInfo {
                ifopt: ifopt.clone(),
                name: Some(format!("Station {}", i)),
                lat: base_lat,
                lon: base_lon,
            });
            osm_route_sets.insert(ifopt, route_set.clone());

            // GTFS: 3 leaf stops per station (e.g., platform A, B, C)
            // All serve the same routes — this is the common real-world pattern
            for platform in 0..3 {
                let gtfs_id = format!("gtfs_{}_{}", i, platform);
                let offset = (platform as f64) * 0.00005; // ~5m apart
                schedule.stops.insert(
                    gtfs_id.clone(),
                    GtfsStop {
                        stop_id: gtfs_id.clone(),
                        stop_name: Some(format!("Station {} Platform {}", i, platform)),
                        parent_station: Some(format!("parent_{}", i)),
                        lat: Some(base_lat + offset),
                        lon: Some(base_lon + offset),
                    },
                );
                schedule
                    .trips_by_stop
                    .insert(gtfs_id.clone(), HashSet::new());
                gtfs_route_sets.insert(gtfs_id, route_set.clone());
            }
        }

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);

        let match_rate = stats.matched as f64 / num_stations as f64;
        assert!(
            match_rate >= 0.9,
            "Match rate {:.1}% ({}/{}) is below 90% threshold",
            match_rate * 100.0,
            stats.matched,
            num_stations
        );
    }

    #[test]
    fn test_duplicate_ifopt_entries_do_not_overwrite_correct_match() {
        // Same IFOPT appearing multiple times with different coordinates (from platforms + stop_positions).
        // The first occurrence (closest) should win and not be overwritten by later duplicates.
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

        // Correct GTFS stop (2m away from first OSM entry)
        schedule.stops.insert(
            "gtfs_correct".to_string(),
            GtfsStop {
                stop_id: "gtfs_correct".to_string(),
                stop_name: Some("Barfüßerbrücke".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.3654),
                lon: Some(10.8941),
            },
        );
        // Wrong GTFS stop (farther away, at a different station)
        schedule.stops.insert(
            "gtfs_wrong".to_string(),
            GtfsStop {
                stop_id: "gtfs_wrong".to_string(),
                stop_name: Some("Pilgerhausstraße".to_string()),
                parent_station: Some("parent2".to_string()),
                lat: Some(48.3670),
                lon: Some(10.8941),
            },
        );
        schedule
            .trips_by_stop
            .insert("gtfs_correct".to_string(), HashSet::new());
        schedule
            .trips_by_stop
            .insert("gtfs_wrong".to_string(), HashSet::new());

        // Same IFOPT appears 3 times with slightly different coordinates
        let osm_stops = vec![
            OsmStopInfo {
                ifopt: "de:09761:131:0:a".to_string(),
                name: Some("Barfüßerbrücke".to_string()),
                lat: 48.3654,
                lon: 10.89412, // closest to gtfs_correct
            },
            OsmStopInfo {
                ifopt: "de:09761:131:0:a".to_string(),
                name: Some("Barfüßerbrücke".to_string()),
                lat: 48.3658,
                lon: 10.8941, // slightly different coords
            },
            OsmStopInfo {
                ifopt: "de:09761:131:0:a".to_string(),
                name: Some("Barfüßerbrücke".to_string()),
                lat: 48.3662,
                lon: 10.8941, // even farther
            },
        ];

        let tram_routes: HashSet<RouteIdentifier> =
            [make_route("1", TransportType::Tram)].into_iter().collect();

        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert("de:09761:131:0:a".to_string(), tram_routes.clone());

        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        gtfs_route_sets.insert("gtfs_correct".to_string(), tram_routes.clone());
        gtfs_route_sets.insert("gtfs_wrong".to_string(), tram_routes);

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);

        // Only one match (duplicates are skipped)
        assert_eq!(stats.matched, 1);
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:09761:131:0:a"),
            Some(&vec!["gtfs_correct".to_string()]),
            "First IFOPT entry (closest to gtfs_correct) should be matched, duplicates skipped"
        );
    }

    // --- Cross-station theft and direction disambiguation tests ---

    #[test]
    fn test_cross_station_theft_prevented_by_fallback_distance_limit() {
        // Maria-Alber scenario: Station A has 5 OSM platforms (2 with Line 6 routes).
        // Station B (Rudolf-Diesel-Gymnasium, ~400m away) has 1 GTFS stop also serving Line 6.
        // Bug: without fallback distance limit, station A's 2nd platform would "steal" station B's
        // GTFS stop because its nearest candidate was claimed and it fell back to ANY unclaimed one.
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

        // Station A (Maria-Alber) center: 48.3565, 10.9850
        // GTFS stop at station A serving Line 6
        schedule.stops.insert(
            "gtfs_a_line6".to_string(),
            GtfsStop {
                stop_id: "gtfs_a_line6".to_string(),
                stop_name: Some("Friedberg Maria-Alber".to_string()),
                parent_station: Some("parent_a".to_string()),
                lat: Some(48.3565),
                lon: Some(10.9850),
            },
        );
        schedule
            .trips_by_stop
            .insert("gtfs_a_line6".to_string(), HashSet::from(["trip_a".to_string()]));

        // Station B (Rudolf-Diesel-Gymnasium) ~400m away: 48.3600, 10.9850
        // GTFS stop at station B also serving Line 6
        schedule.stops.insert(
            "gtfs_b_line6".to_string(),
            GtfsStop {
                stop_id: "gtfs_b_line6".to_string(),
                stop_name: Some("Rudolf-Diesel-Gymnasium".to_string()),
                parent_station: Some("parent_b".to_string()),
                lat: Some(48.3600),
                lon: Some(10.9850),
            },
        );
        schedule
            .trips_by_stop
            .insert("gtfs_b_line6".to_string(), HashSet::from(["trip_b".to_string()]));

        // Station A has 5 OSM platforms; 2 have Line 6 routes
        // Platform A is closest to gtfs_a_line6 (~5m)
        let osm_stops = vec![
            OsmStopInfo {
                ifopt: "de:maria:1:0:A".to_string(),
                name: Some("Maria-Alber A".to_string()),
                lat: 48.35654,
                lon: 10.98504,
            },
            OsmStopInfo {
                ifopt: "de:maria:1:0:B".to_string(),
                name: Some("Maria-Alber B".to_string()),
                lat: 48.3568,
                lon: 10.9853,
            },
            OsmStopInfo {
                ifopt: "de:maria:1:0:C".to_string(),
                name: Some("Maria-Alber C".to_string()),
                lat: 48.3563,
                lon: 10.9848,
            },
            OsmStopInfo {
                ifopt: "de:maria:1:0:D".to_string(),
                name: Some("Maria-Alber D".to_string()),
                lat: 48.3567,
                lon: 10.9852,
            },
            OsmStopInfo {
                ifopt: "de:maria:1:0:E".to_string(),
                name: Some("Maria-Alber E".to_string()),
                lat: 48.3565,
                lon: 10.9853,
            },
        ];

        // Only platforms A and B have Line 6 routes
        let line6_routes: HashSet<RouteIdentifier> =
            [make_route("6", TransportType::Bus)].into_iter().collect();
        let other_routes: HashSet<RouteIdentifier> =
            [make_route("3", TransportType::Bus)].into_iter().collect();

        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert("de:maria:1:0:A".to_string(), line6_routes.clone());
        osm_route_sets.insert("de:maria:1:0:B".to_string(), line6_routes.clone());
        osm_route_sets.insert("de:maria:1:0:C".to_string(), other_routes.clone());
        osm_route_sets.insert("de:maria:1:0:D".to_string(), other_routes.clone());
        osm_route_sets.insert("de:maria:1:0:E".to_string(), other_routes);

        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        gtfs_route_sets.insert("gtfs_a_line6".to_string(), line6_routes.clone());
        gtfs_route_sets.insert("gtfs_b_line6".to_string(), line6_routes);

        let stats = schedule.build_ifopt_mapping(&osm_stops, &osm_route_sets, &gtfs_route_sets);

        // Platform A (closest to gtfs_a_line6) should claim it
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:maria:1:0:A"),
            Some(&vec!["gtfs_a_line6".to_string()]),
            "Closest Line 6 platform should claim station A's GTFS stop"
        );

        // Station B's GTFS stop (400m away) should NOT be claimed by any station A platform.
        // The fallback distance limit (max 200m) prevents this.
        assert!(
            !schedule.gtfs_to_ifopt.contains_key("gtfs_b_line6")
                || schedule.gtfs_to_ifopt.get("gtfs_b_line6")
                    .map(|ifopts| !ifopts.iter().any(|ifopt| ifopt.starts_with("de:maria:")))
                    .unwrap_or(true),
            "Station B's GTFS stop must NOT be stolen by any station A platform"
        );

        // Platform B shares gtfs_a_line6 via station-level fallback (same station sibling)
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:maria:1:0:B"),
            Some(&vec!["gtfs_a_line6".to_string()]),
            "Platform B should share station A's GTFS stop via station fallback"
        );

        // 2 matches at station A (platform A claims, platform B shares via fallback)
        assert_eq!(stats.matched, 2, "Two matches at station A via station fallback");
    }

    #[test]
    fn test_direction_disambiguation_via_trip_overlap() {
        // Two platforms at same station serve Line 6 in different directions.
        // Two GTFS stops at that station, each visited by different trips.
        // A third station ("anchor") on the same routes is already unambiguously matched,
        // establishing which trips belong to which directional route.
        // The anchor's trip overlap tells us which GTFS stop at the target station
        // serves the same direction as each platform.
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

        // Anchor GTFS stop at a different station, unambiguously close to one platform.
        // This stop's trips establish the direction fingerprint for osm_route 1001.
        schedule.stops.insert(
            "gtfs_anchor".to_string(),
            GtfsStop {
                stop_id: "gtfs_anchor".to_string(),
                stop_name: Some("Anchor Station".to_string()),
                parent_station: Some("parent_anchor".to_string()),
                lat: Some(48.360),
                lon: Some(10.985),
            },
        );
        // Trips T1,T2,T3 go through anchor and gtfs_north (same direction: osm_route 1001)
        // Trips T4,T5,T6 go through gtfs_south only (opposite direction: osm_route 1002)
        schedule.trips_by_stop.insert(
            "gtfs_anchor".to_string(),
            HashSet::from(["T1".to_string(), "T2".to_string(), "T3".to_string()]),
        );

        // Two GTFS stops at target station (equidistant from both platforms)
        schedule.stops.insert(
            "gtfs_north".to_string(),
            GtfsStop {
                stop_id: "gtfs_north".to_string(),
                stop_name: Some("Maria-Alber".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.3565),
                lon: Some(10.9850),
            },
        );
        schedule.stops.insert(
            "gtfs_south".to_string(),
            GtfsStop {
                stop_id: "gtfs_south".to_string(),
                stop_name: Some("Maria-Alber".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.3565),
                lon: Some(10.9850), // same position — only trips differ
            },
        );
        // gtfs_north shares trips with anchor (same direction)
        schedule.trips_by_stop.insert(
            "gtfs_north".to_string(),
            HashSet::from(["T1".to_string(), "T2".to_string(), "T3".to_string()]),
        );
        // gtfs_south has completely different trips (opposite direction)
        schedule.trips_by_stop.insert(
            "gtfs_south".to_string(),
            HashSet::from(["T4".to_string(), "T5".to_string(), "T6".to_string()]),
        );

        // Anchor platform: unambiguously on osm_route 1001, close to gtfs_anchor
        let osm_stops = vec![
            OsmStopInfo {
                ifopt: "de:anchor:1:0:X".to_string(),
                name: Some("Anchor".to_string()),
                lat: 48.360,
                lon: 10.985,
            },
            // Platform A: on osm_route 1001 (same as anchor)
            OsmStopInfo {
                ifopt: "de:maria:1:0:A".to_string(),
                name: Some("Maria-Alber A".to_string()),
                lat: 48.3565,
                lon: 10.9850,
            },
            // Platform B: on osm_route 1002 (opposite direction)
            OsmStopInfo {
                ifopt: "de:maria:1:0:B".to_string(),
                name: Some("Maria-Alber B".to_string()),
                lat: 48.3565,
                lon: 10.9850, // same position — only route differs
            },
        ];

        let line6_routes: HashSet<RouteIdentifier> =
            [make_route("6", TransportType::Bus)].into_iter().collect();

        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert("de:anchor:1:0:X".to_string(), line6_routes.clone());
        osm_route_sets.insert("de:maria:1:0:A".to_string(), line6_routes.clone());
        osm_route_sets.insert("de:maria:1:0:B".to_string(), line6_routes.clone());

        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        gtfs_route_sets.insert("gtfs_anchor".to_string(), line6_routes.clone());
        gtfs_route_sets.insert("gtfs_north".to_string(), line6_routes.clone());
        gtfs_route_sets.insert("gtfs_south".to_string(), line6_routes);

        // Directional routes: anchor + platform A on route 1001, platform B on route 1002
        let mut osm_directional_routes: HashMap<String, HashSet<i64>> = HashMap::new();
        osm_directional_routes
            .insert("de:anchor:1:0:X".to_string(), HashSet::from([1001]));
        osm_directional_routes
            .insert("de:maria:1:0:A".to_string(), HashSet::from([1001]));
        osm_directional_routes
            .insert("de:maria:1:0:B".to_string(), HashSet::from([1002]));

        let stats = schedule.build_ifopt_mapping_with_direction(
            &osm_stops,
            &osm_route_sets,
            &gtfs_route_sets,
            &osm_directional_routes,
        );

        assert_eq!(stats.matched, 3, "All three platforms should be matched");

        // Anchor gets gtfs_anchor (closest geographically)
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:anchor:1:0:X"),
            Some(&vec!["gtfs_anchor".to_string()]),
        );

        // Platform A (osm_route 1001, same as anchor) should get gtfs_north
        // because gtfs_north shares trips T1,T2,T3 with the anchor's gtfs_anchor
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:maria:1:0:A"),
            Some(&vec!["gtfs_north".to_string()]),
            "Platform A should match gtfs_north via trip overlap with anchor"
        );

        // Platform B (osm_route 1002) should get gtfs_south
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:maria:1:0:B"),
            Some(&vec!["gtfs_south".to_string()]),
            "Platform B should match gtfs_south (the remaining stop)"
        );
    }

    #[test]
    fn test_direction_fallback_without_trip_data() {
        // When no directional route data is available, matching should still work
        // using distance-first sorting (graceful degradation).
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
            "gtfs_1".to_string(),
            GtfsStop {
                stop_id: "gtfs_1".to_string(),
                stop_name: Some("Stop".to_string()),
                parent_station: Some("parent".to_string()),
                lat: Some(48.3565),
                lon: Some(10.9850),
            },
        );
        schedule
            .trips_by_stop
            .insert("gtfs_1".to_string(), HashSet::from(["trip1".to_string()]));

        let osm_stops = vec![OsmStopInfo {
            ifopt: "de:test:1:0:A".to_string(),
            name: Some("Stop A".to_string()),
            lat: 48.3566,
            lon: 10.9851,
        }];

        let line6: HashSet<RouteIdentifier> =
            [make_route("6", TransportType::Bus)].into_iter().collect();

        let mut osm_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        osm_route_sets.insert("de:test:1:0:A".to_string(), line6.clone());

        let mut gtfs_route_sets: HashMap<String, HashSet<RouteIdentifier>> = HashMap::new();
        gtfs_route_sets.insert("gtfs_1".to_string(), line6);

        // No directional route data available
        let stats = schedule.build_ifopt_mapping_with_direction(
            &osm_stops,
            &osm_route_sets,
            &gtfs_route_sets,
            &HashMap::new(),
        );

        assert_eq!(stats.matched, 1, "Should still match without direction data");
        assert_eq!(
            schedule.ifopt_to_gtfs.get("de:test:1:0:A"),
            Some(&vec!["gtfs_1".to_string()]),
        );
    }
}
