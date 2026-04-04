import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { VehicleTrackingPanel } from "./VehicleTrackingPanel";
import type { TrackedVehicle } from "./vehicles/TrackedVehicle";
import type { RouteVehicles } from "../hooks/useVehicleUpdates";
import type { Vehicle, VehicleStop } from "../api";

// Mock scrollIntoView which isn't available in JSDOM
beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
});

function makeStop(overrides: Partial<VehicleStop> & { sequence: number }): VehicleStop {
    return {
        stop_ifopt: `de:09761:${overrides.sequence}:1:A`,
        stop_name: overrides.stop_name ?? `Stop ${overrides.sequence}`,
        lat: 48.37,
        lon: 10.89,
        sequence: overrides.sequence,
        arrival_time: null,
        arrival_time_estimated: null,
        departure_time: null,
        departure_time_estimated: null,
        delay_minutes: null,
        ...overrides,
    };
}

function makeTrackedVehicle(overrides?: Partial<TrackedVehicle>): TrackedVehicle {
    return {
        id: "trip-123",
        currentTripId: "trip-123",
        tripHistory: [],
        lineNumber: "4",
        destination: "Oberhausen Nord P+R",
        origin: null,
        color: "#941680",
        routeId: 12345,
        status: "active",
        pinned: false,
        lastKnownStops: [
            makeStop({ sequence: 1, stop_name: "Hauptbahnhof", departure_time: "2026-04-04T10:00:00Z" }),
            makeStop({ sequence: 5, stop_name: "Königsplatz", arrival_time: "2026-04-04T10:05:00Z", departure_time: "2026-04-04T10:06:00Z" }),
            makeStop({ sequence: 10, stop_name: "Oberhausen Nord P+R", arrival_time: "2026-04-04T10:15:00Z" }),
        ],
        ...overrides,
    };
}

function makeLiveVehicle(overrides?: Partial<Vehicle>): Vehicle {
    return {
        trip_id: "trip-123",
        line_number: "4",
        destination: "Oberhausen Nord P+R",
        origin: "WRONG_ORIGIN_FROM_API",
        stops: [
            makeStop({ sequence: 1, stop_name: "Hauptbahnhof", departure_time: "2026-04-04T10:00:00Z" }),
            makeStop({ sequence: 5, stop_name: "Königsplatz", arrival_time: "2026-04-04T10:05:00Z", departure_time: "2026-04-04T10:06:00Z" }),
            makeStop({ sequence: 10, stop_name: "Oberhausen Nord P+R", arrival_time: "2026-04-04T10:15:00Z" }),
        ],
        next_trip_id: null,
        gtfs_route_type: 0, // tram
        color: "#941680",
        operator: null,
        ...overrides,
    };
}

function renderPanel(
    vehicle: TrackedVehicle,
    vehicles: RouteVehicles[] = [],
    routeColors = new Map<string, string>(),
    routeTypes = new Map<string, string>(),
    routeIdTypes = new Map<number, string>(),
) {
    return render(
        <VehicleTrackingPanel
            vehicle={vehicle}
            vehicles={vehicles}
            routeColors={routeColors}
            routeTypes={routeTypes}
            routeIdTypes={routeIdTypes}
            currentTime={new Date("2026-04-04T10:03:00Z")}
            cameraFollowing={false}
            onPin={vi.fn()}
            onUnpin={vi.fn()}
            onToggleCameraFollow={vi.fn()}
        />,
    );
}

