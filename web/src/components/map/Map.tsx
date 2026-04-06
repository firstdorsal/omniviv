import { Info, Minus, Plus } from "lucide-react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Station, StationPlatform, StationStopPosition } from "../../api";
import { getApiClient } from "../../apiClient";
import type { RouteVehicles } from "../../App";
import type { MappingLine, MappingGtfsStop } from "../MappingManager";
import type { RouteItinerary } from "../NavigationPanel";
import { createWaypointMarkerElement } from "../WaypointMarker";
import { haversineDistance, findClosestPointIndex, stripStationSuffix } from "../../lib/geoUtils";
import { decodePolyline } from "./polyline";
import { getConfig } from "../../config";
import { GtfsStopPopup } from "../GtfsStopPopup";
import { PlacePopup } from "../PlacePopup";
import { PlatformPopup } from "../PlatformPopup";
import { StationPopup } from "../StationPopup";
import { Button } from "../ui/button";
import { VehicleRenderer, ANIMATION_INTERVAL } from "../vehicles/VehicleRenderer";
import type { DebugOptions } from "../vehicles/VehicleRenderer";
import { VehicleModelLoader } from "../vehicles/VehicleModelLoader";
import { VehicleTracker } from "../vehicles/VehicleTracker";
import type { SmoothedVehiclePosition } from "../vehicles/vehicleUtils";
import { MapLayerManager } from "./MapLayerManager";

const MAP_STYLE_URL = import.meta.env.VITE_MAP_STYLE_URL ?? "/styles/basic-preview/style.json";

/** Replace the origin (scheme+host+port) of a URL with the configured martin URL.
 *  Uses string replacement instead of `new URL()` because style URLs may contain
 *  template placeholders like `{fontstack}/{range}` that aren't valid URLs. */
function rebaseUrl(url: string, martinOrigin: string): string {
    return url.replace(/^https?:\/\/[^/]+/, martinOrigin.replace(/\/$/, ""));
}

async function loadMapStyle(): Promise<maplibregl.StyleSpecification> {
    const response = await fetch(MAP_STYLE_URL);
    const style = await response.json();
    const martinUrl = getConfig().martinUrl;

    // Rebase tile source URLs to the configured martin instance
    if (style.sources) {
        for (const source of Object.values(style.sources) as { url?: string }[]) {
            if (source.url) {
                source.url = rebaseUrl(source.url, martinUrl);
            }
        }
    }

    if (style.glyphs) {
        style.glyphs = rebaseUrl(style.glyphs, martinUrl);
    }

    // Remove sprite reference — POI icons are loaded on-demand via styleimagemissing
    // using the same Maki/Temaki SVGs as the route planning UI.
    delete style.sprite;

    return style;
}
// ANIMATION_INTERVAL is imported from VehicleRenderer

type PickMode = "start" | "end" | null;

interface NavigationLocation {
    name: string;
    lat: number;
    lon: number;
}

interface HighlightedBuilding {
    lat: number;
    lon: number;
    color?: string;
}

interface MapProps {
    stations: Station[];
    vehicleRouteGeometries: Map<number, number[][][]>;
    routeIdColors: Map<number, string>;
    routeIdTypes?: Map<number, string>;
    vehicles: RouteVehicles[];
    showStations: boolean;
    showSteige: boolean;
    showOutlines: boolean;
    showDebugStops: boolean;
    showDebugPlatforms: boolean;
    showRoutes: boolean;
    visibleRouteTypes: string[];
    lineOverrides: import("../../App").LineOverride[];
    showVehicles: boolean;
    showPois: boolean;
    debugOptions: DebugOptions;
    simulatedTime: Date;
    isRealTime: boolean;
    timeSpeed: number;
    onSetNavigationStart?: (lat: number, lon: number) => void;
    onSetNavigationEnd?: (lat: number, lon: number) => void;
    pickMode?: PickMode;
    onCancelPickMode?: () => void;
    navigationStart?: NavigationLocation | null;
    navigationEnd?: NavigationLocation | null;
    navigationWaypoints?: (NavigationLocation | null)[];
    navigationRoute?: RouteItinerary | null;
    highlightedBuilding?: HighlightedBuilding | null;
    onHighlightBuilding?: (building: HighlightedBuilding | null) => void;
    mappingLines?: MappingLine[];
    mappingGtfsStops?: MappingGtfsStop[];
    pinnedStopIds?: Set<string>;
    onPinStop?: (osmId: string, displayName: string, stationName?: string, refIfopt?: string | null, lat?: number, lon?: number) => void;
    onUnpinStop?: (id: string) => void;
    onViewportChange?: (bbox: [number, number, number, number], zoom: number) => void;
    trackedTripId?: string | null;
    cameraFollowTripId?: string | null;
    onVehicleClick?: (tripId: string, lineNumber: string, destination: string, routeId: number, color: string) => void;
    onVehicleDeselect?: () => void;
    onCameraFollowStop?: () => void;
    onTrackedTripChanged?: (oldTripId: string, newTripId: string) => void;
    onTrackedVehicleLost?: (tripId: string) => void;
    routeColors: Map<string, string>;
    routeTypes: Map<string, string>;
    debugMode?: boolean;
}

interface ContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    lng: number;
    lat: number;
}

interface MeasurementState {
    startPoint: { lng: number; lat: number } | null;
    endPoint: { lng: number; lat: number } | null;
    isActive: boolean;
}

interface MapState {
    mapLoaded: boolean;
    contextMenu: ContextMenuState | null;
    measurement: MeasurementState;
    buildingHighlighted: boolean;
    bearing: number;
    pitch: number;
    zoom: number;
    scaleWidth: number;
    scaleLabel: string;
    attributionExpanded: boolean;
}

export default class TransitMap extends React.Component<MapProps, MapState> {
    private mapContainer: React.RefObject<HTMLDivElement | null>;
    private map: maplibregl.Map | null = null;
    private popup: maplibregl.Popup | null = null;
    private popupRoot: Root | null = null;

    // Managers
    private layerManager: MapLayerManager | null = null;
    private vehicleRenderer: VehicleRenderer | null = null;
    private vehicleTracker: VehicleTracker | null = null;

    // Data caches
    // Route colors and types come from props (this.props.routeColors, this.props.routeTypes)
    private routeGeometries = new Map<number, number[][][]>();
    private routeTypes = new globalThis.Map<number, string>();
    private modelLoader = new VehicleModelLoader("augsburg");
    private modelLoaderInitAborted = false;
    private hashSyncTimer: ReturnType<typeof setTimeout> | null = null;

    // Guards against stale async initialization (e.g. React StrictMode double-mount).
    // Each componentDidMount increments this; async callbacks abort if it changed.
    private initGeneration = 0;

    constructor(props: MapProps) {
        super(props);
        this.mapContainer = React.createRef();
        this.state = {
            mapLoaded: false,
            contextMenu: null,
            measurement: {
                startPoint: null,
                endPoint: null,
                isActive: false,
            },
            buildingHighlighted: false,
            bearing: 0,
            pitch: 0,
            zoom: 12,
            scaleWidth: 100,
            scaleLabel: "",
            attributionExpanded: false,
        };
    }

    /** Fly the map camera to a specific location */
    public flyTo(lat: number, lon: number) {
        this.map?.flyTo({ center: [lon, lat], zoom: 15, duration: 1000 });
    }

    /** Get the smoothed position for a vehicle by trip ID */
    public getSmoothedPosition(tripId: string): SmoothedVehiclePosition | undefined {
        return this.vehicleRenderer?.getSmoothedPosition(tripId);
    }

    componentDidMount() {
        this.initGeneration++;
        this.initializeMap(this.initGeneration);
        this.updateRouteData();
    }

