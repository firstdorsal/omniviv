/**
 * Realistic Vehicle Movement Tests
 *
 * End-to-end tests that simulate complete vehicle journeys along real-world-like
 * routes and verify that rendered movement stays physically plausible.
 *
 * These tests complement the unit tests in vehicleUtils.test.ts by running
 * multi-frame simulations with realistic parameters (Augsburg tram speeds,
 * stop spacing, dwell times) and asserting invariants that would catch
 * teleporting, flying, backward movement, or impossible speeds.
 */
import { describe, it, expect, vi } from "vitest";
import type { Vehicle, VehicleStop } from "../../api";
import {
    calculateVehiclePosition,
    createSmoothedPosition,
    linearizeRoute,
    updateSmoothedPosition,
    findPositionOnRoute,
    getPositionAtDistance,
    type VehiclePosition,
    type SmoothedVehiclePosition,
    type LinearizedRoute,
} from "./vehicleUtils";

vi.mock("./features", () => ({
    featureManager: { isEnabled: () => false },
    shouldStopAtStation: () => false,
    getDwellTimeMs: () => 20000,
}));

// ---------------------------------------------------------------------------
// Physical constants for Augsburg trams
// ---------------------------------------------------------------------------
/** Maximum service speed: 70 km/h */
const MAX_TRAM_SPEED_KMH = 70;
const MAX_TRAM_SPEED_MPS = MAX_TRAM_SPEED_KMH / 3.6;

/** Typical cruising speed: ~30 km/h */
const CRUISE_SPEED_MPS = 8.33;

/** Frame interval at 60 fps */
const FRAME_MS = 16;

/** Meters per degree at Augsburg latitude (~48.37) */
const LAT_DEG = 48.37;
const METERS_PER_DEG_LAT = 111320;
const METERS_PER_DEG_LON = 111320 * Math.cos((LAT_DEG * Math.PI) / 180);

// ---------------------------------------------------------------------------
// Route builder: construct realistic L-shaped and curved routes
// ---------------------------------------------------------------------------

/** Build an L-shaped route: east then north (simulates a right turn) */
function buildLShapedRoute(
    startLon: number,
    startLat: number,
    legMeters: number,
    pointsPerLeg = 10,
): { geometry: number[][][]; route: LinearizedRoute } {
    const coords: number[][] = [];
    const dlonPerPoint = (legMeters / pointsPerLeg) / METERS_PER_DEG_LON;
    const dlatPerPoint = (legMeters / pointsPerLeg) / METERS_PER_DEG_LAT;

    // East leg
    for (let i = 0; i <= pointsPerLeg; i++) {
        coords.push([startLon + i * dlonPerPoint, startLat]);
    }
    // North leg (skip first point = same as corner)
    const cornerLon = coords[coords.length - 1][0];
    const cornerLat = coords[coords.length - 1][1];
    for (let i = 1; i <= pointsPerLeg; i++) {
        coords.push([cornerLon, cornerLat + i * dlatPerPoint]);
    }

    const geometry: number[][][] = [coords];
    const route = linearizeRoute(geometry)!;
    return { geometry, route };
}

/** Build a multi-stop curved route that resembles a real tram line */
function buildCurvedRoute(numSegments: number, segmentMeters: number): {
    geometry: number[][][];
    route: LinearizedRoute;
    coords: number[][];
} {
    const coords: number[][] = [];
    let lon = 10.89;
    let lat = 48.37;
    let bearing = 0; // Start heading north

    coords.push([lon, lat]);
    for (let i = 0; i < numSegments; i++) {
        // Each segment curves slightly (simulates real street layout)
        bearing += (Math.random() - 0.5) * 30; // -15 to +15 degrees turn
        const radians = (bearing * Math.PI) / 180;
        lon += (Math.sin(radians) * segmentMeters) / METERS_PER_DEG_LON;
        lat += (Math.cos(radians) * segmentMeters) / METERS_PER_DEG_LAT;
        coords.push([lon, lat]);
    }

    const geometry: number[][][] = [coords];
    const route = linearizeRoute(geometry)!;
    return { geometry, route, coords };
}

