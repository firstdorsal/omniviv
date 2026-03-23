use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use prost::Message;
use tracing::{debug, info};

use crate::sync::{Departure, EventType};

use super::error::GtfsError;
use super::static_data::{extract_platform_from_ifopt, station_level_ifopt, GtfsSchedule};

use gtfs_realtime::trip_descriptor::ScheduleRelationship as TripSchedule;
use gtfs_realtime::trip_update::stop_time_update::ScheduleRelationship as StopSchedule;

/// Maximum allowed protobuf response size (100 MB)
const MAX_PROTOBUF_SIZE: usize = 100 * 1024 * 1024;

/// Fetch and decode the GTFS-RT protobuf feed.
pub async fn fetch_feed(
    client: &reqwest::Client,
    url: &str,
) -> Result<gtfs_realtime::FeedMessage, GtfsError> {
    let response = client
        .get(url)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(GtfsError::NetworkMessage(format!(
            "GTFS-RT HTTP {}",
            response.status()
        )));
    }

    let bytes = response.bytes().await?;

    if bytes.len() > MAX_PROTOBUF_SIZE {
        return Err(GtfsError::NetworkMessage(format!(
            "GTFS-RT response too large: {} bytes (max {} bytes)",
            bytes.len(),
            MAX_PROTOBUF_SIZE
        )));
    }

    gtfs_realtime::FeedMessage::decode(bytes.as_ref()).map_err(GtfsError::from)
}

/// Process GTFS-RT TripUpdates into Departure structs.
///
/// Only produces departures for stops in `relevant_stop_ids`.
/// Also generates schedule-only departures for active trips without RT data.
/// Percentage of a route's trips that must be explicitly cancelled before the
/// entire route is treated as disrupted (all trips cancelled). GTFS-RT feeds
/// often only partially mark trips during strikes, so this heuristic extends
/// partial cancellations to the full route.
const ROUTE_DISRUPTION_THRESHOLD: f64 = 0.05; // 5%

/// Collect trip IDs that are cancelled via GTFS-RT Service Alerts.
///
/// 1. Collects explicitly cancelled trip IDs from alerts with NO_SERVICE or
///    UNKNOWN_EFFECT (used by DELFI/gtfs.de for per-trip cancellations).
/// 2. If more than 5% of a route's trips are explicitly cancelled, treats the
///    entire route as disrupted and cancels ALL its trips (strike heuristic).
fn collect_cancelled_trips_from_alerts(
    feed: &gtfs_realtime::FeedMessage,
    schedule: &GtfsSchedule,
    now: DateTime<Utc>,
    tz: Tz,
) -> HashSet<String> {
    let mut cancelled = HashSet::new();
    let now_unix = now.timestamp().max(0) as u64;

    for entity in &feed.entity {
        let Some(alert) = &entity.alert else {
            continue;
        };

        // Skip alerts whose active_period does not include the current time.
        // An empty active_period means "always active" per the GTFS-RT spec.
        if !alert.active_period.is_empty()
            && !alert.active_period.iter().any(|period| {
                let start_ok = period.start.map_or(true, |s| now_unix >= s);
                let end_ok = period.end.map_or(true, |e| now_unix < e);
                start_ok && end_ok
            })
        {
            debug!(entity_id = %entity.id, "Skipping alert — active_period does not include current time");
            continue;
        }

        // NO_SERVICE = trip does not operate.
        // Also match UNKNOWN_EFFECT: some feed providers (e.g., DELFI/gtfs.de)
        // use UNKNOWN_EFFECT for per-trip cancellation alerts (strikes etc.)
        // instead of the standard NO_SERVICE value.
        let effect = alert.effect();
        if effect != gtfs_realtime::alert::Effect::NoService
            && effect != gtfs_realtime::alert::Effect::UnknownEffect
        {
            continue;
        }

        for ie in &alert.informed_entity {
            if let Some(trip) = &ie.trip {
                if let Some(ref trip_id) = trip.trip_id {
                    cancelled.insert(trip_id.clone());
                }
            }
        }
    }

    // Heuristic: if a significant fraction of a route's TODAY-ACTIVE trips are
    // explicitly cancelled, the entire route is likely disrupted (e.g., strike).
    // Extend the cancellation to ALL trips on that route.
    // We filter to today's active services to get an accurate ratio — the
    // schedule contains trips for all days, but cancellations target today only.
    let mut cancelled_per_route: HashMap<&str, usize> = HashMap::new();
    let mut total_per_route: HashMap<&str, usize> = HashMap::new();

    let today = now.with_timezone(&tz).date_naive();
    for (trip_id, trip) in &schedule.trips {
        if !schedule.is_service_active(&trip.service_id, today) {
            continue;
        }
        *total_per_route.entry(trip.route_id.as_str()).or_default() += 1;
        if cancelled.contains(trip_id.as_str()) {
            *cancelled_per_route.entry(trip.route_id.as_str()).or_default() += 1;
        }
    }

    let mut disrupted_routes: HashSet<&str> = HashSet::new();
    for (route_id, total) in &total_per_route {
        let canc = cancelled_per_route.get(route_id).copied().unwrap_or(0);
        let ratio = canc as f64 / *total as f64;
        if canc > 0 {
            debug!(route_id, canc, total, ratio = format!("{:.1}%", ratio * 100.0), "Route cancellation ratio (today)");
        }
        if total > &0 && ratio >= ROUTE_DISRUPTION_THRESHOLD {
            disrupted_routes.insert(route_id);
        }
    }

    if !disrupted_routes.is_empty() {
        // Cancel ALL of today's trips on disrupted routes
        for (trip_id, trip) in &schedule.trips {
            if disrupted_routes.contains(&trip.route_id.as_str())
                && schedule.is_service_active(&trip.service_id, today)
            {
                cancelled.insert(trip_id.clone());
            }
        }
        info!(
            disrupted_routes = disrupted_routes.len(),
            "Extended partial cancellations to full routes (strike heuristic)"
        );
    }

    cancelled
}

