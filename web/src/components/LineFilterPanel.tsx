import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Slider } from "./ui/slider";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { LineBadge } from "./LineBadge";
import { getApiClient } from "../apiClient";
import type { Route, RouteSearchRequest } from "../api";
import type { LineOverride, LineOverrideState } from "../App";

const DEFAULT_OPACITY = 0.8;

const ROUTE_TYPE_LABELS: ReadonlyArray<readonly [string, string]> = [
    ["tram", "Straßenbahn"],
    ["bus", "Bus"],
    ["train", "Bahn"],
    ["light_rail", "S-Bahn"],
    ["subway", "U-Bahn"],
    ["ferry", "Fähre"],
] as const;

interface LineFilterPanelProps {
    overrides: LineOverride[];
    onOverridesChange: (next: LineOverride[]) => void;
    /** Mirror of the layer panel's route type filter — synced with App state */
    visibleRouteTypes: string[];
    onVisibleRouteTypesChange: (next: string[]) => void;
    /** Mirror of the parent "Linien" toggle (showRoutes) — when off, type checkboxes are disabled. */
    routesEnabled: boolean;
    onRoutesEnabledChange: (next: boolean) => void;
}

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_LIMIT = 100;
const MIN_QUERY_LENGTH = 1;

/**
 * Parse a search query supporting `city:X` and `type:Y` filter prefixes.
 *
 * Example: "city:augsburg type:tram 1" → { city: "augsburg", type: "tram", text: "1" }
 *
 * Recognized type aliases:
 *   - tram, straßenbahn, strassenbahn → tram
 *   - bus → bus
 *   - bahn, train, zug → train
 *   - s-bahn, sbahn → light_rail
 *   - u-bahn, ubahn, subway → subway
 *   - fähre, faehre, ferry → ferry
 */
function parseQuery(input: string): { text: string; city: string | null; routeType: string | null } {
    const parts = input.split(/\s+/).filter(Boolean);
    let city: string | null = null;
    let routeType: string | null = null;
    const remainingParts: string[] = [];

    for (const part of parts) {
        const lower = part.toLowerCase();
        if (lower.startsWith("city:")) {
            city = part.slice(5);
            continue;
        }
        if (lower.startsWith("type:")) {
            routeType = normalizeRouteType(part.slice(5));
            continue;
        }
        remainingParts.push(part);
    }

    return {
        text: remainingParts.join(" ").trim(),
        city: city && city.length > 0 ? city : null,
        routeType,
    };
}

function normalizeRouteType(input: string): string | null {
    const lower = input.toLowerCase();
    if (["tram", "straßenbahn", "strassenbahn"].includes(lower)) return "tram";
    if (lower === "bus") return "bus";
    if (["bahn", "train", "zug"].includes(lower)) return "train";
    if (["s-bahn", "sbahn"].includes(lower)) return "light_rail";
    if (["u-bahn", "ubahn", "subway"].includes(lower)) return "subway";
    if (["fähre", "faehre", "ferry"].includes(lower)) return "ferry";
    return null;
}

function VisibilityToggleGroup({
    value,
    onValueChange,
    label,
}: {
    value: LineOverrideState;
    onValueChange: (next: LineOverrideState) => void;
    label: string;
}) {
    return (
        <ToggleGroup
            type="single"
            value={value}
            onValueChange={(next) => {
                if (!next) return; // ignore deselection (radio behavior)
                onValueChange(next as LineOverrideState);
            }}
            variant="outline"
            size="sm"
            aria-label={label}
            className="flex-shrink-0 gap-0"
        >
            <ToggleGroupItem
                value="shown"
                title="Erzwungen sichtbar"
                className="h-6 rounded-r-none border-r-0 px-2 text-xs"
            >
                An
            </ToggleGroupItem>
            <ToggleGroupItem
                value="auto"
                title="Folgt der Layer-Filtereinstellung"
                className="h-6 rounded-none border-r-0 px-2 text-xs"
            >
                Auto
            </ToggleGroupItem>
            <ToggleGroupItem
                value="hidden"
                title="Erzwungen versteckt"
                className="h-6 rounded-l-none px-2 text-xs"
            >
                Aus
            </ToggleGroupItem>
        </ToggleGroup>
    );
}

function shortLabel(route: Route): string {
    const name = route.name?.trim() ?? "";
    if (!name) return route.ref ?? route.route_type;
    // Strip "$ref: " prefix and direction arrow part for a more compact label
    // e.g. "Straßenbahn 1: Göggingen => Lechhausen Neuer Ostfriedhof" → "Göggingen ⇄ Lechhausen Neuer Ostfriedhof"
    const colonIdx = name.indexOf(":");
    const afterColon = colonIdx >= 0 ? name.slice(colonIdx + 1).trim() : name;
    return afterColon.replace(/=>/g, "→");
}

