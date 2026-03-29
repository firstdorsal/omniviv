import { Info, Minus, Plus } from "lucide-react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Station, StationPlatform, StationStopPosition } from "../../api";
import type { RouteVehicles, RouteWithGeometry } from "../../App";
import type { MappingLine, MappingGtfsStop } from "../MappingManager";
import { getConfig } from "../../config";
import { GtfsStopPopup } from "../GtfsStopPopup";
import { PlatformPopup } from "../PlatformPopup";
import { StationPopup } from "../StationPopup";
import { Button } from "../ui/button";
import { VehicleRenderer } from "../vehicles/VehicleRenderer";
import type { DebugOptions } from "../vehicles/VehicleRenderer";
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
const ANIMATION_INTERVAL = 50;

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
    routes: RouteWithGeometry[];
    vehicles: RouteVehicles[];
    showStations: boolean;
    showStopPositions: boolean;
    showPlatforms: boolean;
    showRoutes: boolean;
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
    onVehicleClick?: (tripId: string, lineNumber: string, destination: string, routeId: number) => void;
    onVehicleDeselect?: () => void;
    onCameraFollowStop?: () => void;
    onTrackedTripChanged?: (oldTripId: string, newTripId: string) => void;
    onTrackedVehicleLost?: (tripId: string) => void;
    routeColors: globalThis.Map<string, string>;
    routeTypes: globalThis.Map<string, string>;
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

export default class Map extends React.Component<MapProps, MapState> {
    private mapContainer: React.RefObject<HTMLDivElement | null>;
    private map: maplibregl.Map | null = null;
    private popup: maplibregl.Popup | null = null;
    private popupRoot: Root | null = null;

    // Managers
    private layerManager: MapLayerManager | null = null;
    private vehicleRenderer: VehicleRenderer | null = null;
    private vehicleTracker: VehicleTracker | null = null;

    // Data caches
    private routeColors = new globalThis.Map<string, string>();
    private routeTypes = new globalThis.Map<string, string>();
    private routeGeometries = new globalThis.Map<number, number[][][]>();
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
        if (prevProps.routes !== this.props.routes) {
            this.updateRouteData();
        }

        if (this.state.mapLoaded && !prevState.mapLoaded) {
            this.updateAllMapData();
        }

        if (this.state.mapLoaded && this.layerManager) {
            if (prevProps.showStations !== this.props.showStations ||
                prevProps.showStopPositions !== this.props.showStopPositions ||
                prevProps.showPlatforms !== this.props.showPlatforms ||
                prevProps.stations !== this.props.stations) {
                this.layerManager.updateStations(
                    this.props.stations,
                    this.props.showStations,
                    this.props.showStopPositions,
                    this.props.showPlatforms
                );
            }
            if (prevProps.showRoutes !== this.props.showRoutes) {
                this.layerManager.setRoutesVisible(this.props.showRoutes);
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
        const colorMap = new globalThis.Map<string, string>();
        const typeMap = new globalThis.Map<string, string>();
        const geometryMap = new globalThis.Map<number, number[][][]>();

        for (const route of this.props.routes) {
            if (route.ref && route.color) {
                colorMap.set(route.ref, route.color);
            }
            if (route.ref && route.route_type) {
                typeMap.set(route.ref, route.route_type);
            }
            if (route.geometry?.segments) {
                geometryMap.set(route.osm_id, route.geometry.segments);
            }
        }

        this.routeColors = colorMap;
        this.routeTypes = typeMap;
        this.routeGeometries = geometryMap;

        this.vehicleRenderer?.updateRouteData(colorMap, geometryMap);
    }

    private updateAllMapData() {
        if (!this.layerManager) return;

        this.layerManager.updateStations(
            this.props.stations,
            this.props.showStations,
            this.props.showStopPositions,
            this.props.showPlatforms
        );
        this.layerManager.setRoutesVisible(this.props.showRoutes);
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

            this.vehicleRenderer = new VehicleRenderer(this.layerManager, this.routeColors, this.routeGeometries);
            this.vehicleRenderer.setZoom(this.map.getZoom());
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
                getRouteColor: (lineNumber) => this.routeColors.get(lineNumber) ?? "#3b82f6",
            });

