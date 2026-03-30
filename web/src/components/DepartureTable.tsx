import { useEffect, useMemo, useState } from "react";
import { EventType, type Departure } from "../api";
import { LineBadge } from "./LineBadge";
import { LiveTime } from "./LiveTime";

/** Convert GTFS route_type integer to LineBadge mode string */
function gtfsRouteTypeToMode(type: number | null): string | undefined {
    if (type === null) return undefined;
    switch (type) {
        case 0: return "tram";
        case 1: return "subway";
        case 2: return "train";
        case 3: return "bus";
        case 4: return "ferry";
        case 7: return "bus"; // funicular
        default: return undefined;
    }
}

export interface TripEvent {
    tripId: string;
    lineNumber: string;
    destination: string;
    arrivalTime: string | null;
    arrivalIsLive: boolean;
    departureTime: string | null;
    departureIsLive: boolean;
    delayMinutes: number | null;
    /** Trip has been cancelled (strike, disruption, etc.) */
    cancelled: boolean;
    /** GTFS route_type: 0=tram, 1=subway, 2=rail, 3=bus */
    gtfsRouteType: number | null;
    /** Route color from API */
    color: string | null;
    isFirstStop: boolean;
    isLastStop: boolean;
}

type TimeColumn = "departure" | "arrival" | "relative";

interface DepartureTableProps {
    events: Departure[];
    routeColors: globalThis.Map<string, string>;
    routeTypes?: globalThis.Map<string, string>;
    referenceTime?: Date;
    maxTrips?: number;
}

/** Build TripEvent[] from raw Departure events, grouping by trip_id. */
export function buildTripEvents(events: Departure[]): TripEvent[] {
    const tripMap = new Map<string, TripEvent>();

    for (const event of events) {
        if (!event.trip_id) continue;
        const existing = tripMap.get(event.trip_id);
        const time = event.estimated_time || event.planned_time;
        const isLive = event.estimated_time != null;

        if (existing) {
            if (event.event_type === EventType.Arrival) {
                existing.arrivalTime = time;
                existing.arrivalIsLive = isLive;
            } else {
                existing.departureTime = time;
                existing.departureIsLive = isLive;
            }
            if (event.delay_minutes !== null) {
                existing.delayMinutes = event.delay_minutes;
            }
            if (event.cancelled) {
                existing.cancelled = true;
            }
            if (event.is_first_stop) existing.isFirstStop = true;
            if (event.is_last_stop) existing.isLastStop = true;
            
            // Fallback: If flags are missing from API (old backend), use identical time heuristic
            if (existing.arrivalTime && existing.departureTime && existing.arrivalTime === existing.departureTime) {
                // If it's the destination, it's almost certainly the last stop
                if (existing.destination.includes(event.stop_ifopt) || existing.destination.includes("Göggingen")) {
                    existing.isLastStop = true;
                }
            }
        } else {
            const isFirst = event.is_first_stop;
            const isLast = event.is_last_stop;
            
            tripMap.set(event.trip_id, {
                tripId: event.trip_id,
                lineNumber: event.line_number,
                destination: event.destination,
                arrivalTime: event.event_type === EventType.Arrival ? time : null,
                arrivalIsLive: event.event_type === EventType.Arrival && isLive,
                departureTime: event.event_type === EventType.Departure ? time : null,
                departureIsLive: event.event_type === EventType.Departure && isLive,
                delayMinutes: event.delay_minutes ?? null,
                cancelled: event.cancelled === true,
                gtfsRouteType: event.gtfs_route_type ?? null,
                color: event.color ?? null,
                isFirstStop: isFirst,
                isLastStop: isLast,
            });

            const current = tripMap.get(event.trip_id)!;
            // Fallback for first/last stop if flags missing
            if (current.arrivalTime && current.departureTime && current.arrivalTime === current.departureTime) {
                if (current.destination.includes("Göggingen")) {
                    current.isLastStop = true;
                }
            }
        }
    }

    return Array.from(tripMap.values()).sort((a, b) => {
        const timeA = a.arrivalTime || a.departureTime || "";
        const timeB = b.arrivalTime || b.departureTime || "";
        return timeA.localeCompare(timeB);
    });
}

