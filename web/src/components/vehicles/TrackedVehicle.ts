import type { Vehicle, VehicleStop } from "../../api";
import type { RouteVehicles } from "../../hooks/useVehicleUpdates";

export interface TrackedVehicle {
    /** Stable entity ID (equals the first trip_id that created this entity) */
    id: string;
    /** Current GTFS trip_id (updates on loop transition via next_trip_id) */
    currentTripId: string;
    /** Trip IDs this entity has previously operated */
    tripHistory: string[];
    lineNumber: string;
    destination: string;
    origin: string | null;
    color: string;
    routeId: number;
    status: "active" | "lost";
    /** Whether this vehicle is pinned (persisted to localStorage) */
    pinned: boolean;
    /** Cached stops for display when vehicle is lost */
    lastKnownStops: VehicleStop[];
    /** Future: physical vehicle number from GPS tracking */
    physicalVehicleId?: string | null;
}

/** Serialized form for localStorage (only pinned vehicles are persisted) */
export interface PersistedVehicle {
    id: string;
    currentTripId: string;
    tripHistory: string[];
    lineNumber: string;
    destination: string;
    origin: string | null;
    color: string;
    routeId: number;
    lastKnownStops: VehicleStop[];
    physicalVehicleId?: string | null;
}

export function createTrackedVehicle(
    tripId: string,
    lineNumber: string,
    destination: string,
    origin: string | null,
    color: string,
    routeId: number,
    stops: VehicleStop[],
): TrackedVehicle {
    return {
        id: tripId,
        currentTripId: tripId,
        tripHistory: [],
        lineNumber,
        destination,
        origin,
        color,
        routeId,
        status: "active",
        pinned: false,
        lastKnownStops: stops,
    };
}

/** Handle loop transition: update the entity to track the new trip */
export function transitionTrip(
    entity: TrackedVehicle,
    newTripId: string,
    newVehicle: Vehicle | null,
): TrackedVehicle {
    return {
        ...entity,
        tripHistory: [...entity.tripHistory, entity.currentTripId],
        currentTripId: newTripId,
        destination: newVehicle?.destination ?? entity.destination,
        origin: newVehicle?.origin ?? entity.origin,
        status: "active",
        lastKnownStops: newVehicle?.stops ?? entity.lastKnownStops,
    };
}

/** Find a Vehicle object by trip_id across all route vehicle data */
export function findVehicleInRoutes(
    tripId: string,
    routeVehicles: RouteVehicles[],
): { vehicle: Vehicle; routeId: number } | null {
    for (const rv of routeVehicles) {
        const vehicle = rv.vehicles.find((v) => v.trip_id === tripId);
        if (vehicle) {
            return { vehicle, routeId: rv.routeId };
        }
    }
    return null;
}

/** Convert a TrackedVehicle to its persisted form (for localStorage) */
export function toPersistedVehicle(entity: TrackedVehicle): PersistedVehicle {
    return {
        id: entity.id,
        currentTripId: entity.currentTripId,
        tripHistory: entity.tripHistory,
        lineNumber: entity.lineNumber,
        destination: entity.destination,
        origin: entity.origin,
        color: entity.color,
        routeId: entity.routeId,
        lastKnownStops: entity.lastKnownStops,
        physicalVehicleId: entity.physicalVehicleId,
    };
}

/** Restore a TrackedVehicle from localStorage data */
export function fromPersistedVehicle(persisted: PersistedVehicle): TrackedVehicle {
    return {
        ...persisted,
        status: "lost", // Assume lost until confirmed by live data
        pinned: true, // Only pinned vehicles are persisted
    };
}

const STORAGE_KEY = "tracked-vehicles";

export function loadPersistedVehicles(): TrackedVehicle[] {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            const parsed: PersistedVehicle[] = JSON.parse(stored);
            return parsed.map(fromPersistedVehicle);
        }
    } catch (e) {
        console.error("Failed to load tracked vehicles from localStorage:", e);
    }
    return [];
}

export function savePersistedVehicles(vehicles: TrackedVehicle[]): void {
    try {
        const pinned = vehicles.filter((v) => v.pinned);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(pinned.map(toPersistedVehicle)));
    } catch (e) {
        console.error("Failed to save tracked vehicles to localStorage:", e);
    }
}
