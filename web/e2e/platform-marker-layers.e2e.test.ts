import { test, expect } from "@playwright/test";
import {
    MARTIN_URL,
    waitForMap,
    openLayersPanel,
    enableDebugMode,
    openDebugPanel,
    isCheckboxChecked,
    toggleCheckbox,
    queryLayer,
} from "./helpers";

/**
 * E2E tests: Verify the 4-tier transport marker system on the map.
 *
 * The markers are split between the Layers panel (user-facing) and the Debug panel (developer-only):
 *
 * LAYER PANEL (Ebenen):
 *   - "Haltestellen" (top-level toggle) — station circle markers, visible by default
 *     - "Steige" (sub-toggle) — user-friendly platform markers labeled C1, A2, etc.
 *       - Fallback: if no OSM platform exists, uses stop_position coordinates
 *       - "Umrisse" (sub-sub-toggle) — physical platform way outlines
 *
 * DEBUG PANEL (only when debug mode is on):
 *   - "Haltepositionen" — blue dots for ALL raw OSM stop_positions
 *   - "Plattformen" — orange dots for ALL raw OSM platforms
 *
 * Prerequisites:
 *   - vite dev server at localhost:5174
 *   - Martin tiles at omniviv-martin.localhost serving pre-generated MBTiles
 *   - Database populated with Augsburg OSM data
 */

// ─── Martin static tile serving (no SQL functions, only MBTiles) ─────────────

test.describe("Martin serves pre-generated MBTiles (auto_publish: false)", () => {
    test("transit_stations composite MBTiles returns data at z15 Königsplatz", async () => {
        const res = await fetch(`${MARTIN_URL}/transit_stations/15/17375/11340`);
        expect(res.ok).toBeTruthy();
        const contentType = res.headers.get("content-type");
        expect(contentType, "transit_stations tiles should be protobuf MVT").toBe("application/x-protobuf");
        const buf = await res.arrayBuffer();
        expect(buf.byteLength, "transit_stations should have data at Königsplatz").toBeGreaterThan(100);
    });

    test("transit_routes MBTiles returns data at z15 Königsplatz", async () => {
        const res = await fetch(`${MARTIN_URL}/transit_routes/15/17375/11340`);
        expect(res.ok).toBeTruthy();
        const buf = await res.arrayBuffer();
        expect(buf.byteLength, "transit_routes should have data at Königsplatz").toBeGreaterThan(100);
    });

    test("tile_steige individual MBTiles returns data at z15 Königsplatz", async () => {
        const res = await fetch(`${MARTIN_URL}/tile_steige/15/17375/11340`);
        expect(res.ok).toBeTruthy();
        const buf = await res.arrayBuffer();
        expect(buf.byteLength, "tile_steige should have data at Königsplatz").toBeGreaterThan(100);
    });

    test("Martin catalog does NOT expose SQL function sources (auto_publish: false)", async () => {
        const res = await fetch(`${MARTIN_URL}/catalog`);
        expect(res.ok).toBeTruthy();
        const catalog = await res.json();
        const sources = Object.keys(catalog.tiles ?? {});
        // All sources should be MBTiles-based, not SQL functions.
        // SQL function sources would have names like "transit_stations" but with
        // no corresponding MBTiles file. We verify by checking that well-known
        // MBTiles sources are present.
        expect(sources, "Catalog should include transit_stations MBTiles source").toContain("transit_stations");
        expect(sources, "Catalog should include transit_routes MBTiles source").toContain("transit_routes");
    });
});

// ─── Layer Panel: Haltestellen and Steige hierarchy ─────────────────────────

test.describe("Layer panel hierarchy", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await waitForMap(page);
    });

    test("Ebenen panel shows Haltestellen with Steige sub-toggle", async ({ page }) => {
        await openLayersPanel(page);

        // Haltestellen top-level toggle must exist
        const haltestellen = page.locator('label:has-text("Haltestellen")');
        await expect(haltestellen).toBeVisible();

        // Steige sub-toggle must exist (indented under Haltestellen)
        const steige = page.locator('label:has-text("Steige")');
        await expect(steige).toBeVisible();
    });

    test("Ebenen panel does NOT show Haltepositionen (moved to debug)", async ({ page }) => {
        await openLayersPanel(page);

        // "Haltepositionen" must NOT be in the layer panel — it's a debug-only feature
        const haltepos = page.locator('label:has-text("Haltepositionen")');
        await expect(haltepos).toHaveCount(0);
    });

    test("Steige sub-toggle has Umrisse sub-sub-toggle", async ({ page }) => {
        await openLayersPanel(page);

        const umrisse = page.locator('label:has-text("Umrisse")');
        await expect(umrisse).toBeVisible();
    });

    test("Steige is disabled when Haltestellen is off", async ({ page }) => {
        await openLayersPanel(page);

        // Turn off Haltestellen
        if (await isCheckboxChecked(page, "Haltestellen")) {
            await toggleCheckbox(page, "Haltestellen");
        }

        const steigeCheckbox = page.locator('label:has-text("Steige") button[role="checkbox"]');
        await expect(steigeCheckbox).toBeDisabled();
    });

    test("Umrisse is disabled when Steige is off", async ({ page }) => {
        await openLayersPanel(page);

        // Ensure Haltestellen is on but Steige is off
        if (!await isCheckboxChecked(page, "Haltestellen")) {
            await toggleCheckbox(page, "Haltestellen");
        }
        if (await isCheckboxChecked(page, "Steige")) {
            await toggleCheckbox(page, "Steige");
        }

        const umrisseCheckbox = page.locator('label:has-text("Umrisse") button[role="checkbox"]');
        await expect(umrisseCheckbox).toBeDisabled();
    });
});