    componentDidUpdate(prevProps: MapProps, prevState: MapState) {
        if (prevProps.vehicleRouteGeometries !== this.props.vehicleRouteGeometries ||
            prevProps.routeColors !== this.props.routeColors ||
            prevProps.routeTypes !== this.props.routeTypes ||
            prevProps.routeIdColors !== this.props.routeIdColors ||
            prevProps.routeIdTypes !== this.props.routeIdTypes) {
            this.updateRouteData();
        }

        if (this.state.mapLoaded && !prevState.mapLoaded) {
            this.updateAllMapData();
        }

        if (this.state.mapLoaded && this.layerManager) {
            if (prevProps.showStations !== this.props.showStations ||
                prevProps.showSteige !== this.props.showSteige ||
                prevProps.showOutlines !== this.props.showOutlines ||
                prevProps.showDebugStops !== this.props.showDebugStops ||
                prevProps.showDebugPlatforms !== this.props.showDebugPlatforms ||
                prevProps.stations !== this.props.stations) {
                this.layerManager.updateStations(
                    this.props.stations,
                    this.props.showStations,
                    this.props.showSteige,
                    this.props.showOutlines,
                    this.props.showDebugStops,
                    this.props.showDebugPlatforms,
                );
            }
            if (
                prevProps.showRoutes !== this.props.showRoutes
                || prevProps.visibleRouteTypes !== this.props.visibleRouteTypes
                || prevProps.lineOverrides !== this.props.lineOverrides
            ) {
                this.layerManager.setRoutesVisible(this.props.showRoutes, this.props.visibleRouteTypes, this.props.lineOverrides);
            }
            if (prevProps.showPois !== this.props.showPois) {
                this.setPoiVisibility(this.props.showPois);
            }
            if (prevProps.showVehicles !== this.props.showVehicles) {
                this.handleVehicleVisibilityChange();
            }
            if (prevProps.vehicles !== this.props.vehicles) {
                // Always update the vehicles reference so animation loop uses latest data
                this.vehicleRenderer?.setVehicles(this.props.vehicles);
                if (this.props.showVehicles) {
                    // Ensure animation is running (may have been stopped by StrictMode remount).
                    // startAnimation() is a no-op if already running. The loop picks up
                    // new vehicles via this.currentVehicles on the next frame.
                    this.vehicleRenderer?.startAnimation();
                }
            }
            // Update simulated time reference for vehicle position calculations
            if (prevProps.simulatedTime !== this.props.simulatedTime) {
                this.vehicleRenderer?.setSimulatedTime(this.props.simulatedTime);
                this.vehicleTracker?.setSimulatedTime(this.props.simulatedTime);
            }
            if (prevProps.timeSpeed !== this.props.timeSpeed) {
                this.vehicleRenderer?.setTimeSpeed(this.props.timeSpeed);
            }
        }

        // Handle tracked vehicle changes (driven by props from App)
        if (prevProps.trackedTripId !== this.props.trackedTripId) {
            this.vehicleRenderer?.setTrackedTripId(this.props.trackedTripId ?? null);
            this.vehicleRenderer?.setDebugOptions(this.props.debugOptions);
            if (this.props.showVehicles) {
                this.vehicleRenderer?.updatePositions(this.props.vehicles, ANIMATION_INTERVAL);
            }
        }

        // Handle camera follow changes (driven by props from App)
        if (prevProps.cameraFollowTripId !== this.props.cameraFollowTripId) {
            this.handleCameraFollowChange(prevProps.cameraFollowTripId ?? null);
        }

        // Update vehicles when debug options change
        if (prevProps.debugOptions !== this.props.debugOptions && this.props.showVehicles) {
            this.updateVehicles();
        }

        // Update cursor for pick mode
        if (prevProps.pickMode !== this.props.pickMode && this.map) {
            if (this.props.pickMode) {
                this.map.getCanvas().style.cursor = "crosshair";
            } else if (!this.state.measurement.isActive) {
                this.map.getCanvas().style.cursor = "";
            }
        }

        // Update navigation points layer
        if (prevProps.navigationStart !== this.props.navigationStart ||
            prevProps.navigationEnd !== this.props.navigationEnd ||
            prevProps.navigationWaypoints !== this.props.navigationWaypoints) {
            this.updateNavigationPointsLayer();
        }

        // Update navigation route geometry
        if (prevProps.navigationRoute !== this.props.navigationRoute) {
            this.updateNavigationRouteLayer();
        }

        // Update mapping visualization lines and GTFS stops
        // Also re-snap when stations change since line endpoints are derived from station coordinates
        if (prevProps.mappingLines !== this.props.mappingLines || prevProps.mappingGtfsStops !== this.props.mappingGtfsStops || prevProps.stations !== this.props.stations) {
            this.layerManager?.updateMappingData(this.props.mappingLines ?? [], this.props.mappingGtfsStops ?? [], this.props.stations);
        }

        // Update highlighted building
        if (prevProps.highlightedBuilding !== this.props.highlightedBuilding) {
            // Reset cached geometry when coordinates change
            this.highlightedBuildingGeometry = null;
            this.setState({ buildingHighlighted: false }, () => {
                this.updateHighlightedBuilding();
            });
        }
    }

    componentWillUnmount() {
        if (this.hashSyncTimer) clearTimeout(this.hashSyncTimer);
        this.cleanup();
    }

    private cleanup() {
        this.modelLoaderInitAborted = true;
        this.vehicleRenderer?.dispose();
        this.vehicleTracker?.dispose();

        for (const m of this.navigationMarkers) m.remove();
        this.navigationMarkers = [];

        if (this.popupRoot) {
            this.popupRoot.unmount();
            this.popupRoot = null;
        }
        this.popup?.remove();
        this.popup = null;
        this.map?.remove();
        this.map = null;
    }

    private updateRouteData() {
        this.routeGeometries = new Map(this.props.vehicleRouteGeometries);
        if (this.props.routeIdTypes) {
            this.routeTypes = this.props.routeIdTypes;
        }
        this.vehicleRenderer?.updateRouteData(this.props.routeColors, this.props.routeTypes, this.props.routeIdColors, this.routeGeometries, this.routeTypes);
    }

    private updateAllMapData() {
        if (!this.layerManager) return;

        this.layerManager.updateStations(
            this.props.stations,
            this.props.showStations,
            this.props.showSteige,
            this.props.showOutlines,
            this.props.showDebugStops,
            this.props.showDebugPlatforms,
        );
        this.layerManager.setRoutesVisible(this.props.showRoutes, this.props.visibleRouteTypes, this.props.lineOverrides);
        this.layerManager.updateMappingData(this.props.mappingLines ?? [], this.props.mappingGtfsStops ?? [], this.props.stations);
        this.setPoiVisibility(this.props.showPois);

        if (this.props.showVehicles) {
            this.startVehicleAnimation();
        }
    }

    private updateScale = () => {
        if (!this.map) return;

        const maxWidth = 100;
        const y = this.map.getContainer().clientHeight / 2;
        const left = this.map.unproject([0, y]);
        const right = this.map.unproject([maxWidth, y]);

        const maxMeters = left.distanceTo(right);
        let distance = maxMeters;
        let unit = "m";

        if (distance >= 1000) {
            distance /= 1000;
            unit = "km";
        }

        // Round to a nice number
        const roundedDistance = this.getRoundedDistance(distance);
        const ratio = roundedDistance / distance;
        const width = maxWidth * ratio;

        this.setState({
            scaleWidth: width,
            scaleLabel: `${roundedDistance} ${unit}`,
        });
    };

    private getRoundedDistance = (distance: number): number => {
        const d = Math.pow(10, Math.floor(Math.log10(distance)));
        const normalized = distance / d;
        if (normalized < 2) return d * 1;
        if (normalized < 5) return d * 2;
        return d * 5;
    };

    private handleZoomIn = () => {
        this.map?.zoomIn();
    };

    private handleZoomOut = () => {
        this.map?.zoomOut();
    };

    private handleResetBearing = () => {
        this.map?.easeTo({ bearing: 0, pitch: 0 });
    };

    private handlePinStop = (osmId: string, displayName: string, stationName?: string, refIfopt?: string | null, lat?: number, lon?: number) => {
        this.props.onPinStop?.(osmId, displayName, stationName, refIfopt, lat, lon);
        // Close the popup after pinning
        if (this.popup) {
            this.popup.remove();
            this.popup = null;
        }
    };

    private showPopup = (coordinates: [number, number], content: React.ReactNode) => {
        if (!this.map) return;

        if (this.popupRoot) {
            this.popupRoot.unmount();
            this.popupRoot = null;
        }
        if (this.popup) {
            this.popup.remove();
        }

        const container = document.createElement("div");
        container.className = "map-popup";
        this.popupRoot = createRoot(container);
        this.popupRoot.render(content);

        this.popup = new maplibregl.Popup({ closeButton: false, closeOnClick: true, maxWidth: "none" })
            .setLngLat(coordinates)
            .setDOMContent(container)
            .addTo(this.map);

        this.popup.on("close", () => {
            if (this.popupRoot) {
                this.popupRoot.unmount();
                this.popupRoot = null;
            }
        });
    };

    private parseHashParams() {
        const defaults = { lat: 48.371, lng: 10.898, zoom: 12, pitch: 30, bearing: 0 };
        const hash = window.location.hash.replace("#", "");
        if (!hash) return defaults;

        const parts = hash.split(",").map(Number);
        if (parts.length < 3 || parts.some(isNaN)) return defaults;

        return {
            lat: parts[0],
            lng: parts[1],
            zoom: parts[2],
            pitch: parts[3] ?? defaults.pitch,
            bearing: parts[4] ?? defaults.bearing,
        };
    }

    private syncHash = () => {
        if (!this.map) return;
        const center = this.map.getCenter();
        const zoom = this.map.getZoom();
        const pitch = this.map.getPitch();
        const bearing = this.map.getBearing();
        const hash = `#${center.lat.toFixed(5)},${center.lng.toFixed(5)},${zoom.toFixed(2)},${pitch.toFixed(0)},${bearing.toFixed(0)}`;
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
    };

