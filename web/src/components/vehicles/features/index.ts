export * from "./types";
export * from "./FeatureManager";
export { simulatedStopsFeature, shouldStopAtStation, getDwellTimeMs } from "./simulatedStops";

// Register collision avoidance as a speed adjustment feature.
// This side-effect registration breaks a circular dependency:
// collisionAvoidance.ts imports vehicleUtils.ts, which imports from ./features/FeatureManager
// directly. If FeatureManager.ts imported collisionAvoidance.ts, the cycle would be:
// FeatureManager → collisionAvoidance → vehicleUtils → FeatureManager.
// By registering here (in the barrel), it runs after both modules are fully loaded.
// INVARIANT: Any file that imports this barrel must NOT be imported by collisionAvoidance.ts.
import { featureManager } from "./FeatureManager";
import { collisionAvoidanceFeature } from "./collisionAvoidance";
featureManager.registerSpeedAdjustmentFeature(collisionAvoidanceFeature);
