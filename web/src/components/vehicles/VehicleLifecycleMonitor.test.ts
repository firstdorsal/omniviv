import { describe, it, expect, beforeEach, vi } from "vitest";
import { VehicleLifecycleMonitor, type VehicleSnapshot, type Anomaly } from "./VehicleLifecycleMonitor";

function makeSnapshot(overrides: Partial<VehicleSnapshot> = {}): VehicleSnapshot {
    return {
        lon: 10.9,
        lat: 48.37,
        linearPosition: 500,
        status: "in_transit",
        routeId: 1,
        ...overrides,
    };
}

describe("VehicleLifecycleMonitor", () => {
    let monitor: VehicleLifecycleMonitor;
    let anomalies: Anomaly[];

    beforeEach(() => {
        monitor = new VehicleLifecycleMonitor();
        monitor.enabled = true;
        anomalies = [];
        monitor.setAnomalyCallback((a) => anomalies.push(a));
    });

    describe("basic tracking", () => {
        it("tracks new vehicles on first appearance", () => {
            const active = new Map([["trip-1", makeSnapshot()]]);
            monitor.update(active);

            const stats = monitor.getStats();
            expect(stats.totalTracked).toBe(1);
            expect(stats.currentlyVisible).toBe(1);
            expect(stats.frameCount).toBe(1);
        });

        it("tracks multiple vehicles", () => {
            const active = new Map([
                ["trip-1", makeSnapshot()],
                ["trip-2", makeSnapshot({ linearPosition: 800 })],
            ]);
            monitor.update(active);

            expect(monitor.getStats().totalTracked).toBe(2);
            expect(monitor.getStats().currentlyVisible).toBe(2);
        });

        it("returns vehicle details via getVehicle", () => {
            const active = new Map([["trip-1", makeSnapshot()]]);
            monitor.update(active);

            const v = monitor.getVehicle("trip-1");
            expect(v).toBeDefined();
            expect(v!.tripId).toBe("trip-1");
            expect(v!.isVisible).toBe(true);
        });

        it("clears all data", () => {
            const active = new Map([["trip-1", makeSnapshot()]]);
            monitor.update(active);
            monitor.clear();

            expect(monitor.getStats().totalTracked).toBe(0);
            expect(monitor.getStats().totalAnomalies).toBe(0);
            expect(monitor.getStats().frameCount).toBe(0);
        });
    });

    describe("ghost removal detection", () => {
        it("detects ghost removal when vehicle disappears with non-completed status", () => {
            const active = new Map([["trip-1", makeSnapshot({ status: "in_transit" })]]);
            monitor.update(active);

            // Vehicle disappears
            monitor.update(new Map());

            expect(anomalies).toHaveLength(1);
            expect(anomalies[0].type).toBe("ghost_removal");
            expect(anomalies[0].tripId).toBe("trip-1");
            expect(anomalies[0].details).toContain("in_transit");
        });

        it("does not flag ghost removal when vehicle completes normally", () => {
            const active = new Map([["trip-1", makeSnapshot({ status: "completed" })]]);
            monitor.update(active);

            // Vehicle disappears after completing
            monitor.update(new Map());

            expect(anomalies).toHaveLength(0);
        });
    });

    describe("flicker detection", () => {
        it("detects flicker when vehicle reappears within threshold", () => {
            // Appear
            monitor.update(new Map([["trip-1", makeSnapshot()]]));
            // Disappear (triggers ghost_removal)
            monitor.update(new Map());

            // Reappear quickly (within 5s threshold — performance.now() barely advances in sync tests)
            monitor.update(new Map([["trip-1", makeSnapshot()]]));

            const flickers = anomalies.filter(a => a.type === "flicker");
            expect(flickers).toHaveLength(1);
            expect(flickers[0].tripId).toBe("trip-1");
        });

        it("does not flag flicker if vehicle was gone for a long time", () => {
            monitor.update(new Map([["trip-1", makeSnapshot()]]));
            monitor.update(new Map()); // disappear

            // Simulate passage of time — mock performance.now to return 10s later
            const originalNow = performance.now;
            const baseTime = originalNow.call(performance);
            vi.spyOn(performance, "now").mockReturnValue(baseTime + 10_000);

            monitor.update(new Map([["trip-1", makeSnapshot()]]));

            const flickers = anomalies.filter(a => a.type === "flicker");
            expect(flickers).toHaveLength(0);

            vi.restoreAllMocks();
        });

        it("counts multiple flickers correctly", () => {
            for (let i = 0; i < 3; i++) {
                monitor.update(new Map([["trip-1", makeSnapshot()]]));
                monitor.update(new Map()); // disappear
            }
            // Final reappear
            monitor.update(new Map([["trip-1", makeSnapshot()]]));

            const v = monitor.getVehicle("trip-1");
            expect(v!.flickerCount).toBe(3);
        });
    });

    describe("teleport detection", () => {
        it("detects teleport when position jumps > 80m on same route", () => {
            monitor.update(new Map([["trip-1", makeSnapshot({ linearPosition: 500, routeId: 1 })]]));
            monitor.update(new Map([["trip-1", makeSnapshot({ linearPosition: 600, routeId: 1 })]]));

            const teleports = anomalies.filter(a => a.type === "teleport");
            expect(teleports).toHaveLength(1);
            expect(teleports[0].details).toContain("100m");
        });

        it("does not flag teleport on route change", () => {
            monitor.update(new Map([["trip-1", makeSnapshot({ linearPosition: 500, routeId: 1 })]]));
            monitor.update(new Map([["trip-1", makeSnapshot({ linearPosition: 600, routeId: 2 })]]));

            const teleports = anomalies.filter(a => a.type === "teleport");
            expect(teleports).toHaveLength(0);
        });

        it("does not flag teleport for movements under threshold", () => {
            monitor.update(new Map([["trip-1", makeSnapshot({ linearPosition: 500, routeId: 1 })]]));
            monitor.update(new Map([["trip-1", makeSnapshot({ linearPosition: 570, routeId: 1 })]]));

            const teleports = anomalies.filter(a => a.type === "teleport");
            expect(teleports).toHaveLength(0);
        });
    });

    describe("stuck detection", () => {
        it("detects stuck vehicle after time threshold", () => {
            const originalNow = performance.now;
            const baseTime = originalNow.call(performance);

            vi.spyOn(performance, "now").mockReturnValue(baseTime);
            monitor.update(new Map([["trip-1", makeSnapshot({ status: "in_transit", linearPosition: 500 })]]));

            // Jump 31 seconds ahead with barely any movement
            vi.spyOn(performance, "now").mockReturnValue(baseTime + 31_000);
            monitor.update(new Map([["trip-1", makeSnapshot({ status: "in_transit", linearPosition: 501 })]]));

            const stuck = anomalies.filter(a => a.type === "stuck");
            expect(stuck).toHaveLength(1);
            expect(stuck[0].details).toContain("in_transit");

            vi.restoreAllMocks();
        });

        it("does not flag stuck for at_stop vehicles", () => {
            const originalNow = performance.now;
            const baseTime = originalNow.call(performance);

            vi.spyOn(performance, "now").mockReturnValue(baseTime);
            monitor.update(new Map([["trip-1", makeSnapshot({ status: "at_stop", linearPosition: 500 })]]));

            vi.spyOn(performance, "now").mockReturnValue(baseTime + 31_000);
            monitor.update(new Map([["trip-1", makeSnapshot({ status: "at_stop", linearPosition: 500 })]]));

            const stuck = anomalies.filter(a => a.type === "stuck");
            expect(stuck).toHaveLength(0);

            vi.restoreAllMocks();
        });
    });

    describe("rapid status change detection", () => {
        it("detects rapid status changes", () => {
            const statuses = ["in_transit", "at_stop", "in_transit", "approaching", "at_stop", "in_transit", "approaching"];

            for (const status of statuses) {
                monitor.update(new Map([["trip-1", makeSnapshot({ status })]]));
            }

            const rapid = anomalies.filter(a => a.type === "rapid_status_change");
            expect(rapid.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe("anomaly ring buffer", () => {
        it("limits anomalies to MAX_ANOMALIES (500)", () => {
            // Generate many ghost_removal anomalies
            for (let i = 0; i < 600; i++) {
                const tripId = `trip-${i}`;
                monitor.update(new Map([[tripId, makeSnapshot({ status: "in_transit" })]]));
                monitor.update(new Map()); // disappear triggers ghost_removal
            }

            expect(monitor.getAnomalies(1000).length).toBeLessThanOrEqual(500);
        });
    });

    describe("query API", () => {
        it("getAnomalies returns last N anomalies", () => {
            // Generate a few anomalies
            for (let i = 0; i < 5; i++) {
                const tripId = `trip-${i}`;
                monitor.update(new Map([[tripId, makeSnapshot()]]));
                monitor.update(new Map());
            }

            const last3 = monitor.getAnomalies(3);
            expect(last3).toHaveLength(3);
        });

        it("getAnomaliesByType filters correctly", () => {
            // Create a ghost removal
            monitor.update(new Map([["trip-1", makeSnapshot()]]));
            monitor.update(new Map());

            // Create a teleport
            monitor.update(new Map([["trip-2", makeSnapshot({ linearPosition: 100, routeId: 1 })]]));
            monitor.update(new Map([["trip-2", makeSnapshot({ linearPosition: 500, routeId: 1 })]]));

            const ghosts = monitor.getAnomaliesByType("ghost_removal");
            const teleports = monitor.getAnomaliesByType("teleport");
            expect(ghosts.length).toBeGreaterThanOrEqual(1);
            expect(teleports.length).toBeGreaterThanOrEqual(1);
            expect(ghosts.every(a => a.type === "ghost_removal")).toBe(true);
            expect(teleports.every(a => a.type === "teleport")).toBe(true);
        });

        it("getStats returns correct anomaliesByType counts", () => {
            monitor.update(new Map([["trip-1", makeSnapshot()]]));
            monitor.update(new Map()); // ghost removal

            const stats = monitor.getStats();
            expect(stats.anomaliesByType["ghost_removal"]).toBe(1);
        });

        it("getAll returns all tracked vehicles", () => {
            monitor.update(new Map([
                ["trip-1", makeSnapshot()],
                ["trip-2", makeSnapshot({ linearPosition: 800 })],
            ]));

            const all = monitor.getAll();
            expect(all.size).toBe(2);
        });
    });

    describe("gone vehicle pruning", () => {
        it("prunes oldest gone vehicles when exceeding MAX_GONE_VEHICLES", () => {
            // Create and then remove 250 vehicles (MAX_GONE_VEHICLES = 200)
            for (let i = 0; i < 250; i++) {
                monitor.update(new Map([[`trip-${i}`, makeSnapshot({ status: "completed" })]]));
            }
            // All disappear
            monitor.update(new Map());

            // Should have pruned down to 200 gone + 0 visible
            const stats = monitor.getStats();
            expect(stats.totalTracked).toBeLessThanOrEqual(200);
        });
    });

    describe("enabled flag", () => {
        it("does not track anything when disabled", () => {
            monitor.enabled = false;
            monitor.update(new Map([["trip-1", makeSnapshot()]]));

            expect(monitor.getStats().totalTracked).toBe(0);
            expect(monitor.getStats().frameCount).toBe(0);
        });

        it("resumes tracking when re-enabled", () => {
            monitor.enabled = false;
            monitor.update(new Map([["trip-1", makeSnapshot()]]));

            monitor.enabled = true;
            monitor.update(new Map([["trip-1", makeSnapshot()]]));

            expect(monitor.getStats().totalTracked).toBe(1);
            expect(monitor.getStats().frameCount).toBe(1);
        });
    });

    describe("anomaly callback", () => {
        it("invokes callback on each new anomaly", () => {
            const cb = vi.fn();
            monitor.setAnomalyCallback(cb);

            monitor.update(new Map([["trip-1", makeSnapshot()]]));
            monitor.update(new Map()); // ghost removal

            expect(cb).toHaveBeenCalledTimes(1);
            expect(cb).toHaveBeenCalledWith(expect.objectContaining({ type: "ghost_removal" }));
        });

        it("can remove callback by passing null", () => {
            const cb = vi.fn();
            monitor.setAnomalyCallback(cb);
            monitor.setAnomalyCallback(null);

            monitor.update(new Map([["trip-1", makeSnapshot()]]));
            monitor.update(new Map());

            expect(cb).not.toHaveBeenCalled();
        });
    });

    describe("speed anomaly detection", () => {
        it("does not flag speed anomaly when rendered speed matches schedule", () => {
            const originalNow = performance.now;
            const baseTime = originalNow.call(performance);

            vi.spyOn(performance, "now").mockReturnValue(baseTime);
            monitor.update(new Map([
                ["trip-1", makeSnapshot({
                    linearPosition: 500,
                    scheduleSpeedMps: 8.3,
                    distToNextStop: 200,
                    msToNextStop: 24000,
                })],
            ]));

            // 1 second later, moved ~8m (consistent with schedule speed of 8.3 m/s)
            vi.spyOn(performance, "now").mockReturnValue(baseTime + 1000);
            monitor.update(new Map([
                ["trip-1", makeSnapshot({
                    linearPosition: 508,
                    scheduleSpeedMps: 8.3,
                    distToNextStop: 192,
                    msToNextStop: 23000,
                })],
            ]));

            const speedAnomalies = anomalies.filter(a => a.type === "speed_anomaly");
            expect(speedAnomalies).toHaveLength(0);

            vi.restoreAllMocks();
        });

        it("flags speed anomaly when rendered speed greatly exceeds schedule", () => {
            const originalNow = performance.now;
            const baseTime = originalNow.call(performance);

            vi.spyOn(performance, "now").mockReturnValue(baseTime);
            monitor.update(new Map([
                ["trip-1", makeSnapshot({
                    linearPosition: 500,
                    scheduleSpeedMps: 8.3,
                    distToNextStop: 200,
                    msToNextStop: 24000,
                })],
            ]));

            // 1 second later, moved 50m (rendered ~50 m/s, schedule 8.3 m/s = 6x ratio)
            vi.spyOn(performance, "now").mockReturnValue(baseTime + 1000);
            monitor.update(new Map([
                ["trip-1", makeSnapshot({
                    linearPosition: 550,
                    scheduleSpeedMps: 8.3,
                    distToNextStop: 150,
                    msToNextStop: 23000,
                })],
            ]));

            const speedAnomalies = anomalies.filter(a => a.type === "speed_anomaly");
            expect(speedAnomalies).toHaveLength(1);
            expect(speedAnomalies[0].details).toContain("50.0 m/s");
            expect(speedAnomalies[0].details).toContain("8.3 m/s");

            vi.restoreAllMocks();
        });

        it("does not flag speed anomaly when schedule data is missing", () => {
            const originalNow = performance.now;
            const baseTime = originalNow.call(performance);

            vi.spyOn(performance, "now").mockReturnValue(baseTime);
            monitor.update(new Map([
                ["trip-1", makeSnapshot({ linearPosition: 500 })],
            ]));

            // Large jump but no schedule data — should not trigger
            vi.spyOn(performance, "now").mockReturnValue(baseTime + 1000);
            monitor.update(new Map([
                ["trip-1", makeSnapshot({ linearPosition: 600 })],
            ]));

            const speedAnomalies = anomalies.filter(a => a.type === "speed_anomaly");
            expect(speedAnomalies).toHaveLength(0);

            vi.restoreAllMocks();
        });

        it("does not flag speed anomaly at low rendered speeds", () => {
            const originalNow = performance.now;
            const baseTime = originalNow.call(performance);

            vi.spyOn(performance, "now").mockReturnValue(baseTime);
            monitor.update(new Map([
                ["trip-1", makeSnapshot({
                    linearPosition: 500,
                    scheduleSpeedMps: 1.0,
                    distToNextStop: 50,
                    msToNextStop: 50000,
                })],
            ]));

            // Moved 3m in 1s = 3 m/s. That's 3x schedule (1 m/s) but below 5 m/s minimum.
            vi.spyOn(performance, "now").mockReturnValue(baseTime + 1000);
            monitor.update(new Map([
                ["trip-1", makeSnapshot({
                    linearPosition: 503,
                    scheduleSpeedMps: 1.0,
                    distToNextStop: 47,
                    msToNextStop: 49000,
                })],
            ]));

            const speedAnomalies = anomalies.filter(a => a.type === "speed_anomaly");
            expect(speedAnomalies).toHaveLength(0);

            vi.restoreAllMocks();
        });

        it("tracks speed anomaly count per vehicle", () => {
            const originalNow = performance.now;
            const baseTime = originalNow.call(performance);

            vi.spyOn(performance, "now").mockReturnValue(baseTime);
            monitor.update(new Map([
                ["trip-1", makeSnapshot({
                    linearPosition: 500,
                    scheduleSpeedMps: 5.0,
                })],
            ]));

            // Two consecutive overspeeds
            for (let i = 1; i <= 2; i++) {
                vi.spyOn(performance, "now").mockReturnValue(baseTime + i * 1000);
                monitor.update(new Map([
                    ["trip-1", makeSnapshot({
                        linearPosition: 500 + i * 60,
                        scheduleSpeedMps: 5.0,
                    })],
                ]));
            }

            const v = monitor.getVehicle("trip-1");
            expect(v!.speedAnomalyCount).toBe(2);

            vi.restoreAllMocks();
        });
    });

    describe("getSpeedStats", () => {
        it("returns speed diagnostics for visible vehicles", () => {
            const originalNow = performance.now;
            const baseTime = originalNow.call(performance);

            vi.spyOn(performance, "now").mockReturnValue(baseTime);
            monitor.update(new Map([
                ["trip-1", makeSnapshot({
                    linearPosition: 500,
                    scheduleSpeedMps: 8.3,
                    distToNextStop: 200,
                    msToNextStop: 24000,
                })],
            ]));

            vi.spyOn(performance, "now").mockReturnValue(baseTime + 1000);
            monitor.update(new Map([
                ["trip-1", makeSnapshot({
                    linearPosition: 508,
                    scheduleSpeedMps: 8.3,
                    distToNextStop: 192,
                    msToNextStop: 23000,
                })],
            ]));

            const stats = monitor.getSpeedStats();
            expect(stats).toHaveLength(1);
            expect(stats[0].tripId).toBe("trip-1");
            expect(stats[0].renderedSpeedMps).toBeCloseTo(8.0, 0);
            expect(stats[0].renderedSpeedKmh).toBeCloseTo(28.8, 0);
            expect(stats[0].scheduleSpeedMps).toBe(8.3);
            expect(stats[0].scheduleSpeedKmh).toBeCloseTo(29.88, 0);
            expect(stats[0].distToNextStop).toBe(192);
            expect(stats[0].msToNextStop).toBe(23000);
            expect(stats[0].speedAnomalyCount).toBe(0);

            vi.restoreAllMocks();
        });

        it("excludes disappeared vehicles", () => {
            monitor.update(new Map([
                ["trip-1", makeSnapshot({ status: "completed" })],
            ]));
            monitor.update(new Map()); // disappear

            const stats = monitor.getSpeedStats();
            expect(stats).toHaveLength(0);
        });

        it("sorts by rendered speed descending", () => {
            const originalNow = performance.now;
            const baseTime = originalNow.call(performance);

            vi.spyOn(performance, "now").mockReturnValue(baseTime);
            monitor.update(new Map([
                ["trip-slow", makeSnapshot({ linearPosition: 100 })],
                ["trip-fast", makeSnapshot({ linearPosition: 200 })],
            ]));

            vi.spyOn(performance, "now").mockReturnValue(baseTime + 1000);
            monitor.update(new Map([
                ["trip-slow", makeSnapshot({ linearPosition: 105 })],  // 5 m/s
                ["trip-fast", makeSnapshot({ linearPosition: 215 })],  // 15 m/s
            ]));

            const stats = monitor.getSpeedStats();
            expect(stats).toHaveLength(2);
            expect(stats[0].tripId).toBe("trip-fast");
            expect(stats[1].tripId).toBe("trip-slow");

            vi.restoreAllMocks();
        });
    });
});
