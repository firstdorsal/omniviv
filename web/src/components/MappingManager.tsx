import { useState, useEffect, useCallback, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, ChevronLeft, ChevronRight, Check, X, Search, Loader2, MapPin } from "lucide-react";
import {
    type MappingStatusResponse,
    type MappingEntry,
    type MappingStatusRequest,
    MappingStatus,
    MappingFilter,
    type CandidateStop,
    type GtfsStopsListResponse,
} from "../api";
import { getApiClient } from "../apiClient";

/** A line to render on the map connecting an OSM stop to a GTFS stop */
export interface MappingLine {
    osmLat: number;
    osmLon: number;
    gtfsLat: number;
    gtfsLon: number;
    isManual: boolean;
    ifopt: string;
}

/** A GTFS stop marker to show on the map */
export interface MappingGtfsStop {
    lat: number;
    lon: number;
    stopId: string;
    stopName: string | null;
    isAssigned: boolean;
    /** OSM platform name this GTFS stop is mapped to (only for assigned stops) */
    osmName: string | null;
    /** IFOPT identifier this GTFS stop is mapped to (only for assigned stops) */
    ifopt: string | null;
}

/** Combined map data from the mapping panel */
export interface MappingMapData {
    lines: MappingLine[];
    gtfsStops: MappingGtfsStop[];
}

type FilterTab = "all" | "unmapped" | "manual" | "auto";

const VALID_FILTERS = new Set(["all", "unmapped", "manual", "auto"]);

interface MappingManagerProps {
    onMapDataChange: (data: MappingMapData) => void;
    onFlyTo?: (lat: number, lon: number) => void;
    initialFilter?: string;
    onFilterChange?: (filter: string) => void;
}

/** Build mapping lines from entries that have GTFS coordinates */
function buildMappingLines(entries: MappingEntry[]): MappingLine[] {
    return entries
        .filter((e): e is MappingEntry & { gtfs_stop_id: string } =>
            e.gtfs_stop_id != null &&
            e.gtfs_stop_lat != null &&
            e.gtfs_stop_lon != null &&
            e.status !== MappingStatus.Unmapped
        )
        .map((entry) => ({
            osmLat: entry.lat,
            osmLon: entry.lon,
            gtfsLat: entry.gtfs_stop_lat!,
            gtfsLon: entry.gtfs_stop_lon!,
            isManual: entry.status === MappingStatus.Manual,
            ifopt: entry.ifopt,
        }));
}

/** Build GTFS stop markers from entries' candidates */
function buildGtfsStops(entries: MappingEntry[]): MappingGtfsStop[] {
    const seen = new Set<string>();
    const stops: MappingGtfsStop[] = [];

    // Build lookups: GTFS stop ID → OSM info (from assigned mappings)
    const gtfsToOsmName = new Map<string, string>();
    const gtfsToIfopt = new Map<string, string>();
    const assignedIds = new Set<string>();
    for (const entry of entries) {
        if (entry.gtfs_stop_id) {
            assignedIds.add(entry.gtfs_stop_id);
            gtfsToOsmName.set(entry.gtfs_stop_id, entry.name ?? entry.ifopt);
            gtfsToIfopt.set(entry.gtfs_stop_id, entry.ifopt);
        }
    }

    for (const entry of entries) {
        // Add mapped GTFS stop
        if (entry.gtfs_stop_id && entry.gtfs_stop_lat != null && entry.gtfs_stop_lon != null && !seen.has(entry.gtfs_stop_id)) {
            seen.add(entry.gtfs_stop_id);
            stops.push({
                lat: entry.gtfs_stop_lat,
                lon: entry.gtfs_stop_lon,
                stopId: entry.gtfs_stop_id,
                stopName: entry.gtfs_stop_name ?? null,
                isAssigned: true,
                osmName: entry.name ?? entry.ifopt,
                ifopt: entry.ifopt,
            });
        }

        // Add candidate GTFS stops
        for (const c of entry.candidates) {
            if (!seen.has(c.stop_id)) {
                seen.add(c.stop_id);
                const isAssigned = assignedIds.has(c.stop_id);
                stops.push({
                    lat: c.lat,
                    lon: c.lon,
                    stopId: c.stop_id,
                    stopName: c.stop_name ?? null,
                    isAssigned,
                    osmName: isAssigned ? (gtfsToOsmName.get(c.stop_id) ?? null) : null,
                    ifopt: isAssigned ? (gtfsToIfopt.get(c.stop_id) ?? null) : null,
                });
            }
        }
    }

    return stops;
}

