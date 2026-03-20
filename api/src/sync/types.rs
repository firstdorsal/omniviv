//! Type definitions for the sync module.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use utoipa::ToSchema;

/// Type of stop event
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
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
    pub planned_time: String,
    pub estimated_time: Option<String>,
    pub delay_minutes: Option<i32>,
    pub platform: Option<String>,
    /// Unique trip identifier (GTFS trip_id) - consistent across all stops for a journey
    pub trip_id: Option<String>,
    /// Whether this trip has been cancelled (GTFS-RT schedule_relationship = CANCELED).
    /// Cancelled trips should be shown with strikethrough in departure monitors
    /// but NOT as active vehicles on the map.
    #[serde(default, skip_serializing_if = "is_false")]
    pub cancelled: bool,
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