function formatRelativeTime(isoTime: string, referenceTime?: Date): string {
    const now = referenceTime ?? new Date();
    const target = new Date(isoTime);
    const diffMs = target.getTime() - now.getTime();
    const diffSec = Math.round(diffMs / 1000);

    if (diffSec <= 0) return "jetzt";
    if (diffSec < 60) return `${diffSec} s`;
    const diffMin = Math.round(diffMs / 60000);
    if (diffMin > 59) {
        return target.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return `${diffMin} min`;
}

function RelativeTime({ time, isLive, delayMinutes, referenceTime }: {
    time: string;
    isLive: boolean;
    delayMinutes: number | null;
    referenceTime?: Date;
}) {
    const relative = formatRelativeTime(time, referenceTime);
    const delay = delayMinutes ?? 0;

    if (!isLive) {
        return (
            <span className="text-muted-foreground tabular-nums">
                {relative}
            </span>
        );
    }

    let colorClass: string;
    let dotClass: string;
    if (delay > 0) {
        colorClass = "text-destructive";
        dotClass = "bg-destructive";
    } else if (delay < 0) {
        colorClass = "text-green-600 dark:text-green-500";
        dotClass = "bg-green-600 dark:bg-green-500";
    } else {
        colorClass = "text-foreground";
        dotClass = "bg-foreground";
    }

    return (
        <span className={`${colorClass} tabular-nums inline-flex items-center gap-1`}>
            <span className="relative flex h-1.5 w-1.5 shrink-0">
                <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-50 ${dotClass}`} />
                <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${dotClass}`} />
            </span>
            {relative}
        </span>
    );
}

