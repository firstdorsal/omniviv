import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bug, Clock, Github, Layers, Navigation, Settings, Wifi, WifiOff } from "lucide-react";
import { TbWorldX } from "react-icons/tb";
import { Api, Area, Route, RouteGeometry, Station, Vehicle } from "./api";
import { FeaturesPanel } from "./components/FeaturesPanel";
import { OsmIssuesPanel, type MappingMapData } from "./components/IssuesPanel";
import { NavigationPanel, type Location, type PickMode } from "./components/NavigationPanel";
import { TimeControlPanel } from "./components/TimeControlPanel";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import Map from "./components/map/Map";
import type { DebugOptions } from "./components/vehicles/VehicleRenderer";
import { getConfig } from "./config";
import { useRendezvous } from "./hooks/useRendezvous";
import { useTimeSimulation } from "./hooks/useTimeSimulation";
import { useVehicleUpdates, type RouteVehicles } from "./hooks/useVehicleUpdates";

type SidebarPanel = "navigation" | "layers" | "features" | "debug" | "issues" | "time" | null;

const VALID_PANELS = new Set(["navigation", "layers", "features", "debug", "issues", "time"]);

function getInitialPanel(): SidebarPanel {
    const params = new URLSearchParams(window.location.search);
    const panel = params.get("panel");
    if (panel && VALID_PANELS.has(panel)) return panel as SidebarPanel;
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

let api: Api<unknown> | null = null;
function getApi() {
    if (!api) {
        api = new Api({ baseUrl: getConfig().apiUrl });
    }
    return api;
}

// Fallback polling interval when WebSocket is not available (in milliseconds)
const FALLBACK_REFRESH_INTERVAL = 5000;

// LocalStorage key for persisted options
const STORAGE_KEY = "live-tram-options";

export interface RouteWithGeometry extends Route {
    geometry: RouteGeometry | null;
}

// Re-export for use by other components
export type { RouteVehicles } from "./hooks/useVehicleUpdates";

// Local type alias for state
type RouteVehiclesData = RouteVehicles;

interface PersistedOptions {
    showAreaOutlines: boolean;
    showStations: boolean;
    showStopPositions: boolean;
    showPlatforms: boolean;
    showRoutes: boolean;
    showVehicles: boolean;
    debugOptions: DebugOptions;
    rendezvousEnabled: boolean;
}

const DEFAULT_OPTIONS: PersistedOptions = {
    showAreaOutlines: false,
    showStations: true,
    showStopPositions: false,
    showPlatforms: false,
    showRoutes: true,
    showVehicles: true,
    debugOptions: {
        show3DModels: true,
        showDebugSegments: false,
        showDebugOnlyTracked: true,
    },
    rendezvousEnabled: false,
};

function loadOptions(): PersistedOptions {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            // Merge with defaults to handle new options added in future versions
            return {
                ...DEFAULT_OPTIONS,
                ...parsed,
                debugOptions: {
                    ...DEFAULT_OPTIONS.debugOptions,
                    ...(parsed.debugOptions || {}),
                },
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
    const [areas, setAreas] = useState<Area[]>([]);
    const [stations, setStations] = useState<Station[]>([]);
    const [routes, setRoutes] = useState<RouteWithGeometry[]>([]);
    const [vehicles, setVehicles] = useState<RouteVehiclesData[]>([]);
    const [activePanel, setActivePanel] = useState<SidebarPanel>(getInitialPanel);
    const [osmIssuesCount, setOsmIssuesCount] = useState<number | null>(null);

    // Navigation state
    const [navStart, setNavStart] = useState<Location | null>(null);
    const [navEnd, setNavEnd] = useState<Location | null>(null);
    const [pickMode, setPickMode] = useState<PickMode>(null);

    // Highlighted building state
    const [highlightedBuilding, setHighlightedBuilding] = useState<{ lat: number; lon: number; color?: string } | null>(null);

    // Mapping visualization data (from IssuesPanel mapping tab)
    const [mappingMapData, setMappingMapData] = useState<MappingMapData>({ lines: [], gtfsStops: [] });
    const mapRef = useRef<Map>(null);

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
    const { showAreaOutlines, showStations, showStopPositions, showPlatforms, showRoutes, showVehicles, debugOptions, rendezvousEnabled } = options;

    // Königsplatz rendezvous feature
    const { rendezvousState, highlightedBuilding: rendezvousBuilding, shouldFlash } = useRendezvous({
        enabled: rendezvousEnabled,
        currentTime: timeSimulation.currentTime,
        vehicles,
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
            ...(activePanel !== "issues" ? { tab: null, filter: null } : {}),
        });
    }, [activePanel]);

    // Toggle sidebar panel
    const togglePanel = (panel: SidebarPanel) => {
        setActivePanel((current) => (current === panel ? null : panel));
    };

    // Navigation callbacks for map context menu and pick mode
    const handleSetNavigationStart = useCallback((lat: number, lon: number) => {
        setNavStart({
            name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
            lat,
            lon,
        });
        setPickMode(null);
        setActivePanel("navigation");
    }, []);

    const handleSetNavigationEnd = useCallback((lat: number, lon: number) => {
        setNavEnd({
            name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
            lat,
            lon,
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

    // Fetch OSM issues count
    useEffect(() => {
        const fetchIssuesCount = async () => {
            try {
                const response = await fetch(`${getConfig().apiUrl}/api/issues`);
                if (response.ok) {
                    const data = await response.json();
                    setOsmIssuesCount(data.count);
                }
            } catch (error) {
                console.error("Failed to fetch issues count:", error);
            }
        };
        fetchIssuesCount();
    }, []);

    // Fetch vehicles for all routes (used as fallback when WebSocket unavailable)
    const fetchVehiclesFallback = useCallback(async () => {
        if (routes.length === 0) return;

        const refTime = timeSimulation.isRealTime ? undefined : timeSimulation.currentTime.toISOString();

        try {
            const vehiclePromises = routes.map(async (route) => {
                try {
                    const response = await getApi().api.getVehiclesByRoute({
                        route_id: route.osm_id,
                        reference_time: refTime,
                    });
                    return {
                        routeId: route.osm_id,
                        lineNumber: response.data.line_number ?? null,
                        vehicles: response.data.vehicles,
                    };
                } catch {
                    return {
                        routeId: route.osm_id,
                        lineNumber: route.ref ?? null,
                        vehicles: [],
                    };
                }
            });

            const results = await Promise.all(vehiclePromises);
            setVehicles(results);
        } catch (err) {
            console.error("Failed to fetch vehicles:", err);
        }
    }, [routes, timeSimulation.isRealTime, timeSimulation.currentTime]);

    // Handle full vehicle data from WebSocket (initial subscribe)
    const handleFullVehicleData = useCallback((data: RouteVehiclesData[]) => {
        setVehicles(data);
    }, []);

    // Handle incremental updates from WebSocket (only changes)
    const handleIncrementalUpdate = useCallback((updater: (current: RouteVehiclesData[]) => RouteVehiclesData[]) => {
        setVehicles(updater);
    }, []);

    // Initial data fetch
    useEffect(() => {
        const fetchData = async () => {
            try {
                const [areasResponse, stationsResponse, routesResponse] = await Promise.all([
                    getApi().api.listAreas(),
                    getApi().api.listStations(),
                    getApi().api.listRoutes(),
                ]);
                setAreas(areasResponse.data.areas);
                setStations(stationsResponse.data.stations);

                // Fetch geometries for all routes
                const routesWithGeometry = await Promise.all(
                    routesResponse.data.routes.map(async (route) => {
                        try {
                            const geomResponse = await getApi().api.getRouteGeometry(route.osm_id);
                            return { ...route, geometry: geomResponse.data };
                        } catch {
                            return { ...route, geometry: null };
                        }
                    })
                );
                setRoutes(routesWithGeometry);
                // Vehicle data will be fetched via WebSocket subscription
            } catch (err) {
                console.error("Failed to fetch data:", err);
            }
        };

        fetchData();
    }, []);

    // Get route IDs for WebSocket subscription
    const routeIds = useMemo(() => routes.map(r => r.osm_id), [routes]);

    // Compute reference time for simulated time (only when not in real-time mode)
    const referenceTimeISO = useMemo(() => {
        if (timeSimulation.isRealTime) return undefined;
        return timeSimulation.currentTime.toISOString();
    }, [timeSimulation.isRealTime, timeSimulation.currentTime]);

    // WebSocket-based vehicle updates with fallback to polling
    const { isConnected: wsConnected, usingWebSocket } = useVehicleUpdates({
        enabled: showVehicles && routes.length > 0,
        routeIds,
        referenceTime: referenceTimeISO,
        onFullData: handleFullVehicleData,
        onIncrementalUpdate: handleIncrementalUpdate,
        onFallbackFetch: fetchVehiclesFallback,
        fallbackInterval: FALLBACK_REFRESH_INTERVAL,
    });

    return (
        <div className="h-screen w-screen relative flex">
            {/* Sidebar */}
            <div className="flex h-full z-20">
                {/* Icon bar */}
                <div className="flex flex-col bg-background border-r shadow-lg">
                    <Button
                        variant={activePanel === "navigation" ? "default" : "ghost"}
                        size="icon"
                        onClick={() => togglePanel("navigation")}
                        className="m-2"
                        title="Route Planning"
                        aria-label="Route Planning"
                    >
                        <Navigation className="h-5 w-5" />
                    </Button>
                    <Button
                        variant={activePanel === "layers" ? "default" : "ghost"}
                        size="icon"
                        onClick={() => togglePanel("layers")}
                        className="m-2"
                        title="Layers"
                        aria-label="Layers"
                    >
                        <Layers className="h-5 w-5" />
                    </Button>
                    <Button
                        variant={activePanel === "time" ? "default" : "ghost"}
                        size="icon"
                        onClick={() => togglePanel("time")}
                        className="m-2 relative"
                        title="Time Control"
                        aria-label="Time Control"
                    >
                        <Clock className="h-5 w-5" />
                        {!timeSimulation.isRealTime && (
                            <span className="absolute -top-1 -right-1 bg-orange-500 text-white text-xs rounded-full h-3 w-3" />
                        )}
                    </Button>
                    <div className="flex-1" />
                    <Button
                        variant={activePanel === "features" ? "default" : "ghost"}
                        size="icon"
                        onClick={() => togglePanel("features")}
                        className="m-2"
                        title="Settings"
                        aria-label="Settings"
                    >
                        <Settings className="h-5 w-5" />
                    </Button>
                    <Button
                        variant={activePanel === "issues" ? "default" : "ghost"}
                        size="icon"
                        onClick={() => togglePanel("issues")}
                        className="m-2 relative"
                        title="OSM Issues"
                        aria-label="OSM Issues"
                    >
                        <TbWorldX className="h-5 w-5" />
                        {osmIssuesCount !== null && osmIssuesCount > 0 && (
                            <span
                                className="absolute -top-1 -right-1 bg-orange-500 text-white text-xs rounded-full h-5 min-w-5 flex items-center justify-center px-1"
                                aria-label={`${osmIssuesCount} OSM data issues`}
                            >
                                {osmIssuesCount}
                            </span>
                        )}
                    </Button>
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
                    <a
                        href="https://github.com/firstdorsal/omniviv"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="m-2"
                    >
                        <Button
                            variant="ghost"
                            size="icon"
                            title="View on GitHub"
                            aria-label="View on GitHub"
                        >
                            <Github className="h-5 w-5" />
                        </Button>
                    </a>
                </div>

                {/* Content panel */}
                {activePanel && (
                    <div className="w-80 h-full bg-background border-r shadow-lg overflow-y-auto">
                        {activePanel === "navigation" && (
                            <NavigationPanel
                                stations={stations}
                                startLocation={navStart}
                                endLocation={navEnd}
                                onStartChange={setNavStart}
                                onEndChange={setNavEnd}
                                pickMode={pickMode}
                                onPickModeChange={handlePickModeChange}
                            />
                        )}

                        {activePanel === "layers" && (
                            <div className="p-4">
                                <h2 className="font-semibold mb-4">Layers</h2>
                                <div className="space-y-3">
                                    <label className="flex items-center gap-3 cursor-pointer">
                                        <Checkbox
                                            checked={showAreaOutlines}
                                            onCheckedChange={(checked) => updateOption("showAreaOutlines", checked === true)}
                                        />
                                        <span className="text-sm">Show area outlines</span>
                                    </label>

                                    <label className="flex items-center gap-3 cursor-pointer">
                                        <Checkbox
                                            checked={showStations}
                                            onCheckedChange={(checked) => updateOption("showStations", checked === true)}
                                        />
                                        <span className="text-sm">Show stations ({stations.length})</span>
                                    </label>

                                    <label className="flex items-center gap-3 cursor-pointer pl-6">
                                        <Checkbox
                                            checked={showStopPositions}
                                            onCheckedChange={(checked) => updateOption("showStopPositions", checked === true)}
                                            disabled={!showStations}
                                        />
                                        <span className={`text-sm flex items-center gap-2 ${showStations ? "" : "text-muted-foreground"}`}>
                                            <span className="w-3 h-3 rounded-full bg-blue-500 shrink-0" />
                                            Show stop positions
                                        </span>
                                    </label>

                                    <label className="flex items-center gap-3 cursor-pointer pl-6">
                                        <Checkbox
                                            checked={showPlatforms}
                                            onCheckedChange={(checked) => updateOption("showPlatforms", checked === true)}
                                            disabled={!showStations}
                                        />
                                        <span className={`text-sm flex items-center gap-2 ${showStations ? "" : "text-muted-foreground"}`}>
                                            <span className="w-3 h-3 rounded-full bg-orange-500 shrink-0" />
                                            Show platforms
                                        </span>
                                    </label>

                                    <label className="flex items-center gap-3 cursor-pointer">
                                        <Checkbox
                                            checked={showRoutes}
                                            onCheckedChange={(checked) => updateOption("showRoutes", checked === true)}
                                        />
                                        <span className="text-sm">Show routes ({routes.length})</span>
                                    </label>

                                    <label className="flex items-center gap-3 cursor-pointer">
                                        <Checkbox
                                            checked={showVehicles}
                                            onCheckedChange={(checked) => updateOption("showVehicles", checked === true)}
                                        />
                                        <span className="text-sm flex items-center gap-2">
                                            Show vehicles ({totalVehicleCount})
                                            {showVehicles && (
                                                <span title={usingWebSocket && wsConnected ? "Live updates via WebSocket" : "Polling for updates"}>
                                                    {usingWebSocket && wsConnected ? (
                                                        <Wifi className="h-3 w-3 text-green-500" />
                                                    ) : (
                                                        <WifiOff className="h-3 w-3 text-muted-foreground" />
                                                    )}
                                                </span>
                                            )}
                                        </span>
                                    </label>

                                    <label className="flex items-center gap-3 cursor-pointer pl-6">
                                        <Checkbox
                                            checked={debugOptions.show3DModels}
                                            onCheckedChange={(checked) => updateOption("debugOptions", {
                                                ...debugOptions,
                                                show3DModels: checked === true,
                                            })}
                                            disabled={!showVehicles}
                                        />
                                        <span className={`text-sm ${showVehicles ? "" : "text-muted-foreground"}`}>
                                            Show 3D models
                                        </span>
                                    </label>
                                </div>

                                {areas.length > 0 && (
                                    <div className="mt-6 pt-4 border-t">
                                        <h3 className="text-sm font-medium text-muted-foreground mb-2">Areas</h3>
                                        <ul className="space-y-1">
                                            {areas.map((area) => (
                                                <li key={area.id} className="text-sm flex items-center gap-2">
                                                    <span className="w-2 h-2 rounded-full bg-primary" />
                                                    {area.name}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </div>
                        )}

                        {activePanel === "features" && (
                            <FeaturesPanel
                                isDark={isDark}
                                onThemeChange={setIsDark}
                                rendezvousEnabled={rendezvousEnabled}
                                onRendezvousChange={(enabled) => updateOption("rendezvousEnabled", enabled)}
                                rendezvousState={rendezvousState}
                                shouldFlash={shouldFlash}
                            />
                        )}

                        {activePanel === "debug" && (
                            <div className="p-4">
                                <h2 className="font-semibold mb-4">Debug</h2>
                                <div className="space-y-3">
                                    <label className="flex items-center gap-3 cursor-pointer">
                                        <Checkbox
                                            checked={debugOptions.showDebugSegments}
                                            onCheckedChange={(checked) => updateOption("debugOptions", {
                                                ...debugOptions,
                                                showDebugSegments: checked === true,
                                            })}
                                        />
                                        <span className="text-sm">Show vehicle route segments</span>
                                    </label>

                                    <label className="flex items-center gap-3 cursor-pointer pl-6">
                                        <Checkbox
                                            checked={debugOptions.showDebugOnlyTracked}
                                            onCheckedChange={(checked) => updateOption("debugOptions", {
                                                ...debugOptions,
                                                showDebugOnlyTracked: checked === true,
                                            })}
                                            disabled={!debugOptions.showDebugSegments}
                                        />
                                        <span className={`text-sm ${debugOptions.showDebugSegments ? "" : "text-muted-foreground"}`}>
                                            Only tracked vehicle
                                        </span>
                                    </label>
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

                        {activePanel === "time" && (
                            <TimeControlPanel timeSimulation={timeSimulation} />
                        )}

                    </div>
                )}
            </div>

            {/* Map */}
            <div className="flex-1 h-full">
                <Map
                    ref={mapRef}
                    areas={areas}
                    stations={stations}
                    routes={routes}
                    vehicles={vehicles}
                    showAreaOutlines={showAreaOutlines}
                    showStations={showStations}
                    showStopPositions={showStopPositions}
                    showPlatforms={showPlatforms}
                    showRoutes={showRoutes}
                    showVehicles={showVehicles}
                    debugOptions={debugOptions}
                    simulatedTime={timeSimulation.currentTime}
                    timeSpeed={timeSimulation.speed}
                    onSetNavigationStart={handleSetNavigationStart}
                    onSetNavigationEnd={handleSetNavigationEnd}
                    pickMode={pickMode}
                    onCancelPickMode={() => setPickMode(null)}
                    navigationStart={navStart}
                    navigationEnd={navEnd}
                    highlightedBuilding={highlightedBuilding}
                    onHighlightBuilding={setHighlightedBuilding}
                    mappingLines={activePanel === "issues" ? mappingMapData.lines : []}
                    mappingGtfsStops={activePanel === "issues" ? mappingMapData.gtfsStops : []}
                />
            </div>
        </div>
    );
}
