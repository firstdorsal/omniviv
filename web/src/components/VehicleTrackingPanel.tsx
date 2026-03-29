import { AlertTriangle, ArrowRight, Pin, PinOff, Video, VideoOff } from "lucide-react";
import { useMemo } from "react";
import type { VehicleStop } from "../api";
import type { RouteVehicles } from "../hooks/useVehicleUpdates";
import { LineBadge } from "./LineBadge";
import { VehicleStopList } from "./VehicleStopList";
import type { TrackedVehicle } from "./vehicles/TrackedVehicle";
import { findVehicleInRoutes } from "./vehicles/TrackedVehicle";
import { Button } from "./ui/button";

interface VehicleTrackingPanelProps {
    vehicle: TrackedVehicle;
    vehicles: RouteVehicles[];
    routeColors: globalThis.Map<string, string>;
    routeTypes: globalThis.Map<string, string>;
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

    const stops: VehicleStop[] = liveData?.vehicle.stops ?? vehicle.lastKnownStops;
    const destination = liveData?.vehicle.destination ?? vehicle.destination;
    const origin = liveData?.vehicle.origin ?? vehicle.origin;
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

    const color = routeColors.get(vehicle.lineNumber) ?? vehicle.color;
    const mode = routeTypes.get(vehicle.lineNumber);

    return (
        <div className="flex h-full flex-col">
            {/* Header */}
            <div className="border-b px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                        <LineBadge
                            line={vehicle.lineNumber}
                            color={color}
                            mode={mode}
                        />
                        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="font-medium truncate">{destination}</span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
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
                    <div className="text-xs text-muted-foreground truncate">
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
