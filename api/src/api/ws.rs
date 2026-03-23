use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
};
use chrono::{DateTime, Utc};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use tokio::sync::broadcast;
use tracing::warn;

use super::state::AppState;
use super::vehicles::Vehicle;

/// Error type for internal WebSocket data-building operations.
/// Converts to String for WebSocket error messages while providing
/// structured logging of the underlying cause.
#[derive(Debug, thiserror::Error)]
enum WsError {
    #[error("Database error: {0}")]
    DatabaseError(#[from] sqlx::Error),
}

impl WsError {
    /// Convert to a user-facing error string, logging the internal details.
    fn into_message(self, context: &str) -> String {
        match &self {
            WsError::DatabaseError(e) => {
                tracing::error!(error = %e, context, "WebSocket database error");
            }
        }
        context.to_string()
    }
}

/// Maximum number of routes a single WebSocket client can subscribe to
const MAX_ROUTE_SUBSCRIPTIONS: usize = 100;



/// Client subscription message
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
#[serde(rename_all = "snake_case")]
enum ClientMessage {
    /// Subscribe to specific routes
    Subscribe {
        route_ids: Vec<i64>,
        /// Optional reference time for time simulation (ISO 8601/RFC 3339)
        reference_time: Option<String>,
    },
}

/// Server message sent to clients
#[derive(Debug, Serialize)]
#[serde(tag = "type")]
#[serde(rename_all = "snake_case")]
enum ServerMessage {
    /// Initial connection acknowledgment
    Connected { message: String },
    /// Full vehicle data (sent on initial subscribe)
    Vehicles { routes: Vec<RouteVehicles> },
    /// Incremental update with only changes
    VehiclesUpdate { changes: Vec<VehicleChange> },
    /// Error message
    Error { message: String },
}

#[derive(Debug, Clone, Serialize)]
struct RouteVehicles {
    route_id: i64,
    line_number: Option<String>,
    vehicles: Vec<Vehicle>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "action")]
#[serde(rename_all = "snake_case")]
enum VehicleChange {
    /// A new vehicle appeared
    Add { route_id: i64, vehicle: Vehicle },
    /// A vehicle was updated (stops/times changed)
    Update { route_id: i64, vehicle: Vehicle },
    /// A vehicle was removed
    Remove { route_id: i64, trip_id: String },
}

/// Compute a hash for a single vehicle for change detection
fn compute_vehicle_hash(vehicle: &Vehicle) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    vehicle.trip_id.hash(&mut hasher);
    vehicle.line_number.hash(&mut hasher);
    vehicle.destination.hash(&mut hasher);
    vehicle.next_trip_id.hash(&mut hasher);
    for stop in &vehicle.stops {
        stop.stop_ifopt.hash(&mut hasher);
        stop.delay_minutes.hash(&mut hasher);
        stop.departure_time.hash(&mut hasher);
        stop.departure_time_estimated.hash(&mut hasher);
        stop.arrival_time.hash(&mut hasher);
        stop.arrival_time_estimated.hash(&mut hasher);
    }
    hasher.finish()
}

/// Previous state tracking for a connection
#[derive(Default)]
struct PreviousState {
    /// Map of (route_id, trip_id) -> vehicle hash
    vehicle_hashes: HashMap<(i64, String), u64>,
}

/// Compute changes between previous and current state
fn compute_changes(
    previous: &mut PreviousState,
    current: &[RouteVehicles],
) -> Vec<VehicleChange> {
    let mut changes = Vec::new();
    let mut seen_keys: HashSet<(i64, String)> = HashSet::new();

    // Check for new/updated vehicles
    for route in current {
        for vehicle in &route.vehicles {
            let key = (route.route_id, vehicle.trip_id.clone());
            seen_keys.insert(key.clone());

            let new_hash = compute_vehicle_hash(vehicle);

            match previous.vehicle_hashes.get(&key) {
                Some(&old_hash) if old_hash == new_hash => {
                    // No change
                }
                Some(_) => {
                    // Updated
                    changes.push(VehicleChange::Update {
                        route_id: route.route_id,
                        vehicle: vehicle.clone(),
                    });
                    previous.vehicle_hashes.insert(key, new_hash);
                }
                None => {
                    // New vehicle
                    changes.push(VehicleChange::Add {
                        route_id: route.route_id,
                        vehicle: vehicle.clone(),
                    });
                    previous.vehicle_hashes.insert(key, new_hash);
                }
            }
        }
    }

    // Check for removed vehicles
    let removed_keys: Vec<_> = previous
        .vehicle_hashes
        .keys()
        .filter(|k| !seen_keys.contains(*k))
        .cloned()
        .collect();

    for key in removed_keys {
        changes.push(VehicleChange::Remove {
            route_id: key.0,
            trip_id: key.1.clone(),
        });
        previous.vehicle_hashes.remove(&key);
    }

    changes
}

