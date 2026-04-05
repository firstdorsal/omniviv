pub mod list; // pub for utoipauto auto-discovery

pub use list::*;

use axum::{Router, routing::post};

use super::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/by-stop", post(get_departures_by_stop))
        .route("/by-gtfs-stop", post(get_departures_by_gtfs_stop))
        .route("/by-coordinates", post(get_departures_by_coordinates))
        .route("/by-osm-id", post(get_departures_by_osm_id))
        .with_state(state)
}
