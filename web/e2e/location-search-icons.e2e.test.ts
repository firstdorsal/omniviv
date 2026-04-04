import { test, expect, type Page } from "@playwright/test";

/**
 * E2E tests: Verify that location search icons resolve correctly for
 * different MOTIS geocode categories.
 *
 * Tests both:
 *   1. Icon resolution logic: MOTIS category → correct SVG icon path
 *   2. Browser rendering: icons actually load and display in the search dropdown
 *
 * Prerequisites:
 *   - vite dev server at localhost:5174
 *   - MOTIS at omniviv-motis.localhost
 */

const MOTIS_URL = "http://omniviv-motis.localhost";

/**
 * Mirror of the frontend's motisCategoryToIconName logic.
 * Maps place_* categories to city/town/village based on zoom suffix.
 */
function motisCategoryToIconName(category: string | undefined): string | undefined {
    if (!category) return undefined;
    if (category.startsWith("place_capital")) return "city";
    const placeMatch = category.match(/^place_(\d+)$/);
    if (placeMatch) {
        const zoom = parseInt(placeMatch[1]);
        if (zoom <= 6) return "city";
        if (zoom <= 8) return "town";
        return "village";
    }
    return category.replace(/_\d+$/, "");
}

/**
 * Known locations with their expected MOTIS categories and icon paths.
 * Each entry is verified against live MOTIS geocode responses.
 */
const KNOWN_LOCATIONS = [
    {
        query: "Susis Hexenhäusel",
        name: "Susi´s Hexenhäusl",
        expectedCategory: "pub",
        expectedIcon: "/icons/maki/beer.svg",
        description: "Pub in Augsburg Innenstadt",
    },
    {
        query: "Hexenhäusle",
        name: "Hexenhäusle",
        expectedCategory: "biergarten",
        expectedIcon: "/icons/maki/beer.svg",
        description: "Biergarten in Augsburg-Hochfeld",
    },
    {
        query: "Königsplatz",
        name: "Königsplatz",
        expectedCategory: undefined, // station match, no MOTIS category
        expectedIcon: "/icons/maki/rail.svg",
        description: "Tram station (local match)",
        isStation: true,
    },
    {
        query: "Susi Hair",
        name: "Susi Hair",
        expectedCategory: "hairdresser",
        expectedIcon: "/icons/maki/hairdresser.svg",
        description: "Hairdresser (Maki direct match)",
    },
    // -- Augsburg-specific locations across diverse categories -----------------
    {
        query: "Metzgerei Augsburg",
        name: "Metzgerei Lutz",
        expectedCategory: "butcher",
        expectedIcon: "/icons/temaki/meat.svg",
        description: "Metzgerei in Augsburg",
    },
    {
        query: "Fatih Moschee",
        name: "Fatih Moschee",
        expectedCategory: "muslim",
        expectedIcon: "/icons/maki/religious-muslim.svg",
        description: "Moschee in Augsburg",
    },
    {
        query: "Zion Kirche Augsburg",
        name: "Zion Kirche",
        expectedCategory: "christian",
        expectedIcon: "/icons/maki/religious-christian.svg",
        description: "Kirche in Augsburg",
    },
    {
        query: "Rathaus Augsburg",
        name: "Rathaus",
        expectedCategory: "town_hall",
        expectedIcon: "/icons/maki/town-hall.svg",
        description: "Rathaus Augsburg",
    },
    {
        query: "Anna Apotheke Augsburg",
        name: "Anna Apotheke",
        expectedCategory: "pharmacy",
        expectedIcon: "/icons/maki/pharmacy.svg",
        description: "Apotheke in Augsburg",
    },
    {
        query: "Dr. Dieter Kraus Zahnarzt",
        name: "Dr. Dieter Kraus - Zahnarzt",
        expectedCategory: "dentist",
        expectedIcon: "/icons/maki/dentist.svg",
        description: "Zahnarzt in Augsburg",
    },
    {
        query: "Tierarzt Walter Reis",
        name: "Tierarzt Walter Reis",
        expectedCategory: "veterinary",
        expectedIcon: "/icons/maki/veterinary.svg",
        description: "Tierarzt in Augsburg",
    },
    {
        query: "Neue Goldschmiede Augsburg",
        name: "Neue Goldschmiede",
        expectedCategory: "jewellery",
        expectedIcon: "/icons/maki/jewelry-store.svg",
        description: "Juwelier in Augsburg",
    },
    {
        query: "Thai massage Augsburg",
        name: "Ploy Thai Massage",
        expectedCategory: "massage",
        expectedIcon: "/icons/temaki/beauty_salon.svg",
        description: "Massage in Augsburg",
    },
    {
        query: "Pizza Bob Augsburg",
        name: "Pizza Bob",
        expectedCategory: "fast_food",
        expectedIcon: "/icons/maki/fast-food.svg",
        description: "Schnellimbiss in Augsburg",
    },
    {
        query: "Nefis Bäckerei Augsburg",
        name: "Nefis Bäckerei",
        expectedCategory: "bakery",
        expectedIcon: "/icons/maki/bakery.svg",
        description: "Bäckerei in Augsburg",
    },
    {
        query: "Friseur Funk Augsburg",
        name: "Friseur Funk",
        expectedCategory: "hairdresser",
        expectedIcon: "/icons/maki/hairdresser.svg",
        description: "Friseur in Augsburg",
    },
    {
        query: "swa Tankstelle Augsburg",
        name: "swa Tankstelle",
        expectedCategory: "fuel",
        expectedIcon: "/icons/maki/fuel.svg",
        description: "Tankstelle in Augsburg",
    },
    {
        query: "Dönerladen Köksal Usta",
        name: "Dönerladen Köksal Usta",
        expectedCategory: "restaurant",
        expectedIcon: "/icons/maki/restaurant.svg",
        description: "Dönerladen in Augsburg",
    },
    // -- Place type tests (city/town/village from place_* zoom suffix) ---------
    {
        query: "Frankfurt",
        name: "Frankfurt",
        expectedCategory: "city",
        expectedIcon: "/icons/maki/city.svg",
        description: "Stadt Frankfurt am Main (place_6 → city)",
    },
];