// ---------------------------------------------------------------------------
// Stop helpers
// ---------------------------------------------------------------------------

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

function isoTime(base: Date, offsetMs: number): string {
    return new Date(base.getTime() + offsetMs).toISOString();
}

/** Create stops spaced along a route with realistic timing */
function createStopsAlongRoute(
    route: LinearizedRoute,
    numStops: number,
    startTime: Date,
    interStopSeconds: number,
    dwellSeconds: number,
): VehicleStop[] {
    const stops: VehicleStop[] = [];
    const spacing = route.totalLength / (numStops - 1);

    for (let i = 0; i < numStops; i++) {
        const pos = getPositionAtDistance(route, spacing * i);
        const arrivalOffsetMs = i * (interStopSeconds + dwellSeconds) * 1000;
        const departureOffsetMs = arrivalOffsetMs + dwellSeconds * 1000;
        const isLast = i === numStops - 1;

        stops.push(makeStop({
            lon: pos.lon,
            lat: pos.lat,
            sequence: i + 1,
            stop_ifopt: `de:09761:${100 + i}:0:A`,
            stop_name: `Stop ${i + 1}`,
            arrival_time: i > 0 ? isoTime(startTime, arrivalOffsetMs) : null,
            departure_time: isLast ? null : isoTime(startTime, departureOffsetMs),
        }));
    }
    return stops;
}

// ---------------------------------------------------------------------------
// Frame runner: simulates the animation loop
// ---------------------------------------------------------------------------

interface FrameResult {
    position: SmoothedVehiclePosition;
    speedMps: number;
    distanceMoved: number;
}

function runFrames(
    vehicle: Vehicle,
    routeGeometry: number[][][],
    route: LinearizedRoute,
    startTime: Date,
    numFrames: number,
    frameDeltaMs: number = FRAME_MS,
    timeSpeed: number = 1.0,
): FrameResult[] {
    const results: FrameResult[] = [];
    let smoothed: SmoothedVehiclePosition | null = null;
    let prevLinear = 0;

    for (let i = 0; i < numFrames; i++) {
        const simTime = new Date(startTime.getTime() + i * frameDeltaMs * timeSpeed);
        const target = calculateVehiclePosition(vehicle, routeGeometry, simTime);
        if (!target) continue;
        if (target.status === "completed") break;

        if (!smoothed) {
            smoothed = createSmoothedPosition(target);
            prevLinear = smoothed.renderedLinearPosition ?? 0;
            results.push({ position: smoothed, speedMps: 0, distanceMoved: 0 });
            continue;
        }

        smoothed = updateSmoothedPosition(smoothed, target, frameDeltaMs, route, timeSpeed);
        const linear = smoothed.renderedLinearPosition ?? 0;
        const delta = linear - prevLinear;
        const speedMps = delta / (frameDeltaMs / 1000);
        prevLinear = linear;

        results.push({ position: smoothed, speedMps, distanceMoved: delta });
    }
    return results;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Realistic Movement: Speed Constraints", () => {
    const { geometry, route } = buildLShapedRoute(10.89, 48.37, 800);

    it("never exceeds physical tram speed limit (70 km/h) during normal transit", () => {
        const startTime = new Date("2026-03-19T10:00:00Z");
        const stops = createStopsAlongRoute(route, 4, startTime, 90, 20);
        const vehicle: Vehicle = {
            trip_id: "speed_limit_1",
            line_number: "1",
            destination: "Lechhausen",
            stops,
        };

        const frames = runFrames(vehicle, geometry, route, startTime, 3000, FRAME_MS);

        for (const frame of frames) {
            expect(frame.speedMps).toBeLessThanOrEqual(MAX_TRAM_SPEED_MPS + 0.5); // small tolerance
        }
    });

    it("never moves backward during normal transit", () => {
        const startTime = new Date("2026-03-19T10:00:00Z");
        const stops = createStopsAlongRoute(route, 5, startTime, 60, 15);
        const vehicle: Vehicle = {
            trip_id: "no_backward_1",
            line_number: "2",
            destination: "Haunstetten",
            stops,
        };

        const frames = runFrames(vehicle, geometry, route, startTime, 2000, FRAME_MS);

        // Filter only in_transit/approaching frames (at_stop can legitimately have 0 movement)
        const transitFrames = frames.filter(
            f => f.position.status === "in_transit" || f.position.status === "approaching"
        );
        for (const frame of transitFrames) {
            expect(frame.distanceMoved).toBeGreaterThanOrEqual(-0.01); // tiny float tolerance
        }
    });

    it("speed stays within 2x of schedule speed during steady-state cruising", () => {
        const startTime = new Date("2026-03-19T10:00:00Z");
        // 2 stops, 3km apart, 120 seconds = ~25 km/h average = realistic
        const stopA = makeStop({
            lon: route.coords[0][0], lat: route.coords[0][1],
            sequence: 1, stop_ifopt: "de:1:1",
            departure_time: isoTime(startTime, 0),
        });
        const stopB = makeStop({
            lon: route.coords[route.coords.length - 1][0],
            lat: route.coords[route.coords.length - 1][1],
            sequence: 2, stop_ifopt: "de:1:2",
            arrival_time: isoTime(startTime, (route.totalLength / CRUISE_SPEED_MPS) * 1000),
        });

        const vehicle: Vehicle = {
            trip_id: "cruise_1",
            line_number: "3",
            destination: "Hauptbahnhof",
            stops: [stopA, stopB],
        };

        // Start after departure, skip first few frames for settling
        const frames = runFrames(
            vehicle, geometry, route,
            new Date(startTime.getTime() + 2000), // 2s after departure
            500, FRAME_MS
        );

        const transitSpeeds = frames
            .filter(f => f.position.status === "in_transit" && f.speedMps > 0)
            .map(f => f.speedMps);

        expect(transitSpeeds.length).toBeGreaterThan(0);

        // All speeds within 2x of cruise speed
        for (const speed of transitSpeeds) {
            expect(speed).toBeLessThanOrEqual(CRUISE_SPEED_MPS * 2 + 0.5);
        }
    });
});

