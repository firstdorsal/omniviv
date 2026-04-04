import { describe, it, expect } from "vitest";
import { EventType, type Departure } from "../api";
import { buildTripEvents } from "./DepartureTable";

function makeDeparture(overrides: Partial<Departure> & { trip_id: string; line_number: string }): Departure {
    return {
        stop_ifopt: "de:07:1234",
        event_type: EventType.Departure,
        destination: "Hauptbahnhof",
        planned_time: "2026-03-19T10:00:00Z",
        estimated_time: null,
        delay_minutes: null,
        platform: null,
        destination_id: null,
        ...overrides,
    };
}

describe("buildTripEvents", () => {
    it("groups arrival and departure by trip_id", () => {
        const events: Departure[] = [
            makeDeparture({
                trip_id: "trip1",
                line_number: "1",
                event_type: EventType.Arrival,
                planned_time: "2026-03-19T10:00:00Z",
            }),
            makeDeparture({
                trip_id: "trip1",
                line_number: "1",
                event_type: EventType.Departure,
                planned_time: "2026-03-19T10:01:00Z",
            }),
        ];

        const result = buildTripEvents(events);
        expect(result).toHaveLength(1);
        expect(result[0].arrivalTime).toBe("2026-03-19T10:00:00Z");
        expect(result[0].departureTime).toBe("2026-03-19T10:01:00Z");
    });

    it("sorts trips by earliest time", () => {
        const events: Departure[] = [
            makeDeparture({ trip_id: "late", line_number: "2", planned_time: "2026-03-19T11:00:00Z" }),
            makeDeparture({ trip_id: "early", line_number: "1", planned_time: "2026-03-19T09:00:00Z" }),
        ];

        const result = buildTripEvents(events);
        expect(result[0].tripId).toBe("early");
        expect(result[1].tripId).toBe("late");
    });

    it("prefers estimated_time over planned_time", () => {
        const events: Departure[] = [
            makeDeparture({
                trip_id: "trip1",
                line_number: "3",
                planned_time: "2026-03-19T10:00:00Z",
                estimated_time: "2026-03-19T10:03:00Z",
            }),
        ];

        const result = buildTripEvents(events);
        expect(result[0].departureTime).toBe("2026-03-19T10:03:00Z");
        expect(result[0].departureIsLive).toBe(true);
    });

    it("marks non-live events correctly", () => {
        const events: Departure[] = [
            makeDeparture({
                trip_id: "trip1",
                line_number: "4",
                planned_time: "2026-03-19T10:00:00Z",
                estimated_time: null,
            }),
        ];

        const result = buildTripEvents(events);
        expect(result[0].departureIsLive).toBe(false);
    });

    it("preserves delay info from later events", () => {
        const events: Departure[] = [
            makeDeparture({
                trip_id: "trip1",
                line_number: "1",
                event_type: EventType.Arrival,
                delay_minutes: null,
            }),
            makeDeparture({
                trip_id: "trip1",
                line_number: "1",
                event_type: EventType.Departure,
                delay_minutes: 3,
            }),
        ];

        const result = buildTripEvents(events);
        expect(result[0].delayMinutes).toBe(3);
    });

    it("collects distinct line numbers from multiple trips", () => {
        const events: Departure[] = [
            makeDeparture({ trip_id: "t1", line_number: "1" }),
            makeDeparture({ trip_id: "t2", line_number: "2" }),
            makeDeparture({ trip_id: "t3", line_number: "1" }),
            makeDeparture({ trip_id: "t4", line_number: "6" }),
        ];

        const result = buildTripEvents(events);
        const lines = new Set(result.map((t) => t.lineNumber));
        expect(lines).toEqual(new Set(["1", "2", "6"]));
    });

    it("marks cancelled trips", () => {
        const events: Departure[] = [
            makeDeparture({
                trip_id: "trip1",
                line_number: "1",
                cancelled: true,
            }),
        ];

        const result = buildTripEvents(events);
        expect(result).toHaveLength(1);
        expect(result[0].cancelled).toBe(true);
    });

    it("non-cancelled trips are not marked", () => {
        const events: Departure[] = [
            makeDeparture({
                trip_id: "trip1",
                line_number: "1",
            }),
        ];

        const result = buildTripEvents(events);
        expect(result[0].cancelled).toBe(false);
    });

    it("partial cancellation propagates to trip", () => {
        const events: Departure[] = [
            makeDeparture({
                trip_id: "trip1",
                line_number: "1",
                event_type: EventType.Arrival,
                cancelled: false,
            }),
            makeDeparture({
                trip_id: "trip1",
                line_number: "1",
                event_type: EventType.Departure,
                cancelled: true,
            }),
        ];

        const result = buildTripEvents(events);
        expect(result[0].cancelled).toBe(true);
    });

    it("skips events without trip_id", () => {
        const events: Departure[] = [
            makeDeparture({ trip_id: "trip1", line_number: "1" }),
            { ...makeDeparture({ trip_id: "", line_number: "2" }), trip_id: undefined as unknown as string },
        ];

        const result = buildTripEvents(events);
        expect(result).toHaveLength(1);
        expect(result[0].tripId).toBe("trip1");
    });

    it("propagates color from departure to trip event", () => {
        const events: Departure[] = [
            makeDeparture({ trip_id: "trip1", line_number: "1", color: "#ee1d23" }),
        ];
        const result = buildTripEvents(events);
        expect(result[0].color).toBe("#ee1d23");
    });

    it("propagates operator from departure to trip event", () => {
        const events: Departure[] = [
            makeDeparture({ trip_id: "trip1", line_number: "RE9", operator: "GYRE Arverio Bayern GmbH" }),
        ];
        const result = buildTripEvents(events);
        expect(result[0].operator).toBe("GYRE Arverio Bayern GmbH");
    });

    it("propagates gtfs_route_type from departure to trip event", () => {
        const events: Departure[] = [
            makeDeparture({ trip_id: "trip1", line_number: "1", gtfs_route_type: 0 }),
        ];
        const result = buildTripEvents(events);
        expect(result[0].gtfsRouteType).toBe(0);
    });

    it("sets is_first_stop and is_last_stop correctly", () => {
        const events: Departure[] = [
            makeDeparture({ trip_id: "trip1", line_number: "1", is_first_stop: true, is_last_stop: false }),
        ];
        const result = buildTripEvents(events);
        expect(result[0].isFirstStop).toBe(true);
        expect(result[0].isLastStop).toBe(false);
    });

    it("defaults operator to null when not provided", () => {
        const events: Departure[] = [
            makeDeparture({ trip_id: "trip1", line_number: "1" }),
        ];
        const result = buildTripEvents(events);
        expect(result[0].operator).toBeNull();
    });
});
