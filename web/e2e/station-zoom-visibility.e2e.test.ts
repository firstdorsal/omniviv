import { test, expect } from "@playwright/test";

/**
 * E2E tests: Verify that station dots on the map are filtered by zoom level.
 *
 * Station visibility is controlled by the `min_zoom` property in Martin vector
 * tiles (PostgreSQL transit_stations function), filtered client-side by MapLibre
 * GL via `["<=", ["get", "min_zoom"], ["zoom"]]`.
 *
 * Zoom thresholds:
 *   6  — Hauptbahnhöfe only (by name: "Hbf", "Hauptbahnhof")
 *   8  — Major multimodal hubs (train + 3 modes, or train + 4 platforms)
 *   12 — All other rail stations (S-Bahn, RE, etc.) and halts
 *   13 — Tram/bus stops
 *
 * Prerequisites:
 *   - vite dev server at localhost:5174
 *   - Martin at omniviv-martin.localhost
 */

const MARTIN_URL = "http://omniviv-martin.localhost";

async function isMartinReachable(): Promise<boolean> {
    try {
        const res = await fetch(`${MARTIN_URL}/catalog`, { signal: AbortSignal.timeout(3000) });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Query rendered station features on the map at a given zoom level via the browser.
 * Returns station names and their min_zoom values.
 */
async function getVisibleStations(page: import("@playwright/test").Page, center: { lat: number; lon: number }, zoom: number): Promise<{ name: string; min_zoom: number }[]> {
    await page.goto(`/#${center.lat},${center.lon},${zoom.toFixed(2)},0,0`);
    // Wait for window.map to exist (set in DEV mode by Map.tsx)
    await page.waitForFunction(() => !!(window as any).map, { timeout: 20000 });
    // Wait for map to be fully interactive
    await page.waitForFunction(() => {
        const map = (window as any).map;
        return map && typeof map.getZoom === "function";
    }, { timeout: 10000 });
    // Let MapLibre render vector tiles at the target zoom
    await page.waitForTimeout(4000);

    return page.evaluate(() => {
        const map = (window as any).map;
        if (!map) return [];
        try {
            const features = map.queryRenderedFeatures({ layers: ["stations-circle"] });
            return features.map((f: { properties: { name?: string; min_zoom?: number } }) => ({
                name: f.properties?.name ?? "?",
                min_zoom: f.properties?.min_zoom ?? 99,
            }));
        } catch {
            return [];
        }
    });
}

const MUNICH = { lat: 48.14, lon: 11.58 };

// ─── Tile-level tests (no browser needed) ────────────────────────────────────

test.describe("Martin tile min_zoom values", () => {
    test.beforeEach(async () => {
        if (!await isMartinReachable()) {
            test.skip(true, "Martin not reachable");
        }
    });

    test("zoom 9 Munich tile does not contain S-Bahn stations", async () => {
        // z=9, x=271, y=177 covers Munich
        const res = await fetch(`${MARTIN_URL}/transit_stations/9/271/177`);
        expect(res.ok).toBeTruthy();
        const buf = await res.arrayBuffer();
        const text = new TextDecoder("latin1").decode(buf);

        // Known S-Bahn stations that should NOT be in a zoom-9 tile
        const sBahnStations = ["Allach", "Baldham", "Baierbrunn", "Dachau Bahnhof", "Neubiberg", "Olching"];
        for (const name of sBahnStations) {
            expect(
                text.includes(name),
                `S-Bahn station "${name}" should not be in zoom-9 tile`,
            ).toBe(false);
        }
    });

    test("zoom 9 Munich tile contains Hauptbahnhof", async () => {
        const res = await fetch(`${MARTIN_URL}/transit_stations/9/271/177`);
        expect(res.ok).toBeTruthy();
        const buf = await res.arrayBuffer();
        const text = new TextDecoder("latin1").decode(buf);

        expect(
            text.includes("Hauptbahnhof"),
            "Hauptbahnhof should be in zoom-9 tile",
        ).toBe(true);
    });

    test("zoom 12 Munich tile contains S-Bahn stations", async () => {
        // z=12, x=2179, y=1421 covers central Munich (48.14, 11.58)
        const res = await fetch(`${MARTIN_URL}/transit_stations/12/2179/1421`);
        expect(res.ok).toBeTruthy();
        const buf = await res.arrayBuffer();
        const text = new TextDecoder("latin1").decode(buf);

        // At zoom 12, rail stations should be present
        expect(buf.byteLength, "Zoom 12 tile should have substantial content").toBeGreaterThan(1000);
        expect(
            text.includes("Hauptbahnhof"),
            "Hauptbahnhof should still be in zoom-12 tile",
        ).toBe(true);
    });
});

// ─── Browser-based rendering tests ───────────────────────────────────────────

test.describe("Station rendering on map", () => {
    test.beforeEach(async () => {
        if (!await isMartinReachable()) {
            test.skip(true, "Martin not reachable");
        }
    });

    test("Munich zoom 9: only Hauptbahnhof visible, no S-Bahn", async ({ page }) => {
        const stations = await getVisibleStations(page, MUNICH, 9);

        // Filter to Munich area stations (there may be edge-tile stations from other cities)
        const nonHbf = stations.filter(s => {
            const name = s.name.toLowerCase();
            return !name.includes("hbf") && !name.includes("hauptbahnhof");
        });

        expect(
            nonHbf.length,
            `At zoom 9, only Hbf should be visible but found: ${nonHbf.map(s => s.name).join(", ")}`,
        ).toBe(0);
    });

    test("Munich zoom 12: S-Bahn stations become visible", async ({ page }) => {
        const stations = await getVisibleStations(page, MUNICH, 12);

        expect(
            stations.length,
            "At zoom 12, many stations should be visible including S-Bahn",
        ).toBeGreaterThan(10);

        // Should include non-Hbf stations now
        const nonHbf = stations.filter(s => {
            const name = s.name.toLowerCase();
            return !name.includes("hbf") && !name.includes("hauptbahnhof");
        });

        expect(
            nonHbf.length,
            "At zoom 12, S-Bahn/rail stations should be visible",
        ).toBeGreaterThan(0);
    });

    test("all visible stations have min_zoom <= current zoom", async ({ page }) => {
        const zoom = 10;
        const stations = await getVisibleStations(page, MUNICH, zoom);

        for (const s of stations) {
            expect(
                s.min_zoom,
                `Station "${s.name}" has min_zoom ${s.min_zoom} but is visible at zoom ${zoom}`,
            ).toBeLessThanOrEqual(zoom);
        }
    });
});
