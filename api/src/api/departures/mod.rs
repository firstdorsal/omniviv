mod list;

pub use list::*;

use axum::{Router, routing::{get, post}};
use sqlx::PgPool;
use crate::sync::DepartureStore;

#[derive(Clone)]
pub struct DeparturesState {
    pub pool: PgPool,
    pub departure_store: DepartureStore,
    pub time_horizon_minutes: u32,
    pub timezone: chrono_tz::Tz,
}

pub fn router(pool: PgPool, departure_store: DepartureStore, time_horizon_minutes: u32, timezone: chrono_tz::Tz) -> Router {
    let state = DeparturesState {
        pool,
        departure_store,
        time_horizon_minutes,
        timezone,
    };
    Router::new()
        .route("/", get(list_departures))
        .route("/by-stop", post(get_departures_by_stop))
        .route("/by-gtfs-stop", post(get_departures_by_gtfs_stop))
        .with_state(state)
}