pub fn process_trip_updates(
    feed: &gtfs_realtime::FeedMessage,
    schedule: &GtfsSchedule,
    relevant_stop_ids: &HashSet<String>,
    now: DateTime<Utc>,
    time_horizon: Duration,
    tz: Tz,
) -> HashMap<String, Vec<Departure>> {
    let mut departures: HashMap<String, Vec<Departure>> = HashMap::new();
    let cutoff = now + time_horizon;

    // Build station-level prefix set for matching
    let station_prefixes: HashSet<String> = relevant_stop_ids
        .iter()
        .map(|id| station_level_ifopt(id))
        .collect();

    let today = now.with_timezone(&tz).date_naive();

    // Track which trip_ids have RT data
    let mut trips_with_rt: HashSet<String> = HashSet::new();

    let has_mapping = !schedule.ifopt_to_gtfs.is_empty();

    let mut matched_trips = 0u64;
    let mut total_updates = 0u64;

    for entity in &feed.entity {
        let Some(trip_update) = &entity.trip_update else {
            continue;
        };
        total_updates += 1;

        let Some(ref trip_id) = trip_update.trip.trip_id else {
            continue;
        };

        // Check if this trip visits any of our stops
        let Some(trip) = schedule.trips.get(trip_id.as_str()) else {
            continue;
        };

        let Some(stop_times) = schedule.stop_times.get(trip_id.as_str()) else {
            continue;
        };

        // Quick check: does this trip visit any of our relevant stops?
        let visits_our_stops = if has_mapping {
            stop_times
                .iter()
                .any(|st| schedule.is_gtfs_stop_relevant(&st.stop_id, relevant_stop_ids))
        } else {
            stop_times.iter().any(|st| {
                relevant_stop_ids.contains(&st.stop_id)
                    || station_prefixes.contains(&station_level_ifopt(&st.stop_id))
            })
        };
        if !visits_our_stops {
            continue;
        }

        matched_trips += 1;
        trips_with_rt.insert(trip_id.clone());

        // Check trip-level cancellation
        let mut trip_cancelled = matches!(
            trip_update.trip.schedule_relationship(),
            TripSchedule::Canceled | TripSchedule::Deleted
        );

        // Check calendar: service must be active today or tomorrow (when horizon crosses midnight)
        let cutoff_date = cutoff.with_timezone(&tz).date_naive();
        let tomorrow = today.succ_opt().unwrap_or(today);
        if !schedule.is_service_active(&trip.service_id, today)
            && !(cutoff_date > today && schedule.is_service_active(&trip.service_id, tomorrow))
        {
            continue;
        }

        // Get route info
        let route_short_name = schedule
            .routes
            .get(&trip.route_id)
            .and_then(|r| r.route_short_name.clone())
            .unwrap_or_default();

        let last_stop = schedule.last_stop_of_trip(trip_id);
        // Use trip headsign, falling back to last stop name if headsign is empty
        let headsign = trip
            .trip_headsign
            .as_ref()
            .filter(|h| !h.is_empty())
            .cloned()
            .or_else(|| schedule.last_stop_name_of_trip(trip_id))
            .unwrap_or_default();

        // Determine service date from trip descriptor or today
        let service_date = trip_update
            .trip
            .start_date
            .as_ref()
            .and_then(|d| parse_service_date(d))
            .unwrap_or(today);

        // Build a lookup for StopTimeUpdates by stop_id and stop_sequence
        let stu_by_stop: HashMap<&str, &gtfs_realtime::trip_update::StopTimeUpdate> = trip_update
            .stop_time_update
            .iter()
            .filter_map(|stu| {
                stu.stop_id
                    .as_deref()
                    .map(|sid| (sid, stu))
            })
            .collect();

        let stu_by_seq: HashMap<u32, &gtfs_realtime::trip_update::StopTimeUpdate> = trip_update
            .stop_time_update
            .iter()
            .filter_map(|stu| stu.stop_sequence.map(|seq| (seq, stu)))
            .collect();

        // Detect "all stops skipped" as effectively cancelled.
        // Some feeds mark strike cancellations by setting schedule_relationship=SKIPPED
        // on every stop instead of using trip-level CANCELED.
        if !trip_cancelled && !trip_update.stop_time_update.is_empty() {
            let all_skipped = trip_update
                .stop_time_update
                .iter()
                .all(|stu| stu.schedule_relationship() == StopSchedule::Skipped);
            if all_skipped {
                trip_cancelled = true;
            }
        }

        // For cancelled trips (trip-level or all-stops-skipped), emit schedule-based
        // departures with cancelled=true so the departure monitor can show them
        // with strikethrough. Skip the normal STU processing loop.
        if trip_cancelled {
            for st in stop_times {
                let relevant_ifopts: Vec<String> = if has_mapping {
                    if let Some(ifopts) = schedule.gtfs_to_ifopt.get(&st.stop_id) {
                        ifopts.iter()
                            .filter(|ifopt| relevant_stop_ids.contains(*ifopt))
                            .cloned()
                            .collect()
                    } else {
                        vec![]
                    }
                } else {
                    let id = station_level_ifopt(&st.stop_id);
                    if relevant_stop_ids.contains(&st.stop_id)
                        || station_prefixes.contains(&id)
                    {
                        vec![st.stop_id.clone()]
                    } else {
                        vec![]
                    }
                };
                if relevant_ifopts.is_empty() { continue; }

                let primary_secs = st.departure_time.or(st.arrival_time);
                let Some(primary_secs) = primary_secs else { continue; };
                let Some(primary_dt) = schedule_time_to_utc(primary_secs, service_date, tz) else { continue; };
                if primary_dt < now - Duration::minutes(10) || primary_dt > cutoff { continue; }

                for ifopt_id in &relevant_ifopts {
                    if let Some(dep_secs) = st.departure_time {
                        if let Some(dep_dt) = schedule_time_to_utc(dep_secs, service_date, tz) {
                            departures.entry(ifopt_id.clone()).or_default().push(Departure {
                                stop_ifopt: ifopt_id.clone(),
                                event_type: EventType::Departure,
                                line_number: route_short_name.clone(),
                                destination: headsign.clone(),
                                destination_id: last_stop.clone(),
                                planned_time: dep_dt.to_rfc3339(),
                                estimated_time: None,
                                delay_minutes: None,
                                platform: extract_platform_from_ifopt(ifopt_id),
                                trip_id: Some(trip_id.clone()),
                                cancelled: true,
                            });
                        }
                    }
                    if let Some(arr_secs) = st.arrival_time {
                        if let Some(arr_dt) = schedule_time_to_utc(arr_secs, service_date, tz) {
                            departures.entry(ifopt_id.clone()).or_default().push(Departure {
                                stop_ifopt: ifopt_id.clone(),
                                event_type: EventType::Arrival,
                                line_number: route_short_name.clone(),
                                destination: headsign.clone(),
                                destination_id: last_stop.clone(),
                                planned_time: arr_dt.to_rfc3339(),
                                estimated_time: None,
                                delay_minutes: None,
                                platform: extract_platform_from_ifopt(ifopt_id),
                                trip_id: Some(trip_id.clone()),
                                cancelled: true,
                            });
                        }
                    }
                }
            }
            continue; // Skip normal STU processing for this trip
        }

        // Trip-level delay as fallback
        let trip_delay = trip_update.delay.unwrap_or(0);
        let mut propagated_delay: i32 = trip_delay;

        for st in stop_times {
            // Find matching StopTimeUpdate
            let stu = stu_by_stop
                .get(st.stop_id.as_str())
                .or_else(|| stu_by_seq.get(&(st.stop_sequence as u32)))
                .copied();

            // Update propagated delay from this STU
            if let Some(stu) = stu {
                // Check if stop is skipped
                if stu.schedule_relationship() == StopSchedule::Skipped {
                    continue;
                }
                if let Some(dep) = &stu.departure {
                    if let Some(delay) = dep.delay {
                        propagated_delay = delay;
                    }
                } else if let Some(arr) = &stu.arrival {
                    if let Some(delay) = arr.delay {
                        propagated_delay = delay;
                    }
                }
            }

            // Resolve to IFOPTs and check relevance (one GTFS stop can map to multiple platforms)
            let relevant_ifopts: Vec<String> = if has_mapping {
                if let Some(ifopts) = schedule.gtfs_to_ifopt.get(&st.stop_id) {
                    ifopts.iter()
                        .filter(|ifopt| relevant_stop_ids.contains(*ifopt))
                        .cloned()
                        .collect()
                } else {
                    vec![]
                }
            } else {
                let relevant = relevant_stop_ids.contains(&st.stop_id)
                    || station_prefixes.contains(&station_level_ifopt(&st.stop_id));
                if relevant { vec![st.stop_id.clone()] } else { vec![] }
            };
            if relevant_ifopts.is_empty() {
                continue;
            }

            // Use departure_time as primary for window check, fall back to arrival_time
            let primary_secs = st.departure_time.or(st.arrival_time);
            let Some(primary_secs) = primary_secs else {
                continue;
            };
            let Some(primary_dt) = schedule_time_to_utc(primary_secs, service_date, tz) else {
                continue;
            };

            // Skip events too far in the past or beyond the time horizon.
            // 10-minute past window ensures vehicles near their final stops always
            // retain at least 2 stops (the departed + arriving stop), preventing
            // premature vehicle disappearance from the 2-stop minimum filter.
            if primary_dt < now - Duration::minutes(10) || primary_dt > cutoff {
                continue;
            }

            // Compute arrival/departure times once (shared across all mapped IFOPTs)
            let arr_event = if let Some(arr_secs) = st.arrival_time {
                schedule_time_to_utc(arr_secs, service_date, tz).map(|arr_planned_dt| {
                    let (arr_estimated_dt, arr_delay) = if let Some(stu) = stu {
                        compute_estimated_time_for_event(
                            stu.arrival.as_ref().or(stu.departure.as_ref()),
                            arr_planned_dt,
                            propagated_delay,
                        )
                    } else {
                        let est = arr_planned_dt + Duration::seconds(propagated_delay as i64);
                        let delay_min = if propagated_delay != 0 {
                            Some((propagated_delay as f64 / 60.0).round() as i32)
                        } else {
                            None
                        };
                        (Some(est), delay_min)
                    };
                    (arr_planned_dt, arr_estimated_dt, arr_delay)
                })
            } else {
                None
            };

            let dep_event = if let Some(dep_secs) = st.departure_time {
                schedule_time_to_utc(dep_secs, service_date, tz).map(|dep_planned_dt| {
                    let (dep_estimated_dt, dep_delay) = if let Some(stu) = stu {
                        compute_estimated_time_for_event(
                            stu.departure.as_ref().or(stu.arrival.as_ref()),
                            dep_planned_dt,
                            propagated_delay,
                        )
                    } else {
                        let est = dep_planned_dt + Duration::seconds(propagated_delay as i64);
                        let delay_min = if propagated_delay != 0 {
                            Some((propagated_delay as f64 / 60.0).round() as i32)
                        } else {
                            None
                        };
                        (Some(est), delay_min)
                    };
                    (dep_planned_dt, dep_estimated_dt, dep_delay)
                })
            } else {
                None
            };

            // Emit events for each mapped IFOPT (shared stops produce events for all platforms)
            for ifopt_id in &relevant_ifopts {
                if let Some((arr_planned_dt, arr_estimated_dt, arr_delay)) = &arr_event {
                    let arrival = Departure {
                        stop_ifopt: ifopt_id.clone(),
                        event_type: EventType::Arrival,
                        line_number: route_short_name.clone(),
                        destination: headsign.clone(),
                        destination_id: last_stop.clone(),
                        planned_time: arr_planned_dt.to_rfc3339(),
                        estimated_time: arr_estimated_dt.map(|dt| dt.to_rfc3339()),
                        delay_minutes: *arr_delay,
                        platform: extract_platform_from_ifopt(ifopt_id),
                        trip_id: Some(trip_id.clone()),
                        cancelled: trip_cancelled,
                    };
                    departures
                        .entry(ifopt_id.clone())
                        .or_default()
                        .push(arrival);
                }

                if let Some((dep_planned_dt, dep_estimated_dt, dep_delay)) = &dep_event {
                    let departure = Departure {
                        stop_ifopt: ifopt_id.clone(),
                        event_type: EventType::Departure,
                        line_number: route_short_name.clone(),
                        destination: headsign.clone(),
                        destination_id: last_stop.clone(),
                        planned_time: dep_planned_dt.to_rfc3339(),
                        estimated_time: dep_estimated_dt.map(|dt| dt.to_rfc3339()),
                        delay_minutes: *dep_delay,
                        platform: extract_platform_from_ifopt(ifopt_id),
                        trip_id: Some(trip_id.clone()),
                        cancelled: trip_cancelled,
                    };
                    departures
                        .entry(ifopt_id.clone())
                        .or_default()
                        .push(departure);
                }
            }
        }
    }

    debug!(
        total_updates,
        matched_trips,
        "Processed GTFS-RT TripUpdates"
    );

    // Collect trip_ids cancelled via Service Alerts (NO_SERVICE or UNKNOWN_EFFECT).
    // These alerts reference specific trips that should not operate.
    let cancelled_by_alert = collect_cancelled_trips_from_alerts(feed, schedule, now, tz);
    if !cancelled_by_alert.is_empty() {
        info!(
            cancelled_trips = cancelled_by_alert.len(),
            "Collected cancelled trips from GTFS-RT Service Alerts"
        );
    }

    // Mark any already-emitted departures for alert-cancelled trips,
    // but only if the trip has NO realtime data. A trip with live RT updates
    // (stop times, delays) that isn't trip-level CANCELED is actually running —
    // the alert is stale (e.g. leftover from a strike that has ended).
    for events in departures.values_mut() {
        for dep in events.iter_mut() {
            if let Some(ref tid) = dep.trip_id {
                if cancelled_by_alert.contains(tid.as_str()) && !trips_with_rt.contains(tid) {
                    dep.cancelled = true;
                }
            }
        }
    }

    // Also generate schedule-only departures for active trips without RT data
    add_scheduled_departures(
        &mut departures,
        schedule,
        relevant_stop_ids,
        &trips_with_rt,
        &cancelled_by_alert,
        today,
        now,
        cutoff,
        tz,
    );

    // If the time horizon crosses into the next day, also query tomorrow's services.
    let cutoff_date = cutoff.with_timezone(&tz).date_naive();
    if cutoff_date > today {
        let tomorrow = today.succ_opt().unwrap_or(today);
        add_scheduled_departures(
            &mut departures,
            schedule,
            relevant_stop_ids,
            &trips_with_rt,
            &cancelled_by_alert,
            tomorrow,
            now,
            cutoff,
            tz,
        );
    }

    // Sort each stop's departures by planned time
    for events in departures.values_mut() {
        events.sort_by(|a, b| a.planned_time.cmp(&b.planned_time));
    }

    departures
}

