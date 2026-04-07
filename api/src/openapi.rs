//! OpenAPI specification for the Omniviv API.
//!
//! Uses [`utoipauto`] to auto-discover all `#[utoipa::path]` endpoints and
//! `#[derive(ToSchema)]` types from the scanned source directories at compile time.
//! New endpoints and schemas are automatically included without manual registration.

use utoipa::OpenApi;
use utoipauto::utoipauto;

/// Auto-discovers endpoints from `./src/api` and schemas from `./src/api` + `./src/sync`.
#[utoipauto(paths = "./src/api, ./src/sync")]
#[derive(OpenApi)]
#[openapi(
    info(title = "Omniviv API", version = env!("CARGO_PKG_VERSION")),
    tags(
        (name = "routes", description = "Route endpoints"),
        (name = "stations", description = "Station and platform endpoints"),
        (name = "departures", description = "Real-time departure information"),
        (name = "vehicles", description = "Live vehicle tracking"),
        (name = "issues", description = "OSM data quality issues"),
        (name = "health", description = "Service health check"),
        (name = "gtfs-stops", description = "GTFS stop data queries"),
        (name = "mapping", description = "IFOPT-to-GTFS stop mapping management")
    )
)]
pub struct ApiDoc;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_serializes_to_valid_json() {
        let spec = ApiDoc::openapi();
        let json = spec.to_pretty_json().expect("spec must serialize to JSON");
        let parsed: serde_json::Value =
            serde_json::from_str(&json).expect("serialized spec must be valid JSON");
        assert!(parsed.is_object());
    }

    #[test]
    fn spec_contains_expected_paths() {
        let spec = ApiDoc::openapi();
        let json: serde_json::Value =
            serde_json::from_str(&spec.to_pretty_json().unwrap()).unwrap();
        let paths = json["paths"].as_object().expect("spec must have paths");

        let expected_paths = [
            "/api/routes",
            "/api/routes/{route_id}",
            "/api/routes/{route_id}/geometry",
            "/api/routes/colors",
            "/api/routes/visible",
            "/api/stations/{osm_id}",
            "/api/departures/by-stop",
            "/api/departures/by-gtfs-stop",
            "/api/departures/by-coordinates",
            "/api/departures/by-osm-id",
            "/api/vehicles/by-route",
            "/api/issues",
            "/api/health",
            "/api/gtfs-stops",
            "/api/mapping/set",
            "/api/mapping/remove",
            "/api/mapping/status",
        ];

        for path in &expected_paths {
            assert!(
                paths.contains_key(*path),
                "expected path {path} not found in spec. Found: {:?}",
                paths.keys().collect::<Vec<_>>()
            );
        }

        assert!(
            paths.len() >= expected_paths.len(),
            "spec has {} paths, expected at least {}",
            paths.len(),
            expected_paths.len()
        );
    }

    #[test]
    fn spec_contains_expected_schemas() {
        let spec = ApiDoc::openapi();
        let json: serde_json::Value =
            serde_json::from_str(&spec.to_pretty_json().unwrap()).unwrap();
        let schemas = json["components"]["schemas"]
            .as_object()
            .expect("spec must have schemas");

        let expected_schemas = [
            "Route",
            "Station",
            "Departure",
            "Vehicle",
            "HealthResponse",
            "ErrorResponse",
            "TransportType",
            "OsmIssue",
            "MappingEntry",
            "GtfsStopResponse",
        ];

        for schema in &expected_schemas {
            assert!(
                schemas.contains_key(*schema),
                "expected schema {schema} not found in spec. Found: {:?}",
                schemas.keys().collect::<Vec<_>>()
            );
        }

        assert!(
            schemas.len() >= 40,
            "spec has {} schemas, expected at least 40",
            schemas.len()
        );
    }
}
