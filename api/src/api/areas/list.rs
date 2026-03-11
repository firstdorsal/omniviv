use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Serialize;
use sqlx::{FromRow, PgPool};
use utoipa::ToSchema;

use crate::api::{ErrorResponse, internal_error};

#[derive(Debug, Serialize, ToSchema, FromRow)]
pub struct Area {
    pub id: i64,
    pub name: String,
    pub south: f64,
    pub west: f64,
    pub north: f64,
    pub east: f64,
    pub last_synced_at: Option<chrono::DateTime<chrono::Utc>>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize, ToSchema, FromRow)]
pub struct AreaStats {
    pub area_id: i64,
    pub area_name: String,
    pub station_count: i64,
    pub platform_count: i64,
    pub stop_position_count: i64,
    pub route_count: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AreaListResponse {
    pub areas: Vec<Area>,
}

/// List all configured areas
#[utoipa::path(
    get,
    path = "/api/areas",
    responses(
        (status = 200, description = "List of all areas", body = AreaListResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    ),
    tag = "areas"
)]
pub async fn list_areas(
    State(pool): State<PgPool>,
) -> Result<Json<AreaListResponse>, (StatusCode, Json<ErrorResponse>)> {
    let areas: Vec<Area> = sqlx::query_as(
        r#"
        SELECT
            id,
            name,
            south,
            west,
            north,
            east,
            last_synced_at,
            created_at
        FROM areas
        ORDER BY name
        "#,
    )
    .fetch_all(&pool)
    .await
    .map_err(internal_error)?;

    Ok(Json(AreaListResponse { areas }))
}

/// Get a specific area by ID
#[utoipa::path(
    get,
    path = "/api/areas/{id}",
    params(
        ("id" = i64, Path, description = "Area ID")
    ),
    responses(
        (status = 200, description = "Area details", body = Area),
        (status = 404, description = "Area not found", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    ),
    tag = "areas"
)]
pub async fn get_area(
    State(pool): State<PgPool>,
    Path(id): Path<i64>,
) -> Result<Json<Area>, (StatusCode, Json<ErrorResponse>)> {
    let area: Option<Area> = sqlx::query_as(
        r#"
        SELECT
            id,
            name,
            south,
            west,
            north,
            east,
            last_synced_at,
            created_at
        FROM areas
        WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&pool)
    .await
    .map_err(internal_error)?;

    match area {
        Some(area) => Ok(Json(area)),
        None => Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Area not found".to_string(),
            }),
        )),
    }
}

/// Get statistics for an area
#[utoipa::path(
    get,
    path = "/api/areas/{id}/stats",
    params(
        ("id" = i64, Path, description = "Area ID")
    ),
    responses(
        (status = 200, description = "Area statistics", body = AreaStats),
        (status = 404, description = "Area not found", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    ),
    tag = "areas"
)]
pub async fn get_area_stats(
    State(pool): State<PgPool>,
    Path(id): Path<i64>,
) -> Result<Json<AreaStats>, (StatusCode, Json<ErrorResponse>)> {
    // Single query to get area info and all counts (fixes N+1 query issue)
    let stats: Option<AreaStats> = sqlx::query_as(
        r#"
        SELECT
            a.id as area_id,
            a.name as area_name,
            (SELECT COUNT(*) FROM stations WHERE area_id = a.id) as station_count,
            (SELECT COUNT(*) FROM platforms WHERE area_id = a.id) as platform_count,
            (SELECT COUNT(*) FROM stop_positions WHERE area_id = a.id) as stop_position_count,
            (SELECT COUNT(*) FROM routes WHERE area_id = a.id) as route_count
        FROM areas a
        WHERE a.id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&pool)
    .await
    .map_err(internal_error)?;

    match stats {
        Some(stats) => Ok(Json(stats)),
        None => Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Area not found".to_string(),
            }),
        )),
    }
}