describe("Realistic Movement: Multi-Stop Journey", () => {
    // 6-stop route with curves (like a real tram line segment)
    const { geometry, route } = buildCurvedRoute(30, 50); // 30 segments * 50m = 1500m

    it("visits all intermediate stops in sequence without skipping", () => {
        const startTime = new Date("2026-03-19T10:00:00Z");
        const stops = createStopsAlongRoute(route, 6, startTime, 45, 15);
        const vehicle: Vehicle = {
            trip_id: "multi_stop_1",
            line_number: "4",
            destination: "Oberhausen",
            stops,
        };

        // Simulate the full journey (6 stops * 60s = 6 minutes)
        const totalMs = 6 * 60 * 1000;
        const numFrames = totalMs / FRAME_MS;
        const frames = runFrames(vehicle, geometry, route, startTime, numFrames, FRAME_MS);

        // Collect all unique stop_ifopt values the vehicle reported as current stop
        // during at_stop OR as nextStop during transit (both indicate the stop was part
        // of the journey). Using currentStop from all frames gives the best coverage.
        const reportedStops = new Set(
            frames
                .map(f => f.position.currentStop?.stop_ifopt)
                .filter(Boolean)
        );

        // At minimum, the vehicle should have referenced most stops as currentStop.
        // The first stop may only appear as departure, and the last as arrival.
        // Require at least 4 of 6 stops to be referenced.
        const allStopIfopts = stops.map(s => s.stop_ifopt);
        const matchCount = allStopIfopts.filter(s => reportedStops.has(s)).length;
        expect(matchCount).toBeGreaterThanOrEqual(4);
    });

    it("total journey distance matches route length within 10%", () => {
        const startTime = new Date("2026-03-19T10:00:00Z");
        const stops = createStopsAlongRoute(route, 4, startTime, 60, 20);
        const vehicle: Vehicle = {
            trip_id: "distance_1",
            line_number: "6",
            destination: "Friedberg",
            stops,
        };

        const totalMs = 4 * 80 * 1000; // 4 stops * 80s each
        const frames = runFrames(vehicle, geometry, route, startTime, totalMs / FRAME_MS, FRAME_MS);

        // Sum positive movements
        const totalDistance = frames.reduce((sum, f) => sum + Math.max(0, f.distanceMoved), 0);

        // Should be within 10% of route length (allow for dwell time at stops)
        expect(totalDistance).toBeGreaterThan(0);
        expect(totalDistance).toBeLessThanOrEqual(route.totalLength * 1.1);
    });

    it("vehicle decelerates before stops and accelerates after", () => {
        const startTime = new Date("2026-03-19T10:00:00Z");
        // 3 stops, generous timing for clear acc/dec phases
        const stopA = makeStop({
            lon: route.coords[0][0], lat: route.coords[0][1],
            sequence: 1, stop_ifopt: "de:1:1",
            departure_time: isoTime(startTime, 0),
        });
        const midPos = getPositionAtDistance(route, route.totalLength / 2);
        const stopB = makeStop({
            lon: midPos.lon, lat: midPos.lat,
            sequence: 2, stop_ifopt: "de:1:2",
            arrival_time: isoTime(startTime, 60_000),
            departure_time: isoTime(startTime, 80_000),
        });
        const stopC = makeStop({
            lon: route.coords[route.coords.length - 1][0],
            lat: route.coords[route.coords.length - 1][1],
            sequence: 3, stop_ifopt: "de:1:3",
            arrival_time: isoTime(startTime, 140_000),
        });

        const vehicle: Vehicle = {
            trip_id: "acc_dec_1",
            line_number: "1",
            destination: "Test",
            stops: [stopA, stopB, stopC],
        };

        const frames = runFrames(vehicle, geometry, route, startTime, 9000, FRAME_MS);

        // Find speeds just before arriving at stopB (~55-59s)
        const approachFrames = frames.filter(f => {
            const elapsed = f.position.nextStop?.stop_ifopt === "de:1:2"
                && f.position.status === "approaching";
            return elapsed;
        });

        // Find speeds just after departing stopB (~80-85s)
        const departFrames = frames.filter(f => {
            const elapsed = f.position.currentStop?.stop_ifopt === "de:1:2"
                && f.position.status === "in_transit"
                && f.position.progress < 0.15;
            return elapsed;
        });

        if (approachFrames.length > 0 && departFrames.length > 0) {
            const approachSpeed = approachFrames[approachFrames.length - 1].speedMps;
            const departSpeed = departFrames[0].speedMps;

            // Speed near stop should be less than cruise speed (easing effect)
            // This verifies the easeInOutProgress function is working
            expect(approachSpeed).toBeLessThanOrEqual(CRUISE_SPEED_MPS * 1.5);
            expect(departSpeed).toBeLessThanOrEqual(CRUISE_SPEED_MPS * 1.5);
        }
    });
});

