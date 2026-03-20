/**
 * Vehicle Lifecycle Monitor
 *
 * Tracks vehicle appearances, disappearances, teleports, status changes, and
 * other lifecycle events to automatically detect rendering anomalies that are
 * hard to catch visually.
 *
 * Usage: The monitor is integrated into VehicleRenderer and exposes its API on
 * `window.__vehicleMonitor` for console debugging:
 *
 *   __vehicleMonitor.getStats()        — summary of tracked vehicles and anomalies
 *   __vehicleMonitor.getSpeedStats()   — speed diagnostics for all visible vehicles
 *   __vehicleMonitor.getAnomalies()    — list of detected anomalies
 *   __vehicleMonitor.getVehicle("id")  — full history for a specific vehicle
 *   __vehicleMonitor.getAll()          — all tracked vehicle states
 *   __vehicleMonitor.clear()           — reset all tracking data
 */

/** Anomaly types the monitor can detect. */
export type AnomalyType =
    | "flicker"            // disappeared and reappeared within FLICKER_THRESHOLD_MS
    | "teleport"           // position jumped > TELEPORT_THRESHOLD_M between frames
    | "ghost_removal"      // disappeared while status was not "completed"
    | "stuck"              // in_transit but hasn't moved > STUCK_THRESHOLD_M in STUCK_TIME_MS
    | "rapid_status_change" // status changed > RAPID_STATUS_CHANGES_LIMIT times within RAPID_STATUS_WINDOW_MS
    | "speed_anomaly";     // rendered speed exceeds schedule speed by SPEED_ANOMALY_RATIO

export interface Anomaly {
    type: AnomalyType;
    tripId: string;
    timestamp: number;
    details: string;
}

export interface VehicleSnapshot {
    lon: number;
    lat: number;
    linearPosition: number;
    status: string;
    routeId: number;
    /** Schedule-derived speed: distToNextStop / (msToNextStop / 1000). Undefined if not in transit or missing schedule. */
    scheduleSpeedMps?: number;
    /** Remaining distance to next stop in meters. */
    distToNextStop?: number;
    /** Remaining time to next stop in milliseconds. */
    msToNextStop?: number;
}

interface TrackedVehicle {
    tripId: string;
    firstSeen: number;
    lastSeen: number;
    lastSnapshot: VehicleSnapshot;
    isVisible: boolean;
    /** Timestamp when the vehicle last disappeared (0 if currently visible). */
    disappearedAt: number;
    /** Last status before disappearing (for ghost removal detection). */
    lastStatusBeforeDisappear: string;
    /** Count of disappearances. */
    disappearCount: number;
    /** Count of flickers (disappeared + reappeared within threshold). */
    flickerCount: number;
    /** Count of teleports. */
    teleportCount: number;
    /** Recent status changes for rapid-change detection. */
    recentStatusChanges: number[];
    /** Position at last movement check (for stuck detection). */
    stuckCheckPosition: number;
    stuckCheckTime: number;
    /** Latest computed rendered speed in m/s (from consecutive linearPosition readings). */
    renderedSpeedMps: number;
    /** Latest schedule-derived speed in m/s (from snapshot). */
    lastScheduleSpeedMps: number;
    /** Count of speed anomalies. */
    speedAnomalyCount: number;
}

// --- Thresholds ---

/** If a vehicle reappears within this window, it's a flicker. */
const FLICKER_THRESHOLD_MS = 5_000;

/** Position jump larger than this between consecutive frames is a teleport (meters).
 * With 300ms smoothing half-life, a 700m GTFS-RT correction produces ~26m per-frame
 * deltas that smoothly decay — this is expected catch-up, not teleporting.
 * 80m threshold catches only genuine smoothing bypasses or major compound effects. */
const TELEPORT_THRESHOLD_M = 80;

/** Vehicle considered stuck if it moves less than this in STUCK_TIME_MS. */
const STUCK_THRESHOLD_M = 2;
const STUCK_TIME_MS = 30_000;

/** More than this many status changes in the window = rapid status change. */
const RAPID_STATUS_CHANGES_LIMIT = 5;
const RAPID_STATUS_WINDOW_MS = 10_000;

/** Rendered speed must exceed schedule speed by this ratio to flag an anomaly. */
const SPEED_ANOMALY_RATIO = 2.0;
/** Minimum rendered speed to consider for speed anomaly (avoids noise at low speeds). */
const SPEED_ANOMALY_MIN_MPS = 5;

