//! OSM data quality issue detection and management.

use crate::config::TransportType;
use crate::providers::osm::OsmElement;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;
use utoipa::ToSchema;

/// Category of issue for UI organization
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IssueCategory {
    /// OSM data quality issues (missing IFOPT, no platforms, invalid refs)
    OsmDataQuality,
    /// GTFS-OSM mapping issues (no match, ambiguous, low confidence)
    GtfsMapping,
    /// Data processing issues (sync errors, parse failures)
    DataProcessing,
}

/// A candidate GTFS stop match with route-based matching details
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MatchCandidate {
    /// GTFS stop ID
    pub gtfs_stop_id: String,
    /// GTFS stop name
    pub gtfs_stop_name: Option<String>,
    /// Distance in meters from OSM stop
    pub distance_meters: f64,
    /// Human-readable shared route names (e.g. "Tram 1", "Bus 5")
    pub shared_routes: Vec<String>,
    /// Whether this candidate shares at least one route with the OSM stop
    pub is_definitive: bool,
}

/// Types of OSM data quality issues
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum OsmIssueType {
    // OSM data quality issues
    MissingIfopt,
    MissingCoordinates,
    OrphanedElement,
    MissingRouteRef,
    MissingName,
    MissingStopPosition,
    MissingPlatform,
    // GTFS-OSM mapping issues
    /// OSM stop has no matching GTFS stop within max distance
    NoGtfsMatch,
    /// Multiple GTFS stops are within matching distance (ambiguous)
    AmbiguousGtfsMatch,
    /// Match found but with low confidence score
    LowConfidenceMatch,
    /// GTFS stop has no matching OSM stop
    UnmappedGtfsStop,
    // Data processing issues
    /// GTFS CSV record was skipped due to invalid data
    GtfsParseSkipped,
    /// GTFS schedule load failed
    GtfsLoadFailed,
    /// GTFS-RT fetch failed
    GtfsRtFetchFailed,
}

impl OsmIssueType {
    /// Returns the category of this issue type for UI organization
    pub fn category(&self) -> IssueCategory {
        match self {
            OsmIssueType::MissingIfopt
            | OsmIssueType::MissingCoordinates
            | OsmIssueType::OrphanedElement
            | OsmIssueType::MissingRouteRef
            | OsmIssueType::MissingName
            | OsmIssueType::MissingStopPosition
            | OsmIssueType::MissingPlatform => IssueCategory::OsmDataQuality,

            OsmIssueType::NoGtfsMatch
            | OsmIssueType::AmbiguousGtfsMatch
            | OsmIssueType::LowConfidenceMatch
            | OsmIssueType::UnmappedGtfsStop => IssueCategory::GtfsMapping,

            OsmIssueType::GtfsParseSkipped
            | OsmIssueType::GtfsLoadFailed
            | OsmIssueType::GtfsRtFetchFailed => IssueCategory::DataProcessing,
        }
    }
}

/// An OSM data quality issue detected during sync
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct OsmIssue {
    pub osm_id: i64,
    pub osm_type: String,
    pub element_type: String,
    pub issue_type: OsmIssueType,
    /// Category for UI organization (derived from issue_type)
    pub category: IssueCategory,
    pub transport_type: TransportType,
    pub description: String,
    pub osm_url: String,
    pub name: Option<String>,
    /// The ref tag value (e.g., platform letter "a", "b")
    #[serde(rename = "ref")]
    pub ref_tag: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub detected_at: String,
    /// Suggested IFOPT (for missing_ifopt issues)
    pub suggested_ifopt: Option<String>,
    /// Name of the stop that was matched
    pub suggested_ifopt_name: Option<String>,
    /// Distance in meters to the suggested stop
    pub suggested_ifopt_distance: Option<u32>,
    /// GTFS stop ID (for GTFS mapping issues)
    pub gtfs_stop_id: Option<String>,
    /// GTFS stop name (for GTFS mapping issues)
    pub gtfs_stop_name: Option<String>,
    /// Source file (for parse errors)
    pub source_file: Option<String>,
    /// Record count affected (for bulk issues like parse errors)
    pub affected_count: Option<u32>,
    /// Error message from underlying operation
    pub error_message: Option<String>,
    /// Candidate matches with scoring details (for GTFS mapping issues)
    pub match_candidates: Option<Vec<MatchCandidate>>,
}

