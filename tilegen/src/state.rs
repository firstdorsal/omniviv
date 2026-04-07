use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::areas::BoundingBox;
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

/// Record successful completion of a layer generation. Preserves the
/// bbox/area_label/zoom metadata from `record_generation_start` so the
/// diagnostics panel can still show the configured area after completion.
pub async fn record_generation_success(
    pool: &PgPool,
    layer_name: &str,
    duration_ms: i64,
    tile_count: i64,
    file_size_bytes: i64,
) -> Result<(), TilegenError> {
    sqlx::query(
        "INSERT INTO tile_generation_state (layer_name, last_generated_at, generation_duration_ms, tile_count, file_size_bytes, status, phase, error_message)
         VALUES ($1, NOW(), $2, $3, $4, 'ok', 'completed', NULL)
         ON CONFLICT (layer_name) DO UPDATE SET
            last_generated_at = NOW(),
            generation_duration_ms = $2,
            tile_count = $3,
            file_size_bytes = $4,
            status = 'ok',
            phase = 'completed',
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

/// Record a failed generation attempt. Only updates status/phase/error —
/// the bbox/area metadata from the most recent `record_generation_start`
/// is preserved so the diagnostics panel can still show the area.
pub async fn record_generation_failure(
    pool: &PgPool,
    layer_name: &str,
    error_message: &str,
) -> Result<(), TilegenError> {
    sqlx::query(
        "INSERT INTO tile_generation_state (layer_name, status, phase, error_message)
         VALUES ($1, 'failed', 'failed', $2)
         ON CONFLICT (layer_name) DO UPDATE SET
            status = 'failed',
            phase = 'failed',
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

/// Mark a layer as starting a generation run. Records the configured bbox,
/// zoom range, area label and total tile estimate so the frontend can show a
/// progress bar from the very first poll (before any tiles have been generated).
pub async fn record_generation_start(
    pool: &PgPool,
    layer_name: &str,
    bbox: BoundingBox,
    min_zoom: u8,
    max_zoom: u8,
    tiles_total: u64,
    area_label: &str,
) -> Result<(), TilegenError> {
    sqlx::query(
        "INSERT INTO tile_generation_state (
            layer_name, status, phase, started_at,
            bbox_west, bbox_south, bbox_east, bbox_north,
            min_zoom, max_zoom, tiles_total, tiles_done, current_zoom,
            area_label, error_message
         )
         VALUES ($1, 'pending', 'running', NOW(),
                 $2, $3, $4, $5,
                 $6, $7, $8, 0, NULL,
                 $9, NULL)
         ON CONFLICT (layer_name) DO UPDATE SET
            phase = 'running',
            started_at = NOW(),
            bbox_west = $2, bbox_south = $3, bbox_east = $4, bbox_north = $5,
            min_zoom = $6, max_zoom = $7,
            tiles_total = $8,
            tiles_done = 0,
            current_zoom = NULL,
            area_label = $9,
            error_message = NULL"
    )
    .bind(layer_name)
    .bind(bbox[0])
    .bind(bbox[1])
    .bind(bbox[2])
    .bind(bbox[3])
    .bind(min_zoom as i32)
    .bind(max_zoom as i32)
    .bind(tiles_total as i64)
    .bind(area_label)
    .execute(pool)
    .await?;
    Ok(())
}

/// Update the live progress of an in-progress generation. Called periodically
/// by the progress reporter task while martin-cp is writing tiles.
pub async fn update_generation_progress(
    pool: &PgPool,
    layer_name: &str,
    tiles_done: i64,
    current_zoom: Option<i32>,
) -> Result<(), TilegenError> {
    sqlx::query(
        "UPDATE tile_generation_state
         SET tiles_done = $2, current_zoom = $3
         WHERE layer_name = $1"
    )
    .bind(layer_name)
    .bind(tiles_done)
    .bind(current_zoom)
    .execute(pool)
    .await?;
    Ok(())
}

/// Mark the layer as entering the SQL in-place commit phase. The frontend
/// shows this distinctly from the bulk tile-generation phase.
pub async fn record_committing(pool: &PgPool, layer_name: &str) -> Result<(), TilegenError> {
    sqlx::query(
        "UPDATE tile_generation_state SET phase = 'committing' WHERE layer_name = $1"
    )
    .bind(layer_name)
    .execute(pool)
    .await?;
    Ok(())
}

/// Append a row to `tile_generation_history` capturing one completed or failed
/// generation run. The diagnostics panel uses this for the per-layer timeline.
#[allow(clippy::too_many_arguments)]
pub async fn record_history_entry(
    pool: &PgPool,
    layer_name: &str,
    started_at: DateTime<Utc>,
    duration_ms: i64,
    tiles_done: i64,
    tiles_total: i64,
    file_size_bytes: i64,
    bbox: BoundingBox,
    min_zoom: u8,
    max_zoom: u8,
    area_label: &str,
    status: &str,
    error_message: Option<&str>,
) -> Result<(), TilegenError> {
    sqlx::query(
        "INSERT INTO tile_generation_history (
            layer_name, started_at, completed_at, duration_ms,
            tiles_done, tiles_total, file_size_bytes,
            bbox_west, bbox_south, bbox_east, bbox_north,
            min_zoom, max_zoom, area_label, status, error_message
         )
         VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)"
    )
    .bind(layer_name)
    .bind(started_at)
    .bind(duration_ms)
    .bind(tiles_done)
    .bind(tiles_total)
    .bind(file_size_bytes)
    .bind(bbox[0])
    .bind(bbox[1])
    .bind(bbox[2])
    .bind(bbox[3])
    .bind(min_zoom as i32)
    .bind(max_zoom as i32)
    .bind(area_label)
    .bind(status)
    .bind(error_message)
    .execute(pool)
    .await?;
    Ok(())
}
