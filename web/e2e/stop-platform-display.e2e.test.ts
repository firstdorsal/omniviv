import { test, expect, type Page } from "@playwright/test";

/**
 * E2E tests: Verify that station infrastructure data exists in the database,
 * Martin tiles, and MapLibre layers. Tests the data pipeline from PostGIS
 * through Martin vector tiles to the browser.
 *
 * User-facing layer tests (Steige toggle, debug panel markers) are in
 * platform-marker-layers.e2e.test.ts and stop-positions-platforms.e2e.test.ts.
 *
 * Prerequisites:
 *   - vite dev server at localhost:5174
 *   - Martin tiles serving overview + detail PMTiles
 *   - Database populated with Augsburg OSM data
 */

const API = "http://omniviv-api.localhost";

async function openLayersPanel(page: Page) {
    await page.locator('button[aria-label="Ebenen"]').click();
    await expect(page.locator("text=Ebenen")).toBeVisible();
}

async function toggleCheckbox(page: Page, label: string) {
    await page.locator(`label:has-text("${label}") button[role="checkbox"]`).click();
    await page.waitForTimeout(500);
}

/** Query MapLibre for layer info — requires window.map to be exposed (DEV mode) */
async function queryLayer(page: Page, layerId: string): Promise<{
    exists: boolean;
    visibility: string;
    featureCount: number;
}> {
    return page.evaluate((id) => {
        const map = (window as any).map;
        if (!map) return { exists: false, visibility: "no map", featureCount: -1 };
        const layer = map.getLayer(id);
        if (!layer) return { exists: false, visibility: "no layer", featureCount: 0 };
        const vis = map.getLayoutProperty(id, "visibility") ?? "visible";
        let count = 0;
        try { count = map.queryRenderedFeatures({ layers: [id] }).length; } catch { count = -1; }
        return { exists: true, visibility: vis, featureCount: count };
    }, layerId);
}

/** Wait for map to be ready with window.map exposed */
async function waitForMap(page: Page) {
    await page.waitForFunction(() => !!(window as any).map, { timeout: 20000 });
    await page.waitForFunction(() => {
        const map = (window as any).map;
        return map && typeof map.getZoom === "function";
    }, { timeout: 10000 });
    await page.waitForTimeout(4000);
}

// ─── Database verification ──────────────────────────────────────────────────

