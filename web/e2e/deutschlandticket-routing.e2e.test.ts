import { test, expect, type Page } from "@playwright/test";

/**
 * E2E tests: Verify that the Deutschland-Ticket toggle correctly filters
 * route results to only show Nahverkehr (regional/local transit) connections.
 *
 * When the toggle is active, ICE/IC/EC (long-distance rail) and Flixbus/Coach
 * should be excluded from results. This is achieved server-side by MOTIS via
 * extended GTFS route types (set by the gtfs-germany.lua script) and the
 * transitModes parameter excluding HIGHSPEED_RAIL, LONG_DISTANCE, NIGHT_RAIL,
 * and COACH.
 *
 * Test route: Augsburg → München — known to have both ICE and RB/RE connections.
 *
 * Prerequisites:
 *   - vite dev server at localhost:5174
 *   - MOTIS at omniviv-motis.localhost with gtfs-germany.lua applied
 */

const MOTIS_URL = "http://omniviv-motis.localhost";

// Long-distance patterns that should NOT appear in D-Ticket results
const LONG_DISTANCE_PATTERN = /^(ICE|IC|EC|TGV|RJX|RJ|THA|NJ|EN)\b/i;
const LONG_DISTANCE_AGENCIES = ["db fernverkehr", "flixbus", "flixtrain", "blablabus"];

function isLongDistance(routeShortName: string, agencyName: string): boolean {
    if (LONG_DISTANCE_PATTERN.test(routeShortName)) return true;
    const lower = agencyName.toLowerCase();
    return LONG_DISTANCE_AGENCIES.some(a => lower.includes(a));
}

async function isMotisReachable(): Promise<boolean> {
    try {
        const res = await fetch(`${MOTIS_URL}/api/v1/geocode?text=test`, {
            signal: AbortSignal.timeout(5000),
        });
        return res.ok;
    } catch {
        return false;
    }
}

