import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
    LocationSearch,
    type ResolvedLocation,
    type GeocodeSuggestion,
    type LocationBookmark,
    BOOKMARKS_KEY,
    BOOKMARKS_CHANGED_EVENT,
    RECENTS_KEY,
    RECENTS_CHANGED_EVENT,
    loadBookmarks,
    saveBookmarks,
    loadRecents,
    saveRecent,
    isBookmarked,
    toggleBookmark,
    formatArea,
    categoryToLabel,
} from "./LocationSearch";
import type { Station } from "../api";

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

// Stub fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// -- Test data ----------------------------------------------------------------

const STATION_A: Station = {
    name: "Augsburg Hbf",
    lat: 48.365,
    lon: 10.886,
    min_zoom: 0,
    osm_id: 1,
    osm_type: "node",
    platform_ways: [],
    platforms: [{ name: "1", lat: 48.365, lon: 10.886, osm_id: 10, gtfs_stop_ids: [] }],
    stop_positions: [],
};

const STATION_B: Station = {
    name: "Königsplatz",
    lat: 48.367,
    lon: 10.893,
    min_zoom: 0,
    osm_id: 2,
    osm_type: "node",
    platform_ways: [],
    platforms: [
        { name: "A1", lat: 48.367, lon: 10.893, osm_id: 20, gtfs_stop_ids: [] },
        { name: "A2", lat: 48.367, lon: 10.893, osm_id: 21, gtfs_stop_ids: [] },
    ],
    stop_positions: [],
};

const STATION_C: Station = {
    name: "Augsburg West P+R",
    lat: 48.368,
    lon: 10.860,
    min_zoom: 0,
    osm_id: 3,
    osm_type: "node",
    platform_ways: [],
    platforms: [],
    stop_positions: [],
};

const STATIONS = [STATION_A, STATION_B, STATION_C];

const BOOKMARK_A: LocationBookmark = {
    name: "Home",
    lat: 48.370,
    lon: 10.900,
    type: "address",
    detail: "Augsburg",
};

const BOOKMARK_B: LocationBookmark = {
    name: "Work",
    lat: 48.380,
    lon: 10.910,
    type: "poi",
    detail: "Innenstadt, Augsburg",
};

function motisResponse(items: Array<{ name: string; lat: number; lon: number; type?: string; category?: string; areas?: Array<{ name: string; adminLevel: number }> }>) {
    return {
        ok: true,
        json: () => Promise.resolve(items.map(i => ({
            type: i.type ?? "PLACE",
            name: i.name,
            lat: i.lat,
            lon: i.lon,
            category: i.category,
            areas: i.areas ?? [],
        }))),
    };
}

function renderSearch(props: Partial<React.ComponentProps<typeof LocationSearch>> = {}) {
    const onChange = props.onChange ?? vi.fn();
    const result = render(
        <LocationSearch
            stations={STATIONS}
            value={null}
            onChange={onChange}
            {...props}
        />,
    );
    return { ...result, onChange };
}

// -- Unit tests for helpers ---------------------------------------------------

describe("formatArea", () => {
    it("returns undefined for empty areas", () => {
        expect(formatArea(undefined)).toBeUndefined();
        expect(formatArea([])).toBeUndefined();
    });

    it("returns city name from adminLevel 6", () => {
        expect(formatArea([{ name: "Augsburg", adminLevel: 6 }])).toBe("Augsburg");
    });

    it("returns city name from adminLevel 8", () => {
        expect(formatArea([{ name: "München", adminLevel: 8 }])).toBe("München");
    });

    it("combines neighborhood and city", () => {
        const areas = [
            { name: "Augsburg", adminLevel: 6 },
            { name: "Innenstadt", adminLevel: 10 },
        ];
        expect(formatArea(areas)).toBe("Innenstadt, Augsburg");
    });

    it("does not duplicate when neighborhood equals city", () => {
        const areas = [
            { name: "Augsburg", adminLevel: 6 },
            { name: "Augsburg", adminLevel: 10 },
        ];
        expect(formatArea(areas)).toBe("Augsburg");
    });

    it("falls back to adminLevel 4 for city-states like Berlin", () => {
        const areas = [
            { name: "Deutschland", adminLevel: 2 },
            { name: "Berlin", adminLevel: 4 },
            { name: "Friedrichshain-Kreuzberg", adminLevel: 9 },
            { name: "Friedrichshain", adminLevel: 10 },
        ];
        expect(formatArea(areas)).toBe("Friedrichshain, Berlin");
    });

    it("falls back to adminLevel 4 when no neighborhood", () => {
        const areas = [
            { name: "Deutschland", adminLevel: 2 },
            { name: "Hamburg", adminLevel: 4 },
        ];
        expect(formatArea(areas)).toBe("Hamburg");
    });

    it("returns neighborhood alone when no city level found", () => {
        const areas = [
            { name: "Deutschland", adminLevel: 2 },
            { name: "Ottensen", adminLevel: 10 },
        ];
        expect(formatArea(areas)).toBe("Ottensen");
    });
});

