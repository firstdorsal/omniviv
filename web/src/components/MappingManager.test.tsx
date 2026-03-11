import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MappingManager } from "./MappingManager";
import {
    MappingStatus,
    MappingFilter,
    type MappingStatusResponse,
    type MappingEntry,
    type SetMappingResponse,
    type RemoveMappingResponse,
    type GtfsStopsListResponse,
} from "../api";

// Mock the config module
vi.mock("../config", () => ({
    getConfig: () => ({
        apiUrl: "http://test-api",
        martinUrl: "http://test-martin",
    }),
}));

// Helper to build a MappingStatusResponse
function buildMappingStatusResponse(
    overrides: Partial<MappingStatusResponse> = {},
    entries: MappingEntry[] = []
): MappingStatusResponse {
    return {
        total_ifopt_count: 100,
        mapped_count: 60,
        manual_count: 10,
        auto_count: 50,
        unmapped_count: 40,
        entries,
        has_more: false,
        ...overrides,
    };
}

function buildEntry(overrides: Partial<MappingEntry> = {}): MappingEntry {
    return {
        ifopt: "de:08111:6115:0:1",
        name: "Hauptbahnhof",
        lat: 48.7758,
        lon: 9.1829,
        status: MappingStatus.Unmapped,
        gtfs_stop_id: null,
        gtfs_stop_name: null,
        combined_score: null,
        candidates: [],
        ...overrides,
    };
}

// Track all fetch calls for assertion
let fetchCalls: { url: string; options?: RequestInit }[] = [];
let fetchResponses: Map<string, () => Promise<Response>> = new Map();

function mockFetchResponse(urlPattern: string, body: unknown, ok = true) {
    fetchResponses.set(urlPattern, () =>
        Promise.resolve(
            new Response(JSON.stringify(body), {
                status: ok ? 200 : 500,
                headers: { "Content-Type": "application/json" },
            })
        )
    );
}

