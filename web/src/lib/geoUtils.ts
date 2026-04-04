/**
 * Haversine distance between two geographic points in meters.
 */
export function haversineDistance(
    lat1: number, lon1: number,
    lat2: number, lon2: number,
): number {
    const R = 6371000;
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
    const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(deltaPhi / 2) ** 2 +
        Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Find the index of the coordinate closest to a given lon/lat.
 * Uses squared Euclidean distance for speed (no trig needed for comparison).
 */
export function findClosestPointIndex(
    coords: [number, number][],
    lon: number,
    lat: number,
): number {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < coords.length; i++) {
        const d = (coords[i][0] - lon) ** 2 + (coords[i][1] - lat) ** 2;
        if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
        }
    }
    return bestIdx;
}

/**
 * Strip station suffixes like "Hbf", "Bf", "Bahnhof" to get the city name.
 * E.g. "Augsburg Hbf" → "Augsburg", "München Hauptbahnhof" → "München"
 */
export function stripStationSuffix(name: string): string {
    return name.replace(/\s+(Hbf|Bf|Bahnhof)\.?$/i, "").trim();
}
