/**
 * Leader/Follower Collision Avoidance
 *
 * Integrates INTO the smoothing step as a forward-movement cap.
 * Vehicles are NEVER pushed backwards — they can only be prevented from
 * advancing past the safe distance behind their leader.
 *
 * Integration: VehicleRenderer calls `computePositionCaps()` BEFORE the
 * smoothing loop, then applies the caps after each `updateSmoothedPosition()`.
 *
 * The `processPositions` RenderPositionFeature method is intentionally a no-op.
 * The feature registration is kept so the Settings panel toggle still works.
 */

import { findPositionOnRoute, type LinearizedRoute, type SmoothedVehiclePosition } from "../vehicleUtils";
import type { RenderPositionFeature, VehicleRenderContext, RenderPosition } from "./types";

// --- Constants ---

/** Minimum separation distance between leader and follower (meters). */
export const MIN_VEHICLE_SEPARATION = 50;

/** Haversine proximity threshold to enter a leader/follower pair (meters). */
const PROXIMITY_ENTER = 80;

/** Haversine distance at which a pair is dissolved (hysteresis, meters). */
const PROXIMITY_EXIT = 120;

/** Maximum allowed cross-route projection distance (meters). */
const MAX_CROSS_ROUTE_PROJECTION = 15;

// --- Persistent state ---

export interface FollowerState {
    leaderTripId: string;
}

const followerStates = new Map<string, FollowerState>();

export function _resetFollowerStates(): void {
    followerStates.clear();
}

// --- Helpers ---