    private syncHashDebounced = () => {
        if (this.hashSyncTimer) clearTimeout(this.hashSyncTimer);
        this.hashSyncTimer = setTimeout(this.syncHash, 300);
    };

    private async initializeMap(generation: number) {
        if (!this.mapContainer.current) return;

        // Clean up any in-progress or completed previous initialization
        this.cleanup();

        const style = await loadMapStyle();

        // Abort if a newer initialization was started (e.g. StrictMode remount)
        if (generation !== this.initGeneration) return;

        // Restore map position from URL hash (format: #lat,lng,zoom,pitch,bearing)
        const hashParams = this.parseHashParams();

        this.map = new maplibregl.Map({
            container: this.mapContainer.current,
            style,
            center: [hashParams.lng, hashParams.lat],
            zoom: hashParams.zoom,
            pitch: hashParams.pitch,
            bearing: hashParams.bearing,
            attributionControl: false,
        });

        // Expose map for E2E tests to allow querying rendered features
        if (import.meta.env.DEV) {
            (window as any).map = this.map;
        }

        this.map.on("error", (e) => {
            console.error("Map error:", e.error?.message || e);
        });

        // Update bearing, zoom, scale, and URL hash on map move
        this.map.on("move", () => {
            if (!this.map) return;
            const zoom = this.map.getZoom();
            this.setState({
                bearing: this.map.getBearing(),
                pitch: this.map.getPitch(),
                zoom,
            });
            this.vehicleRenderer?.setZoom(zoom);
            this.updateScale();
            this.syncHashDebounced();
        });

        this.map.on("load", () => {
            if (!this.map || generation !== this.initGeneration) return;

            // Enable globe projection
            this.map.setProjection({ type: "globe" });

            // Configure sky for globe - black space background
            this.map.setSky({
                "sky-color": "#000000",
                "sky-horizon-blend": 0,
                "horizon-color": "#000000",
                "horizon-fog-blend": 0,
                "fog-color": "#000000",
                "fog-ground-blend": 0,
                "atmosphere-blend": 0,
            });

            // Configure lighting for 3D features
            this.map.setLight({
                anchor: "viewport",
                color: "#ffffff",
                intensity: 0.5,
                position: [1.5, 180, 50],
            });

            // Initialize managers
            this.layerManager = new MapLayerManager(this.map, getConfig().martinUrl);
            this.layerManager.setupLayers();
            // Pre-render all bundled Maki icons. After they're registered,
            // force POI layers to re-evaluate by toggling their filter.
            this.layerManager.preloadBundledIcons().then(() => {
                if (!this.map) return;
                for (const id of ["poi-level-1", "poi-level-2", "poi-level-3"]) {
                    if (this.map.getLayer(id)) {
                        const filter = this.map.getFilter(id);
                        this.map.setFilter(id, undefined);
                        this.map.setFilter(id, filter);
                    }
                }
            });

            this.vehicleRenderer = new VehicleRenderer(this.layerManager, this.props.routeColors, this.props.routeTypes, this.props.routeIdColors, this.routeGeometries, this.routeTypes, this.modelLoader);
            this.vehicleRenderer.setZoom(this.map.getZoom());
            this.modelLoader.init().catch((error) => {
                if (!this.modelLoaderInitAborted) {
                    console.warn("[Map] Vehicle model loader init failed, using fallback models:", error);
                }
            });
            this.vehicleRenderer.setOnTrackedVehicleLost(() => {
                const tripId = this.props.trackedTripId;
                if (tripId) {
                    this.props.onTrackedVehicleLost?.(tripId);
                }
            });
            this.vehicleRenderer.setOnTrackedTripChanged((newTripId) => {
                const oldTripId = this.props.trackedTripId;
                if (oldTripId) {
                    this.props.onTrackedTripChanged?.(oldTripId, newTripId);
                }
            });

            this.vehicleTracker = new VehicleTracker(this.map, {
                onTrackingInfoUpdate: () => {}, // Panel handles tracking info now
                onTrackingStop: () => this.props.onCameraFollowStop?.(),
                getSmoothedPosition: (tripId) => this.vehicleRenderer?.getSmoothedPosition(tripId),
                getRouteColor: (lineNumber) => this.props.routeColors.get(lineNumber) ?? "#3b82f6",
            });

            // Navigation route geometry (GeoJSON source + line layer)
            this.map.addSource("navigation-route", {
                type: "geojson",
                data: { type: "FeatureCollection", features: [] },
            });
            this.map.addLayer({
                id: "navigation-route-outline",
                type: "line",
                source: "navigation-route",
                filter: ["!=", ["get", "mode"], "WALK"],
                paint: {
                    "line-color": "#000",
                    "line-width": 10,
                    "line-opacity": 0.2,
                },
                layout: { "line-cap": "round", "line-join": "round" },
            });
            this.map.addLayer({
                id: "navigation-route-line",
                type: "line",
                source: "navigation-route",
                filter: ["!=", ["get", "mode"], "WALK"],
                paint: {
                    "line-color": ["get", "color"],
                    "line-width": 6,
                    "line-opacity": 0.9,
                },
                layout: { "line-cap": "round", "line-join": "round" },
            });
            // Walk segments get dashed lines
            this.map.addLayer({
                id: "navigation-route-walk",
                type: "line",
                source: "navigation-route",
                filter: ["==", ["get", "mode"], "WALK"],
                paint: {
                    "line-color": "#3b82f6",
                    "line-width": 4,
                    "line-opacity": 0.9,
                    "line-dasharray": [1.5, 1.5],
                },
                layout: { "line-cap": "round", "line-join": "round" },
            });
            // Stop markers along the navigation route
            this.map.addLayer({
                id: "navigation-route-stops",
                type: "circle",
                source: "navigation-route",
                filter: ["==", ["geometry-type"], "Point"],
                paint: {
                    "circle-radius": 5,
                    "circle-color": "#fff",
                    "circle-stroke-color": "#333",
                    "circle-stroke-width": 2,
                },
            });
            this.map.addLayer({
                id: "navigation-route-stop-labels",
                type: "symbol",
                source: "navigation-route",
                filter: ["==", ["geometry-type"], "Point"],
                layout: {
                    "text-field": ["get", "name"],
                    "text-font": ["Open Sans Semibold"],
                    "text-size": 12,
                    "text-offset": [0, 1.2],
                    "text-anchor": "top",
                    "text-optional": true,
                    "text-allow-overlap": false,
                },
                paint: {
                    "text-color": "#333",
                    "text-halo-color": "#fff",
                    "text-halo-width": 1.5,
                },
            });

            this.setupMapEventHandlers();
            this.setState({ mapLoaded: true });
            this.updateScale();
            this.updateNavigationPointsLayer();
            this.updateNavigationRouteLayer();

            // Notify parent of viewport changes (for loading visible routes)
            // Use 'move' with throttling so stations load during panning, not just after
            let viewportThrottleTimer: ReturnType<typeof setTimeout> | null = null;
            const fireViewportChange = () => {
                if (!this.map) return;
                const bounds = this.map.getBounds();
                const zoom = Math.floor(this.map.getZoom());
                this.props.onViewportChange?.(
                    [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
                    zoom,
                );
            };
            this.map.on("move", () => {
                if (viewportThrottleTimer) return;
                fireViewportChange();
                viewportThrottleTimer = setTimeout(() => {
                    viewportThrottleTimer = null;
                }, 200);
            });
            this.map.on("moveend", () => {
                if (viewportThrottleTimer) {
                    clearTimeout(viewportThrottleTimer);
                    viewportThrottleTimer = null;
                }
                fireViewportChange();
                // Re-apply highlighted building when map moves (tiles may load)
                if (this.props.highlightedBuilding && !this.state.buildingHighlighted) {
                    this.updateHighlightedBuilding();
                }
            });

            // Fire initial viewport change
            {
                const bounds = this.map.getBounds();
                const zoom = Math.floor(this.map.getZoom());
                this.props.onViewportChange?.(
                    [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
                    zoom,
                );
            }

            // Also try on sourcedata events when new tiles load
            this.map.on("sourcedata", (e) => {
                if (e.sourceId === "openmaptiles" && e.isSourceLoaded && this.props.highlightedBuilding && !this.state.buildingHighlighted) {
                    this.updateHighlightedBuilding();
                }
            });
        });
    }

    private setupMapEventHandlers() {
        if (!this.map) return;

        // Hover cursors
        this.map.on("mouseenter", "stations-circle", () => { if (this.map) this.map.getCanvas().style.cursor = "pointer"; });
        this.map.on("mouseleave", "stations-circle", () => { if (this.map) this.map.getCanvas().style.cursor = ""; });
        this.map.on("mouseenter", "stops-circle", () => { if (this.map) this.map.getCanvas().style.cursor = "pointer"; });
        this.map.on("mouseleave", "stops-circle", () => { if (this.map) this.map.getCanvas().style.cursor = ""; });
        this.map.on("mouseenter", "platforms-circle", () => { if (this.map) this.map.getCanvas().style.cursor = "pointer"; });
        this.map.on("mouseleave", "platforms-circle", () => { if (this.map) this.map.getCanvas().style.cursor = ""; });
        this.map.on("mouseenter", "mapping-gtfs-circle", () => { if (this.map) this.map.getCanvas().style.cursor = "pointer"; });
        this.map.on("mouseleave", "mapping-gtfs-circle", () => { if (this.map) this.map.getCanvas().style.cursor = ""; });
        this.map.on("mouseenter", "vehicles-marker", () => { if (this.map) this.map.getCanvas().style.cursor = "pointer"; });
        this.map.on("mouseleave", "vehicles-marker", () => { if (this.map) this.map.getCanvas().style.cursor = ""; });

        // Station click
        // Station click — load details from API on demand
        this.map.on("click", "stations-circle", async (e) => {
            if (!e.features || e.features.length === 0) return;
            const feature = e.features[0];
            const coordinates = (feature.geometry as GeoJSON.Point).coordinates.slice() as [number, number];
            const osmId = feature.properties?.osm_id;
            const stationName = feature.properties?.name ?? "Station";

            // Try to find station in props first (for backwards compat)
            const station = this.props.stations.find((s) => s.osm_id === osmId);
            if (station) {
                const handlePlatformClick = (platform: StationPlatform | StationStopPosition) => {
                    let platformCoords: [number, number] = [platform.lon, platform.lat];
                    if (this.map) {
                        const displayName = platform.ref ?? platform.name;
                        if (displayName) {
                            const steigeFeatures = this.map.queryRenderedFeatures(undefined, { layers: ["steige-circle"] });
                            const match = steigeFeatures.find(
                                (f: { properties: Record<string, unknown> }) => f.properties?.display_name === displayName && f.properties?.station_id === osmId
                            );
                            if (match) {
                                const coords = (match.geometry as GeoJSON.Point).coordinates;
                                platformCoords = [coords[0], coords[1]];
                            }
                        }
                    }
                    this.showPopup(platformCoords, <PlatformPopup platform={platform} stationName={station.name ?? undefined} routeColors={this.props.routeColors} routeTypes={this.props.routeTypes} referenceTime={this.props.isRealTime ? undefined : this.props.simulatedTime} isPinned={this.props.pinnedStopIds?.has(String(platform.osm_id))} onPin={this.handlePinStop} onUnpin={this.props.onUnpinStop} onClose={() => this.popup?.remove()} debugMode={this.props.debugMode} />);
                };
                this.showPopup(coordinates, <StationPopup station={station} onPlatformClick={handlePlatformClick} onClose={() => this.popup?.remove()} debugMode={this.props.debugMode} />);
                return;
            }

            // Station not in props (loaded via vector tiles) — fetch from API
            try {
                const response = await getApiClient().api.getStation(Number(osmId));
                const fullStation = response.data;
                const handlePlatformClick = (platform: StationPlatform | StationStopPosition) => {
                    // Try to find the matching steige feature on the map for correct position.
                    // The steige layer uses platform_ways centroids (passenger-side) which are
                    // the correct visual position, while the API returns stop_position/platform
                    // table coordinates which may be on the track.
                    let platformCoords: [number, number] = [platform.lon, platform.lat];
                    if (this.map) {
                        const displayName = platform.ref ?? platform.name;
                        if (displayName) {
                            const steigeFeatures = this.map.queryRenderedFeatures(undefined, { layers: ["steige-circle"] });
                            const match = steigeFeatures.find(
                                (f: { properties: Record<string, unknown> }) => f.properties?.display_name === displayName && f.properties?.station_id === osmId
                            );
                            if (match) {
                                const coords = (match.geometry as GeoJSON.Point).coordinates;
                                platformCoords = [coords[0], coords[1]];
                            }
                        }
                    }
                    this.showPopup(platformCoords, <PlatformPopup platform={platform} stationName={fullStation.name ?? undefined} routeColors={this.props.routeColors} routeTypes={this.props.routeTypes} referenceTime={this.props.isRealTime ? undefined : this.props.simulatedTime} isPinned={this.props.pinnedStopIds?.has(String(platform.osm_id))} onPin={this.handlePinStop} onUnpin={this.props.onUnpinStop} onClose={() => this.popup?.remove()} debugMode={this.props.debugMode} />);
                };
                this.showPopup(coordinates, <StationPopup station={fullStation} onPlatformClick={handlePlatformClick} onClose={() => this.popup?.remove()} debugMode={this.props.debugMode} />);
            } catch (error) {
                console.error("Failed to fetch station details:", error);
                this.showPopup(coordinates, <div className="p-3 font-semibold">{stationName}</div>);
            }
        });

        // Stop position click (from vector tiles) — show departure monitor directly
        this.map.on("click", "stops-circle", (e) => {
            if (!e.features || e.features.length === 0) return;
            const feature = e.features[0];
            const coordinates = (feature.geometry as GeoJSON.Point).coordinates.slice() as [number, number];
            const osmId = feature.properties?.osm_id;
            const ref = feature.properties?.ref;
            const name = feature.properties?.name;
            const refIfopt = feature.properties?.ref_ifopt;
            const displayName = ref || name || `Stop ${osmId}`;

            // Build a synthetic platform object from tile properties
            const platform = {
                osm_id: osmId,
                name: name ?? null,
                ref: ref ?? null,
                ref_ifopt: refIfopt ?? null,
                lat: coordinates[1],
                lon: coordinates[0],
                gtfs_stop_ids: [],
            };
            const stationName = feature.properties?.station_name ?? undefined;
            this.showPopup(coordinates, <PlatformPopup platform={platform} stationName={stationName} routeColors={this.props.routeColors} routeTypes={this.props.routeTypes} referenceTime={this.props.isRealTime ? undefined : this.props.simulatedTime} isPinned={this.props.pinnedStopIds?.has(String(osmId))} onPin={this.handlePinStop} onUnpin={this.props.onUnpinStop} onClose={() => this.popup?.remove()} debugMode={this.props.debugMode} />);
        });

        // Steige click (user-facing platform markers from precalculated source-layer)
        this.map.on("click", "steige-circle", (e) => {
            if (!e.features || e.features.length === 0) return;
            const feature = e.features[0];
            const coordinates = (feature.geometry as GeoJSON.Point).coordinates.slice() as [number, number];
            // stop_osm_id is the associated stop_position's OSM ID that has a GTFS mapping.
            // platform_ways and platforms don't have GTFS mappings — only stop_positions do.
            const stopOsmId = feature.properties?.stop_osm_id ?? feature.properties?.osm_id;
            const ref = feature.properties?.platform_ref;
            const name = feature.properties?.name;
            const refIfopt = feature.properties?.ref_ifopt;
            const displayName = feature.properties?.display_name;

            const platform = {
                osm_id: stopOsmId,
                name: displayName ?? name ?? null,
                ref: ref ?? null,
                ref_ifopt: refIfopt ?? null,
                lat: coordinates[1],
                lon: coordinates[0],
                gtfs_stop_ids: [],
            };
            this.showPopup(coordinates, <PlatformPopup platform={platform} stationName={undefined} routeColors={this.props.routeColors} routeTypes={this.props.routeTypes} referenceTime={this.props.isRealTime ? undefined : this.props.simulatedTime} isPinned={this.props.pinnedStopIds?.has(String(stopOsmId))} onPin={this.handlePinStop} onUnpin={this.props.onUnpinStop} onClose={() => this.popup?.remove()} debugMode={this.props.debugMode} />);
        });
        this.map.on("mouseenter", "steige-circle", () => { if (this.map) this.map.getCanvas().style.cursor = "pointer"; });
        this.map.on("mouseleave", "steige-circle", () => { if (this.map) this.map.getCanvas().style.cursor = ""; });

        // Legacy platform click (GeoJSON, for mapping mode)
        this.map.on("click", "platforms-circle", (e) => {
            if (!e.features || e.features.length === 0) return;
            const feature = e.features[0];
            const coordinates = (feature.geometry as GeoJSON.Point).coordinates.slice() as [number, number];
            const osmId = feature.properties?.osm_id;
            const stationName = feature.properties?.station_name;
            for (const station of this.props.stations) {
                const platform = station.platforms.find((p) => p.osm_id === osmId);
                if (platform) {
                    this.showPopup(coordinates, <PlatformPopup platform={platform} stationName={stationName} routeColors={this.props.routeColors} routeTypes={this.props.routeTypes} referenceTime={this.props.isRealTime ? undefined : this.props.simulatedTime} isPinned={this.props.pinnedStopIds?.has(String(platform.osm_id))} onPin={this.handlePinStop} onUnpin={this.props.onUnpinStop} onClose={() => this.popup?.remove()} debugMode={this.props.debugMode} />);
                    return;
                }
                const stopPosition = station.stop_positions.find((s) => s.osm_id === osmId);
                if (stopPosition) {
                    this.showPopup(coordinates, <PlatformPopup platform={stopPosition} stationName={stationName} routeColors={this.props.routeColors} routeTypes={this.props.routeTypes} referenceTime={this.props.isRealTime ? undefined : this.props.simulatedTime} isPinned={this.props.pinnedStopIds?.has(String(stopPosition.osm_id))} onPin={this.handlePinStop} onUnpin={this.props.onUnpinStop} onClose={() => this.popup?.remove()} debugMode={this.props.debugMode} />);
                    return;
                }
            }
        });

        // GTFS stop click - show departures popup
        this.map.on("click", "mapping-gtfs-circle", (e) => {
            if (!e.features || e.features.length === 0) return;
            const feature = e.features[0];
            const coordinates = (feature.geometry as GeoJSON.Point).coordinates.slice() as [number, number];
            const stopId = feature.properties?.stopId ?? "";
            const stopName = feature.properties?.name ?? stopId;
            const ifopt = feature.properties?.ifopt || null;
            const isAssigned = feature.properties?.isAssigned === true || feature.properties?.isAssigned === "true";
            this.showPopup(coordinates, <GtfsStopPopup stopId={stopId} stopName={stopName} ifopt={ifopt} isAssigned={isAssigned} routeColors={this.props.routeColors} routeTypes={this.props.routeTypes} referenceTime={this.props.isRealTime ? undefined : this.props.simulatedTime} onClose={() => this.popup?.remove()} debugMode={this.props.debugMode} />);
        });

        // Place click (city/town/village labels) - show name + population
        const placeLayers = ["place-city", "place-town", "place-village"];
        for (const layer of placeLayers) {
            this.map.on("click", layer, (e) => {
                if (!e.features || e.features.length === 0) return;
                const feature = e.features[0];
                const name = feature.properties?.name ?? feature.properties?.name_en ?? "";
                const placeClass = feature.properties?.class ?? "city";
                if (!name) return;
                const coordinates = (feature.geometry as GeoJSON.Point).coordinates.slice() as [number, number];
                e.originalEvent?.stopPropagation();
                this.showPopup(coordinates, <PlacePopup name={name} placeClass={placeClass} />);
            });
            this.map.on("mouseenter", layer, () => {
                if (this.map) this.map.getCanvas().style.cursor = "pointer";
            });
            this.map.on("mouseleave", layer, () => {
                if (this.map) this.map.getCanvas().style.cursor = "";
            });
        }

        // Vehicle click - open sidebar panel
        this.map.on("click", "vehicles-marker", (e) => {
            if (!e.features || e.features.length === 0) return;
            const props = e.features[0].properties;
            if (!props) return;
            const tripId = props.tripId;
            const lineNumber = props.lineNumber ?? "";
            const destination = props.destination ?? "";
            // Find the routeId from vehicles data
            let routeId = 0;
            for (const rv of this.props.vehicles) {
                if (rv.vehicles.some((v) => v.trip_id === tripId)) {
                    routeId = rv.routeId;
                    break;
                }
            }
            const color = props.color ?? "";
            this.props.onVehicleClick?.(tripId, lineNumber, destination, routeId, color);
        });

        // Map click - handle pick mode, measurement, stop tracking, close context menu
        this.map.on("click", (e) => {
            this.setState({ contextMenu: null });

            // Handle pick mode for navigation
            if (this.props.pickMode) {
                if (this.props.pickMode === "start" && this.props.onSetNavigationStart) {
                    this.props.onSetNavigationStart(e.lngLat.lat, e.lngLat.lng);
                } else if (this.props.pickMode === "end" && this.props.onSetNavigationEnd) {
                    this.props.onSetNavigationEnd(e.lngLat.lat, e.lngLat.lng);
                }
                return;
            }

            // Handle measurement mode
            if (this.state.measurement.isActive) {
                this.handleMeasurementClick(e.lngLat.lng, e.lngLat.lat);
                return;
            }

            const features = this.map?.queryRenderedFeatures(e.point, { layers: ["vehicles-marker"] });
            if (!features || features.length === 0) {
                this.props.onVehicleDeselect?.();
            }
        });

        // Right-click context menu
        this.map.on("contextmenu", (e) => {
            e.preventDefault();
            this.setState({
                contextMenu: {
                    visible: true,
                    x: e.point.x,
                    y: e.point.y,
                    lng: e.lngLat.lng,
                    lat: e.lngLat.lat,
                },
            });
        });
    }

    private closeContextMenu = () => {
        this.setState({ contextMenu: null });
    };

    private copyCoordinates = async () => {
        const { contextMenu } = this.state;
        if (!contextMenu) return;

        const coordString = `${contextMenu.lat.toFixed(6)}, ${contextMenu.lng.toFixed(6)}`;
        try {
            await navigator.clipboard.writeText(coordString);
        } catch (err) {
            console.error("Failed to copy coordinates:", err);
        }
        this.closeContextMenu();
    };

    private setAsNavigationStart = () => {
        const { contextMenu } = this.state;
        if (!contextMenu || !this.props.onSetNavigationStart) return;

        this.props.onSetNavigationStart(contextMenu.lat, contextMenu.lng);
        this.closeContextMenu();
    };

    private setAsNavigationEnd = () => {
        const { contextMenu } = this.state;
        if (!contextMenu || !this.props.onSetNavigationEnd) return;

        this.props.onSetNavigationEnd(contextMenu.lat, contextMenu.lng);
        this.closeContextMenu();
    };

    private highlightBuildingAtPoint = () => {
        const { contextMenu } = this.state;
        if (!contextMenu || !this.props.onHighlightBuilding) return;

        this.props.onHighlightBuilding({
            lat: contextMenu.lat,
            lon: contextMenu.lng,
        });
        this.closeContextMenu();
    };

    private clearHighlightedBuilding = () => {
        if (this.props.onHighlightBuilding) {
            this.props.onHighlightBuilding(null);
        }
        this.closeContextMenu();
    };

    private startMeasurement = () => {
        const { contextMenu } = this.state;
        if (!contextMenu) return;

        this.setState({
            measurement: {
                startPoint: { lng: contextMenu.lng, lat: contextMenu.lat },
                endPoint: null,
                isActive: true,
            },
            contextMenu: null,
        }, () => {
            this.updateMeasurementLayer();
        });

        // Change cursor to crosshair
        if (this.map) {
            this.map.getCanvas().style.cursor = "crosshair";
        }
    };

    private handleMeasurementClick = (lng: number, lat: number) => {
        const { measurement } = this.state;
        if (!measurement.isActive || !measurement.startPoint) return;

        // Reset cursor
        if (this.map) {
            this.map.getCanvas().style.cursor = "";
        }

        this.setState({
            measurement: {
                ...measurement,
                endPoint: { lng, lat },
                isActive: false,
            },
        }, () => {
            this.updateMeasurementLayer();
        });
    };

    private clearMeasurement = () => {
        // Reset cursor
        if (this.map) {
            this.map.getCanvas().style.cursor = "";
        }

        this.setState({
            measurement: {
                startPoint: null,
                endPoint: null,
                isActive: false,
            },
        }, () => {
            this.updateMeasurementLayer();
        });
    };

    private calculateDistance(start: { lng: number; lat: number }, end: { lng: number; lat: number }): number {
        return haversineDistance(start.lat, start.lng, end.lat, end.lng);
    }

    private formatDistance(meters: number): string {
        if (meters < 1000) {
            return `${meters.toFixed(0)} m`;
        }
        return `${(meters / 1000).toFixed(2)} km`;
    }

    private highlightedBuildingGeometry: GeoJSON.Feature | null = null;

    private updateHighlightedBuilding() {
        if (!this.map) return;

        const { highlightedBuilding } = this.props;
        const sourceId = "highlighted-building";
        const layerId = "highlighted-building-3d";

        // If no building to highlight, clear everything
        if (!highlightedBuilding) {
            if (this.map.getLayer(layerId)) {
                this.map.removeLayer(layerId);
            }
            if (this.map.getSource(sourceId)) {
                this.map.removeSource(sourceId);
            }
            this.highlightedBuildingGeometry = null;
            return;
        }

        const lon = highlightedBuilding.lon;
        const lat = highlightedBuilding.lat;

        // If we already have the geometry cached, just ensure the layer exists
        if (this.highlightedBuildingGeometry && this.state.buildingHighlighted) {
            return;
        }

        // Check if the point is visible on screen
        const bounds = this.map.getBounds();
        if (!bounds.contains([lon, lat])) {
            return;
        }

        // Query rendered features using a small bounding box around the point
        const point = this.map.project([lon, lat]);
        const bbox: [maplibregl.PointLike, maplibregl.PointLike] = [
            [point.x - 1, point.y - 1],
            [point.x + 1, point.y + 1],
        ];

        const features = this.map.queryRenderedFeatures(bbox, {
            layers: ["building-3d"],
        });

        if (!features || features.length === 0) {
            return;
        }

        // Find the building that actually contains our point using point-in-polygon
        const building = features.find((f) => {
            const geom = f.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon;
            return this.pointInPolygon(lon, lat, geom);
        }) || features[0];

        // Extract only the single polygon containing our point (not the whole MultiPolygon)
        let singlePolygonGeometry: GeoJSON.Polygon;
        const geom = building.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon;

        if (geom.type === "MultiPolygon") {
            // Find which polygon in the MultiPolygon contains our point
            const containingPolygon = geom.coordinates.find((polygonCoords) => {
                return this.pointInRing(lon, lat, polygonCoords[0]);
            });

            if (containingPolygon) {
                singlePolygonGeometry = {
                    type: "Polygon",
                    coordinates: containingPolygon,
                };
            } else {
                // Fallback to first polygon
                singlePolygonGeometry = {
                    type: "Polygon",
                    coordinates: geom.coordinates[0],
                };
            }
        } else {
            singlePolygonGeometry = geom;
        }

        // Expand polygon slightly outward to avoid z-fighting with original building
        singlePolygonGeometry = this.expandPolygon(singlePolygonGeometry, 1.002);

        // Cache the geometry so we don't re-query
        this.highlightedBuildingGeometry = {
            type: "Feature",
            geometry: singlePolygonGeometry,
            properties: {
                render_height: building.properties?.render_height ?? 10,
                render_min_height: building.properties?.render_min_height ?? 0,
            },
        };

        // Clear existing layer/source before adding new ones
        if (this.map.getLayer(layerId)) {
            this.map.removeLayer(layerId);
        }
        if (this.map.getSource(sourceId)) {
            this.map.removeSource(sourceId);
        }

        // Add source with just this one building
        this.map.addSource(sourceId, {
            type: "geojson",
            data: {
                type: "FeatureCollection",
                features: [this.highlightedBuildingGeometry],
            },
        });

        // Add highlight layer on top
        this.map.addLayer({
            id: layerId,
            type: "fill-extrusion",
            source: sourceId,
            paint: {
                "fill-extrusion-color": highlightedBuilding.color ?? "#ff0000",
                "fill-extrusion-height": ["get", "render_height"],
                "fill-extrusion-base": ["get", "render_min_height"],
                "fill-extrusion-opacity": 1,
            },
        });

        this.setState({ buildingHighlighted: true });
    }

    // Expand polygon outward from centroid by a scale factor
    private expandPolygon(polygon: GeoJSON.Polygon, scale: number): GeoJSON.Polygon {
        const ring = polygon.coordinates[0];

        // Calculate centroid
        let cx = 0, cy = 0;
        for (const [x, y] of ring) {
            cx += x;
            cy += y;
        }
        cx /= ring.length;
        cy /= ring.length;

        // Scale each point outward from centroid
        const expandedRing = ring.map(([x, y]) => [
            cx + (x - cx) * scale,
            cy + (y - cy) * scale,
        ]);

        return {
            type: "Polygon",
            coordinates: [expandedRing],
        };
    }

    // Simple point-in-polygon check
    private pointInPolygon(x: number, y: number, geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon): boolean {
        const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;

        for (const polygon of polygons) {
            if (this.pointInRing(x, y, polygon[0])) {
                // Check if point is in any holes
                let inHole = false;
                for (let i = 1; i < polygon.length; i++) {
                    if (this.pointInRing(x, y, polygon[i])) {
                        inHole = true;
                        break;
                    }
                }
                if (!inHole) return true;
            }
        }
        return false;
    }

    private pointInRing(x: number, y: number, ring: number[][]): boolean {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1];
            const xj = ring[j][0], yj = ring[j][1];

            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    private navigationMarkers: maplibregl.Marker[] = [];

    private updateNavigationPointsLayer() {
        if (!this.map) return;

        // Remove old markers
        for (const m of this.navigationMarkers) m.remove();
        this.navigationMarkers = [];

        const { navigationStart, navigationEnd, navigationWaypoints } = this.props;

        // Build ordered list: start, intermediates, end
        const points: { location: NavigationLocation; index: number }[] = [];
        if (navigationStart) points.push({ location: navigationStart, index: 0 });
        const intermediates = (navigationWaypoints ?? []).filter((w): w is NavigationLocation => w !== null);
        for (const w of intermediates) {
            points.push({ location: w, index: points.length });
        }
        if (navigationEnd) points.push({ location: navigationEnd, index: points.length });

        for (const { location, index } of points) {
            const el = createWaypointMarkerElement(index, 22);

            const marker = new maplibregl.Marker({ element: el, anchor: "center" })
                .setLngLat([location.lon, location.lat])
                .addTo(this.map);
            this.navigationMarkers.push(marker);
        }
    }

    /** Pending navigation route update — cancelled when a new itinerary is selected */
    private navRouteAbort: AbortController | null = null;

    private updateNavigationRouteLayer() {
        if (!this.map) return;

        // Cancel any in-flight geometry fetches
        this.navRouteAbort?.abort();
        this.navRouteAbort = null;

        const source = this.map.getSource("navigation-route") as maplibregl.GeoJSONSource | undefined;
        if (!source) return;

        const itinerary = this.props.navigationRoute;
        // Dim/restore transit layers when navigation route changes
        this.setTransitLayersDimmed(!!itinerary);

        if (!itinerary) {
            source.setData({ type: "FeatureCollection", features: [] });
            return;
        }

        const abort = new AbortController();
        this.navRouteAbort = abort;

        // Build features asynchronously — fetch OSM geometry for transit legs
        this.buildNavigationFeatures(itinerary, abort.signal).then(features => {
            if (abort.signal.aborted || !this.map) return;
            source.setData({ type: "FeatureCollection", features });

            // Fit the map to show the entire route
            const lineFeatures = features.filter(f => f.geometry.type === "LineString");
            if (lineFeatures.length > 0) {
                const allCoords = lineFeatures.flatMap(f =>
                    (f.geometry as GeoJSON.LineString).coordinates,
                );
                const bounds = new maplibregl.LngLatBounds(allCoords[0] as [number, number], allCoords[0] as [number, number]);
                for (const coord of allCoords) {
                    bounds.extend(coord as [number, number]);
                }
                this.map.fitBounds(bounds, { padding: 80, duration: 500 });
            }
        }).catch(() => {/* aborted or failed — ignore */});
    }

    /** Hide transit layers and minor labels when navigation route is active */
    private setTransitLayersDimmed(dimmed: boolean) {
        if (!this.map) return;
        // Hide everything: transit routes, stations, stops, and minor labels
        const hiddenLayers = [
            "routes-line",
            "stations-circle", "stations-label",
            "steige-circle", "steige-label",
            "stops-circle", "stops-label",
            "place-village", "place-town",
            "poi-level-1", "poi-level-2", "poi-level-3",
        ];
        for (const layerId of hiddenLayers) {
            if (this.map.getLayer(layerId)) {
                this.map.setLayoutProperty(layerId, "visibility", dimmed ? "none" : "visible");
            }
        }
    }

    private resolveLegColor(leg: RouteLeg): string {
        if (leg.mode === "WALK") return "#3b82f6";
        if (leg.routeColor) {
            return leg.routeColor.startsWith("#") ? leg.routeColor : `#${leg.routeColor}`;
        }
        if (leg.routeShortName) {
            const { routeColors } = this.props;
            return (leg.agencyName ? routeColors.get(`${leg.agencyName}:${leg.routeShortName}`) : undefined)
                ?? routeColors.get(`${leg.mode?.toLowerCase()}:${leg.routeShortName}`)
                ?? routeColors.get(leg.routeShortName)
                ?? "#3b82f6";
        }
        return "#3b82f6";
    }

    private async buildNavigationFeatures(
        itinerary: RouteItinerary,
        signal: AbortSignal,
    ): Promise<GeoJSON.Feature[]> {
        // Build one feature per leg. For transit legs, fetch OSM geometry in parallel.
        // Use MOTIS polyline as fallback while/if OSM fetch fails.

        type LegEntry = {
            leg: RouteLeg;
            color: string;
            fallbackCoords: [number, number][] | null;
            osmFetch: Promise<[number, number][] | null> | null;
        };

        const entries: LegEntry[] = itinerary.legs.map(leg => {
            const color = this.resolveLegColor(leg);
            let fallbackCoords: [number, number][] | null = null;
            if (leg.legGeometry?.points) {
                const precision = leg.legGeometry.precision ?? 7;
                fallbackCoords = decodePolyline(leg.legGeometry.points, precision);
                if (fallbackCoords.length < 2) fallbackCoords = null;
            }
            const osmFetch = leg.mode !== "WALK"
                ? this.fetchOsmRouteSegment(leg, signal).catch(() => null)
                : null;
            return { leg, color, fallbackCoords, osmFetch };
        });

        // Wait for all OSM geometry fetches
        const osmResults = await Promise.all(
            entries.map(e => e.osmFetch ?? Promise.resolve(null)),
        );
        if (signal.aborted) return [];

        // Build clean GeoJSON features
        const features: GeoJSON.Feature[] = [];
        for (let i = 0; i < entries.length; i++) {
            const { leg, color, fallbackCoords } = entries[i];
            const osmCoords = osmResults[i];

            // Prefer OSM geometry, fall back to MOTIS polyline
            const coordinates = (osmCoords && osmCoords.length >= 2) ? osmCoords : fallbackCoords;
            if (!coordinates || coordinates.length < 2) continue;

            features.push({
                type: "Feature",
                properties: {
                    mode: leg.mode,
                    color,
                    line: leg.routeShortName ?? "",
                },
                geometry: { type: "LineString", coordinates },
            });
        }

        // Add stop point features for all transit stops along the route
        // (from, to, and all intermediate stops)
        const seenStops = new Set<string>();
        for (const leg of itinerary.legs) {
            if (leg.mode === "WALK") continue;
            const allStops = [leg.from, ...(leg.intermediateStops ?? []), leg.to];
            for (const stop of allStops) {
                if (stop.lat == null || stop.lon == null || !stop.name) continue;
                const key = `${stop.lat.toFixed(4)},${stop.lon.toFixed(4)}`;
                if (seenStops.has(key)) continue;
                seenStops.add(key);
                features.push({
                    type: "Feature",
                    properties: { name: stop.name },
                    geometry: { type: "Point", coordinates: [stop.lon, stop.lat] },
                });
            }
        }

        return features;
    }

    /** Cache: osm_id → chained coordinate array (LRU, max 100 entries) */
    private routeGeometryCache = new Map<number, [number, number][]>();
    private static readonly GEOMETRY_CACHE_MAX = 100;

    /**
     * Fetch OSM route geometry from our API and extract the segment
     * between the leg's start and end coordinates.
     */
    private async fetchOsmRouteSegment(
        leg: RouteLeg,
        signal: AbortSignal,
    ): Promise<[number, number][] | null> {
        const fromLat = leg.from.lat;
        const fromLon = leg.from.lon;
        const toLat = leg.to.lat;
        const toLon = leg.to.lon;
        if (fromLat == null || fromLon == null || toLat == null || toLon == null) return null;
        if (!leg.routeShortName) return null;

        // Map MOTIS mode to our route_type
        const modeToType: Record<string, string> = {
            TRAM: "tram", BUS: "bus", RAIL: "train", REGIONAL_RAIL: "train",
            SUBWAY: "subway", FERRY: "ferry",
        };
        const routeType = modeToType[leg.mode] ?? leg.mode.toLowerCase();
        const baseUrl = getApiClient().baseUrl;

        // Helper: POST to /api/routes/search
        const searchRoutes = async (body: Record<string, unknown>) => {
            const res = await fetch(`${baseUrl}/api/routes/search`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal,
            });
            if (!res.ok) return [];
            return ((await res.json()).routes ?? []) as { osm_id: number; ref?: string; operator?: string; name?: string }[];
        };

        // Step 1: Search by ref + geographic proximity (fast targeted query)
        const midLat = (fromLat + toLat) / 2;
        const midLon = (fromLon + toLon) / 2;
        let refCandidates = await searchRoutes({
            route_type: routeType,
            ref: leg.routeShortName,
            near_lat: midLat,
            near_lon: midLon,
        });

        // If geo-filter returned nothing (route_stops missing for some routes),
        // retry with ref + from/to city name to narrow down
        if (refCandidates.length === 0) {
            const cityName = (leg.from.name?.replace(/,.*$/, "").trim()) || (leg.to.name?.replace(/,.*$/, "").trim()) || "";
            if (cityName) {
                refCandidates = await searchRoutes({ route_type: routeType, ref: leg.routeShortName, name_contains: cityName });
            }
            if (refCandidates.length === 0) {
                refCandidates = await searchRoutes({ route_type: routeType, ref: leg.routeShortName });
            }
        }

        const result = await this.findBestGeometryMatch(refCandidates, fromLat, fromLon, toLat, toLon, signal);
        if (result && result.score <= 2000) return result.coords;

        // Step 2: Fallback — search by city name in route name
        const destCity = leg.to.name ? stripStationSuffix(leg.to.name) : undefined;
        const fromCity = leg.from.name ? stripStationSuffix(leg.from.name) : undefined;
        if (destCity && fromCity) {
            const candidateIds = new Set(refCandidates.map(c => c.osm_id));
            const nameRoutes = await searchRoutes({
                route_type: routeType,
                name_contains: destCity,
                near_lat: midLat,
                near_lon: midLon,
            });
            const filtered = nameRoutes.filter(r => !candidateIds.has(r.osm_id));
            const withBoth = filtered.filter(r => r.name?.includes(fromCity));
            const rest = filtered.filter(r => !r.name?.includes(fromCity));
            const sorted = [...withBoth, ...rest].slice(0, 15);
            if (sorted.length > 0) {
                const fallback = await this.findBestGeometryMatch(sorted, fromLat, fromLon, toLat, toLon, signal);
                if (fallback && fallback.score <= 2000) return fallback.coords;
            }
        }

        return null;
    }

    /** Try a list of route candidates and return the geometry segment that best covers from→to */
    private async findBestGeometryMatch(
        candidates: { osm_id: number }[],
        fromLat: number, fromLon: number, toLat: number, toLon: number,
        signal: AbortSignal,
    ): Promise<{ coords: [number, number][]; score: number } | null> {
        // Fetch all uncached geometries in parallel
        const uncached = candidates.filter(r => !this.routeGeometryCache.has(r.osm_id));
        if (uncached.length > 0) {
            const fetches = uncached.map(async (route) => {
                try {
                    const res = await fetch(
                        `${getApiClient().baseUrl}/api/routes/${route.osm_id}/geometry`,
                        { signal },
                    );
                    if (!res.ok) return;
                    const data = await res.json();
                    const segments: number[][][] = data.segments ?? [];
                    const coords = segments.flatMap(
                        seg => seg.map(([lon, lat]) => [lon, lat] as [number, number]),
                    );
                    if (this.routeGeometryCache.size >= TransitMap.GEOMETRY_CACHE_MAX) {
                        const oldest = this.routeGeometryCache.keys().next().value;
                        if (oldest !== undefined) this.routeGeometryCache.delete(oldest);
                    }
                    this.routeGeometryCache.set(route.osm_id, coords);
                } catch { /* network error — skip */ }
            });
            await Promise.all(fetches);
        }
        if (signal.aborted) return null;

        let bestCoords: [number, number][] | null = null;
        let bestScore = Infinity;

        for (const route of candidates) {
            const allCoords = this.routeGeometryCache.get(route.osm_id);
            if (!allCoords || allCoords.length < 2) continue;

            const startIdx = findClosestPointIndex(allCoords, fromLon, fromLat);
            const endIdx = findClosestPointIndex(allCoords, toLon, toLat);
            if (startIdx === endIdx) continue;

            const startDist = haversineDistance(allCoords[startIdx][1], allCoords[startIdx][0], fromLat, fromLon);
            const endDist = haversineDistance(allCoords[endIdx][1], allCoords[endIdx][0], toLat, toLon);
            const score = startDist + endDist;
            // Prefer routes where the geometry goes in the right direction
            // (startIdx < endIdx = forward direction, no reversal needed).
            // Reversed routes use the wrong track on parallel-track corridors.
            const isForward = startIdx < endIdx;
            const directionPenalty = isForward ? 0 : 50;
            const adjustedScore = score + directionPenalty;

            if (adjustedScore < bestScore) {
                bestScore = adjustedScore;
                bestCoords = isForward
                    ? allCoords.slice(startIdx, endIdx + 1)
                    : allCoords.slice(endIdx, startIdx + 1).reverse();
            }
        }

        if (!bestCoords) return null;
        return { coords: bestCoords, score: bestScore };
    }


    private updateMeasurementLayer() {
        if (!this.map) return;

        const { measurement } = this.state;
        const sourceId = "measurement-line";
        const pointsSourceId = "measurement-points";

        // Create line data
        const lineData: GeoJSON.FeatureCollection = {
            type: "FeatureCollection",
            features: [],
        };

        const pointsData: GeoJSON.FeatureCollection = {
            type: "FeatureCollection",
            features: [],
        };

        if (measurement.startPoint) {
            pointsData.features.push({
                type: "Feature",
                geometry: {
                    type: "Point",
                    coordinates: [measurement.startPoint.lng, measurement.startPoint.lat],
                },
                properties: { type: "start" },
            });

            if (measurement.endPoint) {
                pointsData.features.push({
                    type: "Feature",
                    geometry: {
                        type: "Point",
                        coordinates: [measurement.endPoint.lng, measurement.endPoint.lat],
                    },
                    properties: { type: "end" },
                });

                lineData.features.push({
                    type: "Feature",
                    geometry: {
                        type: "LineString",
                        coordinates: [
                            [measurement.startPoint.lng, measurement.startPoint.lat],
                            [measurement.endPoint.lng, measurement.endPoint.lat],
                        ],
                    },
                    properties: {},
                });
            }
        }

        // Update or create sources and layers
        const lineSource = this.map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
        const pointsSource = this.map.getSource(pointsSourceId) as maplibregl.GeoJSONSource | undefined;

        if (lineSource) {
            lineSource.setData(lineData);
        } else {
            this.map.addSource(sourceId, { type: "geojson", data: lineData });
            this.map.addLayer({
                id: "measurement-line",
                type: "line",
                source: sourceId,
                paint: {
                    "line-color": "#f97316",
                    "line-width": 3,
                    "line-dasharray": [2, 2],
                },
            });
        }

        if (pointsSource) {
            pointsSource.setData(pointsData);
        } else {
            this.map.addSource(pointsSourceId, { type: "geojson", data: pointsData });
            this.map.addLayer({
                id: "measurement-points",
                type: "circle",
                source: pointsSourceId,
                paint: {
                    "circle-radius": 6,
                    "circle-color": "#f97316",
                    "circle-stroke-color": "#ffffff",
                    "circle-stroke-width": 2,
                },
            });
        }
    }

    private setPoiVisibility(visible: boolean) {
        if (!this.map) return;
        const value = visible ? "visible" : "none";
        for (const layerId of ["poi-level-1", "poi-level-2", "poi-level-3"]) {
            if (this.map.getLayer(layerId)) {
                this.map.setLayoutProperty(layerId, "visibility", value);
            }
        }
    }

    private handleVehicleVisibilityChange() {
        if (this.props.showVehicles) {
            this.startVehicleAnimation();
        } else {
            this.vehicleRenderer?.clear();
        }
    }

    private startVehicleAnimation() {
        if (!this.vehicleRenderer) return;
        // Set the current vehicles data, simulated time, and speed before starting animation
        this.vehicleRenderer.setVehicles(this.props.vehicles);
        this.vehicleRenderer.setSimulatedTime(this.props.simulatedTime);
        this.vehicleRenderer.setTimeSpeed(this.props.timeSpeed);
        this.vehicleRenderer.startAnimation();
    }

    private updateVehicles() {
        if (!this.vehicleRenderer) return;

        this.vehicleRenderer.setTrackedTripId(this.props.trackedTripId ?? null);
        this.vehicleRenderer.setDebugOptions(this.props.debugOptions);
        this.vehicleRenderer.updatePositions(this.props.vehicles, ANIMATION_INTERVAL);
    }

    private handleCameraFollowChange(prevCameraFollowTripId: string | null) {
        const newCameraFollowTripId = this.props.cameraFollowTripId ?? null;
        if (prevCameraFollowTripId && !newCameraFollowTripId) {
            // Stopped camera follow
            this.vehicleTracker?.stopTracking();
        } else if (newCameraFollowTripId && this.vehicleTracker) {
            // Started camera follow
            this.vehicleTracker.startTracking(newCameraFollowTripId);
        }
    }

    render() {
        const { contextMenu, bearing, pitch, scaleWidth, scaleLabel, attributionExpanded } = this.state;

        return (
            <div className="relative w-full h-full bg-black">
                <div ref={this.mapContainer} className="w-full h-full" />

                {/* Custom map controls - top right */}
                <div className="absolute top-4 right-4 flex flex-col gap-1">
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={this.handleZoomIn}
                        title="Zoom in"
                        className="h-8 w-8 shadow-md bg-background"
                    >
                        <Plus className="h-4 w-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={this.handleZoomOut}
                        title="Zoom out"
                        className="h-8 w-8 shadow-md bg-background"
                    >
                        <Minus className="h-4 w-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={this.handleResetBearing}
                        title="Reset north"
                        className="h-8 w-8 shadow-md bg-background"
                    >
                        <svg
                            className="h-4 w-4"
                            viewBox="0 0 24 24"
                            style={{ transform: `rotateX(${pitch}deg) rotate(${-bearing}deg)` }}
                        >
                            {/* North triangle - red */}
                            <polygon points="12,2 8,12 16,12" fill="#ef4444" />
                            {/* South triangle - primary */}
                            <polygon points="12,22 8,12 16,12" className="fill-primary" />
                        </svg>
                    </Button>
                </div>

                {/* Scale indicator - bottom left */}
                <div className="absolute bottom-4 left-4 bg-background rounded-md px-2 py-1 shadow-md flex items-center gap-1.5">
                    <div
                        className="border-b-2 border-l-2 border-r-2 border-foreground h-2"
                        style={{ width: scaleWidth }}
                    />
                    <span className="text-[10px]">{scaleLabel}</span>
                </div>

                {/* Attribution - bottom right */}
                <div className="absolute bottom-4 right-4 flex items-stretch">
                    {attributionExpanded && (
                        <div className="bg-background rounded-l-md px-3 text-xs flex items-center gap-2 shadow-md">
                            <a
                                href="https://www.openstreetmap.org/copyright"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:underline"
                            >
                                © OpenStreetMap
                            </a>
                            <span>|</span>
                            <a
                                href="https://openmaptiles.org/"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:underline"
                            >
                                © OpenMapTiles
                            </a>
                            <span>|</span>
                            <a
                                href="https://maplibre.org/"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:underline"
                            >
                                MapLibre
                            </a>
                        </div>
                    )}
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => this.setState({ attributionExpanded: !attributionExpanded })}
                        title="Attribution"
                        className={`h-8 w-8 shadow-md bg-background ${attributionExpanded ? "rounded-l-none" : ""}`}
                    >
                        <Info className="h-4 w-4" />
                    </Button>
                </div>

                {contextMenu && (
                    <div
                        className="absolute z-50 bg-popover border rounded-md shadow-md py-1 min-w-40"
                        style={{ left: contextMenu.x, top: contextMenu.y }}
                    >
                        <button
                            className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent flex items-center gap-2"
                            onClick={this.copyCoordinates}
                        >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                            Koordinaten kopieren
                        </button>
                        <button
                            className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent flex items-center gap-2"
                            onClick={this.startMeasurement}
                        >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />
                            </svg>
                            Entfernung messen
                        </button>
                        <div className="border-t my-1" />
                        <button
                            className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent flex items-center gap-2"
                            onClick={this.setAsNavigationStart}
                        >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <circle cx="12" cy="12" r="3" />
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 2v4m0 12v4m10-10h-4M6 12H2" />
                            </svg>
                            Als Start setzen
                        </button>
                        <button
                            className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent flex items-center gap-2"
                            onClick={this.setAsNavigationEnd}
                        >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                            </svg>
                            Als Ziel setzen
                        </button>
                        <div className="px-3 py-1 text-xs text-muted-foreground border-t mt-1 pt-1 font-mono">
                            {contextMenu.lat.toFixed(6)}, {contextMenu.lng.toFixed(6)}
                        </div>
                    </div>
                )}
                {this.props.pickMode && (
                    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-popover border rounded-md shadow-md px-4 py-2 flex items-center gap-3">
                        <span className="text-sm">
                            Auf Karte klicken um Ort zu wählen
                        </span>
                        <button
                            className="text-xs text-muted-foreground hover:text-foreground"
                            onClick={this.props.onCancelPickMode}
                        >
                            Abbrechen
                        </button>
                    </div>
                )}
                {this.state.measurement.isActive && !this.props.pickMode && (
                    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-popover border rounded-md shadow-md px-4 py-2 flex items-center gap-3">
                        <span className="text-sm">Klicken um Endpunkt zu setzen</span>
                        <button
                            className="text-xs text-muted-foreground hover:text-foreground"
                            onClick={this.clearMeasurement}
                        >
                            Abbrechen
                        </button>
                    </div>
                )}
                {this.state.measurement.startPoint && this.state.measurement.endPoint && (
                    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-popover border rounded-md shadow-md px-4 py-2 flex items-center gap-3">
                        <svg className="h-4 w-4 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />
                        </svg>
                        <span className="text-sm font-medium">
                            {this.formatDistance(this.calculateDistance(this.state.measurement.startPoint, this.state.measurement.endPoint))}
                        </span>
                        <button
                            className="text-xs text-muted-foreground hover:text-foreground"
                            onClick={this.clearMeasurement}
                        >
                            Clear
                        </button>
                    </div>
                )}
            </div>
        );
    }
}
