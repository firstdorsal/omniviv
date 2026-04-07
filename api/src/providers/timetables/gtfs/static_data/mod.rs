pub mod csv;
pub mod db;
pub mod download;
pub mod mapping;
pub mod types;
pub mod utils;

// Re-export everything that was publicly accessible from the original flat module.
// Items that were `pub` stay `pub`, items that were `pub(crate)` stay `pub(crate)`,
// and items that were private (fn) are not re-exported.

// csv module: parse_gtfs_time was `pub fn`, the rest were private `fn` (only used internally)
pub use csv::parse_gtfs_time;

// db module: all three were `pub async fn`
pub use db::{build_full_schedule_from_db, build_schedule_from_db, build_schedule_from_db_by_gtfs_stop, load_schedule_to_db};

// download module: download_feed was `pub async fn`, DownloadResult was `pub struct`
pub use download::{download_feed, DownloadResult};

// mapping module: mixed visibility
pub(crate) use mapping::{build_osm_gtfs_mapping_to_db, build_route_mapping_to_db, MappingStats};
pub use mapping::{validate_mappings, OsmStopInfo, UnmatchedReason};

// types module: all structs were `pub`
pub use types::{
    GtfsCalendar, GtfsCalendarDate, GtfsRoute, GtfsSchedule, GtfsStop, GtfsStopTime, GtfsTrip,
};

// utils module: both functions were `pub fn`
pub use utils::{extract_platform_from_ifopt, station_level_ifopt};
