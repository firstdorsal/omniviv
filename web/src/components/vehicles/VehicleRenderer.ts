/**
 * Handles vehicle position animation, marker rendering, and 3D model visualization
 */

import type { RouteVehicles } from "../../App";
import type { MapLayerManager } from "../map/MapLayerManager";
import { createVehicleIcon } from "./VehicleIconFactory";
import type { SegmentDistances, VehicleModelLoader } from "./VehicleModelLoader";
import { ANIMATION_INTERVAL, FALLBACK_VEHICLE_MODEL, METERS_PER_DEGREE_AT_EQUATOR, MIN_SEGMENT_RENDER_LENGTH, calculateSegmentDistances, type VehicleModel } from "./vehicleModels";
import {
    calculateVehiclePosition,
    createSmoothedPosition,
    findPositionOnRoute,
    getDebugSegmentFeatures,
    getPositionAtDistance,
    getPositionsBehindOnRoute,
    linearizeRoute,
    updateSmoothedPosition,
    type LinearizedRoute,
    type SmoothedVehiclePosition,
    type VehiclePosition
} from "./vehicleUtils";
import { VehicleLifecycleMonitor, installMonitorGlobal, type VehicleSnapshot } from "./VehicleLifecycleMonitor";
import {
    featureManager,
    COLLISION_AVOIDANCE_FEATURE_ID,
    type VehicleRenderContext,
    type RenderPosition as FeatureRenderPosition,
} from "./features";
import { computePositionCaps } from "./features/collisionAvoidance";

export { ANIMATION_INTERVAL };

/** How long to retain a smoothed position after a vehicle disappears from data (ms).
 *  Prevents teleporting when vehicles flicker in/out due to GTFS-RT update timing. */
const SMOOTHED_POSITION_GRACE_MS = 10_000;

/** 3D vehicle models are hidden below this zoom level (must match MapLayerManager minzoom). */
const MODEL_3D_MIN_ZOOM = 15;

export interface DebugOptions {
    show3DModels: boolean;
    /** Minimum zoom level at which 3D vehicle models are shown (0 = always). */
    model3DMinZoom: number;
    showDebugSegments: boolean;
    showDebugOnlyTracked: boolean;
}

// RenderPosition is imported from features as FeatureRenderPosition
type RenderPosition = FeatureRenderPosition;

export class VehicleRenderer {
    private layerManager: MapLayerManager;
    private routeColors: globalThis.Map<string, string>;
    private routeTypes: globalThis.Map<string, string>;
    private routeTypesById: globalThis.Map<number, string>;
    private modelLoader: VehicleModelLoader;
    private fallbackSegmentDistances = calculateSegmentDistances(FALLBACK_VEHICLE_MODEL);
    /** Map of routeId (OSM) → color from visible routes response — most specific lookup */
    private routeIdColors: globalThis.Map<number, string>;
    private routeGeometries: globalThis.Map<number, number[][][]>;
    private linearizedRoutes = new globalThis.Map<number, LinearizedRoute>();
    private smoothedPositions = new globalThis.Map<string, SmoothedVehiclePosition>();
    /** Timestamp (performance.now) when each vehicle was last seen in active data.
     *  Smoothed positions are kept for SMOOTHED_POSITION_GRACE_MS after disappearing
     *  so vehicles that flicker in/out don't teleport on re-entry. */
    private vehicleLastSeen = new globalThis.Map<string, number>();
    private vehicleIcons = new Set<string>();
    private animationId: number | null = null;
    private lastAnimationTime = 0;

    // Current vehicles data - updated via setVehicles() so animation loop uses latest data
    private currentVehicles: RouteVehicles[] = [];

    // Cached target positions - recalculated every frame
    private cachedTargets: { position: VehiclePosition; routeId: number; routeColor: string }[] =
        [];
    private cachedActiveTripIds = new Set<string>();

    // Time interpolation: React timer provides authoritative time every ~50ms.
    // Between updates, we interpolate linearly using the known time speed.
    // This avoids discrete sub-pixel jumps that cause visible pixel-level teleporting.
    private simulatedTime: Date = new Date();
    private lastAuthoritativeSimTime = 0; // ms since epoch, from last setSimulatedTime
    private lastAuthoritativeRealTime = 0; // performance.now() ms, when last setSimulatedTime was called
    // Time speed from the simulation controller (1.0 = real-time, 10.0 = 10x).
    // Set explicitly via setTimeSpeed() - NOT computed from call timing, which is noisy
    // due to variable React render delays.
    private timeSpeed = 1.0;
    private currentZoom = 12;

