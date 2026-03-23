use std::collections::HashMap;
#[cfg(test)]
use std::collections::HashSet;
#[cfg(test)]
use std::path::Path;

use chrono::NaiveDate;
use tracing::{info, warn};

use super::super::error::GtfsError;
#[cfg(test)]
use super::download::MAX_DECOMPRESSED_SIZE;
use super::types::{
    GtfsCalendar, GtfsCalendarDate, GtfsRoute, GtfsStop, GtfsTrip,
};
#[cfg(test)]
use super::types::{GtfsSchedule, GtfsStopTime};

/// Load the GTFS zip into an in-memory schedule (blocking — call on spawn_blocking).
#[cfg(test)]
pub fn load_schedule(zip_path: &Path) -> Result<GtfsSchedule, GtfsError> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;

    // ZIP bomb protection: check total uncompressed size
    let mut total_uncompressed: u64 = 0;
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            total_uncompressed += entry.size();
        }
    }
    if total_uncompressed > MAX_DECOMPRESSED_SIZE {
        return Err(GtfsError::ParseError(format!(
            "GTFS zip decompressed size {} bytes exceeds limit {} bytes",
            total_uncompressed, MAX_DECOMPRESSED_SIZE
        )));
    }
    info!(
        compressed_mb = std::fs::metadata(zip_path).map(|m| m.len() / (1024 * 1024)).unwrap_or(0),
        decompressed_mb = total_uncompressed / (1024 * 1024),
        "Verified GTFS zip size within limits"
    );

    let stops = parse_stops(&mut archive)?;
    info!(count = stops.len(), "Parsed GTFS stops");

    let routes = parse_routes(&mut archive)?;
    info!(count = routes.len(), "Parsed GTFS routes");

    let trips = parse_trips(&mut archive)?;
    info!(count = trips.len(), "Parsed GTFS trips");

    let stop_times = parse_stop_times(&mut archive)?;
    let total_st: usize = stop_times.values().map(|v| v.len()).sum();
    info!(trips_with_times = stop_times.len(), total_stop_times = total_st, "Parsed GTFS stop_times");

    let calendars = parse_calendar(&mut archive);
    info!(count = calendars.len(), "Parsed GTFS calendar");

    let calendar_dates = parse_calendar_dates(&mut archive);
    let total_cd: usize = calendar_dates.values().map(|v| v.len()).sum();
    info!(services = calendar_dates.len(), total_exceptions = total_cd, "Parsed GTFS calendar_dates");

    // Build reverse index: stop_id -> trip_ids
    let mut trips_by_stop: HashMap<String, HashSet<String>> = HashMap::new();
    for (trip_id, sts) in &stop_times {
        for st in sts {
            trips_by_stop
                .entry(st.stop_id.clone())
                .or_default()
                .insert(trip_id.clone());
        }
    }
    info!(stops_indexed = trips_by_stop.len(), "Built trips-by-stop index");

    Ok(GtfsSchedule {
        stops,
        routes,
        trips,
        stop_times,
        calendars,
        calendar_dates,
        trips_by_stop,
        ifopt_to_gtfs: HashMap::new(),
        gtfs_to_ifopt: HashMap::new(),
        loaded_at: chrono::Utc::now(),
    })
}

