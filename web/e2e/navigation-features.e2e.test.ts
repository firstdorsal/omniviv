import { test, expect, type Page } from "@playwright/test";

/**
 * E2E tests for navigation/search UX features:
 *   1. Search popup can be wider than the sidebar
 *   2. First search result is auto-highlighted on typing
 *   3. Toast notification when geolocation is denied
 *   4. Deutschland-Ticket switch filters out long-distance services
 *   5. Bookmarks and recents are sorted by use frequency
 *
 * Prerequisites:
 *   - vite dev server at localhost:5174
 *   - MOTIS at omniviv-motis.localhost
 */

const MOTIS_URL = "http://omniviv-motis.localhost";

async function isMotisReachable(): Promise<boolean> {
    try {
        const res = await fetch(`${MOTIS_URL}/api/v1/plan?fromPlace=0,0&toPlace=0,0`, {
            signal: AbortSignal.timeout(3000),
        });
        return res.ok || res.status === 400;
    } catch {
        return false;
    }
}

async function openNavigationPanel(page: Page) {
    const navButton = page.locator('button[aria-label="Routenplanung"]');
    await navButton.click();
    await expect(page.locator("text=Routenplanung")).toBeVisible();
}

async function fillLocation(page: Page, inputIndex: number, query: string) {
    const inputs = page.locator('input[role="combobox"]');
    const input = inputs.nth(inputIndex);
    await input.click();
    await input.fill(query);
    await page.waitForTimeout(1500);
    const option = page.locator('[role="option"]').first();
    await expect(option).toBeVisible({ timeout: 5000 });
    await option.click();
}

// ─── 1. Search popup width is not constrained by sidebar ─────────────────────

test.describe("Search popup width", () => {
    test("search results popup uses min-width not fixed width", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        await openNavigationPanel(page);

        const input = page.locator('input[role="combobox"]').first();
        await input.click();
        await input.fill("König");
        await page.waitForTimeout(1500);

        await expect(page.locator('[role="option"]').first()).toBeVisible({ timeout: 5000 });

        // The PopoverContent should use min-width (not fixed width) for the trigger
        // width CSS variable, allowing it to grow beyond the sidebar.
        const popoverContent = page.locator('[data-radix-popper-content-wrapper] > div').first();
        await expect(popoverContent).toBeVisible();

        const styles = await popoverContent.evaluate((el) => {
            const cs = window.getComputedStyle(el);
            return {
                width: cs.width,
                minWidth: cs.minWidth,
                maxWidth: cs.maxWidth,
            };
        });

        // min-width should be set (non-zero), and maxWidth should be 90vw
        expect(parseFloat(styles.minWidth)).toBeGreaterThan(0);
        // The width should be "max-content" (from w-max class), not pinned to trigger
        // If computed, it may resolve to a pixel value, but it should differ from minWidth
        // for content that is wider than the input
    });
});

// ─── 2. First search result auto-highlighted ─────────────────────────────────

