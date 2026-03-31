import { useCallback, useEffect, useRef, useState } from "react";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { TbWalk } from "react-icons/tb";
import { Button } from "./ui/button";
import { DateTimePicker } from "./ui/date-time-picker";
import type { Station } from "../api";
import { getConfig } from "../config";
import { Duration } from "./Duration";
import { LineBadge } from "./LineBadge";
import { LocationSearch, type ResolvedLocation } from "./LocationSearch";
import { formatTime } from "./map/mapUtils";

type PickMode = "start" | "end" | null;

interface NavigationPanelProps {
    stations: Station[];
    routeColors: globalThis.Map<string, string>;
    routeTypes: globalThis.Map<string, string>;
    startLocation: ResolvedLocation | null;
    endLocation: ResolvedLocation | null;
    onStartChange: (location: ResolvedLocation | null) => void;
    onEndChange: (location: ResolvedLocation | null) => void;
    intermediateStops: (ResolvedLocation | null)[];
    onIntermediateStopsChange: (stops: (ResolvedLocation | null)[]) => void;
    pickMode: PickMode;
    onPickModeChange: (mode: PickMode) => void;
    onFlyTo?: (lat: number, lon: number) => void;
}

// Keep the old Location type as alias for backwards compatibility
type Location = ResolvedLocation;

export type { Location, PickMode };

interface RouteLeg {
    mode: string;
    routeShortName?: string;
    routeColor?: string;
    agencyName?: string;
    from: { name: string };
    to: { name: string };
    duration: number;
    startTime: string;
    endTime: string;
    distance?: number;
}

interface RouteItinerary {
    duration: number;
    startTime: string;
    endTime: string;
    transfers: number;
    legs: RouteLeg[];
}

