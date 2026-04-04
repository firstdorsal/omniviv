use std::path::{Path, PathBuf};
use std::time::Instant;

use tokio::io::{AsyncBufReadExt, BufReader};

use crate::config::RegionConfig;
use crate::error::TilegenError;

/// Default path to the Planetiler JAR inside the Docker container.
const DEFAULT_PLANETILER_JAR: &str = "/opt/planetiler.jar";

/// Generate basemap PMTiles for a region using Planetiler.
///
/// Downloads the PBF file if missing or older than the regen interval,
/// then runs Planetiler as a subprocess to produce PMTiles output.
pub async fn generate_basemap(
    region: &RegionConfig,
    planetiler_jar: &str,
    work_dir: &Path,
    output_dir: &Path,
) -> Result<PathBuf, TilegenError> {
    let start = Instant::now();
    let pbf_path = work_dir.join(format!("{}.osm.pbf", region.name));
    let output_file = output_dir.join(format!("{}.pmtiles", region.name));
    let tmp_file = output_dir.join(format!("{}.tmp.pmtiles", region.name));

    // Download PBF if missing or stale (older than regen interval)
    let should_download = if !pbf_path.exists() {
        true
    } else {
        let age = std::fs::metadata(&pbf_path)
            .and_then(|m| m.modified())
            .map(|t| t.elapsed().unwrap_or_default())
            .unwrap_or(std::time::Duration::MAX);
        age > region.regen_interval
    };

    if should_download {
        download_pbf(&region.pbf_url, &pbf_path).await?;
    }

    let [west, south, east, north] = region.bbox;
    let bounds = format!("{west},{south},{east},{north}");

    tracing::info!(
        region = %region.name,
        zoom = %format!("{}-{}", region.min_zoom, region.max_zoom),
        pbf = %pbf_path.display(),
        "Running Planetiler for basemap"
    );

    let jvm_args = ["-Xmx10g", "-Djava.awt.headless=true"];
    let planetiler_args = [
        format!("--osm-path={}", pbf_path.display()),
        format!("--output={}", tmp_file.display()),
        "--output-format=pmtiles".to_string(),
        format!("--bounds={bounds}"),
        format!("--minzoom={}", region.min_zoom),
        format!("--maxzoom={}", region.max_zoom),
        "--download".to_string(),
        "--nodemap-type=array".to_string(),
    ];

    run_planetiler(&region.name, planetiler_jar, &jvm_args, &planetiler_args.iter().map(|s| s.as_str()).collect::<Vec<_>>()).await?;

    if !tmp_file.exists() {
        return Err(TilegenError::Planetiler {
            region: region.name.clone(),
            exit_code: None,
            stderr: "Output file not found after Planetiler run".to_string(),
        });
    }

    std::fs::rename(&tmp_file, &output_file)?;

    let file_size = std::fs::metadata(&output_file)
        .map(|m| m.len())
        .unwrap_or(0);

    tracing::info!(
        region = %region.name,
        size_mb = file_size / 1_048_576,
        duration_secs = start.elapsed().as_secs(),
        "Basemap tiles generated"
    );

    Ok(output_file)
}

/// Download a PBF file with streaming, timeout, and integrity verification.
async fn download_pbf(url: &str, destination: &Path) -> Result<(), TilegenError> {
    use futures::StreamExt;
    use tokio::io::AsyncWriteExt;

    tracing::info!(url, path = %destination.display(), "Downloading PBF");

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(3600)) // 1 hour max for large PBFs
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| TilegenError::PbfDownload {
            url: url.to_string(),
            message: format!("Failed to create HTTP client: {e}"),
        })?;

    let response = client.get(url).send().await.map_err(|e| TilegenError::PbfDownload {
        url: url.to_string(),
        message: e.to_string(),
    })?;

    if !response.status().is_success() {
        return Err(TilegenError::PbfDownload {
            url: url.to_string(),
            message: format!("HTTP {}", response.status()),
        });
    }

    let total_size = response.content_length();
    let mut downloaded: u64 = 0;
    let mut last_log = Instant::now();

    let tmp_path = destination.with_extension("pbf.tmp");
    let mut file = tokio::fs::File::create(&tmp_path).await?;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| TilegenError::PbfDownload {
            url: url.to_string(),
            message: format!("Stream error: {e}"),
        })?;
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;

        if last_log.elapsed().as_secs() >= 10 {
            if let Some(total) = total_size {
                tracing::info!(
                    downloaded_mb = downloaded / 1_048_576,
                    total_mb = total / 1_048_576,
                    percent = (downloaded as f64 / total as f64 * 100.0) as u32,
                    "PBF download progress"
                );
            }
            last_log = Instant::now();
        }
    }

    file.flush().await?;
    drop(file);

    // Verify size matches Content-Length
    if let Some(expected) = total_size {
        let actual = std::fs::metadata(&tmp_path)?.len();
        if actual != expected {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(TilegenError::PbfDownload {
                url: url.to_string(),
                message: format!("Size mismatch: expected {expected} bytes, got {actual}"),
            });
        }
    }

    std::fs::rename(&tmp_path, destination)?;
    tracing::info!(size_mb = downloaded / 1_048_576, "PBF download complete");
    Ok(())
}

/// Run Planetiler as a subprocess via tokio::process.
///
/// JVM args (e.g. -Xmx10g) are placed before -jar, Planetiler args after.
/// stdout is sent to null (Planetiler only logs to stderr).
/// stderr is streamed to tracing in real-time.
pub async fn run_planetiler(
    region_name: &str,
    planetiler_jar: &str,
    jvm_args: &[&str],
    planetiler_args: &[&str],
) -> Result<(), TilegenError> {
    let jar_path = planetiler_jar;

    let mut cmd = tokio::process::Command::new("java");

    // JVM args first (before -jar)
    for arg in jvm_args {
        cmd.arg(arg);
    }

    cmd.arg("-jar").arg(jar_path);

    // Planetiler args after -jar
    for arg in planetiler_args {
        cmd.arg(arg);
    }

    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| TilegenError::Planetiler {
        region: region_name.to_string(),
        exit_code: None,
        stderr: format!("Failed to spawn Planetiler: {e}"),
    })?;

    // Stream stderr to tracing in real-time
    let stderr_handle = if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        Some(tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "planetiler", "{}", line);
            }
        }))
    } else {
        None
    };

    let status = child.wait().await.map_err(|e| TilegenError::Planetiler {
        region: region_name.to_string(),
        exit_code: None,
        stderr: format!("Failed to wait for Planetiler: {e}"),
    })?;

    // Wait for stderr reader to finish before reporting errors
    if let Some(handle) = stderr_handle {
        let _ = handle.await;
    }

    if !status.success() {
        return Err(TilegenError::Planetiler {
            region: region_name.to_string(),
            exit_code: status.code(),
            stderr: format!("Planetiler exited with code {:?}", status.code()),
        });
    }

    Ok(())
}

/// Get the Planetiler JAR path from environment or use default.
pub fn resolve_planetiler_jar() -> String {
    crate::config::read_env_or_file("PLANETILER_JAR")
        .unwrap_or_else(|_| DEFAULT_PLANETILER_JAR.to_string())
}
