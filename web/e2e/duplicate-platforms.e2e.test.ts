import { test, expect } from "@playwright/test";

/**
 * E2E tests to check for duplicate platforms on the map at Königsplatz.
 * Navigates to a specific location and verifies that platforms aren't rendered multiple times.
 */

const TARGET_URL = "/#48.36530,10.89436,18.53,30,0";

test.describe("Platform duplication check at Königsplatz", () => {
    test("should not have duplicate platforms at Königsplatz", async ({ page }) => {
        // Navigate to the target area
        await page.goto(TARGET_URL);

        // Wait for the map to be initialized
        await page.waitForFunction(() => (window as any).map);

        // Enable extra platform layers via localStorage/options if possible, 
        // or just wait for vector tiles. 
        // Based on Map.tsx, these are controlled by props which come from options.
        await page.evaluate(() => {
            const STORAGE_KEY = "live-tram-options";
            const options = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
            options.showStopPositions = true;
            options.showPlatforms = true;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
            // Reload to apply options (or we could try to find the React state, but reload is easier)
        });
        await page.reload();
        await page.waitForFunction(() => (window as any).map);

        // Wait for rendering to settle
        await page.waitForTimeout(5000);

        // Query rendered features in view
        const features = await page.evaluate(() => {
            const map = (window as any).map;
            
            // Query all relevant layers — both vector tile (primary) and GeoJSON (legacy)
            const layers = [
                // Vector tile layers (primary, from Martin/PostGIS)
                "stations-circle",
                "stops-circle",
                "platforms-vt-circle",
                // Legacy GeoJSON layers (for mapping UI)
                "platforms-circle",
                "stop-positions-marker",
                "platform-elements-marker",
            ];
            return map.queryRenderedFeatures({ layers: layers.filter(l => map.getLayer(l)) })
                .map((f: any) => ({
                    id: f.id,
                    layer: f.layer.id,
                    source: f.source,
                    properties: f.properties
                }));
        });

        console.log(`Found ${features.length} platform features in view.`);
        expect(features.length, "No features found — map layers may not have loaded").toBeGreaterThan(0);
        if (features.length > 0) {
            console.log("Feature samples:", JSON.stringify(features.slice(0, 10), null, 2));
        }

        // Group features by a unique key to identify duplicates.
        const counts = new Map<string, number>();
        for (const feature of features) {
            const name = feature.properties.name || "unnamed";
            const osmId = feature.properties.osm_id || "no-id";
            const ref = feature.properties.ref || "";
            // Use name and osm_id and layer as unique key
            const key = `${name}|${ref}|${osmId}|${feature.layer}`;
            
            counts.set(key, (counts.get(key) || 0) + 1);
        }

        const duplicates: string[] = [];
        for (const [key, count] of counts.entries()) {
            if (count > 1) {
                duplicates.push(`${key}: ${count} times`);
            }
        }

        if (duplicates.length > 0) {
            console.error("Duplicate platforms found:", duplicates);
        }

        expect(duplicates.length, `Found duplicate platforms: ${duplicates.join(", ")}`).toBe(0);
    });
});
