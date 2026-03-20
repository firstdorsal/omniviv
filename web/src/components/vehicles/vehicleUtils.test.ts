import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Vehicle, VehicleStop } from "../../api";
import {
    updateSmoothedPosition,
    createSmoothedPosition,
    easeInOutProgress,
    calculateVehiclePosition,
    linearizeRoute,
    getPositionAtDistance,
    type VehiclePosition,
    type SmoothedVehiclePosition,
} from "./vehicleUtils";

// Mock the features module so that featureManager.isEnabled always returns false
// (simulated stops disabled) for deterministic tests
vi.mock("./features", () => ({
    featureManager: { isEnabled: () => false },
    shouldStopAtStation: () => false,
    getDwellTimeMs: () => 20000,
}));

// --- Helpers ---

function makeStop(overrides: Partial<VehicleStop> & { lat: number; lon: number; sequence: number; stop_ifopt: string }): VehicleStop {
    return {
        arrival_time: null,
        arrival_time_estimated: null,
        delay_minutes: null,
        departure_time: null,
        departure_time_estimated: null,
        stop_name: null,
        ...overrides,
    };
}

function makeVehicle(stops: VehicleStop[]): Vehicle {
    return {
        trip_id: "trip_1",
        line_number: "U1",
        destination: "Central Station",
        stops,
    };
}

function makePosition(overrides: Partial<VehiclePosition> = {}): VehiclePosition {
    return {
        tripId: "trip_1",
        lineNumber: "U1",
        destination: "Central Station",
        lon: 10.0,
        lat: 48.0,
        bearing: 90,
        status: "in_transit",
        progress: 0.5,
        delayMinutes: null,
        ...overrides,
    };
}

function makeSmoothed(overrides: Partial<SmoothedVehiclePosition> = {}): SmoothedVehiclePosition {
    const target = makePosition(overrides);
    return {
        ...target,
        renderedLon: overrides.renderedLon ?? target.lon,
        renderedLat: overrides.renderedLat ?? target.lat,
        renderedBearing: overrides.renderedBearing ?? target.bearing,
        lastUpdateTime: Date.now(),
        renderedLinearPosition: undefined,
        ...overrides,
    };
}

// Simple route geometry: a straight line from (10,48) to (10.1,48.1)
const simpleRouteGeometry: number[][][] = [
    [
        [10.0, 48.0],
        [10.05, 48.05],
        [10.1, 48.1],
    ],
];

// --- updateSmoothedPosition tests ---

