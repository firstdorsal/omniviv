mod list;

pub use list::*;

use axum::{routing::post, Router};
use sqlx::PgPool;

use crate::sync::DepartureStore;

#[derive(Clone)]
pub struct VehiclesState {
    pub pool: PgPool,
    pub departure_store: DepartureStore,
    pub time_horizon_minutes: u32,
    pub timezone: chrono_tz::Tz,
}

pub fn router(pool: PgPool, departure_store: DepartureStore, time_horizon_minutes: u32, timezone: chrono_tz::Tz) -> Router {
    let state = VehiclesState {
        pool,
        departure_store,
        time_horizon_minutes,
        timezone,
    };
    Router::new()
        .route("/by-route", post(get_vehicles_by_route))
        .with_state(state)
}