/** Locations specifically for testing category→icon mapping breadth */
const CATEGORY_ICON_TESTS = [
    { category: "pub", expectedIcon: "/icons/maki/beer.svg" },
    { category: "biergarten", expectedIcon: "/icons/maki/beer.svg" },
    { category: "restaurant", expectedIcon: "/icons/maki/restaurant.svg" },
    { category: "cafe", expectedIcon: "/icons/maki/cafe.svg" },
    { category: "bar", expectedIcon: "/icons/maki/bar.svg" },
    { category: "fast_food", expectedIcon: "/icons/maki/fast-food.svg" },
    { category: "hotel", expectedIcon: "/icons/maki/lodging.svg" },
    { category: "supermarket", expectedIcon: "/icons/maki/grocery.svg" },
    { category: "bakery", expectedIcon: "/icons/maki/bakery.svg" },
    { category: "pharmacy", expectedIcon: "/icons/maki/pharmacy.svg" },
    { category: "hospital", expectedIcon: "/icons/maki/hospital.svg" },
    { category: "school", expectedIcon: "/icons/maki/school.svg" },
    { category: "museum", expectedIcon: "/icons/maki/museum.svg" },
    { category: "parking", expectedIcon: "/icons/maki/parking.svg" },
    { category: "fuel", expectedIcon: "/icons/maki/fuel.svg" },
    { category: "shelter", expectedIcon: "/icons/maki/shelter.svg" },
    { category: "dentist", expectedIcon: "/icons/maki/dentist.svg" },
    { category: "theatre", expectedIcon: "/icons/maki/theatre.svg" },
    { category: "cinema", expectedIcon: "/icons/maki/cinema.svg" },
    { category: "nightclub", expectedIcon: "/icons/maki/nightclub.svg" },
    { category: "swimming", expectedIcon: "/icons/maki/swimming.svg" },
    { category: "playground", expectedIcon: "/icons/maki/playground.svg" },
    { category: "bank", expectedIcon: "/icons/maki/bank.svg" },
    { category: "police", expectedIcon: "/icons/maki/police.svg" },
    { category: "fire_station", expectedIcon: "/icons/maki/fire-station.svg" },
    { category: "christian", expectedIcon: "/icons/maki/religious-christian.svg" },
    { category: "muslim", expectedIcon: "/icons/maki/religious-muslim.svg" },
    { category: "jewish", expectedIcon: "/icons/maki/religious-jewish.svg" },
    { category: "butcher", expectedIcon: "/icons/temaki/meat.svg" },
    { category: "clothes", expectedIcon: "/icons/maki/clothing-store.svg" },
    { category: "electronics", expectedIcon: "/icons/temaki/electronic.svg" },
    { category: "hairdresser", expectedIcon: "/icons/maki/hairdresser.svg" },
    { category: "doctors", expectedIcon: "/icons/maki/doctor.svg" },
    { category: "university", expectedIcon: "/icons/maki/college.svg" },
    { category: "kindergarten", expectedIcon: "/icons/maki/school.svg" },
    { category: "townhall", expectedIcon: "/icons/maki/town-hall.svg" },
    { category: "memorial", expectedIcon: "/icons/maki/monument.svg" },
    { category: "viewpoint", expectedIcon: "/icons/maki/viewpoint.svg" },
    { category: "peak", expectedIcon: "/icons/maki/mountain.svg" },
    { category: "marketplace", expectedIcon: "/icons/temaki/shopping_mall.svg" },
    { category: "post_office", expectedIcon: "/icons/maki/post.svg" },
    // Generic types
    { category: "station", expectedIcon: "/icons/maki/rail.svg" },
    { category: "address", expectedIcon: "/icons/maki/building.svg" },
    { category: "none", expectedIcon: "/icons/maki/marker.svg" },
];

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

