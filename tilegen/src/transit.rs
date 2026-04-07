use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection, PgPool, Row};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::areas::count_tiles_in_bbox;
use crate::config::TransitLayerConfig;
use crate::error::TilegenError;
use crate::mbtiles::replace_mbtiles_in_place;
use crate::state;

/// Generate transit tiles for a single layer using martin-cp.
///
/// martin-cp connects to PostGIS, calls the configured SQL function,
/// and writes the result as an MBTiles file with uncompressed (identity)
/// encoding so Martin can serve raw MVT to MapLibre.
/// Result of a successful transit layer generation.
pub struct TransitLayerResult {
    /// Path to the generated MBTiles file
    pub path: PathBuf,
    /// Generation duration in milliseconds
    pub duration_ms: i64,
    /// File size in bytes
    pub file_size_bytes: i64,
}

pub async fn generate_transit_layer(
    layer: &TransitLayerConfig,
    database_url: &str,
    output_dir: &Path,
    concurrency: u32,
    pool: &PgPool,
) -> Result<TransitLayerResult, TilegenError> {
    let start = Instant::now();
    let output_file = output_dir.join(format!("{}.mbtiles", layer.name));
    let tmp_file = output_dir.join(format!("{}.tmp.mbtiles", layer.name));

    // Remove stale tmp file if exists
    if let Err(e) = std::fs::remove_file(&tmp_file) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(path = %tmp_file.display(), "Failed to remove stale tmp file: {e}");
        }
    }

    let resolved_bbox = layer.resolved_bbox()?;
    let [west, south, east, north] = resolved_bbox;
    let bbox = format!("{west},{south},{east},{north}");
    let area_label = layer
        .areas
        .as_ref()
        .map(|a| a.join(","))
        .unwrap_or_else(|| bbox.clone());
    let tiles_total = count_tiles_in_bbox(resolved_bbox, layer.min_zoom, layer.max_zoom);
    let started_at_utc = chrono::Utc::now();

    // Record the start of this generation in the state table so the frontend
    // diagnostics panel can show the bbox + zoom range immediately, before any
    // tiles have been written.
    state::record_generation_start(
        pool,
        &layer.name,
        resolved_bbox,
        layer.min_zoom,
        layer.max_zoom,
        tiles_total,
        &area_label,
    )
    .await?;

    tracing::info!(
        layer = %layer.name,
        function = %layer.function,
        zoom = %format!("{}-{}", layer.min_zoom, layer.max_zoom),
        bbox = %bbox,
        concurrency = %concurrency,
        tiles_total = %tiles_total,
        "Generating transit tiles via martin-cp"
    );

    let mut cmd = tokio::process::Command::new("martin-cp");
    cmd.arg("--output-file").arg(&tmp_file);
    cmd.arg("--source").arg(&layer.function);
    cmd.arg("--min-zoom").arg(layer.min_zoom.to_string());
    cmd.arg("--max-zoom").arg(layer.max_zoom.to_string());
    cmd.arg("--bbox").arg(&bbox);
    cmd.arg("--concurrency").arg(concurrency.to_string());
    // Use the "flat" mbtiles schema (tiles is a base table, not a view)
    // so our in-place SQL replacement can DELETE FROM main.tiles in
    // mbtiles.rs. The default "normalized" schema makes tiles a view
    // over the (images, map) tables, which sqlite refuses to UPDATE.
    cmd.arg("--mbtiles-type").arg("flat");
    // Store tiles uncompressed so Martin serves raw MVT that MapLibre can parse directly.
    // Martin doesn't add Content-Encoding headers for MBTiles-stored compressed tiles.
    cmd.arg("--encoding").arg("identity");
    // Pass the resolved generation bbox as a URL query so the tile SQL
    // function (which has a 4-arg signature `fn(z,x,y,query_params jsonb)`)
    // can clip its output to the intersection of (tile bbox, generation
    // bbox). Without this, low-zoom tiles whose bbox covers far more than
    // the generation bbox would return data for every station/route in
    // that area (e.g. a z6 tile for Augsburg would include Munich,
    // Stuttgart, etc.). See migration 0011 for the function side.
    let url_query = format!(
        "clip_w={}&clip_s={}&clip_e={}&clip_n={}",
        west, south, east, north
    );
    cmd.arg("--url-query").arg(&url_query);
    // Pass database URL via environment variable (not CLI arg) to avoid
    // exposing credentials in /proc/*/cmdline.
    cmd.env("DATABASE_URL", database_url);

    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| TilegenError::TileGeneration {
        layer: layer.name.clone(),
        message: format!("Failed to spawn martin-cp: {e}"),
    })?;

    // Stream stderr to tracing
    let stderr_handle = if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        let layer_name = layer.name.clone();
        Some(tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "martin-cp", layer = %layer_name, "{}", line);
            }
        }))
    } else {
        None
    };

    // Spawn a progress reporter that periodically reads the in-progress
    // tmp.mbtiles and writes progress (tiles_done, current_zoom) to the
    // state table. The frontend's diagnostics panel reads from there.
    let stop_reporter = Arc::new(AtomicBool::new(false));
    let reporter_handle = {
        let stop = Arc::clone(&stop_reporter);
        let pool = pool.clone();
        let tmp_path = tmp_file.clone();
        let layer_name = layer.name.clone();
        tokio::spawn(async move {
            // First update after a small delay to give martin-cp time to create the file.
            tokio::time::sleep(Duration::from_secs(2)).await;
            while !stop.load(Ordering::SeqCst) {
                match read_mbtiles_progress(&tmp_path).await {
                    Ok((tiles_done, current_zoom)) => {
                        if let Err(e) = state::update_generation_progress(
                            &pool, &layer_name, tiles_done, current_zoom,
                        ).await {
                            tracing::debug!(layer = %layer_name, "progress update failed: {e}");
                        }
                    }
                    Err(e) => {
                        // File might not exist yet, or sqlite locked — ignore.
                        tracing::trace!(layer = %layer_name, "progress read failed: {e}");
                    }
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        })
    };

    let status = child.wait().await.map_err(|e| TilegenError::TileGeneration {
        layer: layer.name.clone(),
        message: format!("Failed to wait for martin-cp: {e}"),
    })?;

    // Stop the progress reporter
    stop_reporter.store(true, Ordering::SeqCst);
    if let Err(e) = reporter_handle.await {
        tracing::debug!(layer = %layer.name, "progress reporter task ended: {e}");
    }

    if let Some(handle) = stderr_handle {
        if let Err(e) = handle.await {
            tracing::warn!(layer = %layer.name, "stderr reader task failed: {e}");
        }
    }

    if !status.success() {
        if let Err(e) = std::fs::remove_file(&tmp_file) {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(path = %tmp_file.display(), "Failed to clean up tmp file: {e}");
            }
        }
        let err_msg = format!("martin-cp exited with code {:?}", status.code());
        let _ = state::record_history_entry(
            pool,
            &layer.name,
            started_at_utc,
            start.elapsed().as_millis() as i64,
            0, tiles_total as i64, 0,
            resolved_bbox, layer.min_zoom, layer.max_zoom,
            &area_label,
            "failed",
            Some(&err_msg),
        ).await;
        return Err(TilegenError::TileGeneration {
            layer: layer.name.clone(),
            message: err_msg,
        });
    }

    if !tmp_file.exists() {
        let err_msg = "Output file not found after martin-cp run".to_string();
        let _ = state::record_history_entry(
            pool,
            &layer.name,
            started_at_utc,
            start.elapsed().as_millis() as i64,
            0, tiles_total as i64, 0,
            resolved_bbox, layer.min_zoom, layer.max_zoom,
            &area_label,
            "failed",
            Some(&err_msg),
        ).await;
        return Err(TilegenError::TileGeneration {
            layer: layer.name.clone(),
            message: err_msg,
        });
    }

    // Mark transition to the in-place commit phase so the diagnostics panel
    // can show "committing..." instead of stale tile counts.
    if let Err(e) = state::record_committing(pool, &layer.name).await {
        tracing::warn!(layer = %layer.name, "failed to record committing phase: {e}");
    }

    // Replace the existing output file's tile data in place via SQL ATTACH+copy
    // (preserves the inode so Martin's cached file handle keeps serving the
    // same file). On the very first generation, this falls back to a plain
    // rename since there's no existing file to update.
    replace_mbtiles_in_place(&tmp_file, &output_file).await?;

    let file_size = std::fs::metadata(&output_file)
        .map(|m| m.len())
        .unwrap_or(0);
    let duration = start.elapsed();

    tracing::info!(
        layer = %layer.name,
        size_kb = file_size / 1024,
        duration_secs = duration.as_secs(),
        "Transit tiles generated"
    );

    // Append a row to the history table so the diagnostics panel can show
    // the timeline of past runs.
    if let Err(e) = state::record_history_entry(
        pool,
        &layer.name,
        started_at_utc,
        duration.as_millis() as i64,
        tiles_total as i64, // best estimate; the actual count is in the file
        tiles_total as i64,
        file_size as i64,
        resolved_bbox,
        layer.min_zoom,
        layer.max_zoom,
        &area_label,
        "ok",
        None,
    )
    .await
    {
        tracing::warn!(layer = %layer.name, "failed to record history entry: {e}");
    }

    Ok(TransitLayerResult {
        path: output_file,
        duration_ms: duration.as_millis() as i64,
        file_size_bytes: file_size as i64,
    })
}

