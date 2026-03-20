/**
 * Simulated Station Stops Feature
 * Makes vehicles stop at stations even without explicit dwell time in the schedule
 * Stop probability varies by time of day (95% at 5am, 50% at midnight)
 */

import type { VehicleFeature } from "./types";

// Simulated dwell time at stations (in milliseconds)
export const MIN_DWELL_TIME_MS = 20000; // 20 seconds minimum
export const MAX_DWELL_TIME_MS = 30000; // 30 seconds maximum

/**
 * Calculate the probability of stopping at a station based on time of day
 * Early morning (5am): 95% chance
 * Late night (midnight): 50% chance
 * Linear interpolation between these values
 */
export function getStopProbabilityForTime(time: Date): number {
    const hour = time.getHours();
    const minute = time.getMinutes();
    const timeInHours = hour + minute / 60;

    // Normalize time: treat 0-5am as 24-29 for continuity
    const normalizedHour = timeInHours < 5 ? timeInHours + 24 : timeInHours;

    // From 5am (5) to midnight (24), probability goes from 95% to 50%
    // That's 19 hours, dropping 45 percentage points
    const hoursFromMorning = normalizedHour - 5;
    const probability = 0.95 - (hoursFromMorning / 19) * 0.45;

    return Math.max(0.5, Math.min(0.95, probability));
}

/**
 * Deterministic pseudo-random function based on trip_id and stop
 * Returns a value between 0 and 1 that's consistent for the same inputs
 */
export function deterministicRandom(tripId: string, stopIfopt: string): number {
    const str = `${tripId}:${stopIfopt}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash % 10000) / 10000;
}

/**
 * Check if a vehicle should stop at a station (for stations without explicit dwell time)
 */
export function shouldStopAtStation(tripId: string, stopIfopt: string, currentTime: Date): boolean {
    const probability = getStopProbabilityForTime(currentTime);
    const random = deterministicRandom(tripId, stopIfopt);
    return random < probability;
}

/**
 * Get a varied dwell time for a specific stop (deterministic)
 */
export function getDwellTimeMs(tripId: string, stopIfopt: string): number {
    const random = deterministicRandom(tripId, stopIfopt + ":dwell");
    return MIN_DWELL_TIME_MS + random * (MAX_DWELL_TIME_MS - MIN_DWELL_TIME_MS);
}

export const simulatedStopsFeature: VehicleFeature = {
    id: "simulated-stops",
    name: "Simulierte Haltestellenstopps",
    description: "Fahrzeuge halten an Haltestellen auch ohne explizite Haltezeit (Wahrscheinlichkeit variiert nach Tageszeit)",
    defaultEnabled: true,
};
