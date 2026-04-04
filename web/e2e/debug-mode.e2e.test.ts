import { test, expect, type Page } from "@playwright/test";

/**
 * E2E tests: Verify the global debug mode toggle and debug log buttons.
 *
 * Tests:
 *   1. Debug mode toggle in settings persists across reloads
 *   2. Bug button in sidebar only visible when debug mode is on
 *   3. Debug log buttons appear on location search suggestions when debug mode is on
 *   4. Debug log buttons disappear when debug mode is off
 *   5. Clicking a debug log button actually logs to the console
 *   6. Debug log buttons appear on route itinerary cards
 *
 * Prerequisites:
 *   - vite dev server at localhost:5174
 *   - MOTIS at omniviv-motis.localhost
 */

const MOTIS_URL = "http://omniviv-motis.localhost";

async function isMotisReachable(): Promise<boolean> {
    try {
        const res = await fetch(`${MOTIS_URL}/api/v1/geocode?text=test&place=48.37,10.89`, {
            signal: AbortSignal.timeout(3000),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/** Open the settings panel */
async function openSettings(page: Page) {
    await page.locator('button[aria-label="Einstellungen"]').click();
    await expect(page.locator("text=Einstellungen")).toBeVisible();
}

/** Toggle the debug mode switch */
async function toggleDebugMode(page: Page) {
    const toggle = page.locator("#debug-mode");
    await toggle.click();
}

/** Check if debug mode switch is checked */
async function isDebugModeOn(page: Page): Promise<boolean> {
    const toggle = page.locator("#debug-mode");
    return (await toggle.getAttribute("data-state")) === "checked";
}

/** Enable debug mode via settings (idempotent) */
async function enableDebugMode(page: Page) {
    await openSettings(page);
    if (!(await isDebugModeOn(page))) {
        await toggleDebugMode(page);
    }
    await expect(page.locator("#debug-mode")).toHaveAttribute("data-state", "checked");
}

/** Disable debug mode via settings (idempotent) */
async function disableDebugMode(page: Page) {
    await openSettings(page);
    if (await isDebugModeOn(page)) {
        await toggleDebugMode(page);
    }
    await expect(page.locator("#debug-mode")).toHaveAttribute("data-state", "unchecked");
}

// ─── Debug Mode Toggle ──────────────────────────────────────────────────────

test.describe("Debug mode toggle", () => {
    test("debug mode is off by default", async ({ page }) => {
        // Clear any persisted state
        await page.goto("/");
        await page.evaluate(() => {
            const raw = localStorage.getItem("live-tram-options");
            if (raw) {
                const opts = JSON.parse(raw);
                opts.debugMode = false;
                localStorage.setItem("live-tram-options", JSON.stringify(opts));
            }
        });
        await page.reload();
        await page.waitForLoadState("networkidle");

        // Bug button should not be visible
        const bugButton = page.locator('button[aria-label="Debug"]');
        await expect(bugButton).toHaveCount(0);
    });

    test("enabling debug mode shows bug button in sidebar", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        // Verify bug button is hidden initially
        let bugButton = page.locator('button[aria-label="Debug"]');
        await expect(bugButton).toHaveCount(0);

        // Enable debug mode
        await enableDebugMode(page);

        // Bug button should now be visible
        bugButton = page.locator('button[aria-label="Debug"]');
        await expect(bugButton).toBeVisible();
    });

    test("disabling debug mode hides bug button", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        // Enable first
        await enableDebugMode(page);
        await expect(page.locator('button[aria-label="Debug"]')).toBeVisible();

        // Disable
        await toggleDebugMode(page);
        await expect(page.locator('button[aria-label="Debug"]')).toHaveCount(0);
    });

    test("debug mode persists across page reloads", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        await enableDebugMode(page);
        await expect(page.locator('button[aria-label="Debug"]')).toBeVisible();

        // Reload
        await page.reload();
        await page.waitForLoadState("networkidle");

        // Bug button should still be visible
        await expect(page.locator('button[aria-label="Debug"]')).toBeVisible();
    });
});

// ─── Debug Log Buttons on Location Search ────────────────────────────────────

test.describe("Debug log buttons on location search", () => {
    test.beforeEach(async () => {
        if (!(await isMotisReachable())) {
            test.skip(true, "MOTIS not reachable");
        }
    });

    test("debug log buttons appear on search suggestions when debug mode is on", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        await enableDebugMode(page);

        // Open route planning
        await page.locator('button[aria-label="Routenplanung"]').click();
        await expect(page.locator("text=Routenplanung")).toBeVisible();

        // Search for a location
        const input = page.locator('input[role="combobox"]').first();
        await input.click();
        await input.fill("Königsplatz");
        await page.waitForTimeout(1500);

        // Debug log buttons should appear
        const debugButtons = page.locator('[aria-label="Log GeocodeSuggestion to console"]');
        await expect(debugButtons.first()).toBeVisible({ timeout: 5000 });
        const count = await debugButtons.count();
        expect(count, "Should have debug buttons for each suggestion").toBeGreaterThan(0);
    });

    test("debug log buttons do NOT appear when debug mode is off", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        // Ensure debug mode is off
        await disableDebugMode(page);

        // Open route planning
        await page.locator('button[aria-label="Routenplanung"]').click();

        const input = page.locator('input[role="combobox"]').first();
        await input.click();
        await input.fill("Königsplatz");
        await page.waitForTimeout(1500);

        // Debug log buttons should NOT appear
        const debugButtons = page.locator('[aria-label="Log GeocodeSuggestion to console"]');
        await expect(debugButtons).toHaveCount(0);
    });

    test("clicking a debug log button logs data to the console", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        await enableDebugMode(page);

        await page.locator('button[aria-label="Routenplanung"]').click();

        const input = page.locator('input[role="combobox"]').first();
        await input.click();
        await input.fill("Susis Hexenhäusel");
        await page.waitForTimeout(1500);

        // Collect console messages
        const consoleMessages: { type: string; text: string }[] = [];
        page.on("console", (msg) => {
            consoleMessages.push({ type: msg.type(), text: msg.text() });
        });

        // Click the first debug log button
        const debugButton = page.locator('[aria-label="Log GeocodeSuggestion to console"]').first();
        await expect(debugButton).toBeVisible({ timeout: 5000 });
        await debugButton.click();

        // Wait a moment for the console message
        await page.waitForTimeout(500);

        // Should have logged a startGroupCollapsed with "GeocodeSuggestion" label
        const groupMessage = consoleMessages.find(
            (m) => m.type === "startGroupCollapsed" && m.text.includes("GeocodeSuggestion"),
        );
        expect(groupMessage, "Should have logged a grouped GeocodeSuggestion message").toBeTruthy();
    });
});

