mod list;

pub use list::*;

use axum::{Router, routing::post};

use super::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/by-stop", post(get_departures_by_stop))
        .route("/by-gtfs-stop", post(get_departures_by_gtfs_stop))
        .with_state(state)
}