/// Add departures from the static schedule for trips that have no RT data.
///
/// Uses the IFOPT <-> GTFS mapping to translate between database IFOPTs
/// and GTFS numeric stop IDs. Falls back to direct ID matching if no mapping exists.
#[allow(clippy::too_many_arguments)]
fn add_scheduled_departures(
    departures: &mut HashMap<String, Vec<Departure>>,
    schedule: &GtfsSchedule,
    relevant_stop_ids: &HashSet<String>,
    trips_with_rt: &HashSet<String>,
    cancelled_by_alert: &HashSet<String>,
    today: NaiveDate,
    now: DateTime<Utc>,
    cutoff: DateTime<Utc>,
    tz: Tz,
) {
    let has_mapping = !schedule.ifopt_to_gtfs.is_empty();

    // Collect all trip_ids that visit our relevant stops
    let mut candidate_trips: HashSet<&str> = HashSet::new();

    if has_mapping {
        // Use the IFOPT -> GTFS mapping to find candidate trips
        for ifopt in relevant_stop_ids {
            for tid in schedule.trips_for_ifopt(ifopt) {
                if !trips_with_rt.contains(tid.as_str()) {
                    candidate_trips.insert(tid);
                }
            }
            // Also try station-level IFOPT
            let prefix = station_level_ifopt(ifopt);
            for tid in schedule.trips_for_ifopt(&prefix) {
                if !trips_with_rt.contains(tid.as_str()) {
                    candidate_trips.insert(tid);
                }
            }
        }
    } else {
        // Fallback: direct ID matching (for backwards compatibility)
        for stop_id in relevant_stop_ids {
            if let Some(trip_ids) = schedule.trips_by_stop.get(stop_id) {
                for tid in trip_ids {
                    if !trips_with_rt.contains(tid) {
                        candidate_trips.insert(tid);
                    }
                }
            }
        }
    }

    for trip_id in candidate_trips {
        let Some(trip) = schedule.trips.get(trip_id) else {
            continue;
        };

        // Check if service is active today
        if !schedule.is_service_active(&trip.service_id, today) {
            continue;
        }

        let is_cancelled = cancelled_by_alert.contains(trip_id);

        let Some(stop_times) = schedule.stop_times.get(trip_id) else {
            continue;
        };

        let route_short_name = schedule
            .routes
            .get(&trip.route_id)
            .and_then(|r| r.route_short_name.clone())
            .unwrap_or_default();

        let last_stop = schedule.last_stop_of_trip(trip_id);
        // Use trip headsign, falling back to last stop name if headsign is empty
        let headsign = trip
            .trip_headsign
            .as_ref()
            .filter(|h| !h.is_empty())
            .cloned()
            .or_else(|| schedule.last_stop_name_of_trip(trip_id))
            .unwrap_or_default();

        for st in stop_times {
            // Resolve to IFOPTs and check relevance (one GTFS stop can map to multiple platforms)
            let relevant_ifopts: Vec<String> = if has_mapping {
                if let Some(ifopts) = schedule.gtfs_to_ifopt.get(&st.stop_id) {
                    ifopts.iter()
                        .filter(|ifopt| {
                            let station_prefix = station_level_ifopt(ifopt);
                            relevant_stop_ids.contains(*ifopt)
                                || relevant_stop_ids.contains(&station_prefix)
                        })
                        .cloned()
                        .collect()
                } else {
                    vec![]
                }
            } else {
                let relevant = relevant_stop_ids.contains(&st.stop_id);
                if relevant { vec![st.stop_id.clone()] } else { vec![] }
            };

            if relevant_ifopts.is_empty() {
                continue;
            }

            // Use departure_time as the primary time for window checks,
            // falling back to arrival_time (e.g. last stop of trip)
            let primary_secs = st.departure_time.or(st.arrival_time);
            let Some(primary_secs) = primary_secs else {
                continue;
            };
            let Some(primary_dt) = schedule_time_to_utc(primary_secs, today, tz) else {
                continue;
            };

            // 10-minute past window (same as process_trip_updates) to ensure
            // vehicles near their final stops retain enough stop data.
            if primary_dt < now - Duration::minutes(10) || primary_dt > cutoff {
                continue;
            }

            // Compute arrival/departure times once
            let arr_dt = st.arrival_time.and_then(|s| schedule_time_to_utc(s, today, tz));
            let dep_dt = st.departure_time.and_then(|s| schedule_time_to_utc(s, today, tz));

            // Emit events for each mapped IFOPT
            for ifopt_id in &relevant_ifopts {
                if let Some(arr_dt) = arr_dt {
                    let arrival = Departure {
                        stop_ifopt: ifopt_id.clone(),
                        event_type: EventType::Arrival,
                        line_number: route_short_name.clone(),
                        destination: headsign.clone(),
                        destination_id: last_stop.clone(),
                        planned_time: arr_dt.to_rfc3339(),
                        estimated_time: None,
                        delay_minutes: None,
                        platform: extract_platform_from_ifopt(ifopt_id),
                        trip_id: Some(trip_id.to_string()),
                        cancelled: is_cancelled,
                    };
                    departures
                        .entry(ifopt_id.clone())
                        .or_default()
                        .push(arrival);
                }

                if let Some(dep_dt) = dep_dt {
                    let departure = Departure {
                        stop_ifopt: ifopt_id.clone(),
                        event_type: EventType::Departure,
                        line_number: route_short_name.clone(),
                        destination: headsign.clone(),
                        destination_id: last_stop.clone(),
                        planned_time: dep_dt.to_rfc3339(),
                        estimated_time: None,
                        delay_minutes: None,
                        platform: extract_platform_from_ifopt(ifopt_id),
                        trip_id: Some(trip_id.to_string()),
                        cancelled: is_cancelled,
                    };
                    departures
                        .entry(ifopt_id.clone())
                        .or_default()
                        .push(departure);
                }
            }
        }
    }
}