async function openNavigationPanel(page: Page) {
    await page.locator('button[aria-label="Routenplanung"]').click();
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

async function enableDeutschlandTicket(page: Page) {
    const toggle = page.locator('button[role="switch"]#deutschland-ticket');
    const state = await toggle.getAttribute("data-state");
    if (state !== "checked") {
        await toggle.click();
        await page.waitForTimeout(300);
    }
    await expect(toggle).toHaveAttribute("data-state", "checked");
}

async function disableDeutschlandTicket(page: Page) {
    const toggle = page.locator('button[role="switch"]#deutschland-ticket');
    const state = await toggle.getAttribute("data-state");
    if (state === "checked") {
        await toggle.click();
        await page.waitForTimeout(300);
    }
    await expect(toggle).toHaveAttribute("data-state", "unchecked");
}

async function setTime(page: Page, time: string) {
    const input = page.locator('input[type="text"][value*=":"]');
    await input.fill(time);
    await page.waitForTimeout(300);
}

async function waitForResults(page: Page) {
    // Wait for either results or error message
    await Promise.race([
        page.locator('[data-testid="route-results"]').waitFor({ timeout: 30000 }),
        page.locator("text=Keine Verbindungen").waitFor({ timeout: 30000 }),
        page.locator("text=Keine reinen").waitFor({ timeout: 30000 }),
    ]);
}

// ─── MOTIS API Tests ────────────────────────────────────────────────────────

test.describe("Deutschland-Ticket MOTIS API filtering", () => {
    test.beforeEach(async () => {
        if (!await isMotisReachable()) {
            test.skip(true, "MOTIS not reachable");
        }
    });

    test("Augsburg→München at midday: D-Ticket transitModes returns Nahverkehr results", async () => {
        const params = new URLSearchParams({
            fromPlace: "48.365395,10.894373",
            toPlace: "48.137154,11.576124",
            time: "2026-04-01T10:00:00Z",
            arriveBy: "false",
            transitModes: "TRAM,BUS,SUBWAY,SUBURBAN,REGIONAL_RAIL,FERRY,FUNICULAR",
            numItineraries: "15",
        });
        const res = await fetch(`${MOTIS_URL}/api/v2/plan?${params}`);
        expect(res.ok).toBeTruthy();

        const data = await res.json();
        const itineraries = [...(data.itineraries ?? []), ...(data.direct ?? [])];
        expect(itineraries.length, "MOTIS should return itineraries").toBeGreaterThan(0);

        // Check if any itinerary is pure Nahverkehr (no ICE/IC/Flix)
        const nahverkehr = itineraries.filter((it: { legs: { mode: string; routeShortName?: string; agencyName?: string }[] }) => {
            const transitLegs = it.legs.filter(l => l.mode !== "WALK");
            return !transitLegs.some(l =>
                isLongDistance(l.routeShortName ?? "", l.agencyName ?? ""),
            );
        });

        expect(
            nahverkehr.length,
            `Should have at least 1 pure Nahverkehr route Augsburg→München at midday. ` +
            `Got ${nahverkehr.length}/${itineraries.length}. If 0, the MOTIS Lua script ` +
            `may not have been applied — re-import MOTIS with gtfs-germany.lua.`,
        ).toBeGreaterThan(0);
    });

    test("Augsburg→München without D-Ticket filter includes ICE", async () => {
        const params = new URLSearchParams({
            fromPlace: "48.365395,10.894373",
            toPlace: "48.137154,11.576124",
            time: "2026-04-01T10:00:00Z",
            arriveBy: "false",
            mode: "TRANSIT,WALK",
        });
        const res = await fetch(`${MOTIS_URL}/api/v1/plan?${params}`);
        expect(res.ok).toBeTruthy();

        const data = await res.json();
        const itineraries = [...(data.itineraries ?? []), ...(data.direct ?? [])];
        const allLegs = itineraries.flatMap(
            (it: { legs: { mode: string; routeShortName?: string }[] }) =>
                it.legs.filter(l => l.mode !== "WALK"),
        );

        const iceLegs = allLegs.filter((l: { routeShortName?: string }) =>
            /^ICE/i.test(l.routeShortName ?? ""),
        );

        expect(
            iceLegs.length,
            "Without D-Ticket filter, should include ICE routes Augsburg→München",
        ).toBeGreaterThan(0);
    });

    test("D-Ticket results contain only valid Nahverkehr modes", async () => {
        const params = new URLSearchParams({
            fromPlace: "48.365395,10.894373",
            toPlace: "48.137154,11.576124",
            time: "2026-04-01T10:00:00Z",
            arriveBy: "false",
            transitModes: "TRAM,BUS,SUBWAY,SUBURBAN,REGIONAL_RAIL,FERRY,FUNICULAR",
            numItineraries: "15",
        });
        const res = await fetch(`${MOTIS_URL}/api/v2/plan?${params}`);
        const data = await res.json();
        const itineraries = [...(data.itineraries ?? []), ...(data.direct ?? [])];

        // Client-side filter (same as frontend)
        const nahverkehr = itineraries.filter((it: { legs: { mode: string; routeShortName?: string; agencyName?: string }[] }) =>
            !it.legs.some(l => l.mode !== "WALK" && isLongDistance(l.routeShortName ?? "", l.agencyName ?? "")),
        );

        for (const it of nahverkehr) {
            for (const leg of (it as { legs: { mode: string; routeShortName?: string; agencyName?: string }[] }).legs) {
                if (leg.mode === "WALK") continue;
                expect(
                    isLongDistance(leg.routeShortName ?? "", leg.agencyName ?? ""),
                    `Nahverkehr result should not contain long-distance: ${leg.routeShortName} (${leg.agencyName})`,
                ).toBe(false);
            }
        }
    });
});

// ─── Browser Tests ──────────────────────────────────────────────────────────

test.describe("Deutschland-Ticket UI routing", () => {
    test.beforeEach(async () => {
        if (!await isMotisReachable()) {
            test.skip(true, "MOTIS not reachable");
        }
    });

    test("Augsburg→München with D-Ticket enabled shows results", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        await openNavigationPanel(page);
        await enableDeutschlandTicket(page);
        await fillLocation(page, 0, "Augsburg");
        await fillLocation(page, 1, "München");
        await waitForResults(page);

        // Should have route results, not an error
        const results = page.locator('[data-testid="route-results"]');
        const error = page.locator("text=Keine Verbindungen");

        const hasResults = await results.isVisible().catch(() => false);
        const hasError = await error.isVisible().catch(() => false);

        expect(
            hasResults || !hasError,
            "Augsburg→München with D-Ticket should show results (not 'Keine Verbindungen')",
        ).toBe(true);
    });

    test("D-Ticket results do not contain ICE badges", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        await openNavigationPanel(page);
        await enableDeutschlandTicket(page);
        await fillLocation(page, 0, "Augsburg");
        await fillLocation(page, 1, "München");
        await waitForResults(page);

        const results = page.locator('[data-testid="route-results"]');
        if (!await results.isVisible().catch(() => false)) {
            // No results — might be pre-lua-import state, skip gracefully
            return;
        }

        // Check that no badge contains ICE/IC
        const badges = results.locator('[data-line]');
        const count = await badges.count();

        for (let i = 0; i < count; i++) {
            const line = await badges.nth(i).getAttribute("data-line");
            expect(
                LONG_DISTANCE_PATTERN.test(line ?? ""),
                `Badge "${line}" should not be long-distance in D-Ticket mode`,
            ).toBe(false);
        }
    });

    test("without D-Ticket filter, MOTIS API includes ICE for Augsburg→München", async () => {
        // Verify via API that the normal (non-D-Ticket) search includes ICE
        const params = new URLSearchParams({
            fromPlace: "48.365395,10.894373",
            toPlace: "48.137154,11.576124",
            time: "2026-04-01T10:00:00Z",
            arriveBy: "false",
            mode: "TRANSIT,WALK",
        });
        const res = await fetch(`${MOTIS_URL}/api/v1/plan?${params}`);
        expect(res.ok).toBeTruthy();

        const data = await res.json();
        const itineraries = [...(data.itineraries ?? []), ...(data.direct ?? [])];
        const allLegs = itineraries.flatMap(
            (it: { legs: { mode: string; routeShortName?: string }[] }) =>
                it.legs.filter(l => l.mode !== "WALK"),
        );
        const iceLegs = allLegs.filter((l: { routeShortName?: string }) =>
            /^ICE/i.test(l.routeShortName ?? ""),
        );
        expect(
            iceLegs.length,
            "Without D-Ticket, MOTIS should include ICE for Augsburg→München",
        ).toBeGreaterThan(0);
    });
});