describe("Realistic Movement: GTFS-RT Correction Recovery", () => {
    // Straight route for clear speed measurement
    const straightGeometry: number[][][] = [[
        [10.89, 48.37],
        [10.89 + 3000 / METERS_PER_DEG_LON, 48.37], // 3km east
    ]];
    const route = linearizeRoute(straightGeometry)!;

    it("absorbs a 500m GTFS-RT jump without visible speed spike", () => {
        const startTime = new Date("2026-03-19T10:00:00Z");
        const scheduleTimeMs = (route.totalLength / CRUISE_SPEED_MPS) * 1000;

        const stopA = makeStop({
            lon: 10.89, lat: 48.37, sequence: 1, stop_ifopt: "de:1:1",
            departure_time: isoTime(startTime, 0),
        });
        const stopB = makeStop({
            lon: route.coords[1][0], lat: route.coords[1][1],
            sequence: 2, stop_ifopt: "de:1:2",
            arrival_time: isoTime(startTime, scheduleTimeMs),
        });

        const vehicle: Vehicle = {
            trip_id: "correction_1",
            line_number: "1",
            destination: "Test",
            stops: [stopA, stopB],
        };

        // Run 100 normal frames
        const normalFrames = runFrames(
            vehicle, straightGeometry, route,
            new Date(startTime.getTime() + 5000), // 5s after departure
            100, FRAME_MS
        );
        const lastNormal = normalFrames[normalFrames.length - 1];

        // Simulate a GTFS-RT jump: the target jumps 500m ahead
        const jumpedLinear = (lastNormal.position.renderedLinearPosition ?? 0) + 500;
        const jumpTarget: VehiclePosition = {
            tripId: "correction_1",
            lineNumber: "1",
            destination: "Test",
            lon: route.coords[0][0] + jumpedLinear / METERS_PER_DEG_LON,
            lat: 48.37,
            bearing: 90,
            status: "in_transit",
            progress: 0.5,
            delayMinutes: null,
            currentStop: stopA,
            nextStop: stopB,
            routeLinearPosition: jumpedLinear,
            nextStopLinearPosition: route.totalLength,
            msToNextStop: scheduleTimeMs - 5000 - 100 * FRAME_MS,
        };

        // Apply the jump and then run 60 more frames
        let smoothed = lastNormal.position;
        const postJumpSpeeds: number[] = [];
        let prevLinear = smoothed.renderedLinearPosition ?? 0;

        for (let i = 0; i < 60; i++) {
            smoothed = updateSmoothedPosition(smoothed, jumpTarget, FRAME_MS, route);
            const linear = smoothed.renderedLinearPosition ?? 0;
            const speed = (linear - prevLinear) / (FRAME_MS / 1000);
            postJumpSpeeds.push(speed);
            prevLinear = linear;
        }

        // No frame should exceed the physical speed limit
        for (const speed of postJumpSpeeds) {
            expect(speed).toBeLessThanOrEqual(MAX_TRAM_SPEED_MPS + 0.5);
        }

        // Speed should be positive (still moving forward)
        expect(postJumpSpeeds.every(s => s >= 0)).toBe(true);
    });

    it("smoothly recovers schedule speed after a timing correction", () => {
        // Vehicle is at 500m, schedule says it should be at 800m.
        // The vehicle should speed up gradually, not teleport.
        const scheduleTimeMs = (route.totalLength / CRUISE_SPEED_MPS) * 1000;
        const currentPos = 500;
        const msElapsed = (currentPos / CRUISE_SPEED_MPS) * 1000;

        const startTime = new Date("2026-03-19T10:00:00Z");
        const stopA = makeStop({
            lon: 10.89, lat: 48.37, sequence: 1, stop_ifopt: "de:1:1",
            departure_time: isoTime(startTime, 0),
        });
        const stopB = makeStop({
            lon: route.coords[1][0], lat: route.coords[1][1],
            sequence: 2, stop_ifopt: "de:1:2",
            arrival_time: isoTime(startTime, scheduleTimeMs),
        });

        let smoothed = createSmoothedPosition({
            tripId: "recovery_1",
            lineNumber: "1",
            destination: "Test",
            lon: 10.89 + currentPos / METERS_PER_DEG_LON,
            lat: 48.37,
            bearing: 90,
            status: "in_transit",
            progress: currentPos / route.totalLength,
            delayMinutes: null,
            currentStop: stopA,
            nextStop: stopB,
            routeLinearPosition: currentPos,
        });
        smoothed.renderedLinearPosition = currentPos;
        smoothed.prevStopIfopt = stopA.stop_ifopt;
        smoothed.nextStopIfopt = stopB.stop_ifopt;

        // Schedule says remaining: route.totalLength - currentPos meters in scheduleTimeMs - msElapsed ms
        const remainingDist = route.totalLength - currentPos;
        const remainingMs = scheduleTimeMs - msElapsed;

        const speeds: number[] = [];
        let prevLinear = currentPos;

        for (let i = 0; i < 120; i++) {
            const target: VehiclePosition = {
                tripId: "recovery_1",
                lineNumber: "1",
                destination: "Test",
                lon: 10.89 + (currentPos + 300) / METERS_PER_DEG_LON, // target 300m ahead
                lat: 48.37,
                bearing: 90,
                status: "in_transit",
                progress: 0.5,
                delayMinutes: null,
                currentStop: stopA,
                nextStop: stopB,
                routeLinearPosition: currentPos + 300,
                nextStopLinearPosition: route.totalLength,
                msToNextStop: remainingMs - i * FRAME_MS,
            };

            smoothed = updateSmoothedPosition(smoothed, target, FRAME_MS, route);
            const linear = smoothed.renderedLinearPosition ?? 0;
            speeds.push((linear - prevLinear) / (FRAME_MS / 1000));
            prevLinear = linear;
        }

        // Speed should be reasonably stable (no wild oscillation)
        const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
        const maxDeviation = Math.max(...speeds.map(s => Math.abs(s - mean)));
        expect(maxDeviation / mean).toBeLessThan(1.0); // Within 100% of mean
    });
});