describe("categoryToLabel", () => {
    it("returns undefined for none or missing", () => {
        expect(categoryToLabel(undefined)).toBeUndefined();
        expect(categoryToLabel("none")).toBeUndefined();
    });

    it("maps known categories", () => {
        expect(categoryToLabel("theatre_16")).toBe("Theater");
        expect(categoryToLabel("restaurant_14")).toBe("Restaurant");
        expect(categoryToLabel("cafe_16")).toBe("Café");
    });

    it("falls back to cleaned category name for unknown", () => {
        expect(categoryToLabel("water_park_14")).toBe("water park");
    });
});

// -- Bookmark unit tests ------------------------------------------------------

describe("bookmark helpers", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it("loadBookmarks returns empty array when no data", () => {
        expect(loadBookmarks()).toEqual([]);
    });

    it("loadBookmarks returns saved bookmarks", () => {
        localStorage.setItem(BOOKMARKS_KEY, JSON.stringify([BOOKMARK_A]));
        expect(loadBookmarks()).toEqual([BOOKMARK_A]);
    });

    it("loadBookmarks returns empty array on corrupt JSON", () => {
        localStorage.setItem(BOOKMARKS_KEY, "not-json");
        expect(loadBookmarks()).toEqual([]);
    });

    it("saveBookmarks persists to localStorage", () => {
        saveBookmarks([BOOKMARK_A, BOOKMARK_B]);
        const stored = JSON.parse(localStorage.getItem(BOOKMARKS_KEY)!);
        expect(stored).toEqual([BOOKMARK_A, BOOKMARK_B]);
    });

    it("isBookmarked matches by coordinates within tolerance", () => {
        const bm = [BOOKMARK_A];
        expect(isBookmarked(bm, { lat: 48.370, lon: 10.900 })).toBe(true);
        expect(isBookmarked(bm, { lat: 48.3700001, lon: 10.9000001 })).toBe(true);
        expect(isBookmarked(bm, { lat: 48.371, lon: 10.901 })).toBe(false);
    });

    it("toggleBookmark adds when not present", () => {
        const suggestion: GeocodeSuggestion = {
            name: "Test", lat: 48.5, lon: 10.5, type: "poi",
        };
        const result = toggleBookmark([], suggestion);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("Test");
    });

    it("toggleBookmark removes when present", () => {
        const suggestion: GeocodeSuggestion = {
            name: "Home", lat: BOOKMARK_A.lat, lon: BOOKMARK_A.lon, type: "address",
        };
        const result = toggleBookmark([BOOKMARK_A], suggestion);
        expect(result).toHaveLength(0);
    });
});

// -- Component rendering ------------------------------------------------------