describe("updateSmoothedPosition", () => {
    it("snaps to target when distance > SNAP_DISTANCE_METERS (1000m)", () => {
        // Current position far from target (different city essentially)
        const current = makeSmoothed({
            renderedLon: 0.0,
            renderedLat: 0.0,
            renderedBearing: 0,
        });
        const target = makePosition({
            lon: 10.0,
            lat: 48.0,
            bearing: 180,
        });

        const result = updateSmoothedPosition(current, target, 16);

        // Should snap directly to target
        expect(result.renderedLon).toBe(target.lon);
        expect(result.renderedLat).toBe(target.lat);
        expect(result.renderedBearing).toBe(target.bearing);
    });

    it("smoothly interpolates toward target for small distances", () => {
        // Small offset - about 100m at this latitude
        const current = makeSmoothed({
            lon: 10.0,
            lat: 48.0,
            renderedLon: 10.0,
            renderedLat: 48.0,
            renderedBearing: 90,
        });
        const target = makePosition({
            lon: 10.001,
            lat: 48.001,
            bearing: 90,
        });

        const result = updateSmoothedPosition(current, target, 16);

        // With instant snap (moveFraction=1.0), position matches target exactly
        expect(result.renderedLon).toBe(10.001);
        expect(result.renderedLat).toBe(48.001);
    });

    it("bearing smoothing wraps around 360 correctly", () => {
        // Current bearing near 350, target near 10 (crossing 0/360 boundary)
        const current = makeSmoothed({
            lon: 10.0,
            lat: 48.0,
            renderedLon: 10.0,
            renderedLat: 48.0,
            renderedBearing: 350,
        });
        const target = makePosition({
            lon: 10.0,
            lat: 48.0,
            bearing: 10,
        });

        const result = updateSmoothedPosition(current, target, 100);

        // The bearing should go from 350 toward 10 through 360/0 (the short way)
        // So the result should be between 350 and 370(=10) modulo 360
        // i.e., either > 350 or < 10
        const b = result.renderedBearing;
        expect(b >= 350 || b <= 10).toBe(true);
    });

    it("bearing smoothing wraps correctly for large counter-clockwise difference", () => {
        // Current bearing near 10, target near 350 (should go counter-clockwise)
        const current = makeSmoothed({
            lon: 10.0,
            lat: 48.0,
            renderedLon: 10.0,
            renderedLat: 48.0,
            renderedBearing: 10,
        });
        const target = makePosition({
            lon: 10.0,
            lat: 48.0,
            bearing: 350,
        });

        const result = updateSmoothedPosition(current, target, 100);

        // Should move counter-clockwise from 10 toward 350 (through 0/360)
        const b = result.renderedBearing;
        expect(b >= 350 || b <= 10).toBe(true);
    });

    it("interpolates linear position along route when both values exist", () => {
        const current = makeSmoothed({
            lon: 10.0,
            lat: 48.0,
            renderedLon: 10.0,
            renderedLat: 48.0,
            renderedLinearPosition: 100,
        });
        const target = makePosition({
            lon: 10.0,
            lat: 48.0,
        });
        // Override routeLinearPosition on target
        target.routeLinearPosition = 200;

        const result = updateSmoothedPosition(current, target, 16);

        expect(result.renderedLinearPosition).toBeDefined();
        // With instant snap (moveFraction=1.0), position matches target exactly
        expect(result.renderedLinearPosition!).toBe(200);
    });
});

// --- easeInOutProgress tests ---

describe("easeInOutProgress", () => {
    it("returns 0 at progress=0", () => {
        expect(easeInOutProgress(0)).toBe(0);
    });

    it("returns 1 at progress=1", () => {
        expect(easeInOutProgress(1)).toBe(1);
    });

    it("returns 0 for negative progress", () => {
        expect(easeInOutProgress(-0.5)).toBe(0);
    });

    it("returns 1 for progress > 1", () => {
        expect(easeInOutProgress(1.5)).toBe(1);
    });

    it("returns reasonable value at midpoint (0.5)", () => {
        const result = easeInOutProgress(0.5);
        // In the cruising phase (linear), should be 0.5
        expect(result).toBe(0.5);
    });

    it("acceleration phase (< 0.05): output is less than or equal to linear", () => {
        const p = 0.03;
        const result = easeInOutProgress(p);
        // In acceleration phase, should be eased (smoother start)
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(0.05);
    });

    it("deceleration phase (> 0.95): output approaches 1 smoothly", () => {
        const p = 0.97;
        const result = easeInOutProgress(p);
        expect(result).toBeGreaterThanOrEqual(0.95);
        expect(result).toBeLessThanOrEqual(1);
    });

    it("transitions smoothly at phase boundary 0.05", () => {
        const justBefore = easeInOutProgress(0.049);
        const atBoundary = easeInOutProgress(0.05);
        const justAfter = easeInOutProgress(0.051);

        // At the boundary of accel/cruise, the value should be continuous
        // accelEnd * smoothstep(t) where t=1 -> accelEnd * 1 = 0.05
        expect(atBoundary).toBeCloseTo(0.05, 5);
        expect(justBefore).toBeLessThan(atBoundary);
        expect(justAfter).toBeGreaterThan(atBoundary);
    });

    it("transitions smoothly at phase boundary 0.95", () => {
        const justBefore = easeInOutProgress(0.949);
        const atBoundary = easeInOutProgress(0.95);
        const justAfter = easeInOutProgress(0.951);

        expect(atBoundary).toBeCloseTo(0.95, 5);
        expect(justBefore).toBeLessThan(atBoundary);
        expect(justAfter).toBeGreaterThan(atBoundary);
    });

    it("is monotonically increasing", () => {
        let prev = 0;
        for (let p = 0; p <= 1; p += 0.01) {
            const val = easeInOutProgress(p);
            expect(val).toBeGreaterThanOrEqual(prev);
            prev = val;
        }
    });
});

