import { Pin, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Departure, type StationPlatform, type StationStopPosition } from "../api";
import { getApiClient } from "../apiClient";
import { DepartureTable } from "./DepartureTable";
import { getPlatformDisplayName } from "./map/mapUtils";

interface PlatformPopupProps {
    platform: StationPlatform | StationStopPosition;
    stationName?: string;
    routeColors: globalThis.Map<string, string>;
    routeTypes?: globalThis.Map<string, string>;
    /** When set, requests schedule-based departures for this simulated time */
    referenceTime?: Date;
    /** Callback to pin this platform to the sidebar departures panel */
    onPin?: (stopIfopt: string, displayName: string, stationName?: string) => void;
    /** Callback to close the popup */
    onClose?: () => void;
}

export function PlatformPopup({ platform, stationName, routeColors, routeTypes, referenceTime, onPin, onClose }: PlatformPopupProps) {
    const [events, setEvents] = useState<Departure[]>([]);
    const [gtfsStopId, setGtfsStopId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const displayName = getPlatformDisplayName(platform);
    const abortRef = useRef<AbortController | null>(null);

    const fetchDepartures = useCallback(() => {
        if (!platform.ref_ifopt) return;
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        return getApiClient().api
            .getDeparturesByStop({
                stop_ifopt: platform.ref_ifopt,
                reference_time: referenceTime ? referenceTime.toISOString() : undefined,
            })
            .then((res) => {
                if (!controller.signal.aborted) {
                    setEvents(res.data?.departures ?? []);
                    setGtfsStopId(res.data?.mapped_gtfs_stop_id ?? null);
                }
            })
            .catch((err) => {
                if (!controller.signal.aborted) {
                    console.error("Failed to fetch departures:", err);
                    setEvents([]);
                }
            });
    }, [platform.ref_ifopt, referenceTime]);

    // Initial fetch + refetch on dependency change
    useEffect(() => {
        if (!platform.ref_ifopt) {
            setLoading(false);
            return;
        }
        setLoading(true);
        fetchDepartures()?.finally(() => setLoading(false));
        return () => abortRef.current?.abort();
    }, [fetchDepartures, platform.ref_ifopt]);

    // Auto-refresh every 30 seconds
    useEffect(() => {
        const interval = setInterval(fetchDepartures, 30000);
        return () => clearInterval(interval);
    }, [fetchDepartures]);

    return (
        <div className="p-4 bg-popover text-popover-foreground rounded-lg">
            <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                    <div className="font-semibold">Steig {displayName}</div>
                    {stationName && <div className="text-sm text-muted-foreground">{stationName}</div>}
                    {platform.ref_ifopt && <div className="text-xs text-muted-foreground font-mono">{platform.ref_ifopt}</div>}
                    {gtfsStopId && <div className="text-xs text-muted-foreground font-mono">GTFS: {gtfsStopId}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                    {onPin && platform.ref_ifopt && (
                        <button
                            onClick={() => onPin(platform.ref_ifopt!, `Steig ${displayName}`, stationName)}
                            className="p-1 text-muted-foreground hover:text-foreground hover:bg-secondary rounded"
                            title="An Seitenleiste anheften"
                        >
                            <Pin className="w-4 h-4" />
                        </button>
                    )}
                    {onClose && (
                        <button
                            onClick={onClose}
                            className="p-1 text-muted-foreground hover:text-foreground hover:bg-secondary rounded"
                            title="Schließen"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    )}
                </div>
            </div>

            <div className="mt-3 border-t border-border pt-2">
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
