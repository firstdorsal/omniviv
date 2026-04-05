/**
 * Handles vehicle position animation, marker rendering, and 3D model visualization
 */

import type { RouteVehicles } from "../../App";
import type { MapLayerManager } from "../map/MapLayerManager";
import { createVehicleIcon } from "./VehicleIconFactory";
import type { SegmentDistances, VehicleModelLoader } from "./VehicleModelLoader";
import {
    ANIMATION_INTERVAL,
    FALLBACK_VEHICLE_MODEL,
    METERS_PER_DEGREE_AT_EQUATOR,
    MIN_SEGMENT_RENDER_LENGTH,
    calculateSegmentDistances,
    type VehicleModel,
} from "./vehicleModels";
import {
    calculateVehiclePosition,
    createSmoothedPosition,
    findPositionOnRoute,
    getDebugSegmentFeatures,
    getPositionsBehindOnRoute,
    linearizeRoute,
    updateSmoothedPosition,
    type LinearizedRoute,
    type SmoothedVehiclePosition,
    type VehiclePosition,
} from "./vehicleUtils";
import { featureManager, type VehicleRenderContext, type RenderPosition } from "./features";

export { ANIMATION_INTERVAL };

export interface DebugOptions {
    show3DModels: boolean;
    showDebugSegments: boolean;
    showDebugOnlyTracked: boolean;
}

export class VehicleRenderer {
    private layerManager: MapLayerManager;
    private routeColors: globalThis.Map<string, string>;
    private routeGeometries: globalThis.Map<number, number[][][]>;
    private routeTypes: globalThis.Map<number, string>;
    private linearizedRoutes = new globalThis.Map<number, LinearizedRoute>();
    private smoothedPositions = new globalThis.Map<string, SmoothedVehiclePosition>();
    private vehicleIcons = new Set<string>();
    private animationId: number | null = null;
    private lastAnimationTime = 0;

    private modelLoader: VehicleModelLoader;

    /** Fallback segment distances used before the loader is ready. */
    private fallbackSegmentDistances = calculateSegmentDistances(FALLBACK_VEHICLE_MODEL);

    private currentVehicles: RouteVehicles[] = [];
    private simulatedTime: Date = new Date();

    private onTrackedVehicleLost?: () => void;
    private trackedTripId: string | null = null;
    private debugOptions: DebugOptions = { show3DModels: true, showDebugSegments: false, showDebugOnlyTracked: true };

    constructor(
        layerManager: MapLayerManager,
        routeColors: globalThis.Map<string, string>,
        routeGeometries: globalThis.Map<number, number[][][]>,
        routeTypes: globalThis.Map<number, string>,
        modelLoader: VehicleModelLoader,
    ) {
        this.layerManager = layerManager;
        this.routeColors = routeColors;
        this.routeGeometries = routeGeometries;
        this.routeTypes = routeTypes;
        this.modelLoader = modelLoader;
        this.buildLinearizedRoutes();
    }

    private buildLinearizedRoutes(): void {
        this.linearizedRoutes.clear();
        for (const [routeId, geometry] of this.routeGeometries) {
            const linearized = linearizeRoute(geometry);
            if (linearized) {
                this.linearizedRoutes.set(routeId, linearized);
            }
        }
    }

    updateRouteData(
        routeColors: globalThis.Map<string, string>,
        routeGeometries: globalThis.Map<number, number[][][]>,
        routeTypes: globalThis.Map<number, string>,
    ): void {
        this.routeColors = routeColors;
        this.routeGeometries = routeGeometries;
        this.routeTypes = routeTypes;
        this.buildLinearizedRoutes();
    }

    setOnTrackedVehicleLost(callback: () => void): void {
        this.onTrackedVehicleLost = callback;
    }

    setTrackedTripId(tripId: string | null): void {
        this.trackedTripId = tripId;
    }

    setDebugOptions(options: DebugOptions): void {
        this.debugOptions = options;
    }

    getSmoothedPosition(tripId: string): SmoothedVehiclePosition | undefined {
        return this.smoothedPositions.get(tripId);
    }

    setVehicles(vehicles: RouteVehicles[]): void {
        this.currentVehicles = vehicles;
    }

    setSimulatedTime(time: Date): void {
        this.simulatedTime = time;
    }

