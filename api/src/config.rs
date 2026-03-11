use serde::Deserialize;
use std::path::Path;
use tracing::warn;

/// Read an environment variable, supporting the `_FILE` suffix convention.
///
/// If `{name}_FILE` is set, reads the file at that path and returns its contents (trimmed).
/// Otherwise, reads the value of `{name}` directly.
pub fn read_env_or_file(name: &str) -> Result<String, ConfigError> {
    let file_var = format!("{}_FILE", name);
    if let Ok(path) = std::env::var(&file_var) {
        std::fs::read_to_string(&path)
            .map(|s| s.trim().to_string())
            .map_err(|e| ConfigError::ReadError(format!("Failed to read {}: {}", path, e)))
    } else {
        std::env::var(name).map_err(|_| ConfigError::MissingEnvVar(name.to_string()))
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub areas: Vec<Area>,
    /// Allowed CORS origins. Required unless cors_permissive is true.
    #[serde(default)]
    pub cors_origins: Vec<String>,
    /// Explicitly allow all origins (development only). Defaults to false.
    #[serde(default)]
    pub cors_permissive: bool,
    /// GTFS sync configuration
    #[serde(default)]
    pub gtfs_sync: GtfsSyncConfig,
}

/// Configuration for GTFS-based departure sync.
///
/// All fields have sensible defaults for the German GTFS feed
/// (<https://gtfs.de>). The static feed (~216MB) is cached on disk
/// and refreshed periodically. The realtime feed (~1-5MB protobuf)
/// is polled at a configurable interval.
///
/// The GTFS schedule is loaded into PostgreSQL for persistent storage
/// and queried at runtime. No in-memory schedule cache is maintained.
#[derive(Debug, Clone, Deserialize)]
pub struct GtfsSyncConfig {
    /// URL to download the static GTFS zip (default: gtfs.de all-Germany feed)
    #[serde(default = "GtfsSyncConfig::default_static_feed_url")]
    pub static_feed_url: String,
    /// URL for the GTFS-RT protobuf feed (default: gtfs.de realtime feed)
    #[serde(default = "GtfsSyncConfig::default_realtime_feed_url")]
    pub realtime_feed_url: String,
    /// Directory to cache the static GTFS zip on disk. The zip is only
    /// re-downloaded if the server indicates a newer version (via ETag/Last-Modified).
    #[serde(default = "GtfsSyncConfig::default_cache_dir")]
    pub cache_dir: String,
    /// How often to re-download static GTFS data (hours). Defaults to 24.
    /// The static schedule changes infrequently (typically weekly), but daily
    /// checks ensure timely pickup of service changes. The download uses
    /// HTTP conditional requests so no data is transferred if unchanged.
    #[serde(default = "GtfsSyncConfig::default_static_refresh_hours")]
    pub static_refresh_hours: u64,
    /// How often to poll the GTFS-RT feed (seconds). Defaults to 15.
    /// Lower values give more responsive real-time updates but increase
    /// network and CPU load.
    #[serde(default = "GtfsSyncConfig::default_realtime_interval_secs")]
    pub realtime_interval_secs: u64,
    /// Only show departures up to this many minutes in the future. Defaults to 120.
    /// Controls the time window for both real-time and schedule-based departures.
    /// Larger values return more departures per stop but increase response size.
    #[serde(default = "GtfsSyncConfig::default_time_horizon_minutes")]
    pub time_horizon_minutes: u32,
    /// IANA timezone for interpreting GTFS schedule times (e.g. "Europe/Berlin").
    /// GTFS schedule times are local to the transit agency's timezone. This
    /// setting must match the feed's timezone for correct UTC conversion,
    /// including DST transitions.
    #[serde(default = "GtfsSyncConfig::default_timezone")]
    pub timezone: String,
}

impl Default for GtfsSyncConfig {
    fn default() -> Self {
        Self {
            static_feed_url: Self::default_static_feed_url(),
            realtime_feed_url: Self::default_realtime_feed_url(),
            cache_dir: Self::default_cache_dir(),
            static_refresh_hours: Self::default_static_refresh_hours(),
            realtime_interval_secs: Self::default_realtime_interval_secs(),
            time_horizon_minutes: Self::default_time_horizon_minutes(),
            timezone: Self::default_timezone(),
        }
    }
}

impl GtfsSyncConfig {
    /// Validate configuration values and log warnings for potential issues.
    pub fn validate(&self) {
        if !self.static_feed_url.starts_with("https://") {
            warn!(
                url = %self.static_feed_url,
                "GTFS static feed URL does not use HTTPS — data may be intercepted"
            );
        }
        if !self.realtime_feed_url.starts_with("https://") {
            warn!(
                url = %self.realtime_feed_url,
                "GTFS realtime feed URL does not use HTTPS — data may be intercepted"
            );
        }
        if self.timezone.parse::<chrono_tz::Tz>().is_err() {
            warn!(
                timezone = %self.timezone,
                "Invalid IANA timezone, will fall back to Europe/Berlin"
            );
        }
    }

    /// Parse the configured timezone, falling back to Europe/Berlin.
    pub fn parsed_timezone(&self) -> chrono_tz::Tz {
        self.timezone
            .parse::<chrono_tz::Tz>()
            .unwrap_or(chrono_tz::Europe::Berlin)
    }

    fn default_static_feed_url() -> String {
        "https://download.gtfs.de/germany/free/latest.zip".to_string()
    }
    fn default_realtime_feed_url() -> String {
        "https://realtime.gtfs.de/realtime-free.pb".to_string()
    }
    fn default_cache_dir() -> String {
        "./data/gtfs".to_string()
    }
    fn default_static_refresh_hours() -> u64 {
        24
    }
    fn default_realtime_interval_secs() -> u64 {
        15
    }
    fn default_time_horizon_minutes() -> u32 {
        120
    }
    fn default_timezone() -> String {
        "Europe/Berlin".to_string()
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Area {
    pub name: String,
    pub bounding_box: BoundingBox,
    pub transport_types: Vec<TransportType>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct BoundingBox {
    pub south: f64,
    pub west: f64,
    pub north: f64,
    pub east: f64,
}

impl BoundingBox {
    /// Returns bbox as Overpass API format string: "south,west,north,east"
    pub fn to_overpass_string(&self) -> String {
        format!("{},{},{},{}", self.south, self.west, self.north, self.east)
    }

    /// Validate that the bounding box coordinates are consistent and within range.
    pub fn validate(&self) -> Result<(), String> {
        if self.south > self.north {
            return Err("south > north".to_string());
        }
        if self.west > self.east {
            return Err("west > east".to_string());
        }
        if self.south < -90.0 || self.north > 90.0 {
            return Err("latitude out of range".to_string());
        }
        if self.west < -180.0 || self.east > 180.0 {
            return Err("longitude out of range".to_string());
        }
        Ok(())
    }

    /// Check whether a coordinate falls within this bounding box.
    pub fn contains(&self, lat: f64, lon: f64) -> bool {
        lat >= self.south && lat <= self.north && lon >= self.west && lon <= self.east
    }
}

/// Transport type for both configuration and runtime detection
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TransportType {
    Tram,
    Bus,
    Subway,
    Train,
    Ferry,
    /// Used when transport type cannot be determined from OSM data
    #[serde(other)]
    Unknown,
}

impl TransportType {
    pub fn as_str(&self) -> &'static str {
        match self {
            TransportType::Tram => "tram",
            TransportType::Bus => "bus",
            TransportType::Subway => "subway",
            TransportType::Train => "train",
            TransportType::Ferry => "ferry",
            TransportType::Unknown => "unknown",
        }
    }
}

impl Config {
    pub fn load<P: AsRef<Path>>(path: P) -> Result<Self, ConfigError> {
        let content = std::fs::read_to_string(path.as_ref())
            .map_err(|e| ConfigError::ReadError(e.to_string()))?;

        serde_yaml_neo::from_str(&content)
            .map_err(|e| ConfigError::ParseError(e.to_string()))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("Failed to read config file: {0}")]
    ReadError(String),
    #[error("Failed to parse config: {0}")]
    ParseError(String),
    #[error("Missing environment variable: {0}")]
    MissingEnvVar(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gtfs_sync_config_default_values() {
        let config = GtfsSyncConfig::default();
        assert_eq!(
            config.static_feed_url,
            "https://download.gtfs.de/germany/free/latest.zip"
        );
        assert_eq!(
            config.realtime_feed_url,
            "https://realtime.gtfs.de/realtime-free.pb"
        );
        assert_eq!(config.cache_dir, "./data/gtfs");
        assert_eq!(config.static_refresh_hours, 24);
        assert_eq!(config.realtime_interval_secs, 15);
        assert_eq!(config.time_horizon_minutes, 120);
    }

    #[test]
    fn gtfs_sync_config_deserialize_full() {
        let yaml = r#"
            static_feed_url: "https://example.com/gtfs.zip"
            realtime_feed_url: "https://example.com/rt.pb"
            cache_dir: "/tmp/gtfs"
            static_refresh_hours: 12
            realtime_interval_secs: 30
            time_horizon_minutes: 60
        "#;
        let config: GtfsSyncConfig = serde_yaml_neo::from_str(yaml).unwrap();
        assert_eq!(config.static_feed_url, "https://example.com/gtfs.zip");
        assert_eq!(config.realtime_feed_url, "https://example.com/rt.pb");
        assert_eq!(config.cache_dir, "/tmp/gtfs");
        assert_eq!(config.static_refresh_hours, 12);
        assert_eq!(config.realtime_interval_secs, 30);
        assert_eq!(config.time_horizon_minutes, 60);
    }

    #[test]
    fn gtfs_sync_config_deserialize_partial_uses_defaults() {
        let yaml = r#"
            realtime_interval_secs: 10
        "#;
        let config: GtfsSyncConfig = serde_yaml_neo::from_str(yaml).unwrap();
        assert_eq!(config.realtime_interval_secs, 10);
        assert_eq!(config.static_refresh_hours, 24);
        assert_eq!(config.time_horizon_minutes, 120);
    }

    #[test]
    fn gtfs_sync_config_deserialize_empty_uses_defaults() {
        let yaml = "{}";
        let config: GtfsSyncConfig = serde_yaml_neo::from_str(yaml).unwrap();
        assert_eq!(config.static_refresh_hours, 24);
        assert_eq!(config.realtime_interval_secs, 15);
        assert_eq!(config.time_horizon_minutes, 120);
    }

    #[test]
    fn config_without_gtfs_sync_uses_defaults() {
        let yaml = r#"
            areas:
              - name: Test
                bounding_box:
                  south: 48.0
                  west: 10.0
                  north: 49.0
                  east: 11.0
                transport_types:
                  - tram
        "#;
        let config: Config = serde_yaml_neo::from_str(yaml).unwrap();
        assert_eq!(config.gtfs_sync.realtime_interval_secs, 15);
        assert_eq!(config.gtfs_sync.static_refresh_hours, 24);
        assert_eq!(config.gtfs_sync.time_horizon_minutes, 120);
    }

    #[test]
    fn config_with_gtfs_sync_overrides() {
        let yaml = r#"
            areas:
              - name: Test
                bounding_box:
                  south: 48.0
                  west: 10.0
                  north: 49.0
                  east: 11.0
                transport_types:
                  - tram
            gtfs_sync:
              realtime_interval_secs: 30
              static_refresh_hours: 12
              time_horizon_minutes: 60
        "#;
        let config: Config = serde_yaml_neo::from_str(yaml).unwrap();
        assert_eq!(config.gtfs_sync.realtime_interval_secs, 30);
        assert_eq!(config.gtfs_sync.static_refresh_hours, 12);
        assert_eq!(config.gtfs_sync.time_horizon_minutes, 60);
    }

    #[test]
    fn load_actual_config_yaml() {
        // This test depends on config.yaml existing at the working directory.
        // Skip gracefully in CI or environments where it's missing.
        let path = std::path::Path::new("config.yaml");
        if !path.exists() {
            eprintln!("Skipping load_actual_config_yaml: config.yaml not found");
            return;
        }
        let config = Config::load("config.yaml").unwrap();
        assert!(!config.areas.is_empty());
        assert!(config.gtfs_sync.realtime_interval_secs > 0);
        assert!(config.gtfs_sync.static_refresh_hours > 0);
    }

    #[test]
    fn gtfs_sync_config_timezone_default() {
        let config = GtfsSyncConfig::default();
        assert_eq!(config.timezone, "Europe/Berlin");
        assert_eq!(config.parsed_timezone(), chrono_tz::Europe::Berlin);
    }

    #[test]
    fn gtfs_sync_config_timezone_valid() {
        let yaml = r#"
            timezone: "America/New_York"
        "#;
        let config: GtfsSyncConfig = serde_yaml_neo::from_str(yaml).unwrap();
        assert_eq!(config.parsed_timezone(), chrono_tz::America::New_York);
    }

    #[test]
    fn gtfs_sync_config_timezone_invalid_falls_back() {
        let yaml = r#"
            timezone: "Invalid/Timezone"
        "#;
        let config: GtfsSyncConfig = serde_yaml_neo::from_str(yaml).unwrap();
        // Should fall back to Europe/Berlin
        assert_eq!(config.parsed_timezone(), chrono_tz::Europe::Berlin);
    }
}
