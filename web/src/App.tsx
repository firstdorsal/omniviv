import { Bug, Clock, Github, Layers, Navigation, Settings, TrainFront, Wifi, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TbWorldX } from "react-icons/tb";
import type { Station } from "./api";
import { getApiClient } from "./apiClient";
import { DeparturesPanel, type PinnedStop } from "./components/DeparturesPanel";
import { FeaturesPanel } from "./components/FeaturesPanel";
import { OsmIssuesPanel, type MappingMapData } from "./components/IssuesPanel";
import { LineBadge } from "./components/LineBadge";
import { NavigationPanel, type Location, type PickMode, type RouteItinerary } from "./components/NavigationPanel";
import { TimeControlPanel } from "./components/TimeControlPanel";
import { VehicleMonitorPanel } from "./components/VehicleMonitorPanel";
import { VehicleTrackingPanel } from "./components/VehicleTrackingPanel";
import TransitMap from "./components/map/Map";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Slider } from "./components/ui/slider";
import { Toaster } from "./components/ui/sonner";
import type { DebugOptions } from "./components/vehicles/VehicleRenderer";
import {
    createTrackedVehicle,
    findVehicleInRoutes,
    loadPersistedVehicles,
    savePersistedVehicles,
    transitionTrip,
    type TrackedVehicle,
} from "./components/vehicles/TrackedVehicle";
import { DebugModeProvider } from "./contexts/DebugModeContext";
import { useRendezvous } from "./hooks/useRendezvous";
import { useTimeSimulation } from "./hooks/useTimeSimulation";
import { useVehicleUpdates, type RouteVehicles } from "./hooks/useVehicleUpdates";
import { useVisibleRoutes } from "./hooks/useVisibleRoutes";

type SidebarPanel = "navigation" | "layers" | "features" | "debug" | "issues" | "time" | `departures:${string}` | `vehicle:${string}` | null;

const VALID_PANELS = new Set(["navigation", "layers", "features", "debug", "issues", "time"]);

function getInitialPanel(): SidebarPanel {
    const params = new URLSearchParams(window.location.search);
    const panel = params.get("panel");
    if (panel && (VALID_PANELS.has(panel) || panel.startsWith("departures:") || panel.startsWith("vehicle:"))) return panel as SidebarPanel;
    return null;
}

function updateUrlParams(updates: Record<string, string | null>) {
    const params = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(updates)) {
        if (value === null) {
            params.delete(key);
        } else {
            params.set(key, value);
        }
    }
    const search = params.toString();
    const base = search ? `${window.location.pathname}?${search}` : window.location.pathname;
    window.history.replaceState(null, "", `${base}${window.location.hash}`);
}

function getUrlParam(key: string): string | null {
    return new URLSearchParams(window.location.search).get(key);
}

/** Encode a location as pipe-separated string: lat|lon|type|iconName|name */
function encodeLocation(loc: Location): string {
    return `${loc.lat}|${loc.lon}|${loc.type}|${loc.iconName ?? ""}|${loc.name}`;
}

