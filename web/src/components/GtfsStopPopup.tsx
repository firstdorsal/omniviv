import { useEffect, useMemo, useState } from "react";
import { EventType, type Departure } from "../api";
import { getApiClient } from "../apiClient";
import { formatTime } from "./map/mapUtils";

interface GtfsStopPopupProps {
    stopId: string;
    stopName: string;
    /** IFOPT mapped to this GTFS stop (if assigned) — used to fetch departures */
    ifopt: string | null;
    isAssigned: boolean;
    routeColors: globalThis.Map<string, string>;
    referenceTime?: Date;
}

interface TripEvent {
    tripId: string;
    lineNumber: string;
    destination: string;
    arrivalTime: string | null;
    departureTime: string | null;
    delayMinutes: number | null;
}

export function GtfsStopPopup({ stopId, stopName, ifopt, isAssigned, routeColors, referenceTime }: GtfsStopPopupProps) {
    const [events, setEvents] = useState<Departure[]>([]);
    const [loading, setLoading] = useState(true);

    const tripEvents = useMemo(() => {
        const tripMap = new Map<string, TripEvent>();

        for (const event of events) {
            const existing = tripMap.get(event.trip_id);
            const time = event.estimated_time || event.planned_time;

            if (existing) {
                if (event.event_type === EventType.Arrival) {
                    existing.arrivalTime = time;
                } else {
                    existing.departureTime = time;
                }
                if (event.delay_minutes !== null) {
                    existing.delayMinutes = event.delay_minutes;
                }
            } else {
                tripMap.set(event.trip_id, {
                    tripId: event.trip_id,
                    lineNumber: event.line_number,
                    destination: event.destination,
                    arrivalTime: event.event_type === EventType.Arrival ? time : null,
                    departureTime: event.event_type === EventType.Departure ? time : null,
                    delayMinutes: event.delay_minutes ?? null,
                });
            }
        }

        return Array.from(tripMap.values()).sort((a, b) => {
            const timeA = a.arrivalTime || a.departureTime || "";
            const timeB = b.arrivalTime || b.departureTime || "";
            return timeA.localeCompare(timeB);
        });
    }, [events]);

    useEffect(() => {
        const refTime = referenceTime ? referenceTime.toISOString() : undefined;

        const fetchDepartures = ifopt
            ? getApiClient().api.getDeparturesByStop({
                  stop_ifopt: ifopt,
                  reference_time: refTime,
              }).then((res) => res.data?.departures ?? [])
            : getApiClient().api.getDeparturesByGtfsStop({
                  gtfs_stop_id: stopId,
                  reference_time: refTime,
              }).then((res) => res.data?.departures ?? []);

        fetchDepartures
            .then((departures) => setEvents(departures))
            .catch((err) => {
                console.error("Failed to fetch departures:", err);
                setEvents([]);
            })
            .finally(() => setLoading(false));
    }, [stopId, ifopt, referenceTime]);

    return (
        <div className="p-4 pr-8 bg-popover text-popover-foreground rounded-lg">
            <div className="font-semibold text-foreground">{stopName}</div>
            <div className="text-xs text-muted-foreground font-mono">{stopId}</div>
            {isAssigned && ifopt && (
                <div className="text-xs text-muted-foreground mt-0.5">
                    Mapped to <span className="font-mono">{ifopt}</span>
                </div>
            )}
            {!isAssigned && (
                <div className="text-xs text-orange-500 mt-0.5">Unmapped candidate</div>
            )}

            <div className="mt-3 border-t border-border pt-2">
                {loading ? (
                    <div className="text-xs text-muted-foreground">Loading...</div>
                ) : tripEvents.length === 0 ? (
                    <div className="text-xs text-muted-foreground">No upcoming departures</div>
                ) : (
                    <table className="text-sm">
                        <thead>
                            <tr className="text-xs text-muted-foreground">
                                <th className="text-left font-medium pr-2">Line</th>
                                <th className="text-left font-medium pr-3">Destination</th>
                                <th className="text-left font-medium pr-2">Arrival</th>
                                <th className="text-left font-medium pr-2">Departure</th>
                                <th className="text-left font-medium"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {tripEvents.slice(0, 8).map((trip) => {
                                const color = routeColors.get(trip.lineNumber) || "#6b7280";
                                const delayMinutes = trip.delayMinutes ?? 0;
                                return (
                                    <tr key={trip.tripId} className="whitespace-nowrap">
                                        <td className="font-mono font-semibold pr-2" style={{ color } as React.CSSProperties}>
                                            {trip.lineNumber}
                                        </td>
                                        <td className="pr-3">{trip.destination}</td>
                                        <td className="text-muted-foreground tabular-nums pr-2">
                                            {trip.arrivalTime ? formatTime(trip.arrivalTime) : "—"}
                                        </td>
                                        <td className="text-muted-foreground tabular-nums pr-2">
                                            {trip.departureTime ? formatTime(trip.departureTime) : "—"}
                                        </td>
                                        <td>
                                            {delayMinutes > 0 && (
                                                <span className="text-destructive text-xs font-medium">+{delayMinutes}</span>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>

        </div>
    );
}
