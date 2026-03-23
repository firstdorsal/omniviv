import { useCallback, useEffect, useRef, useState } from "react";
import type { Vehicle } from "../api";
import { getConfig } from "../config";

function getWsUrl(): string {
    return getConfig().apiUrl.replace(/^http/, "ws");
}

// Frontend interface (camelCase)
export interface RouteVehicles {
    routeId: number;
    lineNumber: string | null;
    vehicles: Vehicle[];
}

// WebSocket message format (snake_case from backend)
interface WsRouteVehicles {
    route_id: number;
    line_number: string | null;
    vehicles: Vehicle[];
}

// Incremental change types
interface VehicleChangeAdd {
    action: "add";
    route_id: number;
    vehicle: Vehicle;
}

interface VehicleChangeUpdate {
    action: "update";
    route_id: number;
    vehicle: Vehicle;
}

interface VehicleChangeRemove {
    action: "remove";
    route_id: number;
    trip_id: string;
}

type VehicleChange = VehicleChangeAdd | VehicleChangeUpdate | VehicleChangeRemove;

interface ServerMessageConnected {
    type: "connected";
    message: string;
}

interface ServerMessageVehicles {
    type: "vehicles";
    routes: WsRouteVehicles[];
}

interface ServerMessageVehiclesUpdate {
    type: "vehicles_update";
    changes: VehicleChange[];
}

interface ServerMessageError {
    type: "error";
    message: string;
}

type ServerMessage = ServerMessageConnected | ServerMessageVehicles | ServerMessageVehiclesUpdate | ServerMessageError;

// Transform WebSocket data to frontend format
function transformRouteVehicles(wsData: WsRouteVehicles[]): RouteVehicles[] {
    return wsData.map(r => ({
        routeId: r.route_id,
        lineNumber: r.line_number,
        vehicles: r.vehicles,
    }));
}

// Apply incremental changes to existing state
function applyChanges(current: RouteVehicles[], changes: VehicleChange[]): RouteVehicles[] {
    // Collect which route IDs are affected by changes
    const affectedRoutes = new Set(changes.map(c => c.route_id));

    // Only copy routes that have changes; reuse unchanged route objects
    const result = current.map(r =>
        affectedRoutes.has(r.routeId)
            ? { ...r, vehicles: [...r.vehicles] }
            : r
    );

    for (const change of changes) {
        const routeIndex = result.findIndex(r => r.routeId === change.route_id);

        switch (change.action) {
            case "add": {
                if (routeIndex >= 0) {
                    result[routeIndex].vehicles.push(change.vehicle);
                }
                break;
            }
            case "update": {
                if (routeIndex >= 0) {
                    const vehicleIndex = result[routeIndex].vehicles.findIndex(
                        v => v.trip_id === change.vehicle.trip_id
                    );
                    if (vehicleIndex >= 0) {
                        result[routeIndex].vehicles[vehicleIndex] = change.vehicle;
                    } else {
                        result[routeIndex].vehicles.push(change.vehicle);
                    }
                }
                break;
            }
            case "remove": {
                if (routeIndex >= 0) {
                    result[routeIndex].vehicles = result[routeIndex].vehicles.filter(
                        v => v.trip_id !== change.trip_id
                    );
                }
                break;
            }
        }
    }

    return result;
}

interface UseVehicleUpdatesOptions {
    enabled: boolean;
    routeIds: number[];
    /** Optional reference time for time simulation (ISO 8601 string) */
    referenceTime?: string;
    /** Called with full vehicle data on initial subscribe */
    onFullData: (routes: RouteVehicles[]) => void;
    /** Called with the updated state after applying incremental changes */
    onIncrementalUpdate: (updater: (current: RouteVehicles[]) => RouteVehicles[]) => void;
    onFallbackFetch: () => void;
    fallbackInterval?: number;
}

interface UseVehicleUpdatesResult {
    isConnected: boolean;
    usingWebSocket: boolean;
}