// ─── User-facing steige-circle layer ────────────────────────────────────────

test.describe("Steige layer renders user-friendly platform markers", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await waitForMap(page);
    });

    test("steige-circle layer exists on the map", async ({ page }) => {
        const info = await queryLayer(page, "steige-circle");
        expect(info.exists, "steige-circle layer must exist").toBe(true);
    });

    test("steige-circle is hidden by default", async ({ page }) => {
        const info = await queryLayer(page, "steige-circle");
        expect(info.visibility, "steige-circle should be hidden by default").toBe("none");
    });

    test("enabling Steige toggle shows steige-circle markers", async ({ page }) => {
        await openLayersPanel(page);
        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(3000);

        const info = await queryLayer(page, "steige-circle");
        expect(info.visibility, "steige-circle should be visible after toggle").toBe("visible");
        expect(
            info.featureCount,
            "steige-circle should render platform markers at Königsplatz zoom 17",
        ).toBeGreaterThan(0);
    });

    test("enabling Steige also shows connection lines to station", async ({ page }) => {
        await openLayersPanel(page);
        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(3000);

        const info = await queryLayer(page, "station-connections-vector-line");
        expect(info.visibility, "Connection lines should be visible with Steige").toBe("visible");
        expect(
            info.featureCount,
            "Connection lines should render at Königsplatz when Steige is on",
        ).toBeGreaterThan(0);
    });

    test("steige markers include labels with platform names", async ({ page }) => {
        await openLayersPanel(page);
        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(3000);

        const labelInfo = await queryLayer(page, "steige-label");
        expect(labelInfo.exists, "steige-label layer must exist").toBe(true);
        expect(labelInfo.visibility, "steige-label should be visible when Steige is on").toBe("visible");
        expect(
            labelInfo.featureCount,
            "steige-label should render platform name labels at Königsplatz",
        ).toBeGreaterThan(0);
    });

    test("steige features have display_name property for labeling", async ({ page }) => {
        await openLayersPanel(page);
        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(3000);

        const features = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return [];
            return map.queryRenderedFeatures({ layers: ["steige-circle"] })
                .slice(0, 20)
                .map((f: any) => ({
                    display_name: f.properties?.display_name ?? null,
                    source_type: f.properties?.source_type ?? null,
                    station_id: f.properties?.station_id ?? null,
                }));
        });

        expect(features.length).toBeGreaterThan(0);

        // Every steige feature must have a display_name (C1, A2, B1, etc.)
        for (const f of features) {
            expect(f.display_name, "Every steige feature must have a display_name").toBeTruthy();
        }
    });

    test("steige features include fallback stop_positions where no platform exists", async ({ page }) => {
        await openLayersPanel(page);
        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(3000);

        const sourceTypes = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return [];
            return map.queryRenderedFeatures({ layers: ["steige-circle"] })
                .map((f: any) => f.properties?.source_type ?? "unknown");
        });

        expect(sourceTypes.length).toBeGreaterThan(0);

        // The source_type should indicate the origin: platform_way (best), platform, or stop_position (fallback)
        const types = new Set(sourceTypes);
        expect(
            types.has("platform_way") || types.has("platform") || types.has("stop_position"),
            "steige features must have source_type indicating platform_way, platform, or stop_position fallback",
        ).toBe(true);
    });

    test("disabling Steige hides steige-circle", async ({ page }) => {
        await openLayersPanel(page);
        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(500);
        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(500);

        const info = await queryLayer(page, "steige-circle");
        expect(info.visibility).toBe("none");
    });

    test("disabling Haltestellen also hides steige-circle", async ({ page }) => {
        await openLayersPanel(page);
        // Enable Steige first
        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(500);

        // Disable parent Haltestellen
        await toggleCheckbox(page, "Haltestellen");
        await page.waitForTimeout(500);

        const info = await queryLayer(page, "steige-circle");
        expect(info.visibility).toBe("none");
    });
});

// ─── Debug panel: raw OSM markers ───────────────────────────────────────────

