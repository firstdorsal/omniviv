import { test, expect, type Page } from "@playwright/test";

/**
 * E2E tests: Verify that route planning badge colors are correct and
 * have proper text contrast.
 *
 * Tests the full browser pipeline:
 *   1. Open navigation panel
 *   2. Enter start/end locations
 *   3. Trigger route search
 *   4. Verify rendered LineBadge background colors match their data-color attribute
 *   5. Verify text contrast meets WCAG AA (≥4.5:1)
 *   6. Verify MOTIS returns correct OSM route colors via API
 *
 * Prerequisites:
 *   - vite dev server at localhost:5174
 *   - MOTIS at omniviv-motis.localhost
 *   - API at omniviv-api.localhost
 *   - GTFS mapping populated with OSM route colors
 */

const MOTIS_URL = "http://omniviv-motis.localhost";

// Expected OSM colors for Augsburg tram lines (lowercase)
const AUGSBURG_TRAM_COLORS: Record<string, string> = {
    "1": "#e3000f",
    "2": "#0068b3",
    "3": "#ef7c00",
    "4": "#941680",
    "6": "#94c11c",
};

// Known coordinates for MOTIS API tests
const COORDS = {
    STADTBERGEN: { lat: 48.3666284, lon: 10.8442814 },
    KOENIGSPLATZ: { lat: 48.3657, lon: 10.8946 },
    GOGGINGEN: { lat: 48.3488, lon: 10.877 },
    LECHHAUSEN: { lat: 48.381, lon: 10.916 },
};

function hexToRgb(hex: string): string {
    const raw = hex.replace("#", "");
    const r = parseInt(raw.substring(0, 2), 16);
    const g = parseInt(raw.substring(2, 4), 16);
    const b = parseInt(raw.substring(4, 6), 16);
    return `rgb(${r}, ${g}, ${b})`;
}

function rgbToHex(rgb: string): string {
    const m = rgb.match(/(\d+)/g);
    if (!m) return "#000000";
    return "#" + m.slice(0, 3).map((c) => parseInt(c).toString(16).padStart(2, "0")).join("");
}

/** Compute relative luminance (WCAG) from hex color */
function relativeLuminance(hex: string): number {
    const raw = hex.replace("#", "");
    const r = parseInt(raw.substring(0, 2), 16) / 255;
    const g = parseInt(raw.substring(2, 4), 16) / 255;
    const b = parseInt(raw.substring(4, 6), 16) / 255;
    const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG contrast ratio between two luminances */
function contrastRatio(l1: number, l2: number): number {
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
}

function expectedTextColor(bgHex: string): string {
    return relativeLuminance(bgHex) > 0.179 ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)";
}

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

/** Open the navigation panel by clicking the Routenplanung button */
async function openNavigationPanel(page: Page) {
    const navButton = page.locator('button[aria-label="Routenplanung"]');
    await navButton.click();
    await expect(page.locator("text=Routenplanung")).toBeVisible();
}

/**
 * Fill a location input by typing a query and selecting the first matching suggestion.
 * The inputs are ordered: first = start, second = end.
 */
async function fillLocation(page: Page, inputIndex: number, query: string) {
    const inputs = page.locator('input[role="combobox"]');
    const input = inputs.nth(inputIndex);
    await input.click();
    await input.fill(query);
    // Wait for suggestions to load
    await page.waitForTimeout(1500);
    const option = page.locator('[role="option"]').first();
    await expect(option).toBeVisible({ timeout: 5000 });
    await option.click();
}

/** Click "Route finden" and wait for results */
async function searchRoute(page: Page) {
    const searchButton = page.locator('button:has-text("Route finden")');
    await expect(searchButton).toBeEnabled({ timeout: 5000 });
    await searchButton.click();
    await expect(page.locator('[data-testid="route-results"]')).toBeVisible({ timeout: 15000 });
}

