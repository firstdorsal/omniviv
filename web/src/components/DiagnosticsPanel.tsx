import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertCircle, CheckCircle2, History, Loader2, MapPin, MapPinOff } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";
import { getApiClient } from "../apiClient";
import type { TilegenHistoryEntry, TilegenLayerStatus } from "../api";

const POLL_INTERVAL_MS = 2000;
const HISTORY_LIMIT = 10;

interface DiagnosticsPanelProps {
    /** Called when the user selects/deselects a layer card. The features
     * passed are GeoJSON Polygons for the area, ready to render on the map. */
    onSelectionChange: (features: GeoJSON.Feature[]) => void;
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(ms: number): string {
    if (ms === 0) return "—";
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remSeconds = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remSeconds}s`;
    const hours = Math.floor(minutes / 60);
    const remMinutes = minutes % 60;
    return `${hours}h ${remMinutes}m`;
}

function formatRelativeTime(timestamp: string | null | undefined): string {
    if (!timestamp) return "noch nie";
    const ts = new Date(timestamp).getTime();
    const now = Date.now();
    const diffMs = now - ts;
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return `vor ${diffSec}s`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `vor ${diffMin}m`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `vor ${diffHour}h`;
    const diffDay = Math.floor(diffHour / 24);
    return `vor ${diffDay}d`;
}

function PhaseBadge({ phase, status }: { phase: string; status: string }) {
    // All colored variants explicitly set text-white because the default
    // text-primary-foreground may not have enough contrast against bg-amber-600
    // and bg-emerald-600 in some themes.
    if (phase === "running") {
        return (
            <Badge variant="default" className="gap-1 bg-blue-600 text-white hover:bg-blue-600">
                <Loader2 className="h-3 w-3 animate-spin" />
                Generiere
            </Badge>
        );
    }
    if (phase === "committing") {
        return (
            <Badge variant="default" className="gap-1 bg-amber-600 text-white hover:bg-amber-600">
                <Loader2 className="h-3 w-3 animate-spin" />
                Übernehme
            </Badge>
        );
    }
    if (phase === "completed" || status === "ok") {
        return (
            <Badge variant="default" className="gap-1 bg-emerald-600 text-white hover:bg-emerald-600">
                <CheckCircle2 className="h-3 w-3" />
                Bereit
            </Badge>
        );
    }
    if (phase === "failed" || status === "failed") {
        return (
            <Badge variant="destructive" className="gap-1 text-white">
                <AlertCircle className="h-3 w-3" />
                Fehler
            </Badge>
        );
    }
    return <Badge variant="secondary">{phase || status}</Badge>;
}

function HistoryRow({ entry }: { entry: TilegenHistoryEntry }) {
    const dot =
        entry.status === "ok" ? "bg-emerald-600" :
        entry.status === "failed" ? "bg-destructive" :
        "bg-muted-foreground";
    return (
        <div className="flex items-center gap-2 text-[10px]">
            <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${dot}`} />
            <span className="text-muted-foreground flex-1 truncate">
                {formatRelativeTime(entry.completed_at)}
            </span>
            <span className="font-mono tabular-nums">{formatDuration(entry.duration_ms)}</span>
            <span className="text-muted-foreground tabular-nums">
                {formatBytes(entry.file_size_bytes)}
            </span>
        </div>
    );
}

