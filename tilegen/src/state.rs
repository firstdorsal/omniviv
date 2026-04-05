use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::error::TilegenError;

/// Check if a layer needs regeneration based on its interval.
pub async fn needs_regeneration(
    pool: &PgPool,
    layer_name: &str,
    interval: std::time::Duration,
) -> Result<bool, TilegenError> {
    let row: Option<(DateTime<Utc>,)> = sqlx::query_as(
        "SELECT last_generated_at FROM tile_generation_state WHERE layer_name = $1 AND status = 'ok'"
    )
    .bind(layer_name)
    .fetch_optional(pool)
    .await?;

    match row {
        None => Ok(true),
        Some((last_generated,)) => {
            let elapsed = Utc::now() - last_generated;
            Ok(elapsed.num_seconds() > interval.as_secs() as i64)
        }
    }
}

/// Record successful completion of a layer generation.
pub async fn record_generation_success(
    pool: &PgPool,
    layer_name: &str,
    duration_ms: i64,
    tile_count: i64,
    file_size_bytes: i64,
) -> Result<(), TilegenError> {
    sqlx::query(
        "INSERT INTO tile_generation_state (layer_name, last_generated_at, generation_duration_ms, tile_count, file_size_bytes, status, error_message)
         VALUES ($1, NOW(), $2, $3, $4, 'ok', NULL)
         ON CONFLICT (layer_name) DO UPDATE SET
            last_generated_at = NOW(),
            generation_duration_ms = $2,
            tile_count = $3,
            file_size_bytes = $4,
            status = 'ok',
            error_message = NULL"
    )
    .bind(layer_name)
    .bind(duration_ms)
    .bind(tile_count)
    .bind(file_size_bytes)
    .execute(pool)
    .await?;
    Ok(())
}

/// Record a failed generation attempt.
pub async fn record_generation_failure(
    pool: &PgPool,
    layer_name: &str,
    error_message: &str,
) -> Result<(), TilegenError> {
    sqlx::query(
        "INSERT INTO tile_generation_state (layer_name, status, error_message)
         VALUES ($1, 'failed', $2)
         ON CONFLICT (layer_name) DO UPDATE SET
            status = 'failed',
            error_message = $2"
    )
    .bind(layer_name)
    .bind(error_message)
    .execute(pool)
    .await?;
    Ok(())
}

/// Check if the database has transit data (stations table is populated).
pub async fn database_has_transit_data(pool: &PgPool) -> Result<bool, TilegenError> {
    let row: (bool,) = sqlx::query_as("SELECT EXISTS(SELECT 1 FROM stations LIMIT 1)")
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}