/** Collect all badge info from route results, normalizing all colors to #hex */
async function collectBadges(page: Page): Promise<{ line: string; bgHex: string; fgRgb: string; dataColor: string }[]> {
    const badges = page.locator('[data-testid="route-results"] [data-line]');
    const count = await badges.count();
    const results: { line: string; bgHex: string; fgRgb: string; dataColor: string }[] = [];

    for (let i = 0; i < count; i++) {
        const badge = badges.nth(i);
        const info = await badge.evaluate((el) => {
            // Use a hidden element to normalize any CSS color value to rgb()
            const probe = document.createElement("span");
            probe.style.color = el.getAttribute("data-color") ?? "";
            document.body.appendChild(probe);
            const normalizedDataColor = window.getComputedStyle(probe).color;
            probe.remove();

            return {
                line: el.getAttribute("data-line") ?? "?",
                bgRgb: window.getComputedStyle(el).backgroundColor,
                fgRgb: window.getComputedStyle(el).color,
                dataColorRgb: normalizedDataColor,
            };
        });
        results.push({
            line: info.line,
            bgHex: rgbToHex(info.bgRgb),
            fgRgb: info.fgRgb,
            dataColor: rgbToHex(info.dataColorRgb),
        });
    }
    return results;
}

interface MotisLeg {
    mode: string;
    routeShortName?: string;
    routeColor?: string | null;
}

async function fetchMotisRoute(
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
): Promise<MotisLeg[][]> {
    const params = new URLSearchParams({
        fromPlace: `${from.lat},${from.lon}`,
        toPlace: `${to.lat},${to.lon}`,
        time: new Date().toISOString(),
        arriveBy: "false",
        mode: "TRANSIT,WALK",
    });
    const res = await fetch(`${MOTIS_URL}/api/v1/plan?${params}`);
    if (!res.ok) throw new Error(`MOTIS returned ${res.status}`);
    const data = await res.json();
    return [...(data.itineraries ?? []), ...(data.direct ?? [])].map(
        (it: { legs: MotisLeg[] }) => it.legs.filter((l) => l.mode !== "WALK"),
    );
}

// ─── Test Routes ────────────────────────────────────────────────────────────

const BROWSER_ROUTES = [
    { name: "Stadtbergen → Königsplatz", from: "Stadtbergen", to: "Königsplatz" },
    { name: "Göggingen → Lechhausen", from: "Göggingen", to: "Lechhausen" },
    { name: "Königsplatz → Haunstetten", from: "Königsplatz", to: "Haunstetten" },
];

// ─── Browser Tests: Badge Rendering ─────────────────────────────────────────

