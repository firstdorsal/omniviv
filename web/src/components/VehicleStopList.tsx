import { Check, Circle, CircleDot, MapPin } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { VehicleStop } from "../api";
import { LiveTime } from "./LiveTime";

export type StopStatus = "past" | "current" | "upcoming";

export interface StopWithStatus {
    stop: VehicleStop;
    status: StopStatus;
    /** Progress through the current segment (0-1), only set for the "current" stop */
    progress?: number;
}

/**
 * Compute the status of each stop based on the current simulated time.
 * "past" = vehicle has departed this stop
 * "current" = vehicle is at this stop or in transit toward the next
 * "upcoming" = vehicle hasn't reached this stop yet
 */
export function computeStopStatuses(
    stops: VehicleStop[],
    currentTime: Date,
): StopWithStatus[] {
    const now = currentTime.getTime();
    const result: StopWithStatus[] = [];

    for (let i = 0; i < stops.length; i++) {
        const stop = stops[i];
        const departureStr = stop.departure_time_estimated ?? stop.departure_time;
        const arrivalStr = stop.arrival_time_estimated ?? stop.arrival_time;

        const departureMs = departureStr ? new Date(departureStr).getTime() : null;
        const arrivalMs = arrivalStr ? new Date(arrivalStr).getTime() : null;

        // Last stop: use arrival time
        if (i === stops.length - 1) {
            if (arrivalMs !== null && now >= arrivalMs) {
                result.push({ stop, status: "past" });
            } else {
                // Check if we're in transit to this stop (previous departed)
                const prevStop = i > 0 ? stops[i - 1] : null;
                const prevDepartureStr = prevStop
                    ? (prevStop.departure_time_estimated ?? prevStop.departure_time)
                    : null;
                const prevDepartureMs = prevDepartureStr ? new Date(prevDepartureStr).getTime() : null;

                if (prevDepartureMs !== null && now >= prevDepartureMs && arrivalMs !== null) {
                    const progress = Math.min(1, Math.max(0,
                        (now - prevDepartureMs) / (arrivalMs - prevDepartureMs)
                    ));
                    result.push({ stop, status: "current", progress });
                } else {
                    result.push({ stop, status: "upcoming" });
                }
            }
            continue;
        }

        // For non-last stops: departed = past
        if (departureMs !== null && now >= departureMs) {
            result.push({ stop, status: "past" });
            continue;
        }

        // At this stop (arrived but not departed)
        if (arrivalMs !== null && now >= arrivalMs) {
            result.push({ stop, status: "current", progress: 1 });
            continue;
        }

        // In transit to this stop?
        const prevStop = i > 0 ? stops[i - 1] : null;
        const prevDepartureStr = prevStop
            ? (prevStop.departure_time_estimated ?? prevStop.departure_time)
            : null;
        const prevDepartureMs = prevDepartureStr ? new Date(prevDepartureStr).getTime() : null;

        if (prevDepartureMs !== null && now >= prevDepartureMs && arrivalMs !== null) {
            const progress = Math.min(1, Math.max(0,
                (now - prevDepartureMs) / (arrivalMs - prevDepartureMs)
            ));
            result.push({ stop, status: "current", progress });
            continue;
        }

        result.push({ stop, status: "upcoming" });
    }

    return result;
}

function formatDelay(minutes: number | null | undefined): string | null {
    if (minutes === null || minutes === undefined || minutes === 0) return null;
    const sign = minutes > 0 ? "+" : "";
    return `${sign}${minutes} min`;
}

interface VehicleStopListProps {
    stops: VehicleStop[];
    currentTime: Date;
    disabled?: boolean;
}

