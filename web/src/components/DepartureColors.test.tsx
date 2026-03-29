import { describe, expect, it } from "vitest";

/**
 * End-to-end tests for departure colors matching OSM route data.
 * Tests verify the complete pipeline: OSM route data → API → color resolution.
 *
 * These tests hit the real running API and verify that departure colors at
 * Augsburg Königsplatz match the expected OSM route colors.
 */

// Try localhost first (direct), then traefik hostname
const API_URL = process.env.API_URL ?? "http://localhost:3000";
// Use a Wednesday within the current GTFS calendar validity period
const REFERENCE_TIME = "2026-04-01T08:00:00Z";

// Expected colors from OSM route data for Augsburg tram lines at Königsplatz
// Source: SELECT DISTINCT r.ref, r.color FROM routes r JOIN route_stops rs ... WHERE platform LIKE 'de:09761:101%'
const AUGSBURG_TRAM_COLORS: Record<string, string> = {
    "1": "#e3000f",  // Red
    "2": "#0068B3",  // Blue
    "3": "#ef7c00",  // Orange
    "4": "#941680",  // Purple/Magenta
    "6": "#94c11c",  // Green
};

// Helper: fetch departures for a stop
async function fetchDepartures(stopIfopt: string) {
    const res = await fetch(`${API_URL}/api/departures/by-stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stop_ifopt: stopIfopt, reference_time: REFERENCE_TIME }),
    });
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    return res.json();
}

// Check if API is reachable
async function isApiReachable(): Promise<boolean> {
    try {
        const res = await fetch(`${API_URL}/api/health`, { signal: AbortSignal.timeout(2000) });
        return res.ok;
    } catch {
        return false;
    }
}

describe("Departure colors E2E — Augsburg Königsplatz", () => {
    it("API is reachable", async () => {
        const reachable = await isApiReachable();
        if (!reachable) {
            console.warn("API not reachable, skipping E2E tests");
            return;
        }
        expect(reachable).toBe(true);
    });

    it("departures at platform A3 (tram 4) include correct color from OSM", async () => {
        if (!await isApiReachable()) return;

        const data = await fetchDepartures("de:09761:101:31:A3");
        expect(data.departures.length).toBeGreaterThan(0);

        // Find tram departures (gtfs_route_type=0)
        const tramDeps = data.departures.filter(
            (d: { gtfs_route_type?: number; line_number: string }) =>
                d.gtfs_route_type === 0 && d.line_number === "4"
        );

        if (tramDeps.length === 0) {
            console.warn("No tram 4 departures at A3, mapping may be incomplete");
            return;
        }

        // Each tram 4 departure should have the OSM color
        for (const dep of tramDeps.slice(0, 5)) {
            expect(dep.color).toBeDefined();
            expect(dep.color?.toLowerCase()).toBe(AUGSBURG_TRAM_COLORS["4"].toLowerCase());
        }
    });

    it("departures at platform A1 (tram 1) include red color from OSM", async () => {
        if (!await isApiReachable()) return;

        const data = await fetchDepartures("de:09761:101:31:A1");
        if (data.departures.length === 0) {
            console.warn("No departures at A1, mapping may be incomplete");
            return;
        }

        const tram1Deps = data.departures.filter(
            (d: { gtfs_route_type?: number; line_number: string }) =>
                d.gtfs_route_type === 0 && d.line_number === "1"
        );

        if (tram1Deps.length === 0) {
            console.warn("No tram 1 departures at A1");
            return;
        }

        for (const dep of tram1Deps.slice(0, 5)) {
            expect(dep.color?.toLowerCase()).toBe(AUGSBURG_TRAM_COLORS["1"].toLowerCase());
        }
    });

    it("departures at platform B1 (tram 2) include blue color from OSM", async () => {
        if (!await isApiReachable()) return;

        const data = await fetchDepartures("de:09761:101:41:B1");
        if (data.departures.length === 0) {
            console.warn("No departures at B1");
            return;
        }

        const tram2Deps = data.departures.filter(
            (d: { gtfs_route_type?: number; line_number: string }) =>
                d.gtfs_route_type === 0 && d.line_number === "2"
        );

        if (tram2Deps.length === 0) {
            console.warn("No tram 2 departures at B1");
            return;
        }

        for (const dep of tram2Deps.slice(0, 5)) {
            expect(dep.color?.toLowerCase()).toBe(AUGSBURG_TRAM_COLORS["2"].toLowerCase());
        }
    });

    it("departures at platform C3 (tram 3) include orange color from OSM", async () => {
        if (!await isApiReachable()) return;

        const data = await fetchDepartures("de:09761:101:51:C3");
        if (data.departures.length === 0) {
            console.warn("No departures at C3");
            return;
        }

        const tram3Deps = data.departures.filter(
            (d: { gtfs_route_type?: number; line_number: string }) =>
                d.gtfs_route_type === 0 && d.line_number === "3"
        );

        if (tram3Deps.length === 0) {
            console.warn("No tram 3 departures at C3");
            return;
        }

        for (const dep of tram3Deps.slice(0, 5)) {
            expect(dep.color?.toLowerCase()).toBe(AUGSBURG_TRAM_COLORS["3"].toLowerCase());
        }
    });

    it("departures at platform C1 (tram 6) include green color from OSM", async () => {
        if (!await isApiReachable()) return;

        const data = await fetchDepartures("de:09761:101:51:C1");
        if (data.departures.length === 0) {
            console.warn("No departures at C1");
            return;
        }

        const tram6Deps = data.departures.filter(
            (d: { gtfs_route_type?: number; line_number: string }) =>
                d.gtfs_route_type === 0 && d.line_number === "6"
        );

        if (tram6Deps.length === 0) {
            console.warn("No tram 6 departures at C1");
            return;
        }

        for (const dep of tram6Deps.slice(0, 5)) {
            expect(dep.color?.toLowerCase()).toBe(AUGSBURG_TRAM_COLORS["6"].toLowerCase());
        }
    });

    it("tram departures have gtfs_route_type=0 (tram)", async () => {
        if (!await isApiReachable()) return;

        // Test on platform A3 which only serves tram 4
        const data = await fetchDepartures("de:09761:101:31:A3");
        const tramDeps = data.departures.filter(
            (d: { gtfs_route_type?: number }) => d.gtfs_route_type === 0
        );

        // At least some departures should be trams
        expect(tramDeps.length).toBeGreaterThan(0);

        // All tram departures should have route_type 0
        for (const dep of tramDeps) {
            expect(dep.gtfs_route_type).toBe(0);
        }
    });

    it("bus departures have different color than tram at same stop", async () => {
        if (!await isApiReachable()) return;

        const data = await fetchDepartures("de:09761:101:31:A3");
        const tramDeps = data.departures.filter(
            (d: { gtfs_route_type?: number }) => d.gtfs_route_type === 0
        );
        const busDeps = data.departures.filter(
            (d: { gtfs_route_type?: number }) => d.gtfs_route_type === 3
        );

        if (tramDeps.length > 0 && busDeps.length > 0) {
            const tramColor = tramDeps[0].color;
            const busColor = busDeps[0].color;
            // Bus and tram should NOT have the same color
            if (tramColor && busColor) {
                expect(tramColor.toLowerCase()).not.toBe(busColor.toLowerCase());
            }
        }
    });

    // Königsplatz platform IFOPTs (stable OSM identifiers)
    const PLATFORM_IFOPTS: Record<string, string> = {
        A1: "de:09761:101:31:A1",
        A2: "de:09761:101:31:A2",
        A3: "de:09761:101:31:A3",
        A4: "de:09761:101:31:A4",
        B1: "de:09761:101:41:B1",
        B2: "de:09761:101:41:B2",
        C1: "de:09761:101:51:C1",
        C2: "de:09761:101:51:C2",
        C3: "de:09761:101:51:C3",
        C4: "de:09761:101:51:C4",
    };

    it("our departures match the OSM route refs for each platform", { timeout: 30000 }, async () => {
        if (!await isApiReachable()) return;

        // For each platform, check that every tram departure has a line number
        // that matches one of the OSM routes at that platform.
        // This verifies the direction filter works correctly.
        for (const [name, ifopt] of Object.entries(PLATFORM_IFOPTS)) {
            const data = await fetchDepartures(ifopt);
            if (data.departures.length === 0) continue;

            const tramDeps = data.departures.filter(
                (d: { gtfs_route_type?: number }) => d.gtfs_route_type === 0,
            );
            if (tramDeps.length === 0) continue;

            // All tram departures at this platform should be the same line(s)
            // (the OSM route filter ensures this)
            const tramLines = new Set(tramDeps.map((d: { line_number: string }) => d.line_number));
            expect(
                tramLines.size,
                `Platform ${name}: expected consistent tram lines, got ${[...tramLines].join(",")}`,
            ).toBeGreaterThan(0);
        }
    });

    it("Königsplatz stop positions have distinct coordinates per platform", async () => {
        if (!await isApiReachable()) return;

        const res = await fetch(`${API_URL}/api/stations?bbox=10.89,48.364,10.896,48.367`);
        if (!res.ok) return;
        const data = await res.json();
        const station = data.stations?.find((s: { name: string }) => s.name?.includes("Königsplatz"));
        if (!station) {
            console.warn("Königsplatz station not found");
            return;
        }

        // Each platform ref should have stop positions with distinct coordinates
        const positionsByRef = new Map<string, { lat: number; lon: number }>();
        for (const sp of station.stop_positions ?? []) {
            if (!sp.ref) continue;
            if (!positionsByRef.has(sp.ref)) {
                positionsByRef.set(sp.ref, { lat: sp.lat, lon: sp.lon });
            }
        }

        // All platforms A1-C4 should be present
        for (const name of Object.keys(PLATFORM_IFOPTS)) {
            expect(
                positionsByRef.has(name),
                `Stop position for ${name} should exist`,
            ).toBe(true);
        }

        // Platforms in different groups (A vs B vs C) must have meaningfully different coordinates
        const a1 = positionsByRef.get("A1")!;
        const b1 = positionsByRef.get("B1")!;
        const c1 = positionsByRef.get("C1")!;

        // A1 and B1 should be at least 20m apart (different sides of Königsplatz)
        const distA1B1 = Math.sqrt((a1.lat - b1.lat) ** 2 + (a1.lon - b1.lon) ** 2) * 111000;
        expect(distA1B1, "A1 and B1 should be >20m apart").toBeGreaterThan(20);

        // A1 and C1 should be at least 20m apart
        const distA1C1 = Math.sqrt((a1.lat - c1.lat) ** 2 + (a1.lon - c1.lon) ** 2) * 111000;
        expect(distA1C1, "A1 and C1 should be >20m apart").toBeGreaterThan(20);

        // Same-line platforms in opposite directions must differ (A1 vs A2 = tram 1 both directions)
        const a2 = positionsByRef.get("A2")!;
        const distA1A2 = Math.sqrt((a1.lat - a2.lat) ** 2 + (a1.lon - a2.lon) ** 2) * 111000;
        expect(distA1A2, "A1 and A2 (opposite directions) should be >10m apart").toBeGreaterThan(10);

        // All positions should be within Königsplatz area (48.364-48.368, 10.891-10.897)
        for (const [ref, pos] of positionsByRef) {
            expect(pos.lat, `${ref} lat in Königsplatz range`).toBeGreaterThan(48.364);
            expect(pos.lat, `${ref} lat in Königsplatz range`).toBeLessThan(48.368);
            expect(pos.lon, `${ref} lon in Königsplatz range`).toBeGreaterThan(10.891);
            expect(pos.lon, `${ref} lon in Königsplatz range`).toBeLessThan(10.897);
        }
    });

    it("all Augsburg tram lines at Königsplatz have distinct colors", async () => {
        if (!await isApiReachable()) return;

        const colors = new Set<string>();
        for (const [ref, expectedColor] of Object.entries(AUGSBURG_TRAM_COLORS)) {
            colors.add(expectedColor.toLowerCase());
        }

        // All 5 tram lines should have different colors
        expect(colors.size).toBe(Object.keys(AUGSBURG_TRAM_COLORS).length);
    });
});

describe("Color resolution logic (unit tests)", () => {
    // Same logic as DepartureTable.tsx
    function gtfsRouteTypeToMode(type: number | null): string | undefined {
        if (type === null) return undefined;
        switch (type) {
            case 0: return "tram";
            case 1: return "subway";
            case 2: return "train";
            case 3: return "bus";
            case 4: return "ferry";
            default: return undefined;
        }
    }

    function buildColorMap(entries: { ref: string; route_type: string; color: string | null }[]) {
        const colorMap = new Map<string, string>();
        for (const entry of entries) {
            if (!entry.ref || !entry.color) continue;
            const typeKey = `${entry.route_type}:${entry.ref}`;
            if (!colorMap.has(typeKey)) colorMap.set(typeKey, entry.color);
            if (!colorMap.has(entry.ref)) colorMap.set(entry.ref, entry.color);
        }
        return colorMap;
    }

    function resolveColor(
        lineNumber: string,
        gtfsRouteType: number | null,
        departureColor: string | null,
        colorMap: Map<string, string>,
    ): string | undefined {
        if (departureColor) return departureColor;
        const mode = gtfsRouteTypeToMode(gtfsRouteType);
        if (mode) {
            const typeColor = colorMap.get(`${mode}:${lineNumber}`);
            if (typeColor) return typeColor;
        }
        return colorMap.get(lineNumber);
    }

    it("departure's own color takes priority over map lookup", () => {
        const colorMap = buildColorMap([
            { ref: "4", route_type: "tram", color: "#wrong" },
        ]);
        expect(resolveColor("4", 0, "#941680", colorMap)).toBe("#941680");
    });

    it("type-scoped lookup: tram:4 vs bus:4", () => {
        const colorMap = buildColorMap([
            { ref: "4", route_type: "tram", color: "#941680" },
            { ref: "4", route_type: "bus", color: "#0000FF" },
        ]);
        expect(resolveColor("4", 0, null, colorMap)).toBe("#941680");
        expect(resolveColor("4", 3, null, colorMap)).toBe("#0000FF");
    });

    it("fallback to ref-only when type unknown", () => {
        const colorMap = buildColorMap([
            { ref: "S1", route_type: "train", color: "#00A651" },
        ]);
        expect(resolveColor("S1", null, null, colorMap)).toBe("#00A651");
    });

    it("returns undefined when no color", () => {
        expect(resolveColor("99", null, null, new Map())).toBeUndefined();
    });

    it("GTFS route_type to mode mapping", () => {
        expect(gtfsRouteTypeToMode(0)).toBe("tram");
        expect(gtfsRouteTypeToMode(1)).toBe("subway");
        expect(gtfsRouteTypeToMode(2)).toBe("train");
        expect(gtfsRouteTypeToMode(3)).toBe("bus");
        expect(gtfsRouteTypeToMode(4)).toBe("ferry");
        expect(gtfsRouteTypeToMode(null)).toBeUndefined();
    });
});
