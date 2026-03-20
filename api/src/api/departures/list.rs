use axum::{extract::State, Json};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use utoipa::ToSchema;

use crate::api::ErrorResponse;
use crate::providers::timetables::gtfs::{realtime, static_data};
use crate::sync::Departure;

use super::DeparturesState;

/// How many minutes of past departures to keep so that recent arrivals remain visible.
const PAST_GRACE_MINUTES: i64 = 5;

/// Per-stop board queries use a longer time horizon than the main departure list
/// so that events for the rest of the day (and into the next morning) are visible.
const STOP_BOARD_HORIZON_MINUTES: i64 = 720; // 12 hours

use crate::api::utils::ifopt_station_prefix;

/// Filter out departures whose destination is the same station as the queried stop.
/// E.g. Line 4 "towards Hauptbahnhof" should not appear at Hauptbahnhof's departure monitor.
fn filter_same_station_destinations(departures: Vec<Departure>, stop_ifopt: &str) -> Vec<Departure> {
    let station_prefix = match ifopt_station_prefix(stop_ifopt) {
        Some(p) => p,
        None => return departures,
    };
    departures
        .into_iter()
        .filter(|d| {
            match &d.destination_id {
                Some(dest_id) => ifopt_station_prefix(dest_id) != Some(station_prefix),
                None => true,
            }
        })
        .collect()
}