pub(crate) fn parse_stops(
    archive: &mut zip::ZipArchive<std::fs::File>,
) -> Result<HashMap<String, GtfsStop>, GtfsError> {
    info!("Parsing stops.txt");
    let file = archive.by_name("stops.txt")?;
    let mut rdr = csv::Reader::from_reader(file);
    let headers = rdr.headers()?.clone();

    let idx_id = headers
        .iter()
        .position(|h| h == "stop_id")
        .ok_or_else(|| GtfsError::ParseError("stops.txt missing stop_id".into()))?;
    let idx_name = headers.iter().position(|h| h == "stop_name");
    let idx_parent = headers.iter().position(|h| h == "parent_station");
    let idx_lat = headers.iter().position(|h| h == "stop_lat");
    let idx_lon = headers.iter().position(|h| h == "stop_lon");

    let mut stops = HashMap::new();
    let mut skipped = 0usize;
    for result in rdr.records() {
        let record = result?;
        let stop_id = record.get(idx_id).unwrap_or("").to_string();
        if stop_id.is_empty() {
            skipped += 1;
            continue;
        }
        stops.insert(
            stop_id.clone(),
            GtfsStop {
                stop_id,
                stop_name: idx_name.and_then(|i| record.get(i)).and_then(non_empty),
                parent_station: idx_parent
                    .and_then(|i| record.get(i))
                    .and_then(non_empty),
                lat: idx_lat
                    .and_then(|i| record.get(i))
                    .and_then(|s| s.parse().ok()),
                lon: idx_lon
                    .and_then(|i| record.get(i))
                    .and_then(|s| s.parse().ok()),
            },
        );
    }
    if skipped > 0 {
        warn!(skipped, "Skipped stops.txt records with empty stop_id");
    }
    Ok(stops)
}

pub(crate) fn parse_routes(
    archive: &mut zip::ZipArchive<std::fs::File>,
) -> Result<HashMap<String, GtfsRoute>, GtfsError> {
    info!("Parsing routes.txt");
    let file = archive.by_name("routes.txt")?;
    let mut rdr = csv::Reader::from_reader(file);
    let headers = rdr.headers()?.clone();

    let idx_id = headers
        .iter()
        .position(|h| h == "route_id")
        .ok_or_else(|| GtfsError::ParseError("routes.txt missing route_id".into()))?;
    let idx_short = headers.iter().position(|h| h == "route_short_name");
    let idx_long = headers.iter().position(|h| h == "route_long_name");
    let idx_type = headers.iter().position(|h| h == "route_type");

    let mut routes = HashMap::new();
    let mut skipped = 0usize;
    for result in rdr.records() {
        let record = result?;
        let route_id = record.get(idx_id).unwrap_or("").to_string();
        if route_id.is_empty() {
            skipped += 1;
            continue;
        }
        routes.insert(
            route_id.clone(),
            GtfsRoute {
                route_id,
                route_short_name: idx_short
                    .and_then(|i| record.get(i))
                    .and_then(non_empty),
                route_long_name: idx_long
                    .and_then(|i| record.get(i))
                    .and_then(non_empty),
                route_type: idx_type
                    .and_then(|i| record.get(i))
                    .and_then(|s| s.parse().ok()),
            },
        );
    }
    if skipped > 0 {
        warn!(skipped, "Skipped routes.txt records with empty route_id");
    }
    Ok(routes)
}

pub(crate) fn parse_trips(
    archive: &mut zip::ZipArchive<std::fs::File>,
) -> Result<HashMap<String, GtfsTrip>, GtfsError> {
    info!("Parsing trips.txt");
    let file = archive.by_name("trips.txt")?;
    let mut rdr = csv::Reader::from_reader(file);
    let headers = rdr.headers()?.clone();

    let idx_trip = headers
        .iter()
        .position(|h| h == "trip_id")
        .ok_or_else(|| GtfsError::ParseError("trips.txt missing trip_id".into()))?;
    let idx_route = headers
        .iter()
        .position(|h| h == "route_id")
        .ok_or_else(|| GtfsError::ParseError("trips.txt missing route_id".into()))?;
    let idx_service = headers
        .iter()
        .position(|h| h == "service_id")
        .ok_or_else(|| GtfsError::ParseError("trips.txt missing service_id".into()))?;
    let idx_headsign = headers.iter().position(|h| h == "trip_headsign");
    let idx_dir = headers.iter().position(|h| h == "direction_id");

    let mut trips = HashMap::new();
    let mut skipped = 0usize;
    for result in rdr.records() {
        let record = result?;
        let trip_id = record.get(idx_trip).unwrap_or("").to_string();
        if trip_id.is_empty() {
            skipped += 1;
            continue;
        }
        trips.insert(
            trip_id.clone(),
            GtfsTrip {
                trip_id,
                route_id: record.get(idx_route).unwrap_or("").to_string(),
                service_id: record.get(idx_service).unwrap_or("").to_string(),
                trip_headsign: idx_headsign
                    .and_then(|i| record.get(i))
                    .and_then(non_empty),
                direction_id: idx_dir
                    .and_then(|i| record.get(i))
                    .and_then(|s| s.parse().ok()),
            },
        );
    }
    if skipped > 0 {
        warn!(skipped, "Skipped trips.txt records with empty trip_id");
    }
    Ok(trips)
}

