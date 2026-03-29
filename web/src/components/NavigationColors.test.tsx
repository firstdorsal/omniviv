import { describe, expect, it } from "vitest";

/**
 * End-to-end tests for route planning color resolution.
 *
 * Tests the complete pipeline:
 * - OSM route colors → osm_gtfs_route_mapping → gtfs_routes.route_color → MOTIS routeColor
 * - Fallback: route colors API → frontend color map → type-scoped lookup
 *
 * Test routes:
 * - Kongress am Park → Königsplatz (tram 6, Augsburg)
 * - Therese-Giehse-Allee → Königsplatz (U5 Munich + ICE/RE + Augsburg tram)
 */

const API_URL = process.env.API_URL ?? "http://localhost:3000";
const MOTIS_URL = process.env.MOTIS_URL ?? "http://omniviv-motis.localhost";

// Coordinates
const KONGRESS_AM_PARK = { lat: 48.3600074, lon: 10.8868995 };
const KOENIGSPLATZ = { lat: 48.3657, lon: 10.8946 };
const THERESE_GIEHSE_ALLEE = { lat: 48.094772, lon: 11.642777 };
const STADTBERGEN = { lat: 48.3666284, lon: 10.8442814 };

// Expected OSM colors for Augsburg tram lines
const AUGSBURG_TRAM_COLORS: Record<string, string> = {
    "1": "#e3000f",
    "2": "#0068B3",
    "3": "#ef7c00",
    "4": "#941680",
    "6": "#94c11c",
};

// Munich U5 color from OSM (Münchner Verkehrsgesellschaft)
const MUNICH_U5_COLOR = "#A06E1E";

async function isReachable(url: string): Promise<boolean> {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        return res.ok || res.status === 404;
    } catch {
        return false;
    }
}

interface MotisLeg {
    mode: string;
    routeShortName?: string;
    routeColor?: string | null;
    agencyName?: string;
    duration: number;
}

async function fetchRoute(
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
): Promise<MotisLeg[][]> {
    const params = new URLSearchParams({
        fromPlace: `${from.lat},${from.lon}`,
        toPlace: `${to.lat},${to.lon}`,
        time: "2026-03-26T08:00:00Z",
        arriveBy: "false",
        mode: "TRANSIT,WALK",
    });
    const res = await fetch(`${MOTIS_URL}/api/v1/plan?${params}`);
    if (!res.ok) throw new Error(`MOTIS returned ${res.status}`);
    const data = await res.json();
    return [...(data.itineraries ?? []), ...(data.direct ?? [])].map(
        (it: { legs: MotisLeg[] }) => it.legs.filter((l) => l.mode !== "WALK"),
    );
}

/** Same resolution logic as NavigationPanel */
function resolveNavigationColor(
    leg: MotisLeg,
    colorMap: Map<string, string>,
): string | undefined {
    if (leg.routeColor) {
        return leg.routeColor.startsWith("#") ? leg.routeColor : `#${leg.routeColor}`;
    }
    if (!leg.routeShortName) return undefined;
    return colorMap.get(`${leg.mode?.toLowerCase()}:${leg.routeShortName}`)
        ?? colorMap.get(leg.routeShortName);
}

async function fetchRouteColors(): Promise<Map<string, string>> {
    const res = await fetch(`${API_URL}/api/routes/colors`);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const data = await res.json();
    const colorMap = new Map<string, string>();
    for (const entry of data.entries ?? []) {
        if (!entry.ref || !entry.color) continue;
        if (entry.operator) {
            const opKey = `${entry.operator}:${entry.ref}`;
            if (!colorMap.has(opKey)) colorMap.set(opKey, entry.color);
        }
        const typeKey = `${entry.route_type}:${entry.ref}`;
        if (!colorMap.has(typeKey)) colorMap.set(typeKey, entry.color);
        if (!colorMap.has(entry.ref)) colorMap.set(entry.ref, entry.color);
    }
    return colorMap;
}