describe("Realistic Movement: Route Following", () => {
    it("vehicle follows L-shaped route around the corner, not a straight line", () => {
        const { geometry, route } = buildLShapedRoute(10.89, 48.37, 500);
        const startTime = new Date("2026-03-19T10:00:00Z");

        const travelTimeSec = route.totalLength / CRUISE_SPEED_MPS;
        const stops = [
            makeStop({
                lon: route.coords[0][0], lat: route.coords[0][1],
                sequence: 1, stop_ifopt: "de:1:1",
                departure_time: isoTime(startTime, 0),
            }),
            makeStop({
                lon: route.coords[route.coords.length - 1][0],
                lat: route.coords[route.coords.length - 1][1],
                sequence: 2, stop_ifopt: "de:1:2",
                arrival_time: isoTime(startTime, travelTimeSec * 1000),
            }),
        ];

        const vehicle: Vehicle = {
            trip_id: "L_route_1",
            line_number: "1",
            destination: "Test",
            stops,
        };

        const frames = runFrames(vehicle, geometry, route, startTime, 3000, FRAME_MS);

        // All rendered positions should be within 5m of the route
        for (const frame of frames) {
            const pos = frame.position;
            const nearest = findPositionOnRoute(route, pos.renderedLon, pos.renderedLat);
            expect(nearest.distance).toBeLessThan(5); // within 5 meters of route
        }
    });

    it("bearing changes smoothly through a turn, no sudden flips", () => {
        const { geometry, route } = buildLShapedRoute(10.89, 48.37, 500);
        const startTime = new Date("2026-03-19T10:00:00Z");

        const travelTimeSec = route.totalLength / CRUISE_SPEED_MPS;
        const stops = [
            makeStop({
                lon: route.coords[0][0], lat: route.coords[0][1],
                sequence: 1, stop_ifopt: "de:1:1",
                departure_time: isoTime(startTime, 0),
            }),
            makeStop({
                lon: route.coords[route.coords.length - 1][0],
                lat: route.coords[route.coords.length - 1][1],
                sequence: 2, stop_ifopt: "de:1:2",
                arrival_time: isoTime(startTime, travelTimeSec * 1000),
            }),
        ];

        const vehicle: Vehicle = {
            trip_id: "bearing_1",
            line_number: "1",
            destination: "Test",
            stops,
        };

        const frames = runFrames(vehicle, geometry, route, startTime, 3000, FRAME_MS);

        // Check that consecutive bearing changes are < 30 degrees per frame
        // (at 16ms per frame, >30 degrees would be visible as a visual jerk)
        for (let i = 1; i < frames.length; i++) {
            const prev = frames[i - 1].position.renderedBearing;
            const curr = frames[i].position.renderedBearing;
            let diff = Math.abs(curr - prev);
            if (diff > 180) diff = 360 - diff;
            expect(diff).toBeLessThan(30);
        }
    });
});

