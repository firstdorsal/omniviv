use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum MappingError {
    #[error("Both ifopt and gtfs_stop_id are required")]
    EmptyFields,

    #[error("GTFS stop not found: {0}")]
    GtfsStopNotFound(String),

    #[error("Database error: {0}")]
    DatabaseError(#[from] sqlx::Error),
}

impl IntoResponse for MappingError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            MappingError::EmptyFields => {
                (StatusCode::BAD_REQUEST, self.to_string())
            }
            MappingError::GtfsStopNotFound(id) => {
                (StatusCode::NOT_FOUND, format!("GTFS stop '{}' not found", id))
            }
            MappingError::DatabaseError(e) => {
                tracing::error!("Database error in mapping: {}", e);
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string())
            }
        };
        (status, message).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_fields_status() {
        let error = MappingError::EmptyFields;
        let response = error.into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn test_gtfs_stop_not_found_status() {
        let error = MappingError::GtfsStopNotFound("stop123".to_string());
        let response = error.into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
