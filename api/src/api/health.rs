use axum::{extract::State, routing::get, Json, Router};
use serde::Serialize;
use sqlx::{FromRow, PgPool};
use utoipa::ToSchema;

#[derive(Clone)]
pub struct HealthState {
    pub pool: PgPool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct HealthResponse {
    /// Whether the service is running
    pub healthy: bool,
    /// Whether the static GTFS schedule has been loaded into PostgreSQL
    pub gtfs_schedule_loaded: bool,
    /// Number of GTFS stops in the database
    pub gtfs_stop_count: i64,
    /// Number of GTFS routes in the database
    pub gtfs_route_count: i64,
    /// Number of GTFS trips in the database
    pub gtfs_trip_count: i64,
    /// Number of IFOPT-to-GTFS stop mappings
    pub ifopt_mapping_count: i64,
}

#[derive(Debug, FromRow)]
struct FeedMeta {
    stop_count: i64,
    route_count: i64,
    trip_count: i64,
    mapping_count: i64,
}

/// Health check endpoint
#[utoipa::path(
    get,
    path = "/api/health",
    responses(
        (status = 200, description = "Service health status", body = HealthResponse)
    ),
    tag = "health"
)]
pub async fn health_check(State(state): State<HealthState>) -> Json<HealthResponse> {
    let meta = sqlx::query_as::<_, FeedMeta>(
        "SELECT stop_count, route_count, trip_count, mapping_count FROM gtfs_feed_meta WHERE id = 1",
    )
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();

    let (loaded, stop_count, route_count, trip_count, mapping_count) = match meta {
        Some(m) => (true, m.stop_count, m.route_count, m.trip_count, m.mapping_count),
        None => (false, 0, 0, 0, 0),
    };

    Json(HealthResponse {
        healthy: true,
        gtfs_schedule_loaded: loaded,
        gtfs_stop_count: stop_count,
        gtfs_route_count: route_count,
        gtfs_trip_count: trip_count,
        ifopt_mapping_count: mapping_count,
    })
}

pub fn router(pool: PgPool) -> Router {
    let state = HealthState { pool };
    Router::new()
        .route("/", get(health_check))
        .with_state(state)
}