    startAnimation(): void {
        if (this.animationId) return;

        this.updatePositions(this.currentVehicles, ANIMATION_INTERVAL);

        const animate = (timestamp: number) => {
            const deltaMs = this.lastAnimationTime > 0 ? timestamp - this.lastAnimationTime : ANIMATION_INTERVAL;
            if (deltaMs >= ANIMATION_INTERVAL) {
                this.lastAnimationTime = timestamp;
                // Use this.currentVehicles so animation always uses latest data
                this.updatePositions(this.currentVehicles, deltaMs);
            }
            this.animationId = requestAnimationFrame(animate);
        };

        this.animationId = requestAnimationFrame(animate);
    }

    stopAnimation(): void {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        this.lastAnimationTime = 0;
    }

    clear(): void {
        this.stopAnimation();
        this.layerManager.clearVehicleData();
        this.layerManager.updateDebugSegments([]);
        this.smoothedPositions.clear();
    }

    /** Resolve the VehicleModel for a given route based on its route type. */
    private resolveModel(routeId: number): VehicleModel {
        if (this.modelLoader.ready) {
            const routeType = this.routeTypes.get(routeId);
            if (routeType) {
                return this.modelLoader.getDefaultModel(routeType);
            }
        }
        return FALLBACK_VEHICLE_MODEL;
    }

    private resolveSegmentDistances(model: VehicleModel): SegmentDistances {
        if (this.modelLoader.ready) {
            return this.modelLoader.getSegmentDistances(model);
        }
        if (model.id === FALLBACK_VEHICLE_MODEL.id) {
            return this.fallbackSegmentDistances;
        }
        return calculateSegmentDistances(model);
    }

