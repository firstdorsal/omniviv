import { describe, it, expect } from "vitest";
import { isDark, estimateVehiclePosition, distanceMeters } from "./useRendezvous";
import type { Vehicle } from "../api";

describe("isDark", () => {
    it("returns false before sunset in summer", () => {
        // June 15, 18:00 — well before sunset (~21:15)
        expect(isDark(new Date(2026, 5, 15, 18, 0))).toBe(false);
    });

    it("returns true after sunset in summer", () => {
        // June 15, 22:00 — after sunset (~21:15)
        expect(isDark(new Date(2026, 5, 15, 22, 0))).toBe(true);
    });

    it("returns true after sunset in winter", () => {
        // December 15, 17:00 — after sunset (~16:15)
        expect(isDark(new Date(2026, 11, 15, 17, 0))).toBe(true);
    });

    it("returns false before sunset in winter", () => {
        // December 15, 15:00 — before sunset (~16:15)
        expect(isDark(new Date(2026, 11, 15, 15, 0))).toBe(false);
    });
});

describe("distanceMeters", () => {
    it("returns 0 for same point", () => {
        expect(distanceMeters(48.365, 10.894, 48.365, 10.894)).toBe(0);
    });

    it("returns approximately correct distance for known points", () => {
        // Königsplatz to Hauptbahnhof Augsburg, ~1.3 km
        const dist = distanceMeters(48.3653, 10.8941, 48.3656, 10.8856);
        expect(dist).toBeGreaterThan(500);
        expect(dist).toBeLessThan(1500);
    });
});

describe("estimateVehiclePosition", () => {
    function makeVehicle(stops: { lat: number; lon: number; dep?: string; arr?: string }[]): Vehicle {
        return {
            trip_id: "trip1",
            line_number: "1",
            destination: "Test",
            origin: null,
            next_trip_id: null,
            stops: stops.map((s, i) => ({
                stop_ifopt: `stop_${i}`,
                stop_name: null,
                sequence: i + 1,
                lat: s.lat,
                lon: s.lon,
                arrival_time: s.arr ?? null,
                arrival_time_estimated: null,
                departure_time: s.dep ?? null,
                departure_time_estimated: null,
                delay_minutes: null,
            })),
        };
    }

    it("returns null for empty stops", () => {
        const vehicle = makeVehicle([]);
        expect(estimateVehiclePosition(vehicle, new Date())).toBeNull();
    });

    it("returns first stop position before departure", () => {
        const vehicle = makeVehicle([
            { lat: 48.37, lon: 10.89, dep: "2026-03-20T10:00:00Z" },
            { lat: 48.38, lon: 10.90, arr: "2026-03-20T10:15:00Z" },
        ]);
        const before = new Date("2026-03-20T09:50:00Z");
        const pos = estimateVehiclePosition(vehicle, before);
        expect(pos).toEqual({ lat: 48.37, lon: 10.89 });
    });

    it("returns last stop position after arrival", () => {
        const vehicle = makeVehicle([
            { lat: 48.37, lon: 10.89, dep: "2026-03-20T10:00:00Z" },
            { lat: 48.38, lon: 10.90, arr: "2026-03-20T10:15:00Z" },
        ]);
        const after = new Date("2026-03-20T10:20:00Z");
        const pos = estimateVehiclePosition(vehicle, after);
        expect(pos).toEqual({ lat: 48.38, lon: 10.90 });
    });

    it("interpolates position between stops", () => {
        const vehicle = makeVehicle([
            { lat: 48.37, lon: 10.89, dep: "2026-03-20T10:00:00Z" },
            { lat: 48.38, lon: 10.90, arr: "2026-03-20T10:10:00Z" },
        ]);
        // Halfway between departure and arrival
        const halfway = new Date("2026-03-20T10:05:00Z");
        const pos = estimateVehiclePosition(vehicle, halfway);
        expect(pos).not.toBeNull();
        expect(pos!.lat).toBeCloseTo(48.375, 3);
        expect(pos!.lon).toBeCloseTo(10.895, 3);
    });

    it("handles zero-duration segment without division by zero", () => {
        const vehicle = makeVehicle([
            { lat: 48.37, lon: 10.89, dep: "2026-03-20T10:00:00Z" },
            { lat: 48.38, lon: 10.90, arr: "2026-03-20T10:00:00Z" }, // same time = 0 duration
        ]);
        // At that exact time — should not crash
        const pos = estimateVehiclePosition(vehicle, new Date("2026-03-20T10:00:00Z"));
        expect(pos).not.toBeNull();
        // Should be at stop 0 (dwelling), not NaN from division by zero
        expect(Number.isFinite(pos!.lat)).toBe(true);
        expect(Number.isFinite(pos!.lon)).toBe(true);
    });
});
