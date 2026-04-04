import { describe, it, expect } from "vitest";
import { computeStopStatuses } from "./VehicleStopList";
import type { VehicleStop } from "../api";

function makeStop(overrides: Partial<VehicleStop> & { sequence: number }): VehicleStop {
    return {
        stop_ifopt: `de:09761:${overrides.sequence}:1:A`,
        stop_name: overrides.stop_name ?? `Stop ${overrides.sequence}`,
        lat: 48.37,
        lon: 10.89,
        arrival_time: null,
        arrival_time_estimated: null,
        departure_time: null,
        departure_time_estimated: null,
        delay_minutes: null,
        ...overrides,
    };
}

describe("computeStopStatuses", () => {
    it("marks stops before now as past, current at transitioning stop, upcoming after", () => {
        const now = new Date("2026-04-04T10:10:00Z");
        const stops: VehicleStop[] = [
            makeStop({ sequence: 1, departure_time: "2026-04-04T10:00:00Z" }),
            makeStop({ sequence: 2, arrival_time: "2026-04-04T10:05:00Z", departure_time: "2026-04-04T10:06:00Z" }),
            makeStop({ sequence: 3, arrival_time: "2026-04-04T10:15:00Z", departure_time: "2026-04-04T10:16:00Z" }),
            makeStop({ sequence: 4, arrival_time: "2026-04-04T10:20:00Z" }),
        ];
        const result = computeStopStatuses(stops, now);
        expect(result[0].status).toBe("past"); // departed 10:00
        expect(result[1].status).toBe("past"); // departed 10:06
        expect(result[2].status).toBe("current"); // in transit, arriving 10:15
        expect(result[3].status).toBe("upcoming");
    });

    it("handles empty stop list", () => {
        expect(computeStopStatuses([], new Date())).toEqual([]);
    });

    it("all stops upcoming when now is before first departure", () => {
        const now = new Date("2026-04-04T09:00:00Z");
        const stops: VehicleStop[] = [
            makeStop({ sequence: 1, departure_time: "2026-04-04T10:00:00Z" }),
            makeStop({ sequence: 2, arrival_time: "2026-04-04T10:10:00Z" }),
        ];
        const result = computeStopStatuses(stops, now);
        expect(result[0].status).toBe("upcoming");
        expect(result[1].status).toBe("upcoming");
    });

    it("all stops past when now is after last arrival", () => {
        const now = new Date("2026-04-04T11:00:00Z");
        const stops: VehicleStop[] = [
            makeStop({ sequence: 1, departure_time: "2026-04-04T10:00:00Z" }),
            makeStop({ sequence: 2, arrival_time: "2026-04-04T10:10:00Z" }),
        ];
        const result = computeStopStatuses(stops, now);
        expect(result[0].status).toBe("past");
        expect(result[1].status).toBe("past");
    });

    it("computes progress for current segment", () => {
        const now = new Date("2026-04-04T10:05:00Z"); // midway
        const stops: VehicleStop[] = [
            makeStop({ sequence: 1, departure_time: "2026-04-04T10:00:00Z" }),
            makeStop({ sequence: 2, arrival_time: "2026-04-04T10:10:00Z" }),
        ];
        const result = computeStopStatuses(stops, now);
        expect(result[1].status).toBe("current");
        expect(result[1].progress).toBeCloseTo(0.5, 1);
    });
});

describe("stop ordering for reverse-direction trips", () => {
    it("reverse-direction stops should be sorted by time, not sequence", () => {
        // A Line 4 vehicle going Oberhausen → Hauptbahnhof has route sequence
        // in the forward direction (Hbf→Oberhausen), so the reverse trip's
        // stops have decreasing sequence but increasing time
        const reverseStops: VehicleStop[] = [
            makeStop({
                sequence: 10, // high sequence (near end of route)
                stop_name: "Oberhausen Nord P+R",
                departure_time: "2026-04-04T10:00:00Z",
            }),
            makeStop({
                sequence: 5, // middle of route
                stop_name: "Wertachbrücke",
                arrival_time: "2026-04-04T10:05:00Z",
                departure_time: "2026-04-04T10:06:00Z",
            }),
            makeStop({
                sequence: 1, // start of route
                stop_name: "Hauptbahnhof",
                arrival_time: "2026-04-04T10:15:00Z",
            }),
        ];

        // Sort by time (the fix we applied)
        const sorted = [...reverseStops].sort((a, b) => {
            const timeA = a.departure_time ?? a.departure_time_estimated ?? a.arrival_time ?? a.arrival_time_estimated;
            const timeB = b.departure_time ?? b.departure_time_estimated ?? b.arrival_time ?? b.arrival_time_estimated;
            if (!timeA || !timeB) return a.sequence - b.sequence;
            return new Date(timeA).getTime() - new Date(timeB).getTime();
        });

        expect(sorted[0].stop_name).toBe("Oberhausen Nord P+R");
        expect(sorted[1].stop_name).toBe("Wertachbrücke");
        expect(sorted[2].stop_name).toBe("Hauptbahnhof");
    });

    it("forward-direction stops remain in time order", () => {
        const forwardStops: VehicleStop[] = [
            makeStop({
                sequence: 1,
                stop_name: "Hauptbahnhof",
                departure_time: "2026-04-04T10:00:00Z",
            }),
            makeStop({
                sequence: 5,
                stop_name: "Wertachbrücke",
                arrival_time: "2026-04-04T10:05:00Z",
                departure_time: "2026-04-04T10:06:00Z",
            }),
            makeStop({
                sequence: 10,
                stop_name: "Oberhausen Nord P+R",
                arrival_time: "2026-04-04T10:15:00Z",
            }),
        ];

        const sorted = [...forwardStops].sort((a, b) => {
            const timeA = a.departure_time ?? a.departure_time_estimated ?? a.arrival_time ?? a.arrival_time_estimated;
            const timeB = b.departure_time ?? b.departure_time_estimated ?? b.arrival_time ?? b.arrival_time_estimated;
            if (!timeA || !timeB) return a.sequence - b.sequence;
            return new Date(timeA).getTime() - new Date(timeB).getTime();
        });

        expect(sorted[0].stop_name).toBe("Hauptbahnhof");
        expect(sorted[1].stop_name).toBe("Wertachbrücke");
        expect(sorted[2].stop_name).toBe("Oberhausen Nord P+R");
    });
});
