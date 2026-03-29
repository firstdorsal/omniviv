import { Clock, LocateFixed, MapPinned, Star, X } from "lucide-react";
import { PinheadIcon, getPinheadIconName } from "./PinheadIcon";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Station } from "../api";
import { getConfig } from "../config";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";

/** Type of resolved location entity */
export type LocationType = "station" | "address" | "poi" | "gps" | "map" | "coordinates";

export interface ResolvedLocation {
    name: string;
    lat: number;
    lon: number;
    type: LocationType;
    /** Pinhead icon name override (derived from MOTIS category or OSM tags) */
    iconName?: string;
}

interface LocationSearchProps {
    /** Label shown above the input */
    label?: string;
    placeholder?: string;
    /** Known stations for local matching (instant, no network) */
    stations: Station[];
    /** Currently selected location */
    value: ResolvedLocation | null;
    onChange: (location: ResolvedLocation | null) => void;
    /** Show GPS button */
    showGps?: boolean;
    /** Show "pick on map" button */
    showMapPick?: boolean;
    /** Currently picking on map */
    isPickingOnMap?: boolean;
    onPickOnMap?: () => void;
    /** Auto-focus the input. Pass a changing value (e.g. timestamp) to re-trigger. */
    autoFocus?: number | boolean;
}

/** Icon for a location type, using Pinhead map icons.
 *  If iconName is provided (from MOTIS category), uses that directly.
 *  GPS and map types use Lucide icons directly. */
export function LocationTypeIcon({ type, iconName, className = "h-4 w-4" }: { type: LocationType; iconName?: string; className?: string }) {
    if (type === "gps") return <LocateFixed className={className} />;
    if (type === "map") return <MapPinned className={className} />;
    return <PinheadIcon name={iconName ?? getPinheadIconName(type)} className={className} />;
}

export interface GeocodeSuggestion {
    name: string;
    lat: number;
    lon: number;
    type: LocationType;
    /** Specific Pinhead icon name from MOTIS category */
    iconName?: string;
    detail?: string;
}

// -- Bookmarks (localStorage) ------------------------------------------------

export interface LocationBookmark {
    name: string;
    lat: number;
    lon: number;
    type: LocationType;
    iconName?: string;
    detail?: string;
}

export const BOOKMARKS_KEY = "omniviv-location-bookmarks";

