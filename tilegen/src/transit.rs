use std::path::{Path, PathBuf};
use std::time::Instant;

use tokio::io::{AsyncBufReadExt, BufReader};

use crate::config::TransitLayerConfig;
use crate::error::TilegenError;

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

    let [west, south, east, north] = layer.bbox;
    let bbox = format!("{west},{south},{east},{north}");

    tracing::info!(
        layer = %layer.name,
        function = %layer.function,
        zoom = %format!("{}-{}", layer.min_zoom, layer.max_zoom),
        bbox = %bbox,
        "Generating transit tiles via martin-cp"
    );

    let mut cmd = tokio::process::Command::new("martin-cp");
    cmd.arg("--output-file").arg(&tmp_file);
    cmd.arg("--source").arg(&layer.function);
    cmd.arg("--min-zoom").arg(layer.min_zoom.to_string());
    cmd.arg("--max-zoom").arg(layer.max_zoom.to_string());
    cmd.arg("--bbox").arg(&bbox);
    // Store tiles uncompressed so Martin serves raw MVT that MapLibre can parse directly.
    // Martin doesn't add Content-Encoding headers for MBTiles-stored compressed tiles.
    cmd.arg("--encoding").arg("identity");
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

    let status = child.wait().await.map_err(|e| TilegenError::TileGeneration {
        layer: layer.name.clone(),
        message: format!("Failed to wait for martin-cp: {e}"),
    })?;

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
        return Err(TilegenError::TileGeneration {
            layer: layer.name.clone(),
            message: format!("martin-cp exited with code {:?}", status.code()),
        });
    }

    if !tmp_file.exists() {
        return Err(TilegenError::TileGeneration {
            layer: layer.name.clone(),
            message: "Output file not found after martin-cp run".to_string(),
        });
    }

    // Atomic rename
    std::fs::rename(&tmp_file, &output_file)?;

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

    Ok(TransitLayerResult {
        path: output_file,
        duration_ms: duration.as_millis() as i64,
        file_size_bytes: file_size as i64,
    })
}
