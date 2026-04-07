pub mod departures;
pub mod error;
pub mod utils;
pub mod gtfs_stops;
pub mod health;
pub mod issues;
pub mod mapping;
pub mod routes;
pub mod schedule_cache;
pub mod state;
pub mod stations;
pub mod tilegen;
pub mod vehicles;
pub mod ws;

pub use error::{ErrorResponse, bad_request, internal_error};
pub use schedule_cache::ScheduleCache;
pub use state::AppState;

use axum::{routing::get, Router};
use sqlx::PgPool;

use crate::sync::{OsmIssueStore, VehicleUpdateSender, DepartureStore};

pub fn router(
    pool: PgPool,
    departure_store: DepartureStore,
    time_horizon_minutes: u32,
    timezone: chrono_tz::Tz,
    issue_store: OsmIssueStore,
    vehicle_updates_tx: VehicleUpdateSender,
    admin_api_key: Option<String>,
) -> Router {
    let app_state = AppState {
        pool: pool.clone(),
        departure_store,
        time_horizon_minutes,
        timezone,
        vehicle_updates_tx,
        schedule_cache: ScheduleCache::new(std::time::Duration::from_secs(300)),
        ws_tracker: state::WsConnectionTracker::default(),
    };

    Router::new()
        .nest("/routes", routes::router(pool.clone()))
        .nest("/stations", stations::router(pool.clone()))
        .nest("/departures", departures::router(app_state.clone()))
        .nest("/vehicles", vehicles::router(app_state.clone()))
        .nest("/issues", issues::router(issue_store))
        .nest("/health", health::router(pool.clone()))
        .nest("/gtfs-stops", gtfs_stops::router(pool.clone()))
        .nest("/mapping", mapping::router(pool.clone(), admin_api_key))
        .nest("/tilegen", tilegen::router(pool.clone()))
        .route("/ws/vehicles", get(ws::ws_vehicles).with_state(app_state))
}
