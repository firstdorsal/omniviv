mod areas;
mod basemap;
mod config;
mod error;
mod mbtiles;
mod state;
mod transit;
mod world;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use clap::Parser;
use sqlx::postgres::PgPoolOptions;
use tracing_subscriber::EnvFilter;

use config::Config;
use error::TilegenError;

#[derive(Parser)]
#[command(name = "omniviv-tilegen", about = "Pre-generate vector tiles for omniviv")]
struct Cli {
    /// Path to the tilegen.yaml config file
    #[arg(short, long, default_value = "/app/tilegen.yaml")]
    config: PathBuf,

    /// Run a single generation cycle and exit (no loop)
    #[arg(long)]
    once: bool,

    /// Override check interval for testing (e.g. "10s")
    #[arg(long)]
    check_interval: Option<String>,
}

#[tokio::main]
async fn main() -> Result<(), TilegenError> {
    // Tracing setup (same pattern as api)
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn,sqlx::query=error")),
        )
        .init();

    let cli = Cli::parse();

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        build = env!("BUILD_TIMESTAMP"),
        "omniviv-tilegen starting"
    );

    // Load config
    let config = Config::load(&cli.config)?;

    // Read environment variables upfront (supports _FILE suffix convention)
    let database_url = config::read_env_or_file("DATABASE_URL")?;
    let planetiler_jar = basemap::resolve_planetiler_jar();

    // Connect to PostgreSQL
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await
        .map_err(|e| {
            tracing::error!("Failed to connect to PostgreSQL: {e}");
            e
        })?;

    tracing::info!("Connected to PostgreSQL");

    // Create output directories
    let basemap_dir = config.output_dir.join("basemap");
    let transit_dir = config.output_dir.join("transit");
    std::fs::create_dir_all(&basemap_dir)?;
    std::fs::create_dir_all(&transit_dir)?;

    // Clean up stale .tmp files from previous crashed runs
    cleanup_tmp_files(&basemap_dir);
    cleanup_tmp_files(&transit_dir);

    // Handle both SIGINT (Ctrl+C) and SIGTERM (Docker stop)
    let shutdown = Arc::new(AtomicBool::new(false));
    {
        let shutdown_signal = shutdown.clone();
        tokio::spawn(async move {
            let ctrl_c = tokio::signal::ctrl_c();

            #[cfg(unix)]
            {
                use tokio::signal::unix::{signal, SignalKind};
                let mut sigterm = signal(SignalKind::terminate()).expect("Failed to register SIGTERM handler");
                tokio::select! {
                    _ = ctrl_c => {},
                    _ = sigterm.recv() => {},
                }
            }

            #[cfg(not(unix))]
            {
                ctrl_c.await.ok();
            }

            tracing::info!("Received shutdown signal");
            shutdown_signal.store(true, Ordering::SeqCst);
        });
    }

    // Parse check interval (CLI override or config)
    let check_interval = if let Some(ref interval_str) = cli.check_interval {
        humantime::parse_duration(interval_str)
            .map_err(|e| TilegenError::ConfigValidation(format!("Invalid check_interval: {e}")))?
    } else {
        config.check_interval
    };

    // Generation loop
    loop {
        if shutdown.load(Ordering::SeqCst) {
            tracing::info!("Shutting down");
            break;
        }

        if let Err(e) = run_generation_cycle(&config, &pool, &database_url, &planetiler_jar, &basemap_dir, &transit_dir, &shutdown).await {
            tracing::error!("Generation cycle failed: {e}");
        }

        if cli.once {
            tracing::info!("Single run mode — exiting");
            break;
        }

        tracing::debug!(interval = ?check_interval, "Sleeping until next check");
        tokio::time::sleep(check_interval).await;
    }

    Ok(())
}