    /** Counter for target recalculations - exposed for testing */
    _recalcCount = 0;

    private onTrackedVehicleLost?: () => void;
    /** Called when tracking transitions to a new trip (loop). Receives the new trip_id. */
    private onTrackedTripChanged?: (newTripId: string) => void;
    private trackedTripId: string | null = null;
    /** Maps trip_id → next_trip_id for seamless loop transitions. */
    private nextTripMap = new globalThis.Map<string, string>();
    private debugOptions: DebugOptions = {
        show3DModels: true,
        showDebugSegments: false,
        showDebugOnlyTracked: true
    };

    /** Lifecycle monitor for automated anomaly detection. */
    private lifecycleMonitor = new VehicleLifecycleMonitor();

    constructor(
        layerManager: MapLayerManager,
        routeColors: globalThis.Map<string, string>,
        routeTypes: globalThis.Map<string, string>,
        routeIdColors: globalThis.Map<number, string>,
        routeGeometries: globalThis.Map<number, number[][][]>,
        routeTypesById: globalThis.Map<number, string>,
        modelLoader: VehicleModelLoader,
    ) {
        this.layerManager = layerManager;
        this.routeColors = routeColors;
        this.routeTypes = routeTypes;
        this.routeIdColors = routeIdColors;
        this.routeGeometries = routeGeometries;
        this.routeTypesById = routeTypesById;
        this.modelLoader = modelLoader;
        this.buildLinearizedRoutes();

        installMonitorGlobal(this.lifecycleMonitor);
    }

    /**
     * Build linearized routes from route geometries
     */
    private buildLinearizedRoutes(): void {
        this.linearizedRoutes.clear();
        for (const [routeId, geometry] of this.routeGeometries) {
            const linearized = linearizeRoute(geometry);
            if (linearized) {
                this.linearizedRoutes.set(routeId, linearized);
            }
        }
    }