// --- calculateVehiclePosition tests ---

describe("calculateVehiclePosition", () => {
    it("returns null with empty stops array", () => {
        const vehicle = makeVehicle([]);
        const result = calculateVehiclePosition(vehicle, simpleRouteGeometry);
        expect(result).toBeNull();
    });

    it("returns null with only one stop", () => {
        const vehicle = makeVehicle([
            makeStop({ lat: 48.0, lon: 10.0, sequence: 1, stop_ifopt: "de:1:1", departure_time: "2026-01-01T08:00:00Z" }),
        ]);
        const result = calculateVehiclePosition(vehicle, simpleRouteGeometry);
        expect(result).toBeNull();
    });

    it("returns at_stop status when current time is between arrival and departure", () => {
        const now = new Date("2026-01-01T08:05:00Z");
        const vehicle = makeVehicle([
            makeStop({
                lat: 48.0, lon: 10.0, sequence: 1, stop_ifopt: "de:1:1",
                arrival_time: "2026-01-01T08:00:00Z",
                departure_time: "2026-01-01T08:10:00Z",
            }),
            makeStop({
                lat: 48.1, lon: 10.1, sequence: 2, stop_ifopt: "de:1:2",
                arrival_time: "2026-01-01T08:30:00Z",
                departure_time: "2026-01-01T08:35:00Z",
            }),
        ]);

        const result = calculateVehiclePosition(vehicle, simpleRouteGeometry, now);

        expect(result).not.toBeNull();
        expect(result!.status).toBe("at_stop");
        expect(result!.lon).toBe(10.0);
        expect(result!.lat).toBe(48.0);
    });

    it("returns in_transit status when between stops", () => {
        const now = new Date("2026-01-01T08:15:00Z");
        const vehicle = makeVehicle([
            makeStop({
                lat: 48.0, lon: 10.0, sequence: 1, stop_ifopt: "de:1:1",
                arrival_time: "2026-01-01T08:00:00Z",
                departure_time: "2026-01-01T08:10:00Z",
            }),
            makeStop({
                lat: 48.1, lon: 10.1, sequence: 2, stop_ifopt: "de:1:2",
                arrival_time: "2026-01-01T08:30:00Z",
                departure_time: "2026-01-01T08:35:00Z",
            }),
        ]);

        const result = calculateVehiclePosition(vehicle, simpleRouteGeometry, now);

        expect(result).not.toBeNull();
        // 8:15 is 5 min into 20 min transit = 25% progress, so in_transit (< 80%)
        expect(result!.status).toBe("in_transit");
        // Position should be interpolated between the two stops
        expect(result!.lon).toBeGreaterThan(10.0);
        expect(result!.lon).toBeLessThan(10.1);
        expect(result!.lat).toBeGreaterThan(48.0);
        expect(result!.lat).toBeLessThan(48.1);
    });

    it("returns approaching status when close to next stop (progress > 0.8)", () => {
        // 8:28 is 18 min into 20 min transit = 90% progress
        const now = new Date("2026-01-01T08:28:00Z");
        const vehicle = makeVehicle([
            makeStop({
                lat: 48.0, lon: 10.0, sequence: 1, stop_ifopt: "de:1:1",
                arrival_time: "2026-01-01T08:00:00Z",
                departure_time: "2026-01-01T08:10:00Z",
            }),
            makeStop({
                lat: 48.1, lon: 10.1, sequence: 2, stop_ifopt: "de:1:2",
                arrival_time: "2026-01-01T08:30:00Z",
                departure_time: "2026-01-01T08:35:00Z",
            }),
        ]);

        const result = calculateVehiclePosition(vehicle, simpleRouteGeometry, now);

        expect(result).not.toBeNull();
        expect(result!.status).toBe("approaching");
    });

    it("returns waiting status when before first departure", () => {
        const now = new Date("2026-01-01T07:50:00Z");
        const vehicle = makeVehicle([
            makeStop({
                lat: 48.0, lon: 10.0, sequence: 1, stop_ifopt: "de:1:1",
                arrival_time: "2026-01-01T08:00:00Z",
                departure_time: "2026-01-01T08:05:00Z",
            }),
            makeStop({
                lat: 48.1, lon: 10.1, sequence: 2, stop_ifopt: "de:1:2",
                arrival_time: "2026-01-01T08:30:00Z",
                departure_time: "2026-01-01T08:35:00Z",
            }),
        ]);

        const result = calculateVehiclePosition(vehicle, simpleRouteGeometry, now);

        expect(result).not.toBeNull();
        expect(result!.status).toBe("waiting");
        expect(result!.lon).toBe(10.0);
        expect(result!.lat).toBe(48.0);
    });

    it("returns completed status when past last stop arrival", () => {
        const now = new Date("2026-01-01T09:00:00Z");
        const vehicle = makeVehicle([
            makeStop({
                lat: 48.0, lon: 10.0, sequence: 1, stop_ifopt: "de:1:1",
                arrival_time: "2026-01-01T08:00:00Z",
                departure_time: "2026-01-01T08:05:00Z",
            }),
            makeStop({
                lat: 48.1, lon: 10.1, sequence: 2, stop_ifopt: "de:1:2",
                arrival_time: "2026-01-01T08:30:00Z",
                departure_time: "2026-01-01T08:35:00Z",
            }),
        ]);

        const result = calculateVehiclePosition(vehicle, simpleRouteGeometry, now);

        expect(result).not.toBeNull();
        expect(result!.status).toBe("completed");
        expect(result!.progress).toBe(1);
    });

    it("includes delay information from stops", () => {
        const now = new Date("2026-01-01T08:05:00Z");
        const vehicle = makeVehicle([
            makeStop({
                lat: 48.0, lon: 10.0, sequence: 1, stop_ifopt: "de:1:1",
                arrival_time: "2026-01-01T08:00:00Z",
                departure_time: "2026-01-01T08:10:00Z",
                delay_minutes: 3,
            }),
            makeStop({
                lat: 48.1, lon: 10.1, sequence: 2, stop_ifopt: "de:1:2",
                arrival_time: "2026-01-01T08:30:00Z",
                departure_time: "2026-01-01T08:35:00Z",
            }),
        ]);

        const result = calculateVehiclePosition(vehicle, simpleRouteGeometry, now);

        expect(result).not.toBeNull();
        expect(result!.delayMinutes).toBe(3);
    });

    it("populates tripId, lineNumber, and destination from vehicle", () => {
        const now = new Date("2026-01-01T08:05:00Z");
        const vehicle: Vehicle = {
            trip_id: "trip_42",
            line_number: "S3",
            destination: "Airport",
            stops: [
                makeStop({
                    lat: 48.0, lon: 10.0, sequence: 1, stop_ifopt: "de:1:1",
                    arrival_time: "2026-01-01T08:00:00Z",
                    departure_time: "2026-01-01T08:10:00Z",
                }),
                makeStop({
                    lat: 48.1, lon: 10.1, sequence: 2, stop_ifopt: "de:1:2",
                    arrival_time: "2026-01-01T08:30:00Z",
                    departure_time: "2026-01-01T08:35:00Z",
                }),
            ],
        };

        const result = calculateVehiclePosition(vehicle, simpleRouteGeometry, now);

        expect(result).not.toBeNull();
        expect(result!.tripId).toBe("trip_42");
        expect(result!.lineNumber).toBe("S3");
        expect(result!.destination).toBe("Airport");
    });
});

