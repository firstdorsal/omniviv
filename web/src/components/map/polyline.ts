/**
 * Decode an encoded polyline string into an array of [lon, lat] coordinates.
 * Supports variable precision (MOTIS uses precision=7 by default).
 *
 * @param encoded The encoded polyline string
 * @param precision Number of decimal places (default: 7 for MOTIS, 5 for Google)
 * @returns Array of [longitude, latitude] coordinate pairs (GeoJSON order)
 */
export function decodePolyline(encoded: string, precision = 7): [number, number][] {
    const factor = Math.pow(10, precision);
    const coordinates: [number, number][] = [];
    let lat = 0;
    let lon = 0;
    let index = 0;

    while (index < encoded.length) {
        // Decode latitude
        let shift = 0;
        let result = 0;
        let byte: number;
        do {
            byte = encoded.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);
        lat += (result & 1) ? ~(result >> 1) : (result >> 1);

        // Decode longitude
        shift = 0;
        result = 0;
        do {
            byte = encoded.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);
        lon += (result & 1) ? ~(result >> 1) : (result >> 1);

        // GeoJSON uses [lon, lat] order
        coordinates.push([lon / factor, lat / factor]);
    }

    return coordinates;
}