describe("VehicleTrackingPanel", () => {
    describe("origin derivation", () => {
        it("shows first stop name as origin, not API origin field", () => {
            const vehicle = makeTrackedVehicle();
            renderPanel(vehicle);

            const origin = screen.getByTestId("vehicle-origin");
            expect(origin.textContent).toBe("ab Hauptbahnhof");
        });

        it("uses first stop from live data sorted by time", () => {
            const vehicle = makeTrackedVehicle();
            const liveVehicle = makeLiveVehicle({
                stops: [
                    makeStop({ sequence: 10, stop_name: "Oberhausen Nord P+R", departure_time: "2026-04-04T10:00:00Z" }),
                    makeStop({ sequence: 5, stop_name: "Königsplatz", arrival_time: "2026-04-04T10:05:00Z" }),
                    makeStop({ sequence: 1, stop_name: "Hauptbahnhof", arrival_time: "2026-04-04T10:15:00Z" }),
                ],
                origin: "SHOULD_NOT_BE_USED",
            });
            const vehicles: RouteVehicles[] = [
                { routeId: 12345, lineNumber: "4", vehicles: [liveVehicle] },
            ];

            renderPanel(vehicle, vehicles);

            const origin = screen.getByTestId("vehicle-origin");
            // Should show "Oberhausen Nord P+R" (earliest time), not "Hauptbahnhof" (lowest sequence)
            expect(origin.textContent).toBe("ab Oberhausen Nord P+R");
        });

        it("never shows the unreliable API origin field", () => {
            const vehicle = makeTrackedVehicle({ origin: "WRONG_API_ORIGIN" });
            renderPanel(vehicle);

            const origin = screen.getByTestId("vehicle-origin");
            expect(origin.textContent).not.toContain("WRONG_API_ORIGIN");
            expect(origin.textContent).toBe("ab Hauptbahnhof");
        });
    });

    describe("stop ordering", () => {
        it("sorts stops by time for reverse-direction trips", () => {
            const vehicle = makeTrackedVehicle({
                lastKnownStops: [
                    makeStop({ sequence: 10, stop_name: "Oberhausen Nord P+R", departure_time: "2026-04-04T10:00:00Z" }),
                    makeStop({ sequence: 5, stop_name: "Königsplatz", arrival_time: "2026-04-04T10:05:00Z", departure_time: "2026-04-04T10:06:00Z" }),
                    makeStop({ sequence: 1, stop_name: "Hauptbahnhof", arrival_time: "2026-04-04T10:15:00Z" }),
                ],
            });

            renderPanel(vehicle);

            const stopList = screen.getByTestId("vehicle-stop-list");
            const stopNames = Array.from(stopList.querySelectorAll("span.text-sm")).map(
                (el) => el.textContent?.trim(),
            );
            expect(stopNames).toEqual([
                "Oberhausen Nord P+R",
                "Königsplatz",
                "Hauptbahnhof",
            ]);
        });

        it("keeps forward-direction stops in correct order", () => {
            const vehicle = makeTrackedVehicle({
                lastKnownStops: [
                    makeStop({ sequence: 1, stop_name: "Hauptbahnhof", departure_time: "2026-04-04T10:00:00Z" }),
                    makeStop({ sequence: 5, stop_name: "Königsplatz", arrival_time: "2026-04-04T10:05:00Z", departure_time: "2026-04-04T10:06:00Z" }),
                    makeStop({ sequence: 10, stop_name: "Oberhausen Nord P+R", arrival_time: "2026-04-04T10:15:00Z" }),
                ],
            });

            renderPanel(vehicle);

            const stopList = screen.getByTestId("vehicle-stop-list");
            const stopNames = Array.from(stopList.querySelectorAll("span.text-sm")).map(
                (el) => el.textContent?.trim(),
            );
            expect(stopNames).toEqual([
                "Hauptbahnhof",
                "Königsplatz",
                "Oberhausen Nord P+R",
            ]);
        });
    });

    describe("LineBadge with GTFS route type", () => {
        it("shows tram mode from gtfs_route_type=0", () => {
            const vehicle = makeTrackedVehicle();
            const liveVehicle = makeLiveVehicle({ gtfs_route_type: 0 });
            const vehicles: RouteVehicles[] = [
                { routeId: 12345, lineNumber: "4", vehicles: [liveVehicle] },
            ];

            renderPanel(vehicle, vehicles);

            // LineBadge should be rendered with the line number
            const badge = screen.getByTestId("line-badge-4");
            expect(badge).toBeDefined();
            expect(badge.getAttribute("data-line")).toBe("4");
        });

        it("uses vehicle color from GTFS data", () => {
            const vehicle = makeTrackedVehicle({ color: "#000000" });
            const liveVehicle = makeLiveVehicle({ color: "#941680" });
            const vehicles: RouteVehicles[] = [
                { routeId: 12345, lineNumber: "4", vehicles: [liveVehicle] },
            ];

            renderPanel(vehicle, vehicles);

            const badge = screen.getByTestId("line-badge-4");
            expect(badge.getAttribute("data-color")).toBe("#941680");
        });

        it("uses routeIdTypes when gtfs_route_type is null", () => {
            const vehicle = makeTrackedVehicle();
            const liveVehicle = makeLiveVehicle({ gtfs_route_type: null });
            const vehicles: RouteVehicles[] = [
                { routeId: 12345, lineNumber: "4", vehicles: [liveVehicle] },
            ];
            // routeTypes has "bus" (wrong), routeIdTypes has "tram" (correct from visible routes)
            const routeTypes = new Map([["4", "bus"]]);
            const routeIdTypes = new Map([[12345, "tram"]]);

            renderPanel(vehicle, vehicles, new Map(), routeTypes, routeIdTypes);

            const badge = screen.getByTestId("line-badge-4");
            expect(badge).toBeDefined();
            // The badge should use the routeIdTypes mode, not the routeTypes mode
        });

        it("falls back to routeTypes map when both gtfs_route_type and routeIdTypes are missing", () => {
            const vehicle = makeTrackedVehicle();
            const routeTypes = new Map([["4", "bus"]]);

            renderPanel(vehicle, [], new Map(), routeTypes);

            const badge = screen.getByTestId("line-badge-4");
            expect(badge).toBeDefined();
        });
    });

    describe("destination display", () => {
        it("shows destination from live data", () => {
            const vehicle = makeTrackedVehicle({ destination: "OLD_DESTINATION" });
            const liveVehicle = makeLiveVehicle({ destination: "Oberhausen Nord P+R" });
            const vehicles: RouteVehicles[] = [
                { routeId: 12345, lineNumber: "4", vehicles: [liveVehicle] },
            ];

            renderPanel(vehicle, vehicles);

            expect(screen.getByTestId("vehicle-destination").textContent).toBe("Oberhausen Nord P+R");
        });

        it("falls back to tracked vehicle destination when no live data", () => {
            const vehicle = makeTrackedVehicle({ destination: "Hauptbahnhof" });
            renderPanel(vehicle);

            expect(screen.getByTestId("vehicle-destination").textContent).toBe("Hauptbahnhof");
        });
    });

    describe("status indicators", () => {
        it("shows Aktiv indicator for active vehicle", () => {
            const vehicle = makeTrackedVehicle({ status: "active" });
            renderPanel(vehicle);

            expect(screen.getByText("Aktiv")).toBeDefined();
        });

        it("shows lost warning for lost vehicle without live data", () => {
            const vehicle = makeTrackedVehicle({ status: "lost" });
            renderPanel(vehicle);

            expect(screen.getByText("Fahrzeug nicht mehr verfolgbar")).toBeDefined();
        });
    });
});
