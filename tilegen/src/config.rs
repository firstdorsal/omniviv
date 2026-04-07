use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde::Deserialize;

use crate::areas::{resolve_areas, BoundingBox};
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

    /// Explicit bounding box [west, south, east, north] in WGS84.
    /// Mutually exclusive with `areas`.
    #[serde(default)]
    pub bbox: Option<[f64; 4]>,

    /// List of named areas (e.g. ["bayern"], ["germany"], ["bayern", "berlin"]).
    /// Resolved to a union bounding box. Mutually exclusive with `bbox`.
    #[serde(default)]
    pub areas: Option<Vec<String>>,

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

impl RegionConfig {
    /// Resolve the configured `bbox` or `areas` to a single bounding box.
    pub fn resolved_bbox(&self) -> Result<BoundingBox, TilegenError> {
        match (&self.bbox, &self.areas) {
            (Some(bbox), None) => Ok(*bbox),
            (None, Some(areas)) => resolve_areas(areas),
            (Some(_), Some(_)) => Err(TilegenError::ConfigValidation(format!(
                "Region '{}' has both 'bbox' and 'areas' — specify only one",
                self.name
            ))),
            (None, None) => Err(TilegenError::ConfigValidation(format!(
                "Region '{}' must specify either 'bbox' or 'areas'",
                self.name
            ))),
        }
    }
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

    /// Number of concurrent PostgreSQL connections to use per layer.
    /// Higher values speed up generation at the cost of more database load.
    /// Default 16.
    #[serde(default = "default_concurrency")]
    pub concurrency: u32,

    /// Generate multiple layers in parallel (true) or sequentially (false).
    /// Each layer uses `concurrency` connections, so the total connections
    /// used is `concurrency * (number of enabled layers)` when parallel.
    /// Default true.
    #[serde(default = "default_true")]
    pub parallel_layers: bool,
}

fn default_concurrency() -> u32 {
    16
}

/// A single transit layer generated from one PostGIS tile function via martin-cp.
#[derive(Debug, Clone, Deserialize)]
pub struct TransitLayerConfig {
    /// Layer name — used as the MBTiles filename and Martin source name.
    /// Must match the frontend's tile URL (e.g. "tile_stations" → /tile_stations/{z}/{x}/{y}).
    pub name: String,

    /// PostGIS function name (must match a `(z int, x int, y int) -> bytea` function)
    pub function: String,

    /// Regeneration interval
    #[serde(with = "humantime_serde")]
    pub regen_interval: std::time::Duration,

    /// Explicit bounding box [west, south, east, north]. Mutually exclusive with `areas`.
    #[serde(default)]
    pub bbox: Option<[f64; 4]>,

    /// List of named areas (e.g. ["bayern"], ["germany"], ["bayern", "berlin"]).
    /// Resolved to a union bounding box. Mutually exclusive with `bbox`.
    #[serde(default)]
    pub areas: Option<Vec<String>>,

    /// Minimum zoom level
    pub min_zoom: u8,

    /// Maximum zoom level
    pub max_zoom: u8,

    /// Whether this layer is enabled for generation
    #[serde(default = "default_true")]
    pub enabled: bool,
}

