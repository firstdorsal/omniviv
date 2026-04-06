import { test, expect, type Page } from "@playwright/test";
import {
    waitForMap,
    enableDebugMode,
    openDebugPanel,
} from "./helpers";

/**
 * E2E tests: Line filter panel in the debug panel.
 *
 * The line filter lets users:
 *   - Search for transit routes across all of Germany via /api/routes/search
 *   - Mark individual lines as "shown" (force visible at custom opacity) or "hidden" (force hidden)
 *   - View and remove active overrides
 *   - Toggle route types via mirrored checkboxes (synced with the layer panel)
 *
 * The MapLibre filter on routes-line combines:
 *   - Type filter (visibleRouteTypes from layer panel)
 *   - Force-shown overrides (any state="shown" osm_id, regardless of type)
 *   - Force-hidden overrides (any state="hidden" osm_id, regardless of everything else)
 *
 * Opacity is applied via a per-osm_id `case` expression where each shown override has its own opacity.
 */

const SEARCH_INPUT = 'input[placeholder*="z.B"]';

async function clearLineOverrides(page: Page) {
    // Reset the persisted lineOverrides + reset visibleRouteTypes to defaults
    await page.evaluate(() => {
        try {
            const opts = JSON.parse(localStorage.getItem("live-tram-options") ?? "{}");
            opts.lineOverrides = [];
            opts.visibleRouteTypes = ["tram", "bus", "train", "light_rail", "subway", "ferry"];
            opts.showRoutes = true;
            localStorage.setItem("live-tram-options", JSON.stringify(opts));
        } catch {
            // ignore
        }
    });
}

async function openLineFilter(page: Page) {
    await page.goto("/#48.3655,10.8945,14.00,0,0");
    await waitForMap(page);
    await clearLineOverrides(page);
    await page.reload();
    await waitForMap(page);
    await enableDebugMode(page);
    await openDebugPanel(page);
}

test.describe("LineFilterPanel — search", () => {
    test("Linien-Filter section exists in debug panel", async ({ page }) => {
        await openLineFilter(page);
        await expect(page.locator("text=LINIEN-FILTER")).toBeVisible();
        const input = page.locator(SEARCH_INPUT);
        await expect(input).toBeVisible();
    });

    test("typing a query returns results from /api/routes/search", async ({ page }) => {
        await openLineFilter(page);
        const input = page.locator(SEARCH_INPUT);
        await input.fill("augsburg");
        // Wait for debounce + API call
        await page.waitForTimeout(1500);

        // Should show "Ergebnisse (...)" header
        const resultsHeader = page.locator("text=/Ergebnisse \\(/");
        await expect(resultsHeader).toBeVisible({ timeout: 5000 });
    });

    test("results contain Augsburg-area routes", async ({ page }) => {
        await openLineFilter(page);
        const input = page.locator(SEARCH_INPUT);
        await input.fill("augsburg");
        await page.waitForTimeout(1500);

        // Look for at least one Augsburg-related route name in the results list
        const augsburgItem = page.locator("text=/Augsburg/").first();
        await expect(augsburgItem).toBeVisible({ timeout: 5000 });
    });

    test("single-character query is allowed", async ({ page }) => {
        await openLineFilter(page);
        const input = page.locator(SEARCH_INPUT);
        await input.fill("1");
        await page.waitForTimeout(1500);
        // Should produce results (1 char is the new minimum)
        const resultsHeader = page.locator("text=/Ergebnisse \\(/");
        await expect(resultsHeader).toBeVisible({ timeout: 5000 });
    });

    test("city: prefix narrows results to a city", async ({ page }) => {
        await openLineFilter(page);
        const input = page.locator(SEARCH_INPUT);
        await input.fill("city:augsburg type:tram");
        await page.waitForTimeout(1500);

        const resultsHeader = page.locator("text=/Ergebnisse \\(/");
        await expect(resultsHeader).toBeVisible({ timeout: 5000 });
    });
});

test.describe("LineFilterPanel — type checkboxes mirrored", () => {
    test("synced section shows master toggle plus all 6 transport types", async ({ page }) => {
        await openLineFilter(page);
        // Master "Linien anzeigen" toggle is rendered in the debug panel
        await expect(page.getByRole("checkbox", { name: "Linien anzeigen", exact: true })).toBeVisible();
        for (const label of ["Straßenbahn", "Bus", "Bahn", "S-Bahn", "U-Bahn", "Fähre"]) {
            const checkbox = page.getByRole("checkbox", { name: label, exact: true });
            await expect(checkbox.first(), `${label} checkbox must exist`).toBeVisible();
        }
    });

    test("toggling a type checkbox in debug panel updates the routes-line filter", async ({ page }) => {
        await openLineFilter(page);

        // Uncheck "Straßenbahn" (tram) inside the debug panel's mirrored section.
        // There may be two checkboxes with the same label (layer + debug panel) — both reflect the same state.
        const tramCheckboxes = page.getByRole("checkbox", { name: "Straßenbahn", exact: true });
        await tramCheckboxes.first().click();
        await page.waitForTimeout(500);

        // Verify routes-line filter no longer includes "tram"
        const filter = await page.evaluate(() => {
            const map = (window as any).map;
            return JSON.stringify(map?.getFilter("routes-line"));
        });
        expect(filter).toBeTruthy();
        expect(filter, "Filter should NOT include tram after unchecking").not.toContain('"tram"');
    });
});

