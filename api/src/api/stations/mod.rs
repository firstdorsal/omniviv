pub mod list;

pub use list::{StationPlatform, StationStopPosition, StationsState};

use axum::Router;
use sqlx::PgPool;

pub fn router(pool: PgPool) -> Router {
    let state = StationsState {
        pool,
    };
    Router::new()
        .route("/", axum::routing::get(list::list_stations))
        .route("/{osm_id}", axum::routing::get(list::get_station))
        .with_state(state)
}
