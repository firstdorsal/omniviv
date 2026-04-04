import { X } from "lucide-react";
import type { Station, StationPlatform, StationStopPosition } from "../api";
import { DebugLogButtonDirect } from "./DebugLogButton";
import { getPlatformDisplayName } from "./map/mapUtils";

interface StationPopupProps {
    station: Station;
    onPlatformClick: (platform: StationPlatform | StationStopPosition) => void;
    onClose?: () => void;
    debugMode?: boolean;
}

export function StationPopup({ station, onPlatformClick, onClose, debugMode = false }: StationPopupProps) {
    // Get unique platforms by display name, with semicolon splitting.
    // Platforms take priority over stop_positions (same as the steige tile layer).
    // Stop positions with compound refs like "A;B" are split into individual entries.
    const uniquePlatforms: { platform: StationPlatform | StationStopPosition; displayName: string }[] = [];
    const seenNames = new Set<string>();

    const addEntry = (p: StationPlatform | StationStopPosition) => {
        const raw = getPlatformDisplayName(p);
        // Split semicolons: "A;B" → ["A", "B"]
        const parts = raw.split(";").map(s => s.trim()).filter(Boolean);
        for (const part of parts) {
            if (!seenNames.has(part)) {
                seenNames.add(part);
                uniquePlatforms.push({ platform: p, displayName: part });
            }
        }
    };

    // Platforms first (higher priority)
    for (const p of station.platforms) addEntry(p);
    // Stop positions as fallback
    for (const sp of station.stop_positions) addEntry(sp);

    return (
        <div className="p-4 bg-popover text-popover-foreground rounded-lg">
            <div className="flex items-start gap-2">
                <div className="font-semibold flex-1">{station.name || "Unbekannte Haltestelle"}</div>
                <DebugLogButtonDirect label="Station" data={station} enabled={debugMode} />
                {onClose && (
                    <button onClick={onClose} className="shrink-0 p-1 text-muted-foreground hover:text-foreground hover:bg-secondary rounded" title="Schließen">
                        <X className="w-4 h-4" />
                    </button>
                )}
            </div>
            {uniquePlatforms.length > 0 && (
                <div className="mt-3 border-t border-border pt-2">
                    <div className="text-xs text-muted-foreground mb-1">Steige ({uniquePlatforms.length})</div>
                    <div className="flex flex-wrap gap-2">
                        {uniquePlatforms.map(({ platform, displayName }, idx) => (
                            <button
                                key={idx}
                                onClick={() => onPlatformClick(platform)}
                                className="px-2 py-1 text-sm font-medium bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded transition-colors"
                            >
                                {displayName}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