/// WebSocket endpoint for vehicle updates
pub async fn ws_vehicles(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

/// Commands sent from the receiver task to the forward task
#[derive(Debug)]
enum SubscriptionCommand {
    SubscribeRoutes {
        route_ids: Vec<i64>,
        reference_time: Option<String>,
    },
    /// Send an error message to the client
    SendError {
        message: String,
    },
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let mut vehicle_rx = state.vehicle_updates_tx.subscribe();
    let mut subscribed_routes: HashSet<i64> = HashSet::new();
    let mut previous_state = PreviousState::default();

    let connected_msg = ServerMessage::Connected {
        message: "Connected to vehicle updates. Send subscribe message with route_ids.".to_string(),
    };
    if let Ok(json) = serde_json::to_string(&connected_msg) {
        let _ = sender.send(Message::Text(json.into())).await;
    }

    // Channel to communicate subscriptions from receiver task to sender task
    let (sub_tx, mut sub_rx) = tokio::sync::mpsc::channel::<SubscriptionCommand>(16);

    // Clone state for the forward task
    let forward_state = state.clone();

    let mut simulated_time: Option<DateTime<Utc>> = None;

    // Spawn task to forward broadcast updates to WebSocket
    let forward_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                // Handle subscription updates
                Some(cmd) = sub_rx.recv() => {
                    match cmd {
                        SubscriptionCommand::SubscribeRoutes { route_ids, reference_time } => {
                            subscribed_routes = route_ids.iter().copied().collect();
                            simulated_time = parse_ws_reference_time(&reference_time);
                            // Reset previous state when subscription changes
                            previous_state = PreviousState::default();

                            // Send full data for newly subscribed routes
                            if !subscribed_routes.is_empty() {
                                let routes: Vec<i64> = subscribed_routes.iter().copied().collect();
                                match build_vehicle_data(&forward_state, &routes, simulated_time).await {
                                    Ok(data) => {
                                        // Initialize previous state with current data
                                        for route in &data {
                                            for vehicle in &route.vehicles {
                                                let key = (route.route_id, vehicle.trip_id.clone());
                                                let hash = compute_vehicle_hash(vehicle);
                                                previous_state.vehicle_hashes.insert(key, hash);
                                            }
                                        }
                                        let msg = ServerMessage::Vehicles { routes: data };
                                        if let Ok(json) = serde_json::to_string(&msg) {
                                            if sender.send(Message::Text(json.into())).await.is_err() {
                                                break;
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        let msg = ServerMessage::Error { message: e.into_message("Failed to build vehicle data") };
                                        if let Ok(json) = serde_json::to_string(&msg) {
                                            let _ = sender.send(Message::Text(json.into())).await;
                                        }
                                    }
                                }
                            }
                        }
                        SubscriptionCommand::SendError { message } => {
                            let msg = ServerMessage::Error { message };
                            if let Ok(json) = serde_json::to_string(&msg) {
                                let _ = sender.send(Message::Text(json.into())).await;
                            }
                        }
                    }
                }
                // Handle broadcast updates
                result = vehicle_rx.recv() => {
                    match result {
                        Ok(_update) => {
                            // Skip if no subscriptions
                            if subscribed_routes.is_empty() {
                                continue;
                            }

                            // For simulated time, skip broadcast updates (schedule data doesn't change)
                            if simulated_time.is_some() {
                                continue;
                            }

                            let routes: Vec<i64> = subscribed_routes.iter().copied().collect();
                            match build_vehicle_data(&forward_state, &routes, None).await {
                                Ok(data) => {
                                    let changes = compute_changes(&mut previous_state, &data);
                                    if !changes.is_empty() {
                                        let msg = ServerMessage::VehiclesUpdate { changes };
                                        if let Ok(json) = serde_json::to_string(&msg) {
                                            if sender.send(Message::Text(json.into())).await.is_err() {
                                                break;
                                            }
                                        }
                                    }
                                }
                                Err(e) => {
                                    tracing::warn!(error = %e, "Failed to build vehicle data");
                                }
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            warn!(skipped = n, "WebSocket broadcast lagged, skipped updates");
                            continue;
                        }
                    }
                }
            }
        }
    });

    // Handle incoming messages from client
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                match serde_json::from_str::<ClientMessage>(&text) {
                    Ok(client_msg) => match client_msg {
                        ClientMessage::Subscribe { route_ids, reference_time } => {
                            if route_ids.len() > MAX_ROUTE_SUBSCRIPTIONS {
                                let error_msg = format!("Cannot subscribe to more than {} routes", MAX_ROUTE_SUBSCRIPTIONS);
                                let _ = sub_tx.send(SubscriptionCommand::SendError { message: error_msg }).await;
                                continue;
                            }
                            let _ = sub_tx.send(SubscriptionCommand::SubscribeRoutes { route_ids, reference_time }).await;
                        }
                    },
                    Err(e) => {
                        warn!("Failed to parse WebSocket message: {}", e);
                        let error_msg = format!("Invalid message format: {}", e);
                        let _ = sub_tx.send(SubscriptionCommand::SendError { message: error_msg }).await;
                    }
                }
            }
            Ok(Message::Ping(_)) => {
                // Axum handles pong automatically
            }
            Ok(Message::Close(_)) => break,
            Err(_) => break,
            _ => {}
        }
    }

    // Cleanup
    forward_task.abort();
}

