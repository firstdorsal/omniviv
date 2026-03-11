use thiserror::Error;

#[derive(Debug, Error)]
pub enum GtfsError {
    #[error("Network error: {0}")]
    NetworkError(#[from] reqwest::Error),
    #[error("Network error: {0}")]
    NetworkMessage(String),
    #[error("GTFS parse error: {0}")]
    ParseError(String),
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
    #[error("ZIP error: {0}")]
    ZipError(#[from] zip::result::ZipError),
    #[error("CSV error: {0}")]
    CsvError(#[from] csv::Error),
    #[error("Protobuf decode error: {0}")]
    ProtobufError(#[from] prost::DecodeError),
    #[error("JSON error: {0}")]
    JsonError(#[from] serde_json::Error),
    #[error("Database error: {0}")]
    DatabaseError(#[from] sqlx::Error),
    #[error("Task join error: {0}")]
    JoinError(#[from] tokio::task::JoinError),
    #[error("Schedule not loaded")]
    ScheduleNotLoaded,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_display_network_message() {
        let err = GtfsError::NetworkMessage("connection refused".into());
        assert_eq!(err.to_string(), "Network error: connection refused");
    }

    #[test]
    fn error_display_parse_error() {
        let err = GtfsError::ParseError("invalid CSV".into());
        assert_eq!(err.to_string(), "GTFS parse error: invalid CSV");
    }

    #[test]
    fn error_display_schedule_not_loaded() {
        let err = GtfsError::ScheduleNotLoaded;
        assert_eq!(err.to_string(), "Schedule not loaded");
    }

    #[test]
    fn error_from_io_error() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file not found");
        let err: GtfsError = io_err.into();
        assert!(err.to_string().contains("file not found"));
        assert!(matches!(err, GtfsError::IoError(_)));
    }

    #[test]
    fn error_from_csv_error() {
        // Create a CSV error by parsing invalid data
        let mut rdr = csv::ReaderBuilder::new()
            .has_headers(false)
            .from_reader(b"not,enough" as &[u8]);
        #[derive(serde::Deserialize)]
        struct ThreeFields {
            _a: String,
            _b: String,
            _c: String,
        }
        let result = rdr.deserialize::<ThreeFields>().next().unwrap();
        if let Err(csv_err) = result {
            let err: GtfsError = csv_err.into();
            assert!(matches!(err, GtfsError::CsvError(_)));
        }
    }

    #[test]
    fn error_from_prost_decode_error() {
        // Decode invalid protobuf to get a DecodeError
        let bad_bytes: &[u8] = &[0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x7F];
        let result = <gtfs_realtime::FeedMessage as prost::Message>::decode(bad_bytes);
        let decode_err = result.unwrap_err();
        let err: GtfsError = decode_err.into();
        assert!(matches!(err, GtfsError::ProtobufError(_)));
    }

    #[test]
    fn error_from_json_error() {
        let result: Result<serde_json::Value, _> = serde_json::from_str("not valid json!!!");
        if let Err(json_err) = result {
            let err: GtfsError = json_err.into();
            assert!(matches!(err, GtfsError::JsonError(_)));
        }
    }
}
