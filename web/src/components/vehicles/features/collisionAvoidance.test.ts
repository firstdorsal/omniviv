import { describe, it, expect, beforeEach } from "vitest";
import {
    computePositionCaps,
    COLLISION_AVOIDANCE_FEATURE_ID,
    MIN_VEHICLE_SEPARATION,
    _resetFollowerStates,
} from "./collisionAvoidance";
import type { LinearizedRoute, SmoothedVehiclePosition } from "../vehicleUtils";
import { getPositionAtDistance } from "../vehicleUtils";

// --- Helpers ---

function makeStraightRoute(lengthMeters: number, startLon = 10.0): LinearizedRoute {
    const degreesPerMeter = 1 / 74000;
    const numPoints = 100;
    const coords: number[][] = [];
    const distances: number[] = [];
    for (let i = 0; i <= numPoints; i++) {
        const frac = i / numPoints;
        coords.push([startLon + frac * lengthMeters * degreesPerMeter, 48.0]);
        distances.push(frac * lengthMeters);
    }
    return { coords, distances, totalLength: lengthMeters };
}

function makeDivergingRoute(sharedLength: number, divergedLength: number): LinearizedRoute {
    const degLon = 1 / 74000;
    const degLat = 1 / 111320;
    const n1 = 50, n2 = 50;
    const coords: number[][] = [];
    const distances: number[] = [];
    let total = 0;

    for (let i = 0; i <= n1; i++) {
        const frac = i / n1;
        const lon = 10.0 + frac * sharedLength * degLon;
        if (coords.length > 0) total += Math.abs((lon - coords[coords.length - 1][0]) * 74000);
        coords.push([lon, 48.0]);
        distances.push(total);
    }
    const lastLon = coords[coords.length - 1][0];
    for (let i = 1; i <= n2; i++) {
        const frac = i / n2;
        const lat = 48.0 + frac * divergedLength * degLat;
        total += Math.abs((lat - coords[coords.length - 1][1]) * 111320);
        coords.push([lastLon, lat]);
        distances.push(total);
    }
    return { coords, distances, totalLength: total };
}

function makeSmoothedPosition(
    tripId: string,
    linearPosition: number,
    lineNumber = "1",
    bearing = 90,
    status: SmoothedVehiclePosition["status"] = "in_transit",
): SmoothedVehiclePosition {
    const degPerM = 1 / 74000;
    const lon = 10.0 + linearPosition * degPerM;
    return {
        tripId,
        lineNumber,
        destination: "Test",
        lon, lat: 48.0,
        bearing,
        status,
        progress: 0.5,
        delayMinutes: null,
        renderedLon: lon,
        renderedLat: 48.0,
        renderedBearing: bearing,
        lastUpdateTime: Date.now(),
        renderedLinearPosition: linearPosition,
    };
}

/**
 * Simulate one frame: compute caps, apply them to smoothed positions.
 * Returns the effective linear positions after capping.
 * Mirrors the logic in VehicleRenderer.renderFrame().
 */
function applyFrame(
    infos: Array<{ tripId: string; routeId: number; lineNumber: string }>,
    smoothed: Map<string, SmoothedVehiclePosition>,
    routes: Map<number, LinearizedRoute>,
): Map<string, number> {
    const caps = computePositionCaps(infos, smoothed, routes);
    const result = new Map<string, number>();

    for (const { tripId, routeId } of infos) {
        const sp = smoothed.get(tripId);
        if (!sp || sp.renderedLinearPosition === undefined) continue;

        let pos = sp.renderedLinearPosition;
        const cap = caps.get(tripId);
        if (cap) {
            const route = routes.get(routeId);
            if (route) {
                // Never backwards: effectiveCap = max(cap, current)
                const effectiveCap = Math.max(cap.maxLinearPosition, pos);
                if (pos > effectiveCap) pos = effectiveCap;
            }
        }
        result.set(tripId, pos);
    }
    return result;
}

// --- Tests ---

