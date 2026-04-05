use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum TilegenError {
    #[error("Failed to read config file {path}: {source}")]
    ConfigRead { path: PathBuf, source: std::io::Error },

    #[error("Failed to parse config: {0}")]
    ConfigParse(#[from] serde_yaml_neo::Error),

    #[error("Config validation error: {0}")]
    ConfigValidation(String),

    #[error("Environment variable {0} is required but not set")]
    MissingEnvVar(String),

    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("Failed to generate tiles for layer {layer}: {message}")]
    TileGeneration { layer: String, message: String },

    #[error("Planetiler failed for region {region} (exit code {exit_code:?}): {stderr}")]
    Planetiler {
        region: String,
        exit_code: Option<i32>,
        stderr: String,
    },

    #[error("PBF download failed for {url}: {message}")]
    PbfDownload { url: String, message: String },

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}