            this.setupMapEventHandlers();
            this.setState({ mapLoaded: true });
            this.updateScale();
            this.updateNavigationPointsLayer();

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
                    const platformCoords: [number, number] = [platform.lon, platform.lat];
                    this.showPopup(platformCoords, <PlatformPopup platform={platform} stationName={station.name ?? undefined} routeColors={this.props.routeColors} routeTypes={this.props.routeTypes} referenceTime={this.props.isRealTime ? undefined : this.props.simulatedTime} isPinned={this.props.pinnedStopIds?.has(String(platform.osm_id))} onPin={this.handlePinStop} onUnpin={this.props.onUnpinStop} onClose={() => this.popup?.remove()} />);
                };
                this.showPopup(coordinates, <StationPopup station={station} onPlatformClick={handlePlatformClick} onClose={() => this.popup?.remove()} />);
                return;
            }

            // Station not in props (loaded via vector tiles) — show name from tile
            this.showPopup(coordinates, <div className="p-3 font-semibold">{stationName}</div>);
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
            this.showPopup(coordinates, <PlatformPopup platform={platform} stationName={stationName} routeColors={this.props.routeColors} routeTypes={this.props.routeTypes} referenceTime={this.props.isRealTime ? undefined : this.props.simulatedTime} isPinned={this.props.pinnedStopIds?.has(String(osmId))} onPin={this.handlePinStop} onUnpin={this.props.onUnpinStop} onClose={() => this.popup?.remove()} />);
        });

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
                    this.showPopup(coordinates, <PlatformPopup platform={platform} stationName={stationName} routeColors={this.props.routeColors} routeTypes={this.props.routeTypes} referenceTime={this.props.isRealTime ? undefined : this.props.simulatedTime} isPinned={this.props.pinnedStopIds?.has(String(platform.osm_id))} onPin={this.handlePinStop} onUnpin={this.props.onUnpinStop} onClose={() => this.popup?.remove()} />);
                    return;
                }
                const stopPosition = station.stop_positions.find((s) => s.osm_id === osmId);
                if (stopPosition) {
                    this.showPopup(coordinates, <PlatformPopup platform={stopPosition} stationName={stationName} routeColors={this.props.routeColors} routeTypes={this.props.routeTypes} referenceTime={this.props.isRealTime ? undefined : this.props.simulatedTime} isPinned={this.props.pinnedStopIds?.has(String(stopPosition.osm_id))} onPin={this.handlePinStop} onUnpin={this.props.onUnpinStop} onClose={() => this.popup?.remove()} />);
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
            this.showPopup(coordinates, <GtfsStopPopup stopId={stopId} stopName={stopName} ifopt={ifopt} isAssigned={isAssigned} routeColors={this.props.routeColors} routeTypes={this.props.routeTypes} referenceTime={this.props.isRealTime ? undefined : this.props.simulatedTime} onClose={() => this.popup?.remove()} />);
        });

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
            this.props.onVehicleClick?.(tripId, lineNumber, destination, routeId);
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
        // Haversine formula
        const R = 6371000; // Earth's radius in meters
        const lat1 = (start.lat * Math.PI) / 180;
        const lat2 = (end.lat * Math.PI) / 180;
        const deltaLat = ((end.lat - start.lat) * Math.PI) / 180;
        const deltaLng = ((end.lng - start.lng) * Math.PI) / 180;

        const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return R * c;
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
            const letter = String.fromCharCode(65 + index);
            const el = document.createElement("div");
            el.className = "nav-waypoint-marker";
            el.style.cssText = "width:32px;height:32px;border-radius:50%;background:var(--background);border:2.5px solid var(--foreground);display:flex;align-items:center;justify-content:center;color:var(--foreground);font-weight:700;font-size:14px;line-height:1;box-shadow:0 1px 4px rgba(0,0,0,.3);cursor:default;user-select:none;";
            el.textContent = letter;

            const marker = new maplibregl.Marker({ element: el, anchor: "center" })
                .setLngLat([location.lon, location.lat])
                .addTo(this.map);
            this.navigationMarkers.push(marker);
        }
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