export function LineFilterPanel({
    overrides,
    onOverridesChange,
    visibleRouteTypes,
    onVisibleRouteTypesChange,
    routesEnabled,
    onRoutesEnabledChange,
}: LineFilterPanelProps) {
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<Route[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const overrideMap = useMemo(() => {
        const map = new Map<number, LineOverride>();
        for (const override of overrides) {
            map.set(override.osm_id, override);
        }
        return map;
    }, [overrides]);

    const runSearch = useCallback(async (rawQuery: string) => {
        const parsed = parseQuery(rawQuery);
        // Need at least one filter to search (text, city, or type)
        const hasAnyFilter =
            parsed.text.length >= MIN_QUERY_LENGTH || parsed.city !== null || parsed.routeType !== null;
        if (!hasAnyFilter) {
            setResults([]);
            setError(null);
            setIsLoading(false);
            return;
        }
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setIsLoading(true);
        setError(null);
        try {
            const request: RouteSearchRequest = { limit: SEARCH_LIMIT };
            if (parsed.text) request.query = parsed.text;
            if (parsed.city) request.city = parsed.city;
            if (parsed.routeType) request.route_type = parsed.routeType;
            const response = await getApiClient().api.searchRoutes(request, { signal: controller.signal });
            if (controller.signal.aborted) return;
            setResults(response.data.routes);
        } catch (err: unknown) {
            if (err instanceof DOMException && err.name === "AbortError") return;
            console.warn("Line search failed", err);
            setError("Suche fehlgeschlagen");
            setResults([]);
        } finally {
            if (!controller.signal.aborted) {
                setIsLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS);
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, [query, runSearch]);

    useEffect(() => {
        return () => abortRef.current?.abort();
    }, []);

    const setOverride = useCallback(
        (route: Route, state: LineOverrideState) => {
            const existing = overrides.find((o) => o.osm_id === route.osm_id);
            const filtered = overrides.filter((o) => o.osm_id !== route.osm_id);
            onOverridesChange([
                ...filtered,
                {
                    osm_id: route.osm_id,
                    state,
                    opacity: existing?.opacity ?? DEFAULT_OPACITY,
                    ref: route.ref ?? null,
                    name: route.name ?? null,
                    route_type: route.route_type,
                    color: route.color ?? null,
                    operator: route.operator ?? null,
                },
            ]);
        },
        [overrides, onOverridesChange],
    );

    const setOverrideStateById = useCallback(
        (osmId: number, state: LineOverrideState) => {
            onOverridesChange(
                overrides.map((o) => (o.osm_id === osmId ? { ...o, state } : o)),
            );
        },
        [overrides, onOverridesChange],
    );

    const setOverrideOpacity = useCallback(
        (osmId: number, opacity: number) => {
            onOverridesChange(
                overrides.map((o) => (o.osm_id === osmId ? { ...o, opacity } : o)),
            );
        },
        [overrides, onOverridesChange],
    );

    const removeOverride = useCallback(
        (osmId: number) => {
            onOverridesChange(overrides.filter((o) => o.osm_id !== osmId));
        },
        [overrides, onOverridesChange],
    );

    return (
        <div className="space-y-3">
            <div>
                <label className="text-muted-foreground mb-1 block text-xs font-medium uppercase">Linien-Filter</label>
                <p className="text-muted-foreground mb-2 text-xs">
                    Linien für ganz Deutschland suchen und einzeln ausblenden oder abdunkeln.
                </p>
                <p className="text-muted-foreground mb-2 text-xs">
                    Filter: <code className="bg-muted rounded px-1">city:augsburg</code>{" "}
                    <code className="bg-muted rounded px-1">type:tram</code>
                </p>
            </div>

            <div className="border-border space-y-1 rounded border p-2">
                <div className="text-muted-foreground mb-1 text-xs">Linien (synchronisiert mit Ebenen)</div>
                <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold">
                    <Checkbox
                        checked={routesEnabled}
                        onCheckedChange={(value) => onRoutesEnabledChange(value === true)}
                    />
                    <span>Linien anzeigen</span>
                </label>
                {ROUTE_TYPE_LABELS.map(([type, label]) => {
                    const checked = visibleRouteTypes.includes(type);
                    return (
                        <label
                            key={type}
                            className="flex cursor-pointer items-center gap-2 pl-5 text-xs"
                        >
                            <Checkbox
                                checked={checked}
                                disabled={!routesEnabled}
                                onCheckedChange={(value) => {
                                    const next = value
                                        ? [...visibleRouteTypes, type]
                                        : visibleRouteTypes.filter((t) => t !== type);
                                    onVisibleRouteTypesChange(next);
                                }}
                            />
                            <span className={routesEnabled ? "" : "text-muted-foreground"}>{label}</span>
                        </label>
                    );
                })}
            </div>

            {overrides.length > 0 && (
                <div className="border-border bg-muted/30 space-y-2 rounded border p-2">
                    <div className="text-muted-foreground text-xs">Aktive Überschreibungen ({overrides.length})</div>
                    {overrides.map((override) => {
                        const subtitle = override.name ?? "";
                        const ariaLabel = `${override.ref ?? "?"} ${subtitle}`.trim();
                        return (
                        <div
                            key={override.osm_id}
                            className="bg-background/50 space-y-1 rounded px-2 py-2 text-xs"
                        >
                            <div className="flex items-center gap-2">
                                <LineBadge
                                    line={override.ref ?? "?"}
                                    color={override.color ?? undefined}
                                    mode={override.route_type}
                                    operator={override.operator ?? undefined}
                                />
                                <span className="text-muted-foreground flex-1 truncate" title={subtitle}>
                                    {subtitle}
                                </span>
                                <VisibilityToggleGroup
                                    value={override.state}
                                    onValueChange={(next) => setOverrideStateById(override.osm_id, next)}
                                    label={`Sichtbarkeit für ${ariaLabel}`}
                                />
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-5 w-5"
                                    onClick={() => removeOverride(override.osm_id)}
                                    aria-label={`Override entfernen für ${ariaLabel}`}
                                >
                                    <X className="h-3 w-3" />
                                </Button>
                            </div>
                            {override.state === "shown" && (
                                <div className="flex items-center gap-2 pl-5">
                                    <span className="text-muted-foreground text-[10px] uppercase">Opacity</span>
                                    <Slider
                                        value={[override.opacity]}
                                        min={0}
                                        max={1}
                                        step={0.05}
                                        onValueChange={(value) => setOverrideOpacity(override.osm_id, value[0])}
                                        aria-label={`Opacity für ${ariaLabel}`}
                                        className="flex-1"
                                    />
                                    <span className="font-mono text-[10px] tabular-nums">
                                        {Math.round(override.opacity * 100)}%
                                    </span>
                                </div>
                            )}
                        </div>
                        );
                    })}
                </div>
            )}

            <div className="relative">
                <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 h-4 w-4 -translate-y-1/2" />
                <Input
                    type="text"
                    placeholder="z.B. 1, augsburg, city:augsburg type:tram"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className="pl-8"
                />
                {isLoading && (
                    <Loader2 className="text-muted-foreground absolute top-1/2 right-2 h-4 w-4 -translate-y-1/2 animate-spin" />
                )}
            </div>

            {error && <div className="text-destructive text-xs">{error}</div>}

            {results.length > 0 && (
                <div className="border-border max-h-80 space-y-1 overflow-y-auto rounded border p-2">
                    <div className="text-muted-foreground mb-1 text-xs">
                        Ergebnisse ({results.length}
                        {results.length === SEARCH_LIMIT ? "+" : ""})
                    </div>
                    {results.map((route) => {
                        const override = overrideMap.get(route.osm_id) ?? null;
                        // Default to "auto" when there is no override yet — clicking any state creates one
                        const state: LineOverrideState = override?.state ?? "auto";
                        const subtitle = shortLabel(route);
                        return (
                            <div
                                key={route.osm_id}
                                className="hover:bg-muted/50 flex items-center gap-2 rounded px-1 py-1 text-xs"
                            >
                                <LineBadge
                                    line={route.ref ?? "?"}
                                    color={route.color ?? undefined}
                                    mode={route.route_type}
                                    operator={route.operator ?? undefined}
                                />
                                <span className="text-muted-foreground flex-1 truncate" title={subtitle}>
                                    {subtitle}
                                </span>
                                <VisibilityToggleGroup
                                    value={state}
                                    onValueChange={(next) => setOverride(route, next)}
                                    label={`Sichtbarkeit für ${route.ref ?? route.osm_id}`}
                                />
                            </div>
                        );
                    })}
                </div>
            )}

            {!isLoading && query.trim().length >= MIN_QUERY_LENGTH && results.length === 0 && !error && (
                <div className="text-muted-foreground text-xs">Keine Linien gefunden</div>
            )}
        </div>
    );
}
