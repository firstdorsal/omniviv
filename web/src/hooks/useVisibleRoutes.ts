import { useCallback, useEffect, useRef, useState } from "react";
import type { VisibleRoute } from "../api";
import { getApiClient } from "../apiClient";

interface Viewport {
    bbox: [number, number, number, number];
    zoom: number;
}

export interface UseVisibleRoutesOptions {
    /** Ref updated by Map's onViewportChange — avoids re-render storms */
    viewportRef: React.RefObject<Viewport | null>;
    /** Whether vehicle display is enabled */
    enabled: boolean;
    /** Route IDs that must always be included (tracked/followed vehicles) */
    alwaysIncludeRouteIds: number[];
    /** Maximum routes to return (default 100, matching backend MAX_ROUTE_SUBSCRIPTIONS) */
    maxRoutes?: number;
    /** Debounce delay in ms (default 300). Exposed for testing. */
    debounceMs?: number;
    /** Poll interval in ms (default 300). Exposed for testing. */
    pollIntervalMs?: number;
}

export interface UseVisibleRoutesResult {
    routeIds: number[];
    /** Map of routeId → color from visible routes response (OSM route color) */
    routeIdColors: Map<number, string>;
    /** Map of routeId → route_type (e.g. "tram", "bus") from visible routes response */
    routeIdTypes: Map<number, string>;
    isLoading: boolean;
}

const DEFAULT_MAX_ROUTES = 100;
const DEBOUNCE_MS = 300;
const POLL_INTERVAL_MS = 300;

function arraysEqual(a: number[], b: number[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * Hook that fetches visible route IDs based on the current map viewport.
 * Uses a ref for viewport data to avoid re-rendering App on every pan/zoom.
 * Debounces API calls and cancels stale requests via AbortController.
 * Preserves last-known-good route IDs on API errors.
 */
export function useVisibleRoutes({
    viewportRef,
    enabled,
    alwaysIncludeRouteIds,
    maxRoutes = DEFAULT_MAX_ROUTES,
    debounceMs = DEBOUNCE_MS,
    pollIntervalMs = POLL_INTERVAL_MS,
}: UseVisibleRoutesOptions): UseVisibleRoutesResult {
    const [routeIds, setRouteIds] = useState<number[]>([]);
    const [routeIdColors, setRouteIdColors] = useState(() => new Map<number, string>());
    const [routeIdTypes, setRouteIdTypes] = useState(() => new Map<number, string>());
    const [isLoading, setIsLoading] = useState(false);

    const abortControllerRef = useRef<AbortController | null>(null);
    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastViewportRef = useRef<string | null>(null);
    const lastRouteIdsRef = useRef<number[]>([]);

    const fetchVisibleRoutes = useCallback(async (viewport: Viewport) => {
        // Cancel any in-flight request
        abortControllerRef.current?.abort();
        const controller = new AbortController();
        abortControllerRef.current = controller;

        setIsLoading(true);
        try {
            const response = await getApiClient().api.getVisibleRoutes(
                { bbox: [...viewport.bbox], zoom: viewport.zoom },
                { signal: controller.signal },
            );

            if (controller.signal.aborted) return;

            const visibleRoutes: VisibleRoute[] = response.data.routes;
            const alwaysSet = new Set(alwaysIncludeRouteIds);

            // Build merged list: alwaysInclude first, then visible sorted by min_zoom
            const visibleSorted = visibleRoutes
                .filter((r) => !alwaysSet.has(r.osm_id))
                .sort((a, b) => a.min_zoom - b.min_zoom)
                .map((r) => r.osm_id);

            const merged = [...alwaysIncludeRouteIds, ...visibleSorted];
            const truncated = merged.slice(0, maxRoutes);
            const sorted = truncated.toSorted((a, b) => a - b);

            // Build routeId → color and routeId → type maps from the response
            const colorMap = new Map<number, string>();
            const typeMap = new Map<number, string>();
            for (const route of visibleRoutes) {
                if (route.color) {
                    colorMap.set(route.osm_id, route.color);
                }
                if (route.route_type) {
                    typeMap.set(route.osm_id, route.route_type);
                }
            }
            setRouteIdColors(colorMap);
            setRouteIdTypes(typeMap);

            // Only update route IDs state if the set actually changed
            if (!arraysEqual(sorted, lastRouteIdsRef.current)) {
                lastRouteIdsRef.current = sorted;
                setRouteIds(sorted);
            }
        } catch (error: unknown) {
            if (error instanceof DOMException && error.name === "AbortError") return;
            console.warn("Failed to fetch visible routes, keeping previous data:", error);
            // Preserve last-known-good route IDs (don't reset to [])
        } finally {
            if (!controller.signal.aborted) {
                setIsLoading(false);
            }
        }
    }, [alwaysIncludeRouteIds, maxRoutes]);

    // Poll the viewport ref periodically and debounce API calls
    useEffect(() => {
        if (!enabled) {
            // When disabled, clear route IDs but keep cache for re-enable
            if (lastRouteIdsRef.current.length > 0) {
                lastRouteIdsRef.current = [];
                setRouteIds([]);
            }
            return;
        }

        // If viewport is null but we have alwaysInclude IDs, return those immediately
        if (!viewportRef.current && alwaysIncludeRouteIds.length > 0) {
            const sorted = [...alwaysIncludeRouteIds].sort((a, b) => a - b);
            if (!arraysEqual(sorted, lastRouteIdsRef.current)) {
                lastRouteIdsRef.current = sorted;
                setRouteIds(sorted);
            }
        }

        const intervalId = setInterval(() => {
            const viewport = viewportRef.current;
            if (!viewport) return;

            // Check if viewport changed since last check
            const key = `${viewport.bbox.join(",")},${viewport.zoom}`;
            if (key === lastViewportRef.current) return;
            lastViewportRef.current = key;

            // Debounce the actual API call
            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
            }
            debounceTimerRef.current = setTimeout(() => {
                fetchVisibleRoutes(viewport);
            }, debounceMs);
        }, pollIntervalMs);

        return () => {
            clearInterval(intervalId);
            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
            }
            abortControllerRef.current?.abort();
        };
    }, [enabled, viewportRef, alwaysIncludeRouteIds, fetchVisibleRoutes]);

    return { routeIds, routeIdColors, routeIdTypes, isLoading };
}