export function MappingManager({ onMapDataChange, onFlyTo, initialFilter, onFilterChange }: MappingManagerProps) {
    const [data, setData] = useState<MappingStatusResponse | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [activeFilter, setActiveFilter] = useState<FilterTab>(
        initialFilter && VALID_FILTERS.has(initialFilter) ? initialFilter as FilterTab : "all"
    );
    const [searchTerm, setSearchTerm] = useState("");
    const [debouncedSearch, setDebouncedSearch] = useState("");
    const [page, setPage] = useState(0);
    const pageSize = 30;

    // Keep the "all mappings" data stable across page changes
    const allLinesRef = useRef<MappingLine[]>([]);
    const allGtfsStopsRef = useRef<MappingGtfsStop[]>([]);

    // Debounce search input
    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(searchTerm), 300);
        return () => clearTimeout(timer);
    }, [searchTerm]);

    // Reset page when filter or search changes
    useEffect(() => {
        setPage(0);
    }, [activeFilter, debouncedSearch]);

    const fetchAllMappingData = useCallback(async () => {
        try {
            const response = await getApiClient().api.mappingStatus({
                include_candidates: true,
                limit: 200,
                offset: 0,
            });
            const lines = buildMappingLines(response.data.entries);
            const gtfsStops = buildGtfsStops(response.data.entries);
            allLinesRef.current = lines;
            allGtfsStopsRef.current = gtfsStops;
            onMapDataChange({ lines, gtfsStops });
        } catch {
            // Ignore - map data is optional
        }
    }, [onMapDataChange]);

    const fetchData = useCallback(async () => {
        setIsLoading(true);
        try {
            const req: MappingStatusRequest = {
                unmapped_only: activeFilter === "unmapped",
                include_candidates: true,
                limit: pageSize,
                offset: page * pageSize,
            };

            if (activeFilter === "manual") {
                req.filter = MappingFilter.Manual;
                req.unmapped_only = false;
            } else if (activeFilter === "auto") {
                req.filter = MappingFilter.Auto;
                req.unmapped_only = false;
            }

            if (debouncedSearch) {
                req.search = debouncedSearch;
            }

            const response = await getApiClient().api.mappingStatus(req);
            setData(response.data);

            // Build GTFS stops from current page entries
            const pageGtfsStops = buildGtfsStops(response.data.entries);

            // Build page-level lines (for current view)
            const pageLines = buildMappingLines(response.data.entries);

            // Merge lines: all + any page-level ones not already in all
            const allLineIfopts = new Set(allLinesRef.current.map(l => l.ifopt));
            const mergedLines = [
                ...allLinesRef.current,
                ...pageLines.filter(l => !allLineIfopts.has(l.ifopt)),
            ];

            // Merge GTFS stops: all + page-level (page overrides with richer data like osmName)
            const pageStopIds = new Set(pageGtfsStops.map(s => s.stopId));
            const mergedGtfsStops = [
                ...pageGtfsStops,
                ...allGtfsStopsRef.current.filter(s => !pageStopIds.has(s.stopId)),
            ];

            onMapDataChange({ lines: mergedLines, gtfsStops: mergedGtfsStops });
        } catch (error) {
            console.error("Failed to fetch mapping status:", error);
        } finally {
            setIsLoading(false);
        }
    }, [activeFilter, debouncedSearch, page, onMapDataChange]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    // Fetch all mapping lines on mount for the full map visualization
    useEffect(() => {
        fetchAllMappingData();
        // Only on mount
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleSetMapping = async (ifopt: string, gtfsStopId: string) => {
        try {
            await getApiClient().api.setMapping({ ifopt, gtfs_stop_id: gtfsStopId });
            await Promise.all([fetchData(), fetchAllMappingData()]);
        } catch (error) {
            console.error("Failed to set mapping:", error);
        }
    };

    const handleRemoveMapping = async (ifopt: string) => {
        try {
            await getApiClient().api.removeMapping({ ifopt });
            await Promise.all([fetchData(), fetchAllMappingData()]);
        } catch (error) {
            console.error("Failed to remove mapping:", error);
        }
    };

    if (isLoading && !data) {
        return (
            <div className="h-full flex items-center justify-center">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                <p className="text-muted-foreground text-sm">Zuordnungen werden geladen...</p>
            </div>
        );
    }

    if (!data) return null;

    const mappedPercent = data.total_ifopt_count > 0
        ? Math.round((data.mapped_count / data.total_ifopt_count) * 100)
        : 0;

    return (
        <div className="h-full flex flex-col">
            {/* Fixed header area */}
            <div className="shrink-0 px-3 pt-3 space-y-2">
                {/* Stats */}
                <div className="p-2.5 bg-muted/50 rounded-lg space-y-1.5">
                    <div className="flex justify-between text-xs">
                        <span>{data.mapped_count} / {data.total_ifopt_count} zugeordnet</span>
                        <span className="text-muted-foreground">
                            {data.manual_count} manuell, {data.auto_count} automatisch
                        </span>
                    </div>
                    <Progress value={mappedPercent} className="h-2" />
                    <p className="text-xs text-muted-foreground">
                        {data.unmapped_count} nicht zugeordnet
                    </p>
                </div>

                {/* Filter tabs */}
                <div className="flex gap-1">
                    {(["all", "unmapped", "manual", "auto"] as FilterTab[]).map((tab) => (
                        <Button
                            key={tab}
                            variant={activeFilter === tab ? "default" : "outline"}
                            size="sm"
                            className="text-xs flex-1"
                            onClick={() => { setActiveFilter(tab); onFilterChange?.(tab); }}
                        >
                            {tab === "all" && `Alle (${data.total_ifopt_count})`}
                            {tab === "unmapped" && `Offen (${data.unmapped_count})`}
                            {tab === "manual" && `Manuell (${data.manual_count})`}
                            {tab === "auto" && `Automatisch (${data.auto_count})`}
                        </Button>
                    ))}
                </div>

                {/* Search */}
                <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="Nach Name oder IFOPT suchen..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="pl-9 h-9 text-sm"
                    />
                </div>
            </div>

            {/* Scrollable entries list */}
            <div className="flex-1 overflow-y-auto px-3 py-2 min-h-0">
                {isLoading ? (
                    <div className="flex items-center justify-center py-4">
                        <Loader2 className="h-4 w-4 animate-spin" />
                    </div>
                ) : (
                    <ul className="divide-y">
                        {data.entries.map((entry, index) => (
                            <MappingEntryCard
                                key={`${entry.ifopt}-${index}`}
                                entry={entry}
                                onSetMapping={handleSetMapping}
                                onRemoveMapping={handleRemoveMapping}
                                onFlyTo={onFlyTo}
                            />
                        ))}
                        {data.entries.length === 0 && (
                            <p className="py-8 text-center text-muted-foreground text-sm">
                                Keine Einträge für den aktuellen Filter
                            </p>
                        )}
                    </ul>
                )}
            </div>

            {/* Fixed pagination footer */}
            {(data.has_more || page > 0) && (
                <div className="shrink-0 flex items-center justify-between px-3 py-2 border-t">
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={page === 0}
                        onClick={() => setPage((p) => p - 1)}
                    >
                        <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-xs text-muted-foreground">
                        Seite {page + 1}
                    </span>
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={!data.has_more}
                        onClick={() => setPage((p) => p + 1)}
                    >
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                </div>
            )}
        </div>
    );
}

function FlyToButton({ lat, lon, onFlyTo, title }: {
    lat: number;
    lon: number;
    onFlyTo?: (lat: number, lon: number) => void;
    title: string;
}) {
    if (!onFlyTo) return null;
    return (
        <button
            onClick={() => onFlyTo(lat, lon)}
            title={title}
            className="shrink-0 p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        >
            <MapPin className="h-3.5 w-3.5" />
        </button>
    );
}

function MappingEntryCard({
    entry,
    onSetMapping,
    onRemoveMapping,
    onFlyTo,
}: {
    entry: MappingEntry;
    onSetMapping: (ifopt: string, gtfsStopId: string) => void;
    onRemoveMapping: (ifopt: string) => void;
    onFlyTo?: (lat: number, lon: number) => void;
}) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [gtfsSearch, setGtfsSearch] = useState("");
    const [gtfsResults, setGtfsResults] = useState<CandidateStop[]>([]);
    const [isSearching, setIsSearching] = useState(false);

    const statusBadge = () => {
        switch (entry.status) {
            case MappingStatus.Unmapped:
                return <Badge variant="destructive">Offen</Badge>;
            case MappingStatus.Auto:
                return (
                    <Badge variant="secondary">
                        Automatisch {entry.combined_score != null ? `${Math.round(entry.combined_score * 100)}%` : ""}
                    </Badge>
                );
            case MappingStatus.Manual:
                return <Badge>Manuell</Badge>;
        }
    };

    const handleGtfsSearch = async () => {
        if (!gtfsSearch.trim()) return;
        setIsSearching(true);
        try {
            const result = await getApiClient().api.listGtfsStops({
                search: gtfsSearch,
                limit: 10,
                leaf_only: true,
            });
            if (result.data) {
                setGtfsResults(
                    result.data.stops.map((s) => ({
                        stop_id: s.stop_id,
                        stop_name: s.stop_name,
                        lat: s.lat,
                        lon: s.lon,
                        distance_meters: haversineDistance(entry.lat, entry.lon, s.lat, s.lon),
                    }))
                );
            }
        } catch (error) {
            console.error("GTFS search failed:", error);
        } finally {
            setIsSearching(false);
        }
    };

    const allCandidates = [
        ...entry.candidates,
        ...gtfsResults.filter(
            (r) => !entry.candidates.some((c) => c.stop_id === r.stop_id)
        ),
    ];

    return (
        <li className="p-3 hover:bg-muted/50 rounded-lg">
            <div className="flex items-center justify-between gap-2 mb-1">
                <div className="flex items-center gap-2 min-w-0">
                    {statusBadge()}
                </div>
                <FlyToButton lat={entry.lat} lon={entry.lon} onFlyTo={onFlyTo} title="Zum OSM-Halt springen" />
            </div>
            <p className="text-sm font-medium truncate">
                {entry.name || entry.ifopt}
            </p>
            <p className="text-xs text-muted-foreground font-mono mt-0.5">
                {entry.ifopt}
            </p>

            {/* Current mapping info */}
            {entry.gtfs_stop_id && (
                <div className="mt-2 p-2 bg-muted/50 rounded border text-xs">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 min-w-0">
                            {entry.gtfs_stop_lat != null && entry.gtfs_stop_lon != null && (
                                <FlyToButton
                                    lat={entry.gtfs_stop_lat}
                                    lon={entry.gtfs_stop_lon}
                                    onFlyTo={onFlyTo}
                                    title="Zum GTFS-Halt springen"
                                />
                            )}
                            <div className="min-w-0">
                                <p className="font-medium truncate">
                                    {entry.gtfs_stop_name || entry.gtfs_stop_id}
                                </p>
                                <p className="text-muted-foreground font-mono">
                                    {entry.gtfs_stop_id}
                                </p>
                            </div>
                        </div>
                        {entry.status === MappingStatus.Manual && (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="shrink-0 text-destructive hover:text-destructive"
                                onClick={() => onRemoveMapping(entry.ifopt)}
                            >
                                <X className="h-3 w-3 mr-1" />
                                Entfernen
                            </Button>
                        )}
                    </div>
                </div>
            )}

            {/* Expandable candidates section */}
            <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
                <CollapsibleTrigger asChild>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="mt-2 w-full justify-between text-xs"
                    >
                        <span>
                            {entry.candidates.length > 0
                                ? `${entry.candidates.length} GTFS-Halt${entry.candidates.length !== 1 ? "e" : ""} in der Nähe`
                                : "Nach GTFS-Halten suchen"}
                        </span>
                        <ChevronDown
                            className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                        />
                    </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                    {/* GTFS search */}
                    <div className="mt-2 flex gap-1.5">
                        <Input
                            placeholder="GTFS-Halte suchen..."
                            value={gtfsSearch}
                            onChange={(e) => setGtfsSearch(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleGtfsSearch()}
                            className="h-8 text-xs"
                        />
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={handleGtfsSearch}
                            disabled={isSearching}
                            className="shrink-0"
                        >
                            {isSearching ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                                <Search className="h-3 w-3" />
                            )}
                        </Button>
                    </div>

                    {/* Candidates table */}
                    {allCandidates.length > 0 ? (
                        <div className="mt-2 rounded border overflow-hidden">
                            <table className="w-full text-xs">
                                <thead className="bg-muted">
                                    <tr>
                                        <th className="text-left p-1.5 font-medium">GTFS-Halt</th>
                                        <th className="text-right p-1.5 font-medium w-14">Entf.</th>
                                        <th className="p-1.5 w-16"></th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y">
                                    {allCandidates.map((candidate) => (
                                        <tr
                                            key={candidate.stop_id}
                                            className={
                                                candidate.stop_id === entry.gtfs_stop_id
                                                    ? "bg-green-50 dark:bg-green-950/30"
                                                    : ""
                                            }
                                        >
                                            <td className="p-1.5">
                                                <div className="flex items-center gap-1">
                                                    <FlyToButton
                                                        lat={candidate.lat}
                                                        lon={candidate.lon}
                                                        onFlyTo={onFlyTo}
                                                        title="Zum GTFS-Halt springen"
                                                    />
                                                    <div className="min-w-0">
                                                        <div className="font-medium truncate max-w-[120px]">
                                                            {candidate.stop_name || candidate.stop_id}
                                                        </div>
                                                        <div className="text-muted-foreground font-mono text-[10px]">
                                                            {candidate.stop_id}
                                                        </div>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="p-1.5 text-right font-mono">
                                                {Math.round(candidate.distance_meters)}m
                                            </td>
                                            <td className="p-1.5 text-right">
                                                {candidate.stop_id === entry.gtfs_stop_id ? (
                                                    <Check className="h-3.5 w-3.5 text-green-600 inline" />
                                                ) : (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        className="h-6 text-xs px-2"
                                                        onClick={() =>
                                                            onSetMapping(entry.ifopt, candidate.stop_id)
                                                        }
                                                    >
                                                        Zuordnen
                                                    </Button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <p className="text-xs text-muted-foreground py-2 text-center">
                            Keine GTFS-Halte in der Nähe gefunden. Versuche die Suche oben.
                        </p>
                    )}
                </CollapsibleContent>
            </Collapsible>
        </li>
    );
}

/** Simple haversine distance between two points in meters */
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}