#[cfg(test)]
pub(crate) fn parse_stop_times(
    archive: &mut zip::ZipArchive<std::fs::File>,
) -> Result<HashMap<String, Vec<GtfsStopTime>>, GtfsError> {
    info!("Parsing stop_times.txt");
    let file = archive.by_name("stop_times.txt")?;
    let mut rdr = csv::Reader::from_reader(file);
    let headers = rdr.headers()?.clone();

    let idx_trip = headers
        .iter()
        .position(|h| h == "trip_id")
        .ok_or_else(|| GtfsError::ParseError("stop_times.txt missing trip_id".into()))?;
    let idx_seq = headers
        .iter()
        .position(|h| h == "stop_sequence")
        .ok_or_else(|| GtfsError::ParseError("stop_times.txt missing stop_sequence".into()))?;
    let idx_stop = headers
        .iter()
        .position(|h| h == "stop_id")
        .ok_or_else(|| GtfsError::ParseError("stop_times.txt missing stop_id".into()))?;
    let idx_arr = headers.iter().position(|h| h == "arrival_time");
    let idx_dep = headers.iter().position(|h| h == "departure_time");

    let mut stop_times: HashMap<String, Vec<GtfsStopTime>> = HashMap::new();
    let mut skipped = 0usize;
    for result in rdr.records() {
        let record = result?;
        let trip_id = record.get(idx_trip).unwrap_or("").to_string();
        if trip_id.is_empty() {
            skipped += 1;
            continue;
        }
        let st = GtfsStopTime {
            stop_sequence: record
                .get(idx_seq)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0),
            stop_id: record.get(idx_stop).unwrap_or("").to_string(),
            arrival_time: idx_arr
                .and_then(|i| record.get(i))
                .and_then(parse_gtfs_time),
            departure_time: idx_dep
                .and_then(|i| record.get(i))
                .and_then(parse_gtfs_time),
        };
        stop_times.entry(trip_id).or_default().push(st);
    }
    if skipped > 0 {
        warn!(skipped, "Skipped stop_times.txt records with empty trip_id");
    }

    // Sort each trip's stop_times by stop_sequence
    for stop_time_list in stop_times.values_mut() {
        stop_time_list.sort_by_key(|stop_time| stop_time.stop_sequence);
    }

    Ok(stop_times)
}