/** Decode a pipe-separated location string back to a Location object */
function decodeLocation(raw: string | null): Location | null {
    if (!raw) return null;
    const [latStr, lonStr, type, iconName, ...nameParts] = raw.split("|");
    const lat = parseFloat(latStr);
    const lon = parseFloat(lonStr);
    if (isNaN(lat) || isNaN(lon) || !type) return null;
    return {
        lat,
        lon,
        type: type as Location["type"],
        iconName: iconName || undefined,
        name: nameParts.join("|") || `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    };
}

// Fallback polling interval when WebSocket is not available (in milliseconds)
const FALLBACK_REFRESH_INTERVAL = 5000;

// LocalStorage key for persisted options
const STORAGE_KEY = "live-tram-options";

// Re-export for use by other components
export type { RouteVehicles } from "./hooks/useVehicleUpdates";


/** All transit route types from OSM (used for route type filtering in the Linien toggle). */
const ALL_ROUTE_TYPES = ["tram", "bus", "train", "light_rail", "subway", "ferry"] as const;

interface PersistedOptions {
    showStations: boolean;
    showSteige: boolean;
    showOutlines: boolean;
    showDebugStops: boolean;
    showDebugPlatforms: boolean;
    showRoutes: boolean;
    visibleRouteTypes: string[];
    showVehicles: boolean;
    showPois: boolean;
    debugOptions: DebugOptions;
    rendezvousEnabled: boolean;
    debugMode: boolean;
}

const DEFAULT_OPTIONS: PersistedOptions = {
    showStations: true,
    showSteige: false,
    showOutlines: false,
    showDebugStops: false,
    showDebugPlatforms: false,
    showRoutes: true,
    visibleRouteTypes: [...ALL_ROUTE_TYPES],
    showVehicles: true,
    showPois: false,
    debugOptions: {
        show3DModels: true,
        model3DMinZoom: 15,
        showDebugSegments: false,
        showDebugOnlyTracked: true
    },
    rendezvousEnabled: false,
    debugMode: false,
};

function loadOptions(): PersistedOptions {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            // Migrate old keys: showStopPositions → showDebugStops, showPlatforms → showDebugPlatforms
            if ("showStopPositions" in parsed && !("showDebugStops" in parsed)) {
                parsed.showDebugStops = parsed.showStopPositions;
            }
            if ("showPlatforms" in parsed && !("showDebugPlatforms" in parsed)) {
                parsed.showDebugPlatforms = parsed.showPlatforms;
            }
            // Merge with defaults to handle new options added in future versions
            return {
                ...DEFAULT_OPTIONS,
                ...parsed,
                debugOptions: {
                    ...DEFAULT_OPTIONS.debugOptions,
                    ...(parsed.debugOptions || {})
                }
            };
        }
    } catch (e) {
        console.error("Failed to load options from localStorage:", e);
    }
    return DEFAULT_OPTIONS;
}

function saveOptions(options: PersistedOptions): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
    } catch (e) {
        console.error("Failed to save options to localStorage:", e);
    }
}

export default function App() {
    // Stations are loaded via Martin vector tiles, not API.
    // Empty array kept for backwards compat with components that still reference it.
    const stations: Station[] = [];
    const [vehicles, setVehicles] = useState<RouteVehicles[]>([]);
    const viewportRef = useRef<{ bbox: [number, number, number, number]; zoom: number } | null>(null);
    const [vehicleRouteGeometries, setVehicleRouteGeometries] = useState(
        () => new Map<number, number[][][]>()
    );
    const [activePanel, setActivePanel] = useState<SidebarPanel>(getInitialPanel);
    const [pinnedStops, setPinnedStops] = useState<PinnedStop[]>(() => {
        try {
            const stored = localStorage.getItem("pinned-stops");
            if (stored) return JSON.parse(stored);
        } catch { /* ignore */ }
        return [];
    });
    const [trackedVehicles, setTrackedVehicles] = useState<TrackedVehicle[]>(loadPersistedVehicles);
    const [cameraFollowTripId, setCameraFollowTripId] = useState<string | null>(null);
    const [panelWidth, setPanelWidth] = useState(() => {
        try {
            const stored = localStorage.getItem("panel-width");
            if (stored) return Math.max(240, Math.min(600, Number(stored)));
        } catch { /* ignore */ }
        return 320;
    });

    // Persist pinned stops, tracked vehicles, and panel width
    useEffect(() => {
        localStorage.setItem("pinned-stops", JSON.stringify(pinnedStops));
    }, [pinnedStops]);
    useEffect(() => {
        savePersistedVehicles(trackedVehicles);
    }, [trackedVehicles]);
    useEffect(() => {
        localStorage.setItem("panel-width", String(panelWidth));
    }, [panelWidth]);
    const [osmIssuesCount, setOsmIssuesCount] = useState<number | null>(null);

    // Navigation state — restore from URL params if present
    // URL format: lat|lon|type|iconName|name (pipe-separated, name last)
    // Intermediates: semicolon-separated list of encoded locations
    const [navStart, setNavStart] = useState<Location | null>(() => decodeLocation(getUrlParam("from")));
    const [navEnd, setNavEnd] = useState<Location | null>(() => decodeLocation(getUrlParam("to")));
    const [navVia, setNavVia] = useState<(Location | null)[]>(() => {
        const raw = getUrlParam("via");
        if (!raw) return [];
        return raw.split(";").map(s => decodeLocation(s));
    });
    const [pickMode, setPickMode] = useState<PickMode>(null);
    const [selectedItinerary, setSelectedItinerary] = useState<RouteItinerary | null>(null);

    // Sync navigation locations to URL
    useEffect(() => {
        const viaNonEmpty = navVia.filter((v): v is Location => v !== null);
        updateUrlParams({
            from: navStart ? encodeLocation(navStart) : null,
            to: navEnd ? encodeLocation(navEnd) : null,
            via: viaNonEmpty.length > 0 ? viaNonEmpty.map(encodeLocation).join(";") : null,
        });
    }, [navStart, navEnd, navVia]);

    // Highlighted building state
    const [highlightedBuilding, setHighlightedBuilding] = useState<{
        lat: number;
        lon: number;
        color?: string;
    } | null>(null);

    // Mapping visualization data (from IssuesPanel mapping tab)
    const [mappingMapData, setMappingMapData] = useState<MappingMapData>({
        lines: [],
        gtfsStops: []
    });
    const mapRef = useRef<TransitMap>(null);

    // Theme state
    const [isDark, setIsDark] = useState(() => {
        const stored = localStorage.getItem("theme");
        if (stored) return stored === "dark";
        return window.matchMedia("(prefers-color-scheme: dark)").matches;
    });

    useEffect(() => {
        document.documentElement.classList.toggle("dark", isDark);
        localStorage.setItem("theme", isDark ? "dark" : "light");
    }, [isDark]);

    // Time simulation
    const timeSimulation = useTimeSimulation();

    // Load persisted options from localStorage
    const [options, setOptions] = useState<PersistedOptions>(loadOptions);

    // Save options to localStorage whenever they change
    useEffect(() => {
        saveOptions(options);
    }, [options]);

    // Destructure for easier access
    const {
        showStations,
        showSteige,
        showOutlines,
        showDebugStops,
        showDebugPlatforms,
        showRoutes,
        visibleRouteTypes,
        showVehicles,
        showPois,
        debugOptions,
        rendezvousEnabled
    } = options;

    // Königsplatz rendezvous feature
    const {
        rendezvousState,
        highlightedBuilding: rendezvousBuilding,
        shouldFlash
    } = useRendezvous({
        enabled: rendezvousEnabled,
        currentTime: timeSimulation.currentTime,
        vehicles
    });

    // Update highlighted building based on rendezvous state
    useEffect(() => {
        setHighlightedBuilding(rendezvousBuilding);
    }, [rendezvousBuilding]);

    // Memoize vehicle count to avoid recalculating on every render
    const totalVehicleCount = useMemo(
        () => vehicles.reduce((acc, rv) => acc + rv.vehicles.length, 0),
        [vehicles]
    );

    // Helper to update a single option
    const updateOption = <K extends keyof PersistedOptions>(key: K, value: PersistedOptions[K]) => {
        setOptions((prev) => ({ ...prev, [key]: value }));
    };

    // Sync panel to URL
    useEffect(() => {
        updateUrlParams({
            panel: activePanel,
            // Clear sub-tab params when panel changes away from issues
            ...(activePanel !== "issues" ? { tab: null, filter: null } : {})
        });
    }, [activePanel]);

    // Toggle sidebar panel
    const togglePanel = (panel: SidebarPanel) => {
        setActivePanel((current) => (current === panel ? null : panel));
    };

    // Pin a stop to the sidebar
    const handlePinStop = useCallback((osmId: string, displayName: string, stationName?: string, refIfopt?: string | null, lat?: number, lon?: number) => {
        setPinnedStops((prev) => {
            if (prev.some((s) => s.id === osmId)) return prev;
            return [...prev, { id: osmId, osmId: Number(osmId), displayName, stationName, refIfopt, lat, lon }];
        });
        setActivePanel(`departures:${osmId}`);
    }, []);

    const handlePanelResizeStart = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = panelWidth;
        const onMove = (ev: MouseEvent) => {
            const newWidth = Math.max(240, Math.min(600, startWidth + ev.clientX - startX));
            setPanelWidth(newWidth);
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }, [panelWidth]);

    const pinnedStopIds = useMemo(() => new Set(pinnedStops.map((s) => s.id)), [pinnedStops]);

    const handleUnpinStop = useCallback((id: string) => {
        setPinnedStops((prev) => prev.filter((s) => s.id !== id));
        setActivePanel((current) => current === `departures:${id}` ? null : current);
    }, []);

    // Navigation callbacks for map context menu and pick mode
    const handleSetNavigationStart = useCallback((lat: number, lon: number) => {
        setNavStart({
            name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
            lat,
            lon,
            type: "map",
        });
        setPickMode(null);
        setActivePanel("navigation");
    }, []);

    const handleSetNavigationEnd = useCallback((lat: number, lon: number) => {
        setNavEnd({
            name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
            lat,
            lon,
            type: "map",
        });
        setPickMode(null);
        setActivePanel("navigation");
    }, []);

    // Handler for pick mode changes from NavigationPanel
    const handlePickModeChange = useCallback((mode: PickMode) => {
        setPickMode(mode);
    }, []);

    // Fly the map to a specific location (used by mapping panel)
    const handleFlyTo = useCallback((lat: number, lon: number) => {
        mapRef.current?.flyTo(lat, lon);
    }, []);

    // Route colors and types — loaded from /api/routes/colors, cached in localStorage
    // for instant availability on reload (avoids gray flash).
    // Cache key includes version to invalidate when the resolution logic changes.
    const COLOR_CACHE_KEY = "omniviv-route-colors-v2";
    const TYPE_CACHE_KEY = "omniviv-route-types-v2";
    const [routeColorMap, setRouteColorMap] = useState(() => {
        try {
            const cached = localStorage.getItem(COLOR_CACHE_KEY);
            if (cached) {
                return new globalThis.Map<string, string>(JSON.parse(cached));
            }
        } catch { /* ignore corrupt cache */ }
        return new globalThis.Map<string, string>();
    });
    const [routeTypeMap, setRouteTypeMap] = useState(() => {
        try {
            const cached = localStorage.getItem(TYPE_CACHE_KEY);
            if (cached) {
                return new globalThis.Map<string, string>(JSON.parse(cached));
            }
        } catch { /* ignore corrupt cache */ }
        return new globalThis.Map<string, string>();
    });
    const [routeColorsLoaded, setRouteColorsLoaded] = useState(false);
    const routeColors = routeColorMap;
    const routeTypes = routeTypeMap;

    // Derive the active tracked trip ID for Map highlight
    const activeTrackedTripId = useMemo(() => {
        if (!activePanel?.startsWith("vehicle:")) return null;
        const entityId = activePanel.slice("vehicle:".length);
        const entity = trackedVehicles.find((v) => v.id === entityId);
        return entity?.currentTripId ?? null;
    }, [activePanel, trackedVehicles]);

    // Vehicle click from map: open sidebar panel + auto-follow
    const handleVehicleClick = useCallback((tripId: string, lineNumber: string, destination: string, routeId: number, markerColor: string) => {
        // Check if this vehicle is already tracked
        const existing = trackedVehicles.find((v) => v.currentTripId === tripId);
        if (existing) {
            // Toggle: if panel is already showing this vehicle, close it
            const panelId: SidebarPanel = `vehicle:${existing.id}`;
            setActivePanel((current) => {
                if (current === panelId) {
                    setCameraFollowTripId(null);
                    return null;
                }
                setCameraFollowTripId(tripId);
                return panelId;
            });
            return;
        }

        // Find the full vehicle data
        const liveData = findVehicleInRoutes(tripId, vehicles);
        // Use the marker's color (from the route's OSM data) — bare-ref routeColors
        // lookup is unreliable because the same ref exists across multiple cities.
        const color = markerColor || routeColors.get(lineNumber) || "#3b82f6";
        const stops = liveData?.vehicle.stops ?? [];
        const origin = liveData?.vehicle.origin ?? null;

        const entity = createTrackedVehicle(tripId, lineNumber, destination, origin, color, routeId, stops);
        setTrackedVehicles((prev) => [...prev, entity]);
        setActivePanel(`vehicle:${entity.id}`);
        setCameraFollowTripId(tripId);
    }, [trackedVehicles, vehicles, routeColors]);

    // Pin a vehicle to the sidebar
    const handlePinVehicle = useCallback((entityId: string) => {
        setTrackedVehicles((prev) =>
            prev.map((v) => v.id === entityId ? { ...v, pinned: true } : v)
        );
    }, []);

    // Unpin and remove a vehicle from the sidebar
    const handleUnpinVehicle = useCallback((entityId: string) => {
        setTrackedVehicles((prev) => prev.filter((v) => v.id !== entityId));
        setActivePanel((current) => current === `vehicle:${entityId}` ? null : current);
        setCameraFollowTripId((current) => {
            const entity = trackedVehicles.find((v) => v.id === entityId);
            if (entity && current === entity.currentTripId) return null;
            return current;
        });
    }, [trackedVehicles]);

    // Toggle camera follow for a vehicle
    const handleToggleCameraFollow = useCallback((tripId: string) => {
        setCameraFollowTripId((current) => current === tripId ? null : tripId);
    }, []);

    // Handle trip transition (loop continuation)
    const handleTrackedTripChanged = useCallback((oldTripId: string, newTripId: string) => {
        setTrackedVehicles((prev) =>
            prev.map((v) => {
                if (v.currentTripId !== oldTripId) return v;
                const newVehicleData = findVehicleInRoutes(newTripId, vehicles);
                return transitionTrip(v, newTripId, newVehicleData?.vehicle ?? null);
            })
        );
        setCameraFollowTripId((current) => current === oldTripId ? newTripId : current);
    }, [vehicles]);

    // Handle vehicle lost (disappeared from data)
    const handleTrackedVehicleLost = useCallback((tripId: string) => {
        setTrackedVehicles((prev) =>
            prev.map((v) => {
                if (v.currentTripId !== tripId) return v;
                if (v.pinned) return { ...v, status: "lost" as const };
                return v; // Will be cleaned up by deselect
            }).filter((v) => {
                // Remove unpinned lost vehicles
                if (v.currentTripId === tripId && !v.pinned) return false;
                return true;
            })
        );
        setCameraFollowTripId((current) => current === tripId ? null : current);
        setActivePanel((current) => {
            if (!current?.startsWith("vehicle:")) return current;
            const entityId = current.slice("vehicle:".length);
            const entity = trackedVehicles.find((v) => v.id === entityId);
            if (entity?.currentTripId === tripId && !entity.pinned) return null;
            return current;
        });
    }, [trackedVehicles]);

    // Handle vehicle deselect (click on empty map)
    const handleVehicleDeselect = useCallback(() => {
        if (!activePanel?.startsWith("vehicle:")) return;
        const entityId = activePanel.slice("vehicle:".length);
        const entity = trackedVehicles.find((v) => v.id === entityId);

        if (entity && !entity.pinned) {
            // Remove unpinned vehicle
            setTrackedVehicles((prev) => prev.filter((v) => v.id !== entityId));
        }
        setActivePanel(null);
        setCameraFollowTripId(null);
    }, [activePanel, trackedVehicles]);

    // Handle camera follow stop (user dragged away in tracking mode)
    const handleCameraFollowStop = useCallback(() => {
        setCameraFollowTripId(null);
    }, []);

    // Update tracked vehicle status when vehicles data changes
    useEffect(() => {
        setTrackedVehicles((prev) => {
            let changed = false;
            const updated = prev.map((entity) => {
                if (entity.status === "lost") {
                    // Check if vehicle reappeared
                    const liveData = findVehicleInRoutes(entity.currentTripId, vehicles);
                    if (liveData) {
                        changed = true;
                        // Only update lastKnownStops if live data has at least as many stops
                        const newStops = liveData.vehicle.stops.length >= entity.lastKnownStops.length
                            ? liveData.vehicle.stops
                            : entity.lastKnownStops;
                        return { ...entity, status: "active" as const, lastKnownStops: newStops };
                    }
                } else if (entity.status === "active") {
                    // Update cached stops from live data, but never shrink the list.
                    // The backend may return fewer stops when the departure store
                    // is geographically pruned — keep the most complete list.
                    const liveData = findVehicleInRoutes(entity.currentTripId, vehicles);
                    if (liveData && liveData.vehicle.stops.length > 0) {
                        if (liveData.vehicle.stops.length >= entity.lastKnownStops.length
                            && liveData.vehicle.stops !== entity.lastKnownStops) {
                            changed = true;
                            return { ...entity, lastKnownStops: liveData.vehicle.stops };
                        }
                    }
                }
                return entity;
            });
            return changed ? updated : prev;
        });
    }, [vehicles]);

    // Fetch OSM issues count
    useEffect(() => {
        const fetchIssuesCount = async () => {
            try {
                const response = await getApiClient().api.listIssues();
                setOsmIssuesCount(response.data.count);
            } catch (error) {
                console.error("Failed to fetch issues count:", error);
            }
        };
        fetchIssuesCount();
    }, []);

    // Compute route IDs that must always be subscribed (tracked + camera-followed vehicles)
    const alwaysIncludeRouteIds = useMemo(() => {
        const ids = new Set<number>();
        for (const v of trackedVehicles) {
            if (v.pinned) ids.add(v.routeId);
        }
        if (cameraFollowTripId) {
            const found = findVehicleInRoutes(cameraFollowTripId, vehicles);
            if (found) ids.add(found.routeId);
        }
        return [...ids];
    }, [trackedVehicles, cameraFollowTripId, vehicles]);

    // Viewport-aware route discovery — only subscribe to visible routes
    const { routeIds: visibleRouteIds, routeIdColors, routeIdTypes } = useVisibleRoutes({
        viewportRef,
        enabled: showVehicles,
        alwaysIncludeRouteIds,
    });

    // Fetch vehicles for visible routes (used as fallback when WebSocket unavailable)
    const fetchVehiclesFallback = useCallback(async () => {
        if (visibleRouteIds.length === 0) return;

        const refTime = timeSimulation.isRealTime
            ? undefined
            : timeSimulation.currentTime.toISOString();

        // Cap to 10 routes in fallback mode to avoid request amplification
        const fallbackRouteIds = visibleRouteIds.slice(0, 10);
        try {
            const results = await Promise.all(
                fallbackRouteIds.map(async (routeId) => {
                    try {
                        const response = await getApiClient().api.getVehiclesByRoute({
                            route_id: routeId,
                            reference_time: refTime,
                        });
                        return {
                            routeId,
                            lineNumber: response.data.line_number ?? null,
                            vehicles: response.data.vehicles,
                        };
                    } catch {
                        return { routeId, lineNumber: null as string | null, vehicles: [] as never[] };
                    }
                })
            );
            setVehicles(results);
        } catch (err) {
            console.error("Failed to fetch vehicles:", err);
        }
    }, [visibleRouteIds, timeSimulation.isRealTime, timeSimulation.currentTime]);

    // Handle full vehicle data from WebSocket (initial subscribe)
    const handleFullVehicleData = useCallback((data: RouteVehicles[]) => {
        setVehicles(data);
    }, []);

    // Handle incremental updates from WebSocket (only changes)
    const handleIncrementalUpdate = useCallback(
        (updater: (current: RouteVehicles[]) => RouteVehicles[]) => {
            setVehicles(updater);
        },
        []
    );

    // Cache for tracking which route geometries have been fetched
    const geometryFetchedRef = useRef(new Set<number>());

    // Lazily fetch route geometry when vehicles arrive on a route not yet cached
    const ensureRouteGeometry = useCallback(async (routeId: number) => {
        if (geometryFetchedRef.current.has(routeId)) return;
        geometryFetchedRef.current.add(routeId);
        try {
            const geomResponse = await getApiClient().api.getRouteGeometry(routeId);
            setVehicleRouteGeometries((prev) => {
                const next = new Map(prev);
                next.set(routeId, geomResponse.data.segments);
                return next;
            });
        } catch {
            // Route may not have geometry yet — allow retry later
            geometryFetchedRef.current.delete(routeId);
        }
    }, []);

    const handleViewportChange = useCallback((bbox: [number, number, number, number], zoom: number) => {
        viewportRef.current = { bbox, zoom };
    }, []);

    // Initial data fetch — route color/type lookup. Stations loaded via viewport.
    useEffect(() => {
        const fetchData = async () => {
            try {
                // Load route colors/types from a lightweight endpoint.
                // Keys: "tram:1" for type-specific lookup, "1" as fallback.
                const response = await fetch(`${getApiClient().baseUrl}/api/routes/colors`);
                if (response.ok) {
                    const data = await response.json();
                    const colorMap = new globalThis.Map<string, string>();
                    const typeMap = new globalThis.Map<string, string>();
                    // Track how many different colors exist per type:ref and bare ref.
                    // Germany has 26+ cities with "Tram 1" — only use non-operator keys
                    // when the color is unambiguous (same color everywhere).
                    const typeKeyColors = new globalThis.Map<string, Set<string>>();
                    const refKeyColors = new globalThis.Map<string, Set<string>>();
                    for (const entry of data.entries ?? []) {
                        if (!entry.ref) continue;
                        const typeKey = `${entry.route_type}:${entry.ref}`;
                        if (entry.color) {
                            // Operator-scoped key — always set (unambiguous)
                            if (entry.operator) {
                                const operatorKey = `${entry.operator}:${entry.ref}`;
                                if (!colorMap.has(operatorKey)) colorMap.set(operatorKey, entry.color);
                            }
                            // Track ambiguity for fallback keys
                            if (!typeKeyColors.has(typeKey)) typeKeyColors.set(typeKey, new Set());
                            typeKeyColors.get(typeKey)!.add(entry.color.toLowerCase());
                            if (!refKeyColors.has(entry.ref)) refKeyColors.set(entry.ref, new Set());
                            refKeyColors.get(entry.ref)!.add(entry.color.toLowerCase());
                        }
                        if (!typeMap.has(entry.ref)) {
                            typeMap.set(entry.ref, entry.route_type);
                        }
                    }
                    // Only set type:ref and bare ref keys when the color is unambiguous
                    for (const [key, colors] of typeKeyColors) {
                        if (colors.size === 1) colorMap.set(key, [...colors][0]);
                    }
                    for (const [key, colors] of refKeyColors) {
                        if (colors.size === 1) colorMap.set(key, [...colors][0]);
                    }
                    setRouteColorMap(colorMap);
                    setRouteTypeMap(typeMap);
                    try {
                        localStorage.setItem(COLOR_CACHE_KEY, JSON.stringify([...colorMap]));
                        localStorage.setItem(TYPE_CACHE_KEY, JSON.stringify([...typeMap]));
                        // Clean up old cache keys
                        localStorage.removeItem("omniviv-route-colors");
                        localStorage.removeItem("omniviv-route-types");
                    } catch { /* localStorage full or unavailable */ }
                }
                setRouteColorsLoaded(true);
            } catch (err) {
                console.error("Failed to fetch data:", err);
                setRouteColorsLoaded(true);
            }
        };

        fetchData();
    }, []);

    // When vehicles data changes, ensure geometry is loaded for all active routes
    useEffect(() => {
        for (const rv of vehicles) {
            if (rv.vehicles.length > 0 && !geometryFetchedRef.current.has(rv.routeId)) {
                ensureRouteGeometry(rv.routeId);
            }
        }
    }, [vehicles, ensureRouteGeometry]);

    // LRU eviction for geometry cache — keep at most 200 entries
    useEffect(() => {
        if (vehicleRouteGeometries.size <= 200) return;
        const keep = new Set([...visibleRouteIds, ...alwaysIncludeRouteIds]);
        setVehicleRouteGeometries((prev) => {
            const next = new Map<number, number[][][]>();
            for (const [id, geom] of prev) {
                if (keep.has(id)) next.set(id, geom);
            }
            // Also remove from fetch tracker so evicted routes can be re-fetched
            for (const id of geometryFetchedRef.current) {
                if (!keep.has(id)) geometryFetchedRef.current.delete(id);
            }
            return next;
        });
    }, [vehicleRouteGeometries.size, visibleRouteIds, alwaysIncludeRouteIds]);

    // Compute reference time for simulated time (only when not in real-time mode)
    const referenceTimeISO = useMemo(() => {
        if (timeSimulation.isRealTime) return undefined;
        return timeSimulation.currentTime.toISOString();
    }, [timeSimulation.isRealTime, timeSimulation.currentTime]);

    // WebSocket-based vehicle updates with fallback to polling
    const { isConnected: wsConnected, usingWebSocket } = useVehicleUpdates({
        enabled: showVehicles,
        routeIds: visibleRouteIds,
        referenceTime: referenceTimeISO,
        onFullData: handleFullVehicleData,
        onIncrementalUpdate: handleIncrementalUpdate,
        onFallbackFetch: fetchVehiclesFallback,
        fallbackInterval: FALLBACK_REFRESH_INTERVAL
    });

    return (
        <DebugModeProvider enabled={options.debugMode}>
        <div className="relative flex h-screen w-screen">
            {/* Sidebar */}
            <div className="z-20 flex h-full">
                {/* Icon bar */}
                <div className="bg-background flex flex-col border-r shadow-lg">
                    <Button
                        variant={activePanel === "navigation" ? "default" : "ghost"}
                        size="icon"
                        onClick={() => togglePanel("navigation")}
                        className="m-2"
                        title="Routenplanung"
                        aria-label="Routenplanung"
                    >
                        <Navigation className="h-5 w-5" />
                    </Button>
                    <Button
                        variant={activePanel === "layers" ? "default" : "ghost"}
                        size="icon"
                        onClick={() => togglePanel("layers")}
                        className="m-2"
                        title="Ebenen"
                        aria-label="Ebenen"
                    >
                        <Layers className="h-5 w-5" />
                    </Button>
                    <Button
                        variant={activePanel === "time" ? "default" : "ghost"}
                        size="icon"
                        onClick={() => togglePanel("time")}
                        className="relative m-2"
                        title="Zeitsteuerung"
                        aria-label="Zeitsteuerung"
                    >
                        <Clock className="h-5 w-5" />
                        {!timeSimulation.isRealTime && (
                            <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-orange-500 text-xs text-white" />
                        )}
                    </Button>

                    {/* Separator + pinned platform buttons */}
                    {pinnedStops.length > 0 && <div className="mx-2 border-t border-border" />}
                    {pinnedStops.map((stop) => {
                        const panelId: SidebarPanel = `departures:${stop.id}`;
                        return (
                            <Button
                                key={stop.id}
                                variant={activePanel === panelId ? "default" : "ghost"}
                                size="icon"
                                onClick={() => togglePanel(panelId)}
                                className="m-2"
                                title={`${stop.displayName}${stop.stationName ? ` — ${stop.stationName}` : ""}`}
                                aria-label={stop.displayName}
                            >
                                <span className="text-[10px] font-bold leading-none">{stop.displayName.replace(/^Steig\s*/i, "")}</span>
                            </Button>
                        );
                    })}

                    {/* Separator + pinned vehicle buttons */}
                    {trackedVehicles.some((v) => v.pinned) && <div className="mx-2 border-t border-border" />}
                    {trackedVehicles.filter((v) => v.pinned).map((vehicle) => {
                        const panelId: SidebarPanel = `vehicle:${vehicle.id}`;
                        const vehicleMode = routeIdTypes.get(vehicle.routeId) ?? routeTypes.get(vehicle.lineNumber);
                        return (
                            <Button
                                key={vehicle.id}
                                variant={activePanel === panelId ? "default" : "ghost"}
                                size="icon"
                                onClick={() => togglePanel(panelId)}
                                className={`m-2 ${vehicle.status === "lost" ? "opacity-50" : ""}`}
                                title={`Linie ${vehicle.lineNumber} → ${vehicle.destination}`}
                                aria-label={`Linie ${vehicle.lineNumber}`}
                            >
                                <LineBadge
                                    line={vehicle.lineNumber}
                                    color={routeColors.get(`${vehicleMode}:${vehicle.lineNumber}`) ?? routeColors.get(vehicle.lineNumber) ?? vehicle.color}
                                    mode={vehicleMode}
                                    className="scale-75"
                                />
                            </Button>
                        );
                    })}

                    <div className="flex-1" />
                    <Button
                        variant={activePanel === "features" ? "default" : "ghost"}
                        size="icon"
                        onClick={() => togglePanel("features")}
                        className="m-2"
                        title="Einstellungen"
                        aria-label="Einstellungen"
                    >
                        <Settings className="h-5 w-5" />
                    </Button>
                    <Button
                        variant={activePanel === "issues" ? "default" : "ghost"}
                        size="icon"
                        onClick={() => togglePanel("issues")}
                        className="relative m-2"
                        title="Datenprobleme"
                        aria-label="Datenprobleme"
                    >
                        <TbWorldX className="h-5 w-5" />
                        {osmIssuesCount !== null && osmIssuesCount > 0 && (
                            <span
                                className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-orange-500 px-1 text-xs text-white"
                                aria-label={`${osmIssuesCount} Datenprobleme`}
                            >
                                {osmIssuesCount}
                            </span>
                        )}
                    </Button>
                    {options.debugMode && (
                    <Button
                        variant={activePanel === "debug" ? "default" : "ghost"}
                        size="icon"
                        onClick={() => togglePanel("debug")}
                        className="m-2"
                        title="Debug"
                        aria-label="Debug"
                    >
                        <Bug className="h-5 w-5" />
                    </Button>
                    )}
                    <a
                        href="https://github.com/firstdorsal/omniviv"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="m-2"
                    >
                        <Button
                            variant="ghost"
                            size="icon"
                            title="Auf GitHub ansehen"
                            aria-label="Auf GitHub ansehen"
                        >
                            <Github className="h-5 w-5" />
                        </Button>
                    </a>
                </div>

                {/* Content panel */}
                {activePanel && (
                    <div
                        className="relative flex h-full border-r shadow-lg"
                        style={{ width: panelWidth }}
                    >
                        <div className="bg-background h-full flex-1 overflow-y-scroll min-w-0">
                        {activePanel === "navigation" && (
                            <NavigationPanel
                                stations={stations}
                                routeColors={routeColors}
                                routeTypes={routeTypes}
                                startLocation={navStart}
                                endLocation={navEnd}
                                onStartChange={setNavStart}
                                onEndChange={setNavEnd}
                                intermediateStops={navVia}
                                onIntermediateStopsChange={setNavVia}
                                pickMode={pickMode}
                                onPickModeChange={handlePickModeChange}
                                onFlyTo={handleFlyTo}
                                onSelectItinerary={setSelectedItinerary}
                            />
                        )}

                        {activePanel === "layers" && (
                            <div className="p-4">
                                <h2 className="mb-4 font-semibold">Ebenen</h2>
                                <div className="space-y-3">
                                    <label className="flex cursor-pointer items-center gap-3">
                                        <Checkbox
                                            checked={showStations}
                                            onCheckedChange={(checked) =>
                                                updateOption("showStations", checked === true)
                                            }
                                        />
                                        <span className="text-sm">
                                            Haltestellen{stations.length > 0 ? ` (${stations.length})` : ""}
                                        </span>
                                    </label>

                                    <label className="flex cursor-pointer items-center gap-3 pl-6">
                                        <Checkbox
                                            checked={showSteige}
                                            onCheckedChange={(checked) =>
                                                updateOption("showSteige", checked === true)
                                            }
                                            disabled={!showStations}
                                        />
                                        <span
                                            className={`text-sm ${showStations ? "" : "text-muted-foreground"}`}
                                        >
                                            Steige
                                        </span>
                                    </label>

                                    <label className="flex cursor-pointer items-center gap-3 pl-12">
                                        <Checkbox
                                            checked={showOutlines}
                                            onCheckedChange={(checked) =>
                                                updateOption("showOutlines", checked === true)
                                            }
                                            disabled={!showStations || !showSteige}
                                        />
                                        <span
                                            className={`text-sm ${showStations && showSteige ? "" : "text-muted-foreground"}`}
                                        >
                                            Umrisse
                                        </span>
                                    </label>

                                    <label className="flex cursor-pointer items-center gap-3">
                                        <Checkbox
                                            checked={showRoutes}
                                            onCheckedChange={(checked) =>
                                                updateOption("showRoutes", checked === true)
                                            }
                                        />
                                        <span className="text-sm">
                                            Linien{visibleRouteIds.length > 0 ? ` (${visibleRouteIds.length})` : ""}
                                        </span>
                                    </label>
                                    {(
                                        [
                                            ["tram", "Straßenbahn"],
                                            ["bus", "Bus"],
                                            ["train", "Bahn"],
                                            ["light_rail", "S-Bahn"],
                                            ["subway", "U-Bahn"],
                                            ["ferry", "Fähre"],
                                        ] as const
                                    ).map(([type, label]) => (
                                        <label key={type} className="flex cursor-pointer items-center gap-3 pl-6">
                                            <Checkbox
                                                checked={visibleRouteTypes.includes(type)}
                                                onCheckedChange={(checked) => {
                                                    const next = checked
                                                        ? [...visibleRouteTypes, type]
                                                        : visibleRouteTypes.filter((t) => t !== type);
                                                    updateOption("visibleRouteTypes", next);
                                                }}
                                                disabled={!showRoutes}
                                            />
                                            <span
                                                className={`text-sm ${showRoutes ? "" : "text-muted-foreground"}`}
                                            >
                                                {label}
                                            </span>
                                        </label>
                                    ))}

                                    <label className="flex cursor-pointer items-center gap-3">
                                        <Checkbox
                                            checked={showPois}
                                            onCheckedChange={(checked) =>
                                                updateOption("showPois", checked === true)
                                            }
                                        />
                                        <span className="text-sm flex items-center gap-2">
                                            POIs
                                            <span className="inline-block h-2 w-2 rounded-full bg-violet-600" />
                                        </span>
                                    </label>

                                    <label className="flex cursor-pointer items-center gap-3">
                                        <Checkbox
                                            checked={showVehicles}
                                            onCheckedChange={(checked) =>
                                                updateOption("showVehicles", checked === true)
                                            }
                                        />
                                        <span className="flex items-center gap-2 text-sm">
                                            Fahrzeuge ({totalVehicleCount})
                                            {showVehicles && (
                                                <span
                                                    title={
                                                        usingWebSocket && wsConnected
                                                            ? "Live-Updates über WebSocket"
                                                            : "Abfrage-Updates"
                                                    }
                                                >
                                                    {usingWebSocket && wsConnected ? (
                                                        <Wifi className="h-3 w-3 text-green-500" />
                                                    ) : (
                                                        <WifiOff className="text-muted-foreground h-3 w-3" />
                                                    )}
                                                </span>
                                            )}
                                        </span>
                                    </label>

                                    <label className="flex cursor-pointer items-center gap-3 pl-6">
                                        <Checkbox
                                            checked={debugOptions.show3DModels}
                                            onCheckedChange={(checked) =>
                                                updateOption("debugOptions", {
                                                    ...debugOptions,
                                                    show3DModels: checked === true
                                                })
                                            }
                                            disabled={!showVehicles}
                                        />
                                        <span
                                            className={`text-sm ${showVehicles ? "" : "text-muted-foreground"}`}
                                        >
                                            3D-Modelle
                                        </span>
                                    </label>
                                    {showVehicles && debugOptions.show3DModels && (
                                        <div className="flex items-center gap-3 pr-2 pl-12">
                                            <span className="text-muted-foreground text-xs whitespace-nowrap">
                                                Min Zoom
                                            </span>
                                            <Slider
                                                value={[debugOptions.model3DMinZoom ?? 15]}
                                                onValueChange={([v]) =>
                                                    updateOption("debugOptions", {
                                                        ...debugOptions,
                                                        model3DMinZoom: v
                                                    })
                                                }
                                                min={0}
                                                max={20}
                                                step={1}
                                            />
                                            <span className="text-muted-foreground w-5 text-right text-xs">
                                                {debugOptions.model3DMinZoom ?? 15}
                                            </span>
                                        </div>
                                    )}
                                </div>

                            </div>
                        )}

                        {activePanel === "features" && (
                            <FeaturesPanel
                                isDark={isDark}
                                onThemeChange={setIsDark}
                                rendezvousEnabled={rendezvousEnabled}
                                onRendezvousChange={(enabled) =>
                                    updateOption("rendezvousEnabled", enabled)
                                }
                                rendezvousState={rendezvousState}
                                shouldFlash={shouldFlash}
                                debugMode={options.debugMode}
                                onDebugModeChange={(enabled) =>
                                    updateOption("debugMode", enabled)
                                }
                            />
                        )}

                        {activePanel === "debug" && (
                            <div className="p-4">
                                <h2 className="mb-4 font-semibold">Debug</h2>
                                <div className="space-y-3">
                                    <label className="flex cursor-pointer items-center gap-3">
                                        <Checkbox
                                            checked={debugOptions.showDebugSegments}
                                            onCheckedChange={(checked) =>
                                                updateOption("debugOptions", {
                                                    ...debugOptions,
                                                    showDebugSegments: checked === true
                                                })
                                            }
                                        />
                                        <span className="text-sm">Fahrzeug-Routensegmente anzeigen</span>
                                    </label>

                                    <label className="flex cursor-pointer items-center gap-3 pl-6">
                                        <Checkbox
                                            checked={debugOptions.showDebugOnlyTracked}
                                            onCheckedChange={(checked) =>
                                                updateOption("debugOptions", {
                                                    ...debugOptions,
                                                    showDebugOnlyTracked: checked === true
                                                })
                                            }
                                            disabled={!debugOptions.showDebugSegments}
                                        />
                                        <span
                                            className={`text-sm ${debugOptions.showDebugSegments ? "" : "text-muted-foreground"}`}
                                        >
                                            Nur verfolgtes Fahrzeug
                                        </span>
                                    </label>
                                    <div className="mt-4 border-t pt-4">
                                        <h3 className="mb-3 text-xs font-semibold uppercase text-muted-foreground">Haltestellenmarker</h3>
                                        <div className="space-y-3">
                                            <label className="flex cursor-pointer items-center gap-3">
                                                <Checkbox
                                                    checked={showDebugStops}
                                                    onCheckedChange={(checked) =>
                                                        updateOption("showDebugStops", checked === true)
                                                    }
                                                />
                                                <span className="flex items-center gap-2 text-sm">
                                                    <span className="h-3 w-3 shrink-0 rounded-full bg-blue-500" />
                                                    Haltepositionen
                                                </span>
                                            </label>

                                            <label className="flex cursor-pointer items-center gap-3">
                                                <Checkbox
                                                    checked={showDebugPlatforms}
                                                    onCheckedChange={(checked) =>
                                                        updateOption("showDebugPlatforms", checked === true)
                                                    }
                                                />
                                                <span className="flex items-center gap-2 text-sm">
                                                    <span className="h-3 w-3 shrink-0 rounded-full bg-orange-500" />
                                                    Plattformen
                                                </span>
                                            </label>
                                        </div>
                                    </div>
                                </div>

                                <div className="mt-6 border-t pt-4">
                                    <VehicleMonitorPanel />
                                </div>
                            </div>
                        )}

                        {activePanel === "issues" && (
                            <OsmIssuesPanel
                                onMapDataChange={setMappingMapData}
                                onFlyTo={handleFlyTo}
                                initialTab={getUrlParam("tab") || undefined}
                                onTabChange={(tab) => updateUrlParams({ tab, filter: null })}
                                initialFilter={getUrlParam("filter") || undefined}
                                onFilterChange={(filter) => updateUrlParams({ filter })}
                            />
                        )}

                        {activePanel?.startsWith("departures:") && (() => {
                            const stopId = activePanel.slice("departures:".length);
                            const stop = pinnedStops.find((s) => s.id === stopId);
                            if (!stop) return null;
                            return (
                                <DeparturesPanel
                                    stop={stop}
                                    routeColors={routeColors}
                                    routeTypes={routeTypes}
                                    referenceTime={timeSimulation.isRealTime ? undefined : timeSimulation.currentTime}
                                    onUnpin={handleUnpinStop}
                                    onLocate={handleFlyTo}
                                />
                            );
                        })()}

                        {activePanel?.startsWith("vehicle:") && (() => {
                            const entityId = activePanel.slice("vehicle:".length);
                            const entity = trackedVehicles.find((v) => v.id === entityId);
                            if (!entity) return null;
                            return (
                                <VehicleTrackingPanel
                                    vehicle={entity}
                                    vehicles={vehicles}
                                    routeColors={routeColors}
                                    routeTypes={routeTypes}
                                    routeIdTypes={routeIdTypes}
                                    currentTime={timeSimulation.currentTime}
                                    cameraFollowing={cameraFollowTripId === entity.currentTripId}
                                    onPin={handlePinVehicle}
                                    onUnpin={handleUnpinVehicle}
                                    onToggleCameraFollow={handleToggleCameraFollow}
                                />
                            );
                        })()}

                        {activePanel === "time" && (
                            <TimeControlPanel timeSimulation={timeSimulation} />
                        )}
                        </div>
                        {/* Resize handle — outside scrollable area, right of scrollbar */}
                        <div
                            className="h-full w-1.5 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 shrink-0"
                            onMouseDown={handlePanelResizeStart}
                        />
                    </div>
                )}
            </div>

            {/* Map */}
            <div className="h-full flex-1">
                <TransitMap
                    ref={mapRef}
                    stations={stations}
                    vehicleRouteGeometries={vehicleRouteGeometries}
                    routeIdColors={routeIdColors}
                    vehicles={vehicles}
                    showStations={showStations}
                    showSteige={showSteige}
                    showOutlines={showOutlines}
                    showDebugStops={showDebugStops}
                    showDebugPlatforms={showDebugPlatforms}
                    showRoutes={showRoutes}
                    visibleRouteTypes={visibleRouteTypes}
                    showVehicles={showVehicles}
                    showPois={showPois}
                    debugOptions={debugOptions}
                    simulatedTime={timeSimulation.currentTime}
                    isRealTime={timeSimulation.isRealTime}
                    timeSpeed={timeSimulation.speed}
                    onSetNavigationStart={handleSetNavigationStart}
                    onSetNavigationEnd={handleSetNavigationEnd}
                    pickMode={pickMode}
                    onCancelPickMode={() => setPickMode(null)}
                    navigationStart={navStart}
                    navigationEnd={navEnd}
                    navigationRoute={activePanel === "navigation" ? selectedItinerary : null}
                    navigationWaypoints={navVia}
                    highlightedBuilding={highlightedBuilding}
                    onHighlightBuilding={setHighlightedBuilding}
                    mappingLines={activePanel === "issues" ? mappingMapData.lines : []}
                    mappingGtfsStops={activePanel === "issues" ? mappingMapData.gtfsStops : []}
                    pinnedStopIds={pinnedStopIds}
                    onPinStop={handlePinStop}
                    onUnpinStop={handleUnpinStop}
                    onViewportChange={handleViewportChange}
                    trackedTripId={activeTrackedTripId}
                    cameraFollowTripId={cameraFollowTripId}
                    onVehicleClick={handleVehicleClick}
                    onVehicleDeselect={handleVehicleDeselect}
                    onCameraFollowStop={handleCameraFollowStop}
                    onTrackedTripChanged={handleTrackedTripChanged}
                    onTrackedVehicleLost={handleTrackedVehicleLost}
                    routeColors={routeColors}
                    routeTypes={routeTypes}
                    routeIdTypes={routeIdTypes}
                    debugMode={options.debugMode}
                />
            </div>
        </div>
        <Toaster position="top-center" theme={isDark ? "dark" : "light"} />
        </DebugModeProvider>
    );
}