impl TransitLayerConfig {
    /// Resolve the configured `bbox` or `areas` to a single bounding box.
    pub fn resolved_bbox(&self) -> Result<BoundingBox, TilegenError> {
        match (&self.bbox, &self.areas) {
            (Some(bbox), None) => Ok(*bbox),
            (None, Some(areas)) => resolve_areas(areas),
            (Some(_), Some(_)) => Err(TilegenError::ConfigValidation(format!(
                "Transit layer '{}' has both 'bbox' and 'areas' — specify only one",
                self.name
            ))),
            (None, None) => Err(TilegenError::ConfigValidation(format!(
                "Transit layer '{}' must specify either 'bbox' or 'areas'",
                self.name
            ))),
        }
    }
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
            // Resolve bbox/areas — also catches missing/conflicting/unknown values
            let bbox = region.resolved_bbox()?;
            if bbox[0] >= bbox[2] || bbox[1] >= bbox[3] {
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
            // Resolve bbox/areas — also catches missing/conflicting/unknown values
            let bbox = layer.resolved_bbox()?;
            if bbox[0] >= bbox[2] || bbox[1] >= bbox[3] {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_yaml(yaml: &str) -> Result<Config, TilegenError> {
        let config: Config = serde_yaml_neo::from_str(yaml)?;
        config.validate()?;
        Ok(config)
    }

    const VALID_HEAD: &str = r#"
output_dir: /tiles
work_dir: /data
check_interval: "5m"
regions: []
world:
  enabled: false
  max_zoom: 7
  regen_interval: "7d"
"#;

    #[test]
    fn transit_layer_with_areas_resolves_to_bbox() {
        let yaml = format!("{VALID_HEAD}\ntransit:\n  layers:\n    - name: transit_stations\n      function: transit_stations\n      regen_interval: \"1d\"\n      areas: [\"bayern\"]\n      min_zoom: 0\n      max_zoom: 15\n");
        let config = parse_yaml(&yaml).expect("config should validate");
        let layer = &config.transit.layers[0];
        let bbox = layer.resolved_bbox().unwrap();
        assert_eq!(bbox, [8.97, 47.27, 13.84, 50.57]);
    }

    #[test]
    fn transit_layer_with_germany_resolves_to_country_bbox() {
        let yaml = format!("{VALID_HEAD}\ntransit:\n  layers:\n    - name: transit_stations\n      function: transit_stations\n      regen_interval: \"1d\"\n      areas: [\"germany\"]\n      min_zoom: 0\n      max_zoom: 15\n");
        let config = parse_yaml(&yaml).expect("config should validate");
        let bbox = config.transit.layers[0].resolved_bbox().unwrap();
        assert_eq!(bbox, [5.87, 47.27, 15.04, 55.06]);
    }

    #[test]
    fn transit_layer_with_multiple_areas_resolves_to_union() {
        let yaml = format!("{VALID_HEAD}\ntransit:\n  layers:\n    - name: transit_stations\n      function: transit_stations\n      regen_interval: \"1d\"\n      areas: [\"bayern\", \"berlin\"]\n      min_zoom: 0\n      max_zoom: 15\n");
        let config = parse_yaml(&yaml).expect("config should validate");
        let bbox = config.transit.layers[0].resolved_bbox().unwrap();
        // Bayern + Berlin → bbox covers both
        assert!(bbox[0] <= 8.97 && bbox[2] >= 13.84);
        assert!(bbox[1] <= 47.27 && bbox[3] >= 52.68);
    }

    #[test]
    fn transit_layer_with_explicit_bbox_works() {
        let yaml = format!("{VALID_HEAD}\ntransit:\n  layers:\n    - name: transit_stations\n      function: transit_stations\n      regen_interval: \"1d\"\n      bbox: [10.85, 48.33, 10.93, 48.39]\n      min_zoom: 0\n      max_zoom: 15\n");
        let config = parse_yaml(&yaml).expect("config should validate");
        let bbox = config.transit.layers[0].resolved_bbox().unwrap();
        assert_eq!(bbox, [10.85, 48.33, 10.93, 48.39]);
    }

    #[test]
    fn transit_layer_without_bbox_or_areas_fails() {
        let yaml = format!("{VALID_HEAD}\ntransit:\n  layers:\n    - name: transit_stations\n      function: transit_stations\n      regen_interval: \"1d\"\n      min_zoom: 0\n      max_zoom: 15\n");
        let result = parse_yaml(&yaml);
        assert!(result.is_err(), "config without bbox or areas should fail validation");
    }

    #[test]
    fn transit_layer_with_both_bbox_and_areas_fails() {
        let yaml = format!("{VALID_HEAD}\ntransit:\n  layers:\n    - name: transit_stations\n      function: transit_stations\n      regen_interval: \"1d\"\n      bbox: [10.85, 48.33, 10.93, 48.39]\n      areas: [\"bayern\"]\n      min_zoom: 0\n      max_zoom: 15\n");
        let result = parse_yaml(&yaml);
        assert!(result.is_err(), "config with both bbox and areas should fail validation");
    }

    #[test]
    fn transit_layer_with_unknown_area_fails() {
        let yaml = format!("{VALID_HEAD}\ntransit:\n  layers:\n    - name: transit_stations\n      function: transit_stations\n      regen_interval: \"1d\"\n      areas: [\"narnia\"]\n      min_zoom: 0\n      max_zoom: 15\n");
        let result = parse_yaml(&yaml);
        assert!(result.is_err(), "config with unknown area should fail validation");
    }
}
