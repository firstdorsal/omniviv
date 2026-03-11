/**
 * Handles vehicle position animation, marker rendering, and 3D model visualization
 */

import type { RouteVehicles } from "../../App";
import type { MapLayerManager } from "../map/MapLayerManager";
import { createVehicleIcon } from "./VehicleIconFactory";
import { calculateSegmentDistances, getAugsburgVehicleModel } from "./vehicleModels";
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
    type VehiclePosition,
} from "./vehicleUtils";
import { featureManager, type VehicleRenderContext, type RenderPosition } from "./features";

const ANIMATION_INTERVAL = 50;

export interface DebugOptions {
    show3DModels: boolean;
    showDebugSegments: boolean;
    showDebugOnlyTracked: boolean;
}

export class VehicleRenderer {
    private layerManager: MapLayerManager;
    private routeColors: globalThis.Map<string, string>;
    private routeGeometries: globalThis.Map<number, number[][][]>;
    private linearizedRoutes = new globalThis.Map<number, LinearizedRoute>();
    private smoothedPositions = new globalThis.Map<string, SmoothedVehiclePosition>();
    /** Accumulated linear position offsets (meters) from collision avoidance */
    private collisionOffsets = new globalThis.Map<string, number>();
    private vehicleIcons = new Set<string>();
    private animationId: number | null = null;
    private lastAnimationTime = 0;

    // Current vehicles data - updated via setVehicles() so animation loop uses latest data
    private currentVehicles: RouteVehicles[] = [];

    // Cached target positions - recalculated every frame
    private cachedTargets: { position: VehiclePosition; routeId: number; routeColor: string }[] = [];
    private cachedActiveTripIds = new Set<string>();

    // Time interpolation: React timer provides authoritative time every ~50ms.
    // Between updates, we interpolate linearly using the known time speed.
    // This avoids discrete sub-pixel jumps that cause visible pixel-level teleporting.
    private simulatedTime: Date = new Date();
    private lastAuthoritativeSimTime = 0;   // ms since epoch, from last setSimulatedTime
    private lastAuthoritativeRealTime = 0;  // performance.now() ms, when last setSimulatedTime was called
    // Time speed from the simulation controller (1.0 = real-time, 10.0 = 10x).
    // Set explicitly via setTimeSpeed() - NOT computed from call timing, which is noisy
    // due to variable React render delays.
    private timeSpeed = 1.0;

    /** Counter for target recalculations - exposed for testing */
    _recalcCount = 0;

    private onTrackedVehicleLost?: () => void;
    private trackedTripId: string | null = null;
    private debugOptions: DebugOptions = { show3DModels: true, showDebugSegments: false, showDebugOnlyTracked: true };

    constructor(
        layerManager: MapLayerManager,
        routeColors: globalThis.Map<string, string>,
        routeGeometries: globalThis.Map<number, number[][][]>
    ) {
        this.layerManager = layerManager;
        this.routeColors = routeColors;
        this.routeGeometries = routeGeometries;
        this.buildLinearizedRoutes();
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

    /**
     * Update route data references
     */
    updateRouteData(
        routeColors: globalThis.Map<string, string>,
        routeGeometries: globalThis.Map<number, number[][][]>
    ): void {
        this.routeColors = routeColors;
        this.routeGeometries = routeGeometries;
        this.buildLinearizedRoutes();
    }

    /**
     * Set callback for when tracked vehicle is lost
     */
    setOnTrackedVehicleLost(callback: () => void): void {
        this.onTrackedVehicleLost = callback;
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
        this.collisionOffsets.clear();
    }

    /**
     * Recalculate target positions from vehicle data and simulated time.
     * This is the expensive step - only runs when vehicles or time change.
     */
    private recalculateTargets(): void {
        this._recalcCount++;
        const now = this.simulatedTime;
        const vehiclesByTripId = new globalThis.Map<string, { vehicle: RouteVehicles["vehicles"][0]; routeId: number; stopCount: number }>();

        for (const routeVehicles of this.currentVehicles) {
            for (const vehicle of routeVehicles.vehicles) {
                const existing = vehiclesByTripId.get(vehicle.trip_id);
                if (!existing || vehicle.stops.length > existing.stopCount) {
                    vehiclesByTripId.set(vehicle.trip_id, { vehicle, routeId: routeVehicles.routeId, stopCount: vehicle.stops.length });
                }
            }
        }

        const allPositions: { position: VehiclePosition; routeId: number; routeColor: string }[] = [];
        const completingAtLocation = new Set<string>();
        const activeTripIds = new Set<string>();

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

        // Compute speed adjustments from previous frame's smoothed positions.
        // This uses geographic proximity to detect overlapping vehicles and
        // returns per-vehicle speed multipliers (< 1.0 = slow down, > 1.0 = speed up).
        const speedAdjustments = this.computeSpeedAdjustments(allPositions);

        // Update smoothed positions toward targets
        // Pass linearized route for route-based smoothing with forward-only clamping
        for (const { position: targetPosition, routeId } of allPositions) {
            const linearizedRoute = this.linearizedRoutes.get(routeId);
            let smoothedPosition = this.smoothedPositions.get(targetPosition.tripId);
            if (smoothedPosition) {
                smoothedPosition = updateSmoothedPosition(smoothedPosition, targetPosition, deltaMs, linearizedRoute);
            } else {
                smoothedPosition = createSmoothedPosition(targetPosition);
            }
            this.smoothedPositions.set(targetPosition.tripId, smoothedPosition);
        }

        // Accumulate collision offsets from speed adjustments and apply to smoothed positions.
        // This shifts vehicles along their own routes to create visual separation.
        this.updateCollisionOffsets(speedAdjustments, deltaMs);
        this.applyCollisionOffsets(allPositions);

        // Collect vehicle context for feature processing
        const vehicleContexts: VehicleRenderContext[] = [];
        for (const { position: targetPosition, routeId } of allPositions) {
            const smoothedPosition = this.smoothedPositions.get(targetPosition.tripId);
            if (!smoothedPosition) continue;

            const linearizedRoute = this.linearizedRoutes.get(routeId);
            if (!linearizedRoute) continue;

            // Use smoothed linear position when available (more stable than re-projecting lon/lat)
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
                smoothedPosition,
            });
        }