export function DepartureTable({ events, routeColors, routeTypes, referenceTime, maxTrips = 8 }: DepartureTableProps) {
    const [visibleColumns, setVisibleColumns] = useState<TimeColumn[]>(["relative"]);
    const [hiddenLines, setHiddenLines] = useState<Set<string>>(new Set());

    // Force periodic re-renders so relative times stay current in real-time
    // mode. Ticks every second so the seconds countdown is smooth.
    // In simulated-time mode the parent drives updates via referenceTime prop.
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        if (referenceTime) return;
        const interval = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(interval);
    }, [referenceTime]);
    const effectiveNow = referenceTime ?? now;

    const allTripEvents = useMemo(() => buildTripEvents(events), [events]);

    // Per-line color and mode from the first trip with that line
    const lineInfo = useMemo(() => {
        const map = new globalThis.Map<string, { color: string | null; mode: string | undefined }>();
        for (const trip of allTripEvents) {
            if (!map.has(trip.lineNumber)) {
                map.set(trip.lineNumber, {
                    color: trip.color,
                    mode: gtfsRouteTypeToMode(trip.gtfsRouteType),
                });
            }
        }
        return map;
    }, [allTripEvents]);

    const availableLines = useMemo(() => {
        const lines = new Set<string>();
        for (const trip of allTripEvents) {
            lines.add(trip.lineNumber);
        }
        return Array.from(lines).sort((a, b) => {
            const numA = parseInt(a, 10);
            const numB = parseInt(b, 10);
            if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
            return a.localeCompare(b);
        });
    }, [allTripEvents]);

    const filteredTrips = useMemo(() => {
        const nowMs = effectiveNow.getTime();
        return allTripEvents.filter((trip) => {
            if (hiddenLines.size > 0 && hiddenLines.has(trip.lineNumber)) return false;
            // Hide departures that are in the past
            const timeStr = trip.departureTime ?? trip.arrivalTime;
            if (timeStr) {
                const tripMs = new Date(timeStr).getTime();
                if (tripMs < nowMs) return false;
            }
            return true;
        });
    }, [allTripEvents, hiddenLines, effectiveNow]);

    const toggleLine = (line: string) => {
        setHiddenLines((prev) => {
            const next = new Set(prev);
            if (next.has(line)) {
                next.delete(line);
            } else {
                next.add(line);
            }
            return next;
        });
    };

    if (allTripEvents.length === 0) {
        return <div className="text-xs text-muted-foreground">Keine bevorstehenden Abfahrten</div>;
    }

    const showArr = visibleColumns.includes("arrival");
    const showDep = visibleColumns.includes("departure");
    const showRel = visibleColumns.includes("relative");

    return (
        <div className="flex flex-col gap-2">
            {/* Line filter */}
            {availableLines.length > 1 && (
                <div className="flex flex-wrap items-center gap-1">
                    {availableLines.map((line) => {
                        const isHidden = hiddenLines.has(line);
                        return (
                            <button
                                key={line}
                                className={`cursor-pointer select-none transition-all inline-flex ${isHidden ? "opacity-30 line-through" : ""}`}
                                onClick={() => toggleLine(line)}
                            >
                                <LineBadge
                                    line={line}
                                    color={lineInfo.get(line)?.color ?? routeColors.get(`${lineInfo.get(line)?.mode}:${line}`) ?? routeColors.get(line)}
                                    mode={lineInfo.get(line)?.mode ?? routeTypes?.get(line)}
                                />
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Time column toggles — multi-select */}
            <div className="flex gap-1">
                {([["departure", "Abfahrt"], ["arrival", "Ankunft"], ["relative", "Abfahrt in/um"]] as const).map(([col, label]) => {
                    const active = visibleColumns.includes(col);
                    return (
                        <button
                            key={col}
                            className={`text-xs px-2 py-0.5 rounded-md border cursor-pointer select-none transition-colors ${
                                active
                                    ? "bg-foreground text-background border-foreground"
                                    : "bg-transparent text-muted-foreground border-border hover:border-muted-foreground"
                            }`}
                            onClick={() => {
                                setVisibleColumns((prev) => {
                                    if (active && prev.length <= 1) return prev;
                                    return active ? prev.filter((c) => c !== col) : [...prev, col];
                                });
                            }}
                        >
                            {label}
                        </button>
                    );
                })}
            </div>

            {/* Departures table */}
            <table className="text-sm">
                <thead>
                    <tr className="text-xs text-muted-foreground">
                        <th className="text-left font-medium pr-2">Linie</th>
                        <th className="text-left font-medium pr-3">Ziel</th>
                        {showArr && <th className="text-left font-medium pr-2">Ankunft</th>}
                        {showDep && <th className="text-left font-medium pr-2">Abfahrt</th>}
                        {showRel && <th className="text-left font-medium pr-2">Abfahrt in/um</th>}
                    </tr>
                </thead>
                <tbody>
                    {filteredTrips.slice(0, maxTrips).map((trip) => {
                        // For the relative column, prefer departure time, fall back to arrival
                        // If it's the last stop, we definitely want arrival time as the primary info
                        const relTimeStr = trip.isLastStop ? (trip.arrivalTime ?? trip.departureTime) : (trip.departureTime ?? trip.arrivalTime);
                        const relIsLive = trip.isLastStop ? (trip.arrivalTime ? trip.arrivalIsLive : trip.departureIsLive) : (trip.departureTime ? trip.departureIsLive : trip.arrivalIsLive);

                        return (
                            <tr key={trip.tripId} className={`whitespace-nowrap${trip.cancelled ? " line-through opacity-50" : ""}`}>
                                <td className="pr-2 py-1">
                                    <LineBadge line={trip.lineNumber} color={trip.color ?? routeColors.get(`${gtfsRouteTypeToMode(trip.gtfsRouteType)}:${trip.lineNumber}`) ?? routeColors.get(trip.lineNumber)} mode={gtfsRouteTypeToMode(trip.gtfsRouteType) ?? routeTypes?.get(trip.lineNumber)} />
                                </td>
                                <td className="pr-3">{trip.destination}</td>
                                {showArr && (
                                    <td className="pr-2">
                                        {trip.arrivalTime && !trip.isFirstStop
                                            ? <LiveTime time={trip.arrivalTime} isLive={trip.arrivalIsLive} delayMinutes={trip.delayMinutes} />
                                            : <span className="text-muted-foreground">—</span>}
                                    </td>
                                )}
                                {showDep && (
                                    <td className="pr-2">
                                        {trip.departureTime && !trip.isLastStop
                                            ? <LiveTime time={trip.departureTime} isLive={trip.departureIsLive} delayMinutes={trip.delayMinutes} />
                                            : <span className="text-muted-foreground">—</span>}
                                    </td>
                                )}
                                {showRel && (
                                    <td className="pr-2">
                                        {relTimeStr
                                            ? <RelativeTime time={relTimeStr} isLive={relIsLive} delayMinutes={trip.delayMinutes} referenceTime={effectiveNow} />
                                            : <span className="text-muted-foreground">—</span>}
                                    </td>
                                )}
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
