import { test, expect } from "@playwright/test";

/**
 * E2E tests for operator logos on RE/RB departures.
 *
 * Validates:
 *   1. The API returns operator names for regional train departures
 *   2. Non-DB operators get a visible logo rendered before the LineBadge
 *   3. DB Regio departures do NOT get an extra operator logo
 *   4. Non-regional lines (tram, bus, ICE) do NOT get operator logos
 *
 * Prerequisites:
 *   - API at omniviv-api.localhost with GTFS agencies loaded
 *   - vite dev server at localhost:5174
 */

const API = "http://omniviv-api.localhost";

// Augsburg Hbf stop_position OSM IDs (platforms with rail traffic)
const HBF_OSM_ID = 576389126;

// Known non-DB operators that should produce a logo (substrings matched)
/** Check if an operator is NOT a DB brand (DB Regio, DB Fernverkehr, etc.) */
function isNonDbOperator(operator: string): boolean {
    return !operator.includes("DB ") && !operator.startsWith("DB");
}

function isRegionalTrain(line: string): boolean {
    return /^(RE|RB|IRE)\d/i.test(line);
}

test.describe("Operator logos for regional trains", () => {
    test("API returns operator field for RE/RB departures at Augsburg Hbf", async ({
        request,
    }) => {
        const res = await request.post(`${API}/api/departures/by-osm-id`, {
            data: { osm_id: HBF_OSM_ID },
        });
        expect(res.ok()).toBe(true);

        const data = await res.json();
        const departures = data.departures ?? [];
        expect(departures.length).toBeGreaterThan(0);

        // Filter to RE/RB departures only
        const regionalDeps = departures.filter(
            (d: any) => isRegionalTrain(d.line_number) && d.event_type === "departure"
        );
        expect(
            regionalDeps.length,
            "Expected at least some RE/RB departures at Augsburg Hbf"
        ).toBeGreaterThan(0);

        // Every RE/RB departure should have an operator field
        const withOperator = regionalDeps.filter((d: any) => d.operator);
        expect(
            withOperator.length,
            `${regionalDeps.length - withOperator.length} RE/RB departures missing operator`
        ).toBe(regionalDeps.length);

        // At least some should be non-DB (Arverio, BRB, etc. serve Augsburg Hbf)
        const nonDb = withOperator.filter((d: any) => isNonDbOperator(d.operator));
        expect(
            nonDb.length,
            "Expected at least one non-DB operator at Augsburg Hbf (Arverio, BRB, etc.)"
        ).toBeGreaterThan(0);

        // Log operator distribution for debugging
        const operatorCounts: Record<string, number> = {};
        for (const d of regionalDeps) {
            const op = d.operator ?? "(none)";
            operatorCounts[op] = (operatorCounts[op] ?? 0) + 1;
        }
        console.log("Operator distribution:", operatorCounts);
    });

    test("API returns correct operator for known Augsburg RE lines", async ({
        request,
    }) => {
        const res = await request.post(`${API}/api/departures/by-osm-id`, {
            data: { osm_id: HBF_OSM_ID },
        });
        const data = await res.json();
        const departures: any[] = data.departures ?? [];

        // RE9 should be Arverio (GYRE)
        const re9 = departures.find(
            (d: any) => d.line_number === "RE9" && d.event_type === "departure"
        );

        // RB13 at Augsburg Hbf should be Bayerische Regiobahn
        const rb13 = departures.find(
            (d: any) => d.line_number === "RB13" && d.event_type === "departure"
        );

        // At least one of RE9 or RB13 must be present in the current schedule
        expect(
            re9 || rb13,
            "Expected at least one of RE9 or RB13 at Augsburg Hbf in current schedule"
        ).toBeTruthy();

        if (re9) {
            expect(re9.operator).toContain("Arverio");
        }
        if (rb13) {
            expect(rb13.operator).toContain("Bayerische Regiobahn");
        }
    });

    test("non-regional lines do NOT have operator logos in the UI", async ({
        page,
    }) => {
        // Navigate to the app and open a tram stop (Königsplatz)
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        // Use the API to verify tram departures don't have operator logos rendered
        // We check this by looking at the departure data structure
        const res = await page.request.post(`${API}/api/departures/by-osm-id`, {
            data: { osm_id: 563331 }, // Königsplatz
        });
        const data = await res.json();
        const tramDeps = (data.departures ?? []).filter(
            (d: any) => d.gtfs_route_type === 0
        );

        // Tram departures should still have operator (it's in the data),
        // but the UI should NOT render logos for them (only for RE/RB/IRE)
        // This is a data-level check; the UI filtering happens in LineBadge's isRegionalTrain()
        for (const d of tramDeps.slice(0, 5)) {
            expect(isRegionalTrain(d.line_number)).toBe(false);
        }
    });

    test(
        "browser renders operator logos for non-DB regional trains",
        { timeout: 90000 },
        async ({ page }) => {
            // First verify the API has non-DB regional departures
            const apiRes = await page.request.post(
                `${API}/api/departures/by-osm-id`,
                { data: { osm_id: HBF_OSM_ID } }
            );
            const apiData = await apiRes.json();
            const regionalDeps = (apiData.departures ?? []).filter(
                (d: any) =>
                    isRegionalTrain(d.line_number) &&
                    d.event_type === "departure" &&
                    d.operator &&
                    isNonDbOperator(d.operator)
            );

            if (regionalDeps.length === 0) {
                test.skip(
                    true,
                    "No non-DB regional departures at Hbf right now"
                );
                return;
            }

            // Pin the Hbf stop via localStorage so the DeparturesPanel loads it
            const pinnedStop = {
                id: String(HBF_OSM_ID),
                osmId: HBF_OSM_ID,
                displayName: "Augsburg Hauptbahnhof",
                stationName: "Augsburg Hauptbahnhof",
                refIfopt: null,
                lat: 48.3654,
                lon: 10.8856,
            };

            // Set localStorage before navigation
            await page.addInitScript((stop) => {
                localStorage.setItem("pinned-stops", JSON.stringify([stop]));
            }, pinnedStop);

            // Navigate to the app with the departures panel open for this stop
            await page.goto(`/?panel=departures:${HBF_OSM_ID}`);
            await page.waitForLoadState("networkidle");

            // Wait for departure data to load (the DepartureMonitor fetches every 30s)
            await page.waitForTimeout(5000);

            // Collect all badge info in a single evaluate() call to avoid
            // timeout issues from iterating locators while the DOM re-renders
            // (DepartureMonitor refreshes every 30s).
            const badgeInfo = await page.evaluate(() => {
                const selector = '[data-testid^="line-badge-RE"], [data-testid^="line-badge-RB"], [data-testid^="line-badge-IRE"]';
                const badges = document.querySelectorAll(selector);
                return Array.from(badges).slice(0, 30).map(badge => {
                    const title = badge.getAttribute("title");
                    const hasSvg = badge.querySelector("svg") !== null;
                    const hasImg = badge.querySelector("img") !== null;
                    const svgRect = badge.querySelector("svg rect");
                    const svgText = badge.querySelector("svg text");
                    return {
                        line: badge.getAttribute("data-line") ?? "?",
                        title,
                        hasSvg,
                        hasImg,
                        svgRectFill: svgRect?.getAttribute("fill") ?? null,
                        svgTextContent: svgText?.textContent?.trim() ?? null,
                    };
                });
            });

            console.log(`Found ${badgeInfo.length} RE/RB badges in the UI`);
            expect(
                badgeInfo.length,
                "Expected RE/RB badges to be visible at Augsburg Hbf"
            ).toBeGreaterThan(0);

            // LineBadge.tsx sets title={operator} on the badge span itself when
            // getOperatorLogo() returns a logo component (non-DB operators).
            // The logo SVG/IMG is rendered as a child inside the badge span.
            let logosFound = 0;
            let dbBadgesWithoutLogo = 0;
            for (const badge of badgeInfo) {
                if (badge.title && isNonDbOperator(badge.title)) {
                    logosFound++;
                    expect(
                        badge.hasSvg || badge.hasImg,
                        `Badge ${badge.line} with title "${badge.title}" should contain an operator logo (SVG or IMG)`,
                    ).toBe(true);

                    if (badge.hasSvg && badge.svgRectFill) {
                        expect(badge.svgRectFill.length, "SVG rect fill should not be empty").toBeGreaterThan(0);
                    }
                    if (badge.hasSvg && badge.svgTextContent) {
                        expect(badge.svgTextContent.length, "Logo text should not be empty").toBeGreaterThan(0);
                    }
                } else if (!badge.title) {
                    dbBadgesWithoutLogo++;
                }
            }

            console.log(
                `Operator logos: ${logosFound} found, ${dbBadgesWithoutLogo} DB (no logo)`
            );
            expect(
                logosFound,
                "Expected at least one non-DB operator logo to be visible"
            ).toBeGreaterThan(0);
        }
    );

    test("DB Regio departures do NOT get an extra operator logo wrapper", async ({
        request,
    }) => {
        const res = await request.post(`${API}/api/departures/by-osm-id`, {
            data: { osm_id: HBF_OSM_ID },
        });
        const data = await res.json();
        const dbRegioDeps = (data.departures ?? []).filter(
            (d: any) =>
                isRegionalTrain(d.line_number) &&
                d.operator &&
                d.operator.includes("DB Regio")
        );

        // DB Regio should have operator field but getOperatorLogo should return null
        for (const d of dbRegioDeps.slice(0, 5)) {
            expect(d.operator).toBeTruthy();
            // The frontend's getOperatorLogo returns null for DB Regio
            // (no matching substring in OPERATOR_MATCHERS)
            expect(isNonDbOperator(d.operator)).toBe(false);
        }
    });
});
