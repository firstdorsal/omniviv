use sqlx::PgPool;

use crate::sync::{DepartureStore, VehicleUpdateSender};

/// Shared application state for handlers that need departure/vehicle data.
///
/// Used by the vehicles, departures, and WebSocket handlers. Handlers that
/// only need the database pool (areas, routes, stations, etc.) continue to
/// receive `PgPool` directly.
#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub departure_store: DepartureStore,
    pub time_horizon_minutes: u32,
    pub timezone: chrono_tz::Tz,
    pub vehicle_updates_tx: VehicleUpdateSender,
}