test.describe("Database has correct stop position and platform data", () => {
    test("Königsplatz has stop positions in the database", async ({ request }) => {
        const res = await request.get(`${API}/api/stations/563331`);
        expect(res.ok()).toBeTruthy();
        const station = await res.json();
        expect(station.name).toContain("Königsplatz");
        expect(station.stop_positions.length, "Should have stop positions").toBeGreaterThan(5);
        for (const sp of station.stop_positions.slice(0, 5)) {
            expect(sp.lat).toBeTruthy();
            expect(sp.lon).toBeTruthy();
        }
    });

    test("Königsplatz has platforms in the database", async ({ request }) => {
        const res = await request.get(`${API}/api/stations/563331`);
        expect(res.ok()).toBeTruthy();
        const station = await res.json();
        expect(station.platforms.length, "Should have platforms").toBeGreaterThan(0);
        for (const p of station.platforms.slice(0, 5)) {
            expect(p.lat).toBeTruthy();
            expect(p.lon).toBeTruthy();
        }
    });

    test("stop positions and platforms are at different coordinates", async ({ request }) => {
        const res = await request.get(`${API}/api/stations/563331`);
        const station = await res.json();
        const stopCoords = new Set(station.stop_positions.map(
            (sp: { lat: number; lon: number }) => `${sp.lat.toFixed(5)},${sp.lon.toFixed(5)}`
        ));
        const platCoords = new Set(station.platforms.map(
            (p: { lat: number; lon: number }) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`
        ));
        const stopOnly = [...stopCoords].filter(c => !platCoords.has(c));
        expect(stopOnly.length, "Some stop positions should be at different coords than platforms").toBeGreaterThan(0);
    });
});

// ─── Vector tile verification ───────────────────────────────────────────────

test.describe("Martin tiles contain correct layers", () => {
    test("overview tile at zoom 15 contains stations source-layer", async ({ page }) => {
        const result = await page.evaluate(async () => {
            const res = await fetch("http://omniviv-martin.localhost/overview/15/17375/11340");
            const body = await res.arrayBuffer();
            const text = new TextDecoder("ascii", { fatal: false }).decode(new Uint8Array(body));
            return { ok: res.ok, size: body.byteLength, hasStations: text.includes("stations") };
        });
        expect(result.ok).toBe(true);
        expect(result.size, "Overview tile should not be empty").toBeGreaterThan(100);
        expect(result.hasStations, "Overview tile must contain stations source-layer").toBe(true);
    });

    test("detail tile at zoom 15 contains steige and stops source-layers", async ({ page }) => {
        const result = await page.evaluate(async () => {
            const res = await fetch("http://omniviv-martin.localhost/detail/15/17375/11340");
            const body = await res.arrayBuffer();
            const text = new TextDecoder("ascii", { fatal: false }).decode(new Uint8Array(body));
            return {
                ok: res.ok,
                size: body.byteLength,
                hasStops: text.includes("stops"),
                hasPlatforms: text.includes("platforms"),
                hasSteige: text.includes("steige"),
            };
        });
        expect(result.ok).toBe(true);
        expect(result.size, "Detail tile should not be empty").toBeGreaterThan(100);
        expect(result.hasStops, "Detail tile must contain stops source-layer").toBe(true);
        expect(result.hasPlatforms, "Detail tile must contain platforms source-layer").toBe(true);
        expect(result.hasSteige, "Detail tile must contain steige source-layer").toBe(true);
    });
});

// ─── MapLibre layer existence and defaults ──────────────────────────────────

test.describe("MapLibre layers exist with correct defaults", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await waitForMap(page);
    });

    test("all station infrastructure layers exist", async ({ page }) => {
        const layers = ["stations-circle", "stations-label", "steige-circle", "steige-label",
                        "stops-circle", "stops-label", "platforms-vt-circle", "platforms-vt-label",
                        "station-connections-vector-line"];
        for (const id of layers) {
            const info = await queryLayer(page, id);
            expect(info.exists, `${id} layer must exist`).toBe(true);
        }
    });

    test("station markers visible by default, all others hidden", async ({ page }) => {
        // Stations visible by default
        expect((await queryLayer(page, "stations-circle")).visibility).toBe("visible");
        expect((await queryLayer(page, "stations-label")).visibility).toBe("visible");

        // User-facing steige hidden by default
        expect((await queryLayer(page, "steige-circle")).visibility).toBe("none");
        expect((await queryLayer(page, "steige-label")).visibility).toBe("none");

        // Debug layers hidden by default
        expect((await queryLayer(page, "stops-circle")).visibility).toBe("none");
        expect((await queryLayer(page, "platforms-vt-circle")).visibility).toBe("none");
        expect((await queryLayer(page, "station-connections-vector-line")).visibility).toBe("none");
    });
});

// ─── Station marker renders at high zoom ─────────────────────────────────────

test.describe("Station circle marker renders at Königsplatz", () => {
    test("stations-circle has a feature at zoom 17", async ({ page }) => {
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await waitForMap(page);

        const info = await queryLayer(page, "stations-circle");
        expect(info.exists).toBe(true);
        expect(info.visibility).toBe("visible");
        expect(info.featureCount, "Station marker should render at Königsplatz").toBeGreaterThan(0);
    });
});

// ─── Steige toggle renders user-facing markers ──────────────────────────────

test.describe("Steige toggle from layers panel", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await waitForMap(page);
    });

    test("enabling Steige renders steige-circle features", async ({ page }) => {
        await openLayersPanel(page);
        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(3000);

        const info = await queryLayer(page, "steige-circle");
        expect(info.visibility).toBe("visible");
        expect(info.featureCount, "steige-circle should render platform markers at Königsplatz").toBeGreaterThan(0);
    });

    test("disabling Haltestellen hides both station and steige markers", async ({ page }) => {
        await openLayersPanel(page);
        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(1000);
        await toggleCheckbox(page, "Haltestellen");
        await page.waitForTimeout(1000);

        expect((await queryLayer(page, "stations-circle")).visibility).toBe("none");
        expect((await queryLayer(page, "steige-circle")).visibility).toBe("none");
    });
});
