use chrono::{DateTime, Utc};

/// Extract the station-level IFOPT prefix (country:area:stop) from a full IFOPT.
/// E.g. `de:09761:10:1:A1` -> `de:09761:10`.
/// Returns None if the input has fewer than 2 colons.
pub fn ifopt_station_prefix(ifopt: &str) -> Option<&str> {
    let mut colons = 0;
    for (i, c) in ifopt.char_indices() {
        if c == ':' {
            colons += 1;
            if colons == 3 {
                return Some(&ifopt[..i]);
            }
        }
    }
    if colons >= 2 { Some(ifopt) } else { None }
}

/// Parse a reference_time string and determine if it's a simulated (non-current) time.
/// Returns `Some(DateTime)` if it's more than 3 minutes from now (simulated time),
/// `None` if effectively "now" (real-time mode).
///
/// The 3-minute threshold avoids treating small clock skew or UI delays as
/// simulated time while still allowing deliberate time travel.
pub fn parse_reference_time(reference_time: &Option<String>) -> Option<DateTime<Utc>> {
    let rt = reference_time.as_ref()?;
    let parsed = DateTime::parse_from_rfc3339(rt).ok()?;
    let dt = parsed.with_timezone(&Utc);

    const REALTIME_THRESHOLD_SECS: i64 = 180;
    let diff = (dt - Utc::now()).num_seconds().abs();
    if diff < REALTIME_THRESHOLD_SECS {
        return None;
    }
    Some(dt)
}

/// Approximate distance in meters between two WGS84 coordinates using
/// equirectangular projection. Accurate enough for short distances (<100 km).
pub fn distance_meters(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let dlat = (lat1 - lat2) * 111_000.0;
    let dlon = (lon1 - lon2) * 111_000.0 * lat1.to_radians().cos();
    (dlat * dlat + dlon * dlon).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ifopt_full_returns_station_prefix() {
        assert_eq!(ifopt_station_prefix("de:09761:10:1:A1"), Some("de:09761:10"));
    }

    #[test]
    fn ifopt_station_only_returns_itself() {
        assert_eq!(ifopt_station_prefix("de:09761:10"), Some("de:09761:10"));
    }

    #[test]
    fn ifopt_too_short_returns_none() {
        assert_eq!(ifopt_station_prefix("de:09761"), None);
    }

    #[test]
    fn ifopt_four_parts() {
        assert_eq!(ifopt_station_prefix("de:09761:10:1"), Some("de:09761:10"));
    }

    #[test]
    fn parse_reference_time_none() {
        assert!(parse_reference_time(&None).is_none());
    }

    #[test]
    fn parse_reference_time_invalid() {
        assert!(parse_reference_time(&Some("not-a-time".into())).is_none());
    }

    #[test]
    fn parse_reference_time_far_future() {
        let result = parse_reference_time(&Some("2030-06-15T14:00:00Z".into()));
        assert!(result.is_some());
    }

    #[test]
    fn parse_reference_time_far_past() {
        let result = parse_reference_time(&Some("2020-01-01T00:00:00Z".into()));
        assert!(result.is_some());
    }
}