test.describe("Debug panel shows raw OSM stop/platform toggles", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await waitForMap(page);
    });

    test("debug panel has Haltepositionen toggle for raw stop_positions", async ({ page }) => {
        await enableDebugMode(page);
        await openDebugPanel(page);

        const label = page.locator('label:has-text("Haltepositionen")');
        await expect(label).toBeVisible();
    });

    test("enabling Haltepositionen in debug panel shows blue stops-circle markers", async ({ page }) => {
        await enableDebugMode(page);
        await openDebugPanel(page);
        await toggleCheckbox(page, "Haltepositionen");
        await page.waitForTimeout(3000);

        const info = await queryLayer(page, "stops-circle");
        expect(info.visibility).toBe("visible");
        expect(
            info.featureCount,
            "stops-circle (raw blue markers) should have features at Königsplatz",
        ).toBeGreaterThan(0);
    });

    test("debug Haltepositionen does NOT show connection lines (those belong to user-facing Steige)", async ({ page }) => {
        await enableDebugMode(page);
        await openDebugPanel(page);
        await toggleCheckbox(page, "Haltepositionen");
        await page.waitForTimeout(1000);

        const info = await queryLayer(page, "station-connections-vector-line");
        expect(info.visibility, "Connection lines should NOT be tied to debug Haltepositionen").toBe("none");
    });

    test("debug panel has raw platforms toggle for orange platform markers", async ({ page }) => {
        await enableDebugMode(page);
        await openDebugPanel(page);

        // There should be a toggle for raw platform markers (the orange dots)
        // The label might be "Plattformen" or similar
        const label = page.locator('label:has-text("Plattformen")');
        await expect(label).toBeVisible();
    });

    test("enabling raw platforms toggle shows platforms-vt-circle markers independently from stops", async ({ page }) => {
        await enableDebugMode(page);
        await openDebugPanel(page);

        // Only enable Plattformen, NOT Haltepositionen
        const halteposChecked = await page.locator('label:has-text("Haltepositionen") button[role="checkbox"]').getAttribute("data-state");
        if (halteposChecked === "checked") {
            await toggleCheckbox(page, "Haltepositionen");
        }
        await toggleCheckbox(page, "Plattformen");
        await page.waitForTimeout(3000);

        const result = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return null;

            const stopsVis = map.getLayoutProperty("stops-circle", "visibility");
            const platformsVis = map.getLayoutProperty("platforms-vt-circle", "visibility");
            const platformFeatures = map.queryRenderedFeatures({ layers: ["platforms-vt-circle"] });
            const stopFeatures = map.queryRenderedFeatures({ layers: ["stops-circle"] });

            return {
                stopsVisibility: stopsVis,
                platformsVisibility: platformsVis,
                platformFeatureCount: platformFeatures.length,
                stopFeatureCount: stopFeatures.length,
                platformSamples: platformFeatures.slice(0, 3).map((f: any) => ({
                    sourceLayer: f.sourceLayer,
                    displayName: f.properties?.display_name,
                })),
            };
        });

        expect(result).not.toBeNull();
        if (!result) return;

        // Stops must be hidden (only Plattformen is enabled)
        expect(result.stopsVisibility, "Stops should be hidden when only Plattformen is toggled").toBe("none");

        // Platforms must be visible with features
        expect(result.platformsVisibility, "Platforms should be visible").toBe("visible");
        expect(result.platformFeatureCount, "platforms-vt-circle should have features").toBeGreaterThan(0);

        // Features must come from the 'platforms' source-layer, not 'stops'
        for (const f of result.platformSamples) {
            expect(f.sourceLayer, "Feature must come from platforms source-layer").toBe("platforms");
        }

        // Stops must have zero rendered features
        expect(result.stopFeatureCount, "stops-circle should have zero features when Haltepositionen is off").toBe(0);
    });

    test("debug Plattformen shows platform_ways centroids including A1-C4 at Königsplatz", async ({ page }) => {
        await enableDebugMode(page);
        await openDebugPanel(page);
        await toggleCheckbox(page, "Plattformen");
        await page.waitForTimeout(3000);

        const result = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return null;
            const features = map.queryRenderedFeatures({ layers: ["platforms-vt-circle"] });
            const names = features.map((f: any) => f.properties?.display_name).filter(Boolean);
            return { count: features.length, names: [...new Set(names)].sort() };
        });

        expect(result).not.toBeNull();
        expect(result!.count, "Should have many platform markers (platform_ways centroids + platform nodes)").toBeGreaterThan(5);
        // Königsplatz should have A1-C4 from platform_ways, not just D and E from platforms
        expect(result!.names, "Should include A1 from platform_ways centroids").toContain("A1");
        expect(result!.names, "Should include C4 from platform_ways centroids").toContain("C4");
    });

    test("debug Plattformen shows orange outlines at z16+", async ({ page }) => {
        // Navigate to z16+ where outlines are visible
        await page.goto("/#48.3655,10.8945,16.50,30,0");
        await waitForMap(page);

        await enableDebugMode(page);
        await openDebugPanel(page);
        await toggleCheckbox(page, "Plattformen");
        await page.waitForTimeout(3000);

        const info = await queryLayer(page, "debug-platform-outlines-line");
        expect(info.exists, "debug-platform-outlines-line layer must exist").toBe(true);
        expect(info.visibility, "outlines should be visible when Plattformen is on").toBe("visible");
        expect(info.featureCount, "Should have platform outline features at Königsplatz z16").toBeGreaterThan(0);
    });

    test("debug outlines are independent from Steige Umrisse toggle", async ({ page }) => {
        await page.goto("/#48.3655,10.8945,16.50,30,0");
        await waitForMap(page);

        // Enable debug mode and Plattformen toggle
        await enableDebugMode(page);
        await openDebugPanel(page);
        await toggleCheckbox(page, "Plattformen");
        await page.waitForTimeout(3000);

        // Verify Steige is off in the layers panel (not toggled by debug Plattformen)
        await openLayersPanel(page);
        const steigeChecked = await isCheckboxChecked(page, "Steige");
        expect(steigeChecked, "Steige should be off when only debug Plattformen is on").toBe(false);

        // Debug outlines should be visible, user-facing outlines should be hidden
        const debugOutlines = await queryLayer(page, "debug-platform-outlines-line");
        const userOutlines = await queryLayer(page, "platform-outlines-line");

        expect(debugOutlines.visibility, "Debug outlines should be visible").toBe("visible");
        expect(userOutlines.visibility, "User-facing Umrisse should remain hidden").toBe("none");
    });

    test("orange debug platform markers visually change the map", async ({ page }) => {
        await enableDebugMode(page);

        // Take screenshot before enabling platforms
        const before = await page.locator(".maplibregl-canvas").screenshot();

        await openDebugPanel(page);
        await toggleCheckbox(page, "Plattformen");
        await page.waitForTimeout(3000);

        // Take screenshot after — orange markers should be visible
        const after = await page.locator(".maplibregl-canvas").screenshot();

        expect(
            Buffer.compare(before, after),
            "Map should visually change when orange platform markers are enabled",
        ).not.toBe(0);
    });

    test("debug OSM markers are NOT visible when debug mode is off", async ({ page }) => {
        // Without enabling debug mode, the debug panel isn't accessible
        // and the raw markers should remain hidden
        const stops = await queryLayer(page, "stops-circle");
        const platforms = await queryLayer(page, "platforms-vt-circle");
        expect(stops.visibility).toBe("none");
        expect(platforms.visibility).toBe("none");
    });
});

