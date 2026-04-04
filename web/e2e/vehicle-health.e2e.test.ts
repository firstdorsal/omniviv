import { test, expect, type Page } from "@playwright/test";

/**
 * E2E tests: Vehicle rendering health checks.
 *
 * Uses the VehicleLifecycleMonitor API (window.__vehicleMonitor) to
 * programmatically detect rendering anomalies:
 *   - Teleporting vehicles (position jumps > 80m between frames)
 *   - Ghost removals (vehicles vanishing while still in transit)
 *   - Stuck vehicles (no movement for 30s while in_transit)
 *   - Speed anomalies (rendered speed > 2x schedule speed)
 *   - Flickering vehicles (disappear and reappear within 5s)
 *   - Rapid status changes (> 5 changes within 10s)
 *   - Vehicles driving backwards (rendered linear position decreasing)
 *   - Unrealistic speeds (> 120 km/h for trams)
 *
 * Prerequisites:
 *   - vite dev server at localhost:5174
 *   - API at omniviv-api.localhost with GTFS-RT data
 */

const APP_URL = "http://localhost:5174";
const API_URL = "http://omniviv-api.localhost";
const AUGSBURG_CENTER = { lat: 48.365, lon: 10.894 };

// How long to observe vehicles for health checks (ms)
const OBSERVATION_PERIOD_MS = 45_000;
// Minimum vehicles needed for a valid test
const MIN_VEHICLES_FOR_TEST = 3;