function setupDefaultFetchMock(defaultResponse?: MappingStatusResponse) {
    const response =
        defaultResponse ??
        buildMappingStatusResponse({}, [
            buildEntry({ ifopt: "de:08111:6115:0:1", name: "Hauptbahnhof" }),
        ]);

    vi.spyOn(globalThis, "fetch").mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            fetchCalls.push({ url, options: init });

            // Check for pattern matches (order matters: more specific patterns first)
            for (const [pattern, responder] of fetchResponses) {
                if (url.includes(pattern)) {
                    return responder();
                }
            }

            // Default: return mapping status response for any POST to mapping/status
            if (url.includes("/api/mapping/status")) {
                return new Response(JSON.stringify(response), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            // Fallback
            return new Response(JSON.stringify({}), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }
    );
}

describe("MappingManager", () => {
    let onMapDataChange: Mock;

    beforeEach(() => {
        onMapDataChange = vi.fn();
        fetchCalls = [];
        fetchResponses = new Map();
        setupDefaultFetchMock();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders stats correctly when data loads", async () => {
        vi.restoreAllMocks();
        fetchCalls = [];
        fetchResponses = new Map();

        const response = buildMappingStatusResponse({
            total_ifopt_count: 200,
            mapped_count: 120,
            manual_count: 20,
            auto_count: 100,
            unmapped_count: 80,
        });
        mockFetchResponse("/api/mapping/status", response);
        setupDefaultFetchMock(response);

        render(<MappingManager onMapDataChange={onMapDataChange} />);

        await waitFor(() => {
            expect(screen.getByText("120 / 200 mapped")).toBeInTheDocument();
        });

        expect(screen.getByText("20 manual, 100 auto")).toBeInTheDocument();
        expect(screen.getByText("80 unmapped")).toBeInTheDocument();
    });

    it("renders filter tabs with correct counts", async () => {
        vi.restoreAllMocks();
        fetchCalls = [];
        fetchResponses = new Map();

        const response = buildMappingStatusResponse({
            total_ifopt_count: 200,
            mapped_count: 120,
            manual_count: 20,
            auto_count: 100,
            unmapped_count: 80,
        });
        mockFetchResponse("/api/mapping/status", response);
        setupDefaultFetchMock(response);

        render(<MappingManager onMapDataChange={onMapDataChange} />);

        await waitFor(() => {
            expect(screen.getByText("All (200)")).toBeInTheDocument();
        });

        expect(screen.getByText("Unmapped (80)")).toBeInTheDocument();
        expect(screen.getByText("Manual (20)")).toBeInTheDocument();
        expect(screen.getByText("Auto (100)")).toBeInTheDocument();
    });

    it("renders entries from the response", async () => {
        vi.restoreAllMocks();
        fetchCalls = [];
        fetchResponses = new Map();

        const response = buildMappingStatusResponse({}, [
            buildEntry({ ifopt: "de:08111:6115:0:1", name: "Hauptbahnhof" }),
            buildEntry({
                ifopt: "de:08111:6118:0:2",
                name: "Marienplatz",
                status: MappingStatus.Auto,
                gtfs_stop_id: "gtfs-123",
                gtfs_stop_name: "Marienplatz GTFS",
                combined_score: 0.95,
            }),
        ]);
        mockFetchResponse("/api/mapping/status", response);
        setupDefaultFetchMock(response);

        render(<MappingManager onMapDataChange={onMapDataChange} />);

        await waitFor(() => {
            expect(screen.getByText("Hauptbahnhof")).toBeInTheDocument();
        });
        expect(screen.getByText("Marienplatz")).toBeInTheDocument();
        expect(screen.getByText("de:08111:6115:0:1")).toBeInTheDocument();
        expect(screen.getByText("de:08111:6118:0:2")).toBeInTheDocument();
    });

    it("shows loading state initially", () => {
        vi.restoreAllMocks();
        // Don't resolve the fetch immediately
        vi.spyOn(globalThis, "fetch").mockImplementation(
            () => new Promise(() => {}) // Never resolves
        );

        render(<MappingManager onMapDataChange={onMapDataChange} />);

        expect(screen.getByText("Loading mappings...")).toBeInTheDocument();
    });

    it("Use button triggers the set mapping API call", async () => {
        const user = userEvent.setup();

        const entry = buildEntry({
            ifopt: "de:08111:6115:0:1",
            name: "Hauptbahnhof",
            status: MappingStatus.Unmapped,
            candidates: [
                {
                    stop_id: "gtfs-stop-1",
                    stop_name: "Hauptbahnhof GTFS",
                    lat: 48.776,
                    lon: 9.183,
                    distance_meters: 25,
                },
            ],
        });
        vi.restoreAllMocks();
        fetchCalls = [];
        fetchResponses = new Map();

        const response = buildMappingStatusResponse({}, [entry]);
        mockFetchResponse("/api/mapping/status", response);

        const setMappingResponse: SetMappingResponse = {
            success: true,
            message: "Mapping set",
        };
        mockFetchResponse("/api/mapping/set", setMappingResponse);
        setupDefaultFetchMock(response);

        render(<MappingManager onMapDataChange={onMapDataChange} />);

        await waitFor(() => {
            expect(screen.getByText("Hauptbahnhof")).toBeInTheDocument();
        });

        // Expand the candidates section
        const expandButton = screen.getByText("1 nearby GTFS stop");
        await user.click(expandButton);

        await waitFor(() => {
            expect(screen.getByText("Hauptbahnhof GTFS")).toBeInTheDocument();
        });

        const useButton = screen.getByRole("button", { name: "Use" });
        await user.click(useButton);

        await waitFor(() => {
            const setMappingCall = fetchCalls.find((c) =>
                c.url.includes("/api/mapping/set")
            );
            expect(setMappingCall).toBeDefined();
            const body = JSON.parse(setMappingCall!.options?.body as string);
            expect(body.ifopt).toBe("de:08111:6115:0:1");
            expect(body.gtfs_stop_id).toBe("gtfs-stop-1");
        });
    });

    it("Remove button triggers the remove mapping API call", async () => {
        const user = userEvent.setup();

        const entry = buildEntry({
            ifopt: "de:08111:6115:0:1",
            name: "Hauptbahnhof",
            status: MappingStatus.Manual,
            gtfs_stop_id: "gtfs-stop-1",
            gtfs_stop_name: "Hauptbahnhof GTFS",
            candidates: [
                {
                    stop_id: "gtfs-stop-1",
                    stop_name: "Hauptbahnhof GTFS",
                    lat: 48.776,
                    lon: 9.183,
                    distance_meters: 25,
                },
            ],
        });
        vi.restoreAllMocks();
        fetchCalls = [];
        fetchResponses = new Map();

        const response = buildMappingStatusResponse({}, [entry]);
        mockFetchResponse("/api/mapping/status", response);

        const removeMappingResponse: RemoveMappingResponse = {
            removed_count: 1,
        };
        mockFetchResponse("/api/mapping/remove", removeMappingResponse);
        setupDefaultFetchMock(response);

        render(<MappingManager onMapDataChange={onMapDataChange} />);

        await waitFor(() => {
            expect(screen.getByText("Hauptbahnhof")).toBeInTheDocument();
        });

        const removeButton = screen.getByRole("button", { name: /Remove/ });
        await user.click(removeButton);

        await waitFor(() => {
            const removeMappingCall = fetchCalls.find((c) =>
                c.url.includes("/api/mapping/remove")
            );
            expect(removeMappingCall).toBeDefined();
            const body = JSON.parse(removeMappingCall!.options?.body as string);
            expect(body.ifopt).toBe("de:08111:6115:0:1");
        });
    });

    it("Remove button is not shown for auto mappings", async () => {
        const entry = buildEntry({
            ifopt: "de:08111:6115:0:1",
            name: "Hauptbahnhof",
            status: MappingStatus.Auto,
            gtfs_stop_id: "gtfs-stop-1",
            gtfs_stop_name: "Hauptbahnhof GTFS",
            combined_score: 0.95,
            candidates: [],
        });
        vi.restoreAllMocks();
        fetchCalls = [];
        fetchResponses = new Map();

        const response = buildMappingStatusResponse({}, [entry]);
        mockFetchResponse("/api/mapping/status", response);
        setupDefaultFetchMock(response);

        render(<MappingManager onMapDataChange={onMapDataChange} />);

        await waitFor(() => {
            expect(screen.getByText("Hauptbahnhof")).toBeInTheDocument();
        });

        expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
    });

    it("GTFS search triggers the correct API endpoint", async () => {
        const user = userEvent.setup();

        const entry = buildEntry({
            ifopt: "de:08111:6115:0:1",
            name: "Hauptbahnhof",
            status: MappingStatus.Unmapped,
            candidates: [],
        });
        vi.restoreAllMocks();
        fetchCalls = [];
        fetchResponses = new Map();

        const response = buildMappingStatusResponse({}, [entry]);
        mockFetchResponse("/api/mapping/status", response);

        const gtfsResponse: GtfsStopsListResponse = {
            stops: [
                {
                    stop_id: "gtfs-searched-1",
                    stop_name: "Searched Stop",
                    lat: 48.777,
                    lon: 9.184,
                    parent_station: null,
                },
            ],
            total_count: 1,
            offset: 0,
            limit: 10,
            has_more: false,
        };
        mockFetchResponse("/api/gtfs-stops", gtfsResponse);
        setupDefaultFetchMock(response);

        render(<MappingManager onMapDataChange={onMapDataChange} />);

        await waitFor(() => {
            expect(screen.getByText("Hauptbahnhof")).toBeInTheDocument();
        });

        // Expand the candidates section
        const expandButton = screen.getByText("Search for GTFS stops");
        await user.click(expandButton);

        // Type into the GTFS search input
        const gtfsSearchInput = screen.getByPlaceholderText("Search GTFS stops...");
        await user.type(gtfsSearchInput, "Hauptbahnhof");

        // Press Enter to trigger search
        await user.keyboard("{Enter}");

        await waitFor(() => {
            const gtfsCall = fetchCalls.find((c) => c.url.includes("/api/gtfs-stops"));
            expect(gtfsCall).toBeDefined();
            expect(gtfsCall!.url).toContain("search=Hauptbahnhof");
            expect(gtfsCall!.url).toContain("limit=10");
            expect(gtfsCall!.url).toContain("leaf_only=true");
        });

        await waitFor(() => {
            expect(screen.getByText("Searched Stop")).toBeInTheDocument();
        });
    });

    it("GTFS search can also be triggered by clicking the search button", async () => {
        const user = userEvent.setup();

        const entry = buildEntry({
            ifopt: "de:08111:6115:0:1",
            name: "Hauptbahnhof",
            status: MappingStatus.Unmapped,
            candidates: [],
        });
        vi.restoreAllMocks();
        fetchCalls = [];
        fetchResponses = new Map();

        const response = buildMappingStatusResponse({}, [entry]);
        mockFetchResponse("/api/mapping/status", response);

        const gtfsResponse: GtfsStopsListResponse = {
            stops: [],
            total_count: 0,
            offset: 0,
            limit: 10,
            has_more: false,
        };
        mockFetchResponse("/api/gtfs-stops", gtfsResponse);
        setupDefaultFetchMock(response);

        render(<MappingManager onMapDataChange={onMapDataChange} />);

        await waitFor(() => {
            expect(screen.getByText("Hauptbahnhof")).toBeInTheDocument();
        });

        // Expand the candidates section
        const expandButton = screen.getByText("Search for GTFS stops");
        await user.click(expandButton);

        // Type search term
        const gtfsSearchInput = screen.getByPlaceholderText("Search GTFS stops...");
        await user.type(gtfsSearchInput, "Bahnhof");

        // Click the search button (adjacent to the input)
        const searchContainer = gtfsSearchInput.closest(".mt-2");
        const searchButton = searchContainer?.querySelector("button");
        expect(searchButton).toBeDefined();
        await user.click(searchButton!);

        await waitFor(() => {
            const gtfsCall = fetchCalls.find((c) => c.url.includes("/api/gtfs-stops"));
            expect(gtfsCall).toBeDefined();
            expect(gtfsCall!.url).toContain("search=Bahnhof");
        });
    });

    describe("filter tabs trigger re-fetch with correct parameters", () => {
        it("All tab sends unmapped_only=false and include_candidates=true", async () => {
            const user = userEvent.setup();

            render(<MappingManager onMapDataChange={onMapDataChange} />);

            // Wait for initial load to complete
            await waitFor(() => {
                expect(screen.getByText("All (100)")).toBeInTheDocument();
            });

            // Click Unmapped first to change state
            const unmappedButton = screen.getByText(/^Unmapped \(/);
            await user.click(unmappedButton);

            await waitFor(() => {
                const unmappedCall = fetchCalls.find((c) => {
                    if (!c.url.includes("/api/mapping/status")) return false;
                    try {
                        const body = JSON.parse(c.options?.body as string);
                        return body.unmapped_only === true;
                    } catch {
                        return false;
                    }
                });
                expect(unmappedCall).toBeDefined();
            });

            fetchCalls = [];

            // Now click All
            const allButton = screen.getByText(/^All \(/);
            await user.click(allButton);

            await waitFor(() => {
                const allCall = fetchCalls.find((c) => {
                    if (!c.url.includes("/api/mapping/status")) return false;
                    try {
                        const body = JSON.parse(c.options?.body as string);
                        return (
                            body.unmapped_only === false &&
                            body.include_candidates === true &&
                            body.filter === undefined
                        );
                    } catch {
                        return false;
                    }
                });
                expect(allCall).toBeDefined();
            });
        });

        it("Unmapped tab sends unmapped_only=true and include_candidates=true", async () => {
            const user = userEvent.setup();

            render(<MappingManager onMapDataChange={onMapDataChange} />);

            await waitFor(() => {
                expect(screen.getByText("All (100)")).toBeInTheDocument();
            });

            fetchCalls = [];

            const unmappedButton = screen.getByText(/^Unmapped \(/);
            await user.click(unmappedButton);

            await waitFor(() => {
                const call = fetchCalls.find((c) => {
                    if (!c.url.includes("/api/mapping/status")) return false;
                    try {
                        const body = JSON.parse(c.options?.body as string);
                        return (
                            body.unmapped_only === true &&
                            body.include_candidates === true
                        );
                    } catch {
                        return false;
                    }
                });
                expect(call).toBeDefined();
            });
        });

        it("Manual tab sends filter=manual and unmapped_only=false", async () => {
            const user = userEvent.setup();

            render(<MappingManager onMapDataChange={onMapDataChange} />);

            await waitFor(() => {
                expect(screen.getByText("All (100)")).toBeInTheDocument();
            });

            fetchCalls = [];

            const manualButton = screen.getByText(/^Manual \(/);
            await user.click(manualButton);

            await waitFor(() => {
                const call = fetchCalls.find((c) => {
                    if (!c.url.includes("/api/mapping/status")) return false;
                    try {
                        const body = JSON.parse(c.options?.body as string);
                        return (
                            body.filter === MappingFilter.Manual &&
                            body.unmapped_only === false
                        );
                    } catch {
                        return false;
                    }
                });
                expect(call).toBeDefined();
            });
        });

        it("Auto tab sends filter=auto and unmapped_only=false", async () => {
            const user = userEvent.setup();

            render(<MappingManager onMapDataChange={onMapDataChange} />);

            await waitFor(() => {
                expect(screen.getByText("All (100)")).toBeInTheDocument();
            });

            fetchCalls = [];

            const autoButton = screen.getByText(/^Auto \(/);
            await user.click(autoButton);

            await waitFor(() => {
                const call = fetchCalls.find((c) => {
                    if (!c.url.includes("/api/mapping/status")) return false;
                    try {
                        const body = JSON.parse(c.options?.body as string);
                        return (
                            body.filter === MappingFilter.Auto &&
                            body.unmapped_only === false
                        );
                    } catch {
                        return false;
                    }
                });
                expect(call).toBeDefined();
            });
        });
    });

    it("search input debounces and sends search parameter", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        render(<MappingManager onMapDataChange={onMapDataChange} />);

        await waitFor(() => {
            expect(screen.getByText("All (100)")).toBeInTheDocument();
        });

        fetchCalls = [];

        const searchInput = screen.getByPlaceholderText("Search by name or IFOPT...");
        await user.type(searchInput, "Marienplatz");

        // Advance timers past the debounce threshold (300ms)
        await vi.advanceTimersByTimeAsync(400);

        await waitFor(
            () => {
                const callWithSearch = fetchCalls.find((c) => {
                    if (!c.url.includes("/api/mapping/status")) return false;
                    try {
                        const body = JSON.parse(c.options?.body as string);
                        return body.search === "Marienplatz";
                    } catch {
                        return false;
                    }
                });
                expect(callWithSearch).toBeDefined();
            },
            { timeout: 3000 }
        );

        consoleSpy.mockRestore();
        vi.useRealTimers();
    });

    it("calls onMapDataChange with lines for mapped entries", async () => {
        const entry = buildEntry({
            ifopt: "de:08111:6115:0:1",
            name: "Hauptbahnhof",
            status: MappingStatus.Manual,
            gtfs_stop_id: "gtfs-stop-1",
            gtfs_stop_name: "Hauptbahnhof GTFS",
            gtfs_stop_lat: 48.776,
            gtfs_stop_lon: 9.183,
            candidates: [
                {
                    stop_id: "gtfs-stop-1",
                    stop_name: "Hauptbahnhof GTFS",
                    lat: 48.776,
                    lon: 9.183,
                    distance_meters: 25,
                },
            ],
        });
        vi.restoreAllMocks();
        fetchCalls = [];
        fetchResponses = new Map();

        const response = buildMappingStatusResponse({}, [entry]);
        mockFetchResponse("/api/mapping/status", response);
        setupDefaultFetchMock(response);

        render(<MappingManager onMapDataChange={onMapDataChange} />);

        await waitFor(() => {
            expect(onMapDataChange).toHaveBeenCalled();
        });

        // The callback now receives MappingMapData { lines, gtfsStops }
        const callWithLines = onMapDataChange.mock.calls.find(
            (call: unknown[]) => {
                const data = call[0] as { lines?: unknown[] };
                return data?.lines && data.lines.length > 0;
            }
        );
        expect(callWithLines).toBeDefined();
        const mapData = callWithLines![0] as { lines: unknown[]; gtfsStops: unknown[] };
        expect(mapData.lines[0]).toEqual(
            expect.objectContaining({
                osmLat: 48.7758,
                osmLon: 9.1829,
                gtfsLat: 48.776,
                gtfsLon: 9.183,
                isManual: true,
                ifopt: "de:08111:6115:0:1",
            })
        );
        // Should also have gtfsStops from candidates
        expect(mapData.gtfsStops.length).toBeGreaterThan(0);
    });

    it("shows empty state when no entries match filter", async () => {
        vi.restoreAllMocks();
        fetchCalls = [];
        fetchResponses = new Map();

        const response = buildMappingStatusResponse({}, []);
        mockFetchResponse("/api/mapping/status", response);
        setupDefaultFetchMock(response);

        render(<MappingManager onMapDataChange={onMapDataChange} />);

        await waitFor(() => {
            expect(
                screen.getByText("No entries match the current filter")
            ).toBeInTheDocument();
        });
    });

    it("shows pagination controls when has_more is true", async () => {
        vi.restoreAllMocks();
        fetchCalls = [];
        fetchResponses = new Map();

        const response = buildMappingStatusResponse(
            { has_more: true },
            [buildEntry()]
        );
        mockFetchResponse("/api/mapping/status", response);
        setupDefaultFetchMock(response);

        render(<MappingManager onMapDataChange={onMapDataChange} />);

        await waitFor(() => {
            expect(screen.getByText("Page 1")).toBeInTheDocument();
        });
    });

    it("does not show pagination when has_more is false and on page 0", async () => {
        vi.restoreAllMocks();
        fetchCalls = [];
        fetchResponses = new Map();

        const response = buildMappingStatusResponse(
            { has_more: false },
            [buildEntry()]
        );
        mockFetchResponse("/api/mapping/status", response);
        setupDefaultFetchMock(response);

        render(<MappingManager onMapDataChange={onMapDataChange} />);

        await waitFor(() => {
            expect(screen.getByText("Hauptbahnhof")).toBeInTheDocument();
        });

        expect(screen.queryByText("Page 1")).not.toBeInTheDocument();
    });

    it("displays badge for unmapped entries", async () => {
        vi.restoreAllMocks();
        fetchCalls = [];
        fetchResponses = new Map();

        const entry = buildEntry({
            status: MappingStatus.Unmapped,
        });
        const response = buildMappingStatusResponse({}, [entry]);
        mockFetchResponse("/api/mapping/status", response);
        setupDefaultFetchMock(response);

        render(<MappingManager onMapDataChange={onMapDataChange} />);

        // Wait for entry to render - "Unmapped" badge text exists alongside "Unmapped (40)" tab
        await waitFor(() => {
            expect(screen.getByText("Hauptbahnhof")).toBeInTheDocument();
        });

        // The badge shows "Unmapped" but the tab shows "Unmapped (40)"
        // We can find the badge by its exact text
        const badges = screen.getAllByText("Unmapped");
        // At least one "Unmapped" badge should exist (from the entry, not the tab button which says "Unmapped (40)")
        expect(badges.length).toBeGreaterThanOrEqual(1);
    });

    it("displays badge with score for auto entries", async () => {
        vi.restoreAllMocks();
        fetchCalls = [];
        fetchResponses = new Map();

        const entry = buildEntry({
            status: MappingStatus.Auto,
            combined_score: 0.87,
            gtfs_stop_id: "gtfs-1",
            gtfs_stop_name: "Auto Stop",
        });
        const response = buildMappingStatusResponse({}, [entry]);
        mockFetchResponse("/api/mapping/status", response);
        setupDefaultFetchMock(response);

        render(<MappingManager onMapDataChange={onMapDataChange} />);

        await waitFor(() => {
            expect(screen.getByText("Auto 87%")).toBeInTheDocument();
        });
    });

    it("displays badge for manual entries", async () => {
        vi.restoreAllMocks();
        fetchCalls = [];
        fetchResponses = new Map();

        const entry = buildEntry({
            status: MappingStatus.Manual,
            gtfs_stop_id: "gtfs-1",
            gtfs_stop_name: "Manual Stop",
        });
        const response = buildMappingStatusResponse({}, [entry]);
        mockFetchResponse("/api/mapping/status", response);
        setupDefaultFetchMock(response);

        render(<MappingManager onMapDataChange={onMapDataChange} />);

        // Wait for the entry to load; "Manual" badge text exists alongside "Manual (10)" tab
        await waitFor(() => {
            expect(screen.getByText("Hauptbahnhof")).toBeInTheDocument();
        });

        // The badge shows "Manual" (exact) while the tab shows "Manual (10)"
        const manualTexts = screen.getAllByText("Manual");
        expect(manualTexts.length).toBeGreaterThanOrEqual(1);
    });

    it("pagination sends correct offset", async () => {
        vi.restoreAllMocks();
        fetchCalls = [];
        fetchResponses = new Map();

        const user = userEvent.setup();
        const response = buildMappingStatusResponse(
            { has_more: true },
            [buildEntry()]
        );
        mockFetchResponse("/api/mapping/status", response);
        setupDefaultFetchMock(response);

        render(<MappingManager onMapDataChange={onMapDataChange} />);

        await waitFor(() => {
            expect(screen.getByText("Page 1")).toBeInTheDocument();
        });

        fetchCalls = [];

        // Find the forward pagination button. It's the second button in the pagination container.
        const pageLabel = screen.getByText("Page 1");
        const paginationContainer = pageLabel.parentElement!;
        const buttons = paginationContainer.querySelectorAll("button");
        // buttons[0] = previous (disabled), buttons[1] = next
        const nextButton = buttons[1];
        expect(nextButton).toBeDefined();
        await user.click(nextButton);

        await waitFor(() => {
            const pageCall = fetchCalls.find((c) => {
                if (!c.url.includes("/api/mapping/status")) return false;
                try {
                    const body = JSON.parse(c.options?.body as string);
                    return body.offset === 30; // page 1 * pageSize 30
                } catch {
                    return false;
                }
            });
            expect(pageCall).toBeDefined();
        });
    });

    it("re-fetches data after set mapping", async () => {
        const user = userEvent.setup();

        const entry = buildEntry({
            ifopt: "de:08111:6115:0:1",
            name: "Hauptbahnhof",
            status: MappingStatus.Unmapped,
            candidates: [
                {
                    stop_id: "gtfs-stop-1",
                    stop_name: "Hauptbahnhof GTFS",
                    lat: 48.776,
                    lon: 9.183,
                    distance_meters: 25,
                },
            ],
        });
        vi.restoreAllMocks();
        fetchCalls = [];
        fetchResponses = new Map();

        const response = buildMappingStatusResponse({}, [entry]);
        mockFetchResponse("/api/mapping/status", response);
        mockFetchResponse("/api/mapping/set", { success: true, message: "ok" });
        setupDefaultFetchMock(response);

        render(<MappingManager onMapDataChange={onMapDataChange} />);

        await waitFor(() => {
            expect(screen.getByText("Hauptbahnhof")).toBeInTheDocument();
        });

        const initialStatusCalls = fetchCalls.filter((c) =>
            c.url.includes("/api/mapping/status")
        ).length;

        // Expand candidates and click Use
        const expandButton = screen.getByText("1 nearby GTFS stop");
        await user.click(expandButton);

        await waitFor(() => {
            expect(screen.getByText("Hauptbahnhof GTFS")).toBeInTheDocument();
        });

        const useButton = screen.getByRole("button", { name: "Use" });
        await user.click(useButton);

        await waitFor(() => {
            const totalStatusCalls = fetchCalls.filter((c) =>
                c.url.includes("/api/mapping/status")
            ).length;
            expect(totalStatusCalls).toBeGreaterThan(initialStatusCalls);
        });
    });
});