impl OsmIssue {
    pub fn new(
        osm_id: i64,
        osm_type: &str,
        element_type: &str,
        issue_type: OsmIssueType,
        transport_type: TransportType,
        description: String,
        name: Option<String>,
        ref_tag: Option<String>,
        lat: Option<f64>,
        lon: Option<f64>,
    ) -> Self {
        let osm_url = format!(
            "https://www.openstreetmap.org/edit?{}={}",
            osm_type, osm_id
        );
        let category = issue_type.category();
        Self {
            osm_id,
            osm_type: osm_type.to_string(),
            element_type: element_type.to_string(),
            issue_type,
            category,
            transport_type,
            description,
            osm_url,
            name,
            ref_tag,
            lat,
            lon,
            detected_at: Utc::now().to_rfc3339(),
            suggested_ifopt: None,
            suggested_ifopt_name: None,
            suggested_ifopt_distance: None,
            gtfs_stop_id: None,
            gtfs_stop_name: None,
            source_file: None,
            affected_count: None,
            error_message: None,
            match_candidates: None,
        }
    }

    /// Create a data processing issue (not tied to a specific OSM element)
    pub fn data_processing_issue(
        issue_type: OsmIssueType,
        description: String,
        error_message: Option<String>,
    ) -> Self {
        let category = issue_type.category();
        Self {
            osm_id: 0,
            osm_type: "system".to_string(),
            element_type: "data_processing".to_string(),
            issue_type,
            category,
            transport_type: TransportType::Unknown,
            description,
            osm_url: String::new(),
            name: None,
            ref_tag: None,
            lat: None,
            lon: None,
            detected_at: Utc::now().to_rfc3339(),
            suggested_ifopt: None,
            suggested_ifopt_name: None,
            suggested_ifopt_distance: None,
            gtfs_stop_id: None,
            gtfs_stop_name: None,
            source_file: None,
            affected_count: None,
            error_message,
            match_candidates: None,
        }
    }

    /// Create a GTFS parse skip issue for a file
    pub fn gtfs_parse_skipped(source_file: &str, skipped_count: u32) -> Self {
        Self {
            osm_id: 0,
            osm_type: "system".to_string(),
            element_type: "gtfs_parse".to_string(),
            issue_type: OsmIssueType::GtfsParseSkipped,
            category: IssueCategory::DataProcessing,
            transport_type: TransportType::Unknown,
            description: format!(
                "Skipped {} records from {} due to invalid data",
                skipped_count, source_file
            ),
            osm_url: String::new(),
            name: None,
            ref_tag: None,
            lat: None,
            lon: None,
            detected_at: Utc::now().to_rfc3339(),
            suggested_ifopt: None,
            suggested_ifopt_name: None,
            suggested_ifopt_distance: None,
            gtfs_stop_id: None,
            gtfs_stop_name: None,
            source_file: Some(source_file.to_string()),
            affected_count: Some(skipped_count),
            error_message: None,
            match_candidates: None,
        }
    }

    /// Create a GTFS-OSM mapping issue for an OSM stop without GTFS match
    pub fn no_gtfs_match(
        osm_id: i64,
        osm_type: &str,
        name: Option<String>,
        ifopt: &str,
        lat: f64,
        lon: f64,
        transport_type: TransportType,
    ) -> Self {
        Self {
            osm_id,
            osm_type: osm_type.to_string(),
            element_type: "stop".to_string(),
            issue_type: OsmIssueType::NoGtfsMatch,
            category: IssueCategory::GtfsMapping,
            transport_type,
            description: format!(
                "No GTFS stop found within matching distance for IFOPT {}",
                ifopt
            ),
            osm_url: format!("https://www.openstreetmap.org/edit?{}={}", osm_type, osm_id),
            name,
            ref_tag: Some(ifopt.to_string()),
            lat: Some(lat),
            lon: Some(lon),
            detected_at: Utc::now().to_rfc3339(),
            suggested_ifopt: None,
            suggested_ifopt_name: None,
            suggested_ifopt_distance: None,
            gtfs_stop_id: None,
            gtfs_stop_name: None,
            source_file: None,
            affected_count: None,
            error_message: None,
            match_candidates: None,
        }
    }

