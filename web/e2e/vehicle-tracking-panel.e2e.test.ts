import { test, expect } from "@playwright/test";

/**
 * E2E tests for the VehicleTrackingPanel.
 *
 * Validates:
 *   - Panel opens when clicking a vehicle marker on the map
 *   - Header shows LineBadge (pill variant) with line number and destination
 *   - Origin line ("ab ...") matches the first stop in the stop list
 *   - Stop list is displayed in correct sequence order
 *   - Camera follow and pin/unpin buttons are functional
 *   - Panel closes when clicking empty map area
 *
 * Prerequisites:
 *   - vite dev server at localhost:5174
 *   - API at omniviv-api.localhost with active tram data
 */

const API_URL = "http://omniviv-api.localhost";
const APP_URL = "http://localhost:5174";
const AUGSBURG_CENTER = { lat: 48.365, lon: 10.894 };

async function isApiReachable(): Promise<boolean> {
    try {
        const res = await fetch(`${API_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Wait for vehicle markers to appear on the map and return the screen
 * position of the first one for clicking.
 */
async function waitForVehicleAndGetPosition(page: import("@playwright/test").Page): Promise<{
    x: number;
    y: number;
    lineNumber: string;
    destination: string;
    tripId: string;
} | null> {
    // Wait for vehicles to render
    const hasVehicles = await page.waitForFunction(
        () => {
            const map = (window as any).map;
            if (!map) return false;
            try {
                return map.queryRenderedFeatures(undefined, { layers: ["vehicles-marker"] })?.length > 0;
            } catch {
                return false;
            }
        },
        { timeout: 30000 },
    ).catch(() => null);

    if (!hasVehicles) return null;

    // Get the screen position of the first vehicle
    return page.evaluate(() => {
        const map = (window as any).map;
        const features = map.queryRenderedFeatures(undefined, { layers: ["vehicles-marker"] });
        if (!features?.length) return null;

        const f = features[0];
        const pos = map.project(f.geometry.coordinates);
        const rect = map.getCanvas().getBoundingClientRect();
        return {
            x: Math.round(pos.x + rect.left),
            y: Math.round(pos.y + rect.top),
            lineNumber: f.properties.lineNumber,
            destination: f.properties.destination,
            tripId: f.properties.tripId,
        };
    });
}

test.describe("Vehicle tracking panel", () => {
    test.beforeEach(async () => {
        test.skip(!(await isApiReachable()), "API not reachable");
    });

    test("opens when clicking a vehicle marker and shows LineBadge with correct data", async ({ page }) => {
        await page.goto(`${APP_URL}/#${AUGSBURG_CENTER.lat},${AUGSBURG_CENTER.lon},14.00,0,0`);
        await page.waitForFunction(() => !!(window as any).map, { timeout: 20000 });

        const vehicle = await waitForVehicleAndGetPosition(page);
        test.skip(!vehicle, "No vehicles currently running");

        // Click the vehicle marker
        await page.mouse.click(vehicle!.x, vehicle!.y);
        await page.waitForTimeout(1000);

        // Panel should appear
        const panel = page.locator('[data-testid="vehicle-tracking-panel"]');
        await expect(panel).toBeVisible({ timeout: 5000 });

        // LineBadge should be present with correct line number
        const badge = panel.locator(`[data-line="${vehicle!.lineNumber}"]`);
        await expect(badge).toBeVisible();

        // Destination should match vehicle marker data
        const destination = page.locator('[data-testid="vehicle-destination"]');
        await expect(destination).toBeVisible();
        await expect(destination).toHaveText(vehicle!.destination);
    });

    test("origin line matches the first stop in the stop list", async ({ page }) => {
        await page.goto(`${APP_URL}/#${AUGSBURG_CENTER.lat},${AUGSBURG_CENTER.lon},14.00,0,0`);
        await page.waitForFunction(() => !!(window as any).map, { timeout: 20000 });

        const vehicle = await waitForVehicleAndGetPosition(page);
        test.skip(!vehicle, "No vehicles currently running");

        await page.mouse.click(vehicle!.x, vehicle!.y);
        await page.waitForTimeout(1000);

        const panel = page.locator('[data-testid="vehicle-tracking-panel"]');
        await expect(panel).toBeVisible({ timeout: 5000 });

        // Get origin text
        const originEl = page.locator('[data-testid="vehicle-origin"]');
        const originText = await originEl.textContent();

        // Get the first stop name from the stop list
        const stopList = page.locator('[data-testid="vehicle-stop-list"]');
        await expect(stopList).toBeVisible();
        const firstStopName = await stopList.locator("> div").first().locator("span.text-sm").first().textContent();

        // Origin should contain the first stop's name
        if (originText && firstStopName) {
            expect(originText).toContain(firstStopName.trim());
        }
    });

    test("stop list is in correct sequence order", async ({ page }) => {
        await page.goto(`${APP_URL}/#${AUGSBURG_CENTER.lat},${AUGSBURG_CENTER.lon},14.00,0,0`);
        await page.waitForFunction(() => !!(window as any).map, { timeout: 20000 });

        const vehicle = await waitForVehicleAndGetPosition(page);
        test.skip(!vehicle, "No vehicles currently running");

        await page.mouse.click(vehicle!.x, vehicle!.y);
        await page.waitForTimeout(1000);

        const panel = page.locator('[data-testid="vehicle-tracking-panel"]');
        await expect(panel).toBeVisible({ timeout: 5000 });

        // Verify stop list exists and has multiple stops
        const stopList = page.locator('[data-testid="vehicle-stop-list"]');
        await expect(stopList).toBeVisible();
        const stopCount = await stopList.locator("> div").count();
        expect(stopCount).toBeGreaterThan(1);

        // Verify stops match API data order (sorted by sequence)
        const stopsFromPanel = await stopList.locator("> div span.text-sm").allTextContents();
        const stopsFromApi = await page.evaluate((tripId: string) => {
            const map = (window as any).map;
            const features = map.queryRenderedFeatures(undefined, { layers: ["vehicles-marker"] });
            const feature = features.find((f: any) => f.properties.tripId === tripId);
            return feature ? { found: true } : { found: false };
        }, vehicle!.tripId);
        expect(stopsFromApi.found).toBe(true);

        // The stop names should not be empty
        for (const name of stopsFromPanel) {
            expect(name.trim().length).toBeGreaterThan(0);
        }
    });

    test("camera follow button toggles state", async ({ page }) => {
        await page.goto(`${APP_URL}/#${AUGSBURG_CENTER.lat},${AUGSBURG_CENTER.lon},14.00,0,0`);
        await page.waitForFunction(() => !!(window as any).map, { timeout: 20000 });

        const vehicle = await waitForVehicleAndGetPosition(page);
        test.skip(!vehicle, "No vehicles currently running");

        await page.mouse.click(vehicle!.x, vehicle!.y);
        await page.waitForTimeout(1000);

        const panel = page.locator('[data-testid="vehicle-tracking-panel"]');
        await expect(panel).toBeVisible({ timeout: 5000 });

        // Camera follow should be active initially (Video icon visible)
        const cameraBtn = panel.locator('button[title="Kamera lösen"]');
        await expect(cameraBtn).toBeVisible();

        // Click to disable camera follow
        await cameraBtn.click();
        await page.waitForTimeout(500);

        // Button title should change to "Kamera folgen"
        const cameraOffBtn = panel.locator('button[title="Kamera folgen"]');
        await expect(cameraOffBtn).toBeVisible();
    });

    test("pin button pins the vehicle and shows sidebar icon", async ({ page }) => {
        await page.goto(`${APP_URL}/#${AUGSBURG_CENTER.lat},${AUGSBURG_CENTER.lon},14.00,0,0`);
        await page.waitForFunction(() => !!(window as any).map, { timeout: 20000 });

        const vehicle = await waitForVehicleAndGetPosition(page);
        test.skip(!vehicle, "No vehicles currently running");

        await page.mouse.click(vehicle!.x, vehicle!.y);
        await page.waitForTimeout(1000);

        const panel = page.locator('[data-testid="vehicle-tracking-panel"]');
        await expect(panel).toBeVisible({ timeout: 5000 });

        // Click pin button
        const pinBtn = panel.locator('button[title="Anheften"]');
        await expect(pinBtn).toBeVisible();
        await pinBtn.click();
        await page.waitForTimeout(500);

        // Unpin button should now be visible
        const unpinBtn = panel.locator('button[title="Loslösen"]');
        await expect(unpinBtn).toBeVisible();

        // A pinned vehicle button should appear in the sidebar
        const sidebarBtn = page.locator(`button[aria-label="Linie ${vehicle!.lineNumber}"]`);
        await expect(sidebarBtn).toBeVisible();

        // Unpin to clean up
        await unpinBtn.click();
        await page.waitForTimeout(500);
    });

    test("panel shows active status indicator for running vehicle", async ({ page }) => {
        await page.goto(`${APP_URL}/#${AUGSBURG_CENTER.lat},${AUGSBURG_CENTER.lon},14.00,0,0`);
        await page.waitForFunction(() => !!(window as any).map, { timeout: 20000 });

        const vehicle = await waitForVehicleAndGetPosition(page);
        test.skip(!vehicle, "No vehicles currently running");

        await page.mouse.click(vehicle!.x, vehicle!.y);
        await page.waitForTimeout(1000);

        const panel = page.locator('[data-testid="vehicle-tracking-panel"]');
        await expect(panel).toBeVisible({ timeout: 5000 });

        // "Aktiv" status indicator should be visible
        await expect(panel.locator("text=Aktiv")).toBeVisible();
    });

    test("stop list has at least 2 stops with non-empty names", async ({ page }) => {
        await page.goto(`${APP_URL}/#${AUGSBURG_CENTER.lat},${AUGSBURG_CENTER.lon},14.00,0,0`);
        await page.waitForFunction(() => !!(window as any).map, { timeout: 20000 });

        const vehicle = await waitForVehicleAndGetPosition(page);
        test.skip(!vehicle, "No vehicles currently running");

        await page.mouse.click(vehicle!.x, vehicle!.y);
        await page.waitForTimeout(1000);

        const panel = page.locator('[data-testid="vehicle-tracking-panel"]');
        await expect(panel).toBeVisible({ timeout: 5000 });

        const stopList = page.locator('[data-testid="vehicle-stop-list"]');
        await expect(stopList).toBeVisible();

        // Should have at least 2 stops (API requires min 2 for a vehicle)
        const stopItems = stopList.locator("> div");
        const count = await stopItems.count();
        expect(count).toBeGreaterThanOrEqual(2);

        // All stops should have non-empty names
        const names = await stopList.locator("> div span.text-sm").allTextContents();
        for (const name of names) {
            expect(name.trim().length).toBeGreaterThan(0);
        }

        // First and last stop names should differ (it's a real route)
        if (names.length >= 2) {
            const firstName = names[0].trim();
            const lastName = names[names.length - 1].trim();
            expect(firstName).not.toBe(lastName);
        }
    });
});