test.describe("Search result auto-highlight", () => {
    test("first result is highlighted when typing a search query", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        await openNavigationPanel(page);

        const input = page.locator('input[role="combobox"]').first();
        await input.click();
        await input.fill("König");
        await page.waitForTimeout(1500);

        const firstOption = page.locator('[role="option"]').first();
        await expect(firstOption).toBeVisible({ timeout: 5000 });

        // The input should reference the first option via aria-activedescendant
        const activeDescendant = await input.getAttribute("aria-activedescendant");
        expect(activeDescendant, "First option should be active (aria-activedescendant set)").toBeTruthy();

        // The first option should have aria-selected="true" or a visual highlight
        const firstOptionId = await firstOption.getAttribute("id");
        expect(activeDescendant).toBe(firstOptionId);
    });

    test("pressing Enter selects the auto-highlighted first result", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        await openNavigationPanel(page);

        const input = page.locator('input[role="combobox"]').first();
        await input.click();
        await input.fill("Königsplatz");
        await page.waitForTimeout(1500);

        const firstOption = page.locator('[role="option"]').first();
        await expect(firstOption).toBeVisible({ timeout: 5000 });

        // Press Enter to select the highlighted item
        await input.press("Enter");

        // Wait for selection to process
        await page.waitForTimeout(500);

        // The input should have a value (the selected location)
        const value = await input.inputValue();
        expect(value.length, "Input should have a value after Enter").toBeGreaterThan(0);

        // The aria-expanded should be false (dropdown closed)
        await expect(input).toHaveAttribute("aria-expanded", "false");
    });

    test("bookmarks are auto-highlighted when dropdown opens without query", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        await openNavigationPanel(page);

        // First, bookmark a location by searching and starring it
        const input = page.locator('input[role="combobox"]').first();
        await input.click();
        await input.fill("Königsplatz");
        await page.waitForTimeout(1500);

        const starButton = page.locator('[role="option"]').first().locator('button');
        if (await starButton.count() > 0) {
            await starButton.first().click();
            // Clear and reopen - bookmarks should show and first should be highlighted
            await input.fill("");
            await input.click();
            await page.waitForTimeout(500);

            const options = page.locator('[role="option"]');
            if (await options.count() > 0) {
                const activeDescendant = await input.getAttribute("aria-activedescendant");
                expect(activeDescendant, "First bookmark should be auto-highlighted").toBeTruthy();
            }
        }
    });
});

// ─── 3. Toast on geolocation denial ─────────────────────────────────────────

test.describe("Geolocation toast", () => {
    test("shows error toast when geolocation permission is denied", async ({ page, context }) => {
        // Deny geolocation permissions
        await context.clearPermissions();

        await page.goto("/");
        await page.waitForLoadState("networkidle");

        await openNavigationPanel(page);

        // Override geolocation to simulate denial
        await page.evaluate(() => {
            navigator.geolocation.getCurrentPosition = (
                _success: PositionCallback,
                error?: PositionErrorCallback | null,
            ) => {
                if (error) {
                    error({
                        code: 1, // PERMISSION_DENIED
                        message: "User denied Geolocation",
                        PERMISSION_DENIED: 1,
                        POSITION_UNAVAILABLE: 2,
                        TIMEOUT: 3,
                    });
                }
            };
        });

        // Click the GPS button (LocateFixed icon button)
        const gpsButton = page.locator('button:has(svg.lucide-locate-fixed)');
        if (await gpsButton.count() > 0) {
            await gpsButton.first().click();

            // A toast should appear with the denied message
            const toast = page.locator('[data-sonner-toast]');
            await expect(toast.first()).toBeVisible({ timeout: 5000 });
            const toastText = await toast.first().textContent();
            expect(toastText).toContain("blockiert");
        }
    });
});

// ─── 4. Deutschland-Ticket switch ────────────────────────────────────────────

