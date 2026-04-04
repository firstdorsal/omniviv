use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::config::WorldConfig;
use crate::error::TilegenError;

/// Generate world overview PMTiles using Planetiler with Natural Earth data only.
/// No PBF download required — Planetiler downloads Natural Earth automatically with --download.
pub async fn generate_world_overview(
    config: &WorldConfig,
    planetiler_jar: &str,
    output_dir: &Path,
) -> Result<PathBuf, TilegenError> {
    let start = Instant::now();
    let output_file = output_dir.join("world.pmtiles");
    let tmp_file = output_dir.join("world.tmp.pmtiles");

    tracing::info!(
        max_zoom = config.max_zoom,
        "Generating world overview tiles (Natural Earth)"
    );

    let jvm_args = ["-Xmx4g", "-Djava.awt.headless=true"];
    let planetiler_args = [
        format!("--output={}", tmp_file.display()),
        "--output-format=pmtiles".to_string(),
        "--minzoom=0".to_string(),
        format!("--maxzoom={}", config.max_zoom),
        "--download".to_string(),
        "--skip-osm".to_string(),
    ];

    crate::basemap::run_planetiler(
        "world",
        planetiler_jar,
        &jvm_args,
        &planetiler_args.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
    )
    .await?;

    if !tmp_file.exists() {
        return Err(TilegenError::Planetiler {
            region: "world".to_string(),
            exit_code: None,
            stderr: "Output file not found after Planetiler run".to_string(),
        });
    }

    std::fs::rename(&tmp_file, &output_file)?;

    let file_size = std::fs::metadata(&output_file)
        .map(|m| m.len())
        .unwrap_or(0);

    tracing::info!(
        size_mb = file_size / 1_048_576,
        duration_secs = start.elapsed().as_secs(),
        "World overview tiles generated"
    );

    Ok(output_file)
}
