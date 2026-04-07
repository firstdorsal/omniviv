import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { NavigationPanel } from "./NavigationPanel";
import type { ResolvedLocation } from "./LocationSearch";

// -- Mocks --------------------------------------------------------------------

vi.mock("../config", () => ({
    getConfig: () => ({
        motisUrl: "http://test-motis",
        apiUrl: "http://test-api",
        martinUrl: "http://test-martin",
    }),
}));

vi.mock("./PinheadIcon", () => ({
    PinheadIcon: ({ name, className }: { name: string; className?: string }) => (
        <span data-testid={`pinhead-${name}`} className={className} />
    ),
    getPinheadIconName: (type: string) => type,
}));

vi.mock("./LineBadge", () => ({
    LineBadge: ({ label }: { label: string }) => <span data-testid="line-badge">{label}</span>,
}));

vi.mock("./Duration", () => ({
    Duration: ({ seconds }: { seconds: number }) => <span data-testid="duration">{seconds}s</span>,
}));

vi.mock("./ui/date-time-picker", () => ({
    DateTimePicker: () => <div data-testid="date-time-picker" />,
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// -- Test data ----------------------------------------------------------------

const LOCATION_A: ResolvedLocation = {
    name: "Augsburg Hbf",
    lat: 48.365,
    lon: 10.886,
    type: "station",
};

const LOCATION_B: ResolvedLocation = {
    name: "Königsplatz",
    lat: 48.368,
    lon: 10.893,
    type: "station",
};

const LOCATION_C: ResolvedLocation = {
    name: "Moritzplatz",
    lat: 48.367,
    lon: 10.898,
    type: "station",
};

const MOCK_ITINERARY = {
    duration: 600,
    startTime: "2026-03-23T10:00:00Z",
    endTime: "2026-03-23T10:10:00Z",
    transfers: 0,
    legs: [
        {
            mode: "TRAM",
            routeShortName: "1",
            from: { name: "Augsburg Hbf" },
            to: { name: "Königsplatz" },
            duration: 600,
            startTime: "2026-03-23T10:00:00Z",
            endTime: "2026-03-23T10:10:00Z",
        },
    ],
};

function mockSuccessfulRouteResponse() {
    mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
            itineraries: [MOCK_ITINERARY],
            direct: [],
        }),
    });
}

function defaultProps(overrides: Partial<Parameters<typeof NavigationPanel>[0]> = {}) {
    return {
        stations: [],
        routeColors: new Map<string, string>(),
        routeTypes: new Map<string, string>(),
        startLocation: null as ResolvedLocation | null,
        endLocation: null as ResolvedLocation | null,
        onStartChange: vi.fn(),
        onEndChange: vi.fn(),
        intermediateStops: [] as (ResolvedLocation | null)[],
        onIntermediateStopsChange: vi.fn(),
        pickMode: null as "start" | "end" | null,
        onPickModeChange: vi.fn(),
        onFlyTo: vi.fn(),
        ...overrides,
    };
}

/** Advance fake timers and flush microtasks so fetch promises resolve. */
async function advanceTimersAndFlush(ms: number) {
    await act(async () => {
        vi.advanceTimersByTime(ms);
        // Flush microtask queue (resolves pending fetch promises)
        await vi.runAllTicKsAsync?.() ?? Promise.resolve();
    });
}

// -- Tests --------------------------------------------------------------------