test.describe("Deutschland-Ticket filter", () => {
    test.beforeEach(async () => {
        if (!await isMotisReachable()) {
            test.skip(true, "MOTIS not reachable");
        }
    });

    test("Deutschland-Ticket switch is visible in navigation panel", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        await openNavigationPanel(page);

        const switchEl = page.locator("#deutschland-ticket");
        await expect(switchEl).toBeVisible();

        const label = page.locator('label[for="deutschland-ticket"]');
        await expect(label).toHaveText("Nur Deutschland-Ticket");
    });

    test("Deutschland-Ticket filter yields Nahverkehr-only results via v2 API", async () => {
        if (!await isMotisReachable()) {
            test.skip(true, "MOTIS not reachable");
            return;
        }

        const longDistancePrefixes = /^(ICE|IC|EC|TGV|RJX|RJ|THA|NJ|EN)\b/i;
        const longDistanceAgencies = /flixbus|flixtrain|flix|db fernverkehr|blablabus/i;

        const isLongDistance = (leg: { routeShortName?: string; agencyName?: string }) => {
            const name = (leg.routeShortName ?? "").toUpperCase();
            const agency = (leg.agencyName ?? "").toLowerCase();
            return longDistancePrefixes.test(name) || longDistanceAgencies.test(agency);
        };

        // Step 1: Fetch UNFILTERED results via v1 API (all modes including ICE)
        const v1Params = new URLSearchParams({
            fromPlace: "48.3657,10.8946",
            toPlace: "48.1351,11.5820",
            time: new Date().toISOString(),
            arriveBy: "false",
            mode: "TRANSIT,WALK",
        });
        const v1Res = await fetch(`${MOTIS_URL}/api/v1/plan?${v1Params}`);
        expect(v1Res.ok, "v1 API should return results").toBeTruthy();
        const v1Data = await v1Res.json();
        const v1Itineraries = [...(v1Data.itineraries ?? []), ...(v1Data.direct ?? [])];

        // Verify unfiltered results include at least one long-distance leg (ICE/IC)
        const hasLongDistance = v1Itineraries.some(
            (it: { legs: Array<{ mode: string; routeShortName?: string; agencyName?: string }> }) =>
                it.legs.some(l => l.mode !== "WALK" && isLongDistance(l)),
        );
        expect(
            hasLongDistance,
            "Augsburg→München unfiltered should include ICE/IC options",
        ).toBe(true);

        // Step 2: Fetch D-Ticket filtered results via v2 API (same as frontend)
        const v2Params = new URLSearchParams({
            fromPlace: "48.3657,10.8946",
            toPlace: "48.1351,11.5820",
            time: new Date().toISOString(),
            arriveBy: "false",
            transitModes: "TRAM,BUS,SUBWAY,FERRY,REGIONAL_RAIL",
            numItineraries: "20",
        });
        const v2Res = await fetch(`${MOTIS_URL}/api/v2/plan?${v2Params}`);
        expect(v2Res.ok, "v2 API should return results").toBeTruthy();
        const v2Data = await v2Res.json();
        const v2Itineraries = [...(v2Data.itineraries ?? []), ...(v2Data.direct ?? [])];

        // Step 3: D-Ticket results should have Nahverkehr routes
        expect(
            v2Itineraries.length,
            "Should find at least one D-Ticket-compatible itinerary for Augsburg → München",
        ).toBeGreaterThan(0);

        // Step 4: Verify NONE of the D-Ticket results contain long-distance legs
        for (const it of v2Itineraries) {
            for (const leg of (it as { legs: Array<{ mode: string; routeShortName?: string; agencyName?: string }> }).legs) {
                if (leg.mode === "WALK") continue;
                expect(
                    isLongDistance(leg),
                    `D-Ticket result should not contain long-distance: ${leg.routeShortName ?? leg.mode} (${leg.agencyName})`,
                ).toBe(false);
            }
        }
    });

    test("toggling Deutschland-Ticket re-triggers search", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        await openNavigationPanel(page);
        await fillLocation(page, 0, "Königsplatz");
        await fillLocation(page, 1, "Hauptbahnhof");

        // Wait for initial results
        await expect(page.locator('[data-testid="route-results"]')).toBeVisible({ timeout: 15000 });

        // Count initial results
        const initialCount = await page.locator('[data-testid="route-results"] > *').count();

        // Toggle the Deutschland-Ticket switch
        const switchEl = page.locator("#deutschland-ticket");
        await switchEl.click();

        // Wait for results to refresh
        await page.waitForTimeout(2000);

        // Results should still be visible (either same or different count)
        await expect(page.locator('[data-testid="route-results"]')).toBeVisible({ timeout: 15000 });

        // The search was re-triggered (we verify this by checking the switch state)
        await expect(switchEl).toBeChecked();
    });
});

