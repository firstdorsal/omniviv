import { PinOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Departure } from "../api";
import { getApiClient } from "../apiClient";
import { DepartureTable } from "./DepartureTable";
import { Button } from "./ui/button";

export interface PinnedStop {
    /** Unique identifier — currently the stop's IFOPT */
    id: string;
    /** IFOPT used to query departures */
    stopIfopt: string;
    /** Short display name shown in the sidebar tab (e.g. "Steig A1") */
    displayName: string;
    /** Parent station name (e.g. "Königsplatz") */
    stationName?: string;
}

interface DeparturesPanelProps {
    stop: PinnedStop;
    routeColors: globalThis.Map<string, string>;
    /** When set, fetches schedule-based departures for this simulated time */
    referenceTime?: Date;
    onUnpin: (id: string) => void;
}

export function DeparturesPanel({ stop, routeColors, referenceTime, onUnpin }: DeparturesPanelProps) {
    const [events, setEvents] = useState<Departure[]>([]);
    const [loading, setLoading] = useState(true);
    const abortRef = useRef<AbortController | null>(null);

    const fetchDepartures = useCallback(() => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        return getApiClient().api
            .getDeparturesByStop({
                stop_ifopt: stop.stopIfopt,
                reference_time: referenceTime ? referenceTime.toISOString() : undefined,
            })
            .then((res) => {
                if (!controller.signal.aborted) {
                    setEvents(res.data?.departures ?? []);
                }
            })
            .catch(() => {
                if (!controller.signal.aborted) setEvents([]);
            });
    }, [stop.stopIfopt, referenceTime]);

    // Initial fetch + refetch on dependency change
    useEffect(() => {
        setLoading(true);
        fetchDepartures().finally(() => setLoading(false));
        return () => abortRef.current?.abort();
    }, [fetchDepartures]);

    // Auto-refresh every 30 seconds
    useEffect(() => {
        const interval = setInterval(fetchDepartures, 30000);
        return () => clearInterval(interval);
    }, [fetchDepartures]);

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b px-4 py-2">
                <div>
                    <div className="text-sm font-semibold">{stop.displayName}</div>
                    {stop.stationName && (
                        <div className="text-xs text-muted-foreground">{stop.stationName}</div>
                    )}
                </div>
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => onUnpin(stop.id)}
                    title="Loslösen"
                >
                    <PinOff className="h-3.5 w-3.5" />
                </Button>
            </div>
            <div className="flex-1 overflow-y-auto">
                {loading ? (
                    <div className="p-4 text-xs text-muted-foreground">Laden...</div>
                ) : (
                    <div className="p-4">
                        <DepartureTable
                            events={events}
                            routeColors={routeColors}
                            referenceTime={referenceTime}
                            maxTrips={15}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}
