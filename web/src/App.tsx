import { Bug, Clock, Github, Layers, Navigation, Settings, TrainFront, Wifi, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TbWorldX } from "react-icons/tb";
import { Api, Area, Route, RouteGeometry, Station } from "./api";
import { DeparturesPanel, type PinnedStop } from "./components/DeparturesPanel";
import { FeaturesPanel } from "./components/FeaturesPanel";
import { OsmIssuesPanel, type MappingMapData } from "./components/IssuesPanel";
import { NavigationPanel, type Location, type PickMode } from "./components/NavigationPanel";
import { TimeControlPanel } from "./components/TimeControlPanel";
import { VehicleMonitorPanel } from "./components/VehicleMonitorPanel";
import Map from "./components/map/Map";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Slider } from "./components/ui/slider";
import type { DebugOptions } from "./components/vehicles/VehicleRenderer";
import { getConfig } from "./config";
import { useRendezvous } from "./hooks/useRendezvous";
import { useTimeSimulation } from "./hooks/useTimeSimulation";
import { useVehicleUpdates, type RouteVehicles } from "./hooks/useVehicleUpdates";

type SidebarPanel = "navigation" | "layers" | "features" | "debug" | "issues" | "time" | `departures:${string}` | null;

const VALID_PANELS = new Set(["navigation", "layers", "features", "debug", "issues", "time"]);