describe("LocationSearch rendering", () => {
    beforeEach(() => {
        localStorage.clear();
        mockFetch.mockReset();
    });

    it("renders with placeholder", () => {
        renderSearch({ placeholder: "Suche..." });
        expect(screen.getByPlaceholderText("Suche...")).toBeInTheDocument();
    });

    it("renders label when provided", () => {
        renderSearch({ label: "Start" });
        expect(screen.getByText("Start")).toBeInTheDocument();
    });

    it("shows GPS button in dropdown when showGps is true", async () => {
        const user = userEvent.setup();
        renderSearch({ showGps: true });
        await user.click(screen.getByRole("combobox"));
        await waitFor(() => expect(screen.getByText("Aktueller Standort")).toBeInTheDocument());
    });

    it("shows map pick button in dropdown when showMapPick is true", async () => {
        const user = userEvent.setup();
        renderSearch({ showMapPick: true, onPickOnMap: vi.fn() });
        await user.click(screen.getByRole("combobox"));
        await waitFor(() => expect(screen.getByText("Auf Karte wählen")).toBeInTheDocument());
    });

    it("does not show GPS/map buttons by default", async () => {
        const user = userEvent.setup();
        renderSearch();
        await user.click(screen.getByRole("combobox"));
        expect(screen.queryByText("Aktueller Standort")).not.toBeInTheDocument();
        expect(screen.queryByText("Auf Karte wählen")).not.toBeInTheDocument();
    });

    it("shows clear button when there is a value", () => {
        const value: ResolvedLocation = { name: "Test", lat: 48.3, lon: 10.9, type: "address" };
        renderSearch({ value });
        expect(screen.getByLabelText("Eingabe löschen")).toBeInTheDocument();
    });

    it("does not show clear button when empty", () => {
        renderSearch();
        expect(screen.queryByLabelText("Eingabe löschen")).not.toBeInTheDocument();
    });

    it("shows map pick button as active when isPickingOnMap", async () => {
        const user = userEvent.setup();
        renderSearch({ showMapPick: true, isPickingOnMap: true, onPickOnMap: vi.fn() });
        await user.click(screen.getByRole("combobox"));
        await waitFor(() => {
            const btn = screen.getByText("Auf Karte wählen").closest("button")!;
            expect(btn.className).toContain("bg-primary");
        });
    });
});

// -- ARIA / Accessibility -----------------------------------------------------

describe("LocationSearch accessibility", () => {
    beforeEach(() => {
        localStorage.clear();
        mockFetch.mockReset();
    });

    it("input has combobox role", () => {
        renderSearch();
        expect(screen.getByRole("combobox")).toBeInTheDocument();
    });

    it("input has aria-expanded=false when closed", () => {
        renderSearch();
        expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "false");
    });

    it("input has aria-autocomplete=list", () => {
        renderSearch();
        expect(screen.getByRole("combobox")).toHaveAttribute("aria-autocomplete", "list");
    });

    it("input references the listbox via aria-controls", () => {
        renderSearch();
        expect(screen.getByRole("combobox")).toHaveAttribute("aria-controls", "location-search-listbox");
    });

    it("input is labelled by label when present", () => {
        renderSearch({ label: "Von" });
        expect(screen.getByRole("combobox")).toHaveAttribute("aria-labelledby", "location-search-label");
    });

    it("listbox appears with role=listbox when suggestions are shown", async () => {
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");
        await user.type(input, "Augs");
        await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
    });

    it("options have role=option", async () => {
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");
        await user.type(input, "Augs");
        await waitFor(() => {
            const options = screen.getAllByRole("option");
            expect(options.length).toBeGreaterThan(0);
        });
    });

    it("active option has aria-selected=true", async () => {
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");
        await user.type(input, "Augs");
        await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));

        // First option is auto-highlighted
        const options = screen.getAllByRole("option");
        expect(options[0]).toHaveAttribute("aria-selected", "true");
    });

    it("aria-activedescendant updates with keyboard navigation", async () => {
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");
        await user.type(input, "Augs");
        await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));

        // Auto-highlighted first option
        expect(input).toHaveAttribute("aria-activedescendant", "location-option-0");
        await user.keyboard("{ArrowDown}");
        expect(input).toHaveAttribute("aria-activedescendant", "location-option-1");
    });

    it("bookmark buttons have descriptive aria-labels", async () => {
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");
        await user.type(input, "Augs");
        await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));

        const bookmarkBtns = screen.getAllByTitle("Als Favorit speichern");
        expect(bookmarkBtns.length).toBeGreaterThan(0);
        expect(bookmarkBtns[0]).toHaveAttribute("aria-label", expect.stringContaining("als Favorit speichern"));
    });
});

// -- Search behavior ----------------------------------------------------------

