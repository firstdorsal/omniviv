import { test, expect } from "@playwright/test";

/**
 * E2E test: Clicking on a city/town label shows a popup with population.
 * Uses a deterministic target: zoom to show "Augsburg" city label and click it.
 *
 * The click handler is registered on the MapLibre layers "place-city",
 * "place-town", "place-village" in Map.tsx. The popup is rendered using
 * MapLibre's native Popup class (selector: .maplibregl-popup).
 */

test.describe("Place popup with population", () => {
    test("clicking a known city label shows popup with population", { timeout: 30000 }, async ({ page }) => {
        // Zoom 10 centered on Augsburg — the "Augsburg" city label should be visible
        await page.goto("/#48.37,10.90,10,0,0");

        // Wait for window.map to exist (set in DEV mode by Map.tsx)
        await page.waitForFunction(() => !!(window as any).map, { timeout: 20000 });
        await page.waitForFunction(() => {
            const map = (window as any).map;
            return map && typeof map.getZoom === "function";
        }, { timeout: 10000 });
        // Let vector tiles load and render
        await page.waitForTimeout(5000);

        // Find a place feature from the layers that have click handlers
        const clickTarget = await page.evaluate(() => {
            const m = (window as any).map;
            if (!m) return null;

            // Query only the layers that have click handlers registered in Map.tsx
            const placeLayers = ["place-city", "place-town", "place-village"]
                .filter(l => m.getLayer(l));
            if (placeLayers.length === 0) return { error: "no place layers found on map" };

            const placeFeatures = m.queryRenderedFeatures(undefined, { layers: placeLayers })
                .filter((f: any) => f.properties?.name);
            if (placeFeatures.length === 0) return { error: "no place features rendered at this zoom" };

            // Known cities in our dataset that should appear at this zoom
            const knownCities = ["Augsburg", "München", "Landsberg am Lech", "Friedberg", "Aichach"];
            const target =
                placeFeatures.find((f: any) => knownCities.includes(f.properties.name)) ??
                placeFeatures.find((f: any) => f.properties.class === "city") ??
                placeFeatures.find((f: any) => f.properties.class === "town") ??
                placeFeatures[0];

            // map.project() returns coordinates relative to the map canvas container.
            // We need to add the canvas bounding rect offset so that page.mouse.click()
            // hits the correct position on the page (map is offset by the sidebar).
            const coords = target.geometry.coordinates;
            const point = m.project(coords);
            const canvas = m.getCanvas();
            const rect = canvas.getBoundingClientRect();

            return {
                x: rect.left + point.x,
                y: rect.top + point.y,
                name: target.properties.name,
                class: target.properties.class,
                layer: target.layer?.id,
            };
        });

        console.log("Click target:", JSON.stringify(clickTarget));
        expect(clickTarget, "Should find a place feature to click").not.toBeNull();
        if (!clickTarget || "error" in clickTarget) {
            expect(false, `Place feature lookup failed: ${(clickTarget as any)?.error}`).toBe(true);
            return;
        }

        await page.mouse.click(clickTarget.x, clickTarget.y);
        await page.waitForTimeout(2000);

        const popup = page.locator(".maplibregl-popup");
        const visible = await popup.isVisible();
        console.log("Popup visible:", visible);
        expect(visible, `Popup should appear after clicking on ${clickTarget.name}`).toBe(true);

        const text = await popup.textContent();
        console.log("Popup text:", text);
        expect(text).toContain(clickTarget.name);
        expect(text).toMatch(/Stadt|Gemeinde|Ort/);
        expect(text).toContain("Einwohner");
    });
});
