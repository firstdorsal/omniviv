use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::collections::HashMap;
use utoipa::ToSchema;

use crate::api::state::AppState;
use crate::api::{ErrorResponse, error::internal_error};
use crate::api::utils::parse_reference_time;

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

#[derive(Debug, Clone, FromRow)]
pub struct RouteStopInfo {
    pub sequence: i32,
    pub stop_ifopt: Option<String>,
    pub stop_name: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
}

#[derive(Debug, FromRow)]
pub struct RouteInfo {
    pub line_ref: Option<String>,
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
    State(state): State<AppState>,
    Json(request): Json<VehiclesByRouteRequest>,
) -> Result<Json<VehiclesByRouteResponse>, (StatusCode, Json<ErrorResponse>)> {
    // Get route info
    let route_info: Option<RouteInfo> = sqlx::query_as(
        "SELECT ref as line_ref FROM routes WHERE osm_id = $1",
    )
    .bind(request.route_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(internal_error)?;

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
    .map_err(internal_error)?;

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

    let simulated_time = parse_reference_time(&request.reference_time);

    let trip_departures = super::builder::collect_trip_departures(
        &state.pool,
        &state.departure_store,
        &state.schedule_cache,
        &stop_ifopts,
        route_info.line_ref.as_deref(),
        simulated_time,
        state.time_horizon_minutes,
        state.timezone,
    ).await;

    let vehicles = super::builder::build_vehicles_from_departures(trip_departures, &stop_info_map);

    Ok(Json(VehiclesByRouteResponse {
        route_id: request.route_id,
        line_number: route_info.line_ref,
        vehicles,
    }))
}

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