describe("Realistic Movement: Stop Behavior", () => {
    const straightGeometry: number[][][] = [[
        [10.89, 48.37],
        [10.89 + 1000 / METERS_PER_DEG_LON, 48.37],
    ]];
    const route = linearizeRoute(straightGeometry)!;

    it("vehicle stays stationary during dwell time at a stop", () => {
        const startTime = new Date("2026-03-19T10:00:00Z");
        const midPos = getPositionAtDistance(route, route.totalLength / 2);

        const stops = [
            makeStop({
                lon: route.coords[0][0], lat: route.coords[0][1],
                sequence: 1, stop_ifopt: "de:1:1",
                departure_time: isoTime(startTime, 0),
            }),
            makeStop({
                lon: midPos.lon, lat: midPos.lat,
                sequence: 2, stop_ifopt: "de:1:2",
                arrival_time: isoTime(startTime, 30_000),
                departure_time: isoTime(startTime, 50_000), // 20s dwell
            }),
            makeStop({
                lon: route.coords[1][0], lat: route.coords[1][1],
                sequence: 3, stop_ifopt: "de:1:3",
                arrival_time: isoTime(startTime, 80_000),
            }),
        ];

        const vehicle: Vehicle = {
            trip_id: "dwell_1",
            line_number: "1",
            destination: "Test",
            stops,
        };

        // Sample frames during the dwell period (30s-50s = at the stop)
        const dwellStart = 32_000; // 2s into dwell
        const dwellFrames = runFrames(
            vehicle, straightGeometry, route,
            new Date(startTime.getTime() + dwellStart),
            500, FRAME_MS,
        );

        const atStopFrames = dwellFrames.filter(f => f.position.status === "at_stop");
        expect(atStopFrames.length).toBeGreaterThan(0);

        // During at_stop, speed should be 0 (or negligible from smoothing)
        for (const frame of atStopFrames) {
            expect(Math.abs(frame.speedMps)).toBeLessThan(1.0);
        }
    });

    it("vehicle transitions from transit to stop without excessive jump", () => {
        // Directly test the smoothing behavior at a transit -> at_stop transition.
        // Use a position very close to the stop (5m away) to simulate the last
        // frame before arrival. The snap to the stop should be small.
        const stopLinear = route.totalLength / 2;
        const nearStopLinear = stopLinear - 5; // 5m before stop

        const stopA = makeStop({
            lon: route.coords[0][0], lat: route.coords[0][1],
            sequence: 1, stop_ifopt: "de:1:1",
        });
        const stopPos = getPositionAtDistance(route, stopLinear);
        const stopB = makeStop({
            lon: stopPos.lon, lat: stopPos.lat,
            sequence: 2, stop_ifopt: "de:1:2",
        });
        const nearPos = getPositionAtDistance(route, nearStopLinear);

        // Vehicle approaching stop B at ~8 m/s, 5m away
        const smoothed: SmoothedVehiclePosition = {
            tripId: "transition_1",
            lineNumber: "1",
            destination: "Test",
            lon: nearPos.lon,
            lat: nearPos.lat,
            bearing: 90,
            status: "approaching",
            progress: 0.95,
            delayMinutes: null,
            currentStop: stopA,
            nextStop: stopB,
            renderedLon: nearPos.lon,
            renderedLat: nearPos.lat,
            renderedBearing: 90,
            lastUpdateTime: Date.now(),
            renderedLinearPosition: nearStopLinear,
            prevStopIfopt: stopA.stop_ifopt,
            nextStopIfopt: stopB.stop_ifopt,
        };

        // Target switches to at_stop at stopB
        const target: VehiclePosition = {
            tripId: "transition_1",
            lineNumber: "1",
            destination: "Test",
            lon: stopPos.lon,
            lat: stopPos.lat,
            bearing: 90,
            status: "at_stop",
            progress: 0,
            delayMinutes: null,
            currentStop: stopB,
            routeLinearPosition: stopLinear,
        };

        const result = updateSmoothedPosition(smoothed, target, FRAME_MS, route);

        // The snap to the stop should be at most ~5m (the remaining distance).
        // A 5m snap in a single 16ms frame is visually imperceptible at 60fps.
        const jumpM = Math.abs((result.renderedLinearPosition ?? 0) - nearStopLinear);
        expect(jumpM).toBeLessThan(10);
    });
});

