use axum::{extract::State, Json};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use utoipa::ToSchema;

use crate::api::ErrorResponse;
use crate::providers::timetables::gtfs::{realtime, static_data};
use crate::sync::Departure;

use super::DeparturesState;

/// Filter out departures that are in the past relative to the given reference time
fn filter_past_departures(departures: Vec<Departure>, reference_time: DateTime<Utc>) -> Vec<Departure> {
    departures
        .into_iter()
        .filter(|d| {
            // Use estimated time if available, otherwise planned time
            let time_str = d.estimated_time.as_ref().unwrap_or(&d.planned_time);
            match chrono::DateTime::parse_from_rfc3339(time_str) {
                Ok(time) => time > reference_time,
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

/// Parse a reference_time string and determine if it's a simulated (non-current) time.
/// Returns Some(DateTime) if it's a valid future/past simulated time, None if it's effectively "now".
fn parse_reference_time(reference_time: &Option<String>) -> Option<DateTime<Utc>> {
    let rt = reference_time.as_ref()?;
    let parsed = DateTime::parse_from_rfc3339(rt).ok()?;
    let dt = parsed.with_timezone(&Utc);

    // If the reference time is within 3 minutes of now, treat it as real-time
    let diff = (dt - Utc::now()).num_seconds().abs();
    if diff < 180 {
        return None;
    }
    Some(dt)
}

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

    let departures = if let Some(ref_time) = simulated_time {
        // Compute departures from static schedule (loaded from PG) for the simulated time
        let mut stop_ids = HashSet::new();
        stop_ids.insert(request.stop_ifopt.clone());
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
                all_departures.get(&request.stop_ifopt).cloned().unwrap_or_default()
            }
            Err(e) => {
                tracing::warn!(error = %e, stop_ifopt = %request.stop_ifopt, "Failed to build schedule from DB for stop departures");
                Vec::new()
            }
        }
    } else {
        // Use real-time departure store
        let store = state.departure_store.read().await;
        store.get(&request.stop_ifopt).cloned().unwrap_or_default()
    };

    let reference = simulated_time.unwrap_or_else(Utc::now);
    let departures = filter_past_departures(departures, reference);

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

    let departures =
        match static_data::build_schedule_from_db_by_gtfs_stop(&state.pool, &stop_ids).await {
            Ok(schedule) => {
                let time_horizon = Duration::minutes(state.time_horizon_minutes as i64);
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
    fn test_filter_past_departures_exact_reference_time_is_not_kept() {
        let reference = DateTime::parse_from_rfc3339("2026-03-10T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let departures = vec![
            make_departure("2026-03-10T12:00:00Z", None), // exactly at reference time
        ];

        let result = filter_past_departures(departures, reference);
        // time == reference_time is NOT > reference_time, so it should be filtered out
        assert_eq!(result.len(), 0);
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
}