describe("LocationSearch search", () => {
    beforeEach(() => {
        localStorage.clear();
        mockFetch.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("shows local station matches immediately on typing", async () => {
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "Augs");
        await waitFor(() => {
            expect(screen.getByText("Augsburg Hbf")).toBeInTheDocument();
            expect(screen.getByText("Augsburg West P+R")).toBeInTheDocument();
        });
    });

    it("shows detail line for local station matches with platform count", async () => {
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "König");
        await waitFor(() => {
            expect(screen.getByText("Königsplatz")).toBeInTheDocument();
            // Königsplatz has 2 platforms
            expect(screen.getByText("Haltestelle · 2 Steige")).toBeInTheDocument();
        });
    });

    it("shows detail line for stations without platforms", async () => {
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "West");
        await waitFor(() => {
            expect(screen.getByText("Augsburg West P+R")).toBeInTheDocument();
            // No platforms
            expect(screen.getByText("Haltestelle")).toBeInTheDocument();
        });
    });

    it("does not show suggestions for queries shorter than 2 chars", async () => {
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "A");
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("calls MOTIS geocode after debounce", async () => {
        mockFetch.mockResolvedValue(motisResponse([
            { name: "Augsburger Straße", lat: 48.1, lon: 10.1, type: "ADDRESS" },
        ]));

        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "Augs");
        expect(mockFetch).not.toHaveBeenCalled();

        // Advance past the 300ms debounce
        await vi.advanceTimersByTimeAsync(350);
        expect(mockFetch).toHaveBeenCalledWith(
            expect.stringContaining("geocode?text=Augs"),
            expect.any(Object),
        );

        vi.useRealTimers();
    });

    it("deduplicates MOTIS results with same name as stations", async () => {
        mockFetch.mockResolvedValue(motisResponse([
            { name: "Augsburg Hbf", lat: 48.365, lon: 10.886, type: "STOP" },
            { name: "Augsburger Dom", lat: 48.37, lon: 10.90, type: "PLACE" },
        ]));

        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
        renderSearch();
        const input = screen.getByRole("combobox");
        await user.type(input, "Augs");

        // Advance past the 300ms debounce
        await vi.advanceTimersByTimeAsync(350);

        await waitFor(() => {
            // Should see "Augsburger Dom" (unique from MOTIS)
            expect(screen.getByText("Augsburger Dom")).toBeInTheDocument();
            // "Augsburg Hbf" appears only once (from stations, not duplicated from MOTIS)
            const hbfElements = screen.getAllByText("Augsburg Hbf");
            expect(hbfElements).toHaveLength(1);
        });

        vi.useRealTimers();
    });

    it("aborts previous fetch when typing continues", async () => {
        // Track abort signals passed to fetch
        const signals: AbortSignal[] = [];
        mockFetch.mockImplementation((_url: string, opts?: { signal?: AbortSignal }) => {
            if (opts?.signal) signals.push(opts.signal);
            return new Promise(() => { /* never resolves */ });
        });

        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "Au");
        // Wait for first debounce to fire (300ms real time)
        await waitFor(() => expect(signals).toHaveLength(1), { timeout: 2000 });
        expect(signals[0].aborted).toBe(false);

        await user.type(input, "gs");
        // Second fetch fires, first should be aborted
        await waitFor(() => {
            expect(signals.length).toBeGreaterThanOrEqual(2);
            expect(signals[0].aborted).toBe(true);
        }, { timeout: 2000 });
    });
});

// -- Selection behavior -------------------------------------------------------

describe("LocationSearch selection", () => {
    beforeEach(() => {
        localStorage.clear();
        mockFetch.mockReset();
    });

    it("calls onChange when clicking a suggestion", async () => {
        const user = userEvent.setup();
        const { onChange } = renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "König");
        await waitFor(() => expect(screen.getByText("Königsplatz")).toBeInTheDocument());

        await user.click(screen.getByText("Königsplatz"));
        expect(onChange).toHaveBeenCalledWith(
            expect.objectContaining({ name: "Königsplatz", type: "station" }),
        );
    });

    it("closes popover after selection", async () => {
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "König");
        await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());

        await user.click(screen.getByText("Königsplatz"));
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("updates input value to selected suggestion name", async () => {
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "König");
        await waitFor(() => expect(screen.getByText("Königsplatz")).toBeInTheDocument());

        await user.click(screen.getByText("Königsplatz"));
        expect(input).toHaveValue("Königsplatz");
    });

    it("clear button resets value and focuses input", async () => {
        const user = userEvent.setup();
        const value: ResolvedLocation = { name: "Test", lat: 48.3, lon: 10.9, type: "address" };
        const { onChange } = renderSearch({ value });

        await user.click(screen.getByLabelText("Eingabe löschen"));
        expect(onChange).toHaveBeenCalledWith(null);
    });
});