    private resolveModel(routeId: number): VehicleModel {
        if (this.modelLoader.ready) {
            const routeType = this.routeTypesById.get(routeId);
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

    /**
     * Update route data references
     */
    updateRouteData(
        routeColors: globalThis.Map<string, string>,
        routeTypes: globalThis.Map<string, string>,
        routeIdColors: globalThis.Map<number, string>,
        routeGeometries: globalThis.Map<number, number[][][]>,
        routeTypesById: globalThis.Map<number, string>,
    ): void {
        this.routeColors = routeColors;
        this.routeTypes = routeTypes;
        this.routeIdColors = routeIdColors;
        this.routeGeometries = routeGeometries;
        this.routeTypesById = routeTypesById;
        this.buildLinearizedRoutes();
    }

    /**
     * Tiered route color lookup:
     * 1. routeIdColors (exact OSM route → color from /api/routes/visible)
     * 2. type-scoped key (e.g. "tram:1" in routeColors)
     * 3. bare ref (e.g. "1" in routeColors)
     * 4. fallback default blue
     */
    private lookupRouteColor(lineNumber: string, routeId: number): string {
        // Most specific: exact route color from OSM data
        const byRouteId = this.routeIdColors.get(routeId);
        if (byRouteId) return byRouteId;
        // Fallback: type-scoped lookup in the global color map
        const routeType = this.routeTypes.get(lineNumber);
        if (routeType) {
            const byType = this.routeColors.get(`${routeType}:${lineNumber}`);
            if (byType) return byType;
        }
        return this.routeColors.get(lineNumber) ?? "#3b82f6";
    }

    /**
     * Set callback for when tracked vehicle is lost
     */
    setOnTrackedVehicleLost(callback: () => void): void {
        this.onTrackedVehicleLost = callback;
    }

    /**
     * Set callback for when tracking transitions to a new trip (loop continuation)
     */
    setOnTrackedTripChanged(callback: (newTripId: string) => void): void {
        this.onTrackedTripChanged = callback;
    }

    /**
     * Set the currently tracked trip ID
     */
    setTrackedTripId(tripId: string | null): void {
        this.trackedTripId = tripId;
    }

    /**
     * Set debug visualization options
     */
    setDebugOptions(options: DebugOptions): void {
        this.debugOptions = options;
        // Sync the MapLibre layer minzoom with the configurable setting
        const minZoom = options.model3DMinZoom ?? MODEL_3D_MIN_ZOOM;
        this.layerManager.setVehicleModelsMinZoom(minZoom);
    }

    /**
     * Get a specific smoothed position
     */
    getSmoothedPosition(tripId: string): SmoothedVehiclePosition | undefined {
        return this.smoothedPositions.get(tripId);
    }

    /**
     * Update the vehicles data used by the animation loop
     * This should be called whenever vehicles prop changes
     */
    setVehicles(vehicles: RouteVehicles[]): void {
        this.currentVehicles = vehicles;
    }

    /**
     * Set the time speed from the simulation controller.
     * This is the known speed (1.0 = real-time, 10.0 = 10x), NOT computed from
     * React call timing which is noisy due to variable render delays.
     */
    setTimeSpeed(speed: number): void {
        this.timeSpeed = speed;
    }

    setZoom(zoom: number): void {
        this.currentZoom = zoom;
    }

    /**
     * Update the simulated time from the React timer.
     * Called every ~50ms by useTimeSimulation. We store the authoritative time
     * and interpolate smoothly between calls using the known timeSpeed.
     */
    setSimulatedTime(time: Date): void {
        this.lastAuthoritativeSimTime = time.getTime();
        this.lastAuthoritativeRealTime = performance.now();
        this.simulatedTime = time;
    }

    /**
     * Start the vehicle animation loop
     * Uses this.currentVehicles which should be updated via setVehicles()
     */
    startAnimation(): void {
        if (this.animationId) return;

        // Initial update
        this.recalculateTargets();
        this.renderFrame(ANIMATION_INTERVAL);

        const animate = (timestamp: number) => {
            this._tick(timestamp);
            this.animationId = requestAnimationFrame(animate);
        };

        this.animationId = requestAnimationFrame(animate);
    }

    /**
     * Advance one animation frame at the given timestamp (ms).
     * Exposed for deterministic testing.
     */
    _tick(timestamp: number): void {
        const deltaMs = this.lastAnimationTime > 0 ? timestamp - this.lastAnimationTime : 16;
        this.lastAnimationTime = timestamp;

        // Interpolate simulated time from last authoritative update.
        // This produces smooth sub-pixel movement between React's 50ms timer updates.
        // Unlike accumulation (+=deltaMs*speed), this resets every 50ms so no drift.
        if (this.lastAuthoritativeRealTime > 0) {
            const realElapsed = performance.now() - this.lastAuthoritativeRealTime;
            // Cap to prevent huge jumps after tab was inactive
            const cappedElapsed = Math.min(realElapsed, 200);
            this.simulatedTime = new Date(
                this.lastAuthoritativeSimTime + cappedElapsed * this.timeSpeed
            );
        }

        // Always recalculate - time changes every frame via interpolation
        this.recalculateTargets();

        this.renderFrame(deltaMs);
    }

    /**
     * Stop the vehicle animation loop
     */
    stopAnimation(): void {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        this.lastAnimationTime = 0;
    }

    /**
     * Clear all vehicle data
     */
    clear(): void {
        this.stopAnimation();
        this.layerManager.clearVehicleData();
        this.layerManager.updateDebugSegments([]);
        this.smoothedPositions.clear();
        this.vehicleLastSeen.clear();
        this.lifecycleMonitor.clear();
    }

    /**
     * Recalculate target positions from vehicle data and simulated time.
     * This is the expensive step - only runs when vehicles or time change.
     */
    private recalculateTargets(): void {
        this._recalcCount++;
        const now = this.simulatedTime;
        const vehiclesByTripId = new globalThis.Map<
            string,
            { vehicle: RouteVehicles["vehicles"][0]; routeId: number; stopCount: number }
        >();

        this.nextTripMap.clear();
        for (const routeVehicles of this.currentVehicles) {
            for (const vehicle of routeVehicles.vehicles) {
                const existing = vehiclesByTripId.get(vehicle.trip_id);
                if (!existing || vehicle.stops.length > existing.stopCount) {
                    vehiclesByTripId.set(vehicle.trip_id, {
                        vehicle,
                        routeId: routeVehicles.routeId,
                        stopCount: vehicle.stops.length
                    });
                }
                if (vehicle.next_trip_id) {
                    this.nextTripMap.set(vehicle.trip_id, vehicle.next_trip_id);
                }
            }
        }

        const allPositions: { position: VehiclePosition; routeId: number; routeColor: string }[] =
            [];
        const completingAtLocation = new Set<string>();
        const activeTripIds = new Set<string>();

        for (const { vehicle, routeId } of vehiclesByTripId.values()) {
            const routeGeometry = this.routeGeometries.get(routeId);
            // Skip vehicles whose route geometry hasn't loaded yet.
            // Without geometry, vehicles interpolate linearly between stops
            // (cutting through buildings). Better to show nothing until geometry arrives.
            if (!routeGeometry || routeGeometry.length === 0) continue;
            const routeColor = this.lookupRouteColor(vehicle.line_number ?? "", routeId);
            const targetPosition = calculateVehiclePosition(vehicle, routeGeometry, now);

            if (targetPosition && targetPosition.status !== "completed") {
                allPositions.push({ position: targetPosition, routeId, routeColor });
                const lastStop = vehicle.stops[vehicle.stops.length - 1];
                const isOnFinalSegment =
                    targetPosition.nextStop?.stop_ifopt === lastStop?.stop_ifopt;
                if (isOnFinalSegment && targetPosition.progress > 0.5 && lastStop?.stop_ifopt) {
                    completingAtLocation.add(`${targetPosition.lineNumber}:${lastStop.stop_ifopt}`);
                }
            }
        }

        // Filter out waiting vehicles that shouldn't be shown
        // Exception: if a vehicle was already visible (has smoothed position), keep it
        // to prevent pop-in/pop-out when status flickers between states
        const filteredPositions: typeof allPositions = [];
        for (const entry of allPositions) {
            if (entry.position.status === "waiting") {
                const alreadyVisible = this.smoothedPositions.has(entry.position.tripId);
                if (!alreadyVisible) {
                    // New waiting vehicle: only show if another vehicle is completing at same stop
                    const vehicle = vehiclesByTripId.get(entry.position.tripId)?.vehicle;
                    const firstStop = vehicle?.stops[0];
                    const locationKey = `${entry.position.lineNumber}:${firstStop?.stop_ifopt}`;
                    if (!completingAtLocation.has(locationKey)) continue;
                }
            }
            activeTripIds.add(entry.position.tripId);
            filteredPositions.push(entry);
        }

        this.cachedTargets = filteredPositions;
        this.cachedActiveTripIds = activeTripIds;
    }

    /**
     * Smooth positions toward targets and render all layers.
     * This is the cheap step - runs every animation frame for fluid movement.
     */
    private renderFrame(deltaMs: number): void {
        const allPositions = this.cachedTargets;
        const activeTripIds = this.cachedActiveTripIds;

        // Compute forward-movement caps from leader/follower detection.
        // Uses PREVIOUS frame's smoothed positions so leaders' positions are stable.
        // The cap prevents a follower from advancing past (leader − 50m) on its route,
        // but NEVER pushes a vehicle backwards (caller applies Math.max with current pos).
        let positionCaps = new globalThis.Map<string, { maxLinearPosition: number; routeId: number }>();
        if (featureManager.isEnabled(COLLISION_AVOIDANCE_FEATURE_ID)) {
            const vehicleInfo = allPositions.map(({ position, routeId }) => ({
                tripId: position.tripId,
                routeId,
                lineNumber: position.lineNumber,
            }));
            positionCaps = computePositionCaps(
                vehicleInfo,
                this.smoothedPositions,
                this.linearizedRoutes,
            );
        }

        // Capture pre-advance positions for accurate monitor speed diagnostics.
        // The monitor compares rendered speed (position delta / time delta) against
        // schedule speed (distance to next stop / time to next stop). Both must use
        // the SAME position base to avoid inflated ratios.
        const preAdvancePositions = new globalThis.Map<string, number | undefined>();
        for (const { position: targetPosition } of allPositions) {
            const prev = this.smoothedPositions.get(targetPosition.tripId);
            preAdvancePositions.set(targetPosition.tripId, prev?.renderedLinearPosition);
        }

        // Update smoothed positions toward targets
        // Pass linearized route for route-based smoothing with forward-only clamping
        for (const { position: targetPosition, routeId } of allPositions) {
            const linearizedRoute = this.linearizedRoutes.get(routeId);
            const previousPosition = this.smoothedPositions.get(targetPosition.tripId);
            let smoothedPosition: SmoothedVehiclePosition;
            if (previousPosition) {
                smoothedPosition = updateSmoothedPosition(
                    previousPosition,
                    targetPosition,
                    deltaMs,
                    linearizedRoute,
                    this.timeSpeed,
                );
            } else {
                smoothedPosition = createSmoothedPosition(targetPosition);
            }

            // Apply collision avoidance cap: prevent forward movement past safe distance.
            // NEVER move backwards — Math.max with previous position guarantees this.
            const cap = positionCaps.get(targetPosition.tripId);
            if (cap && linearizedRoute &&
                smoothedPosition.renderedLinearPosition !== undefined) {
                const prevLinear = previousPosition?.renderedLinearPosition ?? smoothedPosition.renderedLinearPosition;
                // effectiveCap: the cap, but never behind where the vehicle already was
                const effectiveCap = Math.max(cap.maxLinearPosition, prevLinear);
                if (smoothedPosition.renderedLinearPosition > effectiveCap) {
                    const capped = getPositionAtDistance(linearizedRoute, effectiveCap);
                    smoothedPosition = {
                        ...smoothedPosition,
                        renderedLinearPosition: effectiveCap,
                        renderedLon: capped.lon,
                        renderedLat: capped.lat,
                    };
                }
            }

            this.smoothedPositions.set(targetPosition.tripId, smoothedPosition);
        }

        // Feed lifecycle monitor (includes speed diagnostics for anomaly detection)
        const monitorSnapshots = new globalThis.Map<string, VehicleSnapshot>();
        for (const { position: targetPosition, routeId } of allPositions) {
            const sp = this.smoothedPositions.get(targetPosition.tripId);
            if (!sp) continue;

            // Use PRE-ADVANCE position for schedule speed to match the distance
            // base that the smoothing function used. Using post-advance position
            // would undercount remaining distance and report inflated speed ratios.
            const preLinear = preAdvancePositions.get(targetPosition.tripId);
            let scheduleSpeedMps: number | undefined;
            let distToNextStop: number | undefined;
            if (targetPosition.nextStopLinearPosition !== undefined && preLinear !== undefined) {
                distToNextStop = targetPosition.nextStopLinearPosition - preLinear;
            }
            if (distToNextStop !== undefined &&
                targetPosition.msToNextStop !== undefined &&
                targetPosition.msToNextStop > 0) {
                scheduleSpeedMps = Math.max(0, distToNextStop / (targetPosition.msToNextStop / 1000));
            }

            monitorSnapshots.set(targetPosition.tripId, {
                lon: sp.renderedLon,
                lat: sp.renderedLat,
                linearPosition: sp.renderedLinearPosition ?? 0,
                status: sp.status,
                routeId,
                scheduleSpeedMps,
                distToNextStop,
                msToNextStop: targetPosition.msToNextStop,
            });
        }
        this.lifecycleMonitor.update(monitorSnapshots);

        // Collect vehicle context for feature processing
        const vehicleContexts: VehicleRenderContext[] = [];
        for (const { position: targetPosition, routeId } of allPositions) {
            const smoothedPosition = this.smoothedPositions.get(targetPosition.tripId);
            if (!smoothedPosition) continue;

            const linearizedRoute = this.linearizedRoutes.get(routeId);
            if (!linearizedRoute) continue;

            let linearPosition: number;
            if (smoothedPosition.renderedLinearPosition !== undefined) {
                linearPosition = smoothedPosition.renderedLinearPosition;
            } else {
                const routePosition = findPositionOnRoute(
                    linearizedRoute,
                    smoothedPosition.renderedLon,
                    smoothedPosition.renderedLat
                );
                linearPosition = routePosition.linearPosition;
            }

            vehicleContexts.push({
                tripId: targetPosition.tripId,
                routeId,
                linearPosition,
                lineNumber: smoothedPosition.lineNumber ?? "0",
                smoothedPosition,
            });
        }

        // Process render positions through feature pipeline
        const renderPositions = this.processRenderPositions(vehicleContexts);

        // Generate GeoJSON features for rendering
        const markerFeatures: GeoJSON.Feature[] = [];
        const modelFeatures: GeoJSON.Feature[] = [];
        const debugFeatures: GeoJSON.Feature[] = [];

        for (const { position: targetPosition, routeId, routeColor } of allPositions) {
            const smoothedPosition = this.smoothedPositions.get(targetPosition.tripId);
            if (!smoothedPosition) continue;

            const vehicleModel = this.resolveModel(routeId);
            const segmentDistances = this.resolveSegmentDistances(vehicleModel);

            // Get processed render position (or fall back to smoothed)
            const renderPos: RenderPosition = renderPositions.get(targetPosition.tripId) ?? {
                lon: smoothedPosition.renderedLon,
                lat: smoothedPosition.renderedLat,
                bearing: smoothedPosition.renderedBearing
            };

            // Create vehicle marker icon
            const lineNumber = smoothedPosition.lineNumber ?? "?";
            const iconId = `vehicle-${routeColor.replace("#", "")}-${lineNumber}`;

            if (!this.vehicleIcons.has(iconId)) {
                this.layerManager.addImage(iconId, createVehicleIcon(routeColor, lineNumber));
                this.vehicleIcons.add(iconId);
            }

            // Add marker feature
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
                    nextStopName: smoothedPosition.nextStop?.stop_name ?? null
                },
                geometry: { type: "Point", coordinates: [renderPos.lon, renderPos.lat] }
            });

            // Generate 3D model features and debug visualization
            const linearizedRoute = this.linearizedRoutes.get(routeId);
            const isTracked = targetPosition.tripId === this.trackedTripId;

            const showDebugForThis =
                this.debugOptions.showDebugSegments &&
                (!this.debugOptions.showDebugOnlyTracked || isTracked);

            const minZoom = this.debugOptions.model3DMinZoom ?? MODEL_3D_MIN_ZOOM;
            const show3DAtZoom = this.debugOptions.show3DModels && this.currentZoom >= minZoom;
            if (show3DAtZoom || showDebugForThis) {
                const { modelFeatures: segmentFeatures, debugFeatures: segDebugFeatures } =
                    this.generateModelFeatures(
                        smoothedPosition,
                        linearizedRoute,
                        routeColor,
                        vehicleModel,
                        segmentDistances,
                        showDebugForThis,
                        renderPos,
                    );
                if (show3DAtZoom) {
                    modelFeatures.push(...segmentFeatures);
                }
                if (showDebugForThis) {
                    debugFeatures.push(...segDebugFeatures);
                }
            }
        }