#[derive(Debug, sqlx::FromRow)]
struct RouteInfo {
    line_ref: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct RouteInfoWithId {
    osm_id: i64,
    line_ref: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct RouteStopInfo {
    sequence: i32,
    stop_ifopt: Option<String>,
    stop_name: Option<String>,
    lat: Option<f64>,
    lon: Option<f64>,
}

#[derive(Debug, sqlx::FromRow)]
struct RouteStopInfoWithRoute {
    route_id: i64,
    sequence: i32,
    stop_ifopt: Option<String>,
    stop_name: Option<String>,
    lat: Option<f64>,
    lon: Option<f64>,
}

/// Build vehicle data for the given routes
async fn build_vehicle_data(
    state: &AppState,
    route_ids: &[i64],
    simulated_time: Option<DateTime<Utc>>,
) -> Result<Vec<RouteVehicles>, WsError> {
    if route_ids.is_empty() {
        return Ok(Vec::new());
    }

    // Batch query: Get all route info at once
    let route_infos: Vec<RouteInfoWithId> = sqlx::query_as(
        "SELECT osm_id, ref as line_ref FROM routes WHERE osm_id = ANY($1::bigint[])",
    )
    .bind(route_ids)
    .fetch_all(&state.pool)
    .await
    .map_err(WsError::from)?;

    let route_info_map: HashMap<i64, RouteInfo> = route_infos
        .into_iter()
        .map(|r| (r.osm_id, RouteInfo { line_ref: r.line_ref }))
        .collect();

    // Batch query: Get all route stops at once
    let all_route_stops: Vec<RouteStopInfoWithRoute> = sqlx::query_as(
        r#"
        SELECT
            rs.route_id,
            rs.sequence,
            COALESCE(sp.ref_ifopt, p.ref_ifopt, st.ref_ifopt) as stop_ifopt,
            COALESCE(sp.name, p.name, st.name) as stop_name,
            COALESCE(sp.lat, p.lat, st.lat) as lat,
            COALESCE(sp.lon, p.lon, st.lon) as lon
        FROM route_stops rs
        LEFT JOIN stop_positions sp ON rs.stop_position_id = sp.osm_id
        LEFT JOIN platforms p ON rs.platform_id = p.osm_id
        LEFT JOIN stations st ON rs.station_id = st.osm_id
        WHERE rs.route_id = ANY($1::bigint[])
        ORDER BY rs.route_id, rs.sequence
        "#,
    )
    .bind(route_ids)
    .fetch_all(&state.pool)
    .await
    .map_err(WsError::from)?;

    // Group stops by route_id
    let mut route_stops_map: HashMap<i64, Vec<RouteStopInfo>> = HashMap::new();
    for rs in all_route_stops {
        route_stops_map.entry(rs.route_id).or_default().push(RouteStopInfo {
            sequence: rs.sequence,
            stop_ifopt: rs.stop_ifopt,
            stop_name: rs.stop_name,
            lat: rs.lat,
            lon: rs.lon,
        });
    }

    let mut results = Vec::new();

    for &route_id in route_ids {
        // Get route info from pre-fetched map
        let route_info = match route_info_map.get(&route_id) {
            Some(r) => r,
            None => continue, // Skip unknown routes
        };

        // Get route stops from pre-fetched map (take ownership to avoid cloning the whole Vec)
        let route_stops = route_stops_map.remove(&route_id).unwrap_or_default();

        // Build stop info map
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
            results.push(RouteVehicles {
                route_id,
                line_number: route_info.line_ref.clone(),
                vehicles: vec![],
            });
            continue;
        }

        let trip_departures = super::vehicles::builder::collect_trip_departures(
            &state.pool,
            &state.departure_store,
            &stop_ifopts,
            route_info.line_ref.as_deref(),
            simulated_time,
            state.time_horizon_minutes,
            state.timezone,
        ).await;

        let vehicles = super::vehicles::builder::build_vehicles_from_departures(trip_departures, &stop_info_map);

        results.push(RouteVehicles {
            route_id,
            line_number: route_info.line_ref.clone(),
            vehicles,
        });
    }

    Ok(results)
}

use super::utils::parse_reference_time as parse_ws_reference_time;