// -- Keyboard navigation ------------------------------------------------------

describe("LocationSearch keyboard", () => {
    beforeEach(() => {
        localStorage.clear();
        mockFetch.mockReset();
    });

    it("ArrowDown opens popover when closed with content available", async () => {
        localStorage.setItem(BOOKMARKS_KEY, JSON.stringify([BOOKMARK_A]));
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");
        await user.click(input);
        // Close by pressing escape first
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

        await user.keyboard("{ArrowDown}");
        await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
    });

    it("ArrowDown cycles through options", async () => {
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "Augs");
        await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(1));

        const optionCount = screen.getAllByRole("option").length;

        // First option is already active (auto-highlight)
        expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");

        // ArrowDown moves to second
        await user.keyboard("{ArrowDown}");
        expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
        expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "false");

        // Cycle back to first (need optionCount-1 more presses to wrap)
        for (let i = 2; i < optionCount; i++) {
            await user.keyboard("{ArrowDown}");
        }
        await user.keyboard("{ArrowDown}");
        expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    });

    it("ArrowUp cycles in reverse", async () => {
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "Augs");
        await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));

        // ArrowUp from -1 should go to last item
        await user.keyboard("{ArrowUp}");
        const options = screen.getAllByRole("option");
        expect(options[options.length - 1]).toHaveAttribute("aria-selected", "true");
    });

    it("Enter selects the active option", async () => {
        const user = userEvent.setup();
        const { onChange } = renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "König");
        await waitFor(() => expect(screen.getByText("Königsplatz")).toBeInTheDocument());

        await user.keyboard("{ArrowDown}");
        await user.keyboard("{Enter}");
        expect(onChange).toHaveBeenCalledWith(
            expect.objectContaining({ name: "Königsplatz" }),
        );
    });

    it("Enter selects first option when auto-highlighted", async () => {
        const user = userEvent.setup();
        const { onChange } = renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "König");
        await waitFor(() => expect(screen.getByText("Königsplatz")).toBeInTheDocument());

        // First option is auto-highlighted — Enter selects it
        await user.keyboard("{Enter}");
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ name: "Königsplatz" }));
    });

    it("Escape closes the popover", async () => {
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "Augs");
        await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());

        await user.keyboard("{Escape}");
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("Escape resets active index", async () => {
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "Augs");
        await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));

        // First option is auto-highlighted
        expect(input).toHaveAttribute("aria-activedescendant", "location-option-0");

        await user.keyboard("{Escape}");
        // After Escape, popover closes and active index resets
        expect(input).not.toHaveAttribute("aria-activedescendant");
    });

    it("Tab closes the popover", async () => {
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "Augs");
        await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());

        await user.tab();
        await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    });
});

// -- Popover open/close behavior ----------------------------------------------