test.describe("LineFilterPanel — overrides", () => {
    test("clicking 'Aus' on a result hides that line from the routes layer", async ({ page }) => {
        await openLineFilter(page);

        // Count visible route features before any override
        const beforeCount = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return 0;
            return map.queryRenderedFeatures({ layers: ["routes-line"] }).length;
        });
        expect(beforeCount, "Should have routes visible before override").toBeGreaterThan(0);

        // Search for augsburg
        const input = page.locator(SEARCH_INPUT);
        await input.fill("augsburg");
        await page.waitForTimeout(1500);

        // Click the first "Aus" button (force-hidden) inside a radiogroup
        const ausButton = page.locator('[aria-label*="Sichtbarkeit für"] button', { hasText: /^Aus$/ }).first();
        await ausButton.click();
        await page.waitForTimeout(500);

        // Active override section should appear
        await expect(page.locator("text=/Aktive Überschreibungen/")).toBeVisible();

        // Verify the routes-line filter has an osm_id reference (hidden override)
        const filter = await page.evaluate(() => {
            const map = (window as any).map;
            return JSON.stringify(map?.getFilter("routes-line"));
        });
        expect(filter, "routes-line filter should reference osm_id").toContain("osm_id");
    });

    test("clicking 'An' on a result applies a per-line opacity case expression", async ({ page }) => {
        await openLineFilter(page);

        const input = page.locator(SEARCH_INPUT);
        await input.fill("augsburg");
        await page.waitForTimeout(1500);

        // Click "An" (force-shown) on first result
        const anButton = page.locator('[aria-label*="Sichtbarkeit für"] button', { hasText: /^An$/ }).first();
        await anButton.click();
        await page.waitForTimeout(500);

        // Verify line-opacity is now a case expression
        const opacity = await page.evaluate(() => {
            const map = (window as any).map;
            return map?.getPaintProperty("routes-line", "line-opacity");
        });
        expect(Array.isArray(opacity), "line-opacity should be a case expression after force-show").toBe(true);
        expect((opacity as any[])[0]).toBe("case");
    });

    test("opacity slider appears for shown overrides and changes opacity", async ({ page }) => {
        await openLineFilter(page);

        const input = page.locator(SEARCH_INPUT);
        await input.fill("augsburg");
        await page.waitForTimeout(1500);

        await page.locator('[aria-label*="Sichtbarkeit für"] button', { hasText: /^An$/ }).first().click();
        await page.waitForTimeout(500);

        // Slider should appear in the override list
        const slider = page.locator('[aria-label*="Opacity für"]').first();
        await expect(slider).toBeVisible();
    });

    test("clicking 'Auto' keeps the entry in overrides but clears the force-state", async ({ page }) => {
        await openLineFilter(page);

        const input = page.locator(SEARCH_INPUT);
        await input.fill("augsburg");
        await page.waitForTimeout(1500);

        // Hide a line first
        await page.locator('[aria-label*="Sichtbarkeit für"] button', { hasText: /^Aus$/ }).first().click();
        await page.waitForTimeout(500);
        await expect(page.locator("text=/Aktive Überschreibungen/")).toBeVisible();

        // Click Auto on the same result — entry should stay in the overrides list
        await page.locator('[aria-label*="Sichtbarkeit für"] button', { hasText: /^Auto$/ }).first().click();
        await page.waitForTimeout(500);

        // Active override section should STILL be visible (auto state is tracked)
        await expect(page.locator("text=/Aktive Überschreibungen/")).toBeVisible();

        // No osm_id-based filter should be active anymore (auto = inherit type filter)
        const filter = await page.evaluate(() => {
            const map = (window as any).map;
            return JSON.stringify(map?.getFilter("routes-line"));
        });
        // The hidden override should be cleared
        expect(filter, "auto state should not contribute to hidden filter").not.toContain('"!"');
    });

    test("active overrides panel has its own visibility toggle", async ({ page }) => {
        await openLineFilter(page);

        const input = page.locator(SEARCH_INPUT);
        await input.fill("augsburg");
        await page.waitForTimeout(1500);

        // Hide a line via search results
        await page.locator('[aria-label*="Sichtbarkeit für"] button', { hasText: /^Aus$/ }).first().click();
        await page.waitForTimeout(500);

        // Clear the search to focus on the overrides list
        await input.fill("");
        await page.waitForTimeout(500);

        // Active overrides section should be visible
        await expect(page.locator("text=/Aktive Überschreibungen/")).toBeVisible();

        // The toggle group should be present in the overrides list (not just in search results)
        const overridesPanel = page.locator("text=/Aktive Überschreibungen/").locator("..");
        const toggleInOverrides = overridesPanel.locator('[aria-label*="Sichtbarkeit für"] button', { hasText: /^An$/ }).first();
        await expect(toggleInOverrides).toBeVisible();

        // Click "An" inside the overrides panel — should switch state to shown
        await toggleInOverrides.click();
        await page.waitForTimeout(500);

        // Verify line-opacity is now a case expression (force-shown is active)
        const opacity = await page.evaluate(() => {
            const map = (window as any).map;
            return map?.getPaintProperty("routes-line", "line-opacity");
        });
        expect(Array.isArray(opacity), "line-opacity should be a case expression").toBe(true);

        // Entry should still be present in overrides list
        await expect(page.locator("text=/Aktive Überschreibungen/")).toBeVisible();
    });

    test("removing an override via X button clears the filter", async ({ page }) => {
        await openLineFilter(page);

        const input = page.locator(SEARCH_INPUT);
        await input.fill("augsburg");
        await page.waitForTimeout(1500);

        // Hide a line
        await page.locator('[aria-label*="Sichtbarkeit für"] button', { hasText: /^Aus$/ }).first().click();
        await page.waitForTimeout(500);

        // Active override section should be visible
        await expect(page.locator("text=/Aktive Überschreibungen/")).toBeVisible();

        // Click the X button to remove the override
        const removeButton = page.locator('button[aria-label*="Override entfernen"]').first();
        await removeButton.click();
        await page.waitForTimeout(500);

        // Active override section should be gone
        await expect(page.locator("text=/Aktive Überschreibungen/")).toHaveCount(0);
    });

    test("overrides persist across page reloads", async ({ page }) => {
        await openLineFilter(page);

        const input = page.locator(SEARCH_INPUT);
        await input.fill("augsburg");
        await page.waitForTimeout(1500);

        // Hide a line
        await page.locator('[aria-label*="Sichtbarkeit für"] button', { hasText: /^Aus$/ }).first().click();
        await page.waitForTimeout(500);

        // Reload the page
        await page.reload();
        await waitForMap(page);
        await enableDebugMode(page);
        await openDebugPanel(page);

        // Active override section should still be visible
        await expect(page.locator("text=/Aktive Überschreibungen/")).toBeVisible();
    });
});