// --- Route-based smoothing with forward-only clamping ---

describe("updateSmoothedPosition with route-based smoothing", () => {
    const route = linearizeRoute(simpleRouteGeometry)!;

    const stopA: VehicleStop = makeStop({
        lat: 48.0, lon: 10.0, sequence: 1, stop_ifopt: "de:1:1",
    });
    const stopB: VehicleStop = makeStop({
        lat: 48.1, lon: 10.1, sequence: 2, stop_ifopt: "de:1:2",
    });

    it("prevents backward movement when target jumps backward on same segment", () => {
        // Vehicle is at a position on the route (use actual route position)
        // Position ~halfway along route, use small offset for rendered so it's within snap threshold
        const linearPos = route.totalLength * 0.5;

        const current = makeSmoothed({
            status: "in_transit",
            lon: 10.05,
            lat: 48.05,
            renderedLon: 10.05,
            renderedLat: 48.05,
            renderedLinearPosition: linearPos,
            currentStop: stopA,
            nextStop: stopB,
            prevStopIfopt: stopA.stop_ifopt,
            nextStopIfopt: stopB.stop_ifopt,
        });

        // GTFS-RT update causes target to jump backward (same segment, close coords)
        const backwardLinearPos = linearPos - 200; // 200m backward
        const target = makePosition({
            status: "in_transit",
            lon: 10.049,
            lat: 48.049,
            routeLinearPosition: backwardLinearPos,
            currentStop: stopA,
            nextStop: stopB,
        });

        const result = updateSmoothedPosition(current, target, 16, route);

        // Linear position should NOT decrease (forward-only clamping)
        expect(result.renderedLinearPosition).toBeGreaterThanOrEqual(linearPos);
    });

    it("allows forward movement on same segment at schedule speed", () => {
        const linearPos = route.totalLength * 0.3;
        const SPEED_MPS = 8.33; // ~30 km/h
        const distToStop = route.totalLength - linearPos;
        const msToNextStop = (distToStop / SPEED_MPS) * 1000;

        const current = makeSmoothed({
            status: "in_transit",
            lon: 10.03,
            lat: 48.03,
            renderedLon: 10.03,
            renderedLat: 48.03,
            renderedLinearPosition: linearPos,
            currentStop: stopA,
            nextStop: stopB,
            prevStopIfopt: stopA.stop_ifopt,
            nextStopIfopt: stopB.stop_ifopt,
        });

        const target = makePosition({
            status: "in_transit",
            lon: 10.031,
            lat: 48.031,
            routeLinearPosition: linearPos + 200,
            currentStop: stopA,
            nextStop: stopB,
            nextStopLinearPosition: route.totalLength,
            msToNextStop,
        });

        const result = updateSmoothedPosition(current, target, 16, route);

        // Should advance by speed * deltaMs (= 8.33 * 0.016 = 0.133m)
        const expectedDelta = SPEED_MPS * (16 / 1000);
        const actualDelta = result.renderedLinearPosition! - linearPos;
        expect(actualDelta).toBeGreaterThan(0);
        expect(actualDelta).toBeCloseTo(expectedDelta, 1);
    });

    it("allows backward movement when segment changes", () => {
        // Vehicle was on segment A->B, now on B->C (different segment)
        const stopC: VehicleStop = makeStop({
            lat: 48.2, lon: 10.2, sequence: 3, stop_ifopt: "de:1:3",
        });

        const linearPos = route.totalLength * 0.5;

        const current = makeSmoothed({
            status: "in_transit",
            lon: 10.05,
            lat: 48.05,
            renderedLon: 10.05,
            renderedLat: 48.05,
            renderedLinearPosition: linearPos,
            currentStop: stopA,
            nextStop: stopB,
            prevStopIfopt: stopA.stop_ifopt,
            nextStopIfopt: stopB.stop_ifopt,
        });

        // Now on a different segment (B->C) with slightly lower position, close coords
        const target = makePosition({
            status: "in_transit",
            lon: 10.049,
            lat: 48.049,
            routeLinearPosition: linearPos - 200,
            currentStop: stopB,
            nextStop: stopC,
        });

        const result = updateSmoothedPosition(current, target, 16, route);

        // Should allow movement since it's a different segment
        expect(result.renderedLinearPosition!).toBeLessThan(linearPos);
    });

    it("maintains smooth speed when target advances continuously each frame", () => {
        // With arrival-time-based speed, each frame computes speed from
        // remaining distance to stop / remaining time. As both decrease together,
        // speed stays roughly constant.
        const FRAME_MS = 16;
        const SPEED_MPS = 8.33; // ~30 km/h
        const distPerFrame = SPEED_MPS * (FRAME_MS / 1000);
        const startPos = route.totalLength * 0.2;
        const startLon = 10.02;
        const startLat = 48.02;
        const lonPerMeter = 1 / (111320 * Math.cos(startLat * Math.PI / 180));
        const latPerMeter = 1 / 111320;

        // Schedule: next stop at end of route, time computed for desired speed
        const totalDistToStop = route.totalLength - startPos;
        const totalTimeMs = (totalDistToStop / SPEED_MPS) * 1000;

        let smoothed = makeSmoothed({
            status: "in_transit",
            lon: startLon, lat: startLat,
            renderedLon: startLon, renderedLat: startLat,
            renderedLinearPosition: startPos,
            currentStop: stopA, nextStop: stopB,
            prevStopIfopt: stopA.stop_ifopt, nextStopIfopt: stopB.stop_ifopt,
        });

        // Run 60 frames, feeding decreasing msToNextStop each frame
        const deltas: number[] = [];
        let prevLinear = smoothed.renderedLinearPosition!;
        for (let i = 1; i <= 60; i++) {
            const targetPos = startPos + i * distPerFrame;
            const msToNextStop = totalTimeMs - i * FRAME_MS;
            const target = makePosition({
                status: "in_transit",
                lon: startLon + i * distPerFrame * lonPerMeter * 0.707,
                lat: startLat + i * distPerFrame * latPerMeter * 0.707,
                routeLinearPosition: targetPos,
                currentStop: stopA, nextStop: stopB,
                nextStopLinearPosition: route.totalLength,
                msToNextStop: msToNextStop > 0 ? msToNextStop : 1,
            });
            smoothed = updateSmoothedPosition(smoothed, target, FRAME_MS, route);
            deltas.push(smoothed.renderedLinearPosition! - prevLinear);
            prevLinear = smoothed.renderedLinearPosition!;
        }

        // All deltas positive (moving forward)
        expect(deltas.every(d => d > 0)).toBe(true);

        // Coefficient of variation < 5% (smooth movement)
        const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
        const stddev = Math.sqrt(deltas.map(d => (d - mean) ** 2).reduce((a, b) => a + b, 0) / deltas.length);
        expect(stddev / mean).toBeLessThan(0.05);
    });

    it("uses schedule speed instead of chasing target after GTFS-RT jump", () => {
        // Simulate a GTFS-RT correction: target jumps 500m ahead, but there are
        // 120 seconds left to the next stop.  The vehicle should advance at the
        // schedule speed (~30 km/h), NOT at 70 km/h or exponential-chase speed.
        const linearPos = route.totalLength * 0.2;
        const FRAME_MS = 16;
        const distToStop = route.totalLength - linearPos;
        const MS_TO_STOP = (distToStop / 8.33) * 1000; // 30 km/h schedule speed

        const current = makeSmoothed({
            status: "in_transit",
            lon: 10.02,
            lat: 48.02,
            renderedLon: 10.02,
            renderedLat: 48.02,
            renderedLinearPosition: linearPos,
            currentStop: stopA,
            nextStop: stopB,
            prevStopIfopt: stopA.stop_ifopt,
            nextStopIfopt: stopB.stop_ifopt,
        });

        // Target jumps 500m ahead (GTFS-RT time correction)
        const target = makePosition({
            status: "in_transit",
            lon: 10.025,
            lat: 48.025,
            routeLinearPosition: linearPos + 500,
            currentStop: stopA,
            nextStop: stopB,
            nextStopLinearPosition: route.totalLength,
            msToNextStop: MS_TO_STOP,
        });

        // First frame after jump
        const result = updateSmoothedPosition(current, target, FRAME_MS, route);
        const delta = result.renderedLinearPosition! - linearPos;

        // Speed should be distToStop / timeToStop = 8.33 m/s
        // Per-frame delta = 8.33 * 0.016 = 0.133m
        const expectedDelta = (distToStop / (MS_TO_STOP / 1000)) * (FRAME_MS / 1000);
        expect(delta).toBeCloseTo(expectedDelta, 2);
        expect(delta).toBeGreaterThan(0);

        // Even with the 500m jump, the vehicle never exceeds schedule speed
        let pos = result;
        let prevLinear = pos.renderedLinearPosition!;
        for (let i = 0; i < 60; i++) {
            pos = updateSmoothedPosition(pos, target, FRAME_MS, route);
            const frameDelta = pos.renderedLinearPosition! - prevLinear;
            const speedMs = frameDelta / (FRAME_MS / 1000);
            // Speed should stay close to 8.33 m/s, not ramp up to 70 km/h
            expect(speedMs).toBeLessThan(10); // well below old 70 km/h = 19.4 m/s cap
            prevLinear = pos.renderedLinearPosition!;
        }
    });

    it("schedule speed matches expected per-frame advancement", () => {
        // Verify that at 30 km/h schedule, per-frame delta is exactly speed * dt
        const FRAME_MS = 16;
        const SPEED_MPS = 8.33;
        const startPos = route.totalLength * 0.2;
        const distToStop = route.totalLength - startPos;
        const msToNextStop = (distToStop / SPEED_MPS) * 1000;

        const smoothed = makeSmoothed({
            status: "in_transit",
            lon: 10.02, lat: 48.02,
            renderedLon: 10.02, renderedLat: 48.02,
            renderedLinearPosition: startPos,
            currentStop: stopA, nextStop: stopB,
            prevStopIfopt: stopA.stop_ifopt, nextStopIfopt: stopB.stop_ifopt,
        });

        const target = makePosition({
            status: "in_transit",
            lon: 10.025, lat: 48.025,
            routeLinearPosition: startPos + 100,
            currentStop: stopA, nextStop: stopB,
            nextStopLinearPosition: route.totalLength,
            msToNextStop,
        });

        const result = updateSmoothedPosition(smoothed, target, FRAME_MS, route);
        const delta = result.renderedLinearPosition! - startPos;
        const expectedDelta = SPEED_MPS * (FRAME_MS / 1000);

        expect(delta).toBeCloseTo(expectedDelta, 2);
    });

    it("delays stop name update until rendered position crosses segment boundary", () => {
        // Use a short route (~200m) so positions are within snap threshold
        const shortGeometry: number[][][] = [[
            [10.0, 48.0],
            [10.001, 48.001],
            [10.002, 48.002],
        ]];
        const shortRoute = linearizeRoute(shortGeometry)!;

        // Three stops: A (start) → B (midpoint) → C (end)
        const sA: VehicleStop = makeStop({
            lat: 48.0, lon: 10.0, sequence: 1, stop_ifopt: "de:1:1",
            stop_name: "Moritzplatz",
        });
        const sB: VehicleStop = makeStop({
            lat: 48.001, lon: 10.001, sequence: 2, stop_ifopt: "de:1:2",
            stop_name: "Hauptbahnhof",
        });
        const sC: VehicleStop = makeStop({
            lat: 48.002, lon: 10.002, sequence: 3, stop_ifopt: "de:1:3",
            stop_name: "Rosenaustraße",
        });

        // Vehicle rendered position is at 20% of route — approaching stopB
        const linearPos = shortRoute.totalLength * 0.2;
        const posAtLinear = getPositionAtDistance(shortRoute, linearPos);
        const current = makeSmoothed({
            status: "in_transit",
            lon: posAtLinear.lon,
            lat: posAtLinear.lat,
            renderedLon: posAtLinear.lon,
            renderedLat: posAtLinear.lat,
            renderedLinearPosition: linearPos,
            currentStop: sA,
            nextStop: sB,
            prevStopIfopt: sA.stop_ifopt,
            nextStopIfopt: sB.stop_ifopt,
        });

        // Target jumps to B→C segment (simulated time passed B's departure)
        const targetLinearPos = shortRoute.totalLength * 0.55;
        const targetPos = getPositionAtDistance(shortRoute, targetLinearPos);
        const target = makePosition({
            status: "in_transit",
            lon: targetPos.lon,
            lat: targetPos.lat,
            routeLinearPosition: targetLinearPos,
            currentStop: sB,   // departed from Hauptbahnhof
            nextStop: sC,      // heading to Rosenaustraße
            nextStopLinearPosition: shortRoute.totalLength,
            msToNextStop: 60000, // 60s to next stop
        });

        const result = updateSmoothedPosition(current, target, 16, shortRoute);

        // Rendered position is still before Hauptbahnhof, so UI should show old stops
        expect(result.nextStop?.stop_name).toBe("Hauptbahnhof");
        expect(result.currentStop?.stop_name).toBe("Moritzplatz");
        expect(result.status).toBe("in_transit");
        expect(result.prevStopIfopt).toBe(sA.stop_ifopt);
        expect(result.nextStopIfopt).toBe(sB.stop_ifopt);
    });

    it("updates stop names once rendered position passes segment boundary", () => {
        const shortGeometry: number[][][] = [[
            [10.0, 48.0],
            [10.001, 48.001],
            [10.002, 48.002],
        ]];
        const shortRoute = linearizeRoute(shortGeometry)!;

        const sA: VehicleStop = makeStop({
            lat: 48.0, lon: 10.0, sequence: 1, stop_ifopt: "de:1:1",
            stop_name: "Moritzplatz",
        });
        const sB: VehicleStop = makeStop({
            lat: 48.001, lon: 10.001, sequence: 2, stop_ifopt: "de:1:2",
            stop_name: "Hauptbahnhof",
        });
        const sC: VehicleStop = makeStop({
            lat: 48.002, lon: 10.002, sequence: 3, stop_ifopt: "de:1:3",
            stop_name: "Rosenaustraße",
        });

        // Vehicle rendered position is PAST stopB (55% of route, stopB is at 50%)
        const linearPos = shortRoute.totalLength * 0.55;
        const posAtLinear = getPositionAtDistance(shortRoute, linearPos);
        const current = makeSmoothed({
            status: "in_transit",
            lon: posAtLinear.lon,
            lat: posAtLinear.lat,
            renderedLon: posAtLinear.lon,
            renderedLat: posAtLinear.lat,
            renderedLinearPosition: linearPos,
            currentStop: sA,
            nextStop: sB,
            prevStopIfopt: sA.stop_ifopt,
            nextStopIfopt: sB.stop_ifopt,
        });

        // Target is on B→C segment (schedule info for speed-based advancement)
        const targetLinearPos = shortRoute.totalLength * 0.6;
        const targetPos = getPositionAtDistance(shortRoute, targetLinearPos);
        const target = makePosition({
            status: "in_transit",
            lon: targetPos.lon,
            lat: targetPos.lat,
            routeLinearPosition: targetLinearPos,
            currentStop: sB,
            nextStop: sC,
            nextStopLinearPosition: shortRoute.totalLength,
            msToNextStop: 60000,
        });

        const result = updateSmoothedPosition(current, target, 16, shortRoute);

        // Rendered position is past Hauptbahnhof, so stop names update to new segment
        expect(result.nextStop?.stop_name).toBe("Rosenaustraße");
        expect(result.currentStop?.stop_name).toBe("Hauptbahnhof");
    });

    it("derives lat/lon from route geometry instead of direct interpolation", () => {
        const current = makeSmoothed({
            status: "in_transit",
            lon: 10.0,
            lat: 48.0,
            renderedLon: 10.0,
            renderedLat: 48.0,
            renderedLinearPosition: 0,
            currentStop: stopA,
            nextStop: stopB,
            prevStopIfopt: stopA.stop_ifopt,
            nextStopIfopt: stopB.stop_ifopt,
        });

        const halfwayDistance = route.totalLength / 2;
        const target = makePosition({
            status: "in_transit",
            lon: 10.05,
            lat: 48.05,
            routeLinearPosition: halfwayDistance,
            currentStop: stopA,
            nextStop: stopB,
        });

        // Run enough frames to approach the target
        let pos = current;
        for (let i = 0; i < 300; i++) {
            pos = updateSmoothedPosition(pos, target, 16, route);
        }

        // Position should be near the midpoint of the route
        expect(pos.renderedLon).toBeCloseTo(10.05, 1);
        expect(pos.renderedLat).toBeCloseTo(48.05, 1);
    });
});
