use serde::Deserialize;
use std::path::{Path, PathBuf};

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
    /// Output directory for generated PMTiles files
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

    /// Transit tile groups (generated natively from PostGIS)
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

/// Transit tile configuration with grouped layers.
#[derive(Debug, Deserialize)]
pub struct TransitConfig {
    /// Overview group: stations + routes (z0-15)
    pub overview: TransitGroupConfig,
    /// Detail group: steige + outlines + debug (z15-17)
    pub detail: TransitGroupConfig,
}

/// A group of transit layers combined into a single PMTiles file.
#[derive(Debug, Deserialize)]
pub struct TransitGroupConfig {
    /// Regeneration interval
    #[serde(with = "humantime_serde")]
    pub regen_interval: std::time::Duration,

    /// Bounding box for tile generation
    pub bbox: [f64; 4],

    /// Minimum zoom level
    pub min_zoom: u8,

    /// Maximum zoom level
    pub max_zoom: u8,

    /// Layers to include in this group
    pub layers: Vec<TransitLayerConfig>,
}

/// A single transit layer within a group.
#[derive(Debug, Deserialize)]
pub struct TransitLayerConfig {
    /// MVT source-layer name (must match frontend source-layer references)
    pub name: String,

    /// PostGIS function name to call for tile generation
    pub function: String,
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
        let safe_name = regex_lite::Regex::new(r"^[a-z0-9_-]+$").unwrap();
        let valid_identifier = regex_lite::Regex::new(r"^[a-z_][a-z0-9_]*$").unwrap();

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

        // Validate transit groups
        for (group_name, group) in [("overview", &self.transit.overview), ("detail", &self.transit.detail)] {
            if group.bbox[0] >= group.bbox[2] || group.bbox[1] >= group.bbox[3] {
                return Err(TilegenError::ConfigValidation(format!(
                    "Transit group '{group_name}' bbox is invalid"
                )));
            }
            if group.min_zoom > group.max_zoom {
                return Err(TilegenError::ConfigValidation(format!(
                    "Transit group '{group_name}' min_zoom ({}) > max_zoom ({})",
                    group.min_zoom, group.max_zoom
                )));
            }
            for layer in &group.layers {
                if !valid_identifier.is_match(&layer.function) {
                    return Err(TilegenError::ConfigValidation(format!(
                        "Transit layer function '{}' is not a valid PostgreSQL identifier",
                        layer.function
                    )));
                }
            }
        }

        Ok(())
    }
}