/** Maximum number of anomalies to retain (ring buffer). */
const MAX_ANOMALIES = 500;

/** Maximum number of tracked vehicles to retain after they disappear. */
const MAX_GONE_VEHICLES = 200;

export class VehicleLifecycleMonitor {
    private vehicles = new Map<string, TrackedVehicle>();
    private anomalies: Anomaly[] = [];
    private frameCount = 0;
    private lastUpdateTime = 0;

    /** When false, update() is a no-op — no tracking, no anomaly detection. */
    private _enabled = false;

    /** Callbacks invoked on each new anomaly (for real-time logging). */
    private onAnomaly: ((a: Anomaly) => void) | null = null;

    setAnomalyCallback(cb: ((a: Anomaly) => void) | null): void {
        this.onAnomaly = cb;
    }

    get enabled(): boolean {
        return this._enabled;
    }

    set enabled(value: boolean) {
        this._enabled = value;
    }

    /**
     * Called each frame with the set of vehicles that are currently active
     * (present in activeTripIds / rendered this frame).
     */
    update(activeVehicles: Map<string, VehicleSnapshot>): void {
        if (!this._enabled) return;
        const now = performance.now();
        this.frameCount++;
        this.lastUpdateTime = now;

        // --- Check for disappearances ---
        for (const [tripId, tracked] of this.vehicles) {
            if (!tracked.isVisible) continue;
            if (!activeVehicles.has(tripId)) {
                // Vehicle just disappeared
                tracked.isVisible = false;
                tracked.disappearedAt = now;
                tracked.lastStatusBeforeDisappear = tracked.lastSnapshot.status;
                tracked.disappearCount++;

                // Ghost removal: disappeared without "completed" status
                if (tracked.lastSnapshot.status !== "completed") {
                    this.addAnomaly({
                        type: "ghost_removal",
                        tripId,
                        timestamp: now,
                        details: `Disappeared with status "${tracked.lastSnapshot.status}" after ${((now - tracked.firstSeen) / 1000).toFixed(1)}s visible. Route ${tracked.lastSnapshot.routeId}, pos ${tracked.lastSnapshot.linearPosition.toFixed(0)}m.`,
                    });
                }
            }
        }

        // --- Process active vehicles ---
        for (const [tripId, snapshot] of activeVehicles) {
            const existing = this.vehicles.get(tripId);

            if (!existing) {
                // New vehicle — first appearance
                this.vehicles.set(tripId, {
                    tripId,
                    firstSeen: now,
                    lastSeen: now,
                    lastSnapshot: snapshot,
                    isVisible: true,
                    disappearedAt: 0,
                    lastStatusBeforeDisappear: "",
                    disappearCount: 0,
                    flickerCount: 0,
                    teleportCount: 0,
                    recentStatusChanges: [],
                    stuckCheckPosition: snapshot.linearPosition,
                    stuckCheckTime: now,
                    renderedSpeedMps: 0,
                    lastScheduleSpeedMps: 0,
                    speedAnomalyCount: 0,
                });
                continue;
            }

            // Vehicle was previously tracked
            if (!existing.isVisible) {
                // Reappearance — check for flicker
                const goneMs = now - existing.disappearedAt;
                existing.isVisible = true;

                if (goneMs < FLICKER_THRESHOLD_MS) {
                    existing.flickerCount++;
                    this.addAnomaly({
                        type: "flicker",
                        tripId,
                        timestamp: now,
                        details: `Reappeared after ${goneMs.toFixed(0)}ms (flicker #${existing.flickerCount}). Status was "${existing.lastStatusBeforeDisappear}", now "${snapshot.status}". Route ${snapshot.routeId}.`,
                    });
                }
            }

            // --- Teleport detection ---
            const prevSnap = existing.lastSnapshot;
            const distM = Math.abs(snapshot.linearPosition - prevSnap.linearPosition);
            // Only flag teleport if on the same route (route change naturally causes a jump)
            if (snapshot.routeId === prevSnap.routeId && distM > TELEPORT_THRESHOLD_M) {
                existing.teleportCount++;
                this.addAnomaly({
                    type: "teleport",
                    tripId,
                    timestamp: now,
                    details: `Jumped ${distM.toFixed(0)}m on route ${snapshot.routeId} (${prevSnap.linearPosition.toFixed(0)} → ${snapshot.linearPosition.toFixed(0)}). Teleport #${existing.teleportCount}.`,
                });
            }

            // --- Status change tracking ---
            if (snapshot.status !== prevSnap.status) {
                existing.recentStatusChanges.push(now);
                // Prune old entries
                existing.recentStatusChanges = existing.recentStatusChanges.filter(
                    t => now - t < RAPID_STATUS_WINDOW_MS
                );
                if (existing.recentStatusChanges.length > RAPID_STATUS_CHANGES_LIMIT) {
                    this.addAnomaly({
                        type: "rapid_status_change",
                        tripId,
                        timestamp: now,
                        details: `${existing.recentStatusChanges.length} status changes in ${(RAPID_STATUS_WINDOW_MS / 1000).toFixed(0)}s. Latest: "${prevSnap.status}" → "${snapshot.status}". Route ${snapshot.routeId}.`,
                    });
                }
            }

            // --- Stuck detection ---
            if (snapshot.status === "in_transit" || snapshot.status === "approaching") {
                const movedSinceCheck = Math.abs(snapshot.linearPosition - existing.stuckCheckPosition);
                if (now - existing.stuckCheckTime > STUCK_TIME_MS) {
                    if (movedSinceCheck < STUCK_THRESHOLD_M) {
                        this.addAnomaly({
                            type: "stuck",
                            tripId,
                            timestamp: now,
                            details: `In "${snapshot.status}" but moved only ${movedSinceCheck.toFixed(1)}m in ${((now - existing.stuckCheckTime) / 1000).toFixed(0)}s. Route ${snapshot.routeId}, pos ${snapshot.linearPosition.toFixed(0)}m.`,
                        });
                    }
                    // Reset check window
                    existing.stuckCheckPosition = snapshot.linearPosition;
                    existing.stuckCheckTime = now;
                }
            } else {
                // Reset stuck check when at stop or waiting (not expected to move)
                existing.stuckCheckPosition = snapshot.linearPosition;
                existing.stuckCheckTime = now;
            }

            // --- Speed anomaly detection ---
            const frameDeltaMs = now - existing.lastSeen;
            if (frameDeltaMs > 0 && existing.isVisible) {
                const frameDeltaSec = frameDeltaMs / 1000;
                const renderedSpeed = Math.abs(snapshot.linearPosition - prevSnap.linearPosition) / frameDeltaSec;
                existing.renderedSpeedMps = renderedSpeed;

                if (snapshot.scheduleSpeedMps !== undefined) {
                    existing.lastScheduleSpeedMps = snapshot.scheduleSpeedMps;
                }

                // Flag if rendered speed significantly exceeds schedule speed
                if (snapshot.scheduleSpeedMps !== undefined &&
                    snapshot.scheduleSpeedMps > 0 &&
                    renderedSpeed > SPEED_ANOMALY_MIN_MPS &&
                    renderedSpeed > snapshot.scheduleSpeedMps * SPEED_ANOMALY_RATIO) {
                    existing.speedAnomalyCount++;
                    this.addAnomaly({
                        type: "speed_anomaly",
                        tripId,
                        timestamp: now,
                        details: `Rendered at ${renderedSpeed.toFixed(1)} m/s but schedule says ${snapshot.scheduleSpeedMps.toFixed(1)} m/s (${(renderedSpeed / snapshot.scheduleSpeedMps).toFixed(1)}x). Route ${snapshot.routeId}, pos ${snapshot.linearPosition.toFixed(0)}m.`,
                    });
                }
            }

            existing.lastSeen = now;
            existing.lastSnapshot = snapshot;
        }

        // --- Prune long-gone vehicles to prevent memory leak ---
        this.pruneGoneVehicles(now);
    }

