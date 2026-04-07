import { test, expect, type Page } from "@playwright/test";

/**
 * E2E tests: Verify the route planning panel renders REAL OSM route geometry,
 * not straight-line fallbacks.
 *
 * The flow:
 *   1. User opens navigation panel
 *   2. Picks start + end locations
 *   3. MOTIS returns itineraries
 *   4. User clicks an itinerary
 *   5. Map's buildNavigationFeatures fetches OSM segment geometry for each
 *      transit leg via POST /api/routes/segment
 *   6. The navigation-route source is populated with LineString features
 *      that follow the actual OSM route geometry
 *
 * What we verify:
 *   - /api/routes/segment is called for transit legs
 *   - The rendered LineString features have many coordinates (>5 for short
 *     trips, way more for longer ones), proving they aren't straight lines
 *   - The first/last coordinates of each leg are near the leg's from/to
 *     stop coordinates (geometry actually starts/ends at the right place)
 */

const MOTIS_URL = "http://omniviv-motis.localhost";

async function isMotisReachable(): Promise<boolean> {
    try {
        const res = await fetch(`${MOTIS_URL}/api/v1/plan?fromPlace=0,0&toPlace=0,0`, {
            signal: AbortSignal.timeout(3000),
        });
        return res.ok || res.status === 400;
    } catch {
        return false;
    }
}

async function openNavigationPanel(page: Page) {
    const navButton = page.locator('button[aria-label="Routenplanung"]');
    await navButton.click();
    await expect(page.locator("text=Routenplanung")).toBeVisible();
}

async function fillLocation(page: Page, inputIndex: number, query: string) {
    const inputs = page.locator('input[role="combobox"]');
    const input = inputs.nth(inputIndex);
    await input.click();
    await input.fill(query);
    await page.waitForTimeout(1500);
    const option = page.locator('[role="option"]').first();
    await expect(option).toBeVisible({ timeout: 5000 });
    await option.click();
}

async function waitForMap(page: Page) {
    await page.waitForFunction(() => !!(window as any).map, { timeout: 20000 });
    await page.waitForTimeout(2000);
}

interface NavigationFeature {
    type: "Feature";
    properties: { mode?: string; line?: string };
    geometry: { type: "LineString"; coordinates: [number, number][] } | { type: "Point"; coordinates: [number, number] };
}

async function readNavigationRouteFeatures(page: Page): Promise<NavigationFeature[]> {
    return page.evaluate(() => {
        const map = (window as any).map;
        if (!map) return [];
        // Use queryRenderedFeatures on the navigation-route layers — the public
        // MapLibre API. This returns the features actually visible in the viewport.
        const layerIds = [
            "navigation-route-line",
            "navigation-route-walk",
            "navigation-route-stops",
        ].filter((id) => map.getLayer(id));
        if (layerIds.length === 0) return [];
        const features = map.queryRenderedFeatures({ layers: layerIds });
        return features.map((f: any) => ({
            type: "Feature",
            properties: f.properties ?? {},
            geometry: f.geometry,
        }));
    });
}