pub(crate) fn parse_calendar(
    archive: &mut zip::ZipArchive<std::fs::File>,
) -> HashMap<String, GtfsCalendar> {
    info!("Parsing calendar.txt");
    let file = match archive.by_name("calendar.txt") {
        Ok(f) => f,
        Err(_) => {
            info!("No calendar.txt in GTFS zip (optional file)");
            return HashMap::new();
        }
    };
    let mut rdr = csv::Reader::from_reader(file);
    let headers = match rdr.headers() {
        Ok(h) => h.clone(),
        Err(_) => return HashMap::new(),
    };

    let idx_service = headers.iter().position(|h| h == "service_id");
    let idx_mon = headers.iter().position(|h| h == "monday");
    let idx_tue = headers.iter().position(|h| h == "tuesday");
    let idx_wed = headers.iter().position(|h| h == "wednesday");
    let idx_thu = headers.iter().position(|h| h == "thursday");
    let idx_fri = headers.iter().position(|h| h == "friday");
    let idx_sat = headers.iter().position(|h| h == "saturday");
    let idx_sun = headers.iter().position(|h| h == "sunday");
    let idx_start = headers.iter().position(|h| h == "start_date");
    let idx_end = headers.iter().position(|h| h == "end_date");

    let Some(idx_service) = idx_service else {
        return HashMap::new();
    };

    let mut calendars = HashMap::new();
    let mut skipped = 0usize;
    for result in rdr.records() {
        let Ok(record) = result else {
            skipped += 1;
            continue;
        };
        let service_id = record.get(idx_service).unwrap_or("").to_string();
        if service_id.is_empty() {
            skipped += 1;
            continue;
        }

        let get_bool = |idx: Option<usize>| -> bool {
            idx.and_then(|i| record.get(i))
                .and_then(|s| s.parse::<i32>().ok())
                .map(|v| v == 1)
                .unwrap_or(false)
        };

        let start_date = idx_start
            .and_then(|i| record.get(i))
            .and_then(parse_gtfs_date);
        let end_date = idx_end
            .and_then(|i| record.get(i))
            .and_then(parse_gtfs_date);

        let (Some(start_date), Some(end_date)) = (start_date, end_date) else {
            skipped += 1;
            continue;
        };

        calendars.insert(
            service_id.clone(),
            GtfsCalendar {
                service_id,
                days: [
                    get_bool(idx_mon),
                    get_bool(idx_tue),
                    get_bool(idx_wed),
                    get_bool(idx_thu),
                    get_bool(idx_fri),
                    get_bool(idx_sat),
                    get_bool(idx_sun),
                ],
                start_date,
                end_date,
            },
        );
    }
    if skipped > 0 {
        warn!(skipped, "Skipped calendar.txt records (empty/unparseable)");
    }
    calendars
}

pub(crate) fn parse_calendar_dates(
    archive: &mut zip::ZipArchive<std::fs::File>,
) -> HashMap<String, Vec<GtfsCalendarDate>> {
    info!("Parsing calendar_dates.txt");
    let file = match archive.by_name("calendar_dates.txt") {
        Ok(f) => f,
        Err(_) => {
            info!("No calendar_dates.txt in GTFS zip (optional file)");
            return HashMap::new();
        }
    };
    let mut rdr = csv::Reader::from_reader(file);
    let headers = match rdr.headers() {
        Ok(h) => h.clone(),
        Err(_) => return HashMap::new(),
    };

    let idx_service = headers.iter().position(|h| h == "service_id");
    let idx_date = headers.iter().position(|h| h == "date");
    let idx_type = headers.iter().position(|h| h == "exception_type");

    let (Some(idx_service), Some(idx_date), Some(idx_type)) = (idx_service, idx_date, idx_type)
    else {
        return HashMap::new();
    };

    let mut dates: HashMap<String, Vec<GtfsCalendarDate>> = HashMap::new();
    let mut skipped = 0usize;
    for result in rdr.records() {
        let Ok(record) = result else {
            skipped += 1;
            continue;
        };
        let service_id = record.get(idx_service).unwrap_or("").to_string();
        if service_id.is_empty() {
            skipped += 1;
            continue;
        }
        let Some(date) = record.get(idx_date).and_then(parse_gtfs_date) else {
            skipped += 1;
            continue;
        };
        let exception_type = record
            .get(idx_type)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);

        dates.entry(service_id).or_default().push(GtfsCalendarDate {
            date,
            exception_type,
        });
    }
    if skipped > 0 {
        warn!(skipped, "Skipped calendar_dates.txt records (empty/unparseable)");
    }
    dates
}

/// Parse GTFS time string "HH:MM:SS" to seconds since midnight.
/// Supports hours >= 24 for trips crossing midnight.
pub fn parse_gtfs_time(time_str: &str) -> Option<i32> {
    let parts: Vec<&str> = time_str.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let hours: i32 = parts[0].parse().ok()?;
    let minutes: i32 = parts[1].parse().ok()?;
    let seconds: i32 = parts[2].parse().ok()?;
    Some(hours * 3600 + minutes * 60 + seconds)
}