describe("LocationSearch popover stability", () => {
    beforeEach(() => {
        localStorage.clear();
        mockFetch.mockReset();
    });

    it("opens on focus when bookmarks exist", async () => {
        localStorage.setItem(BOOKMARKS_KEY, JSON.stringify([BOOKMARK_A]));
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.click(input);
        await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
        expect(screen.getByText("Home")).toBeInTheDocument();
    });

    it("does not open on focus when no bookmarks and no query", async () => {
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.click(input);
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("shows bookmarks on focus", async () => {
        localStorage.setItem(BOOKMARKS_KEY, JSON.stringify([BOOKMARK_A]));
        const user = userEvent.setup();
        renderSearch();

        await user.click(screen.getByRole("combobox"));
        await waitFor(() => expect(screen.getByText("Home")).toBeInTheDocument());
    });
});

// -- Bookmark integration -----------------------------------------------------

describe("LocationSearch bookmarks integration", () => {
    beforeEach(() => {
        localStorage.clear();
        mockFetch.mockReset();
    });

    it("bookmark icon appears on hover for unbookmarked items", async () => {
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "König");
        await waitFor(() => expect(screen.getByText("Königsplatz")).toBeInTheDocument());

        // Bookmark toggle should exist
        expect(screen.getByTitle("Als Favorit speichern")).toBeInTheDocument();
    });

    it("clicking bookmark icon saves to localStorage", async () => {
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "König");
        await waitFor(() => expect(screen.getByText("Königsplatz")).toBeInTheDocument());

        await user.click(screen.getByTitle("Als Favorit speichern"));
        const saved = JSON.parse(localStorage.getItem(BOOKMARKS_KEY)!);
        expect(saved).toHaveLength(1);
        expect(saved[0].name).toBe("Königsplatz");
    });

    it("bookmarked item shows filled icon and remove title", async () => {
        localStorage.setItem(BOOKMARKS_KEY, JSON.stringify([{
            name: "Königsplatz", lat: 48.367, lon: 10.893, type: "station",
        }]));

        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "König");
        await waitFor(() => expect(screen.getByText("Königsplatz")).toBeInTheDocument());

        expect(screen.getByTitle("Favorit entfernen")).toBeInTheDocument();
    });

    it("clicking bookmark remove unbookmarks and updates localStorage", async () => {
        localStorage.setItem(BOOKMARKS_KEY, JSON.stringify([{
            name: "Königsplatz", lat: 48.367, lon: 10.893, type: "station",
        }]));

        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "König");
        await waitFor(() => expect(screen.getByTitle("Favorit entfernen")).toBeInTheDocument());

        await user.click(screen.getByTitle("Favorit entfernen"));
        const saved = JSON.parse(localStorage.getItem(BOOKMARKS_KEY)!);
        expect(saved).toHaveLength(0);
    });

    it("selecting a bookmark calls onChange", async () => {
        localStorage.setItem(BOOKMARKS_KEY, JSON.stringify([BOOKMARK_A]));
        const user = userEvent.setup();
        const { onChange } = renderSearch();

        await user.click(screen.getByRole("combobox"));
        await waitFor(() => expect(screen.getByText("Home")).toBeInTheDocument());

        await user.click(screen.getByText("Home"));
        expect(onChange).toHaveBeenCalledWith(
            expect.objectContaining({ name: "Home", lat: 48.370, lon: 10.900 }),
        );
    });

    it("bookmarks appear on focus, then search results replace them", async () => {
        localStorage.setItem(BOOKMARKS_KEY, JSON.stringify([BOOKMARK_A]));
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.click(input);
        await waitFor(() => expect(screen.getByText("Home")).toBeInTheDocument());

        await user.type(input, "Augs");
        await waitFor(() => {
            expect(screen.getByText("Augsburg Hbf")).toBeInTheDocument();
            // Bookmark "Home" hidden when query doesn't match
            expect(screen.queryByText("Home")).not.toBeInTheDocument();
        });
    });

    it("keyboard navigation works across bookmarks and suggestions", async () => {
        localStorage.setItem(BOOKMARKS_KEY, JSON.stringify([BOOKMARK_A]));
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        // Focus opens bookmarks
        await user.click(input);
        await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());

        // ArrowDown selects the bookmark
        await user.keyboard("{ArrowDown}");
        const options = screen.getAllByRole("option");
        expect(options[0]).toHaveAttribute("aria-selected", "true");

        // Enter selects it
        await user.keyboard("{Enter}");
        expect(input).toHaveValue("Home");
    });

    it("matching bookmarks stay visible while typing a query that matches their name", async () => {
        localStorage.setItem(BOOKMARKS_KEY, JSON.stringify([BOOKMARK_A, BOOKMARK_B]));
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        // Type part of bookmark A's name ("Home")
        await user.type(input, "Ho");
        await waitFor(() => {
            // "Home" bookmark should still be visible
            expect(screen.getByText("Home")).toBeInTheDocument();
            // "Work" does not match "Ho" so it should not appear
            expect(screen.queryByText("Work")).not.toBeInTheDocument();
        });
    });

    it("bookmarks are deduplicated from search suggestions", async () => {
        // Bookmark Königsplatz — same coordinates as STATION_B
        localStorage.setItem(BOOKMARKS_KEY, JSON.stringify([{
            name: "Königsplatz", lat: 48.367, lon: 10.893, type: "station",
        }]));
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "König");
        await waitFor(() => {
            // There should be only one Königsplatz option (the bookmark),
            // not a duplicate in the suggestions
            const options = screen.getAllByRole("option");
            const kpOptions = options.filter(o => within(o).queryByText("Königsplatz"));
            expect(kpOptions).toHaveLength(1);
        });
    });
});

