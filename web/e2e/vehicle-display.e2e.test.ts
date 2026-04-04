import { test, expect } from "@playwright/test";

/**
 * E2E tests: Verify viewport-aware vehicle display system.
 *
 * Tests cover:
 *   - API-level: /api/routes/visible endpoint behavior, input validation
 *   - API-level: /api/vehicles/by-route returns vehicle data
 *   - Browser: Full pipeline smoke test (viewport → visible routes → WebSocket → map markers)
 *   - Browser: Vehicle toggle, zoom filtering
 *
 * Prerequisites:
 *   - vite dev server at localhost:5174
 *   - API at omniviv-api.localhost
 *   - Martin at omniviv-martin.localhost
 */

const API_URL = "http://omniviv-api.localhost";
const APP_URL = "http://localhost:5174";

// Augsburg Königsplatz area
const AUGSBURG_BBOX: [number, number, number, number] = [10.87, 48.35, 10.92, 48.38];
const AUGSBURG_CENTER = { lat: 48.365, lon: 10.894 };

// Germany-wide bbox
const GERMANY_BBOX: [number, number, number, number] = [5.0, 47.0, 15.0, 55.0];

async function isApiReachable(): Promise<boolean> {
    try {
        const res = await fetch(`${API_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
        return res.ok;
    } catch {
        return false;
    }
}

// ── API-level tests ──────────────────────────────────────────────────────────

test.describe("POST /api/routes/visible", () => {
    test.beforeEach(async () => {
        test.skip(!(await isApiReachable()), "API not reachable");
    });

    test("returns tram routes at zoom 14 over Augsburg", async ({ request }) => {
        const res = await request.post(`${API_URL}/api/routes/visible`, {
            data: { bbox: AUGSBURG_BBOX, zoom: 14 },
        });
        expect(res.ok()).toBe(true);
        const data = await res.json();
        expect(data.routes.length).toBeGreaterThan(0);

        const trams = data.routes.filter((r: { route_type: string }) => r.route_type === "tram");
        expect(trams.length).toBeGreaterThan(0);
    });

    test("returns NO tram/bus routes at zoom 6 over Germany", async ({ request }) => {
        const res = await request.post(`${API_URL}/api/routes/visible`, {
            data: { bbox: GERMANY_BBOX, zoom: 6 },
        });
        expect(res.ok()).toBe(true);
        const data = await res.json();

        const localTransit = data.routes.filter(
            (r: { route_type: string }) => r.route_type === "tram" || r.route_type === "bus"
        );
        expect(localTransit.length).toBe(0);
    });

    test("all returned routes have min_zoom <= requested zoom", async ({ request }) => {
        const res = await request.post(`${API_URL}/api/routes/visible`, {
            data: { bbox: GERMANY_BBOX, zoom: 6 },
        });
        expect(res.ok()).toBe(true);
        const data = await res.json();

        for (const route of data.routes) {
            expect(route.min_zoom).toBeLessThanOrEqual(6);
        }
    });

    test("rejects oversized bbox", async ({ request }) => {
        const res = await request.post(`${API_URL}/api/routes/visible`, {
            data: { bbox: [-180, -90, 180, 90], zoom: 14 },
        });
        expect(res.status()).toBe(400);
    });

    test("clamps extreme zoom values gracefully", async ({ request }) => {
        // Negative zoom should be clamped to 0, returning only the most important routes (or none)
        const res = await request.post(`${API_URL}/api/routes/visible`, {
            data: { bbox: GERMANY_BBOX, zoom: -5 },
        });
        expect(res.ok()).toBe(true);
        const data = await res.json();
        // All returned routes must have min_zoom <= 0 (clamped value)
        for (const route of data.routes) {
            expect(route.min_zoom).toBeLessThanOrEqual(0);
        }
    });

    test("returns at most 200 routes (LIMIT)", async ({ request }) => {
        const res = await request.post(`${API_URL}/api/routes/visible`, {
            data: { bbox: GERMANY_BBOX, zoom: 24 },
        });
        // Might hit the bbox area cap, so accept 400 too
        if (res.ok()) {
            const data = await res.json();
            expect(data.routes.length).toBeLessThanOrEqual(200);
        }
    });
});

test.describe("POST /api/vehicles/by-route", () => {
    test.beforeEach(async () => {
        test.skip(!(await isApiReachable()), "API not reachable");
    });

    test("returns vehicles for an Augsburg tram route", async ({ request }) => {
        // First, find a tram route in Augsburg
        const routesRes = await request.post(`${API_URL}/api/routes/visible`, {
            data: { bbox: AUGSBURG_BBOX, zoom: 14 },
        });
        expect(routesRes.ok()).toBe(true);
        const routesData = await routesRes.json();
        const tramRoutes = routesData.routes.filter((r: { route_type: string }) => r.route_type === "tram");
        test.skip(tramRoutes.length === 0, "No tram routes found in Augsburg");

        const routeId = tramRoutes[0].osm_id;
        const res = await request.post(`${API_URL}/api/vehicles/by-route`, {
            data: { route_id: routeId },
        });
        expect(res.ok()).toBe(true);
        const data = await res.json();

        // Vehicle data should have the expected structure
        expect(data).toHaveProperty("vehicles");
        expect(data).toHaveProperty("route_id", routeId);

        // If vehicles are running, verify structure
        if (data.vehicles.length > 0) {
            const vehicle = data.vehicles[0];
            expect(vehicle).toHaveProperty("trip_id");
            expect(vehicle).toHaveProperty("line_number");
            expect(vehicle).toHaveProperty("stops");
            expect(vehicle.stops.length).toBeGreaterThan(0);

            const stop = vehicle.stops[0];
            expect(stop).toHaveProperty("lat");
            expect(stop).toHaveProperty("lon");
            expect(stop).toHaveProperty("stop_name");
        }
    });
});

// ── Browser integration tests ────────────────────────────────────────────────

test.describe("Vehicle display on map", () => {
    test.beforeEach(async () => {
        test.skip(!(await isApiReachable()), "API not reachable");
    });

    test("full pipeline: vehicles appear at zoom 14 over Augsburg with correct colors", async ({ page }) => {
        await page.goto(`${APP_URL}/#${AUGSBURG_CENTER.lat},${AUGSBURG_CENTER.lon},14.00,0,0`);

        // Wait for map to initialize
        await page.waitForFunction(() => !!(window as any).map, { timeout: 20000 });

        // Wait for vehicle markers to appear (viewport → routes/visible → WS → render)
        const hasVehicles = await page.waitForFunction(
            () => {
                const map = (window as any).map;
                if (!map) return false;
                try {
                    const features = map.queryRenderedFeatures(undefined, {
                        layers: ["vehicles-marker"],
                    });
                    return features && features.length > 0;
                } catch {
                    return false;
                }
            },
            { timeout: 30000 },
        ).catch(() => null);

        if (!hasVehicles) {
            // Pipeline is wired up but no trams running right now — verify source exists
            const sourceExists = await page.evaluate(() => !!((window as any).map?.getSource("vehicles-marker")));
            expect(sourceExists).toBe(true);
            return;
        }

        // Verify vehicles have colors from OSM route data (not default blue)
        const vehicleData = await page.evaluate(() => {
            const map = (window as any).map;
            const features = map.queryRenderedFeatures(undefined, { layers: ["vehicles-marker"] });
            const colorsByLine: Record<string, string[]> = {};
            for (const f of features) {
                const line = f.properties?.lineNumber || "?";
                const color = f.properties?.color || "?";
                if (!colorsByLine[line]) colorsByLine[line] = [];
                if (!colorsByLine[line].includes(color)) colorsByLine[line].push(color);
            }
            return { count: features.length, colorsByLine };
        });

        expect(vehicleData.count).toBeGreaterThan(0);

        // Known Augsburg tram line colors from OSM
        const expectedColors: Record<string, string> = {
            "1": "#e3000f",
            "2": "#0068b3",
            "3": "#ef7c00",
            "4": "#941680",
            "6": "#94c11c",
        };

        for (const [line, colors] of Object.entries(vehicleData.colorsByLine)) {
            // Each line should have exactly one color (no mixed/default)
            expect(colors).toHaveLength(1);
            const color = colors[0].toLowerCase();
            // Must NOT be default blue (#3b82f6)
            expect(color).not.toBe("#3b82f6");
            // If it's a known tram line, verify exact color
            if (expectedColors[line]) {
                expect(color).toBe(expectedColors[line].toLowerCase());
            }
        }
    });

    test("WebSocket connects when vehicles are enabled", async ({ page }) => {
        const wsPromise = page.waitForEvent("websocket", {
            predicate: (ws) => ws.url().includes("/ws/vehicles"),
            timeout: 20000,
        });

        await page.goto(`${APP_URL}/#${AUGSBURG_CENTER.lat},${AUGSBURG_CENTER.lon},14.00,0,0`);
        const ws = await wsPromise;
        expect(ws.url()).toContain("/ws/vehicles");
    });

    test("toggling Fahrzeuge off hides vehicle markers", async ({ page }) => {
        await page.goto(`${APP_URL}/#${AUGSBURG_CENTER.lat},${AUGSBURG_CENTER.lon},14.00,0,0`);
        await page.waitForFunction(() => !!(window as any).map, { timeout: 20000 });
        await page.waitForTimeout(5000); // Let vehicles load

        // Open layers panel
        await page.click('button[aria-label="Ebenen"]');
        await page.waitForTimeout(500);

        // Find and uncheck the Fahrzeuge checkbox
        const vehicleCheckbox = page.locator("text=Fahrzeuge").locator("..").locator('button[role="checkbox"]');
        if (await vehicleCheckbox.isVisible()) {
            await vehicleCheckbox.click();
            await page.waitForTimeout(1000);

            // Verify no vehicle features are rendered
            const vehicleCount = await page.evaluate(() => {
                const map = (window as any).map;
                if (!map) return -1;
                try {
                    const features = map.queryRenderedFeatures(undefined, {
                        layers: ["vehicles-marker"],
                    });
                    return features?.length ?? 0;
                } catch {
                    return 0;
                }
            });
            expect(vehicleCount).toBe(0);
        }
    });
});
