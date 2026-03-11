/**
 * Manages MapLibre GL layers and data sources
 */

import type maplibregl from "maplibre-gl";
import type { Area, Station, StationPlatform, StationStopPosition } from "../../api";
import type { RouteWithGeometry } from "../../App";
import type { MappingLine, MappingGtfsStop } from "../MappingManager";
import { VEHICLE_ICON_SCALE } from "../vehicles/VehicleIconFactory";
import { getPlatformDisplayName } from "./mapUtils";

export class MapLayerManager {
    private map: maplibregl.Map;
    private vehicleModelsSourceAdded = false;

    constructor(map: maplibregl.Map) {
        this.map = map;
    }

    /**
     * Set up all map layers
     */
    setupLayers(): void {
        // Guard against duplicate setup (e.g. style reload, hot module reload)
        if (this.map.getSource("area-outlines")) return;

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

        // Area outlines
        this.map.addSource("area-outlines", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "area-fill", type: "fill", source: "area-outlines", paint: { "fill-color": "#3b82f6", "fill-opacity": 0.1 } });
        this.map.addLayer({ id: "area-outline", type: "line", source: "area-outlines", paint: { "line-color": "#3b82f6", "line-width": 2, "line-dasharray": [2, 2] } });
        this.map.addLayer({ id: "area-labels", type: "symbol", source: "area-outlines", layout: { "text-field": ["get", "name"], "text-font": ["Open Sans Regular"], "text-size": 14, "text-anchor": "center" }, paint: { "text-color": "#1e40af", "text-halo-color": "#ffffff", "text-halo-width": 2 } });

        // Routes
        this.map.addSource("routes", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "routes-line", type: "line", source: "routes", paint: { "line-color": ["coalesce", ["get", "color"], "#888888"], "line-width": 4, "line-opacity": 0.8 }, layout: { "line-cap": "round", "line-join": "round" } }, "3d-buildings");

        // Platform connections
        this.map.addSource("platform-connections", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "platform-connections-line", type: "line", source: "platform-connections", paint: { "line-color": "#888", "line-width": 1, "line-opacity": 0.5 } });

        // Platforms (grey circles)
        this.map.addSource("platforms", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "platforms-circle", type: "circle", source: "platforms", paint: { "circle-radius": 5, "circle-color": "#666", "circle-stroke-width": 1, "circle-stroke-color": "#ffffff" } });
        this.map.addLayer({ id: "platforms-label", type: "symbol", source: "platforms", minzoom: 16, layout: { "text-field": ["get", "name"], "text-font": ["Open Sans Regular"], "text-size": 10, "text-offset": [0, 0.9], "text-anchor": "top" }, paint: { "text-color": "#333", "text-halo-color": "#ffffff", "text-halo-width": 1.5 } });

        // Stop positions (blue squares) - additional layer
        this.map.addSource("stop-positions", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "stop-positions-marker", type: "circle", source: "stop-positions", paint: { "circle-radius": 4, "circle-color": "#3b82f6", "circle-stroke-width": 1, "circle-stroke-color": "#ffffff" } });

        // Platform elements (orange squares) - additional layer
        this.map.addSource("platform-elements", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "platform-elements-marker", type: "circle", source: "platform-elements", paint: { "circle-radius": 4, "circle-color": "#f97316", "circle-stroke-width": 1, "circle-stroke-color": "#ffffff" } });

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

        // Stations
        this.map.addSource("stations", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "stations-circle", type: "circle", source: "stations", paint: { "circle-radius": 6, "circle-color": "#525252", "circle-stroke-width": 1.5, "circle-stroke-color": "#ffffff" } });
        this.map.addLayer({ id: "stations-label", type: "symbol", source: "stations", layout: { "text-field": ["get", "name"], "text-font": ["Open Sans Regular"], "text-size": 12, "text-offset": [0, 1.5], "text-anchor": "top" }, paint: { "text-color": "#065f46", "text-halo-color": "#ffffff", "text-halo-width": 2 } });

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
        this.map.addLayer({ id: "vehicle-models-3d", type: "fill-extrusion", source: "vehicle-models", paint: { "fill-extrusion-color": ["get", "color"], "fill-extrusion-height": ["get", "height"], "fill-extrusion-base": 0.5, "fill-extrusion-opacity": 0.9 } });
        this.vehicleModelsSourceAdded = true;

        // Move vehicle models layer to render on top of 3D buildings from the base style
        this.map.moveLayer("vehicle-models-3d");

        // Vehicles
        this.map.addSource("vehicles", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "vehicles-marker", type: "symbol", source: "vehicles", layout: { "icon-image": ["get", "iconId"], "icon-size": VEHICLE_ICON_SCALE, "icon-allow-overlap": true, "icon-ignore-placement": true } });

        // Move debug segments below vehicle models but above buildings
        this.map.moveLayer("debug-segments-line", "vehicle-models-3d");

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
     * Update area outlines on the map
     */
    updateAreaOutlines(areas: Area[], show: boolean): void {
        const source = this.map.getSource("area-outlines") as maplibregl.GeoJSONSource;
        if (!source) return;

        if (!show) {
            source.setData({ type: "FeatureCollection", features: [] });
            return;
        }

        const features = areas.map((area) => ({
            type: "Feature" as const,
            properties: { name: area.name, id: area.id },
            geometry: {
                type: "Polygon" as const,
                coordinates: [[[area.west, area.south], [area.east, area.south], [area.east, area.north], [area.west, area.north], [area.west, area.south]]],
            },
        }));
        source.setData({ type: "FeatureCollection", features });
    }

    /**
     * Update stations and platforms on the map
     */
    updateStations(stations: Station[], show: boolean, showStopPositions = false, showPlatformElements = false): void {
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
            properties: { name: station.name, osm_id: station.osm_id },
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

            // Original behavior: show deduplicated platforms and stop positions
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
        connectionSource.setData({ type: "FeatureCollection", features: connectionFeatures });
        stopPositionSource.setData({ type: "FeatureCollection", features: stopPositionFeatures });
        platformElementSource.setData({ type: "FeatureCollection", features: platformElementFeatures });
    }

    /**
     * Update routes on the map
     */
    updateRoutes(routes: RouteWithGeometry[], show: boolean): void {
        const source = this.map.getSource("routes") as maplibregl.GeoJSONSource;
        if (!source) return;

        if (!show) {
            source.setData({ type: "FeatureCollection", features: [] });
            return;
        }

        const features: GeoJSON.Feature[] = [];
        for (const route of routes) {
            if (!route.geometry?.segments) continue;
            for (const segment of route.geometry.segments) {
                if (segment.length < 2) continue;
                features.push({
                    type: "Feature",
                    properties: { route_id: route.osm_id, name: route.name, ref: route.ref, color: route.color || "#888888" },
                    geometry: { type: "LineString", coordinates: segment },
                });
            }
        }
        source.setData({ type: "FeatureCollection", features });
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
     * Add an image to the map
     */
    addImage(id: string, image: ImageData): void {
        if (this.map.hasImage(id)) return;
        this.map.addImage(id, image);
    }
}