describe("collisionAvoidanceFeature", () => {
    const route = makeStraightRoute(2000);
    const routes = new Map([[1, route]]);

    beforeEach(() => {
        _resetFollowerStates();
    });

    it("has correct feature ID", () => {
        expect(COLLISION_AVOIDANCE_FEATURE_ID).toBe("collision-avoidance");
    });

    describe("computePositionCaps", () => {
        it("returns no caps for far-apart vehicles", () => {
            const smoothed = new Map([
                ["a", makeSmoothedPosition("a", 400)],
                ["b", makeSmoothedPosition("b", 600)],
            ]);
            const infos = [
                { tripId: "a", routeId: 1, lineNumber: "1" },
                { tripId: "b", routeId: 1, lineNumber: "1" },
            ];
            const caps = computePositionCaps(infos, smoothed, routes);
            expect(caps.size).toBe(0);
        });

        it("returns no caps for opposite-direction vehicles", () => {
            const smoothed = new Map([
                ["out", makeSmoothedPosition("out", 498, "1", 90)],
                ["in", makeSmoothedPosition("in", 500, "1", 270)],
            ]);
            const infos = [
                { tripId: "out", routeId: 1, lineNumber: "1" },
                { tripId: "in", routeId: 1, lineNumber: "1" },
            ];
            const caps = computePositionCaps(infos, smoothed, routes);
            expect(caps.size).toBe(0);
        });

        it("caps follower behind leader on same route", () => {
            const smoothed = new Map([
                ["behind", makeSmoothedPosition("behind", 490)],
                ["ahead", makeSmoothedPosition("ahead", 500)],
            ]);
            const infos = [
                { tripId: "behind", routeId: 1, lineNumber: "1" },
                { tripId: "ahead", routeId: 1, lineNumber: "1" },
            ];
            const caps = computePositionCaps(infos, smoothed, routes);

            // behind is follower → has cap, ahead is leader → no cap
            expect(caps.has("behind")).toBe(true);
            expect(caps.has("ahead")).toBe(false);

            // Cap should be leader position - MIN_VEHICLE_SEPARATION
            expect(caps.get("behind")!.maxLinearPosition).toBeCloseTo(500 - MIN_VEHICLE_SEPARATION, 0);
        });

        it("line 2 follows line 6 (higher line number leads)", () => {
            const route2 = makeStraightRoute(2000);
            const multiRoutes = new Map([[1, route], [2, route2]]);
            const smoothed = new Map([
                ["line2", makeSmoothedPosition("line2", 502, "2")],
                ["line6", makeSmoothedPosition("line6", 500, "6")],
            ]);
            const infos = [
                { tripId: "line2", routeId: 1, lineNumber: "2" },
                { tripId: "line6", routeId: 2, lineNumber: "6" },
            ];
            const caps = computePositionCaps(infos, smoothed, multiRoutes);

            expect(caps.has("line2")).toBe(true);  // follower
            expect(caps.has("line6")).toBe(false);  // leader
        });

        it("does not cap at_stop vehicles", () => {
            const smoothed = new Map([
                ["stopped", makeSmoothedPosition("stopped", 498, "2", 90, "at_stop")],
                ["leader", makeSmoothedPosition("leader", 500, "6")],
            ]);
            const infos = [
                { tripId: "stopped", routeId: 1, lineNumber: "2" },
                { tripId: "leader", routeId: 1, lineNumber: "6" },
            ];
            const caps = computePositionCaps(infos, smoothed, routes);
            expect(caps.has("stopped")).toBe(false);
        });

        it("does not cap vehicles on diverged routes", () => {
            const straight = makeStraightRoute(2000);
            const diverging = makeDivergingRoute(500, 1500);
            const multiRoutes = new Map([[1, straight], [2, diverging]]);

            const degLon = 1 / 74000;
            const degLat = 1 / 111320;
            const smoothed = new Map([
                ["a", makeSmoothedPosition("a", 600, "2")],
                ["b", (() => {
                    const sp = makeSmoothedPosition("b", 600, "6");
                    sp.renderedLon = 10.0 + 500 * degLon;
                    sp.renderedLat = 48.0 + 100 * degLat;
                    return sp;
                })()],
            ]);
            const infos = [
                { tripId: "a", routeId: 1, lineNumber: "2" },
                { tripId: "b", routeId: 2, lineNumber: "6" },
            ];
            const caps = computePositionCaps(infos, smoothed, multiRoutes);
            expect(caps.size).toBe(0);
        });
    });

    describe("cap application (never backwards)", () => {
        it("does not push vehicle backwards when cap is behind current position", () => {
            // Follower at 490, leader at 500 → cap = 450.
            // Since 450 < 490, effectiveCap = max(450, 490) = 490.
            // Vehicle stays at 490 (frozen, NOT pushed back to 450).
            const smoothed = new Map([
                ["f", makeSmoothedPosition("f", 490, "2")],
                ["l", makeSmoothedPosition("l", 500, "6")],
            ]);
            const infos = [
                { tripId: "f", routeId: 1, lineNumber: "2" },
                { tripId: "l", routeId: 1, lineNumber: "6" },
            ];
            const result = applyFrame(infos, smoothed, routes);

            // Must be >= 490 (never backwards)
            expect(result.get("f")!).toBeGreaterThanOrEqual(490);
        });

        it("caps forward movement when vehicle would advance past safe distance", () => {
            // Simulate: follower was at 440 last frame (behind cap of 450).
            // After smoothing it would advance to e.g. 460.
            // Cap = 500 - 50 = 450. Since 450 > 440 (prev), effectiveCap = 450.
            // Vehicle is capped at 450 (prevented from reaching 460).
            const smoothed = new Map([
                ["f", makeSmoothedPosition("f", 460, "2")], // "after smoothing"
                ["l", makeSmoothedPosition("l", 500, "6")],
            ]);
            // Store the "previous" position to simulate the Math.max logic
            smoothed.get("f")!.renderedLinearPosition = 460;

            const infos = [
                { tripId: "f", routeId: 1, lineNumber: "2" },
                { tripId: "l", routeId: 1, lineNumber: "6" },
            ];
            const caps = computePositionCaps(infos, smoothed, routes);

            // The cap should exist and be ~450
            expect(caps.has("f")).toBe(true);
            expect(caps.get("f")!.maxLinearPosition).toBeCloseTo(450, 0);
        });

        it("allows vehicle to advance freely when cap is ahead", () => {
            // Follower at 300, leader at 500 → cap = 450.
            // 300 < 450, so no capping needed.
            const smoothed = new Map([
                ["f", makeSmoothedPosition("f", 300, "2")],
                ["l", makeSmoothedPosition("l", 500, "6")],
            ]);
            const infos = [
                { tripId: "f", routeId: 1, lineNumber: "2" },
                { tripId: "l", routeId: 1, lineNumber: "6" },
            ];
            const result = applyFrame(infos, smoothed, routes);

            // Vehicle freely at 300 (cap 450 is ahead)
            expect(result.get("f")!).toBe(300);
        });
    });
});
