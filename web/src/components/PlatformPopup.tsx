import type { StationPlatform, StationStopPosition } from "../api";
import { DepartureMonitor } from "./DepartureMonitor";
import { getPlatformDisplayName } from "./map/mapUtils";

interface PlatformPopupProps {
    platform: StationPlatform | StationStopPosition;
    stationName?: string;
    routeColors: globalThis.Map<string, string>;
    routeTypes?: globalThis.Map<string, string>;
    referenceTime?: Date;
    isPinned?: boolean;
    onPin?: (osmId: string, displayName: string, stationName?: string, refIfopt?: string | null, lat?: number, lon?: number) => void;
    onUnpin?: (id: string) => void;
    onClose?: () => void;
    debugMode?: boolean;
}

export function PlatformPopup({ platform, stationName, routeColors, routeTypes, referenceTime, isPinned, onPin, onUnpin, onClose, debugMode }: PlatformPopupProps) {
    const displayName = getPlatformDisplayName(platform);

    return (
        <DepartureMonitor
            osmId={platform.osm_id}
            title={`Steig ${displayName}`}
            stationName={stationName}
            refIfopt={platform.ref_ifopt}
            routeColors={routeColors}
            routeTypes={routeTypes}
            referenceTime={referenceTime}
            isPinned={isPinned}
            onPin={onPin ? () => onPin(String(platform.osm_id), `Steig ${displayName}`, stationName, platform.ref_ifopt, platform.lat, platform.lon) : undefined}
            onUnpin={onUnpin ? () => onUnpin(String(platform.osm_id)) : undefined}
            onClose={onClose}
            debugMode={debugMode}
        />
    );
}