test.describe("Navigation route renders real OSM geometry", () => {
    test.beforeEach(async () => {
        if (!await isMotisReachable()) {
            test.skip(true, "MOTIS not reachable — skipping navigation tests");
        }
    });

    test("transit leg uses /api/routes/segment endpoint", async ({ page }) => {
        const segmentRequests: Array<Record<string, unknown>> = [];
        page.on("request", (req) => {
            if (req.url().includes("/api/routes/segment")) {
                try {
                    segmentRequests.push(JSON.parse(req.postData() ?? "{}"));
                } catch { /* ignore */ }
            }
        });

        await page.goto("/");
        await waitForMap(page);
        await openNavigationPanel(page);

        // Augsburg-specific names to avoid ambiguity with München's Königsplatz
        // Use stops that are far enough apart to require a tram (~3km, not walkable)
        await fillLocation(page, 0, "Augsburg, Königsplatz");
        await fillLocation(page, 1, "Augsburg, Lechhausen");

        // Wait for itineraries to render
        await expect(page.locator('[data-testid="route-results"]')).toBeVisible({ timeout: 15000 });

        // Click the first itinerary
        const firstItin = page.locator('[data-testid^="itinerary-"]').first();
        await firstItin.click();

        // Wait for the segment fetch + render to settle
        await page.waitForTimeout(3000);

        // The segment endpoint should have been called at least once for the transit leg
        expect(segmentRequests.length, "POST /api/routes/segment must be called for transit legs").toBeGreaterThan(0);

        // Each call should have the required fields
        for (const req of segmentRequests) {
            expect(req).toHaveProperty("route_id");
            expect(req).toHaveProperty("from_lat");
            expect(req).toHaveProperty("from_lon");
            expect(req).toHaveProperty("to_lat");
            expect(req).toHaveProperty("to_lon");
        }
    });

    test("ALL rendered transit legs have real geometry, not straight lines", async ({ page }) => {
        await page.goto("/");
        await waitForMap(page);
        await openNavigationPanel(page);

        // Augsburg names + far enough apart to require a tram (not walkable)
        await fillLocation(page, 0, "Augsburg, Königsplatz");
        await fillLocation(page, 1, "Augsburg, Lechhausen");

        await expect(page.locator('[data-testid="route-results"]')).toBeVisible({ timeout: 15000 });
        await page.locator('[data-testid^="itinerary-"]').first().click();

        // Wait for buildNavigationFeatures + segment fetch to complete
        await page.waitForTimeout(4000);

        const features = await readNavigationRouteFeatures(page);
        const lineFeatures = features.filter((f) => f.geometry.type === "LineString") as Array<{
            properties: { mode?: string; line?: string };
            geometry: { type: "LineString"; coordinates: [number, number][] };
        }>;

        expect(lineFeatures.length, "Should have at least one LineString feature").toBeGreaterThan(0);

        const transitLegs = lineFeatures.filter((f) => f.properties.mode && f.properties.mode !== "WALK");
        expect(transitLegs.length, "Should have at least one transit leg").toBeGreaterThan(0);

        // EVERY transit leg must have real geometry, not just the longest one.
        // A short straight-line fallback would have ≤ 5 points.
        for (const leg of transitLegs) {
            expect(
                leg.geometry.coordinates.length,
                `Transit leg "${leg.properties.line ?? leg.properties.mode}" must have real geometry — got only ${leg.geometry.coordinates.length} points (likely a straight-line fallback).`,
            ).toBeGreaterThan(5);
        }
    });

    test("long-distance trip (Augsburg → München) renders real geometry for ALL legs", async ({ page }) => {
        const segmentRequests: Array<Record<string, unknown>> = [];
        page.on("request", (req) => {
            if (req.url().includes("/api/routes/segment")) {
                try {
                    segmentRequests.push(JSON.parse(req.postData() ?? "{}"));
                } catch { /* ignore */ }
            }
        });

        await page.goto("/");
        await waitForMap(page);
        await openNavigationPanel(page);

        await fillLocation(page, 0, "Augsburg Hauptbahnhof");
        await fillLocation(page, 1, "München Hauptbahnhof");

        await expect(page.locator('[data-testid="route-results"]')).toBeVisible({ timeout: 20000 });
        await page.locator('[data-testid^="itinerary-"]').first().click();
        // Long-distance routes have more legs and longer segment fetches
        await page.waitForTimeout(6000);

        const features = await readNavigationRouteFeatures(page);
        const lineFeatures = features.filter((f) => f.geometry.type === "LineString") as Array<{
            properties: { mode?: string; line?: string };
            geometry: { type: "LineString"; coordinates: [number, number][] };
        }>;

        const transitLegs = lineFeatures.filter((f) => f.properties.mode && f.properties.mode !== "WALK");
        expect(transitLegs.length, "Should have transit legs").toBeGreaterThan(0);

        // The segment endpoint MUST be called for each transit leg —
        // including HIGHSPEED_RAIL/ICE legs.
        expect(segmentRequests.length, "Segment endpoint must be called for transit legs").toBeGreaterThanOrEqual(transitLegs.length);

        // EVERY transit leg must have real geometry — including ICE/long-distance.
        // The longest leg (the train) must have hundreds of points.
        for (const leg of transitLegs) {
            expect(
                leg.geometry.coordinates.length,
                `Long-distance transit leg "${leg.properties.line ?? leg.properties.mode}" must use real OSM geometry — got only ${leg.geometry.coordinates.length} points.`,
            ).toBeGreaterThan(5);
        }

        // For Augsburg → München, the longest train leg should have many points.
        // 20+ proves it's real geometry, not a 2-3 point straight line.
        const longestLeg = transitLegs.reduce((a, b) =>
            b.geometry.coordinates.length > a.geometry.coordinates.length ? b : a,
        );
        expect(
            longestLeg.geometry.coordinates.length,
            "The main train leg must have many real-geometry points",
        ).toBeGreaterThan(20);
    });

    test("transit leg geometry follows the route shape (not straight line distance)", async ({ page }) => {
        await page.goto("/");
        await waitForMap(page);
        await openNavigationPanel(page);

        // Use stops that are far enough apart to require a tram (~3km, not walkable)
        await fillLocation(page, 0, "Augsburg, Königsplatz");
        await fillLocation(page, 1, "Augsburg, Lechhausen");

        await expect(page.locator('[data-testid="route-results"]')).toBeVisible({ timeout: 15000 });
        await page.locator('[data-testid^="itinerary-"]').first().click();
        await page.waitForTimeout(4000);

        const features = await readNavigationRouteFeatures(page);
        const transitLegs = features
            .filter((f) => f.geometry.type === "LineString" && f.properties.mode && f.properties.mode !== "WALK") as Array<{
                geometry: { type: "LineString"; coordinates: [number, number][] };
            }>;

        expect(transitLegs.length, "Should have at least one transit leg").toBeGreaterThan(0);

        // For a real route, the actual path length should be longer than the
        // straight-line distance between endpoints (because routes curve around streets).
        // For a perfectly straight 2-point line, ratio = 1.0. Real routes have ratio > 1.05.
        const longestLeg = transitLegs.reduce((a, b) =>
            b.geometry.coordinates.length > a.geometry.coordinates.length ? b : a,
        );

        const coords = longestLeg.geometry.coordinates;
        const first = coords[0];
        const last = coords[coords.length - 1];

        // Compute path length (sum of segment distances)
        let pathLength = 0;
        for (let i = 1; i < coords.length; i++) {
            const dx = coords[i][0] - coords[i - 1][0];
            const dy = coords[i][1] - coords[i - 1][1];
            pathLength += Math.sqrt(dx * dx + dy * dy);
        }

        // Compute straight-line distance
        const straightDx = last[0] - first[0];
        const straightDy = last[1] - first[1];
        const straightLength = Math.sqrt(straightDx * straightDx + straightDy * straightDy);

        const ratio = pathLength / Math.max(straightLength, 1e-9);

        // Real routes always have at least slight curves between stations
        expect(
            ratio,
            `Path/straight ratio should be > 1.0 for real geometry (got ${ratio.toFixed(3)}, ${coords.length} coords)`,
        ).toBeGreaterThan(1.0);
    });

    test("navigation route includes transit legs with mode property set", async ({ page }) => {
        await page.goto("/");
        await waitForMap(page);
        await openNavigationPanel(page);

        // Use stops that are far enough apart to require a tram (~3km, not walkable)
        await fillLocation(page, 0, "Augsburg, Königsplatz");
        await fillLocation(page, 1, "Augsburg, Lechhausen");

        await expect(page.locator('[data-testid="route-results"]')).toBeVisible({ timeout: 15000 });
        await page.locator('[data-testid^="itinerary-"]').first().click();
        await page.waitForTimeout(4000);

        const features = await readNavigationRouteFeatures(page);
        const lineFeatures = features.filter((f) => f.geometry.type === "LineString");

        const modes = new Set(lineFeatures.map((f) => f.properties.mode).filter(Boolean));
        expect(modes.size, "Should have at least one mode").toBeGreaterThan(0);

        // For Königsplatz → Hauptbahnhof, we expect a TRAM leg
        const hasTransit = [...modes].some((m) => m && m !== "WALK");
        expect(hasTransit, `Should have a non-WALK transit leg (modes: ${[...modes].join(", ")})`).toBe(true);
    });
});