        // Update last-seen timestamps for active vehicles, and prune stale ones.
        const now = performance.now();
        for (const tripId of activeTripIds) {
            this.vehicleLastSeen.set(tripId, now);
        }
        for (const tripId of this.smoothedPositions.keys()) {
            if (!activeTripIds.has(tripId)) {
                const lastSeen = this.vehicleLastSeen.get(tripId) ?? 0;
                if (now - lastSeen > SMOOTHED_POSITION_GRACE_MS) {
                    this.smoothedPositions.delete(tripId);
                    this.vehicleLastSeen.delete(tripId);
                }
            }
        }

        // Seamless loop transition: when tracked vehicle completes or disappears,
        // switch to the next trip if available.
        if (this.trackedTripId) {
            const trackedSp = this.smoothedPositions.get(this.trackedTripId);
            const nextTripId = this.nextTripMap.get(this.trackedTripId);

            if (!trackedSp) {
                // Vehicle gone entirely
                if (nextTripId && this.smoothedPositions.has(nextTripId)) {
                    this.trackedTripId = nextTripId;
                    this.onTrackedTripChanged?.(nextTripId);
                } else {
                    this.onTrackedVehicleLost?.();
                }
            } else if (trackedSp.status === "completed" || trackedSp.status === "at_stop") {
                // Vehicle at final stop or completed — transition early if next trip is active
                if (nextTripId && this.smoothedPositions.has(nextTripId)) {
                    const isAtFinalStop = !trackedSp.nextStop;
                    if (trackedSp.status === "completed" || isAtFinalStop) {
                        this.trackedTripId = nextTripId;
                        this.onTrackedTripChanged?.(nextTripId);
                    }
                }
            }
        }