        // Process render positions through feature pipeline
        const renderPositions = this.processRenderPositions(vehicleContexts);

        // Generate GeoJSON features for rendering
        const markerFeatures: GeoJSON.Feature[] = [];
        const modelFeatures: GeoJSON.Feature[] = [];
        const debugFeatures: GeoJSON.Feature[] = [];

        const vehicleModel = getAugsburgVehicleModel();
        const segmentDistances = calculateSegmentDistances(vehicleModel);

        for (const { position: targetPosition, routeId, routeColor } of allPositions) {
            const smoothedPosition = this.smoothedPositions.get(targetPosition.tripId);
            if (!smoothedPosition) continue;

            // Get processed render position (or fall back to smoothed)
            const renderPos = renderPositions.get(targetPosition.tripId) ?? {
                lon: smoothedPosition.renderedLon,
                lat: smoothedPosition.renderedLat,
                bearing: smoothedPosition.renderedBearing,
            };

            // Create vehicle marker icon
            const lineNum = smoothedPosition.lineNumber ?? "?";
            const iconId = `vehicle-${routeColor.replace("#", "")}-${lineNum}`;

            if (!this.vehicleIcons.has(iconId)) {
                this.layerManager.addImage(iconId, createVehicleIcon(routeColor, lineNum));
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
                    nextStopName: smoothedPosition.nextStop?.stop_name ?? null,
                },
                geometry: { type: "Point", coordinates: [renderPos.lon, renderPos.lat] },
            });

            // Generate 3D model features and debug visualization
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

        // Cleanup old smoothed positions and collision offsets
        for (const tripId of this.smoothedPositions.keys()) {
            if (!activeTripIds.has(tripId)) {
                this.smoothedPositions.delete(tripId);
                this.collisionOffsets.delete(tripId);
            }
        }

        // Check if tracked vehicle still exists
        if (this.trackedTripId && !this.smoothedPositions.has(this.trackedTripId)) {
            this.onTrackedVehicleLost?.();
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
        renderPos: { lon: number; lat: number; bearing: number },
        linearizedRoute: LinearizedRoute | undefined,
        routeColor: string,
        vehicleModel: ReturnType<typeof getAugsburgVehicleModel>,
        segmentDistances: ReturnType<typeof calculateSegmentDistances>,
        showDebug = false
    ): { modelFeatures: GeoJSON.Feature[]; debugFeatures: GeoJSON.Feature[] } {
        const modelFeatures: GeoJSON.Feature[] = [];
        const debugFeatures: GeoJSON.Feature[] = [];

        // If no linearized route, don't render 3D model
        if (!linearizedRoute) {
            return { modelFeatures: [], debugFeatures: [] };
        }

        // Use the smoothed linear position when available (more stable than re-projecting lon/lat)
        // Re-projecting lon/lat via findPositionOnRoute can be unstable near route curves
        let linearPosition: number;
        if (smoothedPosition.renderedLinearPosition !== undefined) {
            linearPosition = smoothedPosition.renderedLinearPosition;
        } else {
            const routePosition = findPositionOnRoute(
                linearizedRoute,
                renderPos.lon,
                renderPos.lat
            );
            linearPosition = routePosition.linearPosition;
        }

        // Get all distances behind the vehicle for 3D model segments
        const allDistances: number[] = [];
        for (const segInfo of segmentDistances) {
            allDistances.push(segInfo.frontDistance, segInfo.rearDistance);
        }

        // Get positions along the route behind the vehicle
        const positions = getPositionsBehindOnRoute(linearizedRoute, linearPosition, allDistances);

        // Generate 3D model polygons
        for (let i = 0; i < segmentDistances.length; i++) {
            const segInfo = segmentDistances[i];
            const frontPos = positions[i * 2];
            const rearPos = positions[i * 2 + 1];

            const polygon = this.createSegmentPolygon(
                frontPos.lon, frontPos.lat,
                rearPos.lon, rearPos.lat,
                vehicleModel.width
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

        // Generate debug segment visualization if this is the tracked vehicle
        if (showDebug) {
            const posAtDist = getPositionAtDistance(linearizedRoute, linearPosition);
            const segDebug = getDebugSegmentFeatures(linearizedRoute, posAtDist.segmentIndex, 5, 5);
            debugFeatures.push(...segDebug);
        }

        return { modelFeatures, debugFeatures };
    }

    /**
     * Create a polygon for a tram segment
     */
    private createSegmentPolygon(
        frontLon: number,
        frontLat: number,
        rearLon: number,
        rearLat: number,
        width: number
    ): number[][] {
        const metersPerDegreeLat = 111320;
        const metersPerDegreeLon = 111320 * Math.cos((frontLat * Math.PI) / 180);
        const dx = (frontLon - rearLon) * metersPerDegreeLon;
        const dy = (frontLat - rearLat) * metersPerDegreeLat;
        const length = Math.sqrt(dx * dx + dy * dy);
        if (length < 0.1) return [];

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

    /**
     * Build vehicle contexts from previous frame's smoothed positions and
     * compute speed adjustments for collision avoidance.
     */
    private computeSpeedAdjustments(
        allPositions: { position: VehiclePosition; routeId: number; routeColor: string }[]
    ): globalThis.Map<string, number> {
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
                smoothedPosition,
            });
        }

        return featureManager.computeSpeedAdjustments(vehicleContexts, this.linearizedRoutes);
    }

    /**
     * Accumulate per-vehicle linear position offsets from speed adjustments.
     * Followers get pushed back, leaders get pushed forward, creating
     * gradual visual separation without position jumps or bearing flips.
     */
    private updateCollisionOffsets(
        speedAdjustments: globalThis.Map<string, number>,
        deltaMs: number
    ): void {
        const ESTIMATED_SPEED_MPS = 8.3; // ~30 km/h typical tram speed
        const MAX_OFFSET = 100; // max offset in meters
        const DECAY_RATE = 0.98; // per-frame decay when no longer adjusted
        const MIN_OFFSET = 0.1; // snap to 0 below this

        // Scale accumulation by timeSpeed so offsets keep up with faster vehicle movement.
        // At 10x speed, vehicles traverse 10x more route per frame, so offsets must grow 10x faster.
        const timeScale = this.timeSpeed;

        for (const [tripId, multiplier] of speedAdjustments) {
            const speedDiff = (multiplier - 1.0) * ESTIMATED_SPEED_MPS;
            const currentOffset = this.collisionOffsets.get(tripId) ?? 0;
            const newOffset = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET,
                currentOffset + speedDiff * (deltaMs / 1000) * timeScale
            ));
            this.collisionOffsets.set(tripId, newOffset);
        }

        // Decay offsets for vehicles no longer being adjusted
        for (const [tripId, offset] of this.collisionOffsets) {
            if (!speedAdjustments.has(tripId)) {
                const decayed = offset * DECAY_RATE;
                if (Math.abs(decayed) < MIN_OFFSET) {
                    this.collisionOffsets.delete(tripId);
                } else {
                    this.collisionOffsets.set(tripId, decayed);
                }
            }
        }
    }

    /**
     * Apply accumulated collision offsets to smoothed positions.
     * Shifts each vehicle along its own route by the offset distance,
     * keeping the original bearing to prevent model orientation flips.
     */
    private applyCollisionOffsets(
        allPositions: { position: VehiclePosition; routeId: number; routeColor: string }[]
    ): void {
        for (const { position: targetPosition, routeId } of allPositions) {
            const offset = this.collisionOffsets.get(targetPosition.tripId);
            if (!offset || offset === 0) continue;

            const smoothedPosition = this.smoothedPositions.get(targetPosition.tripId);
            if (!smoothedPosition || smoothedPosition.renderedLinearPosition === undefined) continue;

            const linearizedRoute = this.linearizedRoutes.get(routeId);
            if (!linearizedRoute) continue;

            const offsetLinearPosition = smoothedPosition.renderedLinearPosition + offset;
            const newPos = getPositionAtDistance(linearizedRoute, offsetLinearPosition);

            smoothedPosition.renderedLinearPosition = offsetLinearPosition;
            smoothedPosition.renderedLon = newPos.lon;
            smoothedPosition.renderedLat = newPos.lat;
            // Keep renderedBearing unchanged to prevent model orientation flips
        }
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
        this.collisionOffsets.clear();
        this.linearizedRoutes.clear();
    }
}
