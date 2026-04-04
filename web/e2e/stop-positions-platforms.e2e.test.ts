import { test, expect, type Page } from "@playwright/test";

/**
 * E2E tests: Verify that Steige (user-facing platform markers) appear on the
 * map when the Steige checkbox is toggled on in the Ebenen panel.
 *
 * Steige markers use the precalculated "steige" vector tile source-layer which
 * merges platform nodes with stop_position fallbacks. They are labeled with
 * platform names (C1, A2, etc.).
 *
 * Raw OSM stop positions (blue) and platforms (orange) are debug-only markers
 * controlled from the Debug panel, NOT the Ebenen panel.
 *
 * Prerequisites:
 *   - vite dev server at localhost:5174
 *   - Martin tiles serving detail PMTiles with steige layer
 */

async function openLayersPanel(page: Page) {
    const btn = page.locator('button[aria-label="Ebenen"]');
    await btn.click();
    await expect(page.locator("text=Ebenen")).toBeVisible();
}

async function toggleCheckbox(page: Page, label: string) {
    const checkbox = page.locator(`label:has-text("${label}") button[role="checkbox"]`);
    await checkbox.click();
    await page.waitForTimeout(500);
}

async function isCheckboxChecked(page: Page, label: string): Promise<boolean> {
    const checkbox = page.locator(`label:has-text("${label}") button[role="checkbox"]`);
    const state = await checkbox.getAttribute("data-state");
    return state === "checked";
}

test.describe("Steige (platform markers) on map", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(3000);
    });

    test("Steige checkbox is unchecked by default", async ({ page }) => {
        await openLayersPanel(page);
        const checked = await isCheckboxChecked(page, "Steige");
        expect(checked, "Steige should be unchecked by default").toBe(false);
    });

    test("toggling Steige on shows platform markers on map", async ({ page }) => {
        await openLayersPanel(page);

        const before = await page.locator(".maplibregl-canvas").screenshot();

        await toggleCheckbox(page, "Steige");
        expect(await isCheckboxChecked(page, "Steige")).toBe(true);

        await page.waitForTimeout(2000);
        const after = await page.locator(".maplibregl-canvas").screenshot();

        expect(
            Buffer.compare(before, after),
            "Map should change when Steige are enabled at zoom 17",
        ).not.toBe(0);
    });

    test("toggling Steige off hides platform markers again", async ({ page }) => {
        await openLayersPanel(page);

        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(2000);
        const withSteige = await page.locator(".maplibregl-canvas").screenshot();

        await toggleCheckbox(page, "Steige");
        await page.waitForTimeout(1000);
        const withoutSteige = await page.locator(".maplibregl-canvas").screenshot();

        expect(
            Buffer.compare(withSteige, withoutSteige),
            "Map should change when Steige are disabled",
        ).not.toBe(0);
    });

    test("Steige is disabled when Haltestellen is off", async ({ page }) => {
        await openLayersPanel(page);

        await toggleCheckbox(page, "Haltestellen");

        const steigeCheckbox = page.locator('label:has-text("Steige") button[role="checkbox"]');
        await expect(steigeCheckbox).toBeDisabled();
    });

    test("Umrisse is disabled when Steige is off", async ({ page }) => {
        await openLayersPanel(page);

        const umrisseCheckbox = page.locator('label:has-text("Umrisse") button[role="checkbox"]');
        await expect(umrisseCheckbox).toBeDisabled();
    });

    test("Martin detail tile contains steige layer data", async ({ page }) => {
        const result = await page.evaluate(async () => {
            const res = await fetch("http://omniviv-martin.localhost/detail/15/17375/11340");
            const body = await res.arrayBuffer();
            const text = new TextDecoder("latin1").decode(new Uint8Array(body));
            return { ok: res.ok, size: body.byteLength, hasSteige: text.includes("steige") };
        });

        expect(result.ok, "Martin tile should load successfully").toBe(true);
        expect(result.size, "Tile should contain data").toBeGreaterThan(100);
        expect(result.hasSteige, "Tile must contain steige source-layer").toBe(true);
    });
});

test.describe("Haltepositionen NOT in layers panel", () => {
    test("Ebenen panel does not have Haltepositionen toggle", async ({ page }) => {
        await page.goto("/#48.3655,10.8945,17.00,30,0");
        await page.waitForLoadState("networkidle");

        await openLayersPanel(page);

        // Haltepositionen is now in the debug panel, not the layers panel
        const haltepos = page.locator('label:has-text("Haltepositionen")');
        await expect(haltepos).toHaveCount(0);
    });
});