        // Update all layers together
        this.layerManager.updateVehicles(markerFeatures);
        this.layerManager.updateVehicleModels(modelFeatures);
        this.layerManager.updateDebugSegments(debugFeatures);
    }

    /**
     * Update vehicle positions, markers, and 3D models in a single pass.
     * Used for one-off updates (e.g. when debug options change).
     */
    updatePositions(vehicles: RouteVehicles[], deltaMs: number): void {
        this.currentVehicles = vehicles;
        this.recalculateTargets();
        this.renderFrame(deltaMs);
    }

    /**
     * Generate 3D model features for a vehicle using linearized route
     */
    private generateModelFeatures(
        smoothedPosition: SmoothedVehiclePosition,
        linearizedRoute: LinearizedRoute | undefined,
        routeColor: string,
        vehicleModel: VehicleModel,
        segmentDistances: SegmentDistances,
        showDebug = false,
        renderPos?: RenderPosition,
    ): { modelFeatures: GeoJSON.Feature[]; debugFeatures: GeoJSON.Feature[] } {
        const modelFeatures: GeoJSON.Feature[] = [];
        const debugFeatures: GeoJSON.Feature[] = [];

        // If no linearized route, don't render 3D model
        if (!linearizedRoute) {
            return { modelFeatures: [], debugFeatures: [] };
        }

        // Use the collision-adjusted render position when available, falling back
        // to the smoothed linear position. This ensures the 3D model is always
        // co-located with the marker icon.
        let linearPosition: number;
        if (renderPos) {
            const projected = findPositionOnRoute(linearizedRoute, renderPos.lon, renderPos.lat);
            linearPosition = projected.linearPosition;
        } else if (smoothedPosition.renderedLinearPosition !== undefined) {
            linearPosition = smoothedPosition.renderedLinearPosition;
        } else {
            const routePosition = findPositionOnRoute(
                linearizedRoute,
                smoothedPosition.renderedLon,
                smoothedPosition.renderedLat
            );
            linearPosition = routePosition.linearPosition;
        }

        // Build the list of distances we need positions for.  Each segment
        // contributes either its bogie centerline distances (rigid-body mode)
        // or its front/rear endpoints (flexible-body fallback).  segmentSlices
        // tracks which slice of `positions` belongs to each segment.
        const allDistances: number[] = [];
        const segmentSlices: { start: number; count: number; useBogies: boolean }[] = [];
        for (const segInfo of segmentDistances) {
            const bogies = segInfo.segment.bogiePositions;
            const useBogies = !!(bogies && bogies.length >= 2);
            const start = allDistances.length;
            if (useBogies) {
                for (const bogiePos of bogies!) {
                    allDistances.push(segInfo.frontDistance + bogiePos);
                }
            } else {
                allDistances.push(segInfo.frontDistance, segInfo.rearDistance);
            }
            segmentSlices.push({ start, count: allDistances.length - start, useBogies });
        }

        // Get positions along the route behind the vehicle
        const positions = getPositionsBehindOnRoute(linearizedRoute, linearPosition, allDistances);

        // Generate 3D model polygons
        for (let i = 0; i < segmentDistances.length; i++) {
            const segInfo = segmentDistances[i];
            const slice = segmentSlices[i];
            const segWidth = segInfo.segment.width ?? vehicleModel.width;

            let bodyFront: { lon: number; lat: number };
            let bodyRear: { lon: number; lat: number };

            if (slice.useBogies) {
                // Rigid-body mode: extend the body past the outermost bogies
                // along the chord between them.
                const bogiePositions = segInfo.segment.bogiePositions!;
                const firstBogie = positions[slice.start];
                const lastBogie = positions[slice.start + slice.count - 1];
                const frontOverhang = bogiePositions[0];
                const rearOverhang = segInfo.segment.length - bogiePositions[bogiePositions.length - 1];

                // Compute axis from first bogie to last bogie in metres
                const metersPerDegLon = METERS_PER_DEGREE_AT_EQUATOR * Math.cos((firstBogie.lat * Math.PI) / 180);
                const dxMeters = (lastBogie.lon - firstBogie.lon) * metersPerDegLon;
                const dyMeters = (lastBogie.lat - firstBogie.lat) * METERS_PER_DEGREE_AT_EQUATOR;
                const axisLength = Math.sqrt(dxMeters * dxMeters + dyMeters * dyMeters);

                if (axisLength > MIN_SEGMENT_RENDER_LENGTH) {
                    const axisDxLon = dxMeters / axisLength / metersPerDegLon;
                    const axisDyLat = dyMeters / axisLength / METERS_PER_DEGREE_AT_EQUATOR;
                    // Body front = first bogie minus frontOverhang along the axis
                    bodyFront = {
                        lon: firstBogie.lon - axisDxLon * frontOverhang,
                        lat: firstBogie.lat - axisDyLat * frontOverhang,
                    };
                    // Body rear = last bogie plus rearOverhang along the axis
                    bodyRear = {
                        lon: lastBogie.lon + axisDxLon * rearOverhang,
                        lat: lastBogie.lat + axisDyLat * rearOverhang,
                    };
                } else {
                    // Bogies coincide (degenerate); fall back to bogie positions
                    bodyFront = firstBogie;
                    bodyRear = lastBogie;
                }
            } else {
                // Flexible-body fallback: use the segment's front and rear corners
                bodyFront = positions[slice.start];
                bodyRear = positions[slice.start + 1];
            }

            const polygon = this.createSegmentPolygon(
                bodyFront.lon,
                bodyFront.lat,
                bodyRear.lon,
                bodyRear.lat,
                segWidth
            );

            if (polygon.length > 0) {
                modelFeatures.push({
                    type: "Feature",
                    properties: {
                        color: routeColor,
                        tripId: smoothedPosition.tripId,
                        carIndex: segInfo.index,
                        height: segInfo.segment.height
                    },
                    geometry: { type: "Polygon", coordinates: [polygon] }
                });
            }
        }

        // Generate debug segment visualization if this is the tracked vehicle
        if (showDebug) {
            const posAtDist = getPositionAtDistance(linearizedRoute, linearPosition);
            const segDebug = getDebugSegmentFeatures(linearizedRoute, posAtDist.segmentIndex, 5, 5);
            debugFeatures.push(...segDebug);
        }

        return { modelFeatures, debugFeatures };
    }

    /**
     * Create a polygon for a vehicle segment
     */
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
            [
                frontLon + (perpX * halfWidth) / metersPerDegreeLon,
                frontLat + (perpY * halfWidth) / metersPerDegreeLat
            ],
            [
                frontLon - (perpX * halfWidth) / metersPerDegreeLon,
                frontLat - (perpY * halfWidth) / metersPerDegreeLat
            ],
            [
                rearLon - (perpX * halfWidth) / metersPerDegreeLon,
                rearLat - (perpY * halfWidth) / metersPerDegreeLat
            ],
            [
                rearLon + (perpX * halfWidth) / metersPerDegreeLon,
                rearLat + (perpY * halfWidth) / metersPerDegreeLat
            ]
        ];
        corners.push(corners[0]);
        return corners;
    }

    /**
     * Process render positions through feature pipeline
     * Returns a map of tripId -> {lon, lat, bearing} for rendering
     */
    private processRenderPositions(vehicleContexts: VehicleRenderContext[]): globalThis.Map<string, RenderPosition> {
        const renderPositions = new globalThis.Map<string, RenderPosition>();

        if (vehicleContexts.length === 0) return renderPositions;

        // Initialize render positions from smoothed positions
        for (const vehicle of vehicleContexts) {
            renderPositions.set(vehicle.tripId, {
                lon: vehicle.smoothedPosition.renderedLon,
                lat: vehicle.smoothedPosition.renderedLat,
                bearing: vehicle.smoothedPosition.renderedBearing,
            });
        }

        // Process through all enabled features
        featureManager.processRenderPositions(vehicleContexts, renderPositions, this.linearizedRoutes);

        return renderPositions;
    }

    /**
     * Cleanup resources
     */
    dispose(): void {
        this.stopAnimation();
        this.vehicleIcons.clear();
        this.smoothedPositions.clear();
        this.vehicleLastSeen.clear();
        this.linearizedRoutes.clear();
        this.lifecycleMonitor.clear();
    }
}