export function VehicleStopList({ stops, currentTime, disabled }: VehicleStopListProps) {
    const currentStopRef = useRef<HTMLDivElement>(null);

    // Ensure stops are sorted by time before computing statuses.
    // Route sequence only reflects one direction; reverse-direction trips
    // need time-based sorting to display in correct chronological order.
    const sortedStops = useMemo(
        () => [...stops].sort((a, b) => {
            const timeA = a.departure_time ?? a.departure_time_estimated ?? a.arrival_time ?? a.arrival_time_estimated;
            const timeB = b.departure_time ?? b.departure_time_estimated ?? b.arrival_time ?? b.arrival_time_estimated;
            if (!timeA || !timeB) return a.sequence - b.sequence;
            return new Date(timeA).getTime() - new Date(timeB).getTime();
        }),
        [stops],
    );

    const stopsWithStatus = computeStopStatuses(sortedStops, currentTime);

    // Auto-scroll to current stop
    useEffect(() => {
        if (currentStopRef.current) {
            currentStopRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
        }
    }, [stopsWithStatus.find((s) => s.status === "current")?.stop.sequence]);

    if (sortedStops.length === 0) {
        return <div className="text-xs text-muted-foreground p-2">Keine Haltestellen bekannt</div>;
    }

    return (
        <div className={`flex flex-col ${disabled ? "opacity-50" : ""}`} data-testid="vehicle-stop-list">
            {stopsWithStatus.map((item, index) => {
                const { stop, status, progress } = item;
                const isCurrent = status === "current";
                const isPast = status === "past";

                const arrivalStr = stop.arrival_time_estimated ?? stop.arrival_time;
                const departureStr = stop.departure_time_estimated ?? stop.departure_time;
                const arrivalIsLive = stop.arrival_time_estimated != null;
                const departureIsLive = stop.departure_time_estimated != null;
                const delay = formatDelay(stop.delay_minutes);

                // Show the most relevant time: departure for non-last stops, arrival for last
                const isLast = index === stopsWithStatus.length - 1;
                const isFirst = index === 0;

                return (
                    <div
                        key={stop.stop_ifopt + stop.sequence}
                        ref={isCurrent ? currentStopRef : undefined}
                        className={`relative flex items-start gap-2 px-3 py-1.5 ${
                            isCurrent
                                ? "bg-accent/50"
                                : ""
                        } ${isPast ? "opacity-50" : ""}`}
                    >
                        {/* Timeline indicator */}
                        <div className="flex flex-col items-center shrink-0 w-5 pt-0.5">
                            {isPast ? (
                                <Check className="h-4 w-4 text-muted-foreground" />
                            ) : isCurrent ? (
                                <CircleDot className="h-4 w-4 text-primary" />
                            ) : index === stopsWithStatus.length - 1 ? (
                                <MapPin className="h-4 w-4 text-muted-foreground" />
                            ) : (
                                <Circle className="h-4 w-4 text-muted-foreground" />
                            )}
                            {/* Connecting line */}
                            {index < stopsWithStatus.length - 1 && (
                                <div className="w-0.5 flex-1 min-h-2 bg-border mt-0.5" />
                            )}
                        </div>

                        {/* Stop content */}
                        <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2">
                                <span className={`text-sm truncate ${
                                    isCurrent ? "font-medium" : ""
                                }`}>
                                    {stop.stop_name ?? stop.stop_ifopt}
                                </span>
                                {delay && (
                                    <span className={`text-xs shrink-0 tabular-nums ${
                                        (stop.delay_minutes ?? 0) > 0
                                            ? "text-destructive"
                                            : "text-green-600 dark:text-green-500"
                                    }`}>
                                        {delay}
                                    </span>
                                )}
                            </div>

                            {/* Times row */}
                            <div className="flex items-center gap-2 text-xs mt-0.5">
                                {isFirst && departureStr && (
                                    <span className="flex items-center gap-1">
                                        <span className="text-muted-foreground">Ab</span>
                                        <LiveTime time={departureStr} isLive={departureIsLive} delayMinutes={stop.delay_minutes ?? null} />
                                    </span>
                                )}
                                {!isFirst && arrivalStr && (
                                    <span className="flex items-center gap-1">
                                        <span className="text-muted-foreground">An</span>
                                        <LiveTime time={arrivalStr} isLive={arrivalIsLive} delayMinutes={stop.delay_minutes ?? null} />
                                    </span>
                                )}
                                {!isFirst && !isLast && departureStr && arrivalStr && (
                                    <span className="flex items-center gap-1">
                                        <span className="text-muted-foreground">Ab</span>
                                        <LiveTime time={departureStr} isLive={departureIsLive} delayMinutes={stop.delay_minutes ?? null} />
                                    </span>
                                )}
                                {isLast && !isFirst && departureStr && !arrivalStr && (
                                    <span className="flex items-center gap-1">
                                        <span className="text-muted-foreground">Ab</span>
                                        <LiveTime time={departureStr} isLive={departureIsLive} delayMinutes={stop.delay_minutes ?? null} />
                                    </span>
                                )}
                            </div>

                            {/* Progress bar for current segment */}
                            {isCurrent && progress !== undefined && progress < 1 && (
                                <div className="mt-1.5 h-1.5 bg-secondary rounded-full overflow-hidden">
                                    <div
                                        className="h-full bg-primary rounded-full transition-all duration-500"
                                        style={{ width: `${Math.round(progress * 100)}%` }}
                                    />
                                </div>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
