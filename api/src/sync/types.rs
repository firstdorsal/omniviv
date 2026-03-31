//! Type definitions for the sync module.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use utoipa::ToSchema;

/// Type of stop event
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum EventType {
    Departure,
    Arrival,
}

/// A stop event (departure or arrival)
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct Departure {
    pub stop_ifopt: String,
    pub event_type: EventType,
    pub line_number: String,
    /// For departures: destination; for arrivals: origin
    pub destination: String,
    /// Destination stop ID (for departures) or origin stop ID (for arrivals)
    pub destination_id: Option<String>,
    #[schema(value_type = String)]
    pub planned_time: DateTime<Utc>,
    #[schema(value_type = Option<String>)]
    pub estimated_time: Option<DateTime<Utc>>,
    pub delay_minutes: Option<i32>,
    pub platform: Option<String>,
    /// Unique trip identifier (GTFS trip_id) - consistent across all stops for a journey
    pub trip_id: Option<String>,
    /// Whether this trip has been cancelled (GTFS-RT schedule_relationship = CANCELED).
    /// Cancelled trips should be shown with strikethrough in departure monitors
    /// but NOT as active vehicles on the map.
    #[serde(default, skip_serializing_if = "is_false")]
    pub cancelled: bool,
    /// GTFS route_type: 0=tram, 1=subway, 2=rail, 3=bus, 4=ferry, etc.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gtfs_route_type: Option<i32>,
    /// Route color from GTFS or OSM (hex, e.g. "#ee1d23")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Operator/agency name (e.g. "DB Regio AG Bayern", "Go-Ahead")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operator: Option<String>,
    /// Whether this is the first stop of the trip
    pub is_first_stop: bool,
    /// Whether this is the last stop of the trip
    pub is_last_stop: bool,
}

fn is_false(v: &bool) -> bool {
    !v
}


/// In-memory store for departure data
pub type DepartureStore = Arc<RwLock<HashMap<String, Vec<Departure>>>>;

/// Update notification for vehicle data changes
#[derive(Debug, Clone, Serialize)]
pub struct VehicleUpdate {
    /// Timestamp when this update was generated
    pub timestamp: String,
    /// Whether this is the initial snapshot or an incremental update
    pub is_initial: bool,
}

/// Sender for vehicle update notifications
pub type VehicleUpdateSender = broadcast::Sender<VehicleUpdate>;

// ---------------------------------------------------------------------------
// Universal stop identifier
// ---------------------------------------------------------------------------

/// Universal stop identifier string.
///
/// Can be either an IFOPT string (e.g. `"de:09761:101:31:A3"`) or an
/// OSM-based identifier (e.g. `"osm:12345678"`). This allows the departure
/// store, schedule cache, and realtime processing to work with both
/// IFOPT-bearing and non-IFOPT stops without structural changes.
pub type StopId = String;

/// Build an OSM-based stop identifier from a numeric OSM node/way ID.
pub fn osm_stop_id(osm_id: i64) -> StopId {
    format!("osm:{osm_id}")
}

/// Returns `true` if `id` uses the `osm:` prefix convention.
pub fn is_osm_stop_id(id: &str) -> bool {
    id.starts_with("osm:")
}

/// Parse the numeric OSM ID out of an `osm:{id}` string.
/// Returns `None` if the prefix is missing or the remainder is not a valid i64.
pub fn parse_osm_stop_id(id: &str) -> Option<i64> {
    id.strip_prefix("osm:").and_then(|s| s.parse().ok())
}