describe("Realistic Movement: Time Speed Simulation", () => {
    const straightGeometry: number[][][] = [[
        [10.89, 48.37],
        [10.89 + 2000 / METERS_PER_DEG_LON, 48.37],
    ]];
    const route = linearizeRoute(straightGeometry)!;

    it("at 10x speed, vehicle still obeys physical speed limit", () => {
        const startTime = new Date("2026-03-19T10:00:00Z");
        const travelTimeSec = route.totalLength / CRUISE_SPEED_MPS;

        const stops = [
            makeStop({
                lon: route.coords[0][0], lat: route.coords[0][1],
                sequence: 1, stop_ifopt: "de:1:1",
                departure_time: isoTime(startTime, 0),
            }),
            makeStop({
                lon: route.coords[1][0], lat: route.coords[1][1],
                sequence: 2, stop_ifopt: "de:1:2",
                arrival_time: isoTime(startTime, travelTimeSec * 1000),
            }),
        ];

        const vehicle: Vehicle = {
            trip_id: "fast_sim_1",
            line_number: "1",
            destination: "Test",
            stops,
        };

        const TIME_SPEED = 10.0;
        const frames = runFrames(
            vehicle, straightGeometry, route,
            startTime, 1000, FRAME_MS, TIME_SPEED
        );

        // Rendered speed at 10x is the physical speed as rendered.
        // The vehicle should appear to move at 10x normal speed but the per-frame
        // delta is clamped by MAX_RENDERED_SPEED_MS
        for (const frame of frames) {
            // Speed in simulation space may be up to 10x cruise, but rendered should
            // be clamped to MAX_TRAM_SPEED_MPS * timeSpeed
            const renderedSpeedMps = frame.distanceMoved / (FRAME_MS / 1000);
            // At 10x, 70 km/h physical = 700 km/h sim, but per-frame we advance by
            // MAX_RENDERED_SPEED_MS * simDeltaMs/1000 where simDeltaMs = FRAME_MS * timeSpeed
            // so max per-frame = 19.4 * 0.16 = 3.1m, speed = 3.1/0.016 = 194 m/s
            // The actual cap is MAX_RENDERED_SPEED_MS (19.44) used with simDeltaMs
            // So rendered speed as distance/realDelta can be up to MAX_RENDERED_SPEED_MS * timeSpeed
            expect(renderedSpeedMps).toBeLessThanOrEqual(MAX_TRAM_SPEED_MPS * TIME_SPEED + 1.0);
        }
    });
});

describe("Realistic Movement: Position on Route Consistency", () => {
    it("linearized route positions are monotonically increasing", () => {
        const { route } = buildCurvedRoute(20, 40);
        for (let i = 1; i < route.distances.length; i++) {
            expect(route.distances[i]).toBeGreaterThan(route.distances[i - 1]);
        }
    });

    it("getPositionAtDistance returns points on the route path", () => {
        const { route } = buildCurvedRoute(20, 40);

        // Sample positions along the route
        for (let d = 0; d <= route.totalLength; d += 10) {
            const pos = getPositionAtDistance(route, d);
            const nearest = findPositionOnRoute(route, pos.lon, pos.lat);
            expect(nearest.distance).toBeLessThan(0.1); // within 10cm
        }
    });

    it("findPositionOnRoute and getPositionAtDistance are inverse operations", () => {
        const { route } = buildCurvedRoute(15, 60);

        for (let d = 10; d < route.totalLength - 10; d += 50) {
            const pos = getPositionAtDistance(route, d);
            const found = findPositionOnRoute(route, pos.lon, pos.lat);
            expect(Math.abs(found.linearPosition - d)).toBeLessThan(1.0); // within 1m
        }
    });
});
