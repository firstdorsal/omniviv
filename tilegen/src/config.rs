use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde::Deserialize;

use crate::error::TilegenError;

/// Read an environment variable, supporting the `_FILE` suffix convention.
/// If `{name}_FILE` is set, reads the file at that path and returns its contents (trimmed).
/// Otherwise, reads the value of `{name}` directly.
pub fn read_env_or_file(name: &str) -> Result<String, TilegenError> {
    let file_var = format!("{name}_FILE");
    if let Ok(path) = std::env::var(&file_var) {
        std::fs::read_to_string(&path)
            .map(|s| s.trim().to_string())
            .map_err(|e| TilegenError::ConfigRead {
                path: PathBuf::from(&path),
                source: e,
            })
    } else {
        std::env::var(name).map_err(|_| TilegenError::MissingEnvVar(name.to_string()))
    }
}

/// Top-level tilegen configuration loaded from YAML.
/// Database URL is NOT in this struct — it comes from the environment via `read_env_or_file`.
#[derive(Debug, Deserialize)]
pub struct Config {
    /// Output directory for generated tile files (MBTiles for transit, PMTiles for basemap)
    pub output_dir: PathBuf,

    /// Working directory for PBF downloads and temp files
    pub work_dir: PathBuf,

    /// How often to check if layers need regeneration
    #[serde(with = "humantime_serde")]
    pub check_interval: std::time::Duration,

    /// Geographic regions for basemap generation (Planetiler)
    pub regions: Vec<RegionConfig>,

    /// World overview configuration
    pub world: WorldConfig,

    /// Transit tile layers (generated from PostGIS via martin-cp)
    pub transit: TransitConfig,
}

/// A geographic region for basemap tile generation.
#[derive(Debug, Clone, Deserialize)]
pub struct RegionConfig {
    /// Region identifier (e.g. "germany", "bayern")
    pub name: String,

    /// URL to download the OSM PBF extract (must be https://)
    pub pbf_url: String,

    /// Bounding box [west, south, east, north] in WGS84
    pub bbox: [f64; 4],

    /// Minimum zoom level for tile generation
    pub min_zoom: u8,

    /// Maximum zoom level for tile generation
    pub max_zoom: u8,

    /// Regeneration interval
    #[serde(with = "humantime_serde")]
    pub regen_interval: std::time::Duration,

    /// Whether this region is enabled for generation
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// World overview configuration (Natural Earth data, no PBF download).
#[derive(Debug, Deserialize)]
pub struct WorldConfig {
    pub enabled: bool,
    pub max_zoom: u8,
    #[serde(with = "humantime_serde")]
    pub regen_interval: std::time::Duration,
}

/// Transit tile layers. Each layer maps to one individual PostGIS tile function
/// and produces one MBTiles file via martin-cp. This is much faster than using
/// composite functions because each function only computes the data it needs.
#[derive(Debug, Deserialize)]
pub struct TransitConfig {
    /// Individual transit layers to generate
    pub layers: Vec<TransitLayerConfig>,
}

/// A single transit layer generated from one PostGIS tile function via martin-cp.
#[derive(Debug, Deserialize)]
pub struct TransitLayerConfig {
    /// Layer name — used as the MBTiles filename and Martin source name.
    /// Must match the frontend's tile URL (e.g. "tile_stations" → /tile_stations/{z}/{x}/{y}).
    pub name: String,

    /// PostGIS function name (must match a `(z int, x int, y int) -> bytea` function)
    pub function: String,

    /// Regeneration interval
    #[serde(with = "humantime_serde")]
    pub regen_interval: std::time::Duration,

    /// Bounding box for tile generation [west, south, east, north]
    pub bbox: [f64; 4],

    /// Minimum zoom level
    pub min_zoom: u8,

    /// Maximum zoom level
    pub max_zoom: u8,

    /// Whether this layer is enabled for generation
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

impl Config {
    /// Load config from a YAML file.
    pub fn load(path: &Path) -> Result<Self, TilegenError> {
        let content = std::fs::read_to_string(path).map_err(|e| TilegenError::ConfigRead {
            path: path.to_path_buf(),
            source: e,
        })?;
        let config: Config = serde_yaml_neo::from_str(&content)?;
        config.validate()?;
        Ok(config)
    }

    /// Validate config values.
    fn validate(&self) -> Result<(), TilegenError> {
        static SAFE_NAME: LazyLock<regex_lite::Regex> =
            LazyLock::new(|| regex_lite::Regex::new(r"^[a-z0-9_-]+$").expect("valid regex"));
        static VALID_IDENTIFIER: LazyLock<regex_lite::Regex> =
            LazyLock::new(|| regex_lite::Regex::new(r"^[a-z_][a-z0-9_]*$").expect("valid regex"));

        let safe_name = &*SAFE_NAME;
        let valid_identifier = &*VALID_IDENTIFIER;

        for region in &self.regions {
            // Validate region name for safe filesystem use (prevents path traversal)
            if !safe_name.is_match(&region.name) {
                return Err(TilegenError::ConfigValidation(format!(
                    "Region name '{}' contains invalid characters (only a-z, 0-9, _, - allowed)",
                    region.name
                )));
            }
            if !region.pbf_url.starts_with("https://") {
                return Err(TilegenError::ConfigValidation(format!(
                    "Region '{}' pbf_url must use https:// (got: {})",
                    region.name, region.pbf_url
                )));
            }
            if region.bbox[0] >= region.bbox[2] || region.bbox[1] >= region.bbox[3] {
                return Err(TilegenError::ConfigValidation(format!(
                    "Region '{}' bbox is invalid: west must < east, south must < north",
                    region.name
                )));
            }
            if region.min_zoom > region.max_zoom {
                return Err(TilegenError::ConfigValidation(format!(
                    "Region '{}' min_zoom ({}) > max_zoom ({})",
                    region.name, region.min_zoom, region.max_zoom
                )));
            }
        }

        // Validate transit layers
        for layer in &self.transit.layers {
            if !safe_name.is_match(&layer.name) {
                return Err(TilegenError::ConfigValidation(format!(
                    "Transit layer name '{}' contains invalid characters", layer.name
                )));
            }
            if layer.bbox[0] >= layer.bbox[2] || layer.bbox[1] >= layer.bbox[3] {
                return Err(TilegenError::ConfigValidation(format!(
                    "Transit layer '{}' bbox is invalid", layer.name
                )));
            }
            if layer.min_zoom > layer.max_zoom {
                return Err(TilegenError::ConfigValidation(format!(
                    "Transit layer '{}' min_zoom ({}) > max_zoom ({})",
                    layer.name, layer.min_zoom, layer.max_zoom
                )));
            }
            if !valid_identifier.is_match(&layer.function) {
                return Err(TilegenError::ConfigValidation(format!(
                    "Transit function '{}' is not a valid PostgreSQL identifier",
                    layer.function
                )));
            }
        }

        Ok(())
    }
}