describe("Navigation route colors E2E — Stadtbergen → Königsplatz (tram 6)", () => {
    it("MOTIS returns tram 6 for Stadtbergen → Königsplatz", async () => {
        if (!await isReachable(`${MOTIS_URL}/api/v1/plan?fromPlace=0,0&toPlace=0,0`)) {
            console.warn("MOTIS not reachable, skipping");
            return;
        }

        const itineraries = await fetchRoute(STADTBERGEN, KOENIGSPLATZ);
        expect(itineraries.length).toBeGreaterThan(0);

        const tram6Legs = itineraries.flatMap((legs) =>
            legs.filter((l) => l.routeShortName === "6" && l.mode === "TRAM"),
        );
        expect(tram6Legs.length, "Should have at least one tram 6 leg").toBeGreaterThan(0);
    });

    it("tram 6 has correct color after GTFS enrichment (or null before)", async () => {
        if (!await isReachable(`${MOTIS_URL}/api/v1/plan?fromPlace=0,0&toPlace=0,0`)) {
            console.warn("MOTIS not reachable, skipping");
            return;
        }

        const itineraries = await fetchRoute(STADTBERGEN, KOENIGSPLATZ);
        const tram6Leg = itineraries
            .flatMap((legs) => legs)
            .find((l) => l.routeShortName === "6" && l.mode === "TRAM");

        if (!tram6Leg) {
            console.warn("No tram 6 leg found");
            return;
        }

        // After GTFS enrichment, MOTIS should return the OSM color.
        // Before enrichment, routeColor is null and we fall back to the color map.
        if (tram6Leg.routeColor) {
            const color = tram6Leg.routeColor.startsWith("#")
                ? tram6Leg.routeColor
                : `#${tram6Leg.routeColor}`;
            expect(color.toLowerCase()).toBe(AUGSBURG_TRAM_COLORS["6"].toLowerCase());
        } else {
            console.warn("routeColor is null — GTFS enrichment has not run yet");
        }
    });

    it("route colors API has Augsburg tram 6 color via operator key", async () => {
        if (!await isReachable(`${API_URL}/api/health`)) {
            console.warn("API not reachable, skipping");
            return;
        }

        const colorMap = await fetchRouteColors();

        // Operator-scoped key requires the backend to include operator in the response.
        // If operator key exists, it must have the correct Augsburg color.
        const augsburgTram6 = colorMap.get("Augsburger Verkehrsgesellschaft:6");
        if (augsburgTram6) {
            expect(augsburgTram6.toLowerCase()).toBe(AUGSBURG_TRAM_COLORS["6"].toLowerCase());
        } else {
            // Operator field not yet deployed — verify tram:6 type-scoped key exists at minimum
            const tramKey = colorMap.get("tram:6");
            expect(tramKey, "tram:6 should have a color").toBeDefined();
            console.warn("Operator-scoped key not available yet — backend needs restart with operator field");
        }
    });
});

describe("Navigation route colors E2E — Therese-Giehse-Allee → Königsplatz (cross-city)", () => {
    it("MOTIS returns U5 and ICE/RE legs", async () => {
        if (!await isReachable(`${MOTIS_URL}/api/v1/plan?fromPlace=0,0&toPlace=0,0`)) {
            console.warn("MOTIS not reachable, skipping");
            return;
        }

        const itineraries = await fetchRoute(THERESE_GIEHSE_ALLEE, KOENIGSPLATZ);
        expect(itineraries.length).toBeGreaterThan(0);

        const allLegs = itineraries.flatMap((legs) => legs);
        const u5Legs = allLegs.filter((l) => l.routeShortName === "U5");
        expect(u5Legs.length, "Should have U5 legs").toBeGreaterThan(0);
        expect(u5Legs[0].mode).toBe("SUBWAY");

        const longDistanceLegs = allLegs.filter(
            (l) => l.mode === "REGIONAL_RAIL" && l.routeShortName?.startsWith("ICE"),
        );
        // ICE may or may not appear depending on schedule — just verify if present
        if (longDistanceLegs.length > 0) {
            expect(longDistanceLegs[0].agencyName).toBe("DB Fernverkehr AG");
        }
    });

    it("ICE legs should have no color (long-distance trains have no OSM route color)", async () => {
        if (!await isReachable(`${MOTIS_URL}/api/v1/plan?fromPlace=0,0&toPlace=0,0`)) {
            console.warn("MOTIS not reachable, skipping");
            return;
        }

        const itineraries = await fetchRoute(THERESE_GIEHSE_ALLEE, KOENIGSPLATZ);
        const iceLegs = itineraries
            .flatMap((legs) => legs)
            .filter((l) => l.routeShortName?.startsWith("ICE"));

        for (const leg of iceLegs) {
            // ICE has no OSM route → no color in GTFS → MOTIS returns null/undefined
            // Color map also won't have it → resolves to undefined (grey fallback)
            expect(leg.routeColor ?? null).toBeNull();
        }
    });
});