async fn run_generation_cycle(
    config: &Config,
    pool: &sqlx::PgPool,
    database_url: &str,
    planetiler_jar: &str,
    basemap_dir: &std::path::Path,
    transit_dir: &std::path::Path,
    shutdown: &Arc<AtomicBool>,
) -> Result<(), TilegenError> {

    if !state::database_has_transit_data(pool).await? {
        tracing::warn!("Database has no transit data (stations table empty). Skipping transit tile generation.");
    } else {
        // Determine which layers actually need regeneration (cloning so we can move into tasks)
        let mut to_generate: Vec<config::TransitLayerConfig> = Vec::new();
        for layer in &config.transit.layers {
            if !layer.enabled { continue; }
            if state::needs_regeneration(pool, &layer.name, layer.regen_interval).await? {
                to_generate.push(layer.clone());
            }
        }

        let concurrency = config.transit.concurrency;
        if config.transit.parallel_layers && to_generate.len() > 1 {
            // Generate all layers in parallel — each uses `concurrency` connections.
            tracing::info!(
                layers = to_generate.len(),
                concurrency_per_layer = concurrency,
                "Generating transit layers in parallel"
            );
            let mut handles = Vec::new();
            for layer in to_generate {
                let database_url = database_url.to_string();
                let transit_dir = transit_dir.to_path_buf();
                let pool = pool.clone();
                handles.push(tokio::spawn(async move {
                    let layer_name = layer.name.clone();
                    let result = transit::generate_transit_layer(&layer, &database_url, &transit_dir, concurrency, &pool).await;
                    (layer_name, result)
                }));
            }
            for handle in handles {
                if shutdown.load(Ordering::SeqCst) { break; }
                match handle.await {
                    Ok((layer_name, Ok(result))) => {
                        state::record_generation_success(pool, &layer_name, result.duration_ms, 0, result.file_size_bytes).await?;
                        tracing::info!(layer = %layer_name, path = %result.path.display(), "Transit layer ready");
                    }
                    Ok((layer_name, Err(e))) => {
                        tracing::error!(layer = %layer_name, "Transit layer generation failed: {e}");
                        state::record_generation_failure(pool, &layer_name, &e.to_string()).await?;
                    }
                    Err(e) => {
                        tracing::error!("Transit layer task panicked: {e}");
                    }
                }
            }
        } else {
            // Sequential mode — one layer at a time
            for layer in to_generate {
                if shutdown.load(Ordering::SeqCst) { break; }
                match transit::generate_transit_layer(&layer, database_url, transit_dir, concurrency, pool).await {
                    Ok(result) => {
                        state::record_generation_success(pool, &layer.name, result.duration_ms, 0, result.file_size_bytes).await?;
                        tracing::info!(layer = %layer.name, path = %result.path.display(), "Transit layer ready");
                    }
                    Err(e) => {
                        tracing::error!(layer = %layer.name, "Transit layer generation failed: {e}");
                        state::record_generation_failure(pool, &layer.name, &e.to_string()).await?;
                    }
                }
            }
        }
    }

    // Basemap regions (Planetiler)
    for region in &config.regions {
        if shutdown.load(Ordering::SeqCst) { break; }
        if !region.enabled { continue; }

        let state_key = format!("basemap/{}", region.name);
        if state::needs_regeneration(pool, &state_key, region.regen_interval).await? {
            match basemap::generate_basemap(region, planetiler_jar, &config.work_dir, basemap_dir).await {
                Ok(path) => {
                    let file_size = std::fs::metadata(&path).map(|m| m.len() as i64).unwrap_or(0);
                    state::record_generation_success(pool, &state_key, 0, 0, file_size).await?;
                    tracing::info!(path = %path.display(), "Basemap tiles ready");
                }
                Err(e) => {
                    tracing::error!(region = %region.name, "Basemap generation failed: {e}");
                    state::record_generation_failure(pool, &state_key, &e.to_string()).await?;
                }
            }
        }
    }

    // World overview (Natural Earth)
    if !shutdown.load(Ordering::SeqCst) && config.world.enabled {
        if state::needs_regeneration(pool, "world", config.world.regen_interval).await? {
            match world::generate_world_overview(&config.world, planetiler_jar, basemap_dir).await {
                Ok(path) => {
                    let file_size = std::fs::metadata(&path).map(|m| m.len() as i64).unwrap_or(0);
                    state::record_generation_success(pool, "world", 0, 0, file_size).await?;
                    tracing::info!(path = %path.display(), "World overview tiles ready");
                }
                Err(e) => {
                    tracing::error!("World overview generation failed: {e}");
                    state::record_generation_failure(pool, "world", &e.to_string()).await?;
                }
            }
        }
    }

    Ok(())
}

/// Remove stale .tmp files from a directory (leftover from previous crashed runs).
fn cleanup_tmp_files(dir: &std::path::Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.to_str().map(|s| s.contains(".tmp.")).unwrap_or(false)
            {
                tracing::warn!(path = %path.display(), "Removing stale temporary file");
                if let Err(e) = std::fs::remove_file(&path) {
                    tracing::warn!(path = %path.display(), "Failed to remove stale tmp file: {e}");
                }
            }
        }
    }
}