/// Filter out departures that are too far in the past relative to the given reference time.
/// Departures within [`PAST_GRACE_MINUTES`] of the reference time are kept.
fn filter_past_departures(departures: Vec<Departure>, reference_time: DateTime<Utc>) -> Vec<Departure> {
    let cutoff = reference_time - Duration::minutes(PAST_GRACE_MINUTES);
    departures
        .into_iter()
        .filter(|d| {
            // Use estimated time if available, otherwise planned time
            let time_str = d.estimated_time.as_ref().unwrap_or(&d.planned_time);
            match chrono::DateTime::parse_from_rfc3339(time_str) {
                Ok(time) => time > cutoff,
                Err(_) => true, // Keep if we can't parse the time
            }
        })
        .collect()
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DepartureListResponse {
    pub departures: Vec<Departure>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct StopDeparturesRequest {
    pub stop_ifopt: String,
    /// Optional reference time (ISO 8601/RFC 3339) for time simulation.
    /// When provided, departures are computed from the static GTFS schedule
    /// around this time instead of using live real-time data.
    pub reference_time: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct StopDeparturesResponse {
    pub stop_ifopt: String,
    pub departures: Vec<Departure>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct GtfsStopDeparturesRequest {
    pub gtfs_stop_id: String,
    /// Optional reference time (ISO 8601/RFC 3339) for time simulation.
    pub reference_time: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct GtfsStopDeparturesResponse {
    pub gtfs_stop_id: String,
    pub departures: Vec<Departure>,
}

use crate::api::utils::parse_reference_time;

/// List all departures across all stops
#[utoipa::path(
    get,
    path = "/api/departures",
    responses(
        (status = 200, description = "List of all departures", body = DepartureListResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    ),
    tag = "departures"
)]
pub async fn list_departures(
    State(state): State<DeparturesState>,
) -> Json<DepartureListResponse> {
    let store = state.departure_store.read().await;
    let departures: Vec<Departure> = store.values().flatten().cloned().collect();
    let departures = filter_past_departures(departures, Utc::now());
    Json(DepartureListResponse { departures })
}

/// Get departures for a specific stop by IFOPT ID
#[utoipa::path(
    post,
    path = "/api/departures/by-stop",
    request_body = StopDeparturesRequest,
    responses(
        (status = 200, description = "Departures for the stop", body = StopDeparturesResponse),
        (status = 400, description = "Bad request", body = ErrorResponse)
    ),
    tag = "departures"
)]
pub async fn get_departures_by_stop(
    State(state): State<DeparturesState>,
    Json(request): Json<StopDeparturesRequest>,
) -> Json<StopDeparturesResponse> {
    let simulated_time = parse_reference_time(&request.reference_time);

    let ref_time = simulated_time.unwrap_or_else(Utc::now);

    // Always compute schedule-based departures with the longer stop board horizon
    // so the popup shows upcoming events even when the real-time feed has no data
    // (e.g., late at night when trams have stopped running).
    let mut stop_ids = HashSet::new();
    stop_ids.insert(request.stop_ifopt.clone());

    let mut departures = if simulated_time.is_none() {
        // Start with real-time departure store (has estimated times and delays)
        let store = state.departure_store.read().await;
        store.get(&request.stop_ifopt).cloned().unwrap_or_default()
    } else {
        Vec::new()
    };

    // Supplement with schedule-based departures to fill the 12-hour window.
    // This adds trips that aren't in the real-time store (e.g., next morning).
    match static_data::build_schedule_from_db(&state.pool, &stop_ids).await {
        Ok(schedule) => {
            let time_horizon = Duration::minutes(STOP_BOARD_HORIZON_MINUTES);
            let schedule_departures = realtime::compute_schedule_departures(
                &schedule,
                &stop_ids,
                ref_time,
                time_horizon,
                state.timezone,
            );
            let schedule_deps = schedule_departures.get(&request.stop_ifopt).cloned().unwrap_or_default();

            // Collect trip_ids already in real-time data to avoid duplicates
            let rt_trip_ids: HashSet<String> = departures.iter()
                .filter_map(|d| d.trip_id.clone())
                .collect();

            for dep in schedule_deps {
                if let Some(ref tid) = dep.trip_id {
                    if !rt_trip_ids.contains(tid) {
                        departures.push(dep);
                    }
                } else {
                    departures.push(dep);
                }
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, stop_ifopt = %request.stop_ifopt, "Failed to build schedule from DB for stop departures");
        }
    }

    departures.sort_by(|a, b| a.planned_time.cmp(&b.planned_time));
    let departures = filter_past_departures(departures, ref_time);
    let departures = filter_same_station_destinations(departures, &request.stop_ifopt);

    Json(StopDeparturesResponse {
        stop_ifopt: request.stop_ifopt,
        departures,
    })
}

/// Get departures for a specific GTFS stop by its stop_id, bypassing IFOPT mapping
#[utoipa::path(
    post,
    path = "/api/departures/by-gtfs-stop",
    request_body = GtfsStopDeparturesRequest,
    responses(
        (status = 200, description = "Departures for the GTFS stop", body = GtfsStopDeparturesResponse),
        (status = 400, description = "Bad request", body = ErrorResponse)
    ),
    tag = "departures"
)]
pub async fn get_departures_by_gtfs_stop(
    State(state): State<DeparturesState>,
    Json(request): Json<GtfsStopDeparturesRequest>,
) -> Json<GtfsStopDeparturesResponse> {
    let simulated_time = parse_reference_time(&request.reference_time);
    let ref_time = simulated_time.unwrap_or_else(Utc::now);

    let mut stop_ids = HashSet::new();
    stop_ids.insert(request.gtfs_stop_id.clone());

    // Always compute schedule-based departures with the longer stop board horizon
    let departures =
        match static_data::build_schedule_from_db_by_gtfs_stop(&state.pool, &stop_ids).await {
            Ok(schedule) => {
                let time_horizon = Duration::minutes(STOP_BOARD_HORIZON_MINUTES);
                let all_departures = realtime::compute_schedule_departures(
                    &schedule,
                    &stop_ids,
                    ref_time,
                    time_horizon,
                    state.timezone,
                );
                all_departures
                    .get(&request.gtfs_stop_id)
                    .cloned()
                    .unwrap_or_default()
            }
            Err(e) => {
                tracing::warn!(error = %e, gtfs_stop_id = %request.gtfs_stop_id, "Failed to build schedule from DB for GTFS stop departures");
                Vec::new()
            }
        };

    let departures = filter_past_departures(departures, ref_time);

    Json(GtfsStopDeparturesResponse {
        gtfs_stop_id: request.gtfs_stop_id,
        departures,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::EventType;
    use chrono::Datelike;

    fn make_departure(planned_time: &str, estimated_time: Option<&str>) -> Departure {
        Departure {
            stop_ifopt: "de:08111:6115".to_string(),
            event_type: EventType::Departure,
            line_number: "U1".to_string(),
            destination: "Central Station".to_string(),
            destination_id: None,
            planned_time: planned_time.to_string(),
            estimated_time: estimated_time.map(|s| s.to_string()),
            delay_minutes: None,
            platform: None,
            trip_id: Some("trip_1".to_string()),
            cancelled: false,
        }
    }

    // --- filter_past_departures tests ---

    #[test]
    fn test_filter_past_departures_removes_past() {
        let reference = DateTime::parse_from_rfc3339("2026-03-10T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let departures = vec![
            make_departure("2026-03-10T11:00:00Z", None), // 1 hour in the past
            make_departure("2026-03-10T13:00:00Z", None), // 1 hour in the future
        ];

        let result = filter_past_departures(departures, reference);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].planned_time, "2026-03-10T13:00:00Z");
    }

    #[test]
    fn test_filter_past_departures_keeps_future() {
        let reference = DateTime::parse_from_rfc3339("2026-03-10T08:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let departures = vec![
            make_departure("2026-03-10T09:00:00Z", None),
            make_departure("2026-03-10T10:00:00Z", None),
            make_departure("2026-03-10T11:00:00Z", None),
        ];

        let result = filter_past_departures(departures, reference);
        assert_eq!(result.len(), 3);
    }

    #[test]
    fn test_filter_past_departures_uses_estimated_time_when_available() {
        let reference = DateTime::parse_from_rfc3339("2026-03-10T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        // Planned in the future, but estimated in the past
        let dep_past_estimated = make_departure(
            "2026-03-10T13:00:00Z",
            Some("2026-03-10T11:00:00Z"),
        );
        // Planned in the past, but estimated in the future
        let dep_future_estimated = make_departure(
            "2026-03-10T11:00:00Z",
            Some("2026-03-10T13:00:00Z"),
        );

        let departures = vec![dep_past_estimated, dep_future_estimated];
        let result = filter_past_departures(departures, reference);

        // Only the one with future estimated time should remain
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].estimated_time.as_deref(),
            Some("2026-03-10T13:00:00Z")
        );
    }

    #[test]
    fn test_filter_past_departures_keeps_unparseable_times() {
        let reference = DateTime::parse_from_rfc3339("2026-03-10T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let departures = vec![
            make_departure("not-a-valid-time", None),
            make_departure("2026-03-10T11:00:00Z", None), // past, should be removed
        ];

        let result = filter_past_departures(departures, reference);
        // Unparseable time is kept, past time is removed
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].planned_time, "not-a-valid-time");
    }

    #[test]
    fn test_filter_past_departures_exact_reference_time_is_kept() {
        let reference = DateTime::parse_from_rfc3339("2026-03-10T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let departures = vec![
            make_departure("2026-03-10T12:00:00Z", None), // exactly at reference time
        ];

        let result = filter_past_departures(departures, reference);
        // time == reference_time is within the 5-minute grace period, so it's kept
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn test_filter_past_departures_within_grace_period_is_kept() {
        let reference = DateTime::parse_from_rfc3339("2026-03-10T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let departures = vec![
            make_departure("2026-03-10T11:57:00Z", None), // 3 minutes ago — within grace
            make_departure("2026-03-10T11:54:00Z", None), // 6 minutes ago — beyond grace
        ];

        let result = filter_past_departures(departures, reference);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].planned_time, "2026-03-10T11:57:00Z");
    }

    // --- parse_reference_time tests ---

    #[test]
    fn test_parse_reference_time_none_input() {
        assert!(parse_reference_time(&None).is_none());
    }

    #[test]
    fn test_parse_reference_time_invalid_format() {
        let rt = Some("not-a-time".to_string());
        assert!(parse_reference_time(&rt).is_none());
    }

    #[test]
    fn test_parse_reference_time_within_180s_returns_none() {
        // Time very close to now (within 3 minutes)
        let now = Utc::now();
        let close_time = (now + Duration::seconds(60)).to_rfc3339();
        let rt = Some(close_time);
        assert!(parse_reference_time(&rt).is_none());
    }

    #[test]
    fn test_parse_reference_time_far_future_returns_some() {
        let future_time = "2030-06-15T14:00:00Z".to_string();
        let rt = Some(future_time.clone());
        let result = parse_reference_time(&rt);
        assert!(result.is_some());
        let dt = result.unwrap();
        assert_eq!(dt.year(), 2030);
        assert_eq!(dt.month(), 6);
    }

    #[test]
    fn test_parse_reference_time_far_past_returns_some() {
        let past_time = "2020-01-01T00:00:00Z".to_string();
        let rt = Some(past_time);
        let result = parse_reference_time(&rt);
        assert!(result.is_some());
        let dt = result.unwrap();
        assert_eq!(dt.year(), 2020);
    }

    // --- ifopt_station_prefix tests ---

    #[test]
    fn test_ifopt_station_prefix_full() {
        assert_eq!(ifopt_station_prefix("de:09761:10:1:A1"), Some("de:09761:10"));
    }

    #[test]
    fn test_ifopt_station_prefix_station_only() {
        assert_eq!(ifopt_station_prefix("de:09761:10"), Some("de:09761:10"));
    }

    #[test]
    fn test_ifopt_station_prefix_too_short() {
        assert_eq!(ifopt_station_prefix("de:09761"), None);
    }

    // --- filter_same_station_destinations tests ---

    #[test]
    fn test_filter_same_station_removes_loop_destination() {
        let mut dep = make_departure("2026-03-10T13:00:00Z", None);
        dep.stop_ifopt = "de:09761:10:1:A3".to_string();
        dep.destination_id = Some("de:09761:10:1:A4".to_string()); // same station, different platform

        let result = filter_same_station_destinations(vec![dep], "de:09761:10:1:A3");
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn test_filter_same_station_keeps_different_station() {
        let mut dep = make_departure("2026-03-10T13:00:00Z", None);
        dep.stop_ifopt = "de:09761:10:1:A3".to_string();
        dep.destination_id = Some("de:09761:20:1:B1".to_string()); // different station

        let result = filter_same_station_destinations(vec![dep], "de:09761:10:1:A3");
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn test_filter_same_station_keeps_no_destination_id() {
        let dep = make_departure("2026-03-10T13:00:00Z", None);
        // destination_id is None by default

        let result = filter_same_station_destinations(vec![dep], "de:09761:10:1:A3");
        assert_eq!(result.len(), 1);
    }
}