export function useVehicleUpdates({
    enabled,
    routeIds,
    referenceTime,
    onFullData,
    onIncrementalUpdate,
    onFallbackFetch,
    fallbackInterval = 5000,
}: UseVehicleUpdatesOptions): UseVehicleUpdatesResult {
    const [isConnected, setIsConnected] = useState(false);
    const [usingWebSocket, setUsingWebSocket] = useState(false);
    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimeoutRef = useRef<number | null>(null);
    const fallbackIntervalRef = useRef<number | null>(null);

    // Stable references to callbacks
    const onFullDataRef = useRef(onFullData);
    onFullDataRef.current = onFullData;
    const onIncrementalUpdateRef = useRef(onIncrementalUpdate);
    onIncrementalUpdateRef.current = onIncrementalUpdate;
    const onFallbackFetchRef = useRef(onFallbackFetch);
    onFallbackFetchRef.current = onFallbackFetch;
    const routeIdsRef = useRef(routeIds);
    routeIdsRef.current = routeIds;
    const referenceTimeRef = useRef(referenceTime);
    referenceTimeRef.current = referenceTime;

    // Send subscription when route IDs change
    const sendSubscription = useCallback(() => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN && routeIdsRef.current.length > 0) {
            const msg: Record<string, unknown> = {
                type: "subscribe",
                route_ids: routeIdsRef.current,
            };
            if (referenceTimeRef.current) {
                msg.reference_time = referenceTimeRef.current;
            }
            ws.send(JSON.stringify(msg));
        }
    }, []);

    const connectWebSocket = useCallback(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) return;

        try {
            const ws = new WebSocket(`${getWsUrl()}/api/ws/vehicles`);
            wsRef.current = ws;

            ws.onopen = () => {
                setIsConnected(true);
                setUsingWebSocket(true);
                // Clear fallback polling when WebSocket connects
                if (fallbackIntervalRef.current) {
                    clearInterval(fallbackIntervalRef.current);
                    fallbackIntervalRef.current = null;
                }
                // Subscribe to routes
                sendSubscription();
            };

            ws.onmessage = (event) => {
                try {
                    const message: ServerMessage = JSON.parse(event.data);
                    if (message.type === "vehicles" && message.routes) {
                        // Full data on initial subscribe
                        onFullDataRef.current(transformRouteVehicles(message.routes));
                    } else if (message.type === "vehicles_update" && message.changes) {
                        // Incremental update with only changes
                        onIncrementalUpdateRef.current(current => applyChanges(current, message.changes));
                    }
                } catch {
                    // Ignore parse errors
                }
            };

            ws.onclose = () => {
                setIsConnected(false);
                wsRef.current = null;

                // Schedule reconnect attempt
                if (enabled) {
                    reconnectTimeoutRef.current = window.setTimeout(() => {
                        connectWebSocket();
                    }, 3000);
                }

                // Start fallback polling
                if (enabled && !fallbackIntervalRef.current) {
                    setUsingWebSocket(false);
                    fallbackIntervalRef.current = window.setInterval(() => {
                        onFallbackFetchRef.current();
                    }, fallbackInterval);
                }
            };

            ws.onerror = () => {
                // Error will trigger onclose
            };
        } catch {
            // WebSocket creation failed, use fallback
            setUsingWebSocket(false);
            if (enabled && !fallbackIntervalRef.current) {
                fallbackIntervalRef.current = window.setInterval(() => {
                    onFallbackFetchRef.current();
                }, fallbackInterval);
            }
        }
    }, [enabled, fallbackInterval, sendSubscription]);

    // Effect to connect/disconnect
    useEffect(() => {
        if (!enabled) {
            // Cleanup when disabled
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
                reconnectTimeoutRef.current = null;
            }
            if (fallbackIntervalRef.current) {
                clearInterval(fallbackIntervalRef.current);
                fallbackIntervalRef.current = null;
            }
            setIsConnected(false);
            setUsingWebSocket(false);
            return;
        }

        connectWebSocket();

        return () => {
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
                reconnectTimeoutRef.current = null;
            }
            if (fallbackIntervalRef.current) {
                clearInterval(fallbackIntervalRef.current);
                fallbackIntervalRef.current = null;
            }
        };
    }, [enabled, connectWebSocket]);

    // Effect to re-subscribe when route IDs or reference time change
    useEffect(() => {
        if (isConnected && routeIds.length > 0) {
            sendSubscription();
        }
    }, [isConnected, routeIds, referenceTime, sendSubscription]);

    return { isConnected, usingWebSocket };
}
