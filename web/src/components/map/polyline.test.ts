import { describe, it, expect } from "vitest";
import { decodePolyline } from "./polyline";

describe("decodePolyline", () => {
    it("decodes empty string to empty array", () => {
        expect(decodePolyline("")).toEqual([]);
    });

    it("decodes a single point (precision=5, Google format)", () => {
        // Use the Google example: first point of "_p~iF~ps|U" = (38.5, -120.2)
        const result = decodePolyline("_p~iF~ps|U", 5);
        expect(result).toHaveLength(1);
        expect(result[0][1]).toBeCloseTo(38.5, 1); // lat
        expect(result[0][0]).toBeCloseTo(-120.2, 1); // lon
    });

    it("decodes multiple points (precision=5)", () => {
        // Google's example: "_p~iF~ps|U_ulLnnqC_mqNvxq`@"
        // = [(38.5, -120.2), (40.7, -120.95), (43.252, -126.453)]
        const result = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5);
        expect(result).toHaveLength(3);
        expect(result[0][1]).toBeCloseTo(38.5, 1);
        expect(result[0][0]).toBeCloseTo(-120.2, 1);
        expect(result[1][1]).toBeCloseTo(40.7, 1);
        expect(result[1][0]).toBeCloseTo(-120.95, 1);
        expect(result[2][1]).toBeCloseTo(43.252, 1);
        expect(result[2][0]).toBeCloseTo(-126.453, 1);
    });

    it("returns [lon, lat] order (GeoJSON)", () => {
        const result = decodePolyline("_p~iF~ps|U", 5);
        expect(result).toHaveLength(1);
        // First element is longitude, second is latitude
        const [lon, lat] = result[0];
        expect(lat).toBeCloseTo(38.5, 1);
        expect(lon).toBeCloseTo(-120.2, 1);
    });

    it("handles negative coordinates correctly", () => {
        const result = decodePolyline("_p~iF~ps|U", 5);
        expect(result[0][0]).toBeLessThan(0); // lon is negative
    });

    it("handles precision=7 (MOTIS default)", () => {
        // At precision 7, the same raw int values produce much smaller coordinates
        const result = decodePolyline("_p~iF~ps|U", 7);
        expect(result).toHaveLength(1);
        // Values should be 100x smaller than precision 5
        expect(Math.abs(result[0][1])).toBeLessThan(1);
    });
});
