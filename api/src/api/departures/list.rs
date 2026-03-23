use axum::{extract::State, Json};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::collections::HashSet;
use utoipa::ToSchema;

use crate::api::ErrorResponse;
use crate::api::state::AppState;
use crate::api::utils::{ifopt_station_prefix, parse_reference_time};
use crate::providers::timetables::gtfs::realtime;
use crate::sync::Departure;

/// How many minutes of past departures to keep so that recent arrivals remain visible.
/// See also: `SCHEDULE_PAST_WINDOW_MINUTES` in `realtime.rs` (10 min for schedule building).
const PAST_GRACE_MINUTES: i64 = 5;

/// Per-stop board queries use a longer time horizon than the main departure list
/// so that events for the rest of the day (and into the next morning) are visible.
const STOP_BOARD_HORIZON_MINUTES: i64 = 720; // 12 hours

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

/// Filter departures by direction when a platform's OSM route has known destinations.
/// This handles cases where a single GTFS stop serves both directions (e.g., Kulturstraße)
/// but the OSM data distinguishes platforms A and E by their route direction.
async fn filter_by_direction(
    departures: Vec<Departure>,
    stop_ifopt: &str,
    pool: &PgPool,
) -> Vec<Departure> {
    // Load OSM route destinations for this platform (extracted from route names like
    // "Straßenbahn 1: Göggingen => Lechhausen" → destination keywords for this platform)
    let rows: Vec<(String,)> = match sqlx::query_as(
        r#"
        SELECT DISTINCT r.name
        FROM route_stops rs
        JOIN routes r ON r.osm_id = rs.route_id
        LEFT JOIN platforms p ON p.osm_id = rs.platform_id
        LEFT JOIN stop_positions sp ON sp.osm_id = rs.stop_position_id
        WHERE r.name IS NOT NULL
          AND (p.ref_ifopt = $1 OR sp.ref_ifopt = $1)
        "#,
    )
    .bind(stop_ifopt)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => return departures,
    };

    // Extract destination keywords from route names ("... => Destination")
    let mut dest_keywords: HashSet<String> = HashSet::new();
    for (route_name,) in &rows {
        if let Some(arrow_pos) = route_name.find("=>") {
            let dest = route_name[arrow_pos + 2..].trim();
            for word in dest.split_whitespace() {
                let normalized = word
                    .trim_matches(|c: char| !c.is_alphanumeric())
                    .to_lowercase();
                if normalized.len() >= 3 {
                    dest_keywords.insert(normalized);
                }
            }
        }
    }

    if dest_keywords.is_empty() {
        return departures;
    }

    // Filter: keep departures whose destination contains at least one keyword
    departures
        .into_iter()
        .filter(|d| {
            let dest_lower = d.destination.to_lowercase();
            dest_keywords.iter().any(|kw| dest_lower.contains(kw))
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
            let time = d.estimated_time.unwrap_or(d.planned_time);
            time > cutoff
        })
        .collect()
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
    /// The GTFS stop ID mapped to this IFOPT (if any)
    pub mapped_gtfs_stop_id: Option<String>,
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
    State(state): State<AppState>,
    Json(request): Json<StopDeparturesRequest>,
) -> Json<StopDeparturesResponse> {
    let simulated_time = parse_reference_time(&request.reference_time);

    let ref_time = simulated_time.unwrap_or_else(Utc::now);

    // Always compute schedule-based departures with the longer stop board horizon
    // so the popup shows upcoming events even when the real-time feed has no data
    // (e.g., late at night when trams have stopped running).
    let stop_ids = HashSet::from([request.stop_ifopt.clone()]);

    let mut departures = if simulated_time.is_none() {
        // Start with real-time departure store (has estimated times and delays)
        let store = state.departure_store.read().await;
        store.get(&request.stop_ifopt).cloned().unwrap_or_default()
    } else {
        Vec::new()
    };

    // Supplement with schedule-based departures to fill the 12-hour window.
    // This adds trips that aren't in the real-time store (e.g., next morning).
    match state.schedule_cache.get_or_build(&state.pool, &stop_ids).await {
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

            for departure in schedule_deps {
                if let Some(ref tid) = departure.trip_id {
                    if !rt_trip_ids.contains(tid) {
                        departures.push(departure);
                    }
                } else {
                    departures.push(departure);
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
    let departures = filter_by_direction(departures, &request.stop_ifopt, &state.pool).await;

    // Look up the mapped GTFS stop ID for this IFOPT
    let mapped_gtfs_stop_id: Option<String> = sqlx::query_scalar(
        "SELECT gtfs_stop_id FROM ifopt_gtfs_mapping WHERE ifopt = $1",
    )
    .bind(&request.stop_ifopt)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();

    Json(StopDeparturesResponse {
        stop_ifopt: request.stop_ifopt,
        mapped_gtfs_stop_id,
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
    State(state): State<AppState>,
    Json(request): Json<GtfsStopDeparturesRequest>,
) -> Json<GtfsStopDeparturesResponse> {
    let simulated_time = parse_reference_time(&request.reference_time);
    let ref_time = simulated_time.unwrap_or_else(Utc::now);

    let mut stop_ids = HashSet::new();
    stop_ids.insert(request.gtfs_stop_id.clone());

    // Always compute schedule-based departures with the longer stop board horizon
    let departures =
        match state.schedule_cache.get_or_build_by_gtfs_stop(&state.pool, &stop_ids).await {
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
    fn parse_dt(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn make_departure(planned_time: &str, estimated_time: Option<&str>) -> Departure {
        Departure {
            stop_ifopt: "de:08111:6115".to_string(),
            event_type: EventType::Departure,
            line_number: "U1".to_string(),
            destination: "Central Station".to_string(),
            destination_id: None,
            planned_time: parse_dt(planned_time),
            estimated_time: estimated_time.map(|s| parse_dt(s)),
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
        assert_eq!(result[0].planned_time, parse_dt("2026-03-10T13:00:00Z"));
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
            result[0].estimated_time,
            Some(parse_dt("2026-03-10T13:00:00Z"))
        );
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
        assert_eq!(result[0].planned_time, parse_dt("2026-03-10T11:57:00Z"));
    }

    // --- filter_same_station_destinations tests ---

    #[test]
    fn test_filter_same_station_removes_loop_destination() {
        let mut departure = make_departure("2026-03-10T13:00:00Z", None);
        departure.stop_ifopt = "de:09761:10:1:A3".to_string();
        departure.destination_id = Some("de:09761:10:1:A4".to_string()); // same station, different platform

        let result = filter_same_station_destinations(vec![departure], "de:09761:10:1:A3");
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn test_filter_same_station_keeps_different_station() {
        let mut departure = make_departure("2026-03-10T13:00:00Z", None);
        departure.stop_ifopt = "de:09761:10:1:A3".to_string();
        departure.destination_id = Some("de:09761:20:1:B1".to_string()); // different station

        let result = filter_same_station_destinations(vec![departure], "de:09761:10:1:A3");
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn test_filter_same_station_keeps_no_destination_id() {
        let departure = make_departure("2026-03-10T13:00:00Z", None);
        // destination_id is None by default

        let result = filter_same_station_destinations(vec![departure], "de:09761:10:1:A3");
        assert_eq!(result.len(), 1);
    }
}