    /// Create a GTFS-OSM mapping issue for a GTFS stop without OSM match
    pub fn unmapped_gtfs_stop(
        gtfs_stop_id: &str,
        gtfs_stop_name: Option<&str>,
        lat: f64,
        lon: f64,
    ) -> Self {
        Self {
            osm_id: 0,
            osm_type: "gtfs".to_string(),
            element_type: "gtfs_stop".to_string(),
            issue_type: OsmIssueType::UnmappedGtfsStop,
            category: IssueCategory::GtfsMapping,
            transport_type: TransportType::Unknown,
            description: format!(
                "GTFS stop {} has no matching OSM stop within distance",
                gtfs_stop_name.unwrap_or(gtfs_stop_id)
            ),
            osm_url: String::new(),
            name: gtfs_stop_name.map(String::from),
            ref_tag: None,
            lat: Some(lat),
            lon: Some(lon),
            detected_at: Utc::now().to_rfc3339(),
            suggested_ifopt: None,
            suggested_ifopt_name: None,
            suggested_ifopt_distance: None,
            gtfs_stop_id: Some(gtfs_stop_id.to_string()),
            gtfs_stop_name: gtfs_stop_name.map(String::from),
            source_file: None,
            affected_count: None,
            error_message: None,
            match_candidates: None,
        }
    }

    /// Set the suggested IFOPT from auto-matching
    pub fn with_suggested_ifopt(
        mut self,
        ifopt: String,
        name: Option<String>,
        distance: Option<u32>,
    ) -> Self {
        self.suggested_ifopt = Some(ifopt);
        self.suggested_ifopt_name = name;
        self.suggested_ifopt_distance = distance;
        self
    }

    /// Set GTFS stop info
    pub fn with_gtfs_info(mut self, gtfs_stop_id: String, gtfs_stop_name: Option<String>) -> Self {
        self.gtfs_stop_id = Some(gtfs_stop_id);
        self.gtfs_stop_name = gtfs_stop_name;
        self
    }

    /// Set match candidates for GTFS mapping issues
    pub fn with_match_candidates(mut self, candidates: Vec<MatchCandidate>) -> Self {
        self.match_candidates = Some(candidates);
        self
    }
}

/// In-memory store for OSM data quality issues
pub type OsmIssueStore = Arc<RwLock<Vec<OsmIssue>>>;

/// Determine transport type from OSM element tags
pub fn determine_transport_type(element: &OsmElement) -> TransportType {
    // Check railway tag
    if let Some(railway) = element.tag("railway") {
        match railway.as_str() {
            "tram_stop" | "tram" => return TransportType::Tram,
            "subway" | "subway_entrance" => return TransportType::Subway,
            "station" | "halt" | "stop" => return TransportType::Train,
            _ => {}
        }
    }

    // Check highway tag for bus stops
    if let Some(highway) = element.tag("highway") {
        if highway == "bus_stop" {
            return TransportType::Bus;
        }
    }

    // Check amenity tag for ferry terminals
    if let Some(amenity) = element.tag("amenity") {
        if amenity == "ferry_terminal" {
            return TransportType::Ferry;
        }
    }

    // Check public_transport tag
    if let Some(pt) = element.tag("public_transport") {
        if pt == "stop_position" || pt == "platform" {
            // Try to determine from tram/bus/train/subway/ferry tags
            if element.tag("tram").is_some() || element.tag("light_rail").is_some() {
                return TransportType::Tram;
            }
            if element.tag("bus").is_some() {
                return TransportType::Bus;
            }
            if element.tag("subway").is_some() {
                return TransportType::Subway;
            }
            if element.tag("train").is_some() {
                return TransportType::Train;
            }
            if element.tag("ferry").is_some() {
                return TransportType::Ferry;
            }
        }
    }

    TransportType::Unknown
}

/// Determine transport type from route type string
pub fn transport_type_from_route(route_type: &str) -> TransportType {
    match route_type {
        "tram" | "light_rail" => TransportType::Tram,
        "bus" | "trolleybus" => TransportType::Bus,
        "subway" | "metro" => TransportType::Subway,
        "train" | "railway" | "monorail" => TransportType::Train,
        "ferry" => TransportType::Ferry,
        _ => TransportType::Unknown,
    }
}
