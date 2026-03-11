use crate::config::{Area, BoundingBox};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

// Using Kumi Systems mirror - main overpass-api.de is often overloaded
const OVERPASS_API_URL: &str = "https://overpass.kumi.systems/api/interpreter";

// Retry configuration
const MAX_RETRIES: u32 = 5;
const INITIAL_RETRY_DELAY_SECS: u64 = 10;

// Delay between sequential queries to avoid rate limiting
const INTER_QUERY_DELAY_SECS: u64 = 5;

#[derive(Debug, Clone)]
pub struct OsmClient {
    client: reqwest::Client,
}

impl OsmClient {
    pub fn new() -> Result<Self, OsmError> {
        // Configure client with timeouts
        // Note: Route queries use timeout:180 in Overpass QL, so client timeout must be higher
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(200)) // Overall request timeout (must exceed max query timeout)
            .connect_timeout(Duration::from_secs(30)) // Connection timeout
            .build()
            .map_err(|e| OsmError::NetworkError(format!("Failed to build HTTP client: {}", e)))?;

        Ok(Self { client })
    }

    /// Fetch all public transport features for an area
    pub async fn fetch_area_features(&self, area: &Area) -> Result<AreaFeatures, OsmError> {
        let bounding_box = &area.bounding_box;
        let transport_types: Vec<&str> = area.transport_types.iter().map(|t| t.as_str()).collect();

        // Fetch features sequentially with delays to avoid rate limiting
        tracing::info!(?transport_types, "Fetching stations...");
        let stations = self.fetch_stations(bounding_box, &transport_types).await?;
        tracing::info!(count = stations.len(), "Fetched stations");

        tokio::time::sleep(tokio::time::Duration::from_secs(INTER_QUERY_DELAY_SECS)).await;

        tracing::info!("Fetching platforms...");
        let platforms = self.fetch_platforms(bounding_box, &transport_types).await?;
        tracing::info!(count = platforms.len(), "Fetched platforms");

        tokio::time::sleep(tokio::time::Duration::from_secs(INTER_QUERY_DELAY_SECS)).await;

        tracing::info!("Fetching stop positions...");
        let stop_positions = self.fetch_stop_positions(bounding_box, &transport_types).await?;
        tracing::info!(count = stop_positions.len(), "Fetched stop positions");

        tokio::time::sleep(tokio::time::Duration::from_secs(INTER_QUERY_DELAY_SECS)).await;

        tracing::info!("Fetching routes...");
        let routes = self.fetch_routes(bounding_box, &transport_types).await?;
        tracing::info!(count = routes.len(), "Fetched routes");

        Ok(AreaFeatures {
            stations,
            platforms,
            stop_positions,
            routes,
        })
    }

    /// Fetch stations (stop_areas) for specified transport types
    /// Stop areas are relations that group platforms and stops under one station name
    async fn fetch_stations(&self, bounding_box: &BoundingBox, transport_types: &[&str]) -> Result<Vec<OsmElement>, OsmError> {
        let bounds = bounding_box.to_overpass_string();

        // Build transport-specific station queries
        // We want stop_area relations which group platforms into logical stations
        let mut queries = Vec::new();
        for transport_type in transport_types {
            match *transport_type {
                "tram" => {
                    // Stop areas that contain tram stops
                    queries.push(format!(r#"relation["public_transport"="stop_area"]({bounds});"#));
                    // Also get explicit station nodes/ways
                    queries.push(format!(r#"node["public_transport"="station"]({bounds});"#));
                    queries.push(format!(r#"way["public_transport"="station"]({bounds});"#));
                }
                "bus" => {
                    queries.push(format!(r#"relation["public_transport"="stop_area"]({bounds});"#));
                    queries.push(format!(r#"node["public_transport"="station"]({bounds});"#));
                    queries.push(format!(r#"way["public_transport"="station"]({bounds});"#));
                }
                _ => {}
            }
        }

        if queries.is_empty() {
            return Ok(Vec::new());
        }

        // Use 'out body center' to get relation members and center coordinates
        let query = format!(
            r#"[out:json][timeout:90];
(
{}
);
out body center;"#,
            queries.join("\n")
        );

        self.query_overpass(&query).await
    }

    /// Get platform->station mappings from stop_area relations
    pub fn extract_station_platform_mappings(stations: &[OsmElement]) -> HashMap<i64, i64> {
        let mut mappings = HashMap::new();

        for station in stations {
            if station.element_type != "relation" {
                continue;
            }

            if let Some(members) = &station.members {
                for member in members {
                    // Map only platform/stop members to this station
                    // Fix: removed incorrect || conditions that mapped ALL nodes/ways
                    let role = member.role.as_deref().unwrap_or("");
                    if role == "platform" || role == "stop" {
                        mappings.insert(member.member_ref, station.id);
                    }
                }
            }
        }

        mappings
    }

    /// Fetch platforms for specified transport types
    async fn fetch_platforms(&self, bounding_box: &BoundingBox, transport_types: &[&str]) -> Result<Vec<OsmElement>, OsmError> {
        let bounds = bounding_box.to_overpass_string();

        let mut queries = Vec::new();
        for transport_type in transport_types {
            match *transport_type {
                "tram" => {
                    queries.push(format!(r#"node["public_transport"="platform"]["tram"="yes"]({bounds});"#));
                    queries.push(format!(r#"way["public_transport"="platform"]["tram"="yes"]({bounds});"#));
                    queries.push(format!(r#"node["railway"="platform"]["tram"="yes"]({bounds});"#));
                    queries.push(format!(r#"way["railway"="platform"]["tram"="yes"]({bounds});"#));
                }
                "bus" => {
                    queries.push(format!(r#"node["public_transport"="platform"]["bus"="yes"]({bounds});"#));
                    queries.push(format!(r#"way["public_transport"="platform"]["bus"="yes"]({bounds});"#));
                    queries.push(format!(r#"node["highway"="platform"]({bounds});"#));
                }
                _ => {}
            }
        }

        if queries.is_empty() {
            return Ok(Vec::new());
        }

        let query = format!(
            r#"[out:json][timeout:90];
(
{}
);
out center;"#,
            queries.join("\n")
        );

        self.query_overpass(&query).await
    }

    /// Fetch stop positions for specified transport types
    async fn fetch_stop_positions(&self, bounding_box: &BoundingBox, transport_types: &[&str]) -> Result<Vec<OsmElement>, OsmError> {
        let bounds = bounding_box.to_overpass_string();

        let mut queries = Vec::new();
        for transport_type in transport_types {
            match *transport_type {
                "tram" => {
                    queries.push(format!(r#"node["public_transport"="stop_position"]["tram"="yes"]({bounds});"#));
                }
                "bus" => {
                    queries.push(format!(r#"node["public_transport"="stop_position"]["bus"="yes"]({bounds});"#));
                }
                _ => {}
            }
        }

        if queries.is_empty() {
            return Ok(Vec::new());
        }

        let query = format!(
            r#"[out:json][timeout:90];
(
{}
);
out;"#,
            queries.join("\n")
        );

        self.query_overpass(&query).await
    }

    /// Fetch routes (type=route with specified transport types)
    async fn fetch_routes(
        &self,
        bounding_box: &BoundingBox,
        transport_types: &[&str],
    ) -> Result<Vec<OsmRoute>, OsmError> {
        let bounds = bounding_box.to_overpass_string();
        // Build route type filters
        let route_filters: String = transport_types
            .iter()
            .map(|t| format!(r#"relation["type"="route"]["route"="{}"]({});"#, t, bounds))
            .collect::<Vec<_>>()
            .join("\n");

        let query = format!(
            r#"[out:json][timeout:180];
(
{route_filters}
);
out body;
>;
out skel qt;"#,
            route_filters = route_filters
        );

        tracing::debug!(query = %query, "Executing routes query");
        let response = self.query_overpass_raw(&query).await?;
        self.parse_routes_response(response)
    }

    /// Execute an Overpass query and return elements (with retry logic)
    async fn query_overpass(&self, query: &str) -> Result<Vec<OsmElement>, OsmError> {
        let response = self.execute_with_retry(query).await?;

        let parsed: OverpassResponse = serde_json::from_str(&response).map_err(|e| {
            tracing::error!(
                error = %e,
                body_preview = %response.chars().take(500).collect::<String>(),
                "Failed to parse Overpass response"
            );
            OsmError::ParseError(e.to_string())
        })?;

        Ok(parsed.elements)
    }

    /// Execute HTTP request with retry logic for transient failures
    async fn execute_with_retry(&self, query: &str) -> Result<String, OsmError> {
        let mut last_error = None;

        for attempt in 0..MAX_RETRIES {
            if attempt > 0 {
                let delay = INITIAL_RETRY_DELAY_SECS * 2_u64.pow(attempt - 1);
                tracing::warn!(attempt, delay_secs = delay, "Retrying Overpass request...");
                tokio::time::sleep(Duration::from_secs(delay)).await;
            }

            match self.execute_request(query).await {
                Ok(text) => return Ok(text),
                Err(e) => {
                    // Only retry on transient errors (network, 5xx, 429)
                    if e.is_retryable() {
                        tracing::warn!(attempt, error = %e, "Transient error, will retry");
                        last_error = Some(e);
                    } else {
                        // Non-retryable error, fail immediately
                        return Err(e);
                    }
                }
            }
        }

        Err(last_error.unwrap_or_else(|| OsmError::NetworkError("Max retries exceeded".to_string())))
    }

    /// Execute a single HTTP request
    async fn execute_request(&self, query: &str) -> Result<String, OsmError> {
        tracing::debug!("Executing Overpass query");

        let response = self
            .client
            .post(OVERPASS_API_URL)
            .form(&[("data", query)])
            .send()
            .await
            .map_err(|e| {
                // Network errors are retryable
                OsmError::NetworkError(e.to_string())
            })?;

        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| OsmError::NetworkError(e.to_string()))?;

        if !status.is_success() {
            tracing::error!(status = %status, body_preview = %text.chars().take(200).collect::<String>(), "Overpass API error");

            // 429 (Too Many Requests) and 5xx errors are retryable
            if status.as_u16() == 429 || status.is_server_error() {
                return Err(OsmError::RetryableError(format!("HTTP {}", status)));
            }

            return Err(OsmError::NetworkError(format!(
                "HTTP {}: {}",
                status,
                text.chars().take(200).collect::<String>()
            )));
        }

        // Overpass API sometimes returns HTTP 200 with an XML/HTML error page
        // (e.g. rate limiting, server overload, query timeout).
        // Detect this by checking if the response starts with XML/HTML instead of JSON.
        let trimmed = text.trim_start();
        if trimmed.starts_with("<?xml") || trimmed.starts_with("<!DOCTYPE") || trimmed.starts_with("<html") {
            let preview: String = text.chars().take(1500).collect();
            tracing::warn!(body_preview = %preview, "Overpass API returned HTML/XML error page with HTTP 200");
            return Err(OsmError::RetryableError(
                "Overpass API returned HTML/XML error page (likely rate limited or overloaded)".to_string(),
            ));
        }

        Ok(text)
    }

    /// Execute an Overpass query and return raw response (with retry logic)
    async fn query_overpass_raw(&self, query: &str) -> Result<OverpassResponse, OsmError> {
        let text = self.execute_with_retry(query).await?;

        serde_json::from_str(&text).map_err(|e| {
            tracing::error!(
                error = %e,
                body_preview = %text.chars().take(500).collect::<String>(),
                "Failed to parse Overpass response"
            );
            OsmError::ParseError(e.to_string())
        })
    }

    /// Parse routes response with way geometries
    fn parse_routes_response(&self, response: OverpassResponse) -> Result<Vec<OsmRoute>, OsmError> {
        let mut routes = Vec::new();
        let mut nodes: HashMap<i64, (f64, f64)> = HashMap::new();
        let mut ways: HashMap<i64, Vec<i64>> = HashMap::new();

        // First pass: collect nodes and ways
        for elem in &response.elements {
            match elem.element_type.as_str() {
                "node" => {
                    if let (Some(lat), Some(lon)) = (elem.lat, elem.lon) {
                        nodes.insert(elem.id, (lat, lon));
                    }
                }
                "way" => {
                    if let Some(ref node_ids) = elem.nodes {
                        ways.insert(elem.id, node_ids.clone());
                    }
                }
                _ => {}
            }
        }

        // Second pass: build routes with resolved members
        for elem in &response.elements {
            if elem.element_type != "relation" {
                continue;
            }

            let tags = elem.tags.clone().unwrap_or_default();

            // Skip if not a route relation
            if tags.get("type").map(|s| s.as_str()) != Some("route") {
                continue;
            }

            let mut route_ways = Vec::new();
            let mut route_stops = Vec::new();

            if let Some(ref members) = elem.members {
                for (seq, member) in members.iter().enumerate() {
                    match member.member_type.as_str() {
                        "way" => {
                            // Skip platform ways - only include track/rail ways
                            let role = member.role.as_deref().unwrap_or("");
                            if role == "platform" {
                                continue;
                            }

                            // Resolve way geometry
                            if let Some(node_ids) = ways.get(&member.member_ref) {
                                let coords: Vec<[f64; 2]> = node_ids
                                    .iter()
                                    .filter_map(|node_id| {
                                        nodes.get(node_id).map(|(lat, lon)| [*lon, *lat])
                                    })
                                    .collect();

                                if !coords.is_empty() {
                                    route_ways.push(RouteWay {
                                        way_osm_id: member.member_ref,
                                        sequence: seq as i32,
                                        geometry: coords,
                                    });
                                }
                            }
                        }
                        "node" => {
                            // This could be a stop_position or platform
                            let role = member.role.clone().unwrap_or_default();
                            if role == "stop" || role == "platform" || role.is_empty() {
                                route_stops.push(RouteStop {
                                    osm_id: member.member_ref,
                                    osm_type: "node".to_string(),
                                    sequence: seq as i32,
                                    role,
                                });
                            }
                        }
                        _ => {}
                    }
                }
            }

            routes.push(OsmRoute {
                osm_id: elem.id,
                osm_type: "relation".to_string(),
                name: tags.get("name").cloned(),
                ref_number: tags.get("ref").cloned(),
                route_type: tags.get("route").cloned().unwrap_or_default(),
                operator: tags.get("operator").cloned(),
                network: tags.get("network").cloned(),
                color: tags.get("colour").or(tags.get("color")).cloned(),
                tags,
                ways: route_ways,
                stops: route_stops,
            });
        }

        Ok(routes)
    }
}


#[derive(Debug, Clone)]
pub struct AreaFeatures {
    pub stations: Vec<OsmElement>,
    pub platforms: Vec<OsmElement>,
    pub stop_positions: Vec<OsmElement>,
    pub routes: Vec<OsmRoute>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OverpassResponse {
    pub elements: Vec<OsmElement>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OsmElement {
    #[serde(rename = "type")]
    pub element_type: String,
    pub id: i64,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub center: Option<Center>,
    pub tags: Option<HashMap<String, String>>,
    pub nodes: Option<Vec<i64>>,
    pub members: Option<Vec<RelationMember>>,
}

impl OsmElement {
    /// Get the latitude, preferring center for ways/relations
    pub fn latitude(&self) -> Option<f64> {
        self.lat.or_else(|| self.center.as_ref().map(|c| c.lat))
    }

    /// Get the longitude, preferring center for ways/relations
    pub fn longitude(&self) -> Option<f64> {
        self.lon.or_else(|| self.center.as_ref().map(|c| c.lon))
    }

    /// Get a tag value
    pub fn tag(&self, key: &str) -> Option<&String> {
        self.tags.as_ref().and_then(|t| t.get(key))
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Center {
    pub lat: f64,
    pub lon: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RelationMember {
    #[serde(rename = "type")]
    pub member_type: String,
    #[serde(rename = "ref")]
    pub member_ref: i64,
    pub role: Option<String>,
}

#[derive(Debug, Clone)]
pub struct OsmRoute {
    pub osm_id: i64,
    pub osm_type: String,
    pub name: Option<String>,
    pub ref_number: Option<String>,
    pub route_type: String,
    pub operator: Option<String>,
    pub network: Option<String>,
    pub color: Option<String>,
    pub tags: HashMap<String, String>,
    pub ways: Vec<RouteWay>,
    pub stops: Vec<RouteStop>,
}

#[derive(Debug, Clone)]
pub struct RouteWay {
    pub way_osm_id: i64,
    pub sequence: i32,
    pub geometry: Vec<[f64; 2]>, // [lon, lat] pairs
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct RouteStop {
    pub osm_id: i64,
    pub osm_type: String,
    pub sequence: i32,
    pub role: String,
}

#[derive(Debug, thiserror::Error)]
pub enum OsmError {
    #[error("Network error: {0}")]
    NetworkError(String),
    #[error("Retryable error: {0}")]
    RetryableError(String),
    #[error("Failed to parse response: {0}")]
    ParseError(String),
}

impl OsmError {
    /// Check if this error is transient and should be retried
    pub fn is_retryable(&self) -> bool {
        matches!(self, OsmError::NetworkError(_) | OsmError::RetryableError(_))
    }
}