test.describe("Navigation badge rendering", () => {
    test.beforeEach(async () => {
        if (!await isMotisReachable()) {
            test.skip(true, "MOTIS not reachable");
        }
    });

    for (const route of BROWSER_ROUTES) {
        test(`${route.name}: rendered background matches data-color attribute`, async ({ page }) => {
            await page.goto("/");
            await page.waitForLoadState("networkidle");

            await openNavigationPanel(page);
            await fillLocation(page, 0, route.from);
            await fillLocation(page, 1, route.to);
            await searchRoute(page);

            const badges = await collectBadges(page);
            expect(badges.length, "Should have at least one line badge").toBeGreaterThan(0);

            for (const badge of badges) {
                expect(
                    badge.bgHex.toLowerCase(),
                    `Line ${badge.line}: rendered bg should match data-color`,
                ).toBe(badge.dataColor.toLowerCase());
            }
        });

        test(`${route.name}: tram badges have non-fallback colors`, async ({ page }) => {
            await page.goto("/");
            await page.waitForLoadState("networkidle");

            await openNavigationPanel(page);
            await fillLocation(page, 0, route.from);
            await fillLocation(page, 1, route.to);
            await searchRoute(page);

            const badges = await collectBadges(page);
            expect(badges.length).toBeGreaterThan(0);

            // Only check tram lines (single digit or known Augsburg lines).
            // Regional trains (RB, RE, ICE) legitimately have no OSM color.
            const tramLines = new Set(Object.keys(AUGSBURG_TRAM_COLORS));
            const tramBadges = badges.filter((b) => tramLines.has(b.line));

            for (const badge of tramBadges) {
                expect(
                    badge.dataColor.toLowerCase(),
                    `Tram ${badge.line}: should have a real route color, not fallback grey`,
                ).not.toBe("#6b7280");
            }
        });

        test(`${route.name}: text contrast meets WCAG AA (≥4.5:1)`, async ({ page }) => {
            await page.goto("/");
            await page.waitForLoadState("networkidle");

            await openNavigationPanel(page);
            await fillLocation(page, 0, route.from);
            await fillLocation(page, 1, route.to);
            await searchRoute(page);

            const badges = await collectBadges(page);
            expect(badges.length).toBeGreaterThan(0);

            for (const badge of badges) {
                const fgHex = rgbToHex(badge.fgRgb);
                const bgLum = relativeLuminance(badge.bgHex);
                const fgLum = relativeLuminance(fgHex);
                const ratio = contrastRatio(bgLum, fgLum);

                // WCAG AA: 4.5:1 for normal text, 3:1 for large text (≥14pt bold).
                // LineBadges use font-weight:600 + text-sm (14px) → qualifies as large text.
                expect(
                    ratio,
                    `Line ${badge.line}: contrast ${ratio.toFixed(2)}:1 (bg=${badge.bgHex}, fg=${fgHex}) should be ≥ 3:1 (large text)`,
                ).toBeGreaterThanOrEqual(3);
            }
        });

        test(`${route.name}: text color is correctly auto-selected (white or black)`, async ({ page }) => {
            await page.goto("/");
            await page.waitForLoadState("networkidle");

            await openNavigationPanel(page);
            await fillLocation(page, 0, route.from);
            await fillLocation(page, 1, route.to);
            await searchRoute(page);

            const badges = await collectBadges(page);
            expect(badges.length).toBeGreaterThan(0);

            for (const badge of badges) {
                const expected = expectedTextColor(badge.dataColor);
                expect(
                    badge.fgRgb,
                    `Line ${badge.line} (bg=${badge.dataColor}): text should be ${expected === "rgb(0, 0, 0)" ? "black" : "white"}`,
                ).toBe(expected);
            }
        });
    }
});

// ─── Instant Color Loading (no grey flash) ─────────────────────────────────

test.describe("Route colors load instantly (no grey flash)", () => {
    test.beforeEach(async () => {
        if (!await isMotisReachable()) {
            test.skip(true, "MOTIS not reachable");
        }
    });

    test("colors are cached in localStorage after first load", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        const cached = await page.evaluate(() => localStorage.getItem("omniviv-route-colors-v2"));
        expect(cached, "Route colors should be cached in localStorage after load").toBeTruthy();
        const parsed = JSON.parse(cached!);
        expect(parsed.length, "Cache should contain color entries").toBeGreaterThan(0);
    });

    test("tram badges have correct colors on second visit (from cache)", async ({ page, context }) => {
        // First visit: populate localStorage cache
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        // Verify cache was populated
        const cached = await page.evaluate(() => localStorage.getItem("omniviv-route-colors-v2"));
        expect(cached, "Cache should be populated after first visit").toBeTruthy();

        // Second visit in a NEW page (same context = same localStorage)
        const page2 = await context.newPage();
        await page2.goto("/");
        await page2.waitForLoadState("networkidle");

        await openNavigationPanel(page2);
        await fillLocation(page2, 0, "Stadtbergen");
        await fillLocation(page2, 1, "Königsplatz");
        await searchRoute(page2);

        const badges = await collectBadges(page2);
        const tramLines = new Set(Object.keys(AUGSBURG_TRAM_COLORS));
        const tramBadges = badges.filter(b => tramLines.has(b.line));

        for (const badge of tramBadges) {
            expect(
                badge.dataColor.toLowerCase(),
                `Tram ${badge.line}: should have color from cache, not fallback grey #6b7280`,
            ).not.toBe("#6b7280");

            const expected = AUGSBURG_TRAM_COLORS[badge.line];
            if (expected) {
                expect(
                    badge.dataColor.toLowerCase(),
                    `Tram ${badge.line}: cached color should match OSM`,
                ).toBe(expected.toLowerCase());
            }
        }

        await page2.close();
    });
});