// -- Cross-instance bookmark sync ---------------------------------------------

describe("LocationSearch cross-instance bookmark sync", () => {
    beforeEach(() => {
        localStorage.clear();
        mockFetch.mockReset();
    });

    it("saveBookmarks dispatches a custom event for same-page sync", () => {
        const handler = vi.fn();
        window.addEventListener(BOOKMARKS_CHANGED_EVENT, handler);
        saveBookmarks([BOOKMARK_A]);
        expect(handler).toHaveBeenCalledTimes(1);
        window.removeEventListener(BOOKMARKS_CHANGED_EVENT, handler);
    });

    it("second instance picks up bookmarks saved by the first", async () => {
        const user = userEvent.setup();

        // Render two search bars (like start + destination)
        const onChange1 = vi.fn();
        const onChange2 = vi.fn();
        const { unmount } = render(
            <>
                <LocationSearch
                    stations={STATIONS}
                    value={null}
                    onChange={onChange1}
                    label="Start"
                />
                <LocationSearch
                    stations={STATIONS}
                    value={null}
                    onChange={onChange2}
                    label="Ziel"
                />
            </>,
        );

        // Type in the first search bar to get a suggestion
        const inputs = screen.getAllByRole("combobox");
        await user.type(inputs[0], "König");
        await waitFor(() => expect(screen.getByText("Königsplatz")).toBeInTheDocument());

        // Bookmark it in the first search bar
        await user.click(screen.getByTitle("Als Favorit speichern"));
        expect(JSON.parse(localStorage.getItem(BOOKMARKS_KEY)!)).toHaveLength(1);

        // Now focus the second search bar — the bookmark should appear there too
        await user.click(inputs[1]);
        await waitFor(() => {
            expect(screen.getByText("Königsplatz")).toBeInTheDocument();
        });

        unmount();
    });
});

// -- Recents unit tests -------------------------------------------------------

describe("recents helpers", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it("loadRecents returns empty array when no data", () => {
        expect(loadRecents()).toEqual([]);
    });

    it("loadRecents returns saved recents", () => {
        localStorage.setItem(RECENTS_KEY, JSON.stringify([BOOKMARK_A]));
        expect(loadRecents()).toEqual([BOOKMARK_A]);
    });

    it("loadRecents returns empty array on corrupt JSON", () => {
        localStorage.setItem(RECENTS_KEY, "bad-json");
        expect(loadRecents()).toEqual([]);
    });

    it("saveRecent persists to localStorage sorted by frequency", () => {
        const loc1: GeocodeSuggestion = { name: "A", lat: 1, lon: 1, type: "address" };
        const loc2: GeocodeSuggestion = { name: "B", lat: 2, lon: 2, type: "poi" };
        saveRecent(loc1);
        saveRecent(loc2);
        // Both have useCount=1, both are present
        const stored = loadRecents();
        expect(stored).toHaveLength(2);
        const names = stored.map(s => s.name).sort();
        expect(names).toEqual(["A", "B"]);

        // Use A again — now A should be first (higher useCount)
        saveRecent(loc1);
        const sorted = loadRecents();
        expect(sorted[0].name).toBe("A");
        expect(sorted[0].useCount).toBe(2);
    });

    it("saveRecent deduplicates by coordinates", () => {
        const loc: GeocodeSuggestion = { name: "Place", lat: 48.0, lon: 10.0, type: "address" };
        saveRecent(loc);
        saveRecent({ ...loc, name: "Place Updated" });
        const stored = loadRecents();
        expect(stored).toHaveLength(1);
        // Existing entry's useCount is incremented, name stays the same
        expect(stored[0].name).toBe("Place");
        expect(stored[0].useCount).toBe(2);
    });

    it("saveRecent limits to 10 entries", () => {
        for (let i = 0; i < 15; i++) {
            saveRecent({ name: `Loc ${i}`, lat: i, lon: i, type: "address" });
        }
        expect(loadRecents()).toHaveLength(10);
        expect(loadRecents()[0].name).toBe("Loc 14"); // most recent
    });

    it("saveRecent dispatches a custom event", () => {
        const handler = vi.fn();
        window.addEventListener(RECENTS_CHANGED_EVENT, handler);
        saveRecent({ name: "Test", lat: 1, lon: 1, type: "address" });
        expect(handler).toHaveBeenCalledTimes(1);
        window.removeEventListener(RECENTS_CHANGED_EVENT, handler);
    });
});

