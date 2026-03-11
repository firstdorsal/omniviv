/**
 * Collision Avoidance Feature
 *
 * Prevents vehicles from visually overlapping by adjusting their smoothing
 * speed. When two vehicles are too close (same route or different routes
 * sharing the same physical track), the trailing vehicle slows down and
 * the leading vehicle speeds up, creating gradual separation over time.
 *
 * Key design decisions:
 * - Compares ALL vehicle pairs using geographic proximity (haversine distance)
 * - Uses speed multipliers instead of position jumps to avoid bearing flips
 * - Stateless per-frame: multipliers are recomputed each frame based on current positions
 * - Vehicles at stops are not slowed (they legitimately cluster at stations)
 * - Opposite-direction vehicles are ignored
 * - Multipliers scale with proximity: closer vehicles get stronger adjustments
 */

import type { SpeedAdjustmentFeature, VehicleRenderContext } from "./types";
import type { LinearizedRoute } from "../vehicleUtils";

/** Distance below which vehicles start being separated (meters) */
export const SEPARATION_DISTANCE = 40;

/** Minimum speed multiplier for the trailing vehicle (0.0 = fully stopped) */
export const MIN_SPEED_MULTIPLIER = 0.3;

/** Maximum speed multiplier for the leading vehicle */
export const MAX_SPEED_MULTIPLIER = 1.5;

/** Bearing difference threshold for opposite directions (degrees) */
const OPPOSITE_DIRECTION_THRESHOLD = 90;

/**
 * Calculate the smallest angle between two bearings (0-180)
 */
function bearingDifference(a: number, b: number): number {
    let diff = Math.abs(a - b) % 360;
    if (diff > 180) diff = 360 - diff;
    return diff;
}

/**
 * Haversine distance between two lon/lat points in meters
 */
function haversineDistance(lon1: number, lat1: number, lon2: number, lat2: number): number {
    const R = 6371000;
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export const collisionAvoidanceFeature: SpeedAdjustmentFeature = {
    id: "collision-avoidance",
    name: "Collision Avoidance",
    description: "Prevents nearby vehicles from overlapping by adjusting speed",
    defaultEnabled: true,

    computeSpeedAdjustments(
        vehicles: VehicleRenderContext[],
        _linearizedRoutes: Map<number, LinearizedRoute>
    ): Map<string, number> {
        const adjustments = new Map<string, number>();

        if (vehicles.length < 2) return adjustments;

        // Compare all pairs of vehicles
        for (let i = 0; i < vehicles.length; i++) {
            for (let j = i + 1; j < vehicles.length; j++) {
                const a = vehicles[i];
                const b = vehicles[j];

                // Skip if traveling in opposite directions
                if (bearingDifference(
                    a.smoothedPosition.renderedBearing,
                    b.smoothedPosition.renderedBearing
                ) > OPPOSITE_DIRECTION_THRESHOLD) {
                    continue;
                }

                // Check geographic proximity using rendered positions
                const distance = haversineDistance(
                    a.smoothedPosition.renderedLon,
                    a.smoothedPosition.renderedLat,
                    b.smoothedPosition.renderedLon,
                    b.smoothedPosition.renderedLat
                );

                if (distance >= SEPARATION_DISTANCE) continue;

                // Determine leader/follower by linear position
                const aIsLeader = a.linearPosition >= b.linearPosition;
                const leader = aIsLeader ? a : b;
                const follower = aIsLeader ? b : a;

                // Don't adjust vehicles that are stopped or haven't started
                if (follower.smoothedPosition.status === "at_stop" ||
                    follower.smoothedPosition.status === "waiting") continue;

                // Scale adjustment by proximity: at distance=0 apply max adjustment,
                // at distance=SEPARATION_DISTANCE apply no adjustment
                const proximityFactor = 1 - (distance / SEPARATION_DISTANCE);

                // Slow down the follower
                const followerMultiplier = 1.0 - proximityFactor * (1.0 - MIN_SPEED_MULTIPLIER);
                const currentFollower = adjustments.get(follower.tripId) ?? 1.0;
                adjustments.set(follower.tripId, Math.min(currentFollower, followerMultiplier));

                // Speed up the leader (unless it's stopped or waiting)
                if (leader.smoothedPosition.status !== "at_stop" &&
                    leader.smoothedPosition.status !== "waiting") {
                    const leaderMultiplier = 1.0 + proximityFactor * (MAX_SPEED_MULTIPLIER - 1.0);
                    const currentLeader = adjustments.get(leader.tripId) ?? 1.0;
                    adjustments.set(leader.tripId, Math.max(currentLeader, leaderMultiplier));
                }
            }
        }

        return adjustments;
    },
};
