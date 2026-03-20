import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { type Departure } from "../api";
import { getApiClient } from "../apiClient";
import { DepartureTable } from "./DepartureTable";

interface GtfsStopPopupProps {
    stopId: string;
    stopName: string;
    /** IFOPT mapped to this GTFS stop (if assigned) — used to fetch departures */
    ifopt: string | null;
    isAssigned: boolean;
    routeColors: globalThis.Map<string, string>;
    referenceTime?: Date;
    onClose?: () => void;
}

export function GtfsStopPopup({ stopId, stopName, ifopt, isAssigned, routeColors, referenceTime, onClose }: GtfsStopPopupProps) {
    const [events, setEvents] = useState<Departure[]>([]);
    const [loading, setLoading] = useState(true);

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
        <div className="p-4 bg-popover text-popover-foreground rounded-lg">
            <div className="flex items-start gap-2">
                <div className="font-semibold text-foreground flex-1">{stopName}</div>
                {onClose && (
                    <button onClick={onClose} className="shrink-0 p-1 text-muted-foreground hover:text-foreground hover:bg-secondary rounded" title="Schließen">
                        <X className="w-4 h-4" />
                    </button>
                )}
            </div>
            <div className="text-xs text-muted-foreground font-mono">{stopId}</div>
            {isAssigned && ifopt && (
                <div className="text-xs text-muted-foreground mt-0.5">
                    Zugeordnet zu <span className="font-mono">{ifopt}</span>
                </div>
            )}
            {!isAssigned && (
                <div className="text-xs text-orange-500 mt-0.5">Nicht zugeordnet</div>
            )}

            <div className="mt-3 border-t border-border pt-2">
                {loading ? (
                    <div className="text-xs text-muted-foreground">Laden...</div>
                ) : (
                    <DepartureTable
                        events={events}
                        routeColors={routeColors}
                        referenceTime={referenceTime}
                    />
                )}
            </div>
        </div>
    );
}