/// Open the in-progress tmp.mbtiles in read-only mode and return
/// `(tiles_done, max_zoom_seen)`. Returns Err if the file doesn't exist yet
/// or sqlite refuses the read (e.g. martin-cp holds a write lock).
async fn read_mbtiles_progress(tmp_path: &Path) -> Result<(i64, Option<i32>), TilegenError> {
    if !tmp_path.exists() {
        return Err(TilegenError::TileGeneration {
            layer: tmp_path.display().to_string(),
            message: "tmp file not yet created".to_string(),
        });
    }
    let path_str = tmp_path.to_str().ok_or_else(|| TilegenError::TileGeneration {
        layer: tmp_path.display().to_string(),
        message: "tmp path is not valid UTF-8".to_string(),
    })?;

    let mut conn = SqliteConnectOptions::new()
        .filename(path_str)
        .read_only(true)
        .immutable(false) // martin-cp is actively writing
        .connect()
        .await?;

    let row = sqlx::query("SELECT COUNT(*) AS c, MAX(zoom_level) AS z FROM tiles")
        .fetch_one(&mut conn)
        .await?;
    let count: i64 = row.try_get("c").unwrap_or(0);
    let max_zoom: Option<i32> = row.try_get("z").ok();

    let _ = conn.close().await;
    Ok((count, max_zoom))
}