function LayerCard({
    layer,
    history,
    selected,
    onToggleSelect,
}: {
    layer: TilegenLayerStatus;
    history: TilegenHistoryEntry[];
    selected: boolean;
    onToggleSelect: () => void;
}) {
    const tilesTotal = Math.max(layer.tiles_total, 1);
    const tilesPct = Math.min(100, (layer.tiles_done / tilesTotal) * 100);
    const isRunning = layer.phase === "running" || layer.phase === "committing";
    const lastDuration = layer.generation_duration_ms;
    const hasArea = layer.bbox != null || layer.area_label != null;

    let elapsedMs = 0;
    if (isRunning && layer.started_at) {
        elapsedMs = Date.now() - new Date(layer.started_at).getTime();
    }

    return (
        <div
            className={`border-border w-full space-y-3 rounded-md border p-3 transition-colors ${
                selected ? "border-blue-500 bg-blue-500/5" : ""
            }`}
        >
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                    <div className="font-mono text-sm font-semibold">{layer.layer_name}</div>
                    {layer.area_label && (
                        <div className="text-muted-foreground mt-0.5 text-xs">
                            {layer.area_label}
                            {layer.min_zoom != null && layer.max_zoom != null
                                ? ` · z${layer.min_zoom}-${layer.max_zoom}`
                                : ""}
                        </div>
                    )}
                </div>
                <PhaseBadge phase={layer.phase} status={layer.status} />
            </div>

            {isRunning && (
                <>
                    <Progress value={tilesPct} className="h-2" />
                    <div className="text-muted-foreground flex items-center justify-between text-xs">
                        <span>
                            {layer.tiles_done.toLocaleString("de-DE")} /{" "}
                            {layer.tiles_total.toLocaleString("de-DE")} Kacheln
                            {layer.current_zoom != null ? ` · aktuell z${layer.current_zoom}` : ""}
                        </span>
                        <span className="font-mono">{tilesPct.toFixed(1)}%</span>
                    </div>
                    <div className="text-muted-foreground text-xs">
                        läuft seit {formatDuration(elapsedMs)}
                    </div>
                </>
            )}

            {!isRunning && (
                <div className="text-muted-foreground space-y-1 text-xs">
                    <div className="flex justify-between">
                        <span>Letzte Generierung:</span>
                        <span>{formatRelativeTime(layer.last_generated_at)}</span>
                    </div>
                    <div className="flex justify-between">
                        <span>Dauer:</span>
                        <span>{formatDuration(lastDuration)}</span>
                    </div>
                    <div className="flex justify-between">
                        <span>Dateigröße:</span>
                        <span>{formatBytes(layer.file_size_bytes)}</span>
                    </div>
                    {layer.bbox && (
                        <div className="flex justify-between">
                            <span>BBox:</span>
                            <span className="font-mono text-[10px]">
                                {layer.bbox.map((v) => v.toFixed(2)).join(", ")}
                            </span>
                        </div>
                    )}
                </div>
            )}

            {layer.error_message && (
                <div className="text-destructive bg-destructive/10 rounded p-2 text-xs">
                    {layer.error_message}
                </div>
            )}

            {history.length > 0 && (
                <div className="border-border/50 border-t pt-2">
                    <div className="text-muted-foreground mb-1 flex items-center gap-1 text-[10px] uppercase">
                        <History className="h-3 w-3" />
                        Verlauf ({history.length})
                    </div>
                    <div className="space-y-0.5">
                        {history.slice(0, 5).map((entry) => (
                            <HistoryRow key={entry.id} entry={entry} />
                        ))}
                    </div>
                </div>
            )}

            {hasArea && (
                <Button
                    type="button"
                    variant={selected ? "default" : "outline"}
                    size="sm"
                    onClick={onToggleSelect}
                    className="h-7 w-full gap-1.5 text-xs"
                    aria-pressed={selected}
                >
                    {selected ? (
                        <>
                            <MapPinOff className="h-3.5 w-3.5" />
                            Bereich ausblenden
                        </>
                    ) : (
                        <>
                            <MapPin className="h-3.5 w-3.5" />
                            Bereich auf Karte anzeigen
                        </>
                    )}
                </Button>
            )}
        </div>
    );
}

