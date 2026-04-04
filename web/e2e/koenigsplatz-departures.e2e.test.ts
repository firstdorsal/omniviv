import { test, expect } from "@playwright/test";

/**
 * E2E tests for Königsplatz departure monitors.
 *
 * Validates against the EFA API (per-platform IFOPT query) as ground truth.
 * Each platform is queried individually via its IFOPT to get the exact
 * lines and directions that the AVV assigns to that specific platform.
 */

const API = "http://omniviv-api.localhost";
const EFA_URL = "https://bahnland-bayern.de/efa/XML_DM_REQUEST";

// Königsplatz platform IFOPTs
const PLATFORMS: Record<string, string> = {
    A1: "de:09761:101:31:A1",
    A2: "de:09761:101:31:A2",
    A3: "de:09761:101:31:A3",
    A4: "de:09761:101:31:A4",
    B1: "de:09761:101:41:B1",
    B2: "de:09761:101:41:B2",
    C1: "de:09761:101:51:C1",
    C2: "de:09761:101:51:C2",
    C3: "de:09761:101:51:C3",
    C4: "de:09761:101:51:C4",
};

/** Get next weekday */
function getNextWeekday(): { dateStr: string; isoStr: string } {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return { dateStr: `${y}${m}${day}`, isoStr: `${y}-${m}-${day}T08:00:00Z` };
}

/** Fetch EFA departures for a single platform IFOPT */
async function fetchEfaDepartures(ifopt: string, dateStr: string): Promise<{ line: string; dest: string }[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const res = await fetch(`${EFA_URL}?mode=direct&name_dm=${encodeURIComponent(ifopt)}&type_dm=stop&depType=stopEvents&outputFormat=rapidJSON&limit=50&includedMeans=4&useRealtime=1&itdDate=${dateStr}&itdTime=0800`, { signal: controller.signal });
        if (!res.ok) return [];
        const data = await res.json();
        return (data.stopEvents ?? []).map((ev: any) => ({
            line: ev.transportation?.number ?? "?",
            dest: ev.transportation?.destination?.name ?? "?",
        }));
    } catch {
        return [];
    } finally {
        clearTimeout(timeout);
    }
}

test.describe("Königsplatz departures — EFA per-platform validation", () => {
    test("each platform shows the same tram lines as EFA", { timeout: 120000 }, async ({ request }) => {
        const { dateStr, isoStr } = getNextWeekday();
        const errors: string[] = [];
        let platformsChecked = 0;

        for (const [name, ifopt] of Object.entries(PLATFORMS)) {
            const efaDeps = await fetchEfaDepartures(ifopt, dateStr);
            const efaLines = [...new Set(efaDeps.map(d => d.line))].sort();
            if (efaLines.length === 0) continue;
            platformsChecked++;

            const res = await request.post(`${API}/api/departures/by-stop`, {
                data: { stop_ifopt: ifopt, reference_time: isoStr },
            });
            if (!res.ok()) { errors.push(`${name}: API error`); continue; }

            const data = await res.json();
            const ourTramLines = [...new Set(
                (data.departures ?? [])
                    .filter((d: any) => d.gtfs_route_type === 0)
                    .map((d: any) => d.line_number)
            )].sort();

            if (ourTramLines.join(",") !== efaLines.join(",")) {
                errors.push(`${name}: ours=[${ourTramLines.join(",")}] EFA=[${efaLines.join(",")}]`);
            }
        }

        expect(platformsChecked, "EFA returned no data for any platform — test is vacuous").toBeGreaterThan(0);
        expect(errors.length, `Line mismatches:\n${errors.join("\n")}`).toBe(0);
    });

    test("each platform shows only departures in the EFA direction", { timeout: 120000 }, async ({ request }) => {
        const { dateStr, isoStr } = getNextWeekday();
        const errors: string[] = [];

        for (const [name, ifopt] of Object.entries(PLATFORMS)) {
            const efaDeps = await fetchEfaDepartures(ifopt, dateStr);
            if (efaDeps.length === 0) continue;

            const efaDestsByLine = new Map<string, Set<string>>();
            for (const dep of efaDeps) {
                if (!efaDestsByLine.has(dep.line)) efaDestsByLine.set(dep.line, new Set());
                for (const word of dep.dest.split(/[,\s]+/)) {
                    const w = word.trim().toLowerCase();
                    if (w.length >= 4) efaDestsByLine.get(dep.line)!.add(w);
                }
            }

            const res = await request.post(`${API}/api/departures/by-stop`, {
                data: { stop_ifopt: ifopt, reference_time: isoStr },
            });
            if (!res.ok()) continue;

            const data = await res.json();
            const ourTramDeps = (data.departures ?? []).filter((d: any) => d.gtfs_route_type === 0);

            for (const dep of ourTramDeps) {
                const efaKeywords = efaDestsByLine.get(dep.line_number);
                if (!efaKeywords || efaKeywords.size === 0) continue;

                const ourDestLower = (dep.destination as string).toLowerCase();
                // Accept if destination matches EFA direction OR if destination
                // is the current station itself (= short-turn/terminating service)
                const matchesDirection = [...efaKeywords].some(kw => ourDestLower.includes(kw));
                const isTerminatingHere = ourDestLower.includes("königsplatz");
                if (!matchesDirection && !isTerminatingHere) {
                    errors.push(`${name} Tram ${dep.line_number}: "${dep.destination}" ≠ EFA [${[...efaKeywords].join(",")}]`);
                }
            }
        }

        expect(errors.length, `Direction mismatches:\n${errors.join("\n")}`).toBe(0);
    });

    test("all EFA-active platforms have departures in our API", { timeout: 120000 }, async ({ request }) => {
        const { dateStr, isoStr } = getNextWeekday();

        for (const [name, ifopt] of Object.entries(PLATFORMS)) {
            const efaDeps = await fetchEfaDepartures(ifopt, dateStr);
            if (efaDeps.length === 0) continue; // Platform not active in EFA

            const res = await request.post(`${API}/api/departures/by-stop`, {
                data: { stop_ifopt: ifopt, reference_time: isoStr },
            });
            expect(res.ok(), `${name}: API error`).toBeTruthy();

            const data = await res.json();
            expect(
                data.departures?.length ?? 0,
                `${name}: EFA has ${efaDeps.length} tram deps but our API has none`,
            ).toBeGreaterThan(0);
        }
    });
});
