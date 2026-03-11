/**
 * Common types for vehicle rendering features
 */

import type { SmoothedVehiclePosition, LinearizedRoute } from "../vehicleUtils";

export interface VehicleRenderContext {
    tripId: string;
    routeId: number;
    linearPosition: number;
    smoothedPosition: SmoothedVehiclePosition;
}

export interface RenderPosition {
    lon: number;
    lat: number;
    bearing: number;
}

export interface VehicleFeature {
    /** Unique identifier for the feature */
    id: string;
    /** Display name for UI */
    name: string;
    /** Description of what the feature does */
    description: string;
    /** Whether the feature is enabled by default */
    defaultEnabled: boolean;
}

export interface RenderPositionFeature extends VehicleFeature {
    /**
     * Process render positions for all vehicles.
     * Called each frame to potentially modify where vehicles are rendered.
     */
    processPositions(
        vehicles: VehicleRenderContext[],
        renderPositions: Map<string, RenderPosition>,
        linearizedRoutes: Map<number, LinearizedRoute>
    ): void;
}

export interface SpeedAdjustmentFeature extends VehicleFeature {
    /**
     * Compute per-vehicle speed multipliers for the next smoothing step.
     * A multiplier < 1.0 slows the vehicle down, > 1.0 speeds it up.
     * Called each frame BEFORE position smoothing.
     */
    computeSpeedAdjustments(
        vehicles: VehicleRenderContext[],
        linearizedRoutes: Map<number, LinearizedRoute>
    ): Map<string, number>;
}
