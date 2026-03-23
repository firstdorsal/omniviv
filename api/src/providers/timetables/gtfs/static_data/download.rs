use std::path::{Path, PathBuf};

use futures::StreamExt;
use tokio::io::AsyncWriteExt;
use tracing::{debug, info, warn};

use super::super::error::GtfsError;

/// Maximum allowed download size for GTFS zip (500 MB)
pub(crate) const MAX_DOWNLOAD_SIZE: u64 = 500 * 1024 * 1024;
/// Maximum allowed total decompressed size for GTFS zip (2 GB)
pub(crate) const MAX_DECOMPRESSED_SIZE: u64 = 2 * 1024 * 1024 * 1024;
/// Maximum length for cached HTTP header values (ETag, Last-Modified)
pub(crate) const MAX_HEADER_LENGTH: usize = 1024;

/// Known files in the cache directory. Everything else is cleaned up.
const CACHE_KNOWN_FILES: &[&str] = &["latest.zip", "metadata.json"];

/// Remove unexpected files from the cache directory and log disk usage.
pub(crate) async fn cleanup_cache(cache_dir: &Path) {
    let mut total_size: u64 = 0;
    let mut removed = 0usize;

    let mut entries = match tokio::fs::read_dir(cache_dir).await {
        Ok(entries) => entries,
        Err(_) => return,
    };

    while let Ok(Some(entry)) = entries.next_entry().await {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();

        if let Ok(meta) = entry.metadata().await {
            if CACHE_KNOWN_FILES.contains(&name.as_ref()) {
                total_size += meta.len();
            } else if meta.is_file() {
                // Remove unknown files (e.g., stale temp files from interrupted downloads)
                if let Err(e) = tokio::fs::remove_file(entry.path()).await {
                    warn!(file = %name, error = %e, "Failed to clean up unknown cache file");
                } else {
                    info!(file = %name, size_bytes = meta.len(), "Removed unknown file from GTFS cache");
                    removed += 1;
                }
            }
        }
    }

    if removed > 0 {
        info!(removed, "Cleaned up GTFS cache directory");
    }
    debug!(total_size_mb = total_size / (1024 * 1024), "GTFS cache disk usage");
}

/// Download the static GTFS feed to the cache directory.
/// Result of a feed download attempt.
pub struct DownloadResult {
    /// Path to the zip file (cached or freshly downloaded).
    pub zip_path: PathBuf,
    /// Whether the feed was freshly downloaded (true) or served from cache (false).
    pub was_updated: bool,
}

pub async fn download_feed(
    client: &reqwest::Client,
    url: &str,
    cache_dir: &str,
) -> Result<DownloadResult, GtfsError> {
    let cache_path = Path::new(cache_dir);
    tokio::fs::create_dir_all(cache_path).await?;

    // Clean up stale/unknown files before downloading
    cleanup_cache(cache_path).await;

    let zip_path = cache_path.join("latest.zip");
    let metadata_path = cache_path.join("metadata.json");

    // Conditional request with ETag/Last-Modified
    let mut request = client.get(url);
    if let Ok(meta_content) = tokio::fs::read_to_string(&metadata_path).await {
        if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&meta_content) {
            if let Some(etag) = meta.get("etag").and_then(|v| v.as_str()) {
                request = request.header("If-None-Match", etag);
            }
            if let Some(last_modified) = meta.get("last_modified").and_then(|v| v.as_str()) {
                request = request.header("If-Modified-Since", last_modified);
            }
        }
    }

    let response = request
        .timeout(std::time::Duration::from_secs(600))
        .send()
        .await?;

    if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        info!("Static GTFS feed not modified, using cached version");
        return Ok(DownloadResult {
            zip_path,
            was_updated: false,
        });
    }

    if !response.status().is_success() {
        return Err(GtfsError::NetworkMessage(format!(
            "GTFS download HTTP {}",
            response.status()
        )));
    }

    // Check Content-Length before downloading
    if let Some(content_length) = response.content_length() {
        if content_length > MAX_DOWNLOAD_SIZE {
            return Err(GtfsError::NetworkMessage(format!(
                "GTFS download too large: {} bytes (max {} bytes)",
                content_length, MAX_DOWNLOAD_SIZE
            )));
        }
    }

    // Save headers for future conditional requests (limited to MAX_HEADER_LENGTH)
    let etag = response
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .filter(|s| s.len() <= MAX_HEADER_LENGTH)
        .map(|s| s.to_string());
    let last_modified = response
        .headers()
        .get("last-modified")
        .and_then(|v| v.to_str().ok())
        .filter(|s| s.len() <= MAX_HEADER_LENGTH)
        .map(|s| s.to_string());

    // Stream download with size limit
    let mut total_bytes: u64 = 0;
    let mut file = tokio::fs::File::create(&zip_path).await?;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        total_bytes += chunk.len() as u64;
        if total_bytes > MAX_DOWNLOAD_SIZE {
            drop(file);
            let _ = tokio::fs::remove_file(&zip_path).await;
            return Err(GtfsError::NetworkMessage(format!(
                "GTFS download exceeded size limit at {} bytes (max {} bytes)",
                total_bytes, MAX_DOWNLOAD_SIZE
            )));
        }
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    drop(file);

    info!(size_mb = total_bytes / (1024 * 1024), "Downloaded static GTFS feed");

    let meta = serde_json::json!({
        "etag": etag,
        "last_modified": last_modified,
        "downloaded_at": chrono::Utc::now().to_rfc3339(),
    });
    let _ = tokio::fs::write(&metadata_path, meta.to_string()).await;

    Ok(DownloadResult {
        zip_path,
        was_updated: true,
    })
}
