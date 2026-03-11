import { describe, it, expect } from "vitest";
import { collisionAvoidanceFeature, SEPARATION_DISTANCE, MIN_SPEED_MULTIPLIER, MAX_SPEED_MULTIPLIER } from "./collisionAvoidance";
import type { VehicleRenderContext } from "./types";
import type { LinearizedRoute, SmoothedVehiclePosition } from "../vehicleUtils";

// --- Helpers ---

function makeStraightRoute(lengthMeters: number): LinearizedRoute {
    const degreesPerMeter = 1 / 74000;
    const startLon = 10.0;
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

/**
 * Create a vehicle context with rendered position at a specific point along a route.
 * Both vehicles on the same route and different routes use the same coordinate system
 * to simulate shared physical track.
 */
function makeVehicle(
    tripId: string,
    routeId: number,
    linearPosition: number,
    bearing = 90,
    status: SmoothedVehiclePosition["status"] = "in_transit",
): VehicleRenderContext {
    // Place the rendered position along the route (west→east at lat=48)
    const degreesPerMeter = 1 / 74000;
    const renderedLon = 10.0 + linearPosition * degreesPerMeter;
    const renderedLat = 48.0;

    return {
        tripId,
        routeId,
        linearPosition,
        smoothedPosition: {
            tripId,
            lineNumber: "1",
            destination: "Test",
            lon: renderedLon,
            lat: renderedLat,
            bearing,
            status,
            progress: 0.5,
            delayMinutes: null,
            renderedLon,
            renderedLat,
            renderedBearing: bearing,
            lastUpdateTime: Date.now(),
            renderedLinearPosition: linearPosition,
        },
    };
}

function computeAdjustments(
    vehicles: VehicleRenderContext[],
    routes: Map<number, LinearizedRoute>,
): Map<string, number> {
    return collisionAvoidanceFeature.computeSpeedAdjustments(vehicles, routes);
}

// --- Tests ---

describe("collisionAvoidanceFeature", () => {
    const route = makeStraightRoute(2000);
    const routes = new Map([[1, route]]);

    describe("basic behavior", () => {
        it("returns no adjustments when vehicles are far apart", () => {
            const vehicles = [
                makeVehicle("a", 1, 500),
                makeVehicle("b", 1, 600),
            ];

            const result = computeAdjustments(vehicles, routes);

            expect(result.size).toBe(0);
        });

        it("slows follower and speeds leader when too close", () => {
            // 10m apart < SEPARATION_DISTANCE (40m)
            const vehicles = [
                makeVehicle("follower", 1, 490),
                makeVehicle("leader", 1, 500),
            ];

            const result = computeAdjustments(vehicles, routes);

            const followerSpeed = result.get("follower")!;
            const leaderSpeed = result.get("leader")!;

            expect(followerSpeed).toBeLessThan(1.0);
            expect(leaderSpeed).toBeGreaterThan(1.0);
        });

        it("applies stronger adjustments for closer vehicles", () => {
            // Very close (5m)
            const closeVehicles = [
                makeVehicle("close-follower", 1, 495),
                makeVehicle("close-leader", 1, 500),
            ];

            // Moderately close (30m)
            const moderateVehicles = [
                makeVehicle("mod-follower", 1, 470),
                makeVehicle("mod-leader", 1, 500),
            ];

            const closeResult = computeAdjustments(closeVehicles, routes);
            const modResult = computeAdjustments(moderateVehicles, routes);

            const closeFollowerSpeed = closeResult.get("close-follower")!;
            const modFollowerSpeed = modResult.get("mod-follower")!;

            // Closer vehicles should have more extreme adjustments
            expect(closeFollowerSpeed).toBeLessThan(modFollowerSpeed);
        });

        it("returns max adjustment at distance zero", () => {
            const vehicles = [
                makeVehicle("follower", 1, 500),
                makeVehicle("leader", 1, 500),
            ];

            const result = computeAdjustments(vehicles, routes);

            // One of them should get MIN_SPEED_MULTIPLIER
            const speeds = [...result.values()];
            const minSpeed = Math.min(...speeds);
            const maxSpeed = Math.max(...speeds);

            expect(minSpeed).toBeCloseTo(MIN_SPEED_MULTIPLIER, 2);
            expect(maxSpeed).toBeCloseTo(MAX_SPEED_MULTIPLIER, 2);
        });

        it("handles single vehicle (no adjustments)", () => {
            const vehicles = [makeVehicle("solo", 1, 500)];

            const result = computeAdjustments(vehicles, routes);

            expect(result.size).toBe(0);
        });
    });

    describe("direction and status filtering", () => {
        it("does not adjust vehicles traveling in opposite directions", () => {
            const vehicles = [
                makeVehicle("outbound", 1, 498, 90),
                makeVehicle("inbound", 1, 500, 270),
            ];

            const result = computeAdjustments(vehicles, routes);

            expect(result.size).toBe(0);
        });

        it("adjusts vehicles at exactly 90° bearing difference", () => {
            const vehicles = [
                makeVehicle("follower", 1, 498, 45),
                makeVehicle("leader", 1, 500, 135),
            ];

            const result = computeAdjustments(vehicles, routes);

            // 135 - 45 = 90° which is NOT > 90, so they ARE adjusted
            expect(result.size).toBeGreaterThan(0);
        });

        it("does not adjust at 91° bearing difference", () => {
            const vehicles = [
                makeVehicle("follower", 1, 498, 44),
                makeVehicle("leader", 1, 500, 135),
            ];

            const result = computeAdjustments(vehicles, routes);

            expect(result.size).toBe(0);
        });

        it("does not slow down at_stop vehicles", () => {
            const vehicles = [
                makeVehicle("stopped", 1, 498, 90, "at_stop"),
                makeVehicle("leader", 1, 500),
            ];

            const result = computeAdjustments(vehicles, routes);

            // Leader may get a speed boost, but stopped vehicle should not be slowed
            expect(result.has("stopped")).toBe(false);
        });

        it("does not speed up at_stop leaders", () => {
            const vehicles = [
                makeVehicle("follower", 1, 498),
                makeVehicle("stopped-leader", 1, 500, 90, "at_stop"),
            ];

            const result = computeAdjustments(vehicles, routes);

            // Follower gets slowed, but the stopped leader should not be sped up
            expect(result.get("follower")).toBeLessThan(1.0);
            expect(result.has("stopped-leader")).toBe(false);
        });

        it("does not adjust waiting vehicles", () => {
            const vehicles = [
                makeVehicle("waiting", 1, 498, 90, "waiting"),
                makeVehicle("leader", 1, 500),
            ];

            const result = computeAdjustments(vehicles, routes);

            expect(result.has("waiting")).toBe(false);
        });

        it("does not speed up waiting leaders", () => {
            const vehicles = [
                makeVehicle("follower", 1, 498),
                makeVehicle("waiting-leader", 1, 500, 90, "waiting"),
            ];

            const result = computeAdjustments(vehicles, routes);

            expect(result.get("follower")).toBeLessThan(1.0);
            expect(result.has("waiting-leader")).toBe(false);
        });
    });

    describe("cross-route separation", () => {
        it("separates vehicles on different routes sharing the same track", () => {
            const route2 = makeStraightRoute(2000);
            const multiRoutes = new Map([
                [1, route],
                [2, route2],
            ]);

            // Lines 4 and 6 on the same physical track, very close
            const vehicles = [
                makeVehicle("line4", 1, 498),
                makeVehicle("line6", 2, 500),
            ];

            const result = computeAdjustments(vehicles, multiRoutes);

            // Cross-route: should still detect proximity and adjust
            const line4Speed = result.get("line4")!;
            const line6Speed = result.get("line6")!;

            expect(line4Speed).toBeLessThan(1.0);
            expect(line6Speed).toBeGreaterThan(1.0);
        });

        it("does not separate cross-route vehicles that are far apart", () => {
            const route2 = makeStraightRoute(2000);
            const multiRoutes = new Map([
                [1, route],
                [2, route2],
            ]);

            const vehicles = [
                makeVehicle("a", 1, 400),
                makeVehicle("b", 2, 500),
            ];

            const result = computeAdjustments(vehicles, multiRoutes);

            expect(result.size).toBe(0);
        });
    });

    describe("multiple vehicle interactions", () => {
        it("applies the strongest slowdown when a vehicle is close to multiple others", () => {
            // Vehicle at 500 is close to vehicles at 498 and 502 (on different routes)
            const route2 = makeStraightRoute(2000);
            const route3 = makeStraightRoute(2000);
            const multiRoutes = new Map([
                [1, route],
                [2, route2],
                [3, route3],
            ]);

            const vehicles = [
                makeVehicle("behind", 1, 498),
                makeVehicle("middle", 2, 500),
                makeVehicle("ahead", 3, 502),
            ];

            const result = computeAdjustments(vehicles, multiRoutes);

            // "behind" should be slowed (follower to both "middle" and "ahead")
            expect(result.get("behind")).toBeLessThan(1.0);
        });

        it("handles three same-route vehicles bunched up", () => {
            const vehicles = [
                makeVehicle("c", 1, 495),
                makeVehicle("b", 1, 498),
                makeVehicle("a", 1, 500),
            ];

            const result = computeAdjustments(vehicles, routes);

            // c should be slowed (close to b), b should be slowed (close to a)
            // a should be sped up (close to b)
            expect(result.get("c")).toBeLessThan(1.0);
            expect(result.get("a")).toBeGreaterThan(1.0);
        });
    });
});