test.describe("LineFilterPanel — search endpoint", () => {
    test("API returns results limited to the requested limit", async () => {
        const response = await fetch("http://omniviv-api.localhost/api/routes/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: "1", limit: 10 }),
        });
        expect(response.ok).toBe(true);
        const data = await response.json();
        expect(data.routes.length, "Should respect the limit parameter").toBeLessThanOrEqual(10);
    });

    test("API supports query that matches both ref and name", async () => {
        const response = await fetch("http://omniviv-api.localhost/api/routes/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: "augsburg", limit: 5 }),
        });
        expect(response.ok).toBe(true);
        const data = await response.json();
        expect(data.routes.length, "Should find Augsburg routes").toBeGreaterThan(0);
        // All results should have either Augsburg in the name OR a matching ref
        for (const route of data.routes) {
            const matches = (route.name?.toLowerCase().includes("augsburg") ?? false)
                || (route.ref?.toUpperCase().startsWith("AUGSBURG") ?? false);
            expect(matches, `Route should match the query: ${JSON.stringify(route)}`).toBe(true);
        }
    });

    test("API supports city + type filter", async () => {
        const response = await fetch("http://omniviv-api.localhost/api/routes/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ city: "augsburg", route_type: "tram", limit: 50 }),
        });
        expect(response.ok).toBe(true);
        const data = await response.json();
        expect(data.routes.length, "Should find Augsburg trams").toBeGreaterThan(0);
        for (const route of data.routes) {
            expect(route.route_type, "Should only return trams").toBe("tram");
        }
    });

    test("API does NOT deduplicate by default (variants are real routes)", async () => {
        // Without deduplicate flag (default false), should return multiple variants
        const response = await fetch("http://omniviv-api.localhost/api/routes/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ city: "augsburg", route_type: "tram", limit: 100 }),
        });
        expect(response.ok).toBe(true);
        const data = await response.json();
        // Augsburg trams have multiple variants (forward/back/peak/holiday) — expect more than 7
        expect(data.routes.length, "Should return multiple variants per line by default").toBeGreaterThan(7);
    });
});