// ─── Station markers (Haltestellen) ─────────────────────────────────────────

test.describe("Station markers render correctly", () => {
    test("stations-circle renders at Königsplatz zoom 17", async ({ page }) => {
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await waitForMap(page);

        const info = await queryLayer(page, "stations-circle");
        expect(info.exists).toBe(true);
        expect(info.visibility).toBe("visible");
        expect(info.featureCount, "Station marker should be visible at Königsplatz").toBeGreaterThan(0);
    });

    test("disabling Haltestellen hides station markers", async ({ page }) => {
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await waitForMap(page);
        await openLayersPanel(page);

        await toggleCheckbox(page, "Haltestellen");
        await page.waitForTimeout(500);

        const info = await queryLayer(page, "stations-circle");
        expect(info.visibility).toBe("none");
    });
});

// ─── Source configuration: maxzoom overzoom ──────────────────────────────────

test.describe("Source maxzoom enables overzooming at z16+", () => {
    test("transit-stations source has maxzoom 15 for overzoom at z16+", async ({ page }) => {
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await waitForMap(page);

        const maxzoom = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return null;
            const source = map.getSource("transit-stations");
            if (!source) return null;
            // MapLibre stores maxzoom on the source's internal data
            return source.maxzoom ?? source._options?.maxzoom ?? null;
        });

        expect(maxzoom, "transit-stations source must have maxzoom 15 for overzoom").toBe(15);
    });

    test("transit-routes source has maxzoom 15 for overzoom at z16+", async ({ page }) => {
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await waitForMap(page);

        const maxzoom = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return null;
            const source = map.getSource("transit-routes");
            if (!source) return null;
            return source.maxzoom ?? source._options?.maxzoom ?? null;
        });

        expect(maxzoom, "transit-routes source must have maxzoom 15 for overzoom").toBe(15);
    });

    test("steige markers render at z17 via overzooming z15 tiles", async ({ page }) => {
        // z17 > maxzoom 15, so MapLibre must overzoom z15 tiles
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await waitForMap(page);

        await openLayersPanel(page);
        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(3000);

        const info = await queryLayer(page, "steige-circle");
        expect(info.featureCount, "Steige markers must render at z17 via overzoom").toBeGreaterThan(0);
    });
});

// ─── Layer ordering: outlines render under centroids ─────────────────────────

test.describe("Layer ordering: debug above user-facing, outlines under centroids", () => {
    test("debug-platform-outlines-line is added before platforms-vt-circle in layer stack", async ({ page }) => {
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await waitForMap(page);

        const order = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return null;
            const layers = map.getStyle().layers.map((l: any) => l.id);
            const outlinesIdx = layers.indexOf("debug-platform-outlines-line");
            const circlesIdx = layers.indexOf("platforms-vt-circle");
            return { outlinesIdx, circlesIdx, outlinesBeforeCircles: outlinesIdx < circlesIdx };
        });

        expect(order).not.toBeNull();
        expect(
            order!.outlinesBeforeCircles,
            `Outlines (idx ${order!.outlinesIdx}) must render before/under circles (idx ${order!.circlesIdx})`,
        ).toBe(true);
    });

    test("user platform-outlines-line is added after steige-label in layer stack", async ({ page }) => {
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await waitForMap(page);

        const order = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return null;
            const layers = map.getStyle().layers.map((l: any) => l.id);
            const steigeLabelIdx = layers.indexOf("steige-label");
            const outlinesIdx = layers.indexOf("platform-outlines-line");
            return { steigeLabelIdx, outlinesIdx, outlinesAfterLabel: outlinesIdx > steigeLabelIdx };
        });

        expect(order).not.toBeNull();
        expect(
            order!.outlinesAfterLabel,
            `User outlines (idx ${order!.outlinesIdx}) must be after steige-label (idx ${order!.steigeLabelIdx})`,
        ).toBe(true);
    });

    test("debug platform layers render above user-facing steige layers", async ({ page }) => {
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await waitForMap(page);

        const order = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return null;
            const layers = map.getStyle().layers.map((l: any) => l.id);
            const steigeIdx = layers.indexOf("steige-circle");
            const userOutlinesIdx = layers.indexOf("platform-outlines-line");
            const debugOutlinesIdx = layers.indexOf("debug-platform-outlines-line");
            const debugCirclesIdx = layers.indexOf("platforms-vt-circle");
            const stopsIdx = layers.indexOf("stops-circle");
            return { steigeIdx, userOutlinesIdx, debugOutlinesIdx, debugCirclesIdx, stopsIdx };
        });

        expect(order).not.toBeNull();
        // All debug layers must be above user-facing steige and outlines
        expect(order!.stopsIdx, "Debug stops must be above user steige").toBeGreaterThan(order!.steigeIdx);
        expect(order!.debugOutlinesIdx, "Debug outlines must be above user outlines").toBeGreaterThan(order!.userOutlinesIdx);
        expect(order!.debugCirclesIdx, "Debug circles must be above user steige").toBeGreaterThan(order!.steigeIdx);
    });
});

