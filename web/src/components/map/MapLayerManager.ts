/**
 * Manages MapLibre GL layers and data sources
 */

import type maplibregl from "maplibre-gl";
import type { Station, StationPlatform, StationStopPosition } from "../../api";
import { makiIcons } from "../../generated/maki-icons";
import type { MappingLine, MappingGtfsStop } from "../MappingManager";
import { categoryOverrides, resolveIconPath } from "../PinheadIcon";
import { VEHICLE_ICON_SCALE } from "../vehicles/VehicleIconFactory";
import { getPlatformDisplayName } from "./mapUtils";

const POI_ICON_SIZE = 24;

/**
 * OpenMapTiles POI class values that appear in the poi layer.
 * Each name is used as the icon-image ID in the style.
 */

export class MapLayerManager {
    private map: maplibregl.Map;
    private martinUrl: string;
    private vehicleModelsSourceAdded = false;

    constructor(map: maplibregl.Map, martinUrl: string) {
        this.map = map;
        this.martinUrl = martinUrl;
    }

    /**
     * Set up all map layers
     */
    setupLayers(): void {
        // Guard against duplicate setup (e.g. style reload, hot module reload)
        if (this.map.getSource("transit-stations")) return;

        // Set up on-demand handler for subclass names not in the Maki bundle
        this.setupPoiIconHandler();

        // 3D buildings
        this.map.addLayer({
            id: "3d-buildings",
            source: "openmaptiles",
            "source-layer": "building",
            type: "fill-extrusion",
            minzoom: 12,
            paint: {
                "fill-extrusion-color": "#aaa",
                "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 12, 0, 13, ["coalesce", ["get", "render_height"], 0]],
                "fill-extrusion-base": ["interpolate", ["linear"], ["zoom"], 12, 0, 13, ["coalesce", ["get", "render_min_height"], 0]],
                "fill-extrusion-opacity": 0.6,
            },
        });

        // Routes — vector tiles from Martin (PostGIS), platform ways excluded from geometry
        this.map.addSource("transit-routes", {
            type: "vector",
            tiles: [`${this.martinUrl}/transit_routes/{z}/{x}/{y}`],
            maxzoom: 24,
        });
        this.map.addLayer({
            id: "routes-line",
            type: "line",
            source: "transit-routes",
            "source-layer": "transit_routes",
            paint: {
                "line-color": ["coalesce", ["get", "color"], "#888888"],
                "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1, 10, 2, 14, 4],
                "line-opacity": 0.8,
            },
            layout: { "line-cap": "round", "line-join": "round" },
        }, "3d-buildings");

        // Stations + stops — vector tiles from Martin (PostGIS transit_stations function)
        this.map.addSource("transit-stations", {
            type: "vector",
            tiles: [`${this.martinUrl}/transit_stations/{z}/{x}/{y}`],
            maxzoom: 24,
        });

        // Stop positions (from vector tiles, z15+) — hidden by default, toggled via "Haltepositionen"
        this.map.addLayer({
            id: "stops-circle", type: "circle",
            source: "transit-stations", "source-layer": "stops",
            minzoom: 15,
            maxzoom: 24,
            paint: { "circle-radius": 5, "circle-color": "#3b82f6", "circle-stroke-width": 1, "circle-stroke-color": "#ffffff" },
            layout: { visibility: "none" },
        });
        this.map.addLayer({
            id: "stops-label", type: "symbol",
            source: "transit-stations", "source-layer": "stops",
            minzoom: 16,
            maxzoom: 24,
            layout: { "text-field": ["get", "display_name"], "text-font": ["Open Sans Regular"], "text-size": 10, "text-offset": [0, 0.9], "text-anchor": "top", visibility: "none" },
            paint: { "text-color": "#333", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
        });

        // Platforms from vector tiles (z15+) — orange circles, hidden by default, toggled via "Steige"
        this.map.addLayer({
            id: "platforms-vt-circle", type: "circle",
            source: "transit-stations", "source-layer": "platforms",
            minzoom: 15,
            maxzoom: 24,
            paint: { "circle-radius": 5, "circle-color": "#f97316", "circle-stroke-width": 1.5, "circle-stroke-color": "#ffffff" },
            layout: { visibility: "none" },
        });
        this.map.addLayer({
            id: "platforms-vt-label", type: "symbol",
            source: "transit-stations", "source-layer": "platforms",
            minzoom: 16,
            maxzoom: 24,
            layout: {
                "text-field": ["get", "display_name"],
                "text-font": ["Open Sans Regular"],
                "text-size": 10,
                "text-offset": [0, 0.9],
                "text-anchor": "top",
                visibility: "none",
            },
            paint: { "text-color": "#c2410c", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
        });

        // Legacy GeoJSON sources kept for mapping visualization and click handlers
        this.map.addSource("platform-connections", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "platform-connections-line", type: "line", source: "platform-connections", minzoom: 15, paint: { "line-color": "#888", "line-width": 1, "line-opacity": 0.5 } });
        this.map.addSource("platforms", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "platforms-circle", type: "circle", source: "platforms", minzoom: 15, paint: { "circle-radius": 5, "circle-color": "#666", "circle-stroke-width": 1, "circle-stroke-color": "#ffffff" }, layout: { visibility: "none" } });
        this.map.addSource("stop-positions", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "stop-positions-marker", type: "circle", source: "stop-positions", minzoom: 15, paint: { "circle-radius": 4, "circle-color": "#3b82f6", "circle-stroke-width": 1, "circle-stroke-color": "#ffffff" }, layout: { visibility: "none" } });
        this.map.addSource("platform-elements", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "platform-elements-marker", type: "circle", source: "platform-elements", minzoom: 15, paint: { "circle-radius": 4, "circle-color": "#f97316", "circle-stroke-width": 1, "circle-stroke-color": "#ffffff" }, layout: { visibility: "none" } });

        // Hide the base map's rail layer — our transit route tiles replace it
        if (this.map.getLayer("rail")) {
            this.map.setLayoutProperty("rail", "visibility", "none");
        }

        // IFOPT-GTFS mapping connection lines (sources added here, layers moved to top later)
        this.map.addSource("mapping-lines", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "mapping-lines-line", type: "line", source: "mapping-lines", paint: { "line-color": ["get", "color"], "line-width": 2, "line-opacity": 0.7, "line-dasharray": [3, 2] }, layout: { "line-cap": "round" } });

        // GTFS stops (shown during mapping mode) - bright red for debugging visibility
        this.map.addSource("mapping-gtfs-stops", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "mapping-gtfs-circle", type: "circle", source: "mapping-gtfs-stops", paint: { "circle-radius": ["case", ["==", ["get", "isAssigned"], true], 6, 5], "circle-color": "#ef4444", "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" } });
        this.map.addLayer({
            id: "mapping-gtfs-label", type: "symbol", source: "mapping-gtfs-stops", minzoom: 14,
            layout: {
                "text-field": ["concat", ["get", "name"], "\n", ["get", "stopId"]],
                "text-font": ["Open Sans Regular"], "text-size": 10, "text-offset": [0, 1.2],
                "text-anchor": "top", "text-max-width": 14, "text-allow-overlap": true,
            },
            paint: { "text-color": "#ef4444", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
        });

        // Station connections (lines from stops to stations, from vector tiles, z15+)
        // Added BEFORE labels so text remains on top. Hidden by default, toggled via "Haltepositionen".
        this.map.addLayer({
            id: "station-connections-vector-line", type: "line",
            source: "transit-stations", "source-layer": "connections",
            minzoom: 15,
            maxzoom: 24,
            paint: {
                "line-color": "#444",
                "line-width": 1,
                "line-opacity": 0.9,
                "line-dasharray": [2, 2]
            },
            layout: { visibility: "none" },
        }, "stops-circle");

        // Stations — from vector tiles, filtered by min_zoom property
        this.map.addLayer({
            id: "stations-circle", type: "circle",
            source: "transit-stations", "source-layer": "stations",
            maxzoom: 24,
            filter: ["<=", ["get", "min_zoom"], ["zoom"]],
            paint: { "circle-radius": 6, "circle-color": "#525252", "circle-stroke-width": 1.5, "circle-stroke-color": "#ffffff" },
        });
        this.map.addLayer({
            id: "stations-label", type: "symbol",
            source: "transit-stations", "source-layer": "stations",
            minzoom: 8,
            maxzoom: 24,
            filter: ["<=", ["get", "min_zoom"], ["zoom"]],
            layout: { "text-field": ["get", "name"], "text-font": ["Open Sans Regular"], "text-size": 12, "text-offset": [0, 1.5], "text-anchor": "top" },
            paint: { "text-color": "#065f46", "text-halo-color": "#ffffff", "text-halo-width": 2 },
        });

        // User-facing steige markers (precalculated platforms + stop_position fallback, z15+)
        // Toggled by the "Steige" sub-toggle in the Ebenen panel. Hidden by default.
        this.map.addLayer({
            id: "steige-circle", type: "circle",
            source: "transit-stations", "source-layer": "steige",
            minzoom: 15,
            maxzoom: 24,
            paint: { "circle-radius": 5, "circle-color": "#525252", "circle-stroke-width": 1.5, "circle-stroke-color": "#ffffff" },
            layout: { visibility: "none" },
        });
        this.map.addLayer({
            id: "steige-label", type: "symbol",
            source: "transit-stations", "source-layer": "steige",
            minzoom: 15,
            maxzoom: 24,
            layout: {
                "text-field": ["get", "display_name"],
                "text-font": ["Open Sans Regular"],
                "text-size": 11,
                "text-offset": [0, 0.9],
                "text-anchor": "top",
                "text-allow-overlap": true,
                visibility: "none",
            },
            paint: { "text-color": "#1e293b", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
        });

        // Platform outlines (physical platform way geometries, z16+)
        // Toggled by the "Umrisse" sub-sub-toggle under Steige. Hidden by default.
        this.map.addLayer({
            id: "platform-outlines-line", type: "line",
            source: "transit-stations", "source-layer": "platform_outlines",
            minzoom: 16,
            maxzoom: 24,
            paint: {
                "line-color": "#525252",
                "line-width": 3,
                "line-opacity": 0.8,
            },
            layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
        });

        // Debug: route segments visualization (ahead=green, behind=red) - added before 3D models so it renders underneath
        this.map.addSource("debug-segments", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({
            id: "debug-segments-line",
            type: "line",
            source: "debug-segments",
            paint: {
                "line-color": ["get", "color"],
                "line-width": 8,
                "line-opacity": 0.7,
            },
            layout: { "line-cap": "round", "line-join": "round" },
        });

        // Vehicle 3D models (added before markers so markers render on top)
        this.map.addSource("vehicle-models", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "vehicle-models-3d", type: "fill-extrusion", source: "vehicle-models", minzoom: 15, paint: { "fill-extrusion-color": ["get", "color"], "fill-extrusion-height": ["get", "height"], "fill-extrusion-base": 0.5, "fill-extrusion-opacity": 0.9 } });
        this.vehicleModelsSourceAdded = true;

        // Move vehicle models layer to render on top of 3D buildings from the base style
        this.map.moveLayer("vehicle-models-3d");

        // Vehicles
        this.map.addSource("vehicles", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "vehicles-marker", type: "symbol", source: "vehicles", layout: { "icon-image": ["get", "iconId"], "icon-size": VEHICLE_ICON_SCALE, "icon-allow-overlap": true, "icon-ignore-placement": true } });

        // Move debug segments below vehicle models but above buildings
        this.map.moveLayer("debug-segments-line", "vehicle-models-3d");

        // Move POI layers above 3D buildings (fill-extrusion overlaps 2D symbol layers)
        for (const poiLayer of [
            "poi-level-3", "poi-level-2", "poi-level-1",
        ]) {
            if (this.map.getLayer(poiLayer)) {
                this.map.moveLayer(poiLayer);
            }
        }

        // Move mapping layers to render on top of stations/platforms
        this.map.moveLayer("mapping-lines-line");
        this.map.moveLayer("mapping-gtfs-circle");
        this.map.moveLayer("mapping-gtfs-label");
    }

    /**
     * Check if vehicle models source has been added
     */
    isVehicleModelsSourceAdded(): boolean {
        return this.vehicleModelsSourceAdded;
    }

    /**
     * Update stations and platforms on the map
     */
    updateStations(
        stations: Station[],
        show: boolean,
        showSteige = false,
        showOutlines = false,
        showDebugStops = false,
        showDebugPlatforms = false,
    ): void {
        // Toggle vector tile layers for stations (main station dots + labels)
        for (const layerId of ["stations-circle", "stations-label"]) {
            if (this.map.getLayer(layerId)) {
                this.map.setLayoutProperty(layerId, "visibility", show ? "visible" : "none");
            }
        }
        // User-facing steige markers + connection lines to station
        for (const layerId of ["steige-circle", "steige-label", "station-connections-vector-line"]) {
            if (this.map.getLayer(layerId)) {
                this.map.setLayoutProperty(layerId, "visibility", (show && showSteige) ? "visible" : "none");
            }
        }
        // Platform outlines (sub-sub-toggle of Steige)
        if (this.map.getLayer("platform-outlines-line")) {
            this.map.setLayoutProperty("platform-outlines-line", "visibility", (show && showSteige && showOutlines) ? "visible" : "none");
        }
        // Debug: raw OSM stop positions (blue dots, controlled from debug panel)
        for (const layerId of ["stops-circle", "stops-label"]) {
            if (this.map.getLayer(layerId)) {
                this.map.setLayoutProperty(layerId, "visibility", showDebugStops ? "visible" : "none");
            }
        }
        // Debug: raw OSM platform markers (orange dots, controlled from debug panel)
        for (const layerId of ["platforms-vt-circle", "platforms-vt-label"]) {
            if (this.map.getLayer(layerId)) {
                this.map.setLayoutProperty(layerId, "visibility", showDebugPlatforms ? "visible" : "none");
            }
        }

        const stationSource = this.map.getSource("stations") as maplibregl.GeoJSONSource;
        const platformSource = this.map.getSource("platforms") as maplibregl.GeoJSONSource;
        const connectionSource = this.map.getSource("platform-connections") as maplibregl.GeoJSONSource;
        const stopPositionSource = this.map.getSource("stop-positions") as maplibregl.GeoJSONSource;
        const platformElementSource = this.map.getSource("platform-elements") as maplibregl.GeoJSONSource;
        if (!stationSource || !platformSource || !connectionSource || !stopPositionSource || !platformElementSource) return;

        if (!show) {
            stationSource.setData({ type: "FeatureCollection", features: [] });
            platformSource.setData({ type: "FeatureCollection", features: [] });
            connectionSource.setData({ type: "FeatureCollection", features: [] });
            stopPositionSource.setData({ type: "FeatureCollection", features: [] });
            platformElementSource.setData({ type: "FeatureCollection", features: [] });
            return;
        }

        const stationFeatures = stations.map((station) => ({
            type: "Feature" as const,
            properties: { name: station.name, osm_id: station.osm_id, min_zoom: (station as { min_zoom?: number }).min_zoom ?? 10 },
            geometry: { type: "Point" as const, coordinates: [station.lon, station.lat] },
        }));

        const platformFeatures: GeoJSON.Feature[] = [];
        const connectionFeatures: GeoJSON.Feature[] = [];
        const stopPositionFeatures: GeoJSON.Feature[] = [];
        const platformElementFeatures: GeoJSON.Feature[] = [];

        for (const station of stations) {
            const stationCoord: [number, number] = [station.lon, station.lat];
            const addedNames = new Set<string>();

            const addPlatformFeature = (item: StationPlatform | StationStopPosition) => {
                const coord: [number, number] = [item.lon, item.lat];
                const displayName = getPlatformDisplayName(item);
                platformFeatures.push({
                    type: "Feature",
                    properties: { name: displayName, station_name: station.name, osm_id: item.osm_id, ref_ifopt: item.ref_ifopt },
                    geometry: { type: "Point", coordinates: coord },
                });
                connectionFeatures.push({
                    type: "Feature",
                    properties: { station_id: station.osm_id },
                    geometry: { type: "LineString", coordinates: [stationCoord, coord] },
                });
            };

            // Show deduplicated platforms and stop positions at their original coordinates.
            // Platform ways (physical outlines) are available for future map rendering
            // but their centroids are not suitable as marker positions (they cluster together
            // for parallel platforms like Königsplatz A1-A4).
            for (const platform of station.platforms) {
                const name = getPlatformDisplayName(platform);
                if (!addedNames.has(name)) {
                    addedNames.add(name);
                    addPlatformFeature(platform);
                }
            }
            for (const stopPosition of station.stop_positions) {
                const name = getPlatformDisplayName(stopPosition);
                if (!addedNames.has(name)) {
                    addedNames.add(name);
                    addPlatformFeature(stopPosition);
                }
            }

            // Additional stop position markers (blue)
            if (showStopPositions) {
                for (const stopPosition of station.stop_positions) {
                    stopPositionFeatures.push({
                        type: "Feature",
                        properties: { name: getPlatformDisplayName(stopPosition), station_name: station.name, osm_id: stopPosition.osm_id },
                        geometry: { type: "Point", coordinates: [stopPosition.lon, stopPosition.lat] },
                    });
                }
            }

            // Additional platform element markers (orange)
            if (showPlatformElements) {
                for (const platform of station.platforms) {
                    platformElementFeatures.push({
                        type: "Feature",
                        properties: { name: getPlatformDisplayName(platform), station_name: station.name, osm_id: platform.osm_id },
                        geometry: { type: "Point", coordinates: [platform.lon, platform.lat] },
                    });
                }
            }
        }

        stationSource.setData({ type: "FeatureCollection", features: stationFeatures });
        platformSource.setData({ type: "FeatureCollection", features: platformFeatures });
        // Disable legacy connections as we now use vector tiles
        connectionSource.setData({ type: "FeatureCollection", features: [] });
        stopPositionSource.setData({ type: "FeatureCollection", features: stopPositionFeatures });
        platformElementSource.setData({ type: "FeatureCollection", features: platformElementFeatures });
    }

    /**
     * Toggle route layer visibility (routes served via vector tiles)
     */
    setRoutesVisible(show: boolean): void {
        if (this.map.getLayer("routes-line")) {
            this.map.setLayoutProperty("routes-line", "visibility", show ? "visible" : "none");
        }
    }

    /**
     * Update vehicle markers data
     */
    updateVehicles(features: GeoJSON.Feature[]): void {
        const source = this.map.getSource("vehicles") as maplibregl.GeoJSONSource;
        if (source) {
            source.setData({ type: "FeatureCollection", features });
        }
    }

    /**
     * Update vehicle 3D model features
     */
    updateVehicleModels(features: GeoJSON.Feature[]): void {
        const source = this.map.getSource("vehicle-models") as maplibregl.GeoJSONSource;
        if (source) {
            source.setData({ type: "FeatureCollection", features });
        }
    }

    /**
     * Update the minimum zoom level at which 3D vehicle models are rendered.
     */
    setVehicleModelsMinZoom(minZoom: number): void {
        if (this.map.getLayer("vehicle-models-3d")) {
            this.map.setLayerZoomRange("vehicle-models-3d", minZoom, 24);
        }
    }

    /**
     * Clear vehicle marker and model data
     */
    clearVehicleData(): void {
        this.updateVehicles([]);
        this.updateVehicleModels([]);
    }

    /**
     * Update debug segments visualization
     */
    updateDebugSegments(features: GeoJSON.Feature[]): void {
        const source = this.map.getSource("debug-segments") as maplibregl.GeoJSONSource;
        if (source) {
            source.setData({ type: "FeatureCollection", features });
        }
    }

    /**
     * Update IFOPT-GTFS mapping visualization: connection lines and GTFS stop markers
     */
    updateMappingData(lines: MappingLine[], gtfsStops: MappingGtfsStop[], stations: Station[]): void {
        const lineSource = this.map.getSource("mapping-lines") as maplibregl.GeoJSONSource;
        const gtfsSource = this.map.getSource("mapping-gtfs-stops") as maplibregl.GeoJSONSource;
        if (!lineSource || !gtfsSource) return;

        if (lines.length === 0 && gtfsStops.length === 0) {
            lineSource.setData({ type: "FeatureCollection", features: [] });
            gtfsSource.setData({ type: "FeatureCollection", features: [] });
            return;
        }

        // Build IFOPT → coordinates lookup from station data, using the same
        // deduplication logic as updateStations (platforms preferred, deduplicated
        // by display name) so that line endpoints match the visible markers exactly.
        const ifoptCoords = new Map<string, { lat: number; lon: number }>();
        for (const station of stations) {
            const addedNames = new Set<string>();
            for (const platform of station.platforms) {
                const name = getPlatformDisplayName(platform);
                if (platform.ref_ifopt && !addedNames.has(name)) {
                    addedNames.add(name);
                    if (!ifoptCoords.has(platform.ref_ifopt)) {
                        ifoptCoords.set(platform.ref_ifopt, { lat: platform.lat, lon: platform.lon });
                    }
                }
            }
            for (const sp of station.stop_positions) {
                const name = getPlatformDisplayName(sp);
                if (sp.ref_ifopt && !addedNames.has(name)) {
                    addedNames.add(name);
                    if (!ifoptCoords.has(sp.ref_ifopt)) {
                        ifoptCoords.set(sp.ref_ifopt, { lat: sp.lat, lon: sp.lon });
                    }
                }
            }
        }

        // Build line features, snapping OSM endpoints to actual platform coordinates.
        // Lines whose IFOPT has no visible platform marker are omitted.
        const lineFeatures: GeoJSON.Feature[] = lines
            .filter((line) => ifoptCoords.has(line.ifopt))
            .map((line) => {
                const osm = ifoptCoords.get(line.ifopt)!;
                return {
                    type: "Feature" as const,
                    properties: {
                        ifopt: line.ifopt,
                        isManual: line.isManual,
                        color: line.isManual ? "#22c55e" : "#8b5cf6", // green for manual, purple for auto
                    },
                    geometry: {
                        type: "LineString" as const,
                        coordinates: [
                            [osm.lon, osm.lat],
                            [line.gtfsLon, line.gtfsLat],
                        ],
                    },
                };
            });

        // Build GTFS stop point features from the dedicated stops array
        const gtfsFeatures: GeoJSON.Feature[] = gtfsStops.map((stop) => ({
            type: "Feature",
            properties: {
                stopId: stop.stopId,
                name: stop.stopName ?? stop.stopId,
                isAssigned: stop.isAssigned,
                osmName: stop.osmName ?? "",
                ifopt: stop.ifopt ?? "",
            },
            geometry: {
                type: "Point",
                coordinates: [stop.lon, stop.lat],
            },
        }));

        lineSource.setData({ type: "FeatureCollection", features: lineFeatures });
        gtfsSource.setData({ type: "FeatureCollection", features: gtfsFeatures });
    }

    /**
     * Render an SVG string to an ImageData with white circle background.
     */
    private renderPoiIcon(svgText: string): Promise<ImageData> {
        const dpr = window.devicePixelRatio || 1;
        const renderSize = Math.round(POI_ICON_SIZE * dpr);
        const blob = new Blob([svgText], { type: "image/svg+xml" });
        const blobUrl = URL.createObjectURL(blob);

        return new Promise((resolve, reject) => {
            const img = new Image(renderSize, renderSize);
            img.onload = () => {
                URL.revokeObjectURL(blobUrl);
                const canvas = document.createElement("canvas");
                canvas.width = renderSize;
                canvas.height = renderSize;
                const ctx = canvas.getContext("2d")!;

                // White circle background
                const center = renderSize / 2;
                const radius = renderSize / 2 - dpr;
                ctx.beginPath();
                ctx.arc(center, center, radius, 0, Math.PI * 2);
                ctx.fillStyle = "#ffffff";
                ctx.fill();
                ctx.strokeStyle = "#cccccc";
                ctx.lineWidth = dpr;
                ctx.stroke();

                // Draw SVG icon centered with padding
                const padding = Math.round(5 * dpr);
                const iconArea = renderSize - padding * 2;
                ctx.drawImage(img, padding, padding, iconArea, iconArea);
                resolve(ctx.getImageData(0, 0, renderSize, renderSize));
            };
            img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(); };
            img.src = blobUrl;
        });
    }

    /**
     * Set up on-demand POI icon loading via styleimagemissing.
     * Icons are resolved from the bundled Maki SVGs (zero network requests)
     * via resolveIconPath + PinheadIcon's category overrides, ensuring the
     * same icons appear on the map and in route planning.
     */
    setupPoiIconHandler(): void {
        const dpr = window.devicePixelRatio || 1;
        const loading = new Set<string>();

        this.map.on("styleimagemissing", (e: { id: string }) => {
            const id = e.id;
            if (loading.has(id) || this.map.hasImage(id)) return;
            loading.add(id);

            // Resolve the icon path to find which Maki icon to use
            const path = resolveIconPath(id);
            const match = path.match(/\/icons\/maki\/(.+)\.svg$/);
            const makiName = match?.[1];
            const svgText = makiName ? makiIcons[makiName] : undefined;

            if (!svgText) return; // No bundled icon available

            this.renderPoiIcon(svgText)
                .then((imageData) => {
                    if (!this.map.hasImage(id)) {
                        this.map.addImage(id, imageData, { pixelRatio: dpr });
                    }
                })
                .catch(() => { /* render failed */ });
        });
    }

    /**
     * Pre-render all bundled Maki icons so they're available before tiles parse.
     * SVG data is already in memory (bundled at build time), so no network requests.
     * Returns a promise that resolves when all icons are registered.
     */
    preloadBundledIcons(): Promise<void> {
        const dpr = window.devicePixelRatio || 1;

        // Render each unique Maki SVG once and cache the ImageData
        const renderCache = new Map<string, Promise<ImageData>>();
        for (const [makiName, svgText] of Object.entries(makiIcons)) {
            renderCache.set(makiName, this.renderPoiIcon(svgText));
        }

        // Build a list of all (id, makiName) pairs to register.
        // Each Maki icon is registered under its own name.
        const registrations: { id: string; makiName: string }[] = [];
        for (const makiName of Object.keys(makiIcons)) {
            registrations.push({ id: makiName, makiName });
        }
        // Category overrides map alias names (e.g. "tram_stop") to Maki icons
        // (e.g. "maki/rail-light" → makiName "rail-light"). Register these too.
        for (const [alias, target] of Object.entries(categoryOverrides)) {
            const match = target.match(/^maki\/(.+)$/);
            if (match && makiIcons[match[1]]) {
                registrations.push({ id: alias, makiName: match[1] });
            }
        }

        return Promise.all(
            registrations.map(async ({ id, makiName }) => {
                try {
                    const imageData = await renderCache.get(makiName)!;
                    if (!this.map.hasImage(id)) {
                        this.map.addImage(id, imageData, { pixelRatio: dpr });
                    }
                } catch { /* render failed */ }
            })
        ).then(() => {});
    }

    /**
     * Add an image to the map
     */
    addImage(id: string, image: ImageData): void {
        if (this.map.hasImage(id)) return;
        this.map.addImage(id, image);
    }
}
