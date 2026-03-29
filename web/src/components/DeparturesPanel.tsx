import { DepartureMonitor } from "./DepartureMonitor";

export interface PinnedStop {
    /** Unique identifier — currently the stop's OSM ID */
    id: string;
    /** OSM ID used to query departures */
    osmId: number;
    /** Short display name shown in the sidebar tab (e.g. "Steig A1") */
    displayName: string;
    /** Parent station name (e.g. "Königsplatz") */
    stationName?: string;
    /** IFOPT identifier */
    refIfopt?: string | null;
    /** Platform coordinates for map navigation */
    lat?: number;
    lon?: number;
}

interface DeparturesPanelProps {
    stop: PinnedStop;
    routeColors: globalThis.Map<string, string>;
    routeTypes: globalThis.Map<string, string>;
    referenceTime?: Date;
    onUnpin: (id: string) => void;
    onLocate?: (lat: number, lon: number) => void;
}

export function DeparturesPanel({ stop, routeColors, routeTypes, referenceTime, onUnpin, onLocate }: DeparturesPanelProps) {
    return (
        <DepartureMonitor
            osmId={stop.osmId}
            title={stop.displayName}
            stationName={stop.stationName}
            refIfopt={stop.refIfopt}
            routeColors={routeColors}
            routeTypes={routeTypes}
            referenceTime={referenceTime}
            isPinned={true}
            onUnpin={() => onUnpin(stop.id)}
            onLocate={stop.lat != null && stop.lon != null && onLocate ? () => onLocate(stop.lat!, stop.lon!) : undefined}
        />
    );
}
