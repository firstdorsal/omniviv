/// Extract station-level IFOPT (first 3 colon-separated parts).
/// e.g., "de:09761:691:0:a" -> "de:09761:691"
pub fn station_level_ifopt(ifopt: &str) -> String {
    crate::api::utils::ifopt_station_prefix(ifopt)
        .unwrap_or(ifopt)
        .to_string()
}

/// Extract platform identifier from IFOPT (5th part).
/// e.g., "de:09761:691:0:a" -> Some("a")
pub fn extract_platform_from_ifopt(ifopt: &str) -> Option<String> {
    let parts: Vec<&str> = ifopt.split(':').collect();
    if parts.len() >= 5 {
        Some(parts[4].to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_station_level_ifopt() {
        assert_eq!(station_level_ifopt("de:09761:691:0:a"), "de:09761:691");
        assert_eq!(station_level_ifopt("de:09761:691"), "de:09761:691");
        assert_eq!(station_level_ifopt("de:09761:691:0"), "de:09761:691");
        assert_eq!(station_level_ifopt("short"), "short");
    }

    #[test]
    fn test_extract_platform_from_ifopt() {
        assert_eq!(
            extract_platform_from_ifopt("de:09761:691:0:a"),
            Some("a".to_string())
        );
        assert_eq!(extract_platform_from_ifopt("de:09761:691:0"), None);
        assert_eq!(extract_platform_from_ifopt("de:09761:691"), None);
    }

    #[test]
    fn test_station_level_ifopt_empty() {
        assert_eq!(station_level_ifopt(""), "");
        assert_eq!(station_level_ifopt("a"), "a");
        assert_eq!(station_level_ifopt("a:b"), "a:b");
    }

    #[test]
    fn test_extract_platform_from_ifopt_various() {
        assert_eq!(extract_platform_from_ifopt(""), None);
        assert_eq!(extract_platform_from_ifopt("a:b:c:d:e"), Some("e".to_string()));
        assert_eq!(
            extract_platform_from_ifopt("de:09761:691:0:Gleis 1"),
            Some("Gleis 1".to_string())
        );
        // Exactly 5 parts
        assert_eq!(
            extract_platform_from_ifopt("a:b:c:d:e"),
            Some("e".to_string())
        );
        // More than 5 parts - still returns 5th
        assert_eq!(
            extract_platform_from_ifopt("a:b:c:d:e:f"),
            Some("e".to_string())
        );
    }
}
