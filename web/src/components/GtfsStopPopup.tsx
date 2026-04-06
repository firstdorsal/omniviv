import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Departure } from "../api";
import { getApiClient } from "../apiClient";
import { DebugLogButtonDirect } from "./DebugLogButton";
import { DepartureMonitorHeader } from "./DepartureMonitorHeader";
import { DepartureTable } from "./DepartureTable";

interface GtfsStopPopupProps {
    stopId: string;
    stopName: string;
    /** IFOPT mapped to this GTFS stop (if assigned) — used to fetch departures */
    ifopt: string | null;
    isAssigned: boolean;
    routeColors: globalThis.Map<string, string>;
    routeTypes?: globalThis.Map<string, string>;
    referenceTime?: Date;
    onClose?: () => void;
    debugMode?: boolean;
}

export function GtfsStopPopup({ stopId, stopName, ifopt, isAssigned, routeColors, routeTypes, referenceTime, onClose, debugMode = false }: GtfsStopPopupProps) {
    const [events, setEvents] = useState<Departure[]>([]);
    const [loading, setLoading] = useState(true);
    const abortRef = useRef<AbortController | null>(null);

    const fetchDepartures = useCallback(() => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        const refTime = referenceTime ? referenceTime.toISOString() : undefined;

        const promise = ifopt
            ? getApiClient().api.getDeparturesByStop({
                  stop_ifopt: ifopt,
                  reference_time: refTime,
              }).then((res) => res.data?.departures ?? [])
            : getApiClient().api.getDeparturesByGtfsStop({
                  gtfs_stop_id: stopId,
                  reference_time: refTime,
              }).then((res) => res.data?.departures ?? []);

        return promise
            .then((departures) => {
                if (!controller.signal.aborted) setEvents(departures);
            })
            .catch((err) => {
                if (!controller.signal.aborted) {
                    console.error("Failed to fetch departures:", err);
                    setEvents([]);
                }
            });
    }, [stopId, ifopt, referenceTime]);

    useEffect(() => {
        setLoading(true);
        fetchDepartures()?.finally(() => setLoading(false));
        return () => abortRef.current?.abort();
    }, [fetchDepartures]);

    useEffect(() => {
        const interval = setInterval(fetchDepartures, 30000);
        return () => clearInterval(interval);
    }, [fetchDepartures]);

    return (
        <div className="bg-popover text-popover-foreground rounded-lg">
            <div className="flex max-h-[70vh] w-[24rem] max-w-[calc(100vw-2rem)] flex-col">
                <div className="px-4 py-3">
                    <DepartureMonitorHeader
                        title={stopName}
                        ids={[{ value: stopId }]}
                        extra={<>
                            {isAssigned && ifopt && (
                                <div className="text-xs text-muted-foreground mt-0.5">
                                    Zugeordnet zu <span className="font-mono">{ifopt}</span>
                                </div>
                            )}
                            {!isAssigned && (
                                <div className="text-xs text-orange-500 mt-0.5">Nicht zugeordnet</div>
                            )}
                        </>}
                        actions={<>
                            <DebugLogButtonDirect label="GtfsStop" data={{ stopId, stopName, ifopt, isAssigned, departures: events }} enabled={debugMode} />
                            {onClose && (
                                <button onClick={onClose} className="shrink-0 p-1 text-muted-foreground hover:text-foreground hover:bg-secondary rounded" title="Schließen">
                                    <X className="w-4 h-4" />
                                </button>
                            )}
                        </>}
                    />
                </div>
                <div className="border-t border-border min-h-0 flex-1 overflow-y-auto px-4 py-2">
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
        </div>
    );
}