/// Parse GTFS date string "YYYYMMDD" to NaiveDate.
pub(crate) fn parse_gtfs_date(s: &str) -> Option<NaiveDate> {
    if s.len() != 8 {
        return None;
    }
    let year: i32 = s[0..4].parse().ok()?;
    let month: u32 = s[4..6].parse().ok()?;
    let day: u32 = s[6..8].parse().ok()?;
    NaiveDate::from_ymd_opt(year, month, day)
}

pub(crate) fn non_empty(s: &str) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// Normalize a stop name for comparison.
/// Handles common German abbreviations and formatting differences.
#[cfg(test)]
pub(crate) fn normalize_stop_name(name: &str) -> String {
    let normalized = name
        .to_lowercase()
        // Common German abbreviations
        .replace("hbf", "hauptbahnhof")
        .replace("bf", "bahnhof")
        .replace("str.", "straße")
        .replace("str ", "straße ")
        .replace("pl.", "platz")
        .replace("pl ", "platz ")
        // Remove common suffixes/prefixes
        .replace(" (u)", "")
        .replace(" (s)", "")
        .replace(" (bus)", "")
        .replace(" (tram)", "")
        // Normalize whitespace
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_gtfs_time() {
        assert_eq!(parse_gtfs_time("08:30:00"), Some(30600));
        assert_eq!(parse_gtfs_time("00:00:00"), Some(0));
        assert_eq!(parse_gtfs_time("24:00:00"), Some(86400));
        assert_eq!(parse_gtfs_time("25:30:00"), Some(91800));
        assert_eq!(parse_gtfs_time("invalid"), None);
        assert_eq!(parse_gtfs_time(""), None);
    }

    #[test]
    fn test_parse_gtfs_date() {
        assert_eq!(
            parse_gtfs_date("20260201"),
            Some(NaiveDate::from_ymd_opt(2026, 2, 1).unwrap())
        );
        assert_eq!(parse_gtfs_date("invalid"), None);
        assert_eq!(parse_gtfs_date(""), None);
    }

    #[test]
    fn test_parse_gtfs_time_edge_cases() {
        assert_eq!(parse_gtfs_time("23:59:59"), Some(86399));
        assert_eq!(parse_gtfs_time("48:00:00"), Some(172800));
        assert_eq!(parse_gtfs_time("00:00:01"), Some(1));
        // Invalid formats
        assert_eq!(parse_gtfs_time("8:30:00"), Some(30600)); // single digit hours still parse
        assert_eq!(parse_gtfs_time("08:30"), None); // missing seconds
        assert_eq!(parse_gtfs_time("08:30:00:00"), None); // too many parts
    }

    #[test]
    fn test_parse_gtfs_date_edge_cases() {
        assert_eq!(parse_gtfs_date("20260229"), None); // 2026 is not leap year
        assert_eq!(parse_gtfs_date("20240229"), Some(NaiveDate::from_ymd_opt(2024, 2, 29).unwrap())); // 2024 is leap year
        assert_eq!(parse_gtfs_date("20260101"), Some(NaiveDate::from_ymd_opt(2026, 1, 1).unwrap()));
        assert_eq!(parse_gtfs_date("20261231"), Some(NaiveDate::from_ymd_opt(2026, 12, 31).unwrap()));
        assert_eq!(parse_gtfs_date("00000101"), Some(NaiveDate::from_ymd_opt(0, 1, 1).unwrap()));
    }

    #[test]
    fn test_non_empty() {
        assert_eq!(non_empty("hello"), Some("hello".to_string()));
        assert_eq!(non_empty(""), None);
        assert_eq!(non_empty(" "), Some(" ".to_string())); // whitespace is not empty
    }

    #[test]
    fn test_normalize_stop_name() {
        assert_eq!(normalize_stop_name("Hbf"), "hauptbahnhof");
        assert_eq!(normalize_stop_name("Str. 5"), "straße 5");
        assert_eq!(normalize_stop_name("Rathaus (U)"), "rathaus");
        assert_eq!(
            normalize_stop_name("  Multiple   Spaces  "),
            "multiple spaces"
        );
    }
}
