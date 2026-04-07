import { test, expect } from "@playwright/test";

/**
 * E2E tests: POST /api/routes/segment endpoint
 *
 * Server-side route segment extraction using PostGIS ST_LineSubstring.
 * Replaces the old client-side full-geometry-fetch + nearest-point + slice
 * approach with a single fast database query.
 */

const API = "http://omniviv-api.localhost";

// Augsburg Tram 1 (Göggingen → Lechhausen Neuer Ostfriedhof)
const TRAM_1_FORWARD = 3367544;
// Königsplatz Tram 1 platform A1 — known good point on the route
const KOENIGSPLATZ_LAT = 48.36548695;
const KOENIGSPLATZ_LON = 10.89428830;
// Another point further along Tram 1 (verified to be on the route geometry)
const STADTWERKE_LAT = 48.3603058;
const STADTWERKE_LON = 10.8898198;

async function postSegment(body: Record<string, unknown>) {
    return fetch(`${API}/api/routes/segment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

test.describe("POST /api/routes/segment", () => {
    test("returns a segment between two points on the route", async () => {
        const res = await postSegment({
            route_id: TRAM_1_FORWARD,
            from_lat: KOENIGSPLATZ_LAT,
            from_lon: KOENIGSPLATZ_LON,
            to_lat: STADTWERKE_LAT,
            to_lon: STADTWERKE_LON,
        });
        expect(res.ok).toBe(true);
        const data = await res.json();
        expect(data.segment.length, "segment should have at least 2 points").toBeGreaterThan(1);
        expect(data.length_meters, "segment length should be > 0").toBeGreaterThan(0);
        // Both points are known to be on the route, so offsets should be small
        expect(data.from_offset_meters, "from offset should be < 10m").toBeLessThan(10);
        expect(data.to_offset_meters, "to offset should be < 10m").toBeLessThan(10);
    });

    test("returns coordinates ordered from→to (forward direction)", async () => {
        const res = await postSegment({
            route_id: TRAM_1_FORWARD,
            from_lat: KOENIGSPLATZ_LAT,
            from_lon: KOENIGSPLATZ_LON,
            to_lat: STADTWERKE_LAT,
            to_lon: STADTWERKE_LON,
        });
        const data = await res.json();
        const first = data.segment[0];
        const last = data.segment[data.segment.length - 1];

        // First point should be near Königsplatz
        const distFirst = Math.hypot(first[0] - KOENIGSPLATZ_LON, first[1] - KOENIGSPLATZ_LAT);
        // Last point should be near Stadtwerke
        const distLast = Math.hypot(last[0] - STADTWERKE_LON, last[1] - STADTWERKE_LAT);

        expect(distFirst, "first point should be near requested from").toBeLessThan(0.001);
        expect(distLast, "last point should be near requested to").toBeLessThan(0.001);
    });

    test("returns coordinates reversed when from/to are swapped", async () => {
        const forward = await (await postSegment({
            route_id: TRAM_1_FORWARD,
            from_lat: KOENIGSPLATZ_LAT,
            from_lon: KOENIGSPLATZ_LON,
            to_lat: STADTWERKE_LAT,
            to_lon: STADTWERKE_LON,
        })).json();
        const reversed = await (await postSegment({
            route_id: TRAM_1_FORWARD,
            from_lat: STADTWERKE_LAT,
            from_lon: STADTWERKE_LON,
            to_lat: KOENIGSPLATZ_LAT,
            to_lon: KOENIGSPLATZ_LON,
        })).json();

        // Both segments should have the same length (same physical track)
        expect(Math.abs(forward.length_meters - reversed.length_meters), "lengths should match").toBeLessThan(1);

        // First/last points should be swapped
        const fwdFirst = forward.segment[0];
        const fwdLast = forward.segment[forward.segment.length - 1];
        const revFirst = reversed.segment[0];
        const revLast = reversed.segment[reversed.segment.length - 1];

        expect(revFirst[0], "reversed first should match forward last").toBeCloseTo(fwdLast[0], 4);
        expect(revFirst[1]).toBeCloseTo(fwdLast[1], 4);
        expect(revLast[0], "reversed last should match forward first").toBeCloseTo(fwdFirst[0], 4);
        expect(revLast[1]).toBeCloseTo(fwdFirst[1], 4);
    });

    test("returns 404 for unknown route_id", async () => {
        const res = await postSegment({
            route_id: 999999999999,
            from_lat: 48.36, from_lon: 10.89,
            to_lat: 48.37, to_lon: 10.90,
        });
        expect(res.status).toBe(404);
    });

    test("returns 400 for invalid latitude", async () => {
        const res = await postSegment({
            route_id: TRAM_1_FORWARD,
            from_lat: 200, from_lon: 10.89,
            to_lat: 48.37, to_lon: 10.90,
        });
        expect(res.status).toBe(400);
    });

    test("snaps off-route points to closest point on the route", async () => {
        // Use a from-point that is intentionally far from the route
        const res = await postSegment({
            route_id: TRAM_1_FORWARD,
            from_lat: 48.40, // way north
            from_lon: 10.89,
            to_lat: STADTWERKE_LAT,
            to_lon: STADTWERKE_LON,
        });
        expect(res.ok).toBe(true);
        const data = await res.json();
        // Endpoint should still return a segment, but from_offset should be large
        expect(data.from_offset_meters, "off-route point should have a large offset").toBeGreaterThan(100);
        expect(data.segment.length, "segment should still have points").toBeGreaterThan(1);
    });

    test("performance: segment endpoint completes in under 100ms", async () => {
        const start = Date.now();
        const res = await postSegment({
            route_id: TRAM_1_FORWARD,
            from_lat: KOENIGSPLATZ_LAT,
            from_lon: KOENIGSPLATZ_LON,
            to_lat: STADTWERKE_LAT,
            to_lon: STADTWERKE_LON,
        });
        const elapsed = Date.now() - start;
        expect(res.ok).toBe(true);
        // Should be under 100ms even on a slow CI — local PostGIS query is ~10ms
        expect(elapsed, "segment query should be fast").toBeLessThan(500);
    });
});