/// Compute departures from the static schedule for an arbitrary reference time.
///
/// This is used for time simulation queries where no real-time data is available.
/// Returns departures within `[reference_time - 2min, reference_time + time_horizon]`.
pub fn compute_schedule_departures(
    schedule: &GtfsSchedule,
    relevant_stop_ids: &HashSet<String>,
    reference_time: DateTime<Utc>,
    time_horizon: Duration,
    tz: Tz,
) -> HashMap<String, Vec<Departure>> {
    let mut departures: HashMap<String, Vec<Departure>> = HashMap::new();
    let cutoff = reference_time + time_horizon;

    let today = reference_time.with_timezone(&tz).date_naive();
    let cutoff_date = cutoff.with_timezone(&tz).date_naive();
    let trips_with_rt: HashSet<String> = HashSet::new();
    let no_cancellations: HashSet<String> = HashSet::new();

    add_scheduled_departures(
        &mut departures,
        schedule,
        relevant_stop_ids,
        &trips_with_rt,
        &no_cancellations,
        today,
        reference_time,
        cutoff,
        tz,
    );

    // If the time horizon crosses into the next day, also query tomorrow's services.
    // Without this, departures from services only active tomorrow would be missed
    // (e.g., querying at 23:00 with a horizon that extends past midnight).
    if cutoff_date > today {
        let tomorrow = today.succ_opt().unwrap_or(today);
        add_scheduled_departures(
            &mut departures,
            schedule,
            relevant_stop_ids,
            &trips_with_rt,
            &no_cancellations,
            tomorrow,
            reference_time,
            cutoff,
            tz,
        );
    }

    // Sort each stop's departures by planned time
    for events in departures.values_mut() {
        events.sort_by(|a, b| a.planned_time.cmp(&b.planned_time));
    }

    departures
}