    // --- Query API ---

    getStats(): {
        totalTracked: number;
        currentlyVisible: number;
        totalAnomalies: number;
        anomaliesByType: Record<string, number>;
        topFlickers: Array<{ tripId: string; count: number }>;
        topTeleporters: Array<{ tripId: string; count: number }>;
        frameCount: number;
    } {
        let visible = 0;
        const flickers: Array<{ tripId: string; count: number }> = [];
        const teleporters: Array<{ tripId: string; count: number }> = [];

        for (const v of this.vehicles.values()) {
            if (v.isVisible) visible++;
            if (v.flickerCount > 0) flickers.push({ tripId: v.tripId, count: v.flickerCount });
            if (v.teleportCount > 0) teleporters.push({ tripId: v.tripId, count: v.teleportCount });
        }

        flickers.sort((a, b) => b.count - a.count);
        teleporters.sort((a, b) => b.count - a.count);

        const byType: Record<string, number> = {};
        for (const a of this.anomalies) {
            byType[a.type] = (byType[a.type] ?? 0) + 1;
        }

        return {
            totalTracked: this.vehicles.size,
            currentlyVisible: visible,
            totalAnomalies: this.anomalies.length,
            anomaliesByType: byType,
            topFlickers: flickers.slice(0, 10),
            topTeleporters: teleporters.slice(0, 10),
            frameCount: this.frameCount,
        };
    }