export function loadBookmarks(): LocationBookmark[] {
    try {
        const raw = localStorage.getItem(BOOKMARKS_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

export function saveBookmarks(bookmarks: LocationBookmark[]) {
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks));
    // Notify other LocationSearch instances on the same page
    window.dispatchEvent(new CustomEvent(BOOKMARKS_CHANGED_EVENT));
}

export const BOOKMARKS_CHANGED_EVENT = "omniviv-bookmarks-changed";

// -- Recents (localStorage) ---------------------------------------------------

export const RECENTS_KEY = "omniviv-location-recents";
export const RECENTS_CHANGED_EVENT = "omniviv-recents-changed";
const MAX_RECENTS = 10;

export function loadRecents(): LocationBookmark[] {
    try {
        const raw = localStorage.getItem(RECENTS_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

export function saveRecent(location: GeocodeSuggestion) {
    const recents = loadRecents();
    // Remove existing entry for the same location (by proximity)
    const filtered = recents.filter(
        r => !(Math.abs(r.lat - location.lat) < 1e-6 && Math.abs(r.lon - location.lon) < 1e-6),
    );
    // Prepend new entry (MRU order), trim to max
    const entry: LocationBookmark = {
        name: location.name,
        lat: location.lat,
        lon: location.lon,
        type: location.type,
        iconName: location.iconName,
        detail: location.detail,
    };
    const updated = [entry, ...filtered].slice(0, MAX_RECENTS);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(updated));
    window.dispatchEvent(new CustomEvent(RECENTS_CHANGED_EVENT));
}

export function isBookmarked(bookmarks: LocationBookmark[], loc: { lat: number; lon: number }): boolean {
    return bookmarks.some(b => Math.abs(b.lat - loc.lat) < 1e-6 && Math.abs(b.lon - loc.lon) < 1e-6);
}

export function toggleBookmark(
    bookmarks: LocationBookmark[],
    suggestion: GeocodeSuggestion,
): LocationBookmark[] {
    const idx = bookmarks.findIndex(
        b => Math.abs(b.lat - suggestion.lat) < 1e-6 && Math.abs(b.lon - suggestion.lon) < 1e-6,
    );
    if (idx >= 0) {
        return bookmarks.filter((_, i) => i !== idx);
    }
    return [...bookmarks, {
        name: suggestion.name,
        lat: suggestion.lat,
        lon: suggestion.lon,
        type: suggestion.type,
        iconName: suggestion.iconName,
        detail: suggestion.detail,
    }];
}

// -- Helpers ------------------------------------------------------------------

/** Read the current map center from the URL hash (format: #lat,lng,zoom,pitch,bearing). */
function getMapCenterFromHash(): { lat: number; lon: number } | null {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return null;
    const parts = hash.split(",");
    if (parts.length < 2) return null;
    const lat = parseFloat(parts[0]);
    const lon = parseFloat(parts[1]);
    if (isNaN(lat) || isNaN(lon)) return null;
    return { lat, lon };
}

function mapMotisType(motisType: string): LocationType {
    switch (motisType) {
        case "STOP": return "station";
        case "PLACE": return "poi";
        case "ADDRESS": return "address";
        default: return "address";
    }
}

/**
 * Extract the icon name from a MOTIS category string.
 * MOTIS categories have a size suffix (e.g. "restaurant_14", "cafe_16")
 * that we strip to get the base category name which maps directly to
 * Maki/Temaki icon names.
 */
function motisCategoryToIconName(category: string | undefined): string | undefined {
    if (!category) return undefined;
    // Strip size suffix: "restaurant_14" → "restaurant"
    return category.replace(/_\d+$/, "");
}

export function formatArea(areas: Array<{ name: string; adminLevel: number; default?: boolean }> | undefined): string | undefined {
    if (!areas || areas.length === 0) return undefined;
    const neighborhood = areas.find(a => a.adminLevel === 10 || a.adminLevel === 11);
    // City: prefer level 6/8, fall back to level 4 (city-states like Berlin/Hamburg)
    const city = areas.find(a => a.adminLevel === 6 || a.adminLevel === 8)
        ?? areas.find(a => a.adminLevel === 4);
    if (neighborhood && city && neighborhood.name !== city.name) {
        return `${neighborhood.name}, ${city.name}`;
    }
    // If we only have a neighborhood but no city, still show the neighborhood
    if (neighborhood) return neighborhood.name;
    return city?.name;
}

/**
 * Map a MOTIS category string to a human-readable German label.
 *
 * Categories are defined in triptix-tech/adr (the geocoding library used by
 * MOTIS): https://github.com/triptix-tech/adr/blob/master/include/adr/categories.h
 * The suffix (_14, _16, …) encodes the icon size and is stripped before lookup.
 */
export function categoryToLabel(category: string | undefined): string | undefined {
    if (!category || category === "none") return undefined;
    const base = category.replace(/_\d+$/, "");
    if (HIDDEN_CATEGORIES.has(base)) return undefined;
    return CATEGORY_LABELS[base] ?? base.replace(/_/g, " ");
}

/** Categories that are generic map markers and should not be shown as labels. */
const HIDDEN_CATEGORIES = new Set([
    "place", "place_capital", "rect", "rectdiag",
    "entrance", "entrance_main", "extra",
]);

/** German labels for MOTIS/adr geocode categories (size suffix already stripped). */
const CATEGORY_LABELS: Record<string, string> = {
    // -- Food & drink ---------------------------------------------------------
    restaurant: "Restaurant", cafe: "Café", fast_food: "Schnellimbiss",
    bar: "Bar", pub: "Kneipe", ice_cream: "Eisdiele",
    biergarten: "Biergarten", outdoor_seating: "Außengastronomie",

    // -- Culture & entertainment ----------------------------------------------
    artwork: "Kunstwerk", community_centre: "Gemeindezentrum",
    library: "Bibliothek", museum: "Museum", theatre: "Theater",
    cinema: "Kino", nightclub: "Nachtclub", arts_centre: "Kulturzentrum",
    gallery: "Galerie", internet_cafe: "Internetcafé", casino: "Spielbank",
    public_bookcase: "Bücherschrank", amusement_arcade: "Spielhalle",

    // -- Historic -------------------------------------------------------------
    memorial: "Denkmal", archaeological_site: "Ausgrabungsstätte",
    monument: "Monument", castle: "Burg", statue: "Statue",
    palace: "Schloss", fortress: "Festung", historic_fort: "Festung",
    bust: "Büste", city_gate: "Stadttor", manor: "Herrenhaus",
    obelisk: "Obelisk", plaque: "Gedenktafel", stone: "Gedenkstein",
    carto_shrine: "Schrein",

    // -- Leisure & sports -----------------------------------------------------
    playground: "Spielplatz", fitness: "Fitnessstudio",
    swimming: "Schwimmbad", massage: "Massagepraxis", sauna: "Sauna",
    public_bath: "Öffentliches Bad", miniature_golf: "Minigolf",
    beach_resort: "Strandbad", fishing: "Angelplatz",
    bowling_alley: "Bowlingbahn", dog_park: "Hundepark",
    leisure_dance: "Tanzschule", golf_icon: "Golfplatz",
    leisure_golf_pin: "Golfplatz",
    sports_centre: "Sportzentrum", stadium: "Stadion",

    // -- Amenities & utilities ------------------------------------------------
    toilets: "Toilette", recycling: "Recycling",
    waste_basket: "Abfalleimer", waste_disposal: "Wertstoffhof",
    bench: "Sitzbank", shelter: "Unterstand",
    drinking_water: "Trinkwasser", picnic_site: "Picknickplatz",
    fountain: "Brunnen", camping: "Campingplatz", caravan: "Wohnmobilstellplatz",
    bbq: "Grillplatz", shower: "Dusche", firepit: "Feuerstelle",
    bird_hide: "Vogelbeobachtungshütte", table: "Tisch",
    excrement_bags: "Hundekotbeutel",

    // -- Tourism & information ------------------------------------------------
    guidepost: "Wegweiser", board: "Infotafel", map: "Karte",
    office: "Büro", terminal: "Terminal", audioguide: "Audioguide",
    viewpoint: "Aussichtspunkt",

    // -- Accommodation --------------------------------------------------------
    hotel: "Hotel", tourism_guest_house: "Pension", hostel: "Hostel",
    chalet: "Ferienhaus", motel: "Motel", apartment: "Ferienwohnung",
    alpinehut: "Berghütte", wilderness_hut: "Schutzhütte",

    // -- Financial ------------------------------------------------------------
    bank: "Bank", atm: "Geldautomat", bureau_de_change: "Wechselstube",

    // -- Health ---------------------------------------------------------------
    pharmacy: "Apotheke", hospital: "Krankenhaus",
    doctors: "Arztpraxis", dentist: "Zahnarzt", veterinary: "Tierarzt",

    // -- Education ------------------------------------------------------------
    school: "Schule", kindergarten: "Kindergarten",
    university: "Universität", college: "Hochschule",

    // -- Post & communication -------------------------------------------------
    post_box: "Briefkasten", post_office: "Post",
    parcel_locker: "Packstation", telephone: "Telefon",
    emergency_phone: "Notrufsäule",

    // -- Transport ------------------------------------------------------------
    parking: "Parkplatz", parking_subtle: "Parkplatz",
    bus_stop: "Bushaltestelle", fuel: "Tankstelle",
    parking_bicycle: "Fahrradstellplatz",
    rendering_railway_tram_stop_mapnik: "Tramhaltestelle",
    amenity_bus_station: "Busbahnhof", helipad: "Hubschrauberlandeplatz",
    aerodrome: "Flugplatz", rental_bicycle: "Fahrradverleih",
    taxi: "Taxistand", parking_tickets: "Parkautomat",
    subway_entrance: "U-Bahn-Eingang", charging_station: "Ladestation",
    elevator: "Aufzug", rental_car: "Autovermietung",
    parking_entrance: "Parkhaus-Einfahrt",
    public_transport_tickets: "Fahrkartenverkauf",
    ferry_icon: "Fähre", parking_motorcycle: "Motorradparkplatz",
    bicycle_repair_station: "Fahrradreparaturstation",
    boat_rental: "Bootsverleih",
    parking_entrance_multi_storey: "Parkhaus-Einfahrt",
    transport_slipway: "Slipanlage",

    // -- Government & public services -----------------------------------------
    police: "Polizei", town_hall: "Rathaus", townhall: "Rathaus",
    fire_station: "Feuerwehr", social_facility: "Soziale Einrichtung",
    courthouse: "Gericht", prison: "Gefängnis",
    diplomatic: "Botschaft", office_diplomatic_consulate: "Konsulat",
    social_amenity_darken: "Soziale Einrichtung",

    // -- Religion -------------------------------------------------------------
    christian: "Kirche", jewish: "Synagoge", muslim: "Moschee",
    taoist: "Taoistischer Tempel", hinduist: "Hindutempel",
    buddhist: "Buddhistischer Tempel", shintoist: "Shintō-Schrein",
    sikhist: "Gurdwara", place_of_worship: "Gebetsstätte",
    church: "Kirche", mosque: "Moschee", synagogue: "Synagoge",

    // -- Shopping -------------------------------------------------------------
    marketplace: "Marktplatz", convenience: "Kiosk",
    supermarket: "Supermarkt", clothes: "Bekleidungsgeschäft",
    hairdresser: "Friseur", bakery: "Bäckerei",
    car_repair: "Autowerkstatt", doityourself: "Baumarkt",
    purple_car: "Autohaus", newsagent: "Zeitungsladen",
    beauty: "Kosmetikstudio", car_wash: "Waschanlage",
    butcher: "Metzgerei", alcohol: "Getränkemarkt",
    furniture: "Möbelgeschäft", florist: "Blumenladen",
    mobile_phone: "Handyladen", electronics: "Elektronikgeschäft",
    shoes: "Schuhgeschäft", car_parts: "Autoteile",
    greengrocer: "Gemüsehändler", laundry: "Waschsalon",
    optician: "Optiker", jewellery: "Juwelier", jeweller: "Juwelier",
    books: "Buchhandlung", gift: "Geschenkeladen",
    department_store: "Kaufhaus", bicycle: "Fahrradladen",
    confectionery: "Süßwarenladen", variety_store: "Ramschladen",
    travel_agency: "Reisebüro", sports: "Sportgeschäft",
    chemist: "Drogerie", computer: "Computerladen",
    stationery: "Schreibwarengeschäft", pet: "Tierhandlung",
    beverages: "Getränkemarkt", perfumery: "Parfümerie",
    tyres: "Reifenhändler", shop_motorcycle: "Motorradgeschäft",
    garden_centre: "Gartencenter", copyshop: "Copyshop",
    toys: "Spielwarenladen", deli: "Feinkost",
    tobacco: "Tabakladen", seafood: "Fischgeschäft",
    interior_decoration: "Raumausstatter", ticket: "Ticketverkauf",
    photo: "Fotoladen", trade: "Fachhandel",
    outdoor: "Outdoorladen", houseware: "Haushaltswarenladen",
    art: "Kunsthandlung", paint: "Farbenfachgeschäft",
    fabric: "Stoffladen", bookmaker: "Wettbüro",
    second_hand: "Second-Hand-Laden", charity: "Sozialkaufhaus",
    bed: "Bettenfachgeschäft", medical_supply: "Sanitätshaus",
    hifi: "HiFi-Geschäft", shop_music: "Musikladen",
    coffee: "Kaffeerösterei", hearing_aids: "Hörgeräteakustiker",
    musical_instrument: "Musikinstrumente", tea: "Teeladen",
    video: "Videothek", bag: "Taschengeschäft",
    carpet: "Teppichladen", video_games: "Videospielladen",
    vehicle_inspection: "TÜV/Dekra", dairy: "Käserei",
    shop_other: "Geschäft",

    // -- Natural --------------------------------------------------------------
    tree: "Baum", peak: "Gipfel", spring: "Quelle",
    cave: "Höhle", waterfall: "Wasserfall", saddle: "Bergsattel",
    volcano: "Vulkan",

    // -- Infrastructure -------------------------------------------------------
    water_tower: "Wasserturm", lighthouse: "Leuchtturm",
    windmill: "Windmühle", storage_tank: "Speichertank",
    tower_freestanding: "Turm", tower_observation: "Aussichtsturm",
    tower_bell_tower: "Glockenturm", hunting_stand: "Hochsitz",

    // -- Place types ----------------------------------------------------------
    hamlet: "Weiler", isolated_dwelling: "Einzelgehöft",
    farm: "Bauernhof", allotments: "Kleingärten",
    island: "Insel", islet: "Inselchen", square: "Platz",
    locality: "Örtlichkeit", village: "Dorf", town: "Kleinstadt",
    city: "Stadt", suburb: "Vorort", neighbourhood: "Viertel",
    borough: "Bezirk", quarter: "Stadtviertel",

    // -- Cemetery / misc ------------------------------------------------------
    cemetery: "Friedhof", food_court: "Gastrobereich",
    park: "Park",
};

// -- Component ----------------------------------------------------------------

const LISTBOX_ID = "location-search-listbox";

export function LocationSearch({
    label,
    placeholder = "Adresse, Haltestelle oder Ort...",
    stations,
    value,
    onChange,
    showGps = false,
    showMapPick = false,
    isPickingOnMap = false,
    onPickOnMap,
    autoFocus = false,
}: LocationSearchProps) {
    const [query, setQuery] = useState(value?.name ?? "");
    const [isOpen, setIsOpen] = useState(false);
    const [suggestions, setSuggestions] = useState<GeocodeSuggestion[]>([]);
    const [activeIndex, setActiveIndex] = useState(-1);
    const [isGeocoding, setIsGeocoding] = useState(false);
    const [bookmarks, setBookmarks] = useState<LocationBookmark[]>(loadBookmarks);
    const [recents, setRecents] = useState<LocationBookmark[]>(loadRecents);
    const inputRef = useRef<HTMLInputElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout>>();
    const abortRef = useRef<AbortController>();

    // Clean up debounce timer and in-flight fetches on unmount
    useEffect(() => {
        return () => {
            clearTimeout(debounceRef.current);
            abortRef.current?.abort();
        };
    }, []);

    // Auto-focus when requested (triggers on mount or when autoFocus value changes)
    useEffect(() => {
        if (autoFocus) {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    inputRef.current?.focus();
                });
            });
        }
    }, [autoFocus]);

    // Sync query when value changes externally
    useEffect(() => {
        if (value) setQuery(value.name);
    }, [value]);

    // Sync bookmarks and recents across LocationSearch instances (same page + cross-tab)
    useEffect(() => {
        const reloadBookmarks = () => setBookmarks(loadBookmarks());
        const reloadRecents = () => setRecents(loadRecents());
        const onStorage = (e: StorageEvent) => {
            if (e.key === BOOKMARKS_KEY) reloadBookmarks();
            if (e.key === RECENTS_KEY) reloadRecents();
        };
        window.addEventListener("storage", onStorage);
        window.addEventListener(BOOKMARKS_CHANGED_EVENT, reloadBookmarks);
        window.addEventListener(RECENTS_CHANGED_EVENT, reloadRecents);
        return () => {
            window.removeEventListener("storage", onStorage);
            window.removeEventListener(BOOKMARKS_CHANGED_EVENT, reloadBookmarks);
            window.removeEventListener(RECENTS_CHANGED_EVENT, reloadRecents);
        };
    }, []);

    // Enrich bookmarks with fresh detail from station data so stale
    // bookmarks (saved before detail lines existed) stay up-to-date.
    const enrichedBookmarks = useMemo(() => {
        return bookmarks.map(b => {
            // Only enrich station-type bookmarks that have no detail yet
            if (b.detail) return b;
            const station = stations.find(s =>
                Math.abs(s.lat - b.lat) < 1e-5 && Math.abs(s.lon - b.lon) < 1e-5,
            );
            if (!station) return b;
            const parts: string[] = ["Haltestelle"];
            if (station.platforms.length > 0) parts.push(`${station.platforms.length} Steige`);
            return { ...b, detail: parts.join(" · ") };
        });
    }, [bookmarks, stations]);

    // Filter bookmarks that match the current query (all when query is short)
    const matchingBookmarks = enrichedBookmarks.filter(b => {
        if (query.length < 2) return true;
        return b.name.toLowerCase().includes(query.toLowerCase());
    });
    const showBookmarks = matchingBookmarks.length > 0;

    // Enrich recents with fresh detail from station data (same as bookmarks)
    const enrichedRecents = useMemo(() => {
        return recents.map(r => {
            if (r.detail) return r;
            const station = stations.find(s =>
                Math.abs(s.lat - r.lat) < 1e-5 && Math.abs(s.lon - r.lon) < 1e-5,
            );
            if (!station) return r;
            const parts: string[] = ["Haltestelle"];
            if (station.platforms.length > 0) parts.push(`${station.platforms.length} Steige`);
            return { ...r, detail: parts.join(" · ") };
        });
    }, [recents, stations]);

    // Filter recents: match query, exclude bookmarked locations
    const matchingRecents = enrichedRecents.filter(r => {
        // Exclude if already a bookmark
        if (isBookmarked(bookmarks, r)) return false;
        if (query.length < 2) return true;
        return r.name.toLowerCase().includes(query.toLowerCase());
    });
    const showRecents = matchingRecents.length > 0;

    // Deduplicate suggestions against both bookmarks and recents
    const filteredSuggestions = (showBookmarks || showRecents)
        ? suggestions.filter(s => {
            if (showBookmarks && matchingBookmarks.some(b => Math.abs(b.lat - s.lat) < 1e-6 && Math.abs(b.lon - s.lon) < 1e-6)) return false;
            if (showRecents && matchingRecents.some(r => Math.abs(r.lat - s.lat) < 1e-6 && Math.abs(r.lon - s.lon) < 1e-6)) return false;
            return true;
        })
        : suggestions;

    // Build the flat list of visible items for keyboard navigation
    const visibleItems: GeocodeSuggestion[] = [];
    if (showBookmarks) visibleItems.push(...matchingBookmarks);
    if (showRecents) visibleItems.push(...matchingRecents);
    if (filteredSuggestions.length > 0) visibleItems.push(...filteredSuggestions);
    const showActions = showGps || (showMapPick && !!onPickOnMap);
    const hasContent = visibleItems.length > 0 || showActions;

    // Reset active index when the dropdown content changes.
    // Use stable state refs (not derived arrays which create new refs each render).
    useEffect(() => {
        setActiveIndex(-1);
    }, [suggestions, bookmarks, recents]);

    const handleToggleBookmark = (e: React.MouseEvent, suggestion: GeocodeSuggestion) => {
        e.stopPropagation();
        e.preventDefault();
        const next = toggleBookmark(bookmarks, suggestion);
        setBookmarks(next);
        saveBookmarks(next);
        // Keep focus on input so popover stays open
        inputRef.current?.focus();
    };

    const searchMotis = useCallback(async (text: string) => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setIsGeocoding(true);

        try {
            let url = `${getConfig().motisUrl}/api/v1/geocode?text=${encodeURIComponent(text)}`;
            const center = getMapCenterFromHash();
            if (center) {
                url += `&place=${center.lat},${center.lon}`;
            }
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) return [];
            const data = await response.json();
            return (data as Array<{ type: string; name: string; lat: number; lon: number; category?: string; street?: string; zip?: string; areas?: Array<{ name: string; adminLevel: number }> }>)
                .slice(0, 5)
                .map((r): GeocodeSuggestion => {
                    const parts: string[] = [];
                    const catLabel = categoryToLabel(r.category);
                    if (catLabel) {
                        parts.push(catLabel);
                    } else if (r.type === "STOP") {
                        parts.push("Haltestelle");
                    } else if (r.type === "ADDRESS") {
                        parts.push("Adresse");
                    }
                    if (r.street) parts.push(r.street);
                    const area = formatArea(r.areas);
                    if (area) parts.push(area);
                    return {
                        name: r.name,
                        lat: r.lat,
                        lon: r.lon,
                        type: mapMotisType(r.type),
                        iconName: motisCategoryToIconName(r.category),
                        detail: parts.length > 0 ? parts.join(" · ") : undefined,
                    };
                });
        } catch {
            return [];
        } finally {
            if (!controller.signal.aborted) setIsGeocoding(false);
        }
    }, []);

    const updateSuggestions = useCallback((text: string) => {
        if (text.length < 2) {
            setSuggestions([]);
            return;
        }

        // Instant: match local stations
        const lowerQuery = text.toLowerCase();
        const stationMatches: GeocodeSuggestion[] = stations
            .filter(s => s.name?.toLowerCase().includes(lowerQuery))
            .slice(0, 3)
            .map(s => {
                const parts: string[] = ["Haltestelle"];
                if (s.platforms.length > 0) parts.push(`${s.platforms.length} Steige`);
                return {
                    name: s.name ?? "",
                    lat: s.lat,
                    lon: s.lon,
                    type: "station" as const,
                    detail: parts.join(" · "),
                };
            });

        setSuggestions(stationMatches);

        // Debounced: MOTIS geocoding for addresses/POIs
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(async () => {
            const motisResults = await searchMotis(text);
            // Merge: stations first, then MOTIS results (deduplicated by name or proximity)
            const merged = [
                ...stationMatches,
                ...motisResults.filter(r =>
                    !stationMatches.some(s =>
                        s.name.toLowerCase() === r.name.toLowerCase()
                        || (Math.abs(s.lat - r.lat) < 5e-4 && Math.abs(s.lon - r.lon) < 5e-4)
                    )
                ),
            ].slice(0, 8);
            setSuggestions(merged);
        }, 300);
    }, [stations, searchMotis]);

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const text = e.target.value;
        setQuery(text);
        onChange(null);
        setIsOpen(true);
        updateSuggestions(text);
    };

    const handleSelect = useCallback((suggestion: GeocodeSuggestion) => {
        onChange({
            name: suggestion.name,
            lat: suggestion.lat,
            lon: suggestion.lon,
            type: suggestion.type,
            iconName: suggestion.iconName,
        });
        setQuery(suggestion.name);
        setIsOpen(false);
        setActiveIndex(-1);
        // Save to recents (skip GPS/map picks as they have transient coordinates).
        // The RECENTS_CHANGED_EVENT listener updates our local state.
        if (suggestion.type !== "gps" && suggestion.type !== "map") {
            saveRecent(suggestion);
        }
    }, [onChange]);

    const handleClear = () => {
        setQuery("");
        onChange(null);
        setSuggestions([]);
        setActiveIndex(-1);
        inputRef.current?.focus();
    };

    const handleGps = () => {
        if (!navigator.geolocation) return;
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                handleSelect({
                    name: "Aktueller Standort",
                    lat: pos.coords.latitude,
                    lon: pos.coords.longitude,
                    type: "gps",
                });
            },
            () => { /* ignore errors silently */ },
        );
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (!isOpen || !hasContent) {
            if (e.key === "ArrowDown" && hasContent) {
                e.preventDefault();
                setIsOpen(true);
            }
            return;
        }

        switch (e.key) {
            case "ArrowDown":
                e.preventDefault();
                setActiveIndex(prev => (prev + 1) % visibleItems.length);
                break;
            case "ArrowUp":
                e.preventDefault();
                setActiveIndex(prev => prev <= 0 ? visibleItems.length - 1 : prev - 1);
                break;
            case "Enter":
                e.preventDefault();
                if (activeIndex >= 0 && activeIndex < visibleItems.length) {
                    handleSelect(visibleItems[activeIndex]);
                }
                break;
            case "Escape":
                e.preventDefault();
                setIsOpen(false);
                setActiveIndex(-1);
                break;
            case "Tab":
                setIsOpen(false);
                setActiveIndex(-1);
                break;
        }
    };

    // Close popover when focus leaves both the input and the popover entirely.
    // Use a timeout to allow focus to move between the input and popover content
    // without triggering a close.
    const blurTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
    const handleBlur = () => {
        clearTimeout(blurTimeoutRef.current);
        blurTimeoutRef.current = setTimeout(() => {
            if (!containerRef.current?.contains(document.activeElement)) {
                setIsOpen(false);
                setActiveIndex(-1);
            }
        }, 0);
    };
    const handleFocus = () => {
        clearTimeout(blurTimeoutRef.current);
        setIsOpen(true);
    };

    const activeDescendant = activeIndex >= 0 ? `location-option-${activeIndex}` : undefined;

    return (
        <div ref={containerRef} onBlur={handleBlur} onFocusCapture={handleFocus}>
            {label && (
                <label className="text-xs font-medium text-muted-foreground block mb-1" id="location-search-label">
                    {label}
                </label>
            )}
            <Popover
                open={isOpen && hasContent}
                onOpenChange={(open) => {
                    // Only allow Radix to close if focus is truly outside
                    if (!open && containerRef.current?.contains(document.activeElement)) return;
                    setIsOpen(open);
                }}
            >
                <PopoverAnchor asChild>
                    <div className="relative">
                        {value && (
                            <div className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground">
                                <LocationTypeIcon type={value.type} iconName={value.iconName} className="h-3.5 w-3.5" />
                            </div>
                        )}
                        <input
                            ref={inputRef}
                            type="text"
                            role="combobox"
                            aria-expanded={isOpen && hasContent}
                            aria-controls={LISTBOX_ID}
                            aria-activedescendant={activeDescendant}
                            aria-autocomplete="list"
                            aria-labelledby={label ? "location-search-label" : undefined}
                            className={`flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${value ? "pl-7" : ""}`}
                            placeholder={placeholder}
                            value={query}
                            onChange={handleInputChange}
                            onKeyDown={handleKeyDown}
                            onClick={() => setIsOpen(true)}
                        />
                        {(value || query) && (
                            <button
                                type="button"
                                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground hover:text-foreground rounded"
                                onClick={handleClear}
                                aria-label="Eingabe löschen"
                                tabIndex={-1}
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </div>
                </PopoverAnchor>
                <PopoverContent
                    className="p-0 w-[var(--radix-popover-trigger-width)]"
                    align="start"
                    onOpenAutoFocus={(e) => e.preventDefault()}
                    onCloseAutoFocus={(e) => e.preventDefault()}
                    onInteractOutside={(e) => {
                        const target = e.target as Node | null;
                        if (target && containerRef.current?.contains(target)) {
                            e.preventDefault();
                        }
                    }}
                >
                    <ul
                        id={LISTBOX_ID}
                        role="listbox"
                        aria-label="Suchergebnisse"
                        className="py-1"
                    >
                        {showActions && (
                            <>
                                <li role="presentation" className="flex gap-1 px-2 py-1">
                                    {showGps && (
                                        <button
                                            type="button"
                                            className="flex-1 flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-muted"
                                            onClick={handleGps}
                                            onMouseDown={(e) => e.preventDefault()}
                                        >
                                            <LocateFixed className="h-4 w-4 shrink-0 text-muted-foreground" />
                                            Aktueller Standort
                                        </button>
                                    )}
                                    {showMapPick && onPickOnMap && (
                                        <button
                                            type="button"
                                            className={`flex-1 flex items-center gap-2 px-2 py-1.5 rounded text-sm ${isPickingOnMap ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                                            onClick={() => { onPickOnMap(); setIsOpen(false); }}
                                            onMouseDown={(e) => e.preventDefault()}
                                        >
                                            <MapPinned className="h-4 w-4 shrink-0 text-muted-foreground" />
                                            Auf Karte wählen
                                        </button>
                                    )}
                                </li>
                                {visibleItems.length > 0 && (
                                    <li role="presentation" className="my-0.5 border-t border-border" />
                                )}
                            </>
                        )}
                        {showBookmarks && matchingBookmarks.map((b, i) => (
                            <SuggestionRow
                                key={`bm-${b.lat}-${b.lon}`}
                                id={`location-option-${i}`}
                                suggestion={b}
                                bookmarked
                                active={activeIndex === i}
                                onSelect={handleSelect}
                                onToggleBookmark={handleToggleBookmark}
                            />
                        ))}
                        {showRecents && (
                            <>
                                {showBookmarks && (
                                    <li role="presentation" className="my-0.5 border-t border-border" />
                                )}
                                {matchingRecents.map((r, i) => {
                                    const itemIndex = (showBookmarks ? matchingBookmarks.length : 0) + i;
                                    return (
                                        <SuggestionRow
                                            key={`rc-${r.lat}-${r.lon}`}
                                            id={`location-option-${itemIndex}`}
                                            suggestion={r}
                                            bookmarked={isBookmarked(bookmarks, r)}
                                            recent
                                            active={activeIndex === itemIndex}
                                            onSelect={handleSelect}
                                            onToggleBookmark={handleToggleBookmark}
                                        />
                                    );
                                })}
                            </>
                        )}
                        {filteredSuggestions.length > 0 && (
                            <>
                                {(showBookmarks || showRecents) && (
                                    <li role="presentation" className="my-0.5 border-t border-border" />
                                )}
                                {filteredSuggestions.map((s, i) => {
                                    const itemIndex = (showBookmarks ? matchingBookmarks.length : 0) + (showRecents ? matchingRecents.length : 0) + i;
                                    return (
                                        <SuggestionRow
                                            key={`${s.type}-${s.lat}-${s.lon}-${i}`}
                                            id={`location-option-${itemIndex}`}
                                            suggestion={s}
                                            bookmarked={isBookmarked(bookmarks, s)}
                                            active={activeIndex === itemIndex}
                                            onSelect={handleSelect}
                                            onToggleBookmark={handleToggleBookmark}
                                        />
                                    );
                                })}
                            </>
                        )}
                        {isGeocoding && (
                            <li role="presentation" className="px-3 py-2 text-xs text-muted-foreground">Suche...</li>
                        )}
                    </ul>
                </PopoverContent>
            </Popover>
        </div>
    );
}

function SuggestionRow({
    id,
    suggestion,
    bookmarked,
    recent,
    active,
    onSelect,
    onToggleBookmark,
}: {
    id: string;
    suggestion: GeocodeSuggestion;
    bookmarked: boolean;
    recent?: boolean;
    active: boolean;
    onSelect: (s: GeocodeSuggestion) => void;
    onToggleBookmark: (e: React.MouseEvent, s: GeocodeSuggestion) => void;
}) {
    return (
        <li
            id={id}
            role="option"
            aria-selected={active}
            className={`px-3 py-2 text-left text-sm flex items-center gap-2 group cursor-pointer ${active ? "bg-muted" : "hover:bg-muted"}`}
            onClick={() => onSelect(suggestion)}
            onMouseDown={(e) => e.preventDefault()}
        >
            <LocationTypeIcon type={suggestion.type} iconName={suggestion.iconName} className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
                <div className="truncate">{suggestion.name}</div>
                {suggestion.detail && (
                    <div className="text-xs text-muted-foreground truncate">{suggestion.detail}</div>
                )}
            </div>
            {recent && !bookmarked && (
                <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span
                role="button"
                tabIndex={-1}
                className={`shrink-0 p-0.5 rounded hover:text-foreground ${bookmarked ? "text-foreground" : "text-muted-foreground/0 group-hover:text-muted-foreground"}`}
                onClick={(e) => onToggleBookmark(e, suggestion)}
                onMouseDown={(e) => e.preventDefault()}
                title={bookmarked ? "Favorit entfernen" : "Als Favorit speichern"}
                aria-label={bookmarked ? `${suggestion.name} aus Favoriten entfernen` : `${suggestion.name} als Favorit speichern`}
            >
                <Star className={`h-3.5 w-3.5 ${bookmarked ? "fill-current" : ""}`} />
            </span>
        </li>
    );
}
