/**
 * Feature Manager
 * Handles registration and state of vehicle rendering features
 */

import type { RenderPositionFeature, SpeedAdjustmentFeature, VehicleRenderContext, RenderPosition, VehicleFeature } from "./types";
import type { LinearizedRoute } from "../vehicleUtils";
import { simulatedStopsFeature } from "./simulatedStops";

const STORAGE_KEY = "vehicle-features";

interface StoredFeatureState {
    enabled: string[];
    known: string[];
}

export class FeatureManager {
    private allFeatures: VehicleFeature[] = [];
    private renderPositionFeatures: RenderPositionFeature[] = [];
    private speedAdjustmentFeatures: SpeedAdjustmentFeature[] = [];
    private enabledFeatures: Set<string>;
    /** Feature IDs that were in localStorage at load time. null = no stored state (first visit). */
    private knownFeatureIds: Set<string> | null;

    constructor() {
        const loaded = this.loadFeatureState();
        this.enabledFeatures = loaded.enabled;
        this.knownFeatureIds = loaded.known;

        // Register built-in features
        this.registerFeature(simulatedStopsFeature);
    }

    private loadFeatureState(): { enabled: Set<string>; known: Set<string> | null } {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);
                // New format: { enabled: [...], known: [...] }
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.enabled)) {
                    return {
                        enabled: new Set(parsed.enabled),
                        known: new Set(parsed.known ?? parsed.enabled),
                    };
                }
                // Old format: plain array of enabled IDs — migrate gracefully.
                // Treat enabled set as known set so new features get their defaults applied.
                if (Array.isArray(parsed)) {
                    return { enabled: new Set(parsed), known: new Set(parsed) };
                }
            }
        } catch {
            // Ignore parse errors
        }
        return { enabled: new Set(), known: null };
    }

    private saveFeatureState(): void {
        try {
            const state: StoredFeatureState = {
                enabled: [...this.enabledFeatures],
                known: this.allFeatures.map(f => f.id),
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch {
            // Ignore storage errors
        }
    }

    /**
     * Register a basic feature (just for toggle, no processing logic)
     */
    registerFeature(feature: VehicleFeature): void {
        this.allFeatures.push(feature);
        this.applyDefaultEnabled(feature);
    }

    /**
     * Register a render position feature
     */
    registerRenderPositionFeature(feature: RenderPositionFeature): void {
        this.allFeatures.push(feature);
        this.renderPositionFeatures.push(feature);
        this.applyDefaultEnabled(feature);
    }

    /**
     * Register a speed adjustment feature
     */
    registerSpeedAdjustmentFeature(feature: SpeedAdjustmentFeature): void {
        this.allFeatures.push(feature);
        this.speedAdjustmentFeatures.push(feature);
        this.applyDefaultEnabled(feature);
    }

    /**
     * Enable a feature by default if:
     * - No stored state exists (first visit), or
     * - The feature is new (not in the known set from previous sessions)
     */
    private applyDefaultEnabled(feature: VehicleFeature): void {
        if (!feature.defaultEnabled) return;

        if (this.knownFeatureIds === null || !this.knownFeatureIds.has(feature.id)) {
            this.enabledFeatures.add(feature.id);
        }
    }

    /**
     * Get all features (for UI display)
     */
    getAllFeatures(): Array<{ id: string; name: string; description: string; enabled: boolean }> {
        return this.allFeatures.map(f => ({
            id: f.id,
            name: f.name,
            description: f.description,
            enabled: this.isEnabled(f.id),
        }));
    }

    /**
     * Check if a feature is enabled
     */
    isEnabled(featureId: string): boolean {
        return this.enabledFeatures.has(featureId);
    }

    /**
     * Enable or disable a feature
     */
    setEnabled(featureId: string, enabled: boolean): void {
        if (enabled) {
            this.enabledFeatures.add(featureId);
        } else {
            this.enabledFeatures.delete(featureId);
        }
        this.saveFeatureState();
    }

    /**
     * Toggle a feature on/off
     */
    toggleFeature(featureId: string): boolean {
        const newState = !this.isEnabled(featureId);
        this.setEnabled(featureId, newState);
        return newState;
    }

    /**
     * Process render positions through all enabled render position features
     */
    processRenderPositions(
        vehicles: VehicleRenderContext[],
        renderPositions: Map<string, RenderPosition>,
        linearizedRoutes: Map<number, LinearizedRoute>
    ): void {
        for (const feature of this.renderPositionFeatures) {
            if (this.isEnabled(feature.id)) {
                feature.processPositions(vehicles, renderPositions, linearizedRoutes);
            }
        }
    }

    /**
     * Compute per-vehicle speed multipliers from all enabled speed adjustment features.
     * Returns a map of tripId -> combined speed multiplier.
     */
    computeSpeedAdjustments(
        vehicles: VehicleRenderContext[],
        linearizedRoutes: Map<number, LinearizedRoute>
    ): Map<string, number> {
        const combined = new Map<string, number>();

        for (const feature of this.speedAdjustmentFeatures) {
            if (!this.isEnabled(feature.id)) continue;

            const adjustments = feature.computeSpeedAdjustments(vehicles, linearizedRoutes);
            for (const [tripId, multiplier] of adjustments) {
                const existing = combined.get(tripId) ?? 1.0;
                // Multiply speed adjustments from different features
                combined.set(tripId, existing * multiplier);
            }
        }

        return combined;
    }
}

// Singleton instance
export const featureManager = new FeatureManager();