/// Convert GTFS seconds-since-midnight + service date to UTC DateTime.
/// Handles times >= 24:00:00 (next day) and the configured timezone.
fn schedule_time_to_utc(seconds_since_midnight: i32, service_date: NaiveDate, tz: Tz) -> Option<DateTime<Utc>> {
    let total_secs = seconds_since_midnight;
    let hours = total_secs / 3600;
    let minutes = (total_secs % 3600) / 60;
    let secs = total_secs % 60;

    let (date, time) = if hours >= 24 {
        let next_day = service_date.succ_opt()?;
        let t = NaiveTime::from_hms_opt((hours - 24) as u32, minutes as u32, secs as u32)?;
        (next_day, t)
    } else {
        let t = NaiveTime::from_hms_opt(hours as u32, minutes as u32, secs as u32)?;
        (service_date, t)
    };

    let naive_dt = NaiveDateTime::new(date, time);

    // Convert from local time to UTC using configured timezone
    tz.from_local_datetime(&naive_dt)
        .earliest()
        .map(|dt| dt.with_timezone(&Utc))
}

/// Compute estimated time from a specific GTFS-RT StopTimeEvent (arrival or departure).
fn compute_estimated_time_for_event(
    event: Option<&gtfs_realtime::trip_update::StopTimeEvent>,
    planned_dt: DateTime<Utc>,
    propagated_delay: i32,
) -> (Option<DateTime<Utc>>, Option<i32>) {
    if let Some(event) = event {
        // If absolute time is provided, use it directly
        if let Some(time_unix) = event.time {
            if let Some(est) = DateTime::from_timestamp(time_unix, 0) {
                let delay_secs = (est - planned_dt).num_seconds();
                let delay_min = (delay_secs as f64 / 60.0).round() as i32;
                return (
                    Some(est),
                    if delay_min != 0 { Some(delay_min) } else { None },
                );
            }
        }
        // If delay is provided, add to planned time
        if let Some(delay_secs) = event.delay {
            let estimated = planned_dt + Duration::seconds(delay_secs as i64);
            let delay_min = (delay_secs as f64 / 60.0).round() as i32;
            return (
                Some(estimated),
                if delay_min != 0 { Some(delay_min) } else { None },
            );
        }
    }
    // Fall back to propagated delay — only produce an estimated time if there
    // is an actual non-zero delay to propagate; otherwise the departure is
    // schedule-only and should not appear as "live" in the frontend.
    if propagated_delay != 0 {
        let est = planned_dt + Duration::seconds(propagated_delay as i64);
        let delay_min = Some((propagated_delay as f64 / 60.0).round() as i32);
        (Some(est), delay_min)
    } else {
        (None, None)
    }
}

