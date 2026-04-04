use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::time::Instant;

use pmtiles::{Compression, PmTilesWriter, TileCoord, TileType};
use sqlx::PgPool;

use crate::config::TransitGroupConfig;
use crate::error::TilegenError;
use crate::state;

/// Generate a composite PMTiles file for a transit layer group.
///
/// For each tile coordinate in the configured zoom/bbox range, calls every
/// layer's PostGIS function via sqlx, concatenates the MVT bytes, and streams
/// tiles directly to the PMTiles writer (no in-memory buffering of all tiles).
///
/// MVT concatenation: each PostGIS tile function returns a complete MVT with
/// its own named source-layer. Multiple MVT byte sequences can be concatenated
/// because the protobuf wire format is additive — repeated fields from separate
/// messages merge correctly when decoded together.
pub async fn generate_transit_group(
    pool: &PgPool,
    group_name: &str,
    group_config: &TransitGroupConfig,
    output_dir: &Path,
) -> Result<PathBuf, TilegenError> {
    let start = Instant::now();
    let output_file = output_dir.join(format!("{group_name}.pmtiles"));
    let tmp_file = output_dir.join(format!("{group_name}.tmp.pmtiles"));

    tracing::info!(
        group = group_name,
        zoom = %format!("{}-{}", group_config.min_zoom, group_config.max_zoom),
        layers = group_config.layers.len(),
        "Generating transit tiles"
    );

    state::record_generation_start(pool, group_name).await?;

    let [west, south, east, north] = group_config.bbox;
    let mut tile_count: i64 = 0;

    // Stream tiles directly to PMTiles writer — no in-memory buffering
    let file = std::fs::File::create(&tmp_file)?;
    let writer = BufWriter::new(file);
    let mut pm_writer = PmTilesWriter::new(TileType::Mvt)
        .tile_compression(Compression::Gzip)
        .min_zoom(group_config.min_zoom)
        .max_zoom(group_config.max_zoom)
        .bounds(west, south, east, north)
        .create(writer)
        .map_err(|e| TilegenError::PmtilesWrite(format!("Failed to create PMTiles writer: {e}")))?;

    for zoom in group_config.min_zoom..=group_config.max_zoom {
        let (x_min, x_max, y_min, y_max) = bbox_to_tile_range(west, south, east, north, zoom);

        tracing::debug!(
            group = group_name,
            zoom,
            tiles = (x_max - x_min + 1) * (y_max - y_min + 1),
            "Processing zoom level"
        );

        for x in x_min..=x_max {
            for y in y_min..=y_max {
                let mut combined_mvt = Vec::new();

                for layer in &group_config.layers {
                    // Function names are validated as PostgreSQL identifiers (^[a-z_][a-z0-9_]*$)
                    // in config.rs, making this format!() safe from SQL injection.
                    let mvt_bytes: Option<Vec<u8>> = sqlx::query_scalar(&format!(
                        "SELECT {}($1, $2, $3)",
                        layer.function
                    ))
                    .bind(zoom as i32)
                    .bind(x as i32)
                    .bind(y as i32)
                    .fetch_optional(pool)
                    .await
                    .map_err(|e| TilegenError::TileGeneration {
                        layer: format!("{group_name}/{}", layer.name),
                        message: format!("SQL function {} failed at z={zoom} x={x} y={y}: {e}", layer.function),
                    })?
                    .flatten();

                    if let Some(bytes) = mvt_bytes {
                        if !bytes.is_empty() {
                            combined_mvt.extend_from_slice(&bytes);
                        }
                    }
                }

                if !combined_mvt.is_empty() {
                    let coord = TileCoord::new(zoom, x, y)
                        .map_err(|e| TilegenError::PmtilesWrite(format!("Invalid tile coord z={zoom} x={x} y={y}: {e}")))?;
                    pm_writer.add_tile(coord, &combined_mvt)
                        .map_err(|e| TilegenError::PmtilesWrite(format!("Failed to write tile z={zoom} x={x} y={y}: {e}")))?;
                    tile_count += 1;
                }
            }
        }

        tracing::info!(
            group = group_name,
            zoom,
            tiles_so_far = tile_count,
            "Zoom level complete"
        );
    }

    pm_writer.finalize()
        .map_err(|e| TilegenError::PmtilesWrite(format!("Failed to finalize PMTiles: {e}")))?;

    // Atomic rename
    std::fs::rename(&tmp_file, &output_file)?;

    let file_size = std::fs::metadata(&output_file)
        .map(|m| m.len() as i64)
        .unwrap_or(0);
    let duration = start.elapsed();

    state::record_generation_success(
        pool,
        group_name,
        duration.as_millis() as i64,
        tile_count,
        file_size,
    )
    .await?;

    tracing::info!(
        group = group_name,
        tiles = tile_count,
        size_mb = file_size / 1_048_576,
        duration_secs = duration.as_secs(),
        "Transit tiles generated"
    );

    Ok(output_file)
}

/// Convert a WGS84 bounding box to tile coordinate ranges at a given zoom level.
fn bbox_to_tile_range(west: f64, south: f64, east: f64, north: f64, zoom: u8) -> (u32, u32, u32, u32) {
    let n = 2u32.pow(zoom as u32);

    let x_min = ((west + 180.0) / 360.0 * n as f64).floor() as u32;
    let x_max = ((east + 180.0) / 360.0 * n as f64).floor().min((n - 1) as f64) as u32;

    let y_min = ((1.0 - (north.to_radians().tan() + 1.0 / north.to_radians().cos()).ln() / std::f64::consts::PI) / 2.0 * n as f64)
        .floor()
        .max(0.0) as u32;
    let y_max = ((1.0 - (south.to_radians().tan() + 1.0 / south.to_radians().cos()).ln() / std::f64::consts::PI) / 2.0 * n as f64)
        .floor()
        .min((n - 1) as f64) as u32;

    (x_min, x_max, y_min, y_max)
}