/** Open the navigation panel */
async function openNavigationPanel(page: Page) {
    const navButton = page.locator('button[aria-label="Routenplanung"]');
    await navButton.click();
    await expect(page.locator("text=Routenplanung")).toBeVisible();
}

// ─── Unit-style: Icon resolution via browser ─────────────────────────────────

test.describe("Location icon resolution (in-browser)", () => {
    for (const { category, expectedIcon } of CATEGORY_ICON_TESTS) {
        test(`category "${category}" resolves to ${expectedIcon}`, async ({ page }) => {
            await page.goto("/");
            await page.waitForLoadState("networkidle");

            const resolvedPath = await page.evaluate((cat) => {
                // Access the resolveIconPath function via the module system
                // We test by creating a PinheadIcon element and checking its mask-image
                const el = document.createElement("span");
                el.setAttribute("data-test-category", cat);
                document.body.appendChild(el);

                // Import the module dynamically
                return import("/src/components/PinheadIcon.tsx").then((mod) => {
                    const path = mod.resolveIconPath(cat);
                    el.remove();
                    return path;
                });
            }, category);

            expect(
                resolvedPath,
                `Category "${category}" should resolve to ${expectedIcon}`,
            ).toBe(expectedIcon);
        });
    }
});

// ─── MOTIS API: Verify categories for known locations ────────────────────────

test.describe("MOTIS geocode categories", () => {
    test.beforeEach(async () => {
        if (!(await isMotisReachable())) {
            test.skip(true, "MOTIS not reachable");
        }
    });

    for (const loc of KNOWN_LOCATIONS.filter((l) => !l.isStation)) {
        test(`"${loc.query}" returns category "${loc.expectedCategory}" (${loc.description})`, async ({
            request,
        }) => {
            const res = await request.get(
                `${MOTIS_URL}/api/v1/geocode?text=${encodeURIComponent(loc.query)}&place=48.3657,10.8946`,
            );
            expect(res.ok()).toBeTruthy();

            const data = await res.json();
            expect(data.length, `No results for "${loc.query}"`).toBeGreaterThan(0);

            // Find matching result by name
            const match = data.find(
                (r: { name: string }) => r.name === loc.name,
            );
            expect(match, `No result named "${loc.name}" in MOTIS response`).toBeTruthy();

            // Map category the same way the frontend does (motisCategoryToIconName)
            const category = motisCategoryToIconName(match.category);
            expect(
                category,
                `"${loc.name}" should have category "${loc.expectedCategory}"`,
            ).toBe(loc.expectedCategory);
        });
    }
});

// ─── Browser: Icons render correctly in search dropdown ──────────────────────

