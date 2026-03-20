pub mod areas;
pub mod departures;
pub mod error;
pub mod utils;
pub mod gtfs_stops;
pub mod health;
pub mod issues;
pub mod mapping;
pub mod routes;
pub mod stations;
pub mod vehicles;
pub mod ws;

pub use error::{ErrorResponse, internal_error};

use axum::{routing::get, Router};
use sqlx::PgPool;

use crate::sync::{DepartureStore, OsmIssueStore, VehicleUpdateSender};

pub fn router(
    pool: PgPool,
    departure_store: DepartureStore,
    time_horizon_minutes: u32,
    timezone: chrono_tz::Tz,
    issue_store: OsmIssueStore,
    vehicle_updates_tx: VehicleUpdateSender,
) -> Router {
    let ws_state = ws::WsState {
        pool: pool.clone(),
        departure_store: departure_store.clone(),
        time_horizon_minutes,
        timezone,
        vehicle_updates_tx,
    };

    Router::new()
        .nest("/areas", areas::router(pool.clone()))
        .nest("/routes", routes::router(pool.clone()))
        .nest("/stations", stations::router(pool.clone()))
        .nest("/departures", departures::router(pool.clone(), departure_store.clone(), time_horizon_minutes, timezone))
        .nest("/vehicles", vehicles::router(pool.clone(), departure_store, time_horizon_minutes, timezone))
        .nest("/issues", issues::router(issue_store))
        .nest("/health", health::router(pool.clone()))
        .nest("/gtfs-stops", gtfs_stops::router(pool.clone()))
        .nest("/mapping", mapping::router(pool.clone()))
        .route("/ws/vehicles", get(ws::ws_vehicles).with_state(ws_state))
}