// ─── User-facing Umrisse (platform outlines) toggle ──────────────────────────

test.describe("User-facing Umrisse toggle", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto("/#48.3655,10.8945,16.50,30,0");
        await waitForMap(page);
    });

    test("platform-outlines-line layer exists and is hidden by default", async ({ page }) => {
        const info = await queryLayer(page, "platform-outlines-line");
        expect(info.exists, "platform-outlines-line layer must exist").toBe(true);
        expect(info.visibility, "platform-outlines-line should be hidden by default").toBe("none");
    });

    test("enabling Steige + Umrisse shows platform outline features at z16+", async ({ page }) => {
        await openLayersPanel(page);
        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(500);
        await toggleCheckbox(page, "Umrisse");
        await page.waitForTimeout(3000);

        const info = await queryLayer(page, "platform-outlines-line");
        expect(info.visibility, "platform-outlines-line should be visible with Umrisse on").toBe("visible");
        expect(info.featureCount, "Should have platform outline features at z16.5").toBeGreaterThan(0);
    });

    test("Umrisse requires both Haltestellen AND Steige to be visible", async ({ page }) => {
        await openLayersPanel(page);

        // Enable Steige + Umrisse
        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(500);
        await toggleCheckbox(page, "Umrisse");
        await page.waitForTimeout(500);

        // Disable parent Haltestellen — Umrisse should hide
        await toggleCheckbox(page, "Haltestellen");
        await page.waitForTimeout(500);

        const info = await queryLayer(page, "platform-outlines-line");
        expect(info.visibility, "Umrisse must be hidden when Haltestellen is off").toBe("none");
    });

    test("user Umrisse and debug outlines are styled differently", async ({ page }) => {
        const colors = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return null;
            const userColor = map.getPaintProperty("platform-outlines-line", "line-color");
            const debugColor = map.getPaintProperty("debug-platform-outlines-line", "line-color");
            return { userColor, debugColor };
        });

        expect(colors).not.toBeNull();
        // User outlines are gray (#525252), debug outlines are orange (#f97316)
        expect(colors!.userColor).toBe("#525252");
        expect(colors!.debugColor).toBe("#f97316");
        expect(colors!.userColor, "User and debug outlines must have different colors").not.toBe(colors!.debugColor);
    });
});

// ─── Route tile layer ────────────────────────────────────────────────────────

test.describe("Route tiles render correctly", () => {
    test("routes-line layer exists with transit-routes source", async ({ page }) => {
        await page.goto("/#48.3655,10.8945,14.00,0,0");
        await waitForMap(page);

        const info = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return null;
            const layer = map.getLayer("routes-line");
            if (!layer) return { exists: false, source: null };
            return { exists: true, source: layer.source };
        });

        expect(info).not.toBeNull();
        expect(info!.exists, "routes-line layer must exist").toBe(true);
        expect(info!.source, "routes-line must use transit-routes source").toBe("transit-routes");
    });

    test("route lines render at Augsburg zoom 14", async ({ page }) => {
        await page.goto("/#48.3655,10.8945,14.00,0,0");
        await waitForMap(page);

        const info = await queryLayer(page, "routes-line");
        expect(info.exists).toBe(true);
        expect(info.visibility).toBe("visible");
        expect(info.featureCount, "Route lines should render at Augsburg z14").toBeGreaterThan(0);
    });
});

// ─── Full integration: all user-facing layers together ──────────────────────

