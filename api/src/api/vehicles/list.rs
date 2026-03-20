use axum::{extract::State, http::StatusCode, Json};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::collections::{HashMap, HashSet};
use utoipa::ToSchema;

use super::VehiclesState;
use crate::api::ErrorResponse;
use crate::providers::timetables::gtfs::{realtime, static_data};
use crate::sync::{Departure, EventType};

#[derive(Debug, Deserialize, ToSchema)]
pub struct VehiclesByRouteRequest {
    /// The OSM route ID to get vehicles for
    pub route_id: i64,
    /// Optional reference time (ISO 8601/RFC 3339) for time simulation.
    /// When provided, departures are computed from the static GTFS schedule.
    pub reference_time: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct VehiclesByRouteResponse {
    pub route_id: i64,
    pub line_number: Option<String>,
    pub vehicles: Vec<Vehicle>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct Vehicle {
    /// Unique trip identifier (GTFS trip_id)
    pub trip_id: String,
    /// Line number (e.g., "1", "2", "3")
    pub line_number: String,
    /// Final destination of this vehicle
    pub destination: String,
    /// Origin of this vehicle's journey
    pub origin: Option<String>,
    /// All stops this vehicle will visit, in order
    pub stops: Vec<VehicleStop>,
    /// The trip_id of the next trip this physical vehicle will operate.
    /// Set when the vehicle loops back (e.g., tram reaching end of line
    /// and starting the return trip). Used for seamless follow-mode
    /// transitions and vehicle reuse rendering.
    pub next_trip_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct VehicleStop {
    /// Stop IFOPT identifier
    pub stop_ifopt: String,
    /// Stop name (if available)
    pub stop_name: Option<String>,
    /// Sequence number on the route
    pub sequence: i32,
    /// Latitude
    pub lat: f64,
    /// Longitude
    pub lon: f64,
    /// Arrival time at this stop (ISO 8601)
    pub arrival_time: Option<String>,
    /// Estimated arrival time (real-time, if available)
    pub arrival_time_estimated: Option<String>,
    /// Departure time from this stop (ISO 8601)
    pub departure_time: Option<String>,
    /// Estimated departure time (real-time, if available)
    pub departure_time_estimated: Option<String>,
    /// Delay in minutes (positive = late, negative = early)
    pub delay_minutes: Option<i32>,
}

#[derive(Debug, FromRow)]
struct RouteStopInfo {
    sequence: i32,
    stop_ifopt: Option<String>,
    stop_name: Option<String>,
    lat: Option<f64>,
    lon: Option<f64>,
}

#[derive(Debug, FromRow)]
struct RouteInfo {
    line_ref: Option<String>,
}

/// Maximum time gap (minutes) between a trip's last arrival and the next trip's
/// first departure for them to be considered the same physical vehicle.
const TRIP_LINK_MAX_GAP_MINUTES: i64 = 15;

use crate::api::utils::ifopt_station_prefix;

/// Link consecutive trips that represent the same physical vehicle looping back.
/// Sets `next_trip_id` on a trip when the next trip on the same line starts at
/// the same station where this trip ends, within a short time window.
pub fn link_consecutive_trips(vehicles: &mut [Vehicle]) {
    // Sort by first departure time
    vehicles.sort_by(|a, b| {
        let time_a = a.stops.first().and_then(|s| s.departure_time.as_ref());
        let time_b = b.stops.first().and_then(|s| s.departure_time.as_ref());
        time_a.cmp(&time_b)
    });

    // For each vehicle, try to find its successor
    let n = vehicles.len();
    // Collect linking info first to avoid borrow issues
    let mut links: Vec<(usize, String)> = Vec::new();

    for i in 0..n {
        let last_stop = match vehicles[i].stops.last() {
            Some(s) => s,
            None => continue,
        };
        let last_arrival = match &last_stop.arrival_time {
            Some(t) => t.clone(),
            None => continue,
        };
        let last_station = match ifopt_station_prefix(&last_stop.stop_ifopt) {
            Some(p) => p.to_string(),
            None => continue,
        };
        let line = &vehicles[i].line_number;

        // Search forward for the earliest matching successor
        for j in (i + 1)..n {
            if &vehicles[j].line_number != line {
                continue;
            }
            let first_stop = match vehicles[j].stops.first() {
                Some(s) => s,
                None => continue,
            };
            let first_departure = match &first_stop.departure_time {
                Some(t) => t,
                None => continue,
            };
            let first_station = match ifopt_station_prefix(&first_stop.stop_ifopt) {
                Some(p) => p,
                None => continue,
            };

            // Same station?
            if first_station != last_station {
                continue;
            }

            // Time gap check
            if let (Ok(end_time), Ok(start_time)) = (
                chrono::DateTime::parse_from_rfc3339(&last_arrival),
                chrono::DateTime::parse_from_rfc3339(first_departure),
            ) {
                let gap = start_time.signed_duration_since(end_time).num_minutes();
                if gap >= 0 && gap <= TRIP_LINK_MAX_GAP_MINUTES {
                    links.push((i, vehicles[j].trip_id.clone()));
                    break;
                }
            }
        }
    }

    // Apply links
    for (idx, next_id) in links {
        vehicles[idx].next_trip_id = Some(next_id);
    }
}

/// Get all vehicles currently on a route with their stop sequences
#[utoipa::path(
    post,
    path = "/api/vehicles/by-route",
    request_body = VehiclesByRouteRequest,
    responses(
        (status = 200, description = "List of vehicles on the route", body = VehiclesByRouteResponse),
        (status = 404, description = "Route not found", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    ),
    tag = "vehicles"
)]
pub async fn get_vehicles_by_route(
    State(state): State<VehiclesState>,
    Json(request): Json<VehiclesByRouteRequest>,
) -> Result<Json<VehiclesByRouteResponse>, (StatusCode, Json<ErrorResponse>)> {
    // Get route info
    let route_info: Option<RouteInfo> = sqlx::query_as(
        "SELECT ref as line_ref FROM routes WHERE osm_id = $1",
    )
    .bind(request.route_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Database error: {}", e),
            }),
        )
    })?;

    let route_info = route_info.ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Route not found".to_string(),
            }),
        )
    })?;

    // Get all stops on this route with their IFOPTs and coordinates
    let route_stops: Vec<RouteStopInfo> = sqlx::query_as(
        r#"
        SELECT
            rs.sequence,
            COALESCE(sp.ref_ifopt, p.ref_ifopt, st.ref_ifopt) as stop_ifopt,
            COALESCE(sp.name, p.name, st.name) as stop_name,
            COALESCE(sp.lat, p.lat, st.lat) as lat,
            COALESCE(sp.lon, p.lon, st.lon) as lon
        FROM route_stops rs
        LEFT JOIN stop_positions sp ON rs.stop_position_id = sp.osm_id
        LEFT JOIN platforms p ON rs.platform_id = p.osm_id
        LEFT JOIN stations st ON rs.station_id = st.osm_id
        WHERE rs.route_id = $1
        ORDER BY rs.sequence
        "#,
    )
    .bind(request.route_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Database error: {}", e),
            }),
        )
    })?;

    // Build a map of stop_ifopt -> (sequence, name, lat, lon)
    let stop_info_map: HashMap<String, (i32, Option<String>, f64, f64)> = route_stops
        .iter()
        .filter_map(|s| {
            let ifopt = s.stop_ifopt.as_ref()?;
            let lat = s.lat?;
            let lon = s.lon?;
            Some((ifopt.clone(), (s.sequence, s.stop_name.clone(), lat, lon)))
        })
        .collect();

    let stop_ifopts: Vec<&str> = stop_info_map.keys().map(|s| s.as_str()).collect();

    if stop_ifopts.is_empty() {
        return Ok(Json(VehiclesByRouteResponse {
            route_id: request.route_id,
            line_number: route_info.line_ref,
            vehicles: vec![],
        }));
    }

    // Determine if we're using simulated time
    let simulated_time = parse_reference_time(&request.reference_time);

    // Get departures either from the store (real-time) or schedule (simulated time)
    let trip_departures: HashMap<String, Vec<Departure>> = if let Some(ref_time) = simulated_time {
        // Compute departures from static schedule (loaded from PG) for the simulated time
        let stop_ids: HashSet<String> = stop_ifopts.iter().map(|s| s.to_string()).collect();
        match static_data::build_schedule_from_db(&state.pool, &stop_ids).await {
            Ok(schedule) => {
                let time_horizon = Duration::minutes(state.time_horizon_minutes as i64);
                let all_departures = realtime::compute_schedule_departures(
                    &schedule,
                    &stop_ids,
                    ref_time,
                    time_horizon,
                    state.timezone,
                );

                let mut result: HashMap<String, Vec<Departure>> = HashMap::new();
                for ifopt in &stop_ifopts {
                    if let Some(departures) = all_departures.get(*ifopt) {
                        for dep in departures {
                            let trip_id = match &dep.trip_id {
                                Some(id) => id,
                                None => continue,
                            };
                            if let Some(ref line_ref) = route_info.line_ref {
                                if &dep.line_number != line_ref {
                                    continue;
                                }
                            }
                            result.entry(trip_id.clone()).or_default().push(dep.clone());
                        }
                    }
                }
                result
            }
            Err(_) => HashMap::new(),
        }
    } else {
        // Start with real-time departure store (has estimated times and delays)
        let store = state.departure_store.read().await;
        let mut result: HashMap<String, Vec<Departure>> = HashMap::new();

        for ifopt in &stop_ifopts {
            if let Some(departures) = store.get(*ifopt) {
                for dep in departures {
                    let trip_id = match &dep.trip_id {
                        Some(id) => id,
                        None => continue,
                    };
                    if let Some(ref line_ref) = route_info.line_ref {
                        if &dep.line_number != line_ref {
                            continue;
                        }
                    }
                    result.entry(trip_id.clone()).or_default().push(dep.clone());
                }
            }
        }
        drop(store);

        // Only supplement with schedule data when the RT store has NO data for
        // this route's stops.  When the RT feed is active (even if all trips are
        // cancelled during a strike), it is the authority — trips absent from the
        // feed should not appear as vehicles on the map.
        if result.is_empty() {
            let stop_ids: HashSet<String> = stop_ifopts.iter().map(|s| s.to_string()).collect();
            if let Ok(schedule) = static_data::build_schedule_from_db(&state.pool, &stop_ids).await {
                let ref_time = Utc::now();
                let time_horizon = Duration::minutes(state.time_horizon_minutes as i64);
                let all_departures = realtime::compute_schedule_departures(
                    &schedule,
                    &stop_ids,
                    ref_time,
                    time_horizon,
                    state.timezone,
                );

                for ifopt in &stop_ifopts {
                    if let Some(departures) = all_departures.get(*ifopt) {
                        for dep in departures {
                            let trip_id = match &dep.trip_id {
                                Some(id) => id,
                                None => continue,
                            };
                            if let Some(ref line_ref) = route_info.line_ref {
                                if &dep.line_number != line_ref {
                                    continue;
                                }
                            }
                            result.entry(trip_id.clone()).or_default().push(dep.clone());
                        }
                    }
                }
            }
        }

        result
    };

    // Build vehicles from grouped departures
    let mut vehicles: Vec<Vehicle> = trip_departures
        .into_iter()
        .filter_map(|(trip_id, departures)| {
            if departures.is_empty() {
                return None;
            }

            // Skip cancelled trips — they should appear in departure monitors
            // (with strikethrough) but not as active vehicles on the map.
            if departures.iter().any(|d| d.cancelled) {
                return None;
            }

            // Get line number from first departure
            let line_number = departures.first()?.line_number.clone();

            // Find destination (from departures) and origin (from arrivals)
            let destination = departures
                .iter()
                .find(|d| d.event_type == EventType::Departure)
                .map(|d| d.destination.clone())
                .or_else(|| departures.first().map(|d| d.destination.clone()))?;

            let origin = departures
                .iter()
                .find(|d| d.event_type == EventType::Arrival)
                .map(|d| d.destination.clone()); // For arrivals, destination field contains origin

            // Group by stop to combine arrivals and departures
            let mut stop_events: HashMap<String, (Option<Departure>, Option<Departure>)> =
                HashMap::new();

            for dep in departures {
                let entry = stop_events.entry(dep.stop_ifopt.clone()).or_default();
                match dep.event_type {
                    EventType::Arrival => entry.0 = Some(dep),
                    EventType::Departure => entry.1 = Some(dep),
                }
            }

            // Build vehicle stops
            let mut stops: Vec<VehicleStop> = stop_events
                .into_iter()
                .filter_map(|(stop_ifopt, (arrival, departure))| {
                    let (sequence, stop_name, lat, lon) = stop_info_map.get(&stop_ifopt)?;

                    // Get delay from whichever event is available
                    let delay_minutes = departure
                        .as_ref()
                        .and_then(|d| d.delay_minutes)
                        .or_else(|| arrival.as_ref().and_then(|a| a.delay_minutes));

                    Some(VehicleStop {
                        stop_ifopt,
                        stop_name: stop_name.clone(),
                        sequence: *sequence,
                        lat: *lat,
                        lon: *lon,
                        arrival_time: arrival.as_ref().map(|a| a.planned_time.clone()),
                        arrival_time_estimated: arrival.as_ref().and_then(|a| a.estimated_time.clone()),
                        departure_time: departure.as_ref().map(|d| d.planned_time.clone()),
                        departure_time_estimated: departure.as_ref().and_then(|d| d.estimated_time.clone()),
                        delay_minutes,
                    })
                })
                .collect();

            // Sort stops by sequence
            stops.sort_by_key(|s| s.sequence);

            // Need at least 2 stops to show a moving vehicle
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

    // Link consecutive trips on the same line that represent the same physical
    // vehicle looping back (e.g., tram at end of line starting the return trip).
    link_consecutive_trips(&mut vehicles);

    // Sort vehicles by their first stop's departure time
    vehicles.sort_by(|a, b| {
        let time_a = a.stops.first().and_then(|s| s.departure_time.as_ref());
        let time_b = b.stops.first().and_then(|s| s.departure_time.as_ref());
        time_a.cmp(&time_b)
    });

    Ok(Json(VehiclesByRouteResponse {
        route_id: request.route_id,
        line_number: route_info.line_ref,
        vehicles,
    }))
}

use crate::api::utils::parse_reference_time;

#[cfg(test)]
mod tests {
    use super::*;

    fn make_vehicle(trip_id: &str, line: &str, first_ifopt: &str, first_dep: &str, last_ifopt: &str, last_arr: &str) -> Vehicle {
        Vehicle {
            trip_id: trip_id.to_string(),
            line_number: line.to_string(),
            destination: "Test".to_string(),
            origin: None,
            next_trip_id: None,
            stops: vec![
                VehicleStop {
                    stop_ifopt: first_ifopt.to_string(),
                    stop_name: None,
                    sequence: 1,
                    lat: 48.37, lon: 10.90,
                    arrival_time: None,
                    arrival_time_estimated: None,
                    departure_time: Some(first_dep.to_string()),
                    departure_time_estimated: None,
                    delay_minutes: None,
                },
                VehicleStop {
                    stop_ifopt: last_ifopt.to_string(),
                    stop_name: None,
                    sequence: 10,
                    lat: 48.37, lon: 10.90,
                    arrival_time: Some(last_arr.to_string()),
                    arrival_time_estimated: None,
                    departure_time: None,
                    departure_time_estimated: None,
                    delay_minutes: None,
                },
            ],
        }
    }

    #[test]
    fn links_same_line_same_station_within_gap() {
        let mut vehicles = vec![
            make_vehicle("trip1", "4", "de:09761:10:1:A3", "2026-03-20T08:00:00Z", "de:09761:20:1:B1", "2026-03-20T08:30:00Z"),
            make_vehicle("trip2", "4", "de:09761:20:1:B2", "2026-03-20T08:35:00Z", "de:09761:10:1:A4", "2026-03-20T09:05:00Z"),
        ];
        link_consecutive_trips(&mut vehicles);
        assert_eq!(vehicles[0].next_trip_id.as_deref(), Some("trip2"));
        assert_eq!(vehicles[1].next_trip_id, None);
    }

    #[test]
    fn no_link_different_lines() {
        let mut vehicles = vec![
            make_vehicle("trip1", "4", "de:09761:10:1:A3", "2026-03-20T08:00:00Z", "de:09761:20:1:B1", "2026-03-20T08:30:00Z"),
            make_vehicle("trip2", "6", "de:09761:20:1:B2", "2026-03-20T08:35:00Z", "de:09761:10:1:A4", "2026-03-20T09:05:00Z"),
        ];
        link_consecutive_trips(&mut vehicles);
        assert_eq!(vehicles[0].next_trip_id, None);
    }

    #[test]
    fn no_link_different_stations() {
        let mut vehicles = vec![
            make_vehicle("trip1", "4", "de:09761:10:1:A3", "2026-03-20T08:00:00Z", "de:09761:20:1:B1", "2026-03-20T08:30:00Z"),
            make_vehicle("trip2", "4", "de:09761:30:1:C1", "2026-03-20T08:35:00Z", "de:09761:10:1:A4", "2026-03-20T09:05:00Z"),
        ];
        link_consecutive_trips(&mut vehicles);
        assert_eq!(vehicles[0].next_trip_id, None);
    }

    #[test]
    fn no_link_gap_too_large() {
        let mut vehicles = vec![
            make_vehicle("trip1", "4", "de:09761:10:1:A3", "2026-03-20T08:00:00Z", "de:09761:20:1:B1", "2026-03-20T08:30:00Z"),
            make_vehicle("trip2", "4", "de:09761:20:1:B2", "2026-03-20T08:50:00Z", "de:09761:10:1:A4", "2026-03-20T09:20:00Z"),
        ];
        link_consecutive_trips(&mut vehicles);
        // 20 min gap > 15 min threshold
        assert_eq!(vehicles[0].next_trip_id, None);
    }

    #[test]
    fn single_vehicle_no_link() {
        let mut vehicles = vec![
            make_vehicle("trip1", "4", "de:09761:10:1:A3", "2026-03-20T08:00:00Z", "de:09761:20:1:B1", "2026-03-20T08:30:00Z"),
        ];
        link_consecutive_trips(&mut vehicles);
        assert_eq!(vehicles[0].next_trip_id, None);
    }

    #[test]
    fn link_at_exactly_15_min_boundary() {
        let mut vehicles = vec![
            make_vehicle("trip1", "4", "de:09761:10:1:A3", "2026-03-20T08:00:00Z", "de:09761:20:1:B1", "2026-03-20T08:30:00Z"),
            make_vehicle("trip2", "4", "de:09761:20:1:B2", "2026-03-20T08:45:00Z", "de:09761:10:1:A4", "2026-03-20T09:15:00Z"),
        ];
        link_consecutive_trips(&mut vehicles);
        // Exactly 15 min gap — should link (gap <= 15)
        assert_eq!(vehicles[0].next_trip_id.as_deref(), Some("trip2"));
    }
}
