import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useVisibleRoutes } from "./useVisibleRoutes";
import { createRef } from "react";

// Mock the API client
const mockGetVisibleRoutes = vi.fn();

vi.mock("../apiClient", () => ({
    getApiClient: () => ({
        api: {
            getVisibleRoutes: mockGetVisibleRoutes,
        },
    }),
}));

// Use very short intervals for tests (real timers, fast execution)
const TEST_OPTS = { debounceMs: 10, pollIntervalMs: 10 };

function makeViewportRef(bbox: [number, number, number, number] = [10.87, 48.35, 10.92, 48.38], zoom = 14) {
    const ref = createRef<{ bbox: [number, number, number, number]; zoom: number } | null>();
    (ref as { current: unknown }).current = { bbox, zoom };
    return ref;
}

function makeNullRef() {
    const ref = createRef<{ bbox: [number, number, number, number]; zoom: number } | null>();
    (ref as { current: unknown }).current = null;
    return ref;
}

function makeApiResponse(routes: { osm_id: number; min_zoom: number; route_type?: string }[]) {
    return {
        data: {
            routes: routes.map((r) => ({
                osm_id: r.osm_id,
                name: null,
                ref: null,
                route_type: r.route_type ?? "tram",
                color: null,
                min_zoom: r.min_zoom,
                segments: [],
            })),
        },
    };
}

describe("useVisibleRoutes", () => {
    beforeEach(() => {
        mockGetVisibleRoutes.mockReset();
    });

    it("returns empty when disabled", () => {
        const viewportRef = makeViewportRef();
        const { result } = renderHook(() =>
            useVisibleRoutes({ viewportRef, enabled: false, alwaysIncludeRouteIds: [], ...TEST_OPTS })
        );
        expect(result.current.routeIds).toEqual([]);
    });

    it("returns empty when viewport is null and no alwaysInclude", () => {
        const viewportRef = makeNullRef();
        const { result } = renderHook(() =>
            useVisibleRoutes({ viewportRef, enabled: true, alwaysIncludeRouteIds: [], ...TEST_OPTS })
        );
        expect(result.current.routeIds).toEqual([]);
    });

    it("returns alwaysIncludeRouteIds immediately when viewport is null", async () => {
        const viewportRef = makeNullRef();
        const { result } = renderHook(() =>
            useVisibleRoutes({ viewportRef, enabled: true, alwaysIncludeRouteIds: [42, 7], ...TEST_OPTS })
        );

        await waitFor(() => {
            expect(result.current.routeIds).toEqual([7, 42]);
        });
        expect(mockGetVisibleRoutes).not.toHaveBeenCalled();
    });

    it("fetches visible routes after debounce", async () => {
        mockGetVisibleRoutes.mockResolvedValue(makeApiResponse([
            { osm_id: 100, min_zoom: 13 },
            { osm_id: 200, min_zoom: 10 },
        ]));

        const viewportRef = makeViewportRef();
        const { result } = renderHook(() =>
            useVisibleRoutes({ viewportRef, enabled: true, alwaysIncludeRouteIds: [], ...TEST_OPTS })
        );

        await waitFor(() => {
            expect(result.current.routeIds).toEqual([100, 200]);
        });
        expect(mockGetVisibleRoutes).toHaveBeenCalledTimes(1);
    });

    it("merges alwaysIncludeRouteIds with API results", async () => {
        mockGetVisibleRoutes.mockResolvedValue(makeApiResponse([
            { osm_id: 100, min_zoom: 13 },
        ]));

        const viewportRef = makeViewportRef();
        const { result } = renderHook(() =>
            useVisibleRoutes({ viewportRef, enabled: true, alwaysIncludeRouteIds: [42], ...TEST_OPTS })
        );

        await waitFor(() => {
            expect(result.current.routeIds).toEqual([42, 100]);
        });
    });

    it("deduplicates alwaysInclude and visible route IDs", async () => {
        mockGetVisibleRoutes.mockResolvedValue(makeApiResponse([
            { osm_id: 42, min_zoom: 13 },
            { osm_id: 100, min_zoom: 10 },
        ]));

        const viewportRef = makeViewportRef();
        const { result } = renderHook(() =>
            useVisibleRoutes({ viewportRef, enabled: true, alwaysIncludeRouteIds: [42], ...TEST_OPTS })
        );

        await waitFor(() => {
            // 42 should appear only once
            expect(result.current.routeIds).toEqual([42, 100]);
        });
    });

    it("truncates to maxRoutes with alwaysInclude first", async () => {
        const manyRoutes = Array.from({ length: 120 }, (_, i) => ({
            osm_id: 1000 + i,
            min_zoom: 13,
        }));
        mockGetVisibleRoutes.mockResolvedValue(makeApiResponse(manyRoutes));

        const viewportRef = makeViewportRef();
        const { result } = renderHook(() =>
            useVisibleRoutes({
                viewportRef,
                enabled: true,
                alwaysIncludeRouteIds: [1, 2, 3],
                maxRoutes: 5,
                ...TEST_OPTS,
            })
        );

        await waitFor(() => {
            expect(result.current.routeIds.length).toBe(5);
            expect(result.current.routeIds).toContain(1);
            expect(result.current.routeIds).toContain(2);
            expect(result.current.routeIds).toContain(3);
        });
    });

    it("preserves last-known-good on API error", async () => {
        // First successful call
        mockGetVisibleRoutes.mockResolvedValueOnce(makeApiResponse([
            { osm_id: 100, min_zoom: 13 },
        ]));

        const viewportRef = makeViewportRef();
        const { result } = renderHook(() =>
            useVisibleRoutes({ viewportRef, enabled: true, alwaysIncludeRouteIds: [], ...TEST_OPTS })
        );

        await waitFor(() => {
            expect(result.current.routeIds).toEqual([100]);
        });

        // Now the API fails
        mockGetVisibleRoutes.mockRejectedValue(new Error("Network error"));

        // Change viewport to trigger a new fetch
        (viewportRef as { current: unknown }).current = { bbox: [11, 49, 12, 50], zoom: 14 };

        // Wait for the failed fetch to complete
        await waitFor(() => {
            expect(mockGetVisibleRoutes).toHaveBeenCalledTimes(2);
        });

        // Should still have the previous data (not reset to [])
        expect(result.current.routeIds).toEqual([100]);
    });

    it("returns stable reference when route set is unchanged", async () => {
        mockGetVisibleRoutes.mockResolvedValue(makeApiResponse([
            { osm_id: 100, min_zoom: 13 },
        ]));

        const viewportRef = makeViewportRef();
        const { result } = renderHook(() =>
            useVisibleRoutes({ viewportRef, enabled: true, alwaysIncludeRouteIds: [], ...TEST_OPTS })
        );

        await waitFor(() => {
            expect(result.current.routeIds).toEqual([100]);
        });

        const firstRef = result.current.routeIds;

        // Trigger a new viewport change with same route response
        (viewportRef as { current: unknown }).current = { bbox: [10.88, 48.36, 10.93, 48.39], zoom: 14 };

        await waitFor(() => {
            expect(mockGetVisibleRoutes).toHaveBeenCalledTimes(2);
        });

        // Same sorted set → same reference (no unnecessary re-render)
        expect(result.current.routeIds).toBe(firstRef);
    });
});