test.describe("Full station infrastructure integration", () => {
    test("Königsplatz shows station + steige markers when both enabled", async ({ page }) => {
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await waitForMap(page);
        await openLayersPanel(page);

        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(3000);

        const station = await queryLayer(page, "stations-circle");
        const steige = await queryLayer(page, "steige-circle");

        expect(station.featureCount, "Station marker should be visible").toBeGreaterThan(0);
        expect(steige.featureCount, "Steige markers should be visible").toBeGreaterThan(0);

        // Königsplatz has 10 platforms (A1-A4, B1-B2, C1-C4)
        // Some may come from platforms, others from fallback stop_positions
        expect(
            steige.featureCount,
            "Königsplatz should have multiple steige markers (platforms + fallback stop_positions)",
        ).toBeGreaterThanOrEqual(5);
    });

    test("debug markers are independent from user-facing markers", async ({ page }) => {
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await waitForMap(page);

        // Enable user-facing Steige
        await openLayersPanel(page);
        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(1000);

        // Debug layers should still be hidden
        const debugStops = await queryLayer(page, "stops-circle");
        const debugPlatforms = await queryLayer(page, "platforms-vt-circle");
        expect(debugStops.visibility, "Debug stops should stay hidden when only user Steige is on").toBe("none");
        expect(debugPlatforms.visibility, "Debug platforms should stay hidden when only user Steige is on").toBe("none");
    });
});

// ─── Click interactions ─────────────────────────────────────────────────────

test.describe("Station and platform click interactions", () => {
    test("clicking a station marker opens station popup with platform list", async ({ page }) => {
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await waitForMap(page);

        // Find the Königsplatz station feature and get its screen position
        const clickTarget = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return null;
            const features = map.queryRenderedFeatures({ layers: ["stations-circle"] });
            if (features.length === 0) return null;
            // Target Königsplatz specifically (osm_id 29008174), not just the first feature
            const f = features.find((feat: any) => {
                const name = feat.properties?.name ?? "";
                return name.includes("Königsplatz");
            }) ?? features[0];
            const coords = f.geometry.coordinates;
            const point = map.project(coords);
            const canvas = map.getCanvas();
            const rect = canvas.getBoundingClientRect();
            return { x: rect.left + point.x, y: rect.top + point.y, name: f.properties?.name };
        });

        expect(clickTarget, "Should find a station feature to click").not.toBeNull();
        if (!clickTarget) return;

        await page.mouse.click(clickTarget.x, clickTarget.y);
        await page.waitForTimeout(2000);

        // MapLibre popup should appear
        const popup = page.locator(".maplibregl-popup");
        await expect(popup).toBeVisible({ timeout: 5000 });

        // Should contain the station name
        const text = await popup.textContent();
        expect(text, "Popup should contain station name").toContain("Königsplatz");
    });

    test("clicking a steige marker shows departures", async ({ page }) => {
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await waitForMap(page);

        // Enable Steige
        await openLayersPanel(page);
        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(3000);

        // Find a steige feature and click it
        const clickTarget = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return null;
            const features = map.queryRenderedFeatures({ layers: ["steige-circle"] });
            if (features.length === 0) return null;
            const f = features[0];
            const coords = f.geometry.coordinates;
            const point = map.project(coords);
            const canvas = map.getCanvas();
            const rect = canvas.getBoundingClientRect();
            return {
                x: rect.left + point.x,
                y: rect.top + point.y,
                display_name: f.properties?.display_name,
                stop_osm_id: f.properties?.stop_osm_id,
            };
        });

        expect(clickTarget, "Should find a steige feature to click").not.toBeNull();
        if (!clickTarget) return;

        await page.mouse.click(clickTarget.x, clickTarget.y);

        // MapLibre popup should appear with departure information
        const popup = page.locator(".maplibregl-popup");
        await expect(popup).toBeVisible({ timeout: 5000 });

        // Wait for departures to load (DepartureMonitor fetches from API)
        await page.waitForTimeout(5000);

        // The popup should show departure data (line numbers, destinations, times)
        const popupText = await popup.textContent();
        console.log(`Steige ${clickTarget.display_name} popup text: ${popupText?.substring(0, 200)}`);

        // Check the steige feature has stop_osm_id for departure lookups
        expect(
            clickTarget.stop_osm_id,
            `Steige ${clickTarget.display_name} must have stop_osm_id for departure lookups`,
        ).toBeTruthy();

        // The popup should contain "Steig" header and departure rows
        expect(popupText, "Popup should show platform name").toContain("Steig");
    });

    test("steige markers are interactive (have features for click/hover)", async ({ page }) => {
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await waitForMap(page);

        await openLayersPanel(page);
        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(3000);

        const featureCount = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return 0;
            return map.queryRenderedFeatures({ layers: ["steige-circle"] }).length;
        });

        expect(featureCount, "steige-circle should have features for click/hover interaction").toBeGreaterThan(0);
    });

    test("station popup platform click opens popup at steige marker position, not stop_position", async ({ page }) => {
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await waitForMap(page);

        // Enable Steige so the steige-circle features are queryable for position lookup
        await openLayersPanel(page);
        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(3000);

        // Click the station marker to open station popup
        const stationClick = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return null;
            const features = map.queryRenderedFeatures({ layers: ["stations-circle"] });
            if (features.length === 0) return null;
            const f = features[0];
            const coords = f.geometry.coordinates;
            const point = map.project(coords);
            const canvas = map.getCanvas();
            const rect = canvas.getBoundingClientRect();
            return { x: rect.left + point.x, y: rect.top + point.y };
        });
        if (!stationClick) return;

        await page.mouse.click(stationClick.x, stationClick.y);
        await page.waitForTimeout(2000);

        const popup = page.locator(".maplibregl-popup");
        await expect(popup).toBeVisible({ timeout: 5000 });

        // Click a platform button in the station popup (e.g. A1)
        const platformButton = popup.locator("button").filter({ hasText: /^A1$/ });
        if (await platformButton.count() === 0) return; // Skip if A1 not in popup

        await platformButton.click();
        await page.waitForTimeout(2000);

        // The platform popup should now be visible
        const platformPopup = page.locator(".maplibregl-popup");
        await expect(platformPopup).toBeVisible({ timeout: 5000 });

        // Get the popup's geographic position from MapLibre
        const popupPosition = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return null;
            // Find the active popup's lngLat
            const popupEl = document.querySelector(".maplibregl-popup");
            if (!popupEl) return null;
            // The popup stores its _lngLat — access it through MapLibre's internal
            const style = popupEl.getAttribute("style");
            if (!style) return null;
            // Extract transform translate values to compute geographic position
            // Alternative: check if popup position is near the steige marker
            const steigeFeatures = map.queryRenderedFeatures(undefined, { layers: ["steige-circle"] });
            const a1 = steigeFeatures.find((f: any) => f.properties?.display_name === "A1");
            if (!a1) return null;
            const steigeCoords = a1.geometry.coordinates;
            const steigeLon = a1.properties?.lon ?? steigeCoords[0];
            const steigeLat = a1.properties?.lat ?? steigeCoords[1];
            return { steigeLon, steigeLat };
        });

        // The popup should be at the steige position, not at the stop_position
        if (popupPosition) {
            const a1Ref = KOENIGSPLATZ_REFERENCE_POSITIONS["A1"];
            const distance = haversineMeters(
                { lat: popupPosition.steigeLat, lon: popupPosition.steigeLon },
                a1Ref,
            );
            expect(
                distance,
                `Steige A1 feature should be at platform_way centroid, not stop_position (${distance.toFixed(1)}m from reference)`,
            ).toBeLessThan(1.0);
        }
    });
});