    updatePositions(vehicles: RouteVehicles[], deltaMs: number): void {
        const now = this.simulatedTime;
        const vehiclesByTripId = new globalThis.Map<string, { vehicle: RouteVehicles["vehicles"][0]; routeId: number; stopCount: number }>();

        for (const routeVehicles of vehicles) {
            for (const vehicle of routeVehicles.vehicles) {
                const existing = vehiclesByTripId.get(vehicle.trip_id);
                if (!existing || vehicle.stops.length > existing.stopCount) {
                    vehiclesByTripId.set(vehicle.trip_id, { vehicle, routeId: routeVehicles.routeId, stopCount: vehicle.stops.length });
                }
            }
        }

        const allPositions: { position: VehiclePosition; routeId: number; routeColor: string }[] = [];
        const completingAtLocation = new Set<string>();

        for (const { vehicle, routeId } of vehiclesByTripId.values()) {
            const routeGeometry = this.routeGeometries.get(routeId);
            const routeColor = this.routeColors.get(vehicle.line_number ?? "") ?? "#3b82f6";
            const targetPosition = calculateVehiclePosition(vehicle, routeGeometry ?? [], now);

            if (targetPosition && targetPosition.status !== "completed") {
                allPositions.push({ position: targetPosition, routeId, routeColor });
                const lastStop = vehicle.stops[vehicle.stops.length - 1];
                const isOnFinalSegment = targetPosition.nextStop?.stop_ifopt === lastStop?.stop_ifopt;
                if (isOnFinalSegment && targetPosition.progress > 0.5 && lastStop?.stop_ifopt) {
                    completingAtLocation.add(`${targetPosition.lineNumber}:${lastStop.stop_ifopt}`);
                }
            }
        }

        const markerFeatures: GeoJSON.Feature[] = [];
        const modelFeatures: GeoJSON.Feature[] = [];
        const debugFeatures: GeoJSON.Feature[] = [];
        const activeTripIds = new Set<string>();

        for (const { position: targetPosition, routeId, routeColor } of allPositions) {
            if (targetPosition.status === "waiting") {
                const vehicle = vehiclesByTripId.get(targetPosition.tripId)?.vehicle;
                const firstStop = vehicle?.stops[0];
                const locationKey = `${targetPosition.lineNumber}:${firstStop?.stop_ifopt}`;
                if (!completingAtLocation.has(locationKey)) continue;
            }

            activeTripIds.add(targetPosition.tripId);

            let smoothedPosition = this.smoothedPositions.get(targetPosition.tripId);
            if (smoothedPosition) {
                smoothedPosition = updateSmoothedPosition(smoothedPosition, targetPosition, deltaMs);
            } else {
                smoothedPosition = createSmoothedPosition(targetPosition);
            }
            this.smoothedPositions.set(targetPosition.tripId, smoothedPosition);
        }

        // Collect vehicle context for feature processing
        const vehicleContexts: VehicleRenderContext[] = [];
        for (const { position: targetPosition, routeId } of allPositions) {
            if (!activeTripIds.has(targetPosition.tripId)) continue;

            const smoothedPosition = this.smoothedPositions.get(targetPosition.tripId);
            if (!smoothedPosition) continue;

            const linearizedRoute = this.linearizedRoutes.get(routeId);
            if (!linearizedRoute) continue;

            const routePosition = findPositionOnRoute(
                linearizedRoute,
                smoothedPosition.renderedLon,
                smoothedPosition.renderedLat
            );

            vehicleContexts.push({
                tripId: targetPosition.tripId,
                routeId,
                linearPosition: routePosition.linearPosition,
                smoothedPosition,
            });
        }

        const renderPositions = this.processRenderPositions(vehicleContexts);

        for (const { position: targetPosition, routeId, routeColor } of allPositions) {
            if (!activeTripIds.has(targetPosition.tripId)) continue;

            const smoothedPosition = this.smoothedPositions.get(targetPosition.tripId);
            if (!smoothedPosition) continue;

            const renderPos = renderPositions.get(targetPosition.tripId) ?? {
                lon: smoothedPosition.renderedLon,
                lat: smoothedPosition.renderedLat,
                bearing: smoothedPosition.renderedBearing,
            };

            const lineNumber = smoothedPosition.lineNumber ?? "?";
            const iconId = `vehicle-${routeColor.replace("#", "")}-${lineNumber}`;

            if (!this.vehicleIcons.has(iconId)) {
                this.layerManager.addImage(iconId, createVehicleIcon(routeColor, lineNumber));
                this.vehicleIcons.add(iconId);
            }

            markerFeatures.push({
                type: "Feature",
                properties: {
                    tripId: smoothedPosition.tripId,
                    lineNumber: smoothedPosition.lineNumber,
                    destination: smoothedPosition.destination,
                    status: smoothedPosition.status,
                    delayMinutes: smoothedPosition.delayMinutes,
                    bearing: renderPos.bearing,
                    color: routeColor,
                    iconId,
                    currentStopName: smoothedPosition.currentStop?.stop_name ?? null,
                    nextStopName: smoothedPosition.nextStop?.stop_name ?? null,
                },
                geometry: { type: "Point", coordinates: [renderPos.lon, renderPos.lat] },
            });

            const vehicleModel = this.resolveModel(routeId);
            const segmentDistances = this.resolveSegmentDistances(vehicleModel);

            const linearizedRoute = this.linearizedRoutes.get(routeId);
            const isTracked = targetPosition.tripId === this.trackedTripId;

            const showDebugForThis = this.debugOptions.showDebugSegments &&
                (!this.debugOptions.showDebugOnlyTracked || isTracked);

            if (this.debugOptions.show3DModels || showDebugForThis) {
                const { modelFeatures: segmentFeatures, debugFeatures: segDebugFeatures } = this.generateModelFeatures(
                    smoothedPosition,
                    renderPos,
                    linearizedRoute,
                    routeColor,
                    vehicleModel,
                    segmentDistances,
                    showDebugForThis
                );
                if (this.debugOptions.show3DModels) {
                    modelFeatures.push(...segmentFeatures);
                }
                if (showDebugForThis) {
                    debugFeatures.push(...segDebugFeatures);
                }
            }
        }

        for (const tripId of this.smoothedPositions.keys()) {
            if (!activeTripIds.has(tripId)) {
                this.smoothedPositions.delete(tripId);
            }
        }

        if (this.trackedTripId && !this.smoothedPositions.has(this.trackedTripId)) {
            this.onTrackedVehicleLost?.();
        }

        this.layerManager.updateVehicles(markerFeatures);
        this.layerManager.updateVehicleModels(modelFeatures);
        this.layerManager.updateDebugSegments(debugFeatures);
    }

