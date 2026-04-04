import { AlertTriangle, ArrowRight, Pin, PinOff, Video, VideoOff } from "lucide-react";
import { useMemo } from "react";
import type { VehicleStop } from "../api";
import type { RouteVehicles } from "../hooks/useVehicleUpdates";
import { DebugLogButton } from "./DebugLogButton";
import { LineBadge } from "./LineBadge";
import { VehicleStopList } from "./VehicleStopList";
import type { TrackedVehicle } from "./vehicles/TrackedVehicle";
import { findVehicleInRoutes } from "./vehicles/TrackedVehicle";
import { Button } from "./ui/button";

/** Convert GTFS route_type integer to LineBadge mode string */
function gtfsRouteTypeToMode(type: number | null | undefined): string | undefined {
    if (type === null || type === undefined) return undefined;
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

interface VehicleTrackingPanelProps {
    vehicle: TrackedVehicle;
    vehicles: RouteVehicles[];
    routeColors: globalThis.Map<string, string>;
    routeTypes: globalThis.Map<string, string>;
    /** Map of routeId → route_type from visible routes (authoritative for this vehicle's route) */
    routeIdTypes: globalThis.Map<number, string>;
    currentTime: Date;
    cameraFollowing: boolean;
    onPin: (entityId: string) => void;
    onUnpin: (entityId: string) => void;
    onToggleCameraFollow: (tripId: string) => void;
}

export function VehicleTrackingPanel({
    vehicle,
    vehicles,
    routeColors,
    routeTypes,
    routeIdTypes,
    currentTime,
    cameraFollowing,
    onPin,
    onUnpin,
    onToggleCameraFollow,
}: VehicleTrackingPanelProps) {
    // Look up live vehicle data from the current vehicles state
    const liveData = useMemo(
        () => findVehicleInRoutes(vehicle.currentTripId, vehicles),
        [vehicle.currentTripId, vehicles],
    );

    // Merge live stop data onto the most complete stop list.
    // The backend may return fewer stops than before (departure store is geographically
    // scoped), so we always keep the longest list and update realtime fields from live data.
    const stops = useMemo(() => {
        const liveStops = liveData?.vehicle.stops;
        const cachedStops = vehicle.lastKnownStops;
        // Use whichever list has more stops as the base
        const base = (liveStops && liveStops.length >= cachedStops.length)
            ? liveStops
            : cachedStops;
        // If live data has fewer stops, merge its realtime fields onto the base
        if (liveStops && liveStops.length < base.length) {
            const liveByIfopt = new Map(liveStops.map(s => [s.stop_ifopt, s]));
            return base.map(stop => {
                const live = liveByIfopt.get(stop.stop_ifopt);
                if (!live) return stop;
                return {
                    ...stop,
                    arrival_time_estimated: live.arrival_time_estimated ?? stop.arrival_time_estimated,
                    departure_time_estimated: live.departure_time_estimated ?? stop.departure_time_estimated,
                    delay_minutes: live.delay_minutes ?? stop.delay_minutes,
                };
            });
        }
        // Sort by earliest time to handle reverse-direction trips correctly
        return [...base].sort((a, b) => {
            const timeA = a.departure_time ?? a.departure_time_estimated ?? a.arrival_time ?? a.arrival_time_estimated;
            const timeB = b.departure_time ?? b.departure_time_estimated ?? b.arrival_time ?? b.arrival_time_estimated;
            if (!timeA || !timeB) return a.sequence - b.sequence;
            return new Date(timeA).getTime() - new Date(timeB).getTime();
        });
    }, [liveData?.vehicle.stops, vehicle.lastKnownStops]);
    const destination = liveData?.vehicle.destination ?? vehicle.destination;
    // Derive origin from the first stop's name — the API origin field is unreliable
    // because SIRI arrival events store the trip destination, not the actual origin
    const origin = stops[0]?.stop_name ?? null;
    const isLost = vehicle.status === "lost" && !liveData;
    const isActive = !isLost;

    // Compute current delay from the nearest upcoming stop
    const currentDelay = useMemo(() => {
        if (!stops.length) return null;
        const now = currentTime.getTime();
        for (const stop of stops) {
            const timeStr = stop.arrival_time_estimated ?? stop.departure_time_estimated;
            if (timeStr && new Date(timeStr).getTime() > now) {
                return stop.delay_minutes ?? null;
            }
        }
        return stops[stops.length - 1]?.delay_minutes ?? null;
    }, [stops, currentTime]);

    // Mode detection priority:
    // 1. GTFS route_type from vehicle API data (most accurate, requires backend rebuild)
    // 2. Route type from visible routes data (keyed by this vehicle's routeId — authoritative)
    // 3. Bare-ref routeTypes map (unreliable: bus routes from other cities may win first-match)
    const liveVehicle = liveData?.vehicle;
    const gtfsMode = gtfsRouteTypeToMode(liveVehicle?.gtfs_route_type);
    const routeIdMode = routeIdTypes.get(vehicle.routeId) ?? undefined;
    const mode = gtfsMode ?? routeIdMode ?? routeTypes.get(vehicle.lineNumber);
    const color = liveVehicle?.color
        ?? routeColors.get(`${mode}:${vehicle.lineNumber}`)
        ?? routeColors.get(vehicle.lineNumber)
        ?? vehicle.color;
    const operator = liveVehicle?.operator ?? null;

    return (
        <div className="flex h-full flex-col" data-testid="vehicle-tracking-panel">
            {/* Header */}
            <div className="border-b px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                        <LineBadge
                            line={vehicle.lineNumber}
                            color={color}
                            mode={mode}
                            operator={operator}
                        />
                        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="font-medium truncate" data-testid="vehicle-destination">{destination}</span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                        <DebugLogButton label="TrackedVehicle" data={{ vehicle, liveData, stops }} />
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => onToggleCameraFollow(vehicle.currentTripId)}
                            disabled={isLost}
                            title={cameraFollowing ? "Kamera lösen" : "Kamera folgen"}
                        >
                            {cameraFollowing ? (
                                <Video className="h-3.5 w-3.5" />
                            ) : (
                                <VideoOff className="h-3.5 w-3.5" />
                            )}
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => vehicle.pinned ? onUnpin(vehicle.id) : onPin(vehicle.id)}
                            title={vehicle.pinned ? "Loslösen" : "Anheften"}
                        >
                            {vehicle.pinned ? (
                                <PinOff className="h-3.5 w-3.5" />
                            ) : (
                                <Pin className="h-3.5 w-3.5" />
                            )}
                        </Button>
                    </div>
                </div>

                {/* Subtitle: origin + status */}
                <div className="flex items-center justify-between mt-1">
                    <div className="text-xs text-muted-foreground truncate" data-testid="vehicle-origin">
                        {origin && <span>ab {origin}</span>}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                        {isActive && (
                            <span className="flex items-center gap-1 text-xs">
                                <span className="relative flex h-2 w-2">
                                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-50" />
                                    <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
                                </span>
                                <span className="text-muted-foreground">Aktiv</span>
                            </span>
                        )}
                        {currentDelay !== null && currentDelay !== 0 && isActive && (
                            <span className={`text-xs tabular-nums ${
                                currentDelay > 0
                                    ? "text-destructive"
                                    : "text-green-600 dark:text-green-500"
                            }`}>
                                {currentDelay > 0 ? "+" : ""}{currentDelay} min
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {/* Lost warning */}
            {isLost && (
                <div className="flex items-center gap-2 bg-destructive/10 border-b px-4 py-2">
                    <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
                    <span className="text-xs text-destructive">
                        Fahrzeug nicht mehr verfolgbar
                    </span>
                </div>
            )}

            {/* Stop list */}
            <div className="flex-1 overflow-y-auto">
                <div className="py-2">
                    <VehicleStopList
                        stops={stops}
                        currentTime={currentTime}
                        disabled={isLost}
                    />
                </div>
            </div>
        </div>
    );
}
