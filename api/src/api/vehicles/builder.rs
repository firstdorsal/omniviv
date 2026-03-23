use chrono::{DateTime, Duration, Utc};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};

use super::{StopInfo, Vehicle, VehicleStop};
use crate::api::schedule_cache::ScheduleCache;
use crate::providers::timetables::gtfs::realtime;
use crate::sync::{Departure, DepartureStore, EventType};

/// Collect departures for the given stops, filtered by line_ref, grouped by trip_id.
///
/// When `simulated_time` is `Some`, computes departures from the static GTFS schedule.
/// Otherwise reads real-time data from the departure store, falling back to the
/// schedule when the store has no data for these stops.
pub async fn collect_trip_departures(
    pool: &PgPool,
    departure_store: &DepartureStore,
    schedule_cache: &ScheduleCache,
    stop_ifopts: &[&str],
    line_ref: Option<&str>,
    simulated_time: Option<DateTime<Utc>>,
    time_horizon_minutes: u32,
    timezone: chrono_tz::Tz,
) -> HashMap<String, Vec<Departure>> {
    if let Some(ref_time) = simulated_time {
        collect_from_schedule(pool, schedule_cache, stop_ifopts, line_ref, ref_time, time_horizon_minutes, timezone).await
    } else {
        collect_from_realtime(pool, schedule_cache, departure_store, stop_ifopts, line_ref, time_horizon_minutes, timezone).await
    }
}

/// Like `collect_trip_departures` but takes a pre-read snapshot of the departure
/// store instead of acquiring the lock. Used by the WS handler which reads the
/// store once for all routes.
pub async fn collect_trip_departures_from_snapshot(
    pool: &PgPool,
    departure_snapshot: &HashMap<String, Vec<Departure>>,
    schedule_cache: &ScheduleCache,
    stop_ifopts: &[&str],
    line_ref: Option<&str>,
    simulated_time: Option<DateTime<Utc>>,
    time_horizon_minutes: u32,
    timezone: chrono_tz::Tz,
) -> HashMap<String, Vec<Departure>> {
    if let Some(ref_time) = simulated_time {
        collect_from_schedule(pool, schedule_cache, stop_ifopts, line_ref, ref_time, time_horizon_minutes, timezone).await
    } else {
        collect_from_realtime_snapshot(pool, schedule_cache, departure_snapshot, stop_ifopts, line_ref, time_horizon_minutes, timezone).await
    }
}

/// Filter departures by line_ref and group by trip_id.
fn filter_and_group(
    departures: &[Departure],
    line_ref: Option<&str>,
    result: &mut HashMap<String, Vec<Departure>>,
) {
    for departure in departures {
        let trip_id = match &departure.trip_id {
            Some(id) => id,
            None => continue,
        };
        if let Some(line) = line_ref {
            if departure.line_number != line {
                continue;
            }
        }
        result.entry(trip_id.clone()).or_default().push(departure.clone());
    }
}

async fn collect_from_schedule(
    pool: &PgPool,
    schedule_cache: &ScheduleCache,
    stop_ifopts: &[&str],
    line_ref: Option<&str>,
    ref_time: DateTime<Utc>,
    time_horizon_minutes: u32,
    timezone: chrono_tz::Tz,
) -> HashMap<String, Vec<Departure>> {
    let stop_ids: HashSet<String> = stop_ifopts.iter().map(|s| s.to_string()).collect();
    let schedule = match schedule_cache.get_or_build(pool, &stop_ids).await {
        Ok(s) => s,
        Err(_) => return HashMap::new(),
    };
    let time_horizon = Duration::minutes(time_horizon_minutes as i64);
    let all_departures = realtime::compute_schedule_departures(
        &schedule, &stop_ids, ref_time, time_horizon, timezone,
    );

    let mut result = HashMap::new();
    for ifopt in stop_ifopts {
        if let Some(departures) = all_departures.get(*ifopt) {
            filter_and_group(departures, line_ref, &mut result);
        }
    }
    result
}

async fn collect_from_realtime(
    pool: &PgPool,
    schedule_cache: &ScheduleCache,
    departure_store: &DepartureStore,
    stop_ifopts: &[&str],
    line_ref: Option<&str>,
    time_horizon_minutes: u32,
    timezone: chrono_tz::Tz,
) -> HashMap<String, Vec<Departure>> {
    let store = departure_store.read().await;
    let mut result = HashMap::new();

    for ifopt in stop_ifopts {
        if let Some(departures) = store.get(*ifopt) {
            filter_and_group(departures, line_ref, &mut result);
        }
    }
    drop(store);

    // Only supplement with schedule data when the RT store has NO data for
    // this route's stops. When the RT feed is active (even if all trips are
    // cancelled during a strike), it is the authority.
    if result.is_empty() {
        let stop_ids: HashSet<String> = stop_ifopts.iter().map(|s| s.to_string()).collect();
        if let Ok(schedule) = schedule_cache.get_or_build(pool, &stop_ids).await {
            let ref_time = Utc::now();
            let time_horizon = Duration::minutes(time_horizon_minutes as i64);
            let all_departures = realtime::compute_schedule_departures(
                &schedule, &stop_ids, ref_time, time_horizon, timezone,
            );

            for ifopt in stop_ifopts {
                if let Some(departures) = all_departures.get(*ifopt) {
                    filter_and_group(departures, line_ref, &mut result);
                }
            }
        }
    }

    result
}