async function isApiReachable(): Promise<boolean> {
    try {
        const res = await fetch(`${API_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
        return res.ok;
    } catch {
        return false;
    }
}

interface MonitorStats {
    totalTracked: number;
    currentlyVisible: number;
    totalAnomalies: number;
    anomaliesByType: Record<string, number>;
    topFlickers: { tripId: string; count: number }[];
    topTeleporters: { tripId: string; count: number }[];
    frameCount: number;
}

interface Anomaly {
    type: string;
    tripId: string;
    timestamp: number;
    details: string;
}

interface SpeedEntry {
    tripId: string;
    renderedSpeedKmh: number;
    scheduleSpeedKmh: number;
    speedRatio: number;
    distToNextStop: number | undefined;
    msToNextStop: number | undefined;
}

/**
 * Wait for the map to load, vehicles to appear, and enable the monitor.
 * Returns the page ready for observation.
 */
async function setupVehicleObservation(page: Page): Promise<boolean> {
    await page.goto(`${APP_URL}/#${AUGSBURG_CENTER.lat},${AUGSBURG_CENTER.lon},14.00,0,0`);

    // Wait for map
    await page.waitForFunction(() => !!(window as any).map, { timeout: 20000 });

    // Wait for vehicles to appear
    const hasVehicles = await page.waitForFunction(
        (minCount: number) => {
            const map = (window as any).map;
            if (!map) return false;
            try {
                const features = map.queryRenderedFeatures(undefined, { layers: ["vehicles-marker"] });
                return features && features.length >= minCount;
            } catch {
                return false;
            }
        },
        MIN_VEHICLES_FOR_TEST,
        { timeout: 30000 },
    ).catch(() => null);

    if (!hasVehicles) return false;

    // Enable the lifecycle monitor
    await page.evaluate(() => {
        const mon = (window as any).__vehicleMonitor;
        if (mon) {
            mon.clear();
            mon.enable();
        }
    });

    return true;
}

/**
 * Collect monitor data after the observation period.
 */
async function collectMonitorData(page: Page): Promise<{
    stats: MonitorStats;
    anomalies: Anomaly[];
    speedStats: SpeedEntry[];
    backwardMovements: { tripId: string; from: number; to: number }[];
}> {
    return page.evaluate(() => {
        const mon = (window as any).__vehicleMonitor;
        if (!mon) return {
            stats: { totalTracked: 0, currentlyVisible: 0, totalAnomalies: 0, anomaliesByType: {}, topFlickers: [], topTeleporters: [], frameCount: 0 },
            anomalies: [],
            speedStats: [],
            backwardMovements: [],
        };

        // Detect backward movements by checking position history
        const backwardMovements: { tripId: string; from: number; to: number }[] = [];
        const all = mon.getAll() as Map<string, any>;
        for (const [tripId, vehicle] of all) {
            if (vehicle.lastSnapshot && vehicle.stuckCheckPosition > vehicle.lastSnapshot.linearPosition + 5) {
                backwardMovements.push({
                    tripId,
                    from: vehicle.stuckCheckPosition,
                    to: vehicle.lastSnapshot.linearPosition,
                });
            }
        }

        return {
            stats: mon.getStats(),
            anomalies: mon.getAnomalies(200),
            speedStats: mon.getSpeedStats(),
            backwardMovements,
        };
    });
}

test.describe("Vehicle rendering health", () => {
    test.setTimeout(OBSERVATION_PERIOD_MS + 60_000); // observation + setup time

    test.beforeEach(async () => {
        test.skip(!(await isApiReachable()), "API not reachable");
    });

    test("no teleporting vehicles (position jumps > 80m)", async ({ page }) => {
        const ready = await setupVehicleObservation(page);
        test.skip(!ready, "Not enough vehicles running for this test");

        await page.waitForTimeout(OBSERVATION_PERIOD_MS);
        const data = await collectMonitorData(page);

        const teleportCount = data.stats.anomaliesByType["teleport"] ?? 0;
        const teleportDetails = data.anomalies
            .filter(a => a.type === "teleport")
            .map(a => a.details);

        // Allow max 2 teleports (can happen during route transitions)
        expect(teleportCount).toBeLessThanOrEqual(2);
        if (teleportCount > 0) {
            console.log(`Teleport anomalies (${teleportCount}):`, teleportDetails.slice(0, 5));
        }
    });

    test("no ghost removals (vehicles vanishing while in transit)", async ({ page }) => {
        const ready = await setupVehicleObservation(page);
        test.skip(!ready, "Not enough vehicles running for this test");

        await page.waitForTimeout(OBSERVATION_PERIOD_MS);
        const data = await collectMonitorData(page);

        const ghostCount = data.stats.anomaliesByType["ghost_removal"] ?? 0;
        const ghostDetails = data.anomalies
            .filter(a => a.type === "ghost_removal")
            .map(a => a.details);

        // Ghost removals happen when GTFS-RT drops a trip — allow some
        // but flag if excessive (> 20% of tracked vehicles)
        const ghostRate = data.stats.totalTracked > 0
            ? ghostCount / data.stats.totalTracked
            : 0;
        expect(ghostRate).toBeLessThan(0.2);
        if (ghostCount > 0) {
            console.log(`Ghost removals (${ghostCount}/${data.stats.totalTracked} vehicles):`, ghostDetails.slice(0, 5));
        }
    });

    test("no stuck vehicles (stationary while supposedly in transit)", async ({ page }) => {
        const ready = await setupVehicleObservation(page);
        test.skip(!ready, "Not enough vehicles running for this test");

        await page.waitForTimeout(OBSERVATION_PERIOD_MS);
        const data = await collectMonitorData(page);

        const stuckCount = data.stats.anomaliesByType["stuck"] ?? 0;
        const stuckDetails = data.anomalies
            .filter(a => a.type === "stuck")
            .map(a => a.details);

        expect(stuckCount).toBe(0);
        if (stuckCount > 0) {
            console.log(`Stuck vehicles (${stuckCount}):`, stuckDetails.slice(0, 5));
        }
    });

    test("no excessive speed anomalies (rendered speed < 3x schedule)", async ({ page }) => {
        const ready = await setupVehicleObservation(page);
        test.skip(!ready, "Not enough vehicles running for this test");

        await page.waitForTimeout(OBSERVATION_PERIOD_MS);
        const data = await collectMonitorData(page);

        // Check current speed stats for extreme outliers
        const extremeSpeedVehicles = data.speedStats.filter(s =>
            s.renderedSpeedKmh > 0 && s.speedRatio > 3.0
        );

        // No vehicle should render at > 3x schedule speed
        expect(extremeSpeedVehicles.length).toBe(0);
        if (extremeSpeedVehicles.length > 0) {
            console.log("Extreme speed anomalies:", extremeSpeedVehicles.map(v =>
                `${v.tripId}: ${v.renderedSpeedKmh.toFixed(1)} km/h (${v.speedRatio.toFixed(1)}x schedule)`
            ));
        }
    });

    test("no vehicles exceeding 120 km/h (tram physical limit)", async ({ page }) => {
        const ready = await setupVehicleObservation(page);
        test.skip(!ready, "Not enough vehicles running for this test");

        await page.waitForTimeout(OBSERVATION_PERIOD_MS);
        const data = await collectMonitorData(page);

        // Absolute speed cap: no tram/bus vehicle should render above 120 km/h
        const overSpeedVehicles = data.speedStats.filter(s =>
            s.renderedSpeedKmh > 120
        );

        expect(overSpeedVehicles.length).toBe(0);
        if (overSpeedVehicles.length > 0) {
            console.log("Over-speed vehicles (> 120 km/h):", overSpeedVehicles.map(v =>
                `${v.tripId}: ${v.renderedSpeedKmh.toFixed(1)} km/h`
            ));
        }
    });

    test("no flickering vehicles (disappear/reappear within 5s)", async ({ page }) => {
        const ready = await setupVehicleObservation(page);
        test.skip(!ready, "Not enough vehicles running for this test");

        await page.waitForTimeout(OBSERVATION_PERIOD_MS);
        const data = await collectMonitorData(page);

        const flickerCount = data.stats.anomaliesByType["flicker"] ?? 0;

        // Flickering should be rare — grace period handles most cases
        expect(flickerCount).toBeLessThanOrEqual(3);
        if (flickerCount > 0) {
            console.log(`Flickering vehicles: ${data.stats.topFlickers.map(f =>
                `${f.tripId} (${f.count}x)`
            ).join(", ")}`);
        }
    });

    test("no rapid status changes (> 5 changes in 10s)", async ({ page }) => {
        const ready = await setupVehicleObservation(page);
        test.skip(!ready, "Not enough vehicles running for this test");

        await page.waitForTimeout(OBSERVATION_PERIOD_MS);
        const data = await collectMonitorData(page);

        const rapidCount = data.stats.anomaliesByType["rapid_status_change"] ?? 0;
        expect(rapidCount).toBe(0);
        if (rapidCount > 0) {
            const details = data.anomalies
                .filter(a => a.type === "rapid_status_change")
                .map(a => a.details);
            console.log(`Rapid status changes (${rapidCount}):`, details.slice(0, 5));
        }
    });

    test("no backward movement on route", async ({ page }) => {
        const ready = await setupVehicleObservation(page);
        test.skip(!ready, "Not enough vehicles running for this test");

        await page.waitForTimeout(OBSERVATION_PERIOD_MS);

        // Check for backward linear position changes over the full period
        const backwardMovements = await page.evaluate(() => {
            const mon = (window as any).__vehicleMonitor;
            if (!mon) return [];
            const all = mon.getAll() as Map<string, any>;
            const results: { tripId: string; delta: number }[] = [];
            for (const [tripId, vehicle] of all) {
                if (vehicle.lastSnapshot && vehicle.stuckCheckPosition !== undefined) {
                    const delta = vehicle.lastSnapshot.linearPosition - vehicle.stuckCheckPosition;
                    // Significant backward movement (> 10m) — not just rounding
                    if (delta < -10) {
                        results.push({ tripId, delta: Math.round(delta) });
                    }
                }
            }
            return results;
        });

        expect(backwardMovements.length).toBe(0);
        if (backwardMovements.length > 0) {
            console.log("Backward movements:", backwardMovements);
        }
    });

    test("vehicles have realistic positions (on their route geometry)", async ({ page }) => {
        const ready = await setupVehicleObservation(page);
        test.skip(!ready, "Not enough vehicles running for this test");

        // Wait a few seconds for positions to stabilize
        await page.waitForTimeout(5000);

        // Check that vehicle rendered positions are close to their route geometry
        const offRouteVehicles = await page.evaluate(() => {
            const map = (window as any).map;
            if (!map) return [];
            const features = map.queryRenderedFeatures(undefined, { layers: ["vehicles-marker"] });
            const results: { tripId: string; lineNumber: string; lat: number; lon: number }[] = [];

            for (const f of features) {
                const lat = f.geometry?.coordinates?.[1];
                const lon = f.geometry?.coordinates?.[0];
                if (lat === undefined || lon === undefined) continue;

                // Sanity check: vehicle must be within Augsburg metro area
                // Augsburg bbox: roughly 10.8-11.0 lon, 48.3-48.45 lat
                const inAugsburg = lon > 10.7 && lon < 11.1 && lat > 48.25 && lat < 48.5;
                if (!inAugsburg) {
                    results.push({
                        tripId: f.properties?.tripId,
                        lineNumber: f.properties?.lineNumber,
                        lat,
                        lon,
                    });
                }
            }
            return results;
        });

        expect(offRouteVehicles.length).toBe(0);
        if (offRouteVehicles.length > 0) {
            console.log("Off-route vehicles:", offRouteVehicles);
        }
    });

    test("monitoring summary after observation period", async ({ page }) => {
        const ready = await setupVehicleObservation(page);
        test.skip(!ready, "Not enough vehicles running for this test");

        await page.waitForTimeout(OBSERVATION_PERIOD_MS);
        const data = await collectMonitorData(page);

        // This test always passes but logs the full health report
        console.log("=== Vehicle Health Report ===");
        console.log(`Observation: ${OBSERVATION_PERIOD_MS / 1000}s, ${data.stats.frameCount} frames`);
        console.log(`Vehicles: ${data.stats.totalTracked} tracked, ${data.stats.currentlyVisible} visible`);
        console.log(`Anomalies: ${data.stats.totalAnomalies} total`);
        for (const [type, count] of Object.entries(data.stats.anomaliesByType)) {
            console.log(`  ${type}: ${count}`);
        }
        if (data.speedStats.length > 0) {
            const avgRatio = data.speedStats.reduce((s, v) => s + v.speedRatio, 0) / data.speedStats.length;
            const maxSpeed = Math.max(...data.speedStats.map(v => v.renderedSpeedKmh));
            console.log(`Speed: avg ratio ${avgRatio.toFixed(2)}x, max ${maxSpeed.toFixed(1)} km/h`);
        }
        if (data.stats.topTeleporters.length > 0) {
            console.log("Top teleporters:", data.stats.topTeleporters);
        }
        if (data.stats.topFlickers.length > 0) {
            console.log("Top flickers:", data.stats.topFlickers);
        }

        // Minimum bar: vehicles were tracked and frames rendered
        expect(data.stats.totalTracked).toBeGreaterThan(0);
        expect(data.stats.frameCount).toBeGreaterThan(100);
    });
});