test.describe("Location search icon rendering", () => {
    test.beforeEach(async () => {
        if (!(await isMotisReachable())) {
            test.skip(true, "MOTIS not reachable");
        }
    });

    for (const loc of KNOWN_LOCATIONS) {
        test(`"${loc.query}" shows correct icon in dropdown (${loc.description})`, async ({ page }) => {
            await page.goto("/");
            await page.waitForLoadState("networkidle");

            await openNavigationPanel(page);

            // Type query into the first location input
            const input = page.locator('input[role="combobox"]').first();
            await input.click();
            await input.fill(loc.query);

            // Wait for suggestions
            await page.waitForTimeout(1500);
            const listbox = page.locator('[role="listbox"]');
            await expect(listbox).toBeVisible({ timeout: 5000 });

            // Find the suggestion row containing the location name
            const suggestions = page.locator('[role="option"]');
            const count = await suggestions.count();
            expect(count, `No suggestions for "${loc.query}"`).toBeGreaterThan(0);

            // Check icon in the matching suggestion
            let found = false;
            for (let i = 0; i < count; i++) {
                const text = await suggestions.nth(i).textContent();
                if (text?.includes(loc.name)) {
                    found = true;

                    // The icon element uses mask-image CSS
                    const iconSpan = suggestions.nth(i).locator('span[role="img"]');
                    const iconCount = await iconSpan.count();

                    if (iconCount > 0) {
                        const maskImage = await iconSpan.first().evaluate((el) => {
                            return window.getComputedStyle(el).maskImage ||
                                window.getComputedStyle(el).webkitMaskImage;
                        });

                        expect(
                            maskImage,
                            `"${loc.name}" icon should use ${loc.expectedIcon}`,
                        ).toContain(loc.expectedIcon);
                    } else {
                        // Station matches use Lucide SVG icons, not mask-image spans
                        // GPS and map types also use Lucide
                        if (!loc.isStation) {
                            expect(iconCount, `"${loc.name}" should have a PinheadIcon`).toBeGreaterThan(0);
                        }
                    }
                    break;
                }
            }

            expect(found, `Could not find suggestion "${loc.name}" for query "${loc.query}"`).toBeTruthy();
        });
    }

    test("Susi's Hexenhäusl does NOT show generic marker icon", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        await openNavigationPanel(page);

        const input = page.locator('input[role="combobox"]').first();
        await input.click();
        await input.fill("Susis Hexenhäusel");

        await page.waitForTimeout(1500);
        const suggestions = page.locator('[role="option"]');
        const count = await suggestions.count();
        expect(count).toBeGreaterThan(0);

        for (let i = 0; i < count; i++) {
            const text = await suggestions.nth(i).textContent();
            if (text?.includes("Hexenhäusl")) {
                const iconSpan = suggestions.nth(i).locator('span[role="img"]');
                const iconCount = await iconSpan.count();
                expect(iconCount, "Susi's Hexenhäusl should have an icon").toBeGreaterThan(0);

                const maskImage = await iconSpan.first().evaluate((el) => {
                    return window.getComputedStyle(el).maskImage ||
                        window.getComputedStyle(el).webkitMaskImage;
                });

                // Must NOT be the generic fallback marker
                expect(
                    maskImage,
                    "Susi's Hexenhäusl should NOT use the generic marker icon",
                ).not.toContain("/icons/maki/marker.svg");

                // Should be the beer icon (pub category)
                expect(
                    maskImage,
                    "Susi's Hexenhäusl (pub) should use the beer icon",
                ).toContain("/icons/maki/beer.svg");
                break;
            }
        }
    });

    test("icon SVG files referenced by categoryOverrides actually exist", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        // Get all unique icon paths from categoryOverrides
        const iconPaths: string[] = await page.evaluate(async () => {
            const mod = await import("/src/components/PinheadIcon.tsx");
            const paths = new Set<string>();
            for (const iconRef of Object.values(mod.categoryOverrides)) {
                paths.add(`/icons/${iconRef}.svg`);
            }
            return [...paths];
        });

        expect(iconPaths.length).toBeGreaterThan(0);

        // Verify each SVG file is fetchable
        const failures: string[] = [];
        for (const path of iconPaths) {
            const res = await page.evaluate(async (url) => {
                const r = await fetch(url);
                return { ok: r.ok, status: r.status };
            }, path);

            if (!res.ok) {
                failures.push(`${path} → HTTP ${res.status}`);
            }
        }

        expect(
            failures,
            `These icon SVGs are referenced but don't exist:\n${failures.join("\n")}`,
        ).toHaveLength(0);
    });
});
