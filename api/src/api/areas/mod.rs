pub mod list;

use axum::Router;
use sqlx::PgPool;

pub fn router(pool: PgPool) -> Router {
    Router::new()
        .route("/", axum::routing::get(list::list_areas))
        .route("/{id}", axum::routing::get(list::get_area))
        .route("/{id}/stats", axum::routing::get(list::get_area_stats))
        .with_state(pool)
}