export function NavigationPanel({
    stations,
    routeColors,
    routeTypes,
    startLocation,
    endLocation,
    onStartChange,
    onEndChange,
    pickMode,
    intermediateStops,
    onIntermediateStopsChange: setIntermediateStops,
    onPickModeChange,
    onFlyTo,
}: NavigationPanelProps) {
    const [isSearching, setIsSearching] = useState(false);
    const [itineraries, setItineraries] = useState<RouteItinerary[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [departureDateTime, setDepartureDateTime] = useState<Date | undefined>(() => new Date());
    const [arriveBy, setArriveBy] = useState(false);

    // Stable keys for each LocationSearch slot — survive reordering so React
    // keeps internal component state (query text, popover, etc.) with the data.
    const nextSlotId = useRef(2);
    const [slotKeys, setSlotKeys] = useState<string[]>(["slot-0", "slot-1"]);

    // Drag state — HTML5 DnD with ghost image
    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const dragStartState = useRef<{
        locations: (ResolvedLocation | null)[];
        keys: string[];
    } | null>(null);

    const handleDragStart = (index: number, e: React.DragEvent) => {
        e.dataTransfer.effectAllowed = "move";
        dragStartState.current = {
            locations: [startLocation, ...intermediateStops, endLocation],
            keys: [...slotKeys],
        };
        const row = e.currentTarget.parentElement;
        if (row) {
            const rect = row.getBoundingClientRect();
            e.dataTransfer.setDragImage(row, e.clientX - rect.left, e.clientY - rect.top);
        }
        requestAnimationFrame(() => setDragIndex(index));
    };

    const handleDragOver = (index: number, e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (dragIndex === null || dragIndex === index) return;

        const allLocs: (ResolvedLocation | null)[] = [startLocation, ...intermediateStops, endLocation];
        const [movedLoc] = allLocs.splice(dragIndex, 1);
        allLocs.splice(index, 0, movedLoc);
        const allKeys = [...slotKeys];
        const [movedKey] = allKeys.splice(dragIndex, 1);
        allKeys.splice(index, 0, movedKey);

        onStartChange(allLocs[0]);
        setIntermediateStops(allLocs.slice(1, -1));
        onEndChange(allLocs[allLocs.length - 1]);
        setSlotKeys(allKeys);
        setDragIndex(index);
    };

    const handleDrop = () => {
        dragStartState.current = null;
        setDragIndex(null);
        onPickModeChange(null);
    };

    const handleDragEnd = () => {
        if (dragStartState.current) {
            const { locations, keys } = dragStartState.current;
            onStartChange(locations[0]);
            setIntermediateStops(locations.slice(1, -1));
            onEndChange(locations[locations.length - 1]);
            setSlotKeys(keys);
            dragStartState.current = null;
        }
        setDragIndex(null);
    };

    const [focusRequest, setFocusRequest] = useState<{ key: string; seq: number } | null>(null);

    const addIntermediateStop = () => {
        const id = `slot-${nextSlotId.current++}`;
        // Move the current end into intermediates, new empty slot becomes the end
        setIntermediateStops(prev => [...prev, endLocation]);
        onEndChange(null);
        setSlotKeys(prev => [...prev, id]);
        setFocusRequest({ key: id, seq: Date.now() });
    };

    const updateIntermediateStop = (index: number, location: ResolvedLocation | null) => {
        setIntermediateStops(prev => prev.map((s, i) => i === index ? location : s));
    };

    const removeIntermediateStop = (index: number) => {
        setIntermediateStops(prev => prev.filter((_, i) => i !== index));
        setSlotKeys(prev => prev.filter((_, i) => i !== index + 1));
    };

    /** Remove any stop by its position in the full [start, ...intermediates, end] list. */
    const removeStop = (i: number) => {
        const total = 2 + intermediateStops.length;
        if (total <= 2) return;
        const isStart = i === 0;
        const isEnd = i === total - 1;
        if (isStart) {
            // Promote first intermediate to start
            onStartChange(intermediateStops[0] ?? null);
            setIntermediateStops(prev => prev.slice(1));
            setSlotKeys(prev => prev.filter((_, idx) => idx !== 0));
        } else if (isEnd) {
            // Promote last intermediate to end
            onEndChange(intermediateStops[intermediateStops.length - 1] ?? null);
            setIntermediateStops(prev => prev.slice(0, -1));
            setSlotKeys(prev => prev.filter((_, idx) => idx !== prev.length - 1));
        } else {
            removeIntermediateStop(i - 1);
        }
    };

    const handleSearch = useCallback(async () => {
        if (!startLocation || !endLocation || !departureDateTime) return;
        setIsSearching(true);
        setError(null);
        setItineraries([]);

        try {
            const params = new URLSearchParams({
                fromPlace: `${startLocation.lat},${startLocation.lon}`,
                toPlace: `${endLocation.lat},${endLocation.lon}`,
                time: departureDateTime.toISOString(),
                arriveBy: String(arriveBy),
                mode: "TRANSIT,WALK",
            });
            for (const stop of intermediateStops) {
                if (stop) params.append("intermediatePlaces", `${stop.lat},${stop.lon}`);
            }
            const url = `${getConfig().motisUrl}/api/v1/plan?${params}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            const transit = data.itineraries ?? [];
            const direct = data.direct ?? [];
            const itins = [...transit, ...direct].sort(
                (a, b) => new Date(a.endTime).getTime() - new Date(b.endTime).getTime(),
            );
            setItineraries(itins);
            if (itins.length === 0) {
                setError("Keine Verbindungen gefunden");
            }
        } catch (err) {
            setError("Routensuche fehlgeschlagen");
            console.error("MOTIS routing error:", err);
        } finally {
            setIsSearching(false);
        }
    }, [startLocation, endLocation, intermediateStops, departureDateTime, arriveBy]);

    // Auto-search when the component mounts with valid locations (e.g. tab switch,
    // page reload with URL params) or when locations/parameters change.
    const prevSearchKey = useRef<string | null>(null);
    const hasMounted = useRef(false);
    useEffect(() => {
        if (!startLocation || !endLocation) return;
        // Build a stable key from all search-relevant inputs to avoid duplicate requests
        const viaKey = intermediateStops
            .filter((s): s is ResolvedLocation => s !== null)
            .map(s => `${s.lat},${s.lon}`)
            .join(";");
        const key = `${startLocation.lat},${startLocation.lon}|${endLocation.lat},${endLocation.lon}|${viaKey}|${departureDateTime?.toISOString() ?? ""}|${arriveBy}`;
        if (key === prevSearchKey.current) return;
        prevSearchKey.current = key;

        // Fire immediately on first mount (reload / tab switch), debounce subsequent changes
        if (!hasMounted.current) {
            hasMounted.current = true;
            handleSearch();
            return;
        }
        const timer = setTimeout(() => {
            handleSearch();
        }, 300);
        return () => clearTimeout(timer);
    }, [startLocation, endLocation, intermediateStops, departureDateTime, arriveBy, handleSearch]);

    return (
        <div className="p-4">
            <h2 className="font-semibold mb-4">Routenplanung</h2>

            <div className="space-y-3">
                {/* Route stops with timeline */}
                <div>
                    {Array.from({ length: 2 + intermediateStops.length }, (_, i) => {
                        const total = 2 + intermediateStops.length;
                        const isStart = i === 0;
                        const isEnd = i === total - 1;
                        const intermediateIdx = i - 1;

                        const location = isStart ? startLocation : isEnd ? endLocation : intermediateStops[intermediateIdx];
                        const baseChange = isStart
                            ? onStartChange
                            : isEnd
                                ? onEndChange
                                : (loc: ResolvedLocation | null) => updateIntermediateStop(intermediateIdx, loc);
                        const handleChange = (loc: ResolvedLocation | null) => {
                            baseChange(loc);
                            // When a location is selected, focus the next empty stop
                            if (loc) {
                                const allLocs = [startLocation, ...intermediateStops, endLocation];
                                allLocs[i] = loc;
                                for (let next = i + 1; next < allLocs.length; next++) {
                                    if (!allLocs[next]) {
                                        setFocusRequest({ key: slotKeys[next], seq: Date.now() });
                                        return;
                                    }
                                }
                            }
                        };

                        return (
                            <div key={slotKeys[i]}>
                                {/* Connecting dots between circles */}
                                {i > 0 && (
                                    <div className="flex gap-2">
                                        <div className="w-5" />
                                        <div className="w-6 flex flex-col items-center py-0.5 gap-px">
                                            <div className="w-1 h-1 rounded-full bg-muted-foreground/40" />
                                            <div className="w-1 h-1 rounded-full bg-muted-foreground/40" />
                                            <div className="w-1 h-1 rounded-full bg-muted-foreground/40" />
                                        </div>
                                    </div>
                                )}
                                {/* Location row */}
                                <div
                                    className={`flex items-center gap-2 py-0.5 rounded-md ${dragIndex === i ? "opacity-0" : ""}`}
                                    onDragOver={(e) => handleDragOver(i, e)}
                                    onDrop={handleDrop}
                                >
                                    {/* Drag handle */}
                                    <div
                                        className="w-5 flex justify-center cursor-grab active:cursor-grabbing shrink-0"
                                        draggable
                                        onDragStart={(e) => handleDragStart(i, e)}
                                        onDragEnd={handleDragEnd}
                                    >
                                        <GripVertical className="h-4 w-4 text-muted-foreground" />
                                    </div>
                                    {/* Circle with letter — click to zoom on map */}
                                    <div
                                        className={`w-6 h-6 rounded-full border-2 border-foreground flex items-center justify-center shrink-0 ${location ? "cursor-pointer hover:bg-foreground hover:text-background transition-colors" : ""}`}
                                        onClick={() => { if (location && onFlyTo) onFlyTo(location.lat, location.lon); }}
                                    >
                                        <span className="text-[10px] font-bold select-none">{String.fromCharCode(65 + i)}</span>
                                    </div>
                                    {/* Input — disable pointer events during drag to prevent popover interference */}
                                    <div className={`flex-1 min-w-0 ${dragIndex !== null ? "pointer-events-none" : ""}`}>
                                        <LocationSearch
                                            stations={stations}
                                            value={location}
                                            onChange={handleChange}
                                            showGps
                                            showMapPick
                                            isPickingOnMap={isStart ? pickMode === "start" : isEnd ? pickMode === "end" : false}
                                            onPickOnMap={
                                                isStart
                                                    ? () => onPickModeChange(pickMode === "start" ? null : "start")
                                                    : isEnd
                                                        ? () => onPickModeChange(pickMode === "end" ? null : "end")
                                                        : undefined
                                            }
                                            autoFocus={focusRequest !== null && slotKeys[i] === focusRequest.key ? focusRequest.seq : undefined}
                                            excludeLocations={total === 2
                                                ? [isStart ? endLocation : startLocation].filter((l): l is ResolvedLocation => l !== null)
                                                : undefined
                                            }
                                        />
                                    </div>
                                    {/* Remove button — shown for any stop when more than 2 exist */}
                                    {total > 2 && (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                                            onClick={() => removeStop(i)}
                                            title="Halt entfernen"
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                        </Button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
                <div
                    className="flex items-center gap-2 py-0.5 cursor-pointer group"
                    onClick={addIntermediateStop}
                    title="Halt hinzufügen"
                >
                    <div className="w-5 flex justify-center shrink-0" />
                    <div className="w-6 flex justify-center shrink-0">
                        <Plus className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0 h-9 rounded-md border border-input/40 group-hover:border-input bg-transparent px-3 flex items-center">
                        <span className="text-sm text-muted-foreground/40 group-hover:text-muted-foreground">Halt hinzufügen...</span>
                    </div>
                </div>

                <div className="flex gap-2 items-center">
                    <Button
                        variant={arriveBy ? "outline" : "default"}
                        size="sm"
                        className="text-xs"
                        onClick={() => setArriveBy(false)}
                    >
                        Abfahrt
                    </Button>
                    <Button
                        variant={arriveBy ? "default" : "outline"}
                        size="sm"
                        className="text-xs"
                        onClick={() => setArriveBy(true)}
                    >
                        Ankunft
                    </Button>
                    <DateTimePicker
                        value={departureDateTime}
                        onChange={setDepartureDateTime}
                        timeFormat="24h"
                        timeLayout="beside"
                        className="flex-1"
                    />
                    <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs text-muted-foreground shrink-0"
                        onClick={() => setDepartureDateTime(new Date())}
                    >
                        Jetzt
                    </Button>
                </div>

                <Button
                    className="w-full"
                    disabled={!startLocation || !endLocation || isSearching}
                    onClick={handleSearch}
                >
                    {isSearching ? "Suche..." : "Route finden"}
                </Button>

                {error && (
                    <div className="text-sm text-destructive">{error}</div>
                )}

                {itineraries.length > 0 && (
                    <div className="space-y-3" data-testid="route-results">
                        {itineraries.map((itinerary, i) => (
                            <div key={i} className="@container border rounded-lg p-3 space-y-2" data-testid={`itinerary-${i}`}>
                                <div className="flex items-center justify-between text-sm">
                                    <span className="font-medium">
                                        {formatTime(itinerary.startTime, false)} - {formatTime(itinerary.endTime, false)}
                                    </span>
                                    <Duration seconds={itinerary.duration} className="text-foreground" />
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <div className="relative min-w-0 flex-1 overflow-hidden max-h-8">
                                        <div className="flex items-center gap-1.5 flex-nowrap">
                                            {itinerary.legs.map((leg, j) => {
                                                if (leg.mode === "WALK") {
                                                    const walkMin = Math.round(leg.duration / 60);
                                                    return (
                                                        <span key={j} className="inline-flex items-start text-muted-foreground shrink-0">
                                                            <TbWalk className="h-5 w-5" />
                                                            <span className="text-[10px] -ml-1 -mt-0.5">{walkMin}</span>
                                                        </span>
                                                    );
                                                }
                                                return (
                                                    <LineBadge
                                                        key={j}
                                                        line={leg.routeShortName || leg.mode}
                                                        color={leg.routeColor
                                                            ? (leg.routeColor.startsWith('#') ? leg.routeColor : `#${leg.routeColor}`)
                                                            : leg.routeShortName ? (
                                                                (leg.agencyName ? routeColors.get(`${leg.agencyName}:${leg.routeShortName}`) : undefined)
                                                                ?? routeColors.get(`${leg.mode?.toLowerCase()}:${leg.routeShortName}`)
                                                                ?? routeColors.get(leg.routeShortName)
                                                            ) : undefined}
                                                        mode={leg.mode || (leg.routeShortName ? routeTypes.get(leg.routeShortName) : undefined)}
                                                        className="shrink-0"
                                                    />
                                                );
                                            })}
                                        </div>
                                        <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent" />
                                    </div>
                                    {itinerary.transfers > 0 && (
                                        <span className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">
                                            {itinerary.transfers}x
                                        </span>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
