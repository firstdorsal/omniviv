//! Predefined geographic areas for tile generation.
//!
//! Supports German Bundesländer by name plus "germany" for the whole country.
//! When multiple areas are combined, the union bounding box is used.
//!
//! Bounding boxes are slightly padded to ensure we don't miss any features
//! at the borders. Source: OpenStreetMap administrative boundaries (level 4).

use crate::error::TilegenError;

/// Bounding box as `[west, south, east, north]` in WGS84 degrees.
pub type BoundingBox = [f64; 4];

/// Look up the bounding box for a single named area (case-insensitive).
///
/// Recognized names:
///   - All 16 German Bundesländer (canonical names + common aliases)
///   - `germany` / `de` for the whole country
pub fn lookup_area(name: &str) -> Option<BoundingBox> {
    match normalize_area_name(name).as_str() {
        // German Bundesländer
        "schleswig-holstein" | "sh" => Some([7.87, 53.36, 11.31, 55.06]),
        "hamburg" | "hh" => Some([8.42, 53.40, 10.33, 53.96]),
        "niedersachsen" | "lower-saxony" | "ni" => Some([6.65, 51.30, 11.60, 53.89]),
        "bremen" | "hb" => Some([8.48, 53.01, 8.99, 53.61]),
        "nordrhein-westfalen" | "north-rhine-westphalia" | "nrw" => Some([5.87, 50.32, 9.46, 52.53]),
        "hessen" | "hesse" | "he" => Some([7.77, 49.39, 10.24, 51.66]),
        "rheinland-pfalz" | "rhineland-palatinate" | "rp" => Some([6.11, 48.97, 8.51, 50.94]),
        "baden-wurttemberg" | "baden-wuerttemberg" | "bw" => Some([7.51, 47.53, 10.49, 49.79]),
        "bayern" | "bavaria" | "by" => Some([8.97, 47.27, 13.84, 50.57]),
        "saarland" | "sl" => Some([6.36, 49.11, 7.40, 49.64]),
        "berlin" | "be" => Some([13.09, 52.34, 13.76, 52.68]),
        "brandenburg" | "bb" => Some([11.27, 51.36, 14.77, 53.56]),
        "mecklenburg-vorpommern" | "mecklenburg-western-pomerania" | "mv" => Some([10.59, 53.11, 14.41, 54.78]),
        "sachsen" | "saxony" | "sn" => Some([11.87, 50.17, 15.04, 51.69]),
        "sachsen-anhalt" | "saxony-anhalt" | "st" => Some([10.56, 50.93, 13.19, 53.04]),
        "thuringen" | "thueringen" | "thuringia" | "th" => Some([9.87, 50.20, 12.65, 51.65]),
        // Whole country
        "germany" | "deutschland" | "de" => Some([5.87, 47.27, 15.04, 55.06]),
        // Cities (handy for fast iteration / perf testing). The Augsburg
        // bbox covers every tram line endpoint (Oberhausen Nord, Königsbrunn,
        // Friedberg West, Stadtbergen, Lechhausen) plus a bit of padding.
        "augsburg" | "augsburg-trams" | "ag" => Some([10.80, 48.25, 11.00, 48.45]),
        _ => None,
    }
}

/// Normalize an area name for lookup: lowercase, replace ä/ö/ü/ß, collapse separators.
fn normalize_area_name(name: &str) -> String {
    name.trim()
        .to_lowercase()
        .replace('ä', "a")
        .replace('ö', "o")
        .replace('ü', "u")
        .replace('ß', "ss")
        .replace([' ', '_'], "-")
}

/// Resolve a list of named areas into a single union bounding box.
///
/// Returns an error if any name is unknown. The result is the smallest bbox
/// that contains all the listed areas.
pub fn resolve_areas(names: &[String]) -> Result<BoundingBox, TilegenError> {
    if names.is_empty() {
        return Err(TilegenError::ConfigValidation(
            "areas list must not be empty".to_string(),
        ));
    }

    let mut bbox: Option<BoundingBox> = None;
    for name in names {
        let area = lookup_area(name).ok_or_else(|| {
            TilegenError::ConfigValidation(format!(
                "Unknown area '{}'. Known areas: 16 German Bundesländer (e.g. bayern, nordrhein-westfalen) + germany",
                name
            ))
        })?;
        bbox = Some(match bbox {
            None => area,
            Some(existing) => union_bbox(existing, area),
        });
    }
    Ok(bbox.expect("loop ran at least once"))
}

/// Compute the smallest bounding box containing both inputs.
fn union_bbox(a: BoundingBox, b: BoundingBox) -> BoundingBox {
    [
        a[0].min(b[0]),
        a[1].min(b[1]),
        a[2].max(b[2]),
        a[3].max(b[3]),
    ]
}

