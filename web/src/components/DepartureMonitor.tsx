import { LocateFixed, Pin, PinOff, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { Departure } from "../api";
import { getApiClient } from "../apiClient";
import { DepartureMonitorHeader } from "./DepartureMonitorHeader";
import { DepartureTable } from "./DepartureTable";
import { Button } from "./ui/button";

interface DepartureMonitorProps {
    /** OSM ID used to fetch departures */
    osmId: number;
    /** Display title (e.g. "Steig A1") */
    title: string;
    /** Parent station name */
    stationName?: string;
    /** IFOPT identifier to display */
    refIfopt?: string | null;
    routeColors: globalThis.Map<string, string>;
    routeTypes?: globalThis.Map<string, string>;
    /** When set, requests schedule-based departures for this simulated time */
    referenceTime?: Date;
    /** Whether this stop is currently pinned to the sidebar */
    isPinned?: boolean;
    /** Callback to pin this stop */
    onPin?: () => void;
    /** Callback to unpin this stop */
    onUnpin?: () => void;
    /** Callback to close (only shown in popup context) */
    onClose?: () => void;
    /** Callback to fly to this stop on the map */
    onLocate?: () => void;
    /** Extra content below IDs in the header */
    headerExtra?: ReactNode;
}

export function DepartureMonitor({ osmId, title, stationName, refIfopt, routeColors, routeTypes, referenceTime, isPinned, onPin, onUnpin, onClose, onLocate, headerExtra }: DepartureMonitorProps) {
    const [events, setEvents] = useState<Departure[]>([]);
    const [gtfsStopId, setGtfsStopId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const abortRef = useRef<AbortController | null>(null);

    const fetchDepartures = useCallback(() => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        const refTime = referenceTime ? referenceTime.toISOString() : undefined;

        const request = fetch(`${getApiClient().baseUrl}/api/departures/by-osm-id`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ osm_id: osmId, reference_time: refTime }),
            signal: controller.signal,
        }).then((res) => res.json()).then((data) => ({
            departures: data.departures ?? [],
            gtfsStopId: data.gtfs_stop_id ?? null,
        }));

        return request
            .then((result) => {
                if (!controller.signal.aborted) {
                    setEvents(result.departures);
                    setGtfsStopId(result.gtfsStopId);
                }
            })
            .catch((err) => {
                if (!controller.signal.aborted) {
                    console.error("Failed to fetch departures:", err);
                    setEvents([]);
                }
            });
    }, [osmId, referenceTime]);

    useEffect(() => {
        if (!osmId) {
            setLoading(false);
            return;
        }
        setLoading(true);
        fetchDepartures()?.finally(() => setLoading(false));
        return () => abortRef.current?.abort();
    }, [fetchDepartures, osmId]);

    useEffect(() => {
        const interval = setInterval(fetchDepartures, 30000);
        return () => clearInterval(interval);
    }, [fetchDepartures]);

    const actions = (
        <>
            {onLocate && (
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={onLocate}
                    title="Auf Karte anzeigen"
                >
                    <LocateFixed className="h-3.5 w-3.5" />
                </Button>
            )}
            {isPinned ? (
                onUnpin && (
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={onUnpin}
                        title="Loslösen"
                    >
                        <PinOff className="h-3.5 w-3.5" />
                    </Button>
                )
            ) : (
                onPin && (
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={onPin}
                        title="An Seitenleiste anheften"
                    >
                        <Pin className="h-3.5 w-3.5" />
                    </Button>
                )
            )}
            {onClose && (
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={onClose}
                    title="Schließen"
                >
                    <X className="h-3.5 w-3.5" />
                </Button>
            )}
        </>
    );

    return (
        <div className="flex flex-col">
            <div className="px-4 py-3">
                <DepartureMonitorHeader
                    title={title}
                    stationName={stationName}
                    ids={[
                        { label: "OSM", value: String(osmId) },
                        ...(refIfopt ? [{ label: "IFOPT", value: refIfopt }] : []),
                        ...(gtfsStopId ? [{ label: "GTFS", value: gtfsStopId }] : []),
                    ]}
                    extra={headerExtra}
                    actions={actions}
                />
            </div>
            <div className="border-t border-border px-4 py-2">
                {loading ? (
                    <div className="text-xs text-muted-foreground">Laden...</div>
                ) : (
                    <DepartureTable
                        events={events}
                        routeColors={routeColors}
                        routeTypes={routeTypes}
                        referenceTime={referenceTime}
                    />
                )}
            </div>
        </div>
    );
}