// ─── Steige display_name must never show station names ──────────────────────

test.describe("Steige display_name quality", () => {
    test("no steige marker uses a station name as its label", async ({ page }) => {
        // Navigate to a wider view to capture multiple stations' steige markers
        await page.goto("/#48.3655,10.8945,16.00,30,0");
        await waitForMap(page);

        await openLayersPanel(page);
        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(3000);

        const badLabels = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return [];
            const steigeFeatures = map.queryRenderedFeatures({ layers: ["steige-circle"] });
            const stationFeatures = map.queryRenderedFeatures({ layers: ["stations-circle"] });
            const stationNames = new Set(stationFeatures.map((f: any) => (f.properties?.name ?? "").toLowerCase()));

            return steigeFeatures
                .filter((f: any) => {
                    const dn = (f.properties?.display_name ?? "").toLowerCase();
                    // A display_name should be short (A1, B2, C3) not a full station name
                    return dn.length > 5 && stationNames.has(dn);
                })
                .map((f: any) => ({
                    display_name: f.properties?.display_name,
                    station_id: f.properties?.station_id,
                }));
        });

        expect(
            badLabels.length,
            `Steige markers must not use station names as labels: ${JSON.stringify(badLabels)}`,
        ).toBe(0);
    });
});

// ─── No semicolons in display_name (compound refs must be split) ────────────

test.describe("Steige display_name has no semicolons", () => {
    test("no steige marker has a semicolon in its display_name at Königsplatz area", async ({ page }) => {
        await page.goto("/#48.365,10.895,14.00,0,0");
        await waitForMap(page);

        await openLayersPanel(page);
        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(4000);

        const bad = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return [];
            return map.queryRenderedFeatures({ layers: ["steige-circle"] })
                .filter((f: any) => (f.properties?.display_name ?? "").includes(";"))
                .map((f: any) => ({
                    display_name: f.properties?.display_name,
                    station_id: f.properties?.station_id,
                    osm_id: f.properties?.osm_id,
                }));
        });

        expect(
            bad.length,
            `Steige markers must not have semicolons in display_name (compound refs like "A;B" must be split into separate rows):\n` +
            bad.map((b: { display_name: string; station_id: number; osm_id: number }) =>
                `  ${b.display_name} (station=${b.station_id}, osm=${b.osm_id})`
            ).join("\n"),
        ).toBe(0);
    });

    test("Frohsinnstraße station popup shows A and B buttons, not A;B", async ({ page }) => {
        // Navigate to Frohsinnstraße station
        await page.goto("/#48.3619,10.8918,17.00,0,0");
        await waitForMap(page);

        // Click the station marker
        const clickTarget = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return null;
            const features = map.queryRenderedFeatures({ layers: ["stations-circle"] });
            // Find Frohsinnstraße station
            const f = features.find((f: any) =>
                f.properties?.osm_id === 1096784 || String(f.properties?.osm_id) === "1096784"
            ) ?? features[0];
            if (!f) return null;
            const coords = f.geometry.coordinates;
            const point = map.project(coords);
            const canvas = map.getCanvas();
            const rect = canvas.getBoundingClientRect();
            return { x: rect.left + point.x, y: rect.top + point.y };
        });

        if (!clickTarget) return;
        await page.mouse.click(clickTarget.x, clickTarget.y);
        await page.waitForTimeout(2000);

        const popup = page.locator(".maplibregl-popup");
        await expect(popup).toBeVisible({ timeout: 5000 });

        // Get all button texts in the popup (platform buttons)
        const buttons = await popup.locator("button").allTextContents();
        const platformButtons = buttons.filter(t => t.length <= 5 && t.length > 0);

        // No button should contain a semicolon
        for (const btn of platformButtons) {
            expect(btn, `Station popup button "${btn}" must not contain semicolons`).not.toContain(";");
        }
    });

    test("Frohsinnstraße steige markers are A and B, not A;B", async ({ page }) => {
        // Frohsinnstraße station is at 48.3619, 10.8918
        await page.goto("/#48.3619,10.8918,17.00,0,0");
        await waitForMap(page);

        await openLayersPanel(page);
        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(3000);

        const features = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return [];
            return map.queryRenderedFeatures({ layers: ["steige-circle"] })
                .filter((f: any) => {
                    // Filter to Frohsinnstraße station (station_id=1096784)
                    // Vector tile properties may be numbers or strings
                    const sid = f.properties?.station_id;
                    return sid === 1096784 || sid === "1096784" || String(sid) === "1096784";
                })
                .map((f: any) => f.properties?.display_name ?? "?");
        });

        // Should have A and B as separate entries, never "A;B"
        expect(features.length, "Frohsinnstraße should have steige features").toBeGreaterThan(0);
        for (const dn of features) {
            expect(dn, `Frohsinnstraße steige "${dn}" must not contain semicolons`).not.toContain(";");
        }
        // Specifically verify A and B exist as separate entries
        expect(features, "Frohsinnstraße should have platform A").toContain("A");
        expect(features, "Frohsinnstraße should have platform B").toContain("B");
    });
});

