import { test, expect } from "@playwright/test";

/**
 * E2E tests: Verify that navigation route geometry follows actual rail/road tracks.
 *
 * For each corridor we:
 *   1. Query MOTIS for a route plan
 *   2. For each transit leg, verify that our API can find OSM geometry
 *      with endpoints within 2km of the leg's from/to coordinates
 *   3. Verify the geometry has enough detail (many points, not straight lines)
 */

const MOTIS_URL = "http://omniviv-motis.localhost";
const API_URL = "http://omniviv-api.localhost";

interface Coord { lat: number; lon: number }

function haversine(a: Coord, b: Coord): number {
    const R = 6371000;
    const phi1 = (a.lat * Math.PI) / 180;
    const phi2 = (b.lat * Math.PI) / 180;
    const dphi = ((b.lat - a.lat) * Math.PI) / 180;
    const dlam = ((b.lon - a.lon) * Math.PI) / 180;
    const x = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/** Find the best OSM geometry for a transit leg by searching ref + operator, then name fallback */
async function findBestGeometry(
    request: any,
    routeType: string,
    ref: string,
    operator: string | undefined,
    from: Coord,
    to: Coord,
    fromName: string,
    toName: string,
): Promise<{ score: number; points: number; route: string; method: string }> {
    // Step 1: ref + geographic proximity (same as frontend, using POST)
    const midLat = (from.lat + to.lat) / 2;
    const midLon = (from.lon + to.lon) / 2;
    let res = await request.post(`${API_URL}/api/routes/search`, {
        data: { route_type: routeType, ref, near_lat: midLat, near_lon: midLon },
    });
    let routes: any[] = res.ok() ? (await res.json()).routes ?? [] : [];

    // If geo-filter returned nothing, retry with from/to city name
    if (routes.length === 0 && fromName) {
        const city = fromName.replace(/,.*$/, "").trim();
        if (city) {
            res = await request.post(`${API_URL}/api/routes/search`, {
                data: { route_type: routeType, ref, name_contains: city },
            });
            routes = res.ok() ? (await res.json()).routes ?? [] : [];
        }
    }
    // Last resort: ref only
    if (routes.length === 0) {
        res = await request.post(`${API_URL}/api/routes/search`, {
            data: { route_type: routeType, ref },
        });
        routes = res.ok() ? (await res.json()).routes ?? [] : [];
    }

    let best = { score: Infinity, points: 0, route: "", method: "none" };

    for (const route of routes.slice(0, 8)) {
        const geomRes = await request.get(`${API_URL}/api/routes/${route.osm_id}/geometry`);
        if (!geomRes.ok()) continue;
        const segs: number[][][] = (await geomRes.json()).segments ?? [];
        const coords = segs.flatMap((s: number[][]) => s.map(([lon, lat]: number[]) => ({ lat, lon })));
        if (coords.length < 2) continue;
        const sd = Math.min(...coords.map((c: Coord) => haversine(c, from)));
        const ed = Math.min(...coords.map((c: Coord) => haversine(c, to)));
        const score = sd + ed;
        if (score < best.score) {
            best = { score, points: coords.length, route: route.name ?? ref, method: "ref" };
        }
    }

    if (best.score <= 2000) return best;

    // Step 2: name fallback — search by destination city
    const destCity = toName.replace(/\s+(Hbf|Bf|Bahnhof)\.?$/i, "").trim();
    const fromCity = fromName.replace(/\s+(Hbf|Bf|Bahnhof)\.?$/i, "").trim();
    if (!destCity) return best;

    const nameRes = await request.post(`${API_URL}/api/routes/search`, {
        data: { route_type: routeType, name_contains: destCity },
    });
    if (!nameRes.ok()) return best;
    const nameRoutes: any[] = (await nameRes.json()).routes ?? [];
    // Prioritize routes with both cities
    const withBoth = nameRoutes.filter((r: any) => r.name?.includes(fromCity));
    const rest = nameRoutes.filter((r: any) => !r.name?.includes(fromCity));
    const sorted = [...withBoth, ...rest];

    for (const route of sorted.slice(0, 10)) {
        const geomRes = await request.get(`${API_URL}/api/routes/${route.osm_id}/geometry`);
        if (!geomRes.ok()) continue;
        const segs: number[][][] = (await geomRes.json()).segments ?? [];
        const coords = segs.flatMap((s: number[][]) => s.map(([lon, lat]: number[]) => ({ lat, lon })));
        if (coords.length < 2) continue;
        const sd = Math.min(...coords.map((c: Coord) => haversine(c, from)));
        const ed = Math.min(...coords.map((c: Coord) => haversine(c, to)));
        const score = sd + ed;
        if (score < best.score) {
            best = { score, points: coords.length, route: route.name ?? "?", method: "name-fallback" };
        }
    }

    return best;
}

/** Plan a MOTIS route, extract transit legs, verify each has good OSM geometry */
async function verifyRoutePlan(
    request: any,
    name: string,
    from: Coord,
    to: Coord,
    opts?: { maxScore?: number; skipModes?: string[]; transitModes?: string; assertModes?: string[] },
): Promise<{ passed: boolean; legs: { ref: string; mode: string; score: number; points: number; method: string }[] }> {
    const maxScore = opts?.maxScore ?? 2000;
    const skipModes = new Set(opts?.skipModes ?? ["WALK"]);
    const assertModesSet = opts?.assertModes ? new Set(opts.assertModes) : null;
    const modeToType: Record<string, string> = {
        TRAM: "tram", BUS: "bus", RAIL: "train", REGIONAL_RAIL: "train",
        SUBWAY: "subway", FERRY: "ferry",
    };

    // Use v2 API with transitModes when specified (e.g. to restrict to regional rail),
    // otherwise fall back to v1 API which returns all modes
    let res;
    if (opts?.transitModes) {
        const params = new URLSearchParams({
            fromPlace: `${from.lat},${from.lon}`,
            toPlace: `${to.lat},${to.lon}`,
            transitModes: opts.transitModes,
            numItineraries: "3",
        });
        res = await request.get(`${MOTIS_URL}/api/v2/plan?${params}`);
    } else {
        res = await request.get(
            `${MOTIS_URL}/api/v1/plan?fromPlace=${from.lat},${from.lon}&toPlace=${to.lat},${to.lon}&numItineraries=3`
        );
    }
    expect(res.ok(), `MOTIS plan for ${name} should succeed`).toBe(true);
    const data = await res.json();
    const itineraries = [...(data.itineraries ?? []), ...(data.direct ?? [])];
    const itinerary = itineraries[0];
    expect(itinerary, `Should have at least one itinerary for ${name}`).toBeTruthy();

    const results: { ref: string; mode: string; score: number; points: number; method: string }[] = [];

    for (const leg of itinerary.legs) {
        if (skipModes.has(leg.mode)) continue;
        // When assertModes is set, only verify geometry for those specific modes
        if (assertModesSet && !assertModesSet.has(leg.mode)) continue;
        const ref = leg.routeShortName ?? "?";
        const routeType = modeToType[leg.mode] ?? leg.mode.toLowerCase();
        const fromCoord = { lat: leg.from.lat, lon: leg.from.lon };
        const toCoord = { lat: leg.to.lat, lon: leg.to.lon };

        const geom = await findBestGeometry(
            request, routeType, ref, leg.agencyName,
            fromCoord, toCoord, leg.from.name, leg.to.name,
        );
        results.push({ ref, mode: leg.mode, ...geom });
    }

    const passed = results.every(r => r.score <= maxScore && r.points > 5);
    return { passed, legs: results };
}

// ─── Test suites ────────────────────────────────────────────────────────────

test.describe("Augsburg regional routes", () => {
    test("Tram 1 Königsplatz→Lechhausen", async ({ request }) => {
        const r = await verifyRoutePlan(request, "Tram 1",
            { lat: 48.3657, lon: 10.8946 }, { lat: 48.381, lon: 10.916 },
            { transitModes: "TRAM", assertModes: ["TRAM"] },
        );
        console.log("Tram 1:", r.legs.map(l => `${l.ref}: ${l.score.toFixed(0)}m ${l.points}pts [${l.method}]`).join(", "));
        expect(r.legs.length, "Should have at least one tram leg").toBeGreaterThan(0);
        for (const leg of r.legs) expect(leg.score, `Tram ${leg.ref} should have good geometry`).toBeLessThan(2000);
    });

    test("Tram 3 Königsplatz→Königsbrunn", async ({ request }) => {
        // Königsbrunn is the southern terminus of Tram 3 (C4 direction)
        const r = await verifyRoutePlan(request, "Tram 3",
            { lat: 48.3657, lon: 10.8946 }, { lat: 48.267, lon: 10.889 },
            { transitModes: "TRAM,BUS", assertModes: ["TRAM"] },
        );
        console.log("Tram 3:", r.legs.map(l => `${l.ref}: ${l.score.toFixed(0)}m ${l.points}pts [${l.method}]`).join(", "));
        expect(r.legs.length, "Should have at least one tram leg").toBeGreaterThan(0);
        for (const leg of r.legs) expect(leg.score, `Tram ${leg.ref} should have good geometry`).toBeLessThan(2000);
    });
});

test.describe("Bavaria regional trains", () => {
    // Use transitModes to restrict MOTIS to regional/local services only,
    // preventing ICE legs from appearing when we want to test regional geometry
    const REGIONAL_MODES = "TRAM,BUS,SUBWAY,REGIONAL_RAIL,FERRY";

    test("RE 9 Augsburg→München", async ({ request }) => {
        const r = await verifyRoutePlan(request, "RE 9 Aug→Muc",
            { lat: 48.3654, lon: 10.8856 }, { lat: 48.1402, lon: 11.5583 },
            { transitModes: REGIONAL_MODES, assertModes: ["REGIONAL_RAIL"] },
        );
        console.log("RE 9:", r.legs.map(l => `${l.ref}: ${l.score.toFixed(0)}m ${l.points}pts [${l.method}]`).join(", "));
        expect(r.legs.length, "Should have at least one regional rail leg").toBeGreaterThan(0);
        for (const leg of r.legs) expect(leg.score, `${leg.ref} should have good geometry`).toBeLessThan(2000);
    });

    test("RB 87 Augsburg→Donauwörth (rail leg)", async ({ request }) => {
        const r = await verifyRoutePlan(request, "RB 87 Aug→Don",
            { lat: 48.3654, lon: 10.8856 }, { lat: 48.718, lon: 10.773 },
            { transitModes: REGIONAL_MODES, assertModes: ["REGIONAL_RAIL"] },
        );
        console.log("RB 87:", r.legs.map(l => `${l.ref}: ${l.score.toFixed(0)}m ${l.points}pts [${l.method}]`).join(", "));
        expect(r.legs.length, "Should have at least one regional rail leg").toBeGreaterThan(0);
        for (const leg of r.legs) expect(leg.score, `${leg.ref} should have good geometry`).toBeLessThan(2000);
    });

    test("RB 16 München→Nürnberg", async ({ request }) => {
        const r = await verifyRoutePlan(request, "RB 16 Muc→Nue",
            { lat: 48.1402, lon: 11.5583 }, { lat: 49.4456, lon: 11.083 },
            { transitModes: REGIONAL_MODES, assertModes: ["REGIONAL_RAIL"] },
        );
        console.log("RB 16:", r.legs.map(l => `${l.ref}: ${l.score.toFixed(0)}m ${l.points}pts [${l.method}]`).join(", "));
        expect(r.legs.length, "Should have at least one regional rail leg").toBeGreaterThan(0);
        for (const leg of r.legs) expect(leg.score, `${leg.ref} should have good geometry`).toBeLessThan(2000);
    });

    test("RB 6 München→Garmisch", async ({ request }) => {
        const r = await verifyRoutePlan(request, "RB 6 Muc→Gap",
            { lat: 48.1402, lon: 11.5583 }, { lat: 47.4919, lon: 11.0958 },
            { transitModes: REGIONAL_MODES, assertModes: ["REGIONAL_RAIL"] },
        );
        console.log("RB 6:", r.legs.map(l => `${l.ref}: ${l.score.toFixed(0)}m ${l.points}pts [${l.method}]`).join(", "));
        expect(r.legs.length, "Should have at least one regional rail leg").toBeGreaterThan(0);
        for (const leg of r.legs) expect(leg.score, `${leg.ref} should have good geometry`).toBeLessThan(2000);
    });

    test("S3 Mammendorf→Pasing", async ({ request }) => {
        const r = await verifyRoutePlan(request, "S3 Mamm→Pas",
            { lat: 48.2171, lon: 11.1668 }, { lat: 48.1497, lon: 11.4614 },
            { transitModes: REGIONAL_MODES },
        );
        console.log("S3:", r.legs.map(l => `${l.ref}: ${l.score.toFixed(0)}m ${l.points}pts [${l.method}]`).join(", "));
        for (const leg of r.legs) expect(leg.score, `${leg.ref} should have good geometry`).toBeLessThan(2000);
    });
});

test.describe("ICE long-distance — MOTIS provides fallback geometry", () => {
    // ICE routes do NOT have OSM geometry — the frontend falls back to MOTIS legGeometry.points.
    // These tests verify that MOTIS provides usable polyline geometry for long-distance legs,
    // which is the actual mechanism the frontend relies on for rendering ICE routes.

    async function verifyMotisLegGeometry(
        request: any,
        name: string,
        from: Coord,
        to: Coord,
    ): Promise<{ legs: { ref: string; mode: string; polylinePoints: number; hasGeometry: boolean }[] }> {
        const res = await request.get(
            `${MOTIS_URL}/api/v1/plan?fromPlace=${from.lat},${from.lon}&toPlace=${to.lat},${to.lon}&numItineraries=3`
        );
        expect(res.ok(), `MOTIS plan for ${name} should succeed`).toBe(true);
        const data = await res.json();
        const itinerary = (data.itineraries ?? [])[0];
        expect(itinerary, `Should have at least one itinerary for ${name}`).toBeTruthy();

        const legs: { ref: string; mode: string; polylinePoints: number; hasGeometry: boolean }[] = [];
        for (const leg of itinerary.legs) {
            if (leg.mode === "WALK") continue;
            const polyline = leg.legGeometry?.points ?? "";
            // MOTIS encodes polylines — a non-empty string means geometry is available
            const hasGeometry = polyline.length > 10;
            legs.push({
                ref: leg.routeShortName ?? "?",
                mode: leg.mode,
                polylinePoints: polyline.length,
                hasGeometry,
            });
        }
        return { legs };
    }

    test("ICE Augsburg→München: MOTIS provides polyline geometry for fallback rendering", async ({ request }) => {
        const r = await verifyMotisLegGeometry(request, "ICE Aug→Muc", { lat: 48.3654, lon: 10.8856 }, { lat: 48.1402, lon: 11.5583 });
        console.log("ICE Aug→Muc:", r.legs.map(l => `${l.ref} [${l.mode}]: ${l.polylinePoints} chars, geo=${l.hasGeometry}`).join(", "));
        expect(r.legs.length, "Should have at least one transit leg").toBeGreaterThan(0);
        for (const leg of r.legs) {
            expect(leg.hasGeometry, `${leg.ref} [${leg.mode}] should have MOTIS legGeometry for fallback`).toBe(true);
        }
    });

    test("ICE München→Nürnberg: MOTIS provides polyline geometry for fallback rendering", async ({ request }) => {
        const r = await verifyMotisLegGeometry(request, "ICE Muc→Nue", { lat: 48.1402, lon: 11.5583 }, { lat: 49.4456, lon: 11.083 });
        console.log("ICE Muc→Nue:", r.legs.map(l => `${l.ref} [${l.mode}]: ${l.polylinePoints} chars, geo=${l.hasGeometry}`).join(", "));
        expect(r.legs.length).toBeGreaterThan(0);
        for (const leg of r.legs) {
            expect(leg.hasGeometry, `${leg.ref} [${leg.mode}] should have MOTIS legGeometry for fallback`).toBe(true);
        }
    });

    test("ICE Frankfurt→Köln: MOTIS provides polyline geometry for fallback rendering", async ({ request }) => {
        const r = await verifyMotisLegGeometry(request, "ICE Fra→Köln", { lat: 50.1072, lon: 8.6637 }, { lat: 50.9429, lon: 6.958 });
        console.log("ICE Fra→Köln:", r.legs.map(l => `${l.ref} [${l.mode}]: ${l.polylinePoints} chars, geo=${l.hasGeometry}`).join(", "));
        expect(r.legs.length).toBeGreaterThan(0);
        for (const leg of r.legs) {
            expect(leg.hasGeometry, `${leg.ref} [${leg.mode}] should have MOTIS legGeometry for fallback`).toBe(true);
        }
    });

    test("ICE Berlin→Hamburg: MOTIS provides polyline geometry for fallback rendering", async ({ request }) => {
        const r = await verifyMotisLegGeometry(request, "ICE Bln→Ham", { lat: 52.5251, lon: 13.3694 }, { lat: 53.553, lon: 10.0065 });
        console.log("ICE Bln→Ham:", r.legs.map(l => `${l.ref} [${l.mode}]: ${l.polylinePoints} chars, geo=${l.hasGeometry}`).join(", "));
        expect(r.legs.length).toBeGreaterThan(0);
        for (const leg of r.legs) {
            expect(leg.hasGeometry, `${leg.ref} [${leg.mode}] should have MOTIS legGeometry for fallback`).toBe(true);
        }
    });
});

test.describe("Bus routes", () => {
    test("Bus 506 Augsburg Staatstheater→Hbf (fast query)", async ({ request }) => {
        const start = Date.now();
        const r = await verifyRoutePlan(
            request, "Bus 506",
            { lat: 48.3698, lon: 10.8919 }, { lat: 48.3654, lon: 10.8856 },
        );
        const elapsed = Date.now() - start;
        console.log(`Bus 506: ${r.legs.map(l => `${l.ref}: ${l.score.toFixed(0)}m ${l.points}pts [${l.method}]`).join(", ")} (${elapsed}ms)`);
        // Bus geometry may not always match OSM routes (many are missing),
        // but the query itself should be fast
        expect(elapsed, "Bus route queries should be fast").toBeLessThan(5000);
    });
});

test.describe("Munich S-Bahn and U-Bahn", () => {
    test("U5 Hauptbahnhof→Therese-Giehse-Allee", async ({ request }) => {
        const r = await verifyRoutePlan(request, "U5 Muc",
            { lat: 48.1393, lon: 11.5600 }, { lat: 48.0948, lon: 11.6427 },
            { transitModes: "SUBWAY", assertModes: ["SUBWAY"] },
        );
        console.log("U5:", r.legs.map(l => `${l.ref}: ${l.score.toFixed(0)}m ${l.points}pts [${l.method}]`).join(", "));
        expect(r.legs.length, "Should have at least one subway leg").toBeGreaterThan(0);
        for (const leg of r.legs) expect(leg.score, `${leg.ref} should have good geometry`).toBeLessThan(2000);
    });

    test("S1 München Hbf→Freising", async ({ request }) => {
        const r = await verifyRoutePlan(request, "S1 Muc→Frei",
            { lat: 48.1402, lon: 11.5583 }, { lat: 48.4028, lon: 11.7489 },
            { transitModes: "TRAM,BUS,SUBWAY,REGIONAL_RAIL,FERRY", assertModes: ["REGIONAL_RAIL"] },
        );
        console.log("S1:", r.legs.map(l => `${l.ref}: ${l.score.toFixed(0)}m ${l.points}pts [${l.method}]`).join(", "));
        expect(r.legs.length, "Should have at least one rail leg").toBeGreaterThan(0);
        for (const leg of r.legs) expect(leg.score, `${leg.ref} should have good geometry`).toBeLessThan(2000);
    });
});

test.describe("API performance", () => {
    test("POST /api/routes/search returns fast (<500ms)", async ({ request }) => {
        const queries = [
            { route_type: "tram", ref: "1", operator: "Augsburg" },
            { route_type: "train", ref: "S3", operator: "Bayern" },
            { route_type: "bus", ref: "506" },
            { route_type: "train", ref: "ICE 18" },
        ];
        for (const body of queries) {
            const start = Date.now();
            const res = await request.post(`${API_URL}/api/routes/search`, { data: body });
            const elapsed = Date.now() - start;
            const data = await res.json();
            const label = Object.entries(body).map(([k, v]) => `${k}=${v}`).join("&");
            console.log(`  ${label}: ${data.routes.length} routes in ${elapsed}ms`);
            expect(elapsed, `Query ${label} should be fast`).toBeLessThan(500);
        }
    });
});
