import { useEffect, useMemo, useState } from "react";
import type { Vehicle } from "../api";
import type { RouteVehicles } from "./useVehicleUpdates";

// Königsplatz coordinates (center of rendezvous area)
const KOENIGSPLATZ_CENTER = { lat: 48.365223, lon: 10.894151 };
const KOENIGSPLATZ_RADIUS_M = 100; // meters

// Rendezvous time window
const RENDEZVOUS_START_MINUTES = 20 * 60 + 30; // 20:30
const RENDEZVOUS_END_MINUTES = 24 * 60; // midnight

// Time before departure when flashing starts (seconds)
const FLASH_AFTER_SECONDS = 60;
const FLASH_INTERVAL_MS = 500;

export interface RendezvousState {
    isActive: boolean;
    isRendezvous: boolean;
    tramCount: number;
    trams: { tripId: string; lineNumber: string | null }[];
}

export interface HighlightedBuilding {
    lat: number;
    lon: number;
    color: string;
}

interface UseRendezvousOptions {
    enabled: boolean;
    currentTime: Date;
    vehicles: RouteVehicles[];
}

interface UseRendezvousResult {
    rendezvousState: RendezvousState | null;
    highlightedBuilding: HighlightedBuilding | null;
    shouldFlash: boolean;
}

// Calculate if it's dark based on date (approximate sunset times for Augsburg)
function isDark(date: Date): boolean {
    const month = date.getMonth(); // 0-11
    const hour = date.getHours();
    const minute = date.getMinutes();
    const timeInMinutes = hour * 60 + minute;

    // Approximate sunset times for Augsburg by month (in minutes from midnight)
    const sunsetTimes = [
        17 * 60,      // Jan: ~17:00
        18 * 60,      // Feb: ~18:00
        18 * 60 + 45, // Mar: ~18:45
        20 * 60,      // Apr: ~20:00
        20 * 60 + 45, // May: ~20:45
        21 * 60 + 15, // Jun: ~21:15
        21 * 60,      // Jul: ~21:00
        20 * 60 + 15, // Aug: ~20:15
        19 * 60 + 15, // Sep: ~19:15
        18 * 60 + 15, // Oct: ~18:15
        16 * 60 + 45, // Nov: ~16:45
        16 * 60 + 15, // Dec: ~16:15
    ];

    return timeInMinutes >= sunsetTimes[month];
}

/**
 * Estimate a vehicle's current lat/lon by interpolating between its scheduled stops.
 * Returns null when the vehicle has no usable timing data.
 */
function estimateVehiclePosition(vehicle: Vehicle, currentTime: Date): { lat: number; lon: number } | null {
    const { stops } = vehicle;
    if (stops.length === 0) return null;

    const now = currentTime.getTime();

    for (let i = 0; i < stops.length; i++) {
        const stop = stops[i];
        const arrival = stop.arrival_time_estimated ?? stop.arrival_time;
        const departure = stop.departure_time_estimated ?? stop.departure_time;
        const arrivalMs = arrival ? new Date(arrival).getTime() : null;
        const departureMs = departure ? new Date(departure).getTime() : null;
        const effectiveDeparture = departureMs ?? arrivalMs;

        // Vehicle is dwelling at this stop
        if (arrivalMs && effectiveDeparture && now >= arrivalMs && now <= effectiveDeparture) {
            return { lat: stop.lat, lon: stop.lon };
        }

        // Vehicle is in transit between this stop and the next
        if (i < stops.length - 1) {
            const nextStop = stops[i + 1];
            const nextArrival = nextStop.arrival_time_estimated ?? nextStop.arrival_time;
            const nextArrivalMs = nextArrival ? new Date(nextArrival).getTime() : null;

            if (effectiveDeparture && nextArrivalMs && now >= effectiveDeparture && now < nextArrivalMs) {
                const progress = (now - effectiveDeparture) / (nextArrivalMs - effectiveDeparture);
                return {
                    lat: stop.lat + progress * (nextStop.lat - stop.lat),
                    lon: stop.lon + progress * (nextStop.lon - stop.lon),
                };
            }
        }
    }

    // Before first stop — show at first stop's position
    const firstTime = stops[0].departure_time_estimated ?? stops[0].departure_time
        ?? stops[0].arrival_time_estimated ?? stops[0].arrival_time;
    if (firstTime && now < new Date(firstTime).getTime()) {
        return { lat: stops[0].lat, lon: stops[0].lon };
    }

    // After last stop — show at last stop's position
    const lastStop = stops[stops.length - 1];
    const lastTime = lastStop.arrival_time_estimated ?? lastStop.arrival_time
        ?? lastStop.departure_time_estimated ?? lastStop.departure_time;
    if (lastTime && now > new Date(lastTime).getTime()) {
        return { lat: lastStop.lat, lon: lastStop.lon };
    }

    return null;
}