// ─── Debug Log Buttons on Route Results ──────────────────────────────────────

test.describe("Debug log buttons on route results", () => {
    test.beforeEach(async () => {
        if (!(await isMotisReachable())) {
            test.skip(true, "MOTIS not reachable");
        }
    });

    test("debug log buttons appear on itinerary cards when debug mode is on", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        await enableDebugMode(page);

        // Open route planning and search
        await page.locator('button[aria-label="Routenplanung"]').click();

        // Fill start
        const startInput = page.locator('input[role="combobox"]').first();
        await startInput.click();
        await startInput.fill("Königsplatz");
        await page.waitForTimeout(1500);
        const startOption = page.locator('[role="option"]').first();
        await expect(startOption).toBeVisible({ timeout: 5000 });
        await startOption.click();

        // Fill end
        const endInput = page.locator('input[role="combobox"]').nth(1);
        await endInput.click();
        await endInput.fill("Stadtbergen");
        await page.waitForTimeout(1500);
        const endOption = page.locator('[role="option"]').first();
        await expect(endOption).toBeVisible({ timeout: 5000 });
        await endOption.click();

        // Search route
        const searchButton = page.locator('button:has-text("Route finden")');
        await expect(searchButton).toBeEnabled({ timeout: 5000 });
        await searchButton.click();

        // Wait for results
        await expect(page.locator('[data-testid="route-results"]')).toBeVisible({ timeout: 15000 });

        // Debug log buttons should appear on itinerary cards
        const debugButtons = page.locator('[aria-label="Log RouteItinerary to console"]');
        await expect(debugButtons.first()).toBeVisible({ timeout: 5000 });
        const count = await debugButtons.count();
        expect(count, "Should have debug buttons on itinerary results").toBeGreaterThan(0);
    });

    test("no debug log buttons on itinerary cards when debug mode is off", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        await disableDebugMode(page);

        await page.locator('button[aria-label="Routenplanung"]').click();

        const startInput = page.locator('input[role="combobox"]').first();
        await startInput.click();
        await startInput.fill("Königsplatz");
        await page.waitForTimeout(1500);
        await page.locator('[role="option"]').first().click();

        const endInput = page.locator('input[role="combobox"]').nth(1);
        await endInput.click();
        await endInput.fill("Stadtbergen");
        await page.waitForTimeout(1500);
        await page.locator('[role="option"]').first().click();

        const searchButton = page.locator('button:has-text("Route finden")');
        await expect(searchButton).toBeEnabled({ timeout: 5000 });
        await searchButton.click();

        await expect(page.locator('[data-testid="route-results"]')).toBeVisible({ timeout: 15000 });

        // Debug buttons should NOT appear
        const debugButtons = page.locator('[aria-label="Log RouteItinerary to console"]');
        await expect(debugButtons).toHaveCount(0);
    });
});

// ─── Settings UI ─────────────────────────────────────────────────────────────

test.describe("Debug mode settings UI", () => {
    test("Entwickler section exists in settings panel", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        await openSettings(page);

        await expect(page.locator("text=Entwickler")).toBeVisible();
        await expect(page.locator("text=Debug-Modus")).toBeVisible();
        await expect(page.locator("text=Zeigt Konsolenausgabe-Buttons")).toBeVisible();
    });

    test("debug mode toggle switch works", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        await disableDebugMode(page);

        // Toggle on
        await toggleDebugMode(page);
        await expect(page.locator("#debug-mode")).toHaveAttribute("data-state", "checked");

        // Toggle off
        await toggleDebugMode(page);
        await expect(page.locator("#debug-mode")).toHaveAttribute("data-state", "unchecked");
    });
});

// ─── Dev-only window.map exposure ──────────────────────────────────────────

test.describe("window.map dev-only exposure", () => {
    test("window.map is available in dev mode for E2E test access", async ({ page }) => {
        await page.goto("/");
        // Wait for map initialization
        const hasMap = await page.waitForFunction(
            () => (window as any).map !== undefined,
            { timeout: 10000 },
        ).then(() => true).catch(() => false);

        expect(hasMap, "window.map must be exposed in dev mode — E2E tests depend on it").toBe(true);
    });

    test("window.map exposes queryRenderedFeatures for layer inspection", async ({ page }) => {
        await page.goto("/#48.36530,10.89436,18.53,30,0");
        await page.waitForFunction(() => (window as any).map);
        await page.waitForTimeout(2000);

        const hasQueryMethod = await page.evaluate(() => {
            const map = (window as any).map;
            return typeof map?.queryRenderedFeatures === "function";
        });
        expect(hasQueryMethod, "window.map.queryRenderedFeatures must be a function").toBe(true);
    });
});
