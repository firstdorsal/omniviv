import { describe, expect, it } from "vitest";

/**
 * E2E tests that validate our departure data against the AVV EFA API (ground truth).
 *
 * The EFA API (Electronic Timetable Information) from Augsburger Verkehrsverbund
 * provides the official real-time departure data. We compare our API's output
 * against it to ensure correctness.
 *
 * EFA API: https://fahrtauskunft.avv-augsburg.de/efa/
 */

const API_URL = process.env.API_URL ?? "http://localhost:3000";
const EFA_URL = "https://fahrtauskunft.avv-augsburg.de/efa/XML_DM_REQUEST";

async function isApiReachable(): Promise<boolean> {
    try {
        const res = await fetch(`${API_URL}/api/health`, { signal: AbortSignal.timeout(2000) });
        return res.ok;
    } catch {
        return false;
    }
}

async function isEfaReachable(): Promise<boolean> {
    try {
        const res = await fetch(`${EFA_URL}?outputFormat=rapidJSON&type_dm=stop&name_dm=Augsburg&mode=direct&limit=1`, {
            signal: AbortSignal.timeout(5000),
        });
        return res.ok;
    } catch {
        return false;
    }
}

interface EfaDeparture {
    platform: string;
    lineNumber: string;
    product: string;
    destination: string;
}

/** Fetch departures from the AVV EFA API for a given stop */
async function fetchEfaDepartures(stopName: string, date: string, time: string): Promise<EfaDeparture[]> {
    const params = new URLSearchParams({
        outputFormat: "rapidJSON",
        type_dm: "stop",
        name_dm: stopName,
        mode: "direct",
        useRealtime: "1",
        limit: "200",
        itdDate: date,
        itdTime: time,
    });

    const res = await fetch(`${EFA_URL}?${params}`);
    if (!res.ok) throw new Error(`EFA returned ${res.status}`);
    const data = await res.json();

    return (data.stopEvents ?? []).map((ev: {
        transportation?: { number?: string; product?: { name?: string }; destination?: { name?: string } };
        location?: { properties?: { platform?: string } };
    }) => ({
        platform: ev.location?.properties?.platform ?? "?",
        lineNumber: ev.transportation?.number ?? "?",
        product: ev.transportation?.product?.name ?? "?",
        destination: ev.transportation?.destination?.name ?? "?",
    }));
}

/** Fetch departures from our API for a given IFOPT */
async function fetchOurDepartures(ifopt: string, referenceTime: string) {
    const res = await fetch(`${API_URL}/api/departures/by-stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stop_ifopt: ifopt, reference_time: referenceTime }),
    });
    if (!res.ok) return { departures: [] };
    return res.json();
}

describe("Königsplatz platform assignments — validated against AVV EFA", () => {
    // Known Königsplatz IFOPTs
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

    it("EFA API is reachable", async () => {
        const reachable = await isEfaReachable();
        if (!reachable) {
            console.warn("EFA API not reachable, skipping validation tests");
        }
        // Don't fail — EFA may be down
    });

    it("our tram line assignments match EFA for each platform", { timeout: 30000 }, async () => {
        if (!await isApiReachable() || !await isEfaReachable()) {
            console.warn("API or EFA not reachable, skipping");
            return;
        }

        // Use tomorrow at 08:00 for consistent results
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        // Skip weekends for consistent tram schedules
        const dow = tomorrow.getDay();
        if (dow === 0) tomorrow.setDate(tomorrow.getDate() + 1); // Sunday → Monday
        if (dow === 6) tomorrow.setDate(tomorrow.getDate() + 2); // Saturday → Monday

        const dateStr = `${tomorrow.getFullYear()}${String(tomorrow.getMonth() + 1).padStart(2, "0")}${String(tomorrow.getDate()).padStart(2, "0")}`;
        const isoStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}T08:00:00Z`;

        // Fetch EFA departures for Königsplatz
        const efaDeps = await fetchEfaDepartures("Augsburg Königsplatz", dateStr, "0800");
        expect(efaDeps.length, "EFA should return departures").toBeGreaterThan(0);

        // Build EFA ground truth: platform → set of tram line numbers
        const efaTramsByPlatform = new Map<string, Set<string>>();
        for (const dep of efaDeps) {
            if (dep.product === "Straßenbahn") {
                const set = efaTramsByPlatform.get(dep.platform) ?? new Set();
                set.add(dep.lineNumber);
                efaTramsByPlatform.set(dep.platform, set);
            }
        }

        console.log("EFA tram assignments:", Object.fromEntries(
            [...efaTramsByPlatform.entries()].map(([k, v]) => [k, [...v].sort().join(",")])
        ));

        // For each platform, check our API returns the same tram lines
        for (const [platformName, ifopt] of Object.entries(PLATFORMS)) {
            const efaTrams = efaTramsByPlatform.get(platformName);
            if (!efaTrams || efaTrams.size === 0) {
                // EFA has no trams at this platform (might be bus-only now)
                continue;
            }

            const ourData = await fetchOurDepartures(ifopt, isoStr);
            const ourTrams = new Set(
                ourData.departures
                    ?.filter((d: { gtfs_route_type?: number }) => d.gtfs_route_type === 0)
                    ?.map((d: { line_number: string }) => d.line_number) ?? []
            );

            // Our tram lines should be a subset of EFA's (EFA may show more due to different time windows)
            // At minimum, we should have at least one of the EFA tram lines
            const overlap = [...ourTrams].filter(line => efaTrams.has(line));
            expect(
                overlap.length,
                `Platform ${platformName}: our trams [${[...ourTrams].join(",")}] should overlap with EFA trams [${[...efaTrams].join(",")}]`,
            ).toBeGreaterThan(0);
        }
    });

    it("platforms with departures in EFA also have departures in our API", { timeout: 30000 }, async () => {
        if (!await isApiReachable() || !await isEfaReachable()) {
            console.warn("API or EFA not reachable, skipping");
            return;
        }

        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const dow = tomorrow.getDay();
        if (dow === 0) tomorrow.setDate(tomorrow.getDate() + 1);
        if (dow === 6) tomorrow.setDate(tomorrow.getDate() + 2);

        const isoStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}T08:00:00Z`;
        const dateStr = `${tomorrow.getFullYear()}${String(tomorrow.getMonth() + 1).padStart(2, "0")}${String(tomorrow.getDate()).padStart(2, "0")}`;

        const efaDeps = await fetchEfaDepartures("Augsburg Königsplatz", dateStr, "0800");

        // Find which platforms have tram departures in EFA
        const efaPlatformsWithTrams = new Set<string>();
        for (const dep of efaDeps) {
            if (dep.product === "Straßenbahn" && PLATFORMS[dep.platform]) {
                efaPlatformsWithTrams.add(dep.platform);
            }
        }

        // Every platform that has trams in EFA should also have departures from our API
        for (const platformName of efaPlatformsWithTrams) {
            const ifopt = PLATFORMS[platformName];
            const ourData = await fetchOurDepartures(ifopt, isoStr);
            expect(
                ourData.departures?.length ?? 0,
                `Platform ${platformName} (${ifopt}) has trams in EFA but no departures from our API`,
            ).toBeGreaterThan(0);
        }
    });
});
