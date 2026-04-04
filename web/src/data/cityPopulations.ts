interface CityEntry {
    name: string;
    ascii: string;
    pop: number;
}

let citiesPromise: Promise<CityEntry[]> | null = null;
let nameIndex: Map<string, CityEntry> | null = null;

/** Lazily load city population data. Cached after first call. */
async function loadCities(): Promise<CityEntry[]> {
    if (!citiesPromise) {
        citiesPromise = fetch("/data/city-populations.json")
            .then((r) => (r.ok ? r.json() : []))
            .catch(() => []);
    }
    return citiesPromise;
}

/** Build a case-insensitive name index for fast lookup. */
async function getNameIndex(): Promise<Map<string, CityEntry>> {
    if (nameIndex) return nameIndex;
    const cities = await loadCities();
    nameIndex = new Map();
    for (const city of cities) {
        // Index by both localized name and ASCII name (lowercased)
        const key = city.name.toLowerCase();
        // Keep the first (largest population) entry for duplicate names
        if (!nameIndex.has(key)) nameIndex.set(key, city);
        const asciiKey = city.ascii.toLowerCase();
        if (asciiKey !== key && !nameIndex.has(asciiKey)) nameIndex.set(asciiKey, city);
    }
    return nameIndex;
}

/** Look up population for a city name. Returns null if not found.
 *  Tries exact match first, then strips parenthetical suffixes
 *  like "Lauingen (Donau)" → "Lauingen". */
export async function getCityPopulation(
    name: string
): Promise<{ population: number; name: string } | null> {
    const index = await getNameIndex();
    const lower = name.toLowerCase();
    // Exact match
    let entry = index.get(lower);
    if (!entry) {
        // Strip parenthetical suffix: "Lauingen (Donau)" → "Lauingen"
        const withoutParen = lower.replace(/\s*\(.*\)\s*$/, "").trim();
        if (withoutParen !== lower) {
            entry = index.get(withoutParen);
        }
    }
    if (!entry) {
        // Strip "am/an der/im/bei" suffixes: "Frankfurt am Main" is already in GeoNames,
        // but some map labels may differ
        const simplified = lower.replace(/\s+(am|an der|im|bei)\s+.*$/, "").trim();
        if (simplified !== lower) {
            entry = index.get(simplified);
        }
    }
    if (!entry) return null;
    return { population: entry.pop, name: entry.name };
}

/** Format a population number with dots as thousands separator (German style). */
export function formatPopulation(pop: number): string {
    return pop.toLocaleString("de-DE");
}