// Calculate distance between two points in meters (Haversine)
function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function useRendezvous({ enabled, currentTime, vehicles }: UseRendezvousOptions): UseRendezvousResult {
    const [flashOn, setFlashOn] = useState(true);
    const [rendezvousStartTime, setRendezvousStartTime] = useState<Date | null>(null);

    // Calculate rendezvous state
    const rendezvousState = useMemo((): RendezvousState | null => {
        if (!enabled) return null;

        const hour = currentTime.getHours();
        const minute = currentTime.getMinutes();
        const timeInMinutes = hour * 60 + minute;

        // Only active between 20:30 and midnight
        if (timeInMinutes < RENDEZVOUS_START_MINUTES || timeInMinutes >= RENDEZVOUS_END_MINUTES) {
            return null;
        }

        // Check if it's dark
        if (!isDark(currentTime)) {
            return null;
        }

        // Count trams at Königsplatz by estimating each vehicle's current position
        const tramsAtKoenigsplatz: { tripId: string; lineNumber: string | null }[] = [];
        for (const routeVehicles of vehicles) {
            for (const vehicle of routeVehicles.vehicles) {
                const position = estimateVehiclePosition(vehicle, currentTime);
                if (position) {
                    const dist = distanceMeters(
                        KOENIGSPLATZ_CENTER.lat,
                        KOENIGSPLATZ_CENTER.lon,
                        position.lat,
                        position.lon
                    );
                    if (dist <= KOENIGSPLATZ_RADIUS_M) {
                        tramsAtKoenigsplatz.push({
                            tripId: vehicle.trip_id,
                            lineNumber: routeVehicles.lineNumber,
                        });
                    }
                }
            }
        }

        const isRendezvous = tramsAtKoenigsplatz.length >= 2;

        return {
            isActive: true,
            isRendezvous,
            tramCount: tramsAtKoenigsplatz.length,
            trams: tramsAtKoenigsplatz,
        };
    }, [enabled, currentTime, vehicles]);

    // Track rendezvous timing for flash detection
    useEffect(() => {
        if (rendezvousState?.isRendezvous && !rendezvousStartTime) {
            setRendezvousStartTime(currentTime);
        } else if (!rendezvousState?.isRendezvous) {
            setRendezvousStartTime(null);
        }
    }, [rendezvousState?.isRendezvous, currentTime, rendezvousStartTime]);

    // Calculate if we should flash (1 minute before typical departure)
    const shouldFlash = useMemo(() => {
        if (!rendezvousState?.isRendezvous || !rendezvousStartTime) return false;
        const elapsed = currentTime.getTime() - rendezvousStartTime.getTime();
        const elapsedSeconds = elapsed / 1000;
        return elapsedSeconds >= FLASH_AFTER_SECONDS;
    }, [rendezvousState?.isRendezvous, rendezvousStartTime, currentTime]);

    // Flash animation timer
    useEffect(() => {
        if (!shouldFlash) {
            setFlashOn(true);
            return;
        }

        const interval = setInterval(() => {
            setFlashOn((prev) => !prev);
        }, FLASH_INTERVAL_MS);

        return () => clearInterval(interval);
    }, [shouldFlash]);

    // Calculate highlighted building
    const highlightedBuilding = useMemo((): HighlightedBuilding | null => {
        if (!enabled || !rendezvousState?.isActive) {
            return null;
        }

        let color: string;
        if (rendezvousState.isRendezvous) {
            // Green when trams are meeting, dim green when flashing off
            color = shouldFlash && !flashOn ? "#0a7518" : "#18ed31";
        } else {
            // Blue when waiting for trams
            color = "#1155f5";
        }

        return {
            lat: KOENIGSPLATZ_CENTER.lat,
            lon: KOENIGSPLATZ_CENTER.lon,
            color,
        };
    }, [enabled, rendezvousState, shouldFlash, flashOn]);

    return {
        rendezvousState,
        highlightedBuilding,
        shouldFlash,
    };
}