function getInitialPanel(): SidebarPanel {
    const params = new URLSearchParams(window.location.search);
    const panel = params.get("panel");
    if (panel && (VALID_PANELS.has(panel) || panel.startsWith("departures:"))) return panel as SidebarPanel;
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
        model3DMinZoom: 15,
        showDebugSegments: false,
        showDebugOnlyTracked: true
    },
    rendezvousEnabled: false
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
    const [areas, setAreas] = useState<Area[]>([]);
    const [stations, setStations] = useState<Station[]>([]);
    const [routes, setRoutes] = useState<RouteWithGeometry[]>([]);
    const [vehicles, setVehicles] = useState<RouteVehiclesData[]>([]);
    const [activePanel, setActivePanel] = useState<SidebarPanel>(getInitialPanel);
    const [pinnedStops, setPinnedStops] = useState<PinnedStop[]>(() => {
        try {
            const stored = localStorage.getItem("pinned-stops");
            if (stored) return JSON.parse(stored);
        } catch { /* ignore */ }
        return [];
    });
    const [panelWidth, setPanelWidth] = useState(() => {
        try {
            const stored = localStorage.getItem("panel-width");
            if (stored) return Math.max(240, Math.min(600, Number(stored)));
        } catch { /* ignore */ }
        return 320;
    });

    // Persist pinned stops and panel width
    useEffect(() => {
        localStorage.setItem("pinned-stops", JSON.stringify(pinnedStops));
    }, [pinnedStops]);
    useEffect(() => {
        localStorage.setItem("panel-width", String(panelWidth));
    }, [panelWidth]);
    const [osmIssuesCount, setOsmIssuesCount] = useState<number | null>(null);

    // Navigation state
    const [navStart, setNavStart] = useState<Location | null>(null);
    const [navEnd, setNavEnd] = useState<Location | null>(null);
    const [pickMode, setPickMode] = useState<PickMode>(null);

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
    const {
        showAreaOutlines,
        showStations,
        showStopPositions,
        showPlatforms,
        showRoutes,
        showVehicles,
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
    const handlePinStop = useCallback((stopIfopt: string, displayName: string, stationName?: string) => {
        setPinnedStops((prev) => {
            if (prev.some((s) => s.stopIfopt === stopIfopt)) return prev;
            return [...prev, { id: stopIfopt, stopIfopt, displayName, stationName }];
        });
        setActivePanel(`departures:${stopIfopt}`);
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

    const handleUnpinStop = useCallback((id: string) => {
        setPinnedStops((prev) => prev.filter((s) => s.id !== id));
        setActivePanel((current) => current === `departures:${id}` ? null : current);
    }, []);

    // Navigation callbacks for map context menu and pick mode
    const handleSetNavigationStart = useCallback((lat: number, lon: number) => {
        setNavStart({
            name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
            lat,
            lon
        });
        setPickMode(null);
        setActivePanel("navigation");
    }, []);

    const handleSetNavigationEnd = useCallback((lat: number, lon: number) => {
        setNavEnd({
            name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
            lat,
            lon
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

        const refTime = timeSimulation.isRealTime
            ? undefined
            : timeSimulation.currentTime.toISOString();

        try {
            const vehiclePromises = routes.map(async (route) => {
                try {
                    const response = await getApi().api.getVehiclesByRoute({
                        route_id: route.osm_id,
                        reference_time: refTime
                    });
                    return {
                        routeId: route.osm_id,
                        lineNumber: response.data.line_number ?? null,
                        vehicles: response.data.vehicles
                    };
                } catch {
                    return {
                        routeId: route.osm_id,
                        lineNumber: route.ref ?? null,
                        vehicles: []
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
    const handleIncrementalUpdate = useCallback(
        (updater: (current: RouteVehiclesData[]) => RouteVehiclesData[]) => {
            setVehicles(updater);
        },
        []
    );

    // Initial data fetch
    useEffect(() => {
        const fetchData = async () => {
            try {
                const [areasResponse, stationsResponse, routesResponse] = await Promise.all([
                    getApi().api.listAreas(),
                    getApi().api.listStations(),
                    getApi().api.listRoutes()
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
    const routeIds = useMemo(() => routes.map((r) => r.osm_id), [routes]);

    // Route colors for departure tables (line number → color)
    const routeColors = useMemo(() => {
        const map = new globalThis.Map<string, string>();
        for (const route of routes) {
            if (route.ref && route.color) map.set(route.ref, route.color);
        }
        return map;
    }, [routes]);

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
        fallbackInterval: FALLBACK_REFRESH_INTERVAL
    });

    return (
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
                        className="bg-background relative h-full overflow-y-auto border-r shadow-lg"
                        style={{ width: panelWidth }}
                    >
                        {/* Resize handle */}
                        <div
                            className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 z-10"
                            onMouseDown={handlePanelResizeStart}
                        />
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
                                <h2 className="mb-4 font-semibold">Ebenen</h2>
                                <div className="space-y-3">
                                    <label className="flex cursor-pointer items-center gap-3">
                                        <Checkbox
                                            checked={showAreaOutlines}
                                            onCheckedChange={(checked) =>
                                                updateOption("showAreaOutlines", checked === true)
                                            }
                                        />
                                        <span className="text-sm">Gebietsumrisse anzeigen</span>
                                    </label>

                                    <label className="flex cursor-pointer items-center gap-3">
                                        <Checkbox
                                            checked={showStations}
                                            onCheckedChange={(checked) =>
                                                updateOption("showStations", checked === true)
                                            }
                                        />
                                        <span className="text-sm">
                                            Haltestellen ({stations.length})
                                        </span>
                                    </label>

                                    <label className="flex cursor-pointer items-center gap-3 pl-6">
                                        <Checkbox
                                            checked={showStopPositions}
                                            onCheckedChange={(checked) =>
                                                updateOption("showStopPositions", checked === true)
                                            }
                                            disabled={!showStations}
                                        />
                                        <span
                                            className={`flex items-center gap-2 text-sm ${showStations ? "" : "text-muted-foreground"}`}
                                        >
                                            <span className="h-3 w-3 shrink-0 rounded-full bg-blue-500" />
                                            Haltepositionen
                                        </span>
                                    </label>

                                    <label className="flex cursor-pointer items-center gap-3 pl-6">
                                        <Checkbox
                                            checked={showPlatforms}
                                            onCheckedChange={(checked) =>
                                                updateOption("showPlatforms", checked === true)
                                            }
                                            disabled={!showStations}
                                        />
                                        <span
                                            className={`flex items-center gap-2 text-sm ${showStations ? "" : "text-muted-foreground"}`}
                                        >
                                            <span className="h-3 w-3 shrink-0 rounded-full bg-orange-500" />
                                            Steige
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
                                            Linien ({routes.length})
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

                                {areas.length > 0 && (
                                    <div className="mt-6 border-t pt-4">
                                        <h3 className="text-muted-foreground mb-2 text-sm font-medium">
                                            Gebiete
                                        </h3>
                                        <ul className="space-y-1">
                                            {areas.map((area) => (
                                                <li
                                                    key={area.id}
                                                    className="flex items-center gap-2 text-sm"
                                                >
                                                    <span className="bg-primary h-2 w-2 rounded-full" />
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
                                onRendezvousChange={(enabled) =>
                                    updateOption("rendezvousEnabled", enabled)
                                }
                                rendezvousState={rendezvousState}
                                shouldFlash={shouldFlash}
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
                                    referenceTime={timeSimulation.isRealTime ? undefined : timeSimulation.currentTime}
                                    onUnpin={handleUnpinStop}
                                />
                            );
                        })()}

                        {activePanel === "time" && (
                            <TimeControlPanel timeSimulation={timeSimulation} />
                        )}
                    </div>
                )}
            </div>

            {/* Map */}
            <div className="h-full flex-1">
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
                    onPinStop={handlePinStop}
                />
            </div>
        </div>
    );
}
