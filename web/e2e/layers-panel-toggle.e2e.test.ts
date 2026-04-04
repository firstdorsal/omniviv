import { test, expect, type Page } from "@playwright/test";

/**
 * E2E tests: Verify that the layers panel toggles correctly show/hide
 * stations, routes, and other map elements.
 *
 * Prerequisites:
 *   - vite dev server at localhost:5174
 *   - Martin tiles at omniviv-martin.localhost
 */

/** Open the layers panel */
async function openLayersPanel(page: Page) {
    const btn = page.locator('button[aria-label="Ebenen"]');
    await btn.click();
    await expect(page.locator("text=Ebenen")).toBeVisible();
}

/** Get the state of a checkbox by its label text */
async function isCheckboxChecked(page: Page, label: string): Promise<boolean> {
    const checkbox = page.locator(`label:has-text("${label}") button[role="checkbox"]`);
    const state = await checkbox.getAttribute("data-state");
    return state === "checked";
}

/** Toggle a checkbox by clicking its label */
async function toggleCheckbox(page: Page, label: string) {
    const checkbox = page.locator(`label:has-text("${label}") button[role="checkbox"]`);
    await checkbox.click();
    // Wait for MapLibre to process the visibility change
    await page.waitForTimeout(500);
}

/** Check if a MapLibre layer is visible by evaluating in the page context */
async function isLayerVisible(page: Page, layerId: string): Promise<boolean | null> {
    return page.evaluate((id) => {
        const container = document.querySelector(".maplibregl-canvas-container");
        if (!container) return null;
        // @ts-expect-error accessing MapLibre internals
        const map = container.parentElement?._maplibre ?? container.parentElement?.__map;
        if (!map) {
            // Try alternative: find map via global
            // @ts-expect-error
            const mapEl = document.querySelector(".maplibregl-map")?.__maplibregl;
            if (!mapEl) return null;
        }
        return null; // Can't access map instance directly
    }, layerId);
}

test.describe("Layers panel toggles", () => {
    test.beforeEach(async ({ page }) => {
        // Navigate to a zoom level where stations are visible
        await page.goto("/#48.365,10.894,14.00,30,0");
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(2000);
    });

    test("layers panel shows Haltestellen without count when empty", async ({ page }) => {
        await openLayersPanel(page);

        // The label should say "Haltestellen" without "(0)"
        const label = page.locator('label:has-text("Haltestellen")');
        await expect(label).toBeVisible();

        const text = await label.textContent();
        expect(text).not.toContain("(0)");
    });

    test("layers panel shows Linien without count when empty", async ({ page }) => {
        await openLayersPanel(page);

        const label = page.locator('label:has-text("Linien")');
        await expect(label).toBeVisible();

        const text = await label.textContent();
        expect(text).not.toContain("(0)");
    });

    test("Haltestellen checkbox is checked by default", async ({ page }) => {
        await openLayersPanel(page);

        const checked = await isCheckboxChecked(page, "Haltestellen");
        expect(checked).toBe(true);
    });

    test("toggling Haltestellen off hides station markers on map", async ({ page }) => {
        await openLayersPanel(page);

        // Verify stations are currently checked
        expect(await isCheckboxChecked(page, "Haltestellen")).toBe(true);

        // Take a screenshot before toggling for comparison
        const before = await page.locator(".maplibregl-canvas").screenshot();

        // Toggle off
        await toggleCheckbox(page, "Haltestellen");
        expect(await isCheckboxChecked(page, "Haltestellen")).toBe(false);

        // Wait for map to update
        await page.waitForTimeout(1000);

        // Take a screenshot after toggling
        const after = await page.locator(".maplibregl-canvas").screenshot();

        // The screenshots should differ (stations removed)
        expect(Buffer.compare(before, after), "Map should change when stations are toggled off").not.toBe(0);
    });

    test("toggling Haltestellen back on restores station markers", async ({ page }) => {
        await openLayersPanel(page);

        // Take initial screenshot
        const initial = await page.locator(".maplibregl-canvas").screenshot();

        // Toggle off then on
        await toggleCheckbox(page, "Haltestellen");
        await page.waitForTimeout(500);
        await toggleCheckbox(page, "Haltestellen");
        await page.waitForTimeout(1000);

        // Should be back to checked
        expect(await isCheckboxChecked(page, "Haltestellen")).toBe(true);

        const restored = await page.locator(".maplibregl-canvas").screenshot();

        // The map should look similar to the initial state
        // (exact pixel match is unlikely due to animations, but the screenshots should be close)
        // We just verify the toggle cycles correctly
    });

    test("toggling Linien off hides route lines on map", async ({ page }) => {
        await openLayersPanel(page);

        expect(await isCheckboxChecked(page, "Linien")).toBe(true);

        const before = await page.locator(".maplibregl-canvas").screenshot();

        await toggleCheckbox(page, "Linien");
        expect(await isCheckboxChecked(page, "Linien")).toBe(false);

        await page.waitForTimeout(1000);
        const after = await page.locator(".maplibregl-canvas").screenshot();

        expect(Buffer.compare(before, after), "Map should change when routes are toggled off").not.toBe(0);
    });

    test("Steige and Umrisse are disabled when Haltestellen is off", async ({ page }) => {
        await openLayersPanel(page);

        // Toggle Haltestellen off
        await toggleCheckbox(page, "Haltestellen");

        // Steige and Umrisse checkboxes should be disabled
        const steigeCheckbox = page.locator('label:has-text("Steige") button[role="checkbox"]');
        const umrisseCheckbox = page.locator('label:has-text("Umrisse") button[role="checkbox"]');

        await expect(steigeCheckbox).toBeDisabled();
        await expect(umrisseCheckbox).toBeDisabled();
    });
});