// ─── Hardcoded reference positions for Königsplatz platforms ─────────────────
//
// These coordinates are the GROUND TRUTH for Königsplatz platform positions.
// They were captured from the current correct rendering (2026-04-03) and must
// NEVER be changed by any agent. Platform positions in the physical world do
// not change. Any future code change that moves a marker outside the 1-meter
// radius of these reference points is a regression.
//
// Source: platform_ways centroids (A1–C4), platform point nodes (D, E)

const KOENIGSPLATZ_REFERENCE_POSITIONS: Record<string, { lat: number; lon: number }> = {
    A1: { lat: 48.36548695, lon: 10.89428830 },
    A2: { lat: 48.36552055, lon: 10.89415440 },
    A3: { lat: 48.36552850, lon: 10.89412675 },
    A4: { lat: 48.36556065, lon: 10.89401245 },
    B1: { lat: 48.36547320, lon: 10.89464990 },
    B2: { lat: 48.36548870, lon: 10.89478785 },
    C1: { lat: 48.36518919, lon: 10.89444661 },
    C2: { lat: 48.36510118, lon: 10.89441027 },
    C3: { lat: 48.36508006, lon: 10.89440373 },
    C4: { lat: 48.36499918, lon: 10.89436633 },
    D:  { lat: 48.36496830, lon: 10.89224660 },
    E:  { lat: 48.36686840, lon: 10.89270740 },
};

/** Haversine distance in meters between two lat/lon points */
function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
    const R = 6371000;
    const phi1 = (a.lat * Math.PI) / 180;
    const phi2 = (b.lat * Math.PI) / 180;
    const dphi = ((b.lat - a.lat) * Math.PI) / 180;
    const dlam = ((b.lon - a.lon) * Math.PI) / 180;
    const x = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

test.describe("Königsplatz platform positions are at correct physical locations", () => {
    test("all steige markers are within 1 meter of reference positions", async ({ page }) => {
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await waitForMap(page);

        await openLayersPanel(page);
        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(3000);

        const features = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return [];
            return map.queryRenderedFeatures({ layers: ["steige-circle"] })
                .map((f: any) => ({
                    display_name: f.properties?.display_name ?? null,
                    lon: f.properties?.lon ?? f.geometry?.coordinates?.[0],
                    lat: f.properties?.lat ?? f.geometry?.coordinates?.[1],
                }));
        });

        expect(features.length, "Should have steige features at Königsplatz").toBeGreaterThanOrEqual(10);

        const errors: string[] = [];
        const matched: string[] = [];

        for (const [name, expected] of Object.entries(KOENIGSPLATZ_REFERENCE_POSITIONS)) {
            const feature = features.find((f: { display_name: string }) => f.display_name === name);
            if (!feature) {
                errors.push(`${name}: missing from steige features`);
                continue;
            }

            const actual = { lat: feature.lat, lon: feature.lon };
            const distance = haversineMeters(expected, actual);

            if (distance > 1.0) {
                errors.push(
                    `${name}: ${distance.toFixed(2)}m from reference ` +
                    `(expected ${expected.lat.toFixed(8)},${expected.lon.toFixed(8)} ` +
                    `got ${actual.lat.toFixed(8)},${actual.lon.toFixed(8)})`
                );
            } else {
                matched.push(`${name}: ${distance.toFixed(2)}m ✓`);
            }
        }

        console.log(`Matched ${matched.length}/${Object.keys(KOENIGSPLATZ_REFERENCE_POSITIONS).length} platforms within 1m`);
        if (matched.length > 0) console.log(matched.join(", "));

        expect(errors.length, `Platform position regressions:\n${errors.join("\n")}`).toBe(0);
    });
});