    private generateModelFeatures(
        smoothedPosition: SmoothedVehiclePosition,
        renderPos: { lon: number; lat: number; bearing: number },
        linearizedRoute: LinearizedRoute | undefined,
        routeColor: string,
        vehicleModel: VehicleModel,
        segmentDistances: SegmentDistances,
        showDebug = false
    ): { modelFeatures: GeoJSON.Feature[]; debugFeatures: GeoJSON.Feature[] } {
        const modelFeatures: GeoJSON.Feature[] = [];
        const debugFeatures: GeoJSON.Feature[] = [];

        if (!linearizedRoute) {
            return { modelFeatures: [], debugFeatures: [] };
        }

        const routePosition = findPositionOnRoute(
            linearizedRoute,
            renderPos.lon,
            renderPos.lat
        );
        const linearPosition = routePosition.linearPosition;

        const allDistances: number[] = [];
        for (const segInfo of segmentDistances) {
            allDistances.push(segInfo.frontDistance, segInfo.rearDistance);
        }

        const positions = getPositionsBehindOnRoute(linearizedRoute, linearPosition, allDistances);

        for (let i = 0; i < segmentDistances.length; i++) {
            const segInfo = segmentDistances[i];
            const frontPos = positions[i * 2];
            const rearPos = positions[i * 2 + 1];

            const segWidth = segInfo.segment.width ?? vehicleModel.width;
            const polygon = this.createSegmentPolygon(
                frontPos.lon, frontPos.lat,
                rearPos.lon, rearPos.lat,
                segWidth
            );

            if (polygon.length > 0) {
                modelFeatures.push({
                    type: "Feature",
                    properties: {
                        color: routeColor,
                        tripId: smoothedPosition.tripId,
                        carIndex: segInfo.index,
                        height: segInfo.segment.height,
                    },
                    geometry: { type: "Polygon", coordinates: [polygon] },
                });
            }
        }

        if (showDebug) {
            const segDebug = getDebugSegmentFeatures(linearizedRoute, routePosition.segmentIndex, 5, 5);
            debugFeatures.push(...segDebug);
        }

        return { modelFeatures, debugFeatures };
    }

    private createSegmentPolygon(
        frontLon: number,
        frontLat: number,
        rearLon: number,
        rearLat: number,
        width: number
    ): number[][] {
        const metersPerDegreeLat = METERS_PER_DEGREE_AT_EQUATOR;
        const metersPerDegreeLon = METERS_PER_DEGREE_AT_EQUATOR * Math.cos((frontLat * Math.PI) / 180);
        const dx = (frontLon - rearLon) * metersPerDegreeLon;
        const dy = (frontLat - rearLat) * metersPerDegreeLat;
        const length = Math.sqrt(dx * dx + dy * dy);
        if (length < MIN_SEGMENT_RENDER_LENGTH) return [];

        const dirX = dx / length;
        const dirY = dy / length;
        const perpX = dirY;
        const perpY = -dirX;
        const halfWidth = width / 2;

        const corners = [
            [frontLon + (perpX * halfWidth) / metersPerDegreeLon, frontLat + (perpY * halfWidth) / metersPerDegreeLat],
            [frontLon - (perpX * halfWidth) / metersPerDegreeLon, frontLat - (perpY * halfWidth) / metersPerDegreeLat],
            [rearLon - (perpX * halfWidth) / metersPerDegreeLon, rearLat - (perpY * halfWidth) / metersPerDegreeLat],
            [rearLon + (perpX * halfWidth) / metersPerDegreeLon, rearLat + (perpY * halfWidth) / metersPerDegreeLat],
        ];
        corners.push(corners[0]);
        return corners;
    }

    private processRenderPositions(vehicleContexts: VehicleRenderContext[]): globalThis.Map<string, RenderPosition> {
        const renderPositions = new globalThis.Map<string, RenderPosition>();

        if (vehicleContexts.length === 0) return renderPositions;

        for (const vehicle of vehicleContexts) {
            renderPositions.set(vehicle.tripId, {
                lon: vehicle.smoothedPosition.renderedLon,
                lat: vehicle.smoothedPosition.renderedLat,
                bearing: vehicle.smoothedPosition.renderedBearing,
            });
        }

        featureManager.processRenderPositions(vehicleContexts, renderPositions, this.linearizedRoutes);

        return renderPositions;
    }

    dispose(): void {
        this.stopAnimation();
        this.vehicleIcons.clear();
        this.smoothedPositions.clear();
        this.linearizedRoutes.clear();
    }
}