// -- Recents integration ------------------------------------------------------

describe("LocationSearch recents integration", () => {
    beforeEach(() => {
        localStorage.clear();
        mockFetch.mockReset();
    });

    it("selecting a suggestion saves it to recents", async () => {
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "König");
        await waitFor(() => expect(screen.getByText("Königsplatz")).toBeInTheDocument());

        await user.click(screen.getByText("Königsplatz"));
        const recents = loadRecents();
        expect(recents).toHaveLength(1);
        expect(recents[0].name).toBe("Königsplatz");
    });

    it("shows recents on focus when no bookmarks", async () => {
        saveRecent({ name: "Königsplatz", lat: 48.367, lon: 10.893, type: "station" });
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.click(input);
        await waitFor(() => {
            expect(screen.getByText("Königsplatz")).toBeInTheDocument();
        });
    });

    it("recents are hidden when the same location is bookmarked", async () => {
        const loc = { name: "Königsplatz", lat: 48.367, lon: 10.893, type: "station" as const };
        saveRecent(loc);
        saveBookmarks([{ ...loc }]);
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.click(input);
        await waitFor(() => {
            // Bookmarked Königsplatz should appear (as a favorite), not as a recent
            const options = screen.getAllByRole("option");
            expect(options).toHaveLength(1);
            expect(within(options[0]).getByText("Königsplatz")).toBeInTheDocument();
        });
    });

    it("recents are deduplicated from search suggestions", async () => {
        // Save Königsplatz as a recent — same coords as STATION_B
        saveRecent({ name: "Königsplatz", lat: 48.367, lon: 10.893, type: "station" });
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "König");
        await waitFor(() => {
            // Only one Königsplatz should appear (in recents, not duplicated in suggestions)
            const options = screen.getAllByRole("option");
            const kpOptions = options.filter(o => within(o).queryByText("Königsplatz"));
            expect(kpOptions).toHaveLength(1);
        });
    });

    it("recents filter by query", async () => {
        saveRecent({ name: "Königsplatz", lat: 48.367, lon: 10.893, type: "station" });
        saveRecent({ name: "Augsburg Hbf", lat: 48.365, lon: 10.886, type: "station" });
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.type(input, "König");
        await waitFor(() => {
            // Only Königsplatz should appear in recents (Augsburg Hbf doesn't match "König")
            const listbox = screen.getByRole("listbox");
            expect(within(listbox).getByText("Königsplatz")).toBeInTheDocument();
            expect(within(listbox).queryByText("Augsburg Hbf")).not.toBeInTheDocument();
        });
    });

    it("selecting a recent calls onChange", async () => {
        saveRecent({ name: "Königsplatz", lat: 48.367, lon: 10.893, type: "station" });
        const user = userEvent.setup();
        const { onChange } = renderSearch();
        const input = screen.getByRole("combobox");

        await user.click(input);
        await waitFor(() => expect(screen.getByText("Königsplatz")).toBeInTheDocument());

        await user.click(screen.getByText("Königsplatz"));
        expect(onChange).toHaveBeenCalledWith(
            expect.objectContaining({ name: "Königsplatz", lat: 48.367, lon: 10.893 }),
        );
    });

    it("keyboard navigation works across recents and suggestions", async () => {
        saveRecent({ name: "Hauptbahnhof", lat: 48.365, lon: 10.886, type: "station" });
        const user = userEvent.setup();
        renderSearch();
        const input = screen.getByRole("combobox");

        await user.click(input);
        await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());

        await user.keyboard("{ArrowDown}");
        const options = screen.getAllByRole("option");
        expect(options[0]).toHaveAttribute("aria-selected", "true");

        await user.keyboard("{Enter}");
        expect(input).toHaveValue("Hauptbahnhof");
    });
});