/// Like `collect_from_realtime` but uses a pre-read snapshot instead of locking.
async fn collect_from_realtime_snapshot(
    pool: &PgPool,
    schedule_cache: &ScheduleCache,
    departure_snapshot: &HashMap<String, Vec<Departure>>,
    stop_ifopts: &[&str],
    line_ref: Option<&str>,
    time_horizon_minutes: u32,
    timezone: chrono_tz::Tz,
) -> HashMap<String, Vec<Departure>> {
    let mut result = HashMap::new();

    for ifopt in stop_ifopts {
        if let Some(departures) = departure_snapshot.get(*ifopt) {
            filter_and_group(departures, line_ref, &mut result);
        }
    }

    if result.is_empty() {
        let stop_ids: HashSet<String> = stop_ifopts.iter().map(|s| s.to_string()).collect();
        if let Ok(schedule) = schedule_cache.get_or_build(pool, &stop_ids).await {
            let ref_time = Utc::now();
            let time_horizon = Duration::minutes(time_horizon_minutes as i64);
            let all_departures = realtime::compute_schedule_departures(
                &schedule, &stop_ids, ref_time, time_horizon, timezone,
            );

            for ifopt in stop_ifopts {
                if let Some(departures) = all_departures.get(*ifopt) {
                    filter_and_group(departures, line_ref, &mut result);
                }
            }
        }
    }

    result
}

/// Build `Vehicle` structs from trip-grouped departures and stop info.
pub fn build_vehicles_from_departures(
    trip_departures: HashMap<String, Vec<Departure>>,
    stop_info_map: &HashMap<String, StopInfo>,
) -> Vec<Vehicle> {
    let mut vehicles: Vec<Vehicle> = trip_departures
        .into_iter()
        .filter_map(|(trip_id, departures)| {
            if departures.is_empty() {
                return None;
            }

            // Skip wholly cancelled trips — they should appear in departure monitors
            // (with strikethrough) but not as active vehicles on the map.
            if departures.iter().all(|d| d.cancelled) {
                return None;
            }

            let line_number = departures.first()?.line_number.clone();

            let destination = departures
                .iter()
                .find(|d| d.event_type == EventType::Departure)
                .map(|d| d.destination.clone())
                .or_else(|| departures.first().map(|d| d.destination.clone()))?;

            // For arrivals, destination field contains origin
            let origin = departures
                .iter()
                .find(|d| d.event_type == EventType::Arrival)
                .map(|d| d.destination.clone());

            // Group by stop to combine arrivals and departures
            let mut stop_events: HashMap<String, (Option<Departure>, Option<Departure>)> =
                HashMap::new();

            for departure in departures {
                let entry = stop_events.entry(departure.stop_ifopt.clone()).or_default();
                match departure.event_type {
                    EventType::Arrival => entry.0 = Some(departure),
                    EventType::Departure => entry.1 = Some(departure),
                }
            }

            let mut stops: Vec<VehicleStop> = stop_events
                .into_iter()
                .filter_map(|(stop_ifopt, (arrival, departure))| {
                    let info = stop_info_map.get(&stop_ifopt)?;

                    let delay_minutes = departure
                        .as_ref()
                        .and_then(|d| d.delay_minutes)
                        .or_else(|| arrival.as_ref().and_then(|a| a.delay_minutes));

                    Some(VehicleStop {
                        stop_ifopt,
                        stop_name: info.name.clone(),
                        sequence: info.sequence,
                        lat: info.lat,
                        lon: info.lon,
                        arrival_time: arrival.as_ref().map(|a| a.planned_time),
                        arrival_time_estimated: arrival.as_ref().and_then(|a| a.estimated_time),
                        departure_time: departure.as_ref().map(|d| d.planned_time),
                        departure_time_estimated: departure.as_ref().and_then(|d| d.estimated_time),
                        delay_minutes,
                    })
                })
                .collect();

            stops.sort_by_key(|s| s.sequence);

            if stops.len() < 2 {
                return None;
            }

            Some(Vehicle {
                trip_id,
                line_number,
                destination,
                origin,
                stops,
                next_trip_id: None,
            })
        })
        .collect();

    super::link_consecutive_trips(&mut vehicles);

    vehicles
}