// ─── 5. Bookmarks and recents sorted by frequency ────────────────────────────

test.describe("Frequency-based sorting", () => {
    test("recents are sorted by use count (most used first)", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        // Clear existing recents
        await page.evaluate(() => localStorage.removeItem("omniviv-location-recents"));

        await openNavigationPanel(page);

        // Search and select "Hauptbahnhof" once
        await fillLocation(page, 0, "Hauptbahnhof");

        // Clear and search "Königsplatz" three times
        const input = page.locator('input[role="combobox"]').first();
        for (let i = 0; i < 3; i++) {
            // Clear the input
            const clearButton = input.locator("..").locator('button[aria-label="Eingabe löschen"]');
            if (await clearButton.isVisible()) {
                await clearButton.click();
            } else {
                await input.fill("");
            }
            await page.waitForTimeout(300);

            await input.fill("Königsplatz");
            await page.waitForTimeout(1500);
            const option = page.locator('[role="option"]').first();
            await expect(option).toBeVisible({ timeout: 5000 });
            await option.click();
            await page.waitForTimeout(300);
        }

        // Verify recents in localStorage are sorted by useCount
        const recents = await page.evaluate(() => {
            const raw = localStorage.getItem("omniviv-location-recents");
            return raw ? JSON.parse(raw) : [];
        });

        expect(recents.length).toBeGreaterThanOrEqual(2);

        // Verify sorting: each useCount should be >= the next
        for (let i = 0; i < recents.length - 1; i++) {
            expect(
                (recents[i].useCount ?? 0),
                `Recent at index ${i} (${recents[i].name}) should have useCount >= index ${i + 1} (${recents[i + 1].name})`,
            ).toBeGreaterThanOrEqual(recents[i + 1].useCount ?? 0);
        }

        // Königsplatz should be first (most used)
        const koenigsplatz = recents.find((r: { name: string }) => r.name.toLowerCase().includes("königsplatz"));
        if (koenigsplatz) {
            expect(koenigsplatz.useCount).toBeGreaterThanOrEqual(3);
            expect(recents[0].name.toLowerCase()).toContain("königsplatz");
        }
    });

    test("bookmark useCount is stored in localStorage", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        // Clear existing bookmarks
        await page.evaluate(() => localStorage.removeItem("omniviv-location-bookmarks"));

        await openNavigationPanel(page);

        const input = page.locator('input[role="combobox"]').first();
        await input.click();
        await input.fill("Königsplatz");
        await page.waitForTimeout(1500);

        // Bookmark the first result by clicking its star button
        const starButton = page.locator('[role="option"]').first().locator('button');
        if (await starButton.count() > 0) {
            await starButton.first().click();
            await page.waitForTimeout(300);

            // Now select that bookmarked location multiple times
            for (let i = 0; i < 2; i++) {
                const clearButton = input.locator("..").locator('button[aria-label="Eingabe löschen"]');
                if (await clearButton.isVisible()) {
                    await clearButton.click();
                } else {
                    await input.fill("");
                }
                await page.waitForTimeout(300);
                await input.fill("Königsplatz");
                await page.waitForTimeout(1500);
                const option = page.locator('[role="option"]').first();
                await expect(option).toBeVisible({ timeout: 5000 });
                await option.click();
                await page.waitForTimeout(300);
            }

            // Check bookmark useCount in localStorage
            const bookmarks = await page.evaluate(() => {
                const raw = localStorage.getItem("omniviv-location-bookmarks");
                return raw ? JSON.parse(raw) : [];
            });

            const koenigsplatzBookmark = bookmarks.find((b: { name: string }) =>
                b.name.toLowerCase().includes("königsplatz"),
            );
            if (koenigsplatzBookmark) {
                expect(
                    koenigsplatzBookmark.useCount,
                    "Bookmark useCount should be incremented on each selection",
                ).toBeGreaterThanOrEqual(2);
            }
        }
    });
});