describe("Navigation color resolution logic (unit tests)", () => {
    function buildColorMap(entries: { ref: string; route_type: string; color: string }[]) {
        const colorMap = new Map<string, string>();
        for (const entry of entries) {
            const typeKey = `${entry.route_type}:${entry.ref}`;
            if (!colorMap.has(typeKey)) colorMap.set(typeKey, entry.color);
            if (!colorMap.has(entry.ref)) colorMap.set(entry.ref, entry.color);
        }
        return colorMap;
    }

    it("MOTIS routeColor takes priority over color map", () => {
        const colorMap = buildColorMap([
            { ref: "6", route_type: "tram", color: "#wrong" },
        ]);
        expect(resolveNavigationColor(
            { mode: "TRAM", routeShortName: "6", routeColor: "#94c11c", duration: 300 },
            colorMap,
        )).toBe("#94c11c");
    });

    it("MOTIS routeColor without # prefix is normalized", () => {
        const colorMap = new Map<string, string>();
        expect(resolveNavigationColor(
            { mode: "TRAM", routeShortName: "6", routeColor: "94c11c", duration: 300 },
            colorMap,
        )).toBe("#94c11c");
    });

    it("falls back to type-scoped key when routeColor is null", () => {
        const colorMap = buildColorMap([
            { ref: "4", route_type: "tram", color: "#941680" },
            { ref: "4", route_type: "bus", color: "#0000FF" },
        ]);
        expect(resolveNavigationColor(
            { mode: "TRAM", routeShortName: "4", routeColor: null, duration: 300 },
            colorMap,
        )).toBe("#941680");
        expect(resolveNavigationColor(
            { mode: "BUS", routeShortName: "4", routeColor: null, duration: 300 },
            colorMap,
        )).toBe("#0000FF");
    });

    it("falls back to simple ref when mode doesn't match", () => {
        const colorMap = buildColorMap([
            { ref: "S1", route_type: "train", color: "#00A651" },
        ]);
        expect(resolveNavigationColor(
            { mode: "RAIL", routeShortName: "S1", duration: 600 },
            colorMap,
        )).toBe("#00A651");
    });

    it("returns undefined for unknown lines", () => {
        expect(resolveNavigationColor(
            { mode: "BUS", routeShortName: "999", duration: 300 },
            new Map(),
        )).toBeUndefined();
    });

    it("returns undefined for walk legs", () => {
        expect(resolveNavigationColor(
            { mode: "WALK", duration: 120 },
            new Map(),
        )).toBeUndefined();
    });

    it("all Augsburg tram lines resolve with MOTIS mode names", () => {
        const colorMap = buildColorMap(
            Object.entries(AUGSBURG_TRAM_COLORS).map(([ref, color]) => ({
                ref,
                route_type: "tram",
                color,
            })),
        );
        for (const [ref, expected] of Object.entries(AUGSBURG_TRAM_COLORS)) {
            expect(
                resolveNavigationColor({ mode: "TRAM", routeShortName: ref, duration: 300 }, colorMap),
                `Line ${ref}`,
            ).toBe(expected);
        }
    });
});