function haversineDistance(lon1: number, lat1: number, lon2: number, lat2: number): number {
    const R = 6371000;
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const dPhi = ((lat2 - lat1) * Math.PI) / 180;
    const dLambda = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
        Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) * Math.sin(dLambda / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDiff(b1: number, b2: number): number {
    let d = Math.abs(b1 - b2);
    if (d > 180) d = 360 - d;
    return d;
}

/**
 * Higher line number = leader.  Same line: further ahead = leader.
 */
function assignRoles(
    a: { tripId: string; lineNumber: string; linearPosition: number },
    b: { tripId: string; lineNumber: string; linearPosition: number },
): [typeof a, typeof b] {
    const la = parseInt(a.lineNumber, 10) || 0;
    const lb = parseInt(b.lineNumber, 10) || 0;
    if (la !== lb) return la > lb ? [a, b] : [b, a];
    return a.linearPosition >= b.linearPosition ? [a, b] : [b, a];
}

// --- Public API: called by VehicleRenderer before the smoothing loop ---

export interface PositionCap {
    /** Maximum linear position on the follower's own route (meters). */
    maxLinearPosition: number;
    /** Route ID the cap is relative to. */
    routeId: number;
}

/**
 * Detect leader/follower pairs from the PREVIOUS frame's smoothed positions
 * and return per-vehicle forward-movement caps.
 *
 * The cap means: during this frame's smoothing, the follower's
 * `renderedLinearPosition` must not exceed `cap.maxLinearPosition`.
 * However, it must also never go below its current position (no backwards movement).
 * The caller is responsible for the `Math.max(cap, currentPosition)` clamping.
 */
export function computePositionCaps(
    allPositions: ReadonlyArray<{ tripId: string; routeId: number; lineNumber: string }>,
    smoothedPositions: ReadonlyMap<string, SmoothedVehiclePosition>,
    linearizedRoutes: ReadonlyMap<number, LinearizedRoute>,
): Map<string, PositionCap> {
    const caps = new Map<string, PositionCap>();
    if (allPositions.length < 2) return caps;

    // Build lightweight vehicle info from previous-frame smoothed positions
    type VInfo = {
        tripId: string;
        routeId: number;
        lineNumber: string;
        linearPosition: number;
        lon: number;
        lat: number;
        bearing: number;
        status: string;
    };

    const vehicles: VInfo[] = [];
    for (const { tripId, routeId, lineNumber } of allPositions) {
        const sp = smoothedPositions.get(tripId);
        if (!sp || sp.renderedLinearPosition === undefined) continue;
        vehicles.push({
            tripId,
            routeId,
            lineNumber,
            linearPosition: sp.renderedLinearPosition,
            lon: sp.renderedLon,
            lat: sp.renderedLat,
            bearing: sp.renderedBearing,
            status: sp.status,
        });
    }

    // --- Phase 1: Detect candidate pairs ---

    type Pair = { leader: VInfo; follower: VInfo; distance: number };
    const allPairs: Pair[] = [];

    for (let i = 0; i < vehicles.length; i++) {
        for (let j = i + 1; j < vehicles.length; j++) {
            const a = vehicles[i];
            const b = vehicles[j];

            // Same direction
            if (bearingDiff(a.bearing, b.bearing) >= 90) continue;

            const dist = haversineDistance(a.lon, a.lat, b.lon, b.lat);

            // Hysteresis
            const existA = followerStates.get(a.tripId);
            const existB = followerStates.get(b.tripId);
            const hasExisting =
                (existA && existA.leaderTripId === b.tripId) ||
                (existB && existB.leaderTripId === a.tripId);
            if (dist >= (hasExisting ? PROXIMITY_EXIT : PROXIMITY_ENTER)) continue;

            const [leader, follower] = assignRoles(a, b);

            // Only moving vehicles can be followers
            if (follower.status !== "in_transit" && follower.status !== "approaching") continue;

            // Both routes must exist
            const leaderRoute = linearizedRoutes.get(leader.routeId);
            const followerRoute = linearizedRoutes.get(follower.routeId);
            if (!leaderRoute || !followerRoute) continue;

            // Bidirectional route-overlap check
            const aOnB = findPositionOnRoute(followerRoute, leader.lon, leader.lat);
            if (aOnB.distance > MAX_CROSS_ROUTE_PROJECTION) continue;
            const bOnA = findPositionOnRoute(leaderRoute, follower.lon, follower.lat);
            if (bOnA.distance > MAX_CROSS_ROUTE_PROJECTION) continue;

            allPairs.push({ leader, follower, distance: dist });
        }
    }

    // --- Phase 2: Each follower keeps only nearest leader ---

    const bestByFollower = new Map<string, Pair>();
    for (const p of allPairs) {
        const existing = bestByFollower.get(p.follower.tripId);
        if (!existing || p.distance < existing.distance) {
            bestByFollower.set(p.follower.tripId, p);
        }
    }
    const pairs = [...bestByFollower.values()];

    // --- Phase 3: Prune stale persistent state ---

    for (const [fid, state] of followerStates) {
        if (!pairs.some(p => p.follower.tripId === fid && p.leader.tripId === state.leaderTripId)) {
            followerStates.delete(fid);
        }
    }

    // --- Phase 4: Compute caps ---

    for (const { leader, follower } of pairs) {
        const followerRoute = linearizedRoutes.get(follower.routeId);
        if (!followerRoute) continue;

        // Project leader onto follower's route
        const leaderOnFollowerRoute = findPositionOnRoute(followerRoute, leader.lon, leader.lat);
        const leaderAtStop = leader.status === "at_stop" || leader.status === "waiting";
        const separation = leaderAtStop
            ? MIN_VEHICLE_SEPARATION * 1.1
            : MIN_VEHICLE_SEPARATION;
        const maxPos = leaderOnFollowerRoute.linearPosition - separation;

        caps.set(follower.tripId, { maxLinearPosition: maxPos, routeId: follower.routeId });

        // Update persistent state
        const existing = followerStates.get(follower.tripId);
        if (!existing || existing.leaderTripId !== leader.tripId) {
            followerStates.set(follower.tripId, { leaderTripId: leader.tripId });
        }
    }

    return caps;
}

// --- RenderPositionFeature stub (keeps Settings panel toggle working) ---

export const collisionAvoidanceFeature: RenderPositionFeature = {
    id: "collision-avoidance",
    name: "Kollisionsvermeidung",
    description: "Verhindert, dass Fahrzeuge auf gemeinsamen Gleisen überlappen",
    defaultEnabled: true,

    // No-op: collision avoidance is now integrated into the smoothing step.
    processPositions(
        _vehicles: VehicleRenderContext[],
        _renderPositions: Map<string, RenderPosition>,
        _linearizedRoutes: Map<number, LinearizedRoute>,
    ): void {
        // Intentionally empty — caps are applied in VehicleRenderer.renderFrame()
    },
};

export const COLLISION_AVOIDANCE_FEATURE_ID = collisionAvoidanceFeature.id;