    getAnomalies(limit = 50): Anomaly[] {
        return this.anomalies.slice(-limit);
    }

    getAnomaliesByType(type: AnomalyType, limit = 50): Anomaly[] {
        return this.anomalies.filter(a => a.type === type).slice(-limit);
    }

    getVehicle(tripId: string): TrackedVehicle | undefined {
        return this.vehicles.get(tripId);
    }

    getAll(): Map<string, TrackedVehicle> {
        return this.vehicles;
    }

    /**
     * Get speed diagnostics for all currently visible vehicles.
     * Useful for console debugging: __vehicleMonitor.getSpeedStats()
     */
    getSpeedStats(): Array<{
        tripId: string;
        routeId: number;
        renderedSpeedMps: number;
        renderedSpeedKmh: number;
        scheduleSpeedMps: number;
        scheduleSpeedKmh: number;
        speedRatio: number;
        distToNextStop: number | undefined;
        msToNextStop: number | undefined;
        speedAnomalyCount: number;
    }> {
        const result: ReturnType<VehicleLifecycleMonitor["getSpeedStats"]> = [];

        for (const v of this.vehicles.values()) {
            if (!v.isVisible) continue;

            const scheduleMps = v.lastScheduleSpeedMps;
            result.push({
                tripId: v.tripId,
                routeId: v.lastSnapshot.routeId,
                renderedSpeedMps: v.renderedSpeedMps,
                renderedSpeedKmh: v.renderedSpeedMps * 3.6,
                scheduleSpeedMps: scheduleMps,
                scheduleSpeedKmh: scheduleMps * 3.6,
                speedRatio: scheduleMps > 0 ? v.renderedSpeedMps / scheduleMps : 0,
                distToNextStop: v.lastSnapshot.distToNextStop,
                msToNextStop: v.lastSnapshot.msToNextStop,
                speedAnomalyCount: v.speedAnomalyCount,
            });
        }

        result.sort((a, b) => b.renderedSpeedKmh - a.renderedSpeedKmh);
        return result;
    }

    clear(): void {
        this.vehicles.clear();
        this.anomalies = [];
        this.frameCount = 0;
    }

    // --- Internals ---

    private addAnomaly(anomaly: Anomaly): void {
        this.anomalies.push(anomaly);
        if (this.anomalies.length > MAX_ANOMALIES) {
            this.anomalies = this.anomalies.slice(-MAX_ANOMALIES);
        }
        this.onAnomaly?.(anomaly);
    }

    private pruneGoneVehicles(now: number): void {
        const goneVehicles: Array<{ tripId: string; disappearedAt: number }> = [];
        for (const v of this.vehicles.values()) {
            if (!v.isVisible && v.disappearedAt > 0) {
                goneVehicles.push({ tripId: v.tripId, disappearedAt: v.disappearedAt });
            }
        }
        if (goneVehicles.length > MAX_GONE_VEHICLES) {
            // Remove oldest gone vehicles
            goneVehicles.sort((a, b) => a.disappearedAt - b.disappearedAt);
            const toRemove = goneVehicles.length - MAX_GONE_VEHICLES;
            for (let i = 0; i < toRemove; i++) {
                this.vehicles.delete(goneVehicles[i].tripId);
            }
        }
    }
}

/**
 * Install the monitor on the global window object for console debugging.
 */
export function installMonitorGlobal(monitor: VehicleLifecycleMonitor): void {
    (window as any).__vehicleMonitor = {
        getStats: () => monitor.getStats(),
        getSpeedStats: () => monitor.getSpeedStats(),
        getAnomalies: (limit?: number) => monitor.getAnomalies(limit),
        getAnomaliesByType: (type: AnomalyType, limit?: number) => monitor.getAnomaliesByType(type, limit),
        getVehicle: (tripId: string) => monitor.getVehicle(tripId),
        getAll: () => Object.fromEntries(monitor.getAll()),
        clear: () => monitor.clear(),
        enable: () => { monitor.enabled = true; },
        disable: () => { monitor.enabled = false; },
        isEnabled: () => monitor.enabled,
    };
}
