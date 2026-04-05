pub mod builder;
pub mod list; // pub for utoipauto auto-discovery

pub use list::*;

use axum::{routing::post, Router};

use super::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/by-route", post(get_vehicles_by_route))
        .with_state(state)
}