export function DiagnosticsPanel({ onSelectionChange }: DiagnosticsPanelProps) {
    const [layers, setLayers] = useState<TilegenLayerStatus[]>([]);
    const [history, setHistory] = useState<TilegenHistoryEntry[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [, setTick] = useState(0);
    const [selectedLayerName, setSelectedLayerName] = useState<string | null>(null);
    /** Cache: area_label → GeoJSON Feature, so toggling cards doesn't refetch. */
    const [polygonCache, setPolygonCache] = useState<Map<string, GeoJSON.Feature>>(new Map());

    const historyByLayer = useMemo(() => {
        const map = new Map<string, TilegenHistoryEntry[]>();
        for (const entry of history) {
            const list = map.get(entry.layer_name) ?? [];
            list.push(entry);
            map.set(entry.layer_name, list);
        }
        return map;
    }, [history]);

    useEffect(() => {
        let cancelled = false;
        const poll = async () => {
            try {
                const [statusRes, historyRes] = await Promise.all([
                    getApiClient().api.getStatus(),
                    getApiClient().api.getHistory({ limit: HISTORY_LIMIT * 2 }),
                ]);
                if (cancelled) return;
                setLayers(statusRes.data.layers);
                setHistory(historyRes.data.entries);
                setError(null);
            } catch (err) {
                if (cancelled) return;
                console.warn("Failed to fetch tilegen status", err);
                setError("Status nicht erreichbar");
            }
        };
        poll();
        const interval = setInterval(poll, POLL_INTERVAL_MS);
        const tickInterval = setInterval(() => setTick((t) => t + 1), 1000);
        return () => {
            cancelled = true;
            clearInterval(interval);
            clearInterval(tickInterval);
        };
    }, []);

    /** Build a GeoJSON polygon from a bbox (fallback when no admin polygon exists). */
    const bboxFeature = useCallback((layer: TilegenLayerStatus): GeoJSON.Feature | null => {
        if (!layer.bbox) return null;
        const [w, s, e, n] = layer.bbox;
        return {
            type: "Feature",
            properties: { name: layer.area_label ?? layer.layer_name },
            geometry: {
                type: "Polygon",
                coordinates: [[
                    [w, s], [e, s], [e, n], [w, n], [w, s],
                ]],
            },
        };
    }, []);

    const handleSelectLayer = useCallback(
        async (layer: TilegenLayerStatus) => {
            // Toggle: clicking the selected card again clears the selection
            if (selectedLayerName === layer.layer_name) {
                setSelectedLayerName(null);
                onSelectionChange([]);
                return;
            }
            setSelectedLayerName(layer.layer_name);

            // Try to fetch the actual admin polygon for the area name.
            // Falls back to the bbox rectangle if the API has no polygon
            // for this name (e.g. cities like "augsburg").
            const areaName = layer.area_label;
            if (areaName && polygonCache.has(areaName)) {
                onSelectionChange([polygonCache.get(areaName)!]);
                return;
            }
            if (areaName) {
                try {
                    const res = await getApiClient().api.getAreaPolygon({ name: areaName });
                    const feature = res.data.feature as GeoJSON.Feature | null;
                    if (feature) {
                        setPolygonCache((prev) => {
                            const next = new Map(prev);
                            next.set(areaName, feature);
                            return next;
                        });
                        onSelectionChange([feature]);
                        return;
                    }
                } catch (err) {
                    console.warn("Failed to fetch area polygon", err);
                }
            }
            // Fallback: bbox rectangle
            const fallback = bboxFeature(layer);
            onSelectionChange(fallback ? [fallback] : []);
        },
        [selectedLayerName, polygonCache, bboxFeature, onSelectionChange],
    );

    // Clear the map overlay when this panel unmounts (user switches panels)
    useEffect(() => {
        return () => onSelectionChange([]);
    }, [onSelectionChange]);

    return (
        <div className="p-4">
            <div className="mb-4 flex items-center gap-2">
                <Activity className="h-5 w-5" />
                <h2 className="font-semibold">Diagnose</h2>
            </div>

            <div className="text-muted-foreground mb-3 text-xs">
                Live-Status der Tile-Generierung. Aktualisiert alle {POLL_INTERVAL_MS / 1000}s.
            </div>

            {error && (
                <div className="text-destructive bg-destructive/10 mb-3 rounded p-2 text-xs">
                    {error}
                </div>
            )}

            <div className="space-y-3">
                <div className="text-muted-foreground text-xs font-medium uppercase">
                    Tile-Generierung
                </div>
                {layers.length === 0 && !error && (
                    <div className="text-muted-foreground text-xs">
                        Keine Tile-Layer gefunden
                    </div>
                )}
                {layers.map((layer) => (
                    <LayerCard
                        key={layer.layer_name}
                        layer={layer}
                        history={historyByLayer.get(layer.layer_name) ?? []}
                        selected={selectedLayerName === layer.layer_name}
                        onToggleSelect={() => handleSelectLayer(layer)}
                    />
                ))}
            </div>
        </div>
    );
}