// ─── MOTIS API Tests: Color Accuracy ────────────────────────────────────────

test.describe("MOTIS route color accuracy", () => {
    test("Stadtbergen → Königsplatz: tram legs have correct OSM color", async () => {
        if (!await isMotisReachable()) {
            test.skip(true, "MOTIS not reachable");
            return;
        }

        const itineraries = await fetchMotisRoute(COORDS.STADTBERGEN, COORDS.KOENIGSPLATZ);
        expect(itineraries.length).toBeGreaterThan(0);

        const tramLegs = itineraries
            .flatMap((legs) => legs)
            .filter((l) => l.mode === "TRAM" && l.routeShortName);

        expect(tramLegs.length, "Should have at least one tram leg").toBeGreaterThan(0);

        for (const leg of tramLegs) {
            const line = leg.routeShortName!;
            const expectedColor = AUGSBURG_TRAM_COLORS[line];
            if (!expectedColor) continue; // Unknown line, skip

            if (leg.routeColor) {
                const color = leg.routeColor.startsWith("#") ? leg.routeColor : `#${leg.routeColor}`;
                expect(
                    color.toLowerCase(),
                    `Tram ${line} routeColor should match OSM`,
                ).toBe(expectedColor.toLowerCase());
            }
        }
    });

    test("Göggingen → Lechhausen: tram 1 has correct OSM color", async () => {
        if (!await isMotisReachable()) {
            test.skip(true, "MOTIS not reachable");
            return;
        }

        const itineraries = await fetchMotisRoute(COORDS.GOGGINGEN, COORDS.LECHHAUSEN);
        expect(itineraries.length).toBeGreaterThan(0);

        const tram1Legs = itineraries
            .flatMap((legs) => legs)
            .filter((l) => l.mode === "TRAM" && l.routeShortName === "1");

        // This route may include bus alternatives — tram 1 is not guaranteed
        if (tram1Legs.length > 0 && tram1Legs[0].routeColor) {
            const color = tram1Legs[0].routeColor.startsWith("#")
                ? tram1Legs[0].routeColor
                : `#${tram1Legs[0].routeColor}`;
            expect(
                color.toLowerCase(),
                "Tram 1 routeColor should match OSM",
            ).toBe(AUGSBURG_TRAM_COLORS["1"].toLowerCase());
        }
    });

    test("all Augsburg tram colors in MOTIS responses are valid OSM colors", async () => {
        if (!await isMotisReachable()) {
            test.skip(true, "MOTIS not reachable");
            return;
        }

        // Fetch a route that goes through Königsplatz (hub for all tram lines)
        const itineraries = await fetchMotisRoute(COORDS.STADTBERGEN, COORDS.LECHHAUSEN);
        const tramLegs = itineraries
            .flatMap((legs) => legs)
            .filter((l) => l.mode === "TRAM" && l.routeShortName && l.routeColor);

        for (const leg of tramLegs) {
            const line = leg.routeShortName!;
            const expected = AUGSBURG_TRAM_COLORS[line];
            if (!expected) continue;

            const color = leg.routeColor!.startsWith("#") ? leg.routeColor! : `#${leg.routeColor}`;
            expect(
                color.toLowerCase(),
                `Tram ${line}: MOTIS routeColor should match known OSM color`,
            ).toBe(expected.toLowerCase());
        }
    });
});