/// Estimate the total number of XYZ tiles required to cover `bbox`
/// across the inclusive zoom range `[min_zoom, max_zoom]`. Used by the
/// progress reporter so the frontend can show a percentage.
pub fn count_tiles_in_bbox(bbox: BoundingBox, min_zoom: u8, max_zoom: u8) -> u64 {
    let [west, south, east, north] = bbox;
    let mut total: u64 = 0;
    for z in min_zoom..=max_zoom {
        let n = 1i64 << z;
        let n_f = n as f64;

        // For each lon L, the tile column containing L is floor((L+180)/360 * n).
        // We clamp to [0, n-1] because lon=180 is on the right edge of tile n-1.
        let lon_to_x = |lon: f64| -> i64 {
            (((lon + 180.0) / 360.0 * n_f).floor() as i64).clamp(0, n - 1)
        };

        // Web Mercator latitude → tile row.
        let lat_to_y = |lat: f64| -> i64 {
            let lat_rad = lat.to_radians();
            let y = (1.0 - (lat_rad.tan() + 1.0 / lat_rad.cos()).ln() / std::f64::consts::PI) / 2.0;
            ((y * n_f).floor() as i64).clamp(0, n - 1)
        };

        let x_first = lon_to_x(west);
        let x_last = lon_to_x(east);
        // y axis is flipped: north is small y, south is large y
        let y_first = lat_to_y(north);
        let y_last = lat_to_y(south);

        let dx = (x_last - x_first + 1).max(1) as u64;
        let dy = (y_last - y_first + 1).max(1) as u64;
        total = total.saturating_add(dx.saturating_mul(dy));
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_bayern() {
        let bbox = lookup_area("bayern").unwrap();
        assert_eq!(bbox, [8.97, 47.27, 13.84, 50.57]);
    }

    #[test]
    fn lookup_case_insensitive() {
        assert_eq!(lookup_area("Bayern"), lookup_area("bayern"));
        assert_eq!(lookup_area("BAYERN"), lookup_area("bayern"));
    }

    #[test]
    fn lookup_aliases() {
        assert_eq!(lookup_area("bayern"), lookup_area("bavaria"));
        assert_eq!(lookup_area("bayern"), lookup_area("by"));
        assert_eq!(lookup_area("nordrhein-westfalen"), lookup_area("nrw"));
        assert_eq!(lookup_area("baden-wurttemberg"), lookup_area("bw"));
    }

    #[test]
    fn lookup_umlauts() {
        // ü → u, ß → ss
        assert_eq!(
            lookup_area("baden-württemberg"),
            lookup_area("baden-wurttemberg"),
        );
        assert_eq!(lookup_area("thüringen"), lookup_area("thuringen"));
    }

    #[test]
    fn lookup_unknown() {
        assert_eq!(lookup_area("atlantis"), None);
    }

    #[test]
    fn resolve_single_area() {
        let bbox = resolve_areas(&["bayern".to_string()]).unwrap();
        assert_eq!(bbox, [8.97, 47.27, 13.84, 50.57]);
    }

    #[test]
    fn resolve_germany() {
        let bbox = resolve_areas(&["germany".to_string()]).unwrap();
        assert_eq!(bbox, [5.87, 47.27, 15.04, 55.06]);
    }

    #[test]
    fn resolve_multiple_areas_takes_union() {
        // Bayern + Berlin → bbox covers both
        let bbox = resolve_areas(&["bayern".to_string(), "berlin".to_string()]).unwrap();
        // West = min(8.97, 13.09) = 8.97
        // South = min(47.27, 52.34) = 47.27
        // East = max(13.84, 13.76) = 13.84
        // North = max(50.57, 52.68) = 52.68
        assert_eq!(bbox, [8.97, 47.27, 13.84, 52.68]);
    }

    #[test]
    fn resolve_unknown_area_fails() {
        let result = resolve_areas(&["narnia".to_string()]);
        assert!(result.is_err());
    }

    #[test]
    fn resolve_empty_list_fails() {
        let result = resolve_areas(&[]);
        assert!(result.is_err());
    }

    #[test]
    fn union_is_commutative() {
        let bayern = lookup_area("bayern").unwrap();
        let berlin = lookup_area("berlin").unwrap();
        assert_eq!(union_bbox(bayern, berlin), union_bbox(berlin, bayern));
    }

    #[test]
    fn count_tiles_z0_is_one() {
        // The whole world at z0 is exactly 1 tile
        assert_eq!(count_tiles_in_bbox([-180.0, -85.0, 180.0, 85.0], 0, 0), 1);
    }

    #[test]
    fn count_tiles_z1_is_four() {
        assert_eq!(count_tiles_in_bbox([-180.0, -85.0, 180.0, 85.0], 1, 1), 4);
    }

    #[test]
    fn lookup_augsburg_covers_all_tram_lines() {
        let bbox = lookup_area("augsburg").unwrap();
        // Königsbrunn (south) ~ 48.27
        assert!(bbox[1] <= 48.27, "south edge must include Königsbrunn");
        // Oberhausen Nord (north) ~ 48.40
        assert!(bbox[3] >= 48.40, "north edge must include Oberhausen Nord");
        // Friedberg (east) ~ 10.97
        assert!(bbox[2] >= 10.97, "east edge must include Friedberg");
        // Stadtbergen (west) ~ 10.82
        assert!(bbox[0] <= 10.83, "west edge must include Stadtbergen");
    }

    #[test]
    fn count_tiles_bayern_z0_to_14_is_in_expected_range() {
        let bayern = lookup_area("bayern").unwrap();
        let total = count_tiles_in_bbox(bayern, 0, 14);
        // Bayern at z14 alone is roughly 30k–35k tiles. Total z0..=14 is somewhat more.
        // Loose sanity bounds — this is an estimate, not an exact count.
        assert!(total > 20_000, "expected > 20k tiles for Bayern z0-14, got {total}");
        assert!(total < 100_000, "expected < 100k tiles for Bayern z0-14, got {total}");
    }
}