describe("NavigationPanel auto-search", () => {
    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        mockFetch.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("auto-searches immediately on mount when start and end locations are set", async () => {
        mockSuccessfulRouteResponse();

        render(
            <NavigationPanel
                {...defaultProps({
                    startLocation: LOCATION_A,
                    endLocation: LOCATION_B,
                })}
            />,
        );

        // Should fire immediately (no debounce on first mount)
        await advanceTimersAndFlush(10);

        await waitFor(() => {
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        const url = new URL(mockFetch.mock.calls[0][0]);
        expect(url.pathname).toBe("/api/v1/plan");
        expect(url.searchParams.get("fromPlace")).toBe(`${LOCATION_A.lat},${LOCATION_A.lon}`);
        expect(url.searchParams.get("toPlace")).toBe(`${LOCATION_B.lat},${LOCATION_B.lon}`);
    });

    it("does not auto-search when only start location is set", async () => {
        render(
            <NavigationPanel
                {...defaultProps({
                    startLocation: LOCATION_A,
                    endLocation: null,
                })}
            />,
        );

        await advanceTimersAndFlush(500);

        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("does not auto-search when only end location is set", async () => {
        render(
            <NavigationPanel
                {...defaultProps({
                    startLocation: null,
                    endLocation: LOCATION_B,
                })}
            />,
        );

        await advanceTimersAndFlush(500);

        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("auto-searches again after remount (simulating tab switch)", async () => {
        mockSuccessfulRouteResponse();
        mockSuccessfulRouteResponse();

        const props = defaultProps({
            startLocation: LOCATION_A,
            endLocation: LOCATION_B,
        });

        // First mount — fires immediately
        const { unmount } = render(<NavigationPanel {...props} />);

        await advanceTimersAndFlush(10);

        await waitFor(() => {
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        // Unmount (user switches to another tab)
        unmount();

        // Remount (user switches back to navigation tab) — fires immediately again
        render(<NavigationPanel {...props} />);

        await advanceTimersAndFlush(10);

        await waitFor(() => {
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });
    });

    it("renders itineraries after auto-search completes", async () => {
        // Use real timers for this test since we need full async resolution
        vi.useRealTimers();
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        mockSuccessfulRouteResponse();

        const { container } = render(
            <NavigationPanel
                {...defaultProps({
                    startLocation: LOCATION_A,
                    endLocation: LOCATION_B,
                })}
            />,
        );

        // Wait for fetch to be called (debounce fires after 300ms)
        await waitFor(() => {
            expect(mockFetch).toHaveBeenCalledTimes(1);
        }, { timeout: 2000 });

        // Wait for the button to return from searching state
        await waitFor(() => {
            expect(screen.getByRole("button", { name: /Route finden/i })).not.toBeDisabled();
        }, { timeout: 2000 });

        // Check that console had no errors and itineraries appeared
        expect(consoleSpy).not.toHaveBeenCalled();

        // The mock response has 0 transfers and 1 tram leg — check the leg renders
        const badges = container.querySelectorAll("[data-testid='line-badge']");
        expect(badges.length).toBeGreaterThan(0);

        consoleSpy.mockRestore();
        // Restore fake timers for subsequent tests
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it("auto-searches when location changes", async () => {
        mockSuccessfulRouteResponse();
        mockSuccessfulRouteResponse();

        const props = defaultProps({
            startLocation: LOCATION_A,
            endLocation: LOCATION_B,
        });

        const { rerender } = render(<NavigationPanel {...props} />);

        await advanceTimersAndFlush(350);

        await waitFor(() => {
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        // Change end location
        rerender(
            <NavigationPanel
                {...defaultProps({
                    startLocation: LOCATION_A,
                    endLocation: LOCATION_C,
                })}
            />,
        );

        await advanceTimersAndFlush(350);

        await waitFor(() => {
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        const secondUrl = new URL(mockFetch.mock.calls[1][0]);
        expect(secondUrl.searchParams.get("toPlace")).toBe(`${LOCATION_C.lat},${LOCATION_C.lon}`);
    });

    it("does not duplicate search when same locations are rerendered", async () => {
        mockSuccessfulRouteResponse();

        const props = defaultProps({
            startLocation: LOCATION_A,
            endLocation: LOCATION_B,
        });

        const { rerender } = render(<NavigationPanel {...props} />);

        await advanceTimersAndFlush(350);

        await waitFor(() => {
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        // Rerender with same props (e.g. parent re-renders)
        rerender(<NavigationPanel {...props} />);

        await advanceTimersAndFlush(500);

        // Should still only have been called once
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("includes intermediate stops in auto-search request", async () => {
        mockSuccessfulRouteResponse();

        render(
            <NavigationPanel
                {...defaultProps({
                    startLocation: LOCATION_A,
                    endLocation: LOCATION_B,
                    intermediateStops: [LOCATION_C],
                })}
            />,
        );

        await advanceTimersAndFlush(350);

        await waitFor(() => {
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        const url = new URL(mockFetch.mock.calls[0][0]);
        expect(url.searchParams.get("intermediatePlaces")).toBe(`${LOCATION_C.lat},${LOCATION_C.lon}`);
    });

    it("debounces rapid prop changes after initial mount", async () => {
        mockSuccessfulRouteResponse();
        mockSuccessfulRouteResponse();

        const props = defaultProps({
            startLocation: LOCATION_A,
            endLocation: LOCATION_B,
        });

        const { rerender } = render(<NavigationPanel {...props} />);

        // First mount fires immediately
        await advanceTimersAndFlush(10);
        await waitFor(() => {
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        // Rapidly change location — this should be debounced (300ms)
        rerender(
            <NavigationPanel
                {...defaultProps({
                    startLocation: LOCATION_A,
                    endLocation: LOCATION_C,
                })}
            />,
        );

        // At 100ms the second request should NOT have fired yet
        await advanceTimersAndFlush(100);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // After 300ms debounce, it fires
        await advanceTimersAndFlush(250);

        await waitFor(() => {
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        // The second request should be for LOCATION_C
        const secondUrl = new URL(mockFetch.mock.calls[1][0]);
        expect(secondUrl.searchParams.get("toPlace")).toBe(`${LOCATION_C.lat},${LOCATION_C.lon}`);
    });
});