/// Parse GTFS-RT service date string "YYYYMMDD" to NaiveDate.
fn parse_service_date(s: &str) -> Option<NaiveDate> {
    if s.len() != 8 {
        return None;
    }
    let year: i32 = s[0..4].parse().ok()?;
    let month: u32 = s[4..6].parse().ok()?;
    let day: u32 = s[6..8].parse().ok()?;
    NaiveDate::from_ymd_opt(year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, Timelike};
    use chrono_tz::Europe::Berlin;

    // --- Helper to build a minimal GtfsSchedule for testing ---

    fn make_test_schedule() -> super::super::static_data::GtfsSchedule {
        use super::super::static_data::*;

        let mut stops = HashMap::new();
        stops.insert(
            "stop_A".to_string(),
            GtfsStop {
                stop_id: "stop_A".to_string(),
                stop_name: Some("Station A".to_string()),
                parent_station: Some("parent_A".to_string()),
                lat: Some(48.37),
                lon: Some(10.89),
            },
        );
        stops.insert(
            "stop_B".to_string(),
            GtfsStop {
                stop_id: "stop_B".to_string(),
                stop_name: Some("Station B".to_string()),
                parent_station: Some("parent_B".to_string()),
                lat: Some(48.38),
                lon: Some(10.90),
            },
        );

        let mut routes = HashMap::new();
        routes.insert(
            "route_1".to_string(),
            GtfsRoute {
                route_id: "route_1".to_string(),
                route_short_name: Some("1".to_string()),
                route_long_name: Some("Line 1".to_string()),
                route_type: Some(0),
            },
        );

        let mut trips = HashMap::new();
        trips.insert(
            "trip_100".to_string(),
            GtfsTrip {
                trip_id: "trip_100".to_string(),
                route_id: "route_1".to_string(),
                service_id: "weekday".to_string(),
                trip_headsign: Some("Destination City".to_string()),
                direction_id: Some(0),
            },
        );

        let mut stop_times = HashMap::new();
        // Trip departs stop_A at 08:00, arrives stop_B at 08:15
        stop_times.insert(
            "trip_100".to_string(),
            vec![
                GtfsStopTime {
                    stop_sequence: 1,
                    stop_id: "stop_A".to_string(),
                    arrival_time: Some(28800),  // 08:00
                    departure_time: Some(28800), // 08:00
                },
                GtfsStopTime {
                    stop_sequence: 2,
                    stop_id: "stop_B".to_string(),
                    arrival_time: Some(29700),  // 08:15
                    departure_time: Some(29700), // 08:15
                },
            ],
        );

        let mut calendars = HashMap::new();
        calendars.insert(
            "weekday".to_string(),
            GtfsCalendar {
                service_id: "weekday".to_string(),
                days: [true, true, true, true, true, false, false],
                start_date: NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
                end_date: NaiveDate::from_ymd_opt(2026, 12, 31).unwrap(),
            },
        );

        let mut trips_by_stop: HashMap<String, HashSet<String>> = HashMap::new();
        trips_by_stop
            .entry("stop_A".to_string())
            .or_default()
            .insert("trip_100".to_string());
        trips_by_stop
            .entry("stop_B".to_string())
            .or_default()
            .insert("trip_100".to_string());

        GtfsSchedule {
            stops,
            routes,
            trips,
            stop_times,
            calendars,
            calendar_dates: HashMap::new(),
            trips_by_stop,
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        }
    }

    fn make_feed_message(entities: Vec<gtfs_realtime::FeedEntity>) -> gtfs_realtime::FeedMessage {
        gtfs_realtime::FeedMessage {
            header: gtfs_realtime::FeedHeader {
                gtfs_realtime_version: "2.0".to_string(),
                incrementality: Some(0),
                timestamp: Some(1000000),
                feed_version: None,
            },
            entity: entities,
        }
    }

    fn make_trip_update_entity(
        entity_id: &str,
        trip_id: &str,
        stop_time_updates: Vec<gtfs_realtime::trip_update::StopTimeUpdate>,
    ) -> gtfs_realtime::FeedEntity {
        gtfs_realtime::FeedEntity {
            id: entity_id.to_string(),
            is_deleted: None,
            trip_update: Some(gtfs_realtime::TripUpdate {
                trip: gtfs_realtime::TripDescriptor {
                    trip_id: Some(trip_id.to_string()),
                    route_id: None,
                    direction_id: None,
                    start_time: None,
                    start_date: None,
                    schedule_relationship: None,
                    modified_trip: None,
                },
                vehicle: None,
                stop_time_update: stop_time_updates,
                timestamp: None,
                delay: None,
                trip_properties: None,
            }),
            vehicle: None,
            alert: None,
            shape: None,
            stop: None,
            trip_modifications: None,
        }
    }

    // --- schedule_time_to_utc tests ---

    #[test]
    fn test_schedule_time_to_utc() {
        let date = NaiveDate::from_ymd_opt(2026, 7, 15).unwrap();

        // 08:30:00 Berlin (summer = CEST = UTC+2) -> 06:30 UTC
        let dt = schedule_time_to_utc(30600, date, Berlin).unwrap();
        assert_eq!(dt.hour(), 6);
        assert_eq!(dt.minute(), 30);

        // 25:30:00 = next day 01:30 Berlin -> 2026-07-15 23:30 UTC
        let dt = schedule_time_to_utc(91800, date, Berlin).unwrap();
        assert_eq!(dt.day(), 15);
        assert_eq!(dt.hour(), 23);
        assert_eq!(dt.minute(), 30);
    }

    #[test]
    fn test_schedule_time_to_utc_winter() {
        let date = NaiveDate::from_ymd_opt(2026, 1, 15).unwrap();

        // 08:30:00 Berlin (winter = CET = UTC+1) -> 07:30 UTC
        let dt = schedule_time_to_utc(30600, date, Berlin).unwrap();
        assert_eq!(dt.hour(), 7);
        assert_eq!(dt.minute(), 30);
    }

    #[test]
    fn test_schedule_time_to_utc_midnight_boundary() {
        let date = NaiveDate::from_ymd_opt(2026, 3, 10).unwrap();

        // 00:00:00 Berlin (CET = UTC+1) -> 23:00 UTC previous day
        let dt = schedule_time_to_utc(0, date, Berlin).unwrap();
        assert_eq!(dt.day(), 9);
        assert_eq!(dt.hour(), 23);
        assert_eq!(dt.minute(), 0);
    }

    #[test]
    fn test_schedule_time_to_utc_dst_spring_forward() {
        // 2026-03-29: CET -> CEST (clocks forward at 02:00 to 03:00)
        let date = NaiveDate::from_ymd_opt(2026, 3, 29).unwrap();

        // 01:30 Berlin (still CET = UTC+1) -> 00:30 UTC
        let dt = schedule_time_to_utc(5400, date, Berlin).unwrap();
        assert_eq!(dt.hour(), 0);
        assert_eq!(dt.minute(), 30);

        // 03:30 Berlin (CEST = UTC+2) -> 01:30 UTC
        let dt = schedule_time_to_utc(12600, date, Berlin).unwrap();
        assert_eq!(dt.hour(), 1);
        assert_eq!(dt.minute(), 30);
    }

    #[test]
    fn test_schedule_time_to_utc_dst_fall_back() {
        // 2026-10-25: CEST -> CET (clocks back at 03:00 to 02:00)
        let date = NaiveDate::from_ymd_opt(2026, 10, 25).unwrap();

        // 01:30 Berlin (still CEST = UTC+2) -> 23:30 UTC (prev day)
        let dt = schedule_time_to_utc(5400, date, Berlin).unwrap();
        assert_eq!(dt.hour(), 23);
        assert_eq!(dt.day(), 24);

        // 04:00 Berlin (CET = UTC+1) -> 03:00 UTC
        let dt = schedule_time_to_utc(14400, date, Berlin).unwrap();
        assert_eq!(dt.hour(), 3);
    }

    #[test]
    fn test_schedule_time_to_utc_year_boundary_with_25h() {
        // 2025-12-31, trip at 25:30:00 = 2026-01-01 01:30 Berlin (CET = UTC+1) -> 00:30 UTC
        let date = NaiveDate::from_ymd_opt(2025, 12, 31).unwrap();
        let dt = schedule_time_to_utc(91800, date, Berlin).unwrap();
        assert_eq!(dt.year(), 2026);
        assert_eq!(dt.month(), 1);
        assert_eq!(dt.day(), 1);
        assert_eq!(dt.hour(), 0);
        assert_eq!(dt.minute(), 30);
    }

    #[test]
    fn test_schedule_time_to_utc_negative_returns_none() {
        let date = NaiveDate::from_ymd_opt(2026, 6, 15).unwrap();
        // Negative seconds shouldn't produce valid results
        // from_hms_opt with negative u32 wraps, so this should fail gracefully
        assert!(schedule_time_to_utc(-1, date, Berlin).is_none());
    }

    // --- parse_service_date tests ---

    #[test]
    fn test_parse_service_date() {
        assert_eq!(
            parse_service_date("20260201"),
            Some(NaiveDate::from_ymd_opt(2026, 2, 1).unwrap())
        );
        assert_eq!(parse_service_date("bad"), None);
        assert_eq!(parse_service_date(""), None);
        assert_eq!(parse_service_date("20261301"), None); // invalid month 13
        assert_eq!(parse_service_date("20260230"), None); // Feb 30
    }

    // --- compute_estimated_time_for_event tests ---

    #[test]
    fn test_compute_estimated_time_absolute_time() {
        let planned = DateTime::from_timestamp(1000000, 0).unwrap();
        let event = gtfs_realtime::trip_update::StopTimeEvent {
            delay: None,
            time: Some(1000120), // 2 minutes late
            uncertainty: None,
            scheduled_time: None,
        };
        let (est, delay) = compute_estimated_time_for_event(Some(&event), planned, 0);
        assert_eq!(est, DateTime::from_timestamp(1000120, 0));
        assert_eq!(delay, Some(2));
    }

    #[test]
    fn test_compute_estimated_time_delay() {
        let planned = DateTime::from_timestamp(1000000, 0).unwrap();
        let event = gtfs_realtime::trip_update::StopTimeEvent {
            delay: Some(180), // 3 minutes
            time: None,
            uncertainty: None,
            scheduled_time: None,
        };
        let (est, delay) = compute_estimated_time_for_event(Some(&event), planned, 0);
        assert_eq!(est, Some(planned + Duration::seconds(180)));
        assert_eq!(delay, Some(3));
    }

    #[test]
    fn test_compute_estimated_time_no_event_with_propagated_delay() {
        let planned = DateTime::from_timestamp(1000000, 0).unwrap();
        let (est, delay) = compute_estimated_time_for_event(None, planned, 120);
        assert_eq!(est, Some(planned + Duration::seconds(120)));
        assert_eq!(delay, Some(2));
    }

    #[test]
    fn test_compute_estimated_time_no_event_no_delay() {
        let planned = DateTime::from_timestamp(1000000, 0).unwrap();
        let (est, delay) = compute_estimated_time_for_event(None, planned, 0);
        // No realtime data and no propagated delay → schedule-only, no estimated time
        assert_eq!(est, None);
        assert_eq!(delay, None);
    }

    #[test]
    fn test_compute_estimated_time_absolute_takes_precedence_over_delay() {
        let planned = DateTime::from_timestamp(1000000, 0).unwrap();
        let event = gtfs_realtime::trip_update::StopTimeEvent {
            delay: Some(60),
            time: Some(1000300), // 5 minutes - absolute should win
            uncertainty: None,
            scheduled_time: None,
        };
        let (est, delay) = compute_estimated_time_for_event(Some(&event), planned, 0);
        assert_eq!(est, DateTime::from_timestamp(1000300, 0));
        assert_eq!(delay, Some(5));
    }

    // --- process_trip_updates tests ---

    #[test]
    fn test_process_trip_updates_with_matching_stops() {
        let schedule = make_test_schedule();
        let relevant = HashSet::from(["stop_A".to_string(), "stop_B".to_string()]);

        // Monday 2026-02-02 08:00 Berlin (CET) = 07:00 UTC
        let now = chrono::DateTime::parse_from_rfc3339("2026-02-02T07:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let stu_a = gtfs_realtime::trip_update::StopTimeUpdate {
            stop_sequence: Some(1),
            stop_id: Some("stop_A".to_string()),
            arrival: None,
            departure: Some(gtfs_realtime::trip_update::StopTimeEvent {
                delay: Some(120),
                time: None,
                uncertainty: None,
                scheduled_time: None,
            }),
            departure_occupancy_status: None,
            schedule_relationship: None,
            stop_time_properties: None,
        };

        let entity = make_trip_update_entity("e1", "trip_100", vec![stu_a]);
        let feed = make_feed_message(vec![entity]);

        let result = process_trip_updates(
            &feed,
            &schedule,
            &relevant,
            now,
            Duration::minutes(120),
            Berlin,
        );

        // Should have departures for stop_A
        assert!(result.contains_key("stop_A"));
        let stop_a_deps = &result["stop_A"];
        assert!(!stop_a_deps.is_empty());

        // Check that the departure has the right delay
        let dep = stop_a_deps
            .iter()
            .find(|d| d.event_type == EventType::Departure)
            .expect("Should have a departure event");
        assert_eq!(dep.delay_minutes, Some(2));
        assert_eq!(dep.line_number, "1");
        assert_eq!(dep.trip_id, Some("trip_100".to_string()));
    }

    #[test]
    fn test_process_trip_updates_empty_feed() {
        let schedule = make_test_schedule();
        let relevant = HashSet::from(["stop_A".to_string()]);

        let now = chrono::DateTime::parse_from_rfc3339("2026-02-02T07:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let feed = make_feed_message(vec![]);

        let result = process_trip_updates(
            &feed,
            &schedule,
            &relevant,
            now,
            Duration::minutes(120),
            Berlin,
        );

        // With empty feed, should still get schedule-only departures
        // (from add_scheduled_departures)
        let total: usize = result.values().map(|v| v.len()).sum();
        assert!(total > 0, "Should have schedule-based departures");
    }

    #[test]
    fn test_process_trip_updates_skipped_stop() {
        let schedule = make_test_schedule();
        let relevant = HashSet::from(["stop_A".to_string()]);

        let now = chrono::DateTime::parse_from_rfc3339("2026-02-02T07:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        // Mark stop_A as skipped (schedule_relationship = 1)
        let stu_a = gtfs_realtime::trip_update::StopTimeUpdate {
            stop_sequence: Some(1),
            stop_id: Some("stop_A".to_string()),
            arrival: None,
            departure: None,
            departure_occupancy_status: None,
            schedule_relationship: Some(StopSchedule::Skipped as i32),
            stop_time_properties: None,
        };

        let entity = make_trip_update_entity("e1", "trip_100", vec![stu_a]);
        let feed = make_feed_message(vec![entity]);

        let result = process_trip_updates(
            &feed,
            &schedule,
            &relevant,
            now,
            Duration::minutes(120),
            Berlin,
        );

        // stop_A should not have RT departure events for this trip
        // (the skipped stop is filtered out)
        if let Some(deps) = result.get("stop_A") {
            // If there are any, they should be schedule-only (no estimated time)
            // since the RT update marks it as skipped
            for dep in deps {
                if dep.trip_id.as_deref() == Some("trip_100") {
                    // Schedule-only departures have no estimated_time
                    assert!(dep.estimated_time.is_none());
                }
            }
        }
    }

    #[test]
    fn test_process_trip_updates_no_matching_stops() {
        let schedule = make_test_schedule();
        let relevant = HashSet::from(["non_existent_stop".to_string()]);

        let now = chrono::DateTime::parse_from_rfc3339("2026-02-02T07:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let entity = make_trip_update_entity("e1", "trip_100", vec![]);
        let feed = make_feed_message(vec![entity]);

        let result = process_trip_updates(
            &feed,
            &schedule,
            &relevant,
            now,
            Duration::minutes(120),
            Berlin,
        );

        assert!(result.is_empty() || !result.contains_key("non_existent_stop"));
    }

    #[test]
    fn test_process_trip_updates_inactive_service_day() {
        let schedule = make_test_schedule();
        let relevant = HashSet::from(["stop_A".to_string()]);

        // Saturday 2026-02-07 08:00 Berlin -> weekday service should be inactive
        let now = chrono::DateTime::parse_from_rfc3339("2026-02-07T07:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let entity = make_trip_update_entity("e1", "trip_100", vec![]);
        let feed = make_feed_message(vec![entity]);

        let result = process_trip_updates(
            &feed,
            &schedule,
            &relevant,
            now,
            Duration::minutes(120),
            Berlin,
        );

        // No departures on a Saturday for weekday-only service
        let total: usize = result.values().map(|v| v.len()).sum();
        assert_eq!(total, 0);
    }

    // --- compute_schedule_departures tests ---

    #[test]
    fn test_compute_schedule_departures_returns_results() {
        let schedule = make_test_schedule();
        let relevant = HashSet::from(["stop_A".to_string(), "stop_B".to_string()]);

        // Monday 2026-02-02 08:00 Berlin (CET) = 07:00 UTC
        let ref_time = chrono::DateTime::parse_from_rfc3339("2026-02-02T07:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let result = compute_schedule_departures(
            &schedule,
            &relevant,
            ref_time,
            Duration::minutes(120),
            Berlin,
        );

        assert!(result.contains_key("stop_A"));
        assert!(result.contains_key("stop_B"));
    }

    #[test]
    fn test_compute_schedule_departures_sorted_by_time() {
        let schedule = make_test_schedule();
        let relevant = HashSet::from(["stop_A".to_string(), "stop_B".to_string()]);

        let ref_time = chrono::DateTime::parse_from_rfc3339("2026-02-02T07:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let result = compute_schedule_departures(
            &schedule,
            &relevant,
            ref_time,
            Duration::minutes(120),
            Berlin,
        );

        // Departures within each stop should be sorted by planned_time
        for deps in result.values() {
            for window in deps.windows(2) {
                assert!(window[0].planned_time <= window[1].planned_time);
            }
        }
    }

    #[test]
    fn test_compute_schedule_departures_no_estimated_time() {
        let schedule = make_test_schedule();
        let relevant = HashSet::from(["stop_A".to_string()]);

        let ref_time = chrono::DateTime::parse_from_rfc3339("2026-02-02T07:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let result = compute_schedule_departures(
            &schedule,
            &relevant,
            ref_time,
            Duration::minutes(120),
            Berlin,
        );

        // Schedule-only departures should have no estimated_time or delay
        for deps in result.values() {
            for dep in deps {
                assert!(dep.estimated_time.is_none());
                assert!(dep.delay_minutes.is_none());
            }
        }
    }

    #[test]
    fn test_compute_schedule_departures_outside_horizon() {
        let schedule = make_test_schedule();
        let relevant = HashSet::from(["stop_A".to_string()]);

        // Set reference time far from the scheduled departure (08:00 Berlin = 07:00 UTC)
        // Reference at 12:00 UTC = 13:00 Berlin, with only 30 min horizon
        let ref_time = chrono::DateTime::parse_from_rfc3339("2026-02-02T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let result = compute_schedule_departures(
            &schedule,
            &relevant,
            ref_time,
            Duration::minutes(30),
            Berlin,
        );

        // 08:00 Berlin is well outside 12:00-12:30 Berlin window
        let total: usize = result.values().map(|v| v.len()).sum();
        assert_eq!(total, 0);
    }

    /// Helper to build a schedule where the trip has no headsign (empty string or None)
    fn make_test_schedule_no_headsign() -> super::super::static_data::GtfsSchedule {
        use super::super::static_data::*;

        let mut stops = HashMap::new();
        stops.insert(
            "stop_A".to_string(),
            GtfsStop {
                stop_id: "stop_A".to_string(),
                stop_name: Some("First Station".to_string()),
                parent_station: None,
                lat: Some(48.37),
                lon: Some(10.89),
            },
        );
        stops.insert(
            "stop_B".to_string(),
            GtfsStop {
                stop_id: "stop_B".to_string(),
                stop_name: Some("Final Destination".to_string()),
                parent_station: None,
                lat: Some(48.38),
                lon: Some(10.90),
            },
        );

        let mut routes = HashMap::new();
        routes.insert(
            "route_1".to_string(),
            GtfsRoute {
                route_id: "route_1".to_string(),
                route_short_name: Some("4".to_string()),
                route_long_name: Some("Line 4".to_string()),
                route_type: Some(0),
            },
        );

        let mut trips = HashMap::new();
        // Trip with NO headsign - should fall back to last stop name
        trips.insert(
            "trip_no_headsign".to_string(),
            GtfsTrip {
                trip_id: "trip_no_headsign".to_string(),
                route_id: "route_1".to_string(),
                service_id: "weekday".to_string(),
                trip_headsign: None, // No headsign!
                direction_id: Some(0),
            },
        );
        // Trip with empty headsign - should also fall back
        trips.insert(
            "trip_empty_headsign".to_string(),
            GtfsTrip {
                trip_id: "trip_empty_headsign".to_string(),
                route_id: "route_1".to_string(),
                service_id: "weekday".to_string(),
                trip_headsign: Some("".to_string()), // Empty headsign!
                direction_id: Some(0),
            },
        );

        let mut stop_times = HashMap::new();
        // Trip departs stop_A at 08:00, arrives stop_B at 08:15
        stop_times.insert(
            "trip_no_headsign".to_string(),
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
                    departure_time: Some(29700),
                },
            ],
        );
        stop_times.insert(
            "trip_empty_headsign".to_string(),
            vec![
                GtfsStopTime {
                    stop_sequence: 1,
                    stop_id: "stop_A".to_string(),
                    arrival_time: Some(32400), // 09:00
                    departure_time: Some(32400),
                },
                GtfsStopTime {
                    stop_sequence: 2,
                    stop_id: "stop_B".to_string(),
                    arrival_time: Some(33300), // 09:15
                    departure_time: Some(33300),
                },
            ],
        );

        let mut calendars = HashMap::new();
        calendars.insert(
            "weekday".to_string(),
            GtfsCalendar {
                service_id: "weekday".to_string(),
                days: [true, true, true, true, true, false, false],
                start_date: NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
                end_date: NaiveDate::from_ymd_opt(2026, 12, 31).unwrap(),
            },
        );

        let mut trips_by_stop: HashMap<String, HashSet<String>> = HashMap::new();
        trips_by_stop
            .entry("stop_A".to_string())
            .or_default()
            .insert("trip_no_headsign".to_string());
        trips_by_stop
            .entry("stop_A".to_string())
            .or_default()
            .insert("trip_empty_headsign".to_string());
        trips_by_stop
            .entry("stop_B".to_string())
            .or_default()
            .insert("trip_no_headsign".to_string());
        trips_by_stop
            .entry("stop_B".to_string())
            .or_default()
            .insert("trip_empty_headsign".to_string());

        GtfsSchedule {
            stops,
            routes,
            trips,
            stop_times,
            calendars,
            calendar_dates: HashMap::new(),
            trips_by_stop,
            ifopt_to_gtfs: HashMap::new(),
            gtfs_to_ifopt: HashMap::new(),
            loaded_at: chrono::Utc::now(),
        }
    }

    #[test]
    fn test_destination_falls_back_to_last_stop_when_headsign_missing() {
        let schedule = make_test_schedule_no_headsign();
        let relevant = HashSet::from(["stop_A".to_string()]);

        // Monday 2026-02-02 at 07:00 UTC = 08:00 Berlin (CET)
        let ref_time = chrono::DateTime::parse_from_rfc3339("2026-02-02T07:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let result = compute_schedule_departures(
            &schedule,
            &relevant,
            ref_time,
            Duration::minutes(180), // 3 hour horizon to catch both trips
            Berlin,
        );

        // Check departures at stop_A
        let departures = result.get("stop_A").expect("Should have departures for stop_A");

        // Find the departure for trip_no_headsign
        let dep_no_headsign = departures
            .iter()
            .find(|d| d.trip_id.as_deref() == Some("trip_no_headsign"))
            .expect("Should find departure for trip_no_headsign");

        // Destination should be the last stop name "Final Destination"
        assert_eq!(
            dep_no_headsign.destination, "Final Destination",
            "When headsign is None, destination should fall back to last stop name"
        );

        // Find the departure for trip_empty_headsign
        let dep_empty_headsign = departures
            .iter()
            .find(|d| d.trip_id.as_deref() == Some("trip_empty_headsign"))
            .expect("Should find departure for trip_empty_headsign");

        // Destination should also be the last stop name "Final Destination"
        assert_eq!(
            dep_empty_headsign.destination, "Final Destination",
            "When headsign is empty string, destination should fall back to last stop name"
        );
    }

    #[test]
    fn test_compute_schedule_departures_emits_arrival_and_departure_events() {
        let schedule = make_test_schedule();
        let relevant = HashSet::from(["stop_A".to_string(), "stop_B".to_string()]);

        // Monday 2026-02-02 08:00 Berlin (CET) = 07:00 UTC
        let ref_time = chrono::DateTime::parse_from_rfc3339("2026-02-02T07:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let result = compute_schedule_departures(
            &schedule,
            &relevant,
            ref_time,
            Duration::minutes(120),
            Berlin,
        );

        // Collect all events across all stops
        let all_events: Vec<&Departure> = result.values().flatten().collect();
        assert!(!all_events.is_empty(), "Should have schedule departures");

        let has_arrival = all_events.iter().any(|d| d.event_type == EventType::Arrival);
        let has_departure = all_events.iter().any(|d| d.event_type == EventType::Departure);

        assert!(
            has_arrival,
            "compute_schedule_departures should emit Arrival events"
        );
        assert!(
            has_departure,
            "compute_schedule_departures should emit Departure events"
        );

        // Verify that stop_A has both event types
        // (stop_A has both arrival_time and departure_time in the test schedule)
        let stop_a_events = result.get("stop_A").expect("stop_A should have events");
        let stop_a_arrivals: Vec<_> = stop_a_events
            .iter()
            .filter(|d| d.event_type == EventType::Arrival)
            .collect();
        let stop_a_departures: Vec<_> = stop_a_events
            .iter()
            .filter(|d| d.event_type == EventType::Departure)
            .collect();

        assert!(
            !stop_a_arrivals.is_empty(),
            "stop_A should have at least one Arrival event"
        );
        assert!(
            !stop_a_departures.is_empty(),
            "stop_A should have at least one Departure event"
        );
    }
}
