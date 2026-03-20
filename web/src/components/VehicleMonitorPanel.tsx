import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Play, Square } from "lucide-react";
import { Button } from "./ui/button";
import type { Anomaly, AnomalyType } from "./vehicles/VehicleLifecycleMonitor";

interface MonitorGlobal {
    getStats: () => MonitorStats;
    getSpeedStats: () => SpeedStat[];
    getAnomalies: (limit?: number) => Anomaly[];
    getAnomaliesByType: (type: AnomalyType, limit?: number) => Anomaly[];
    getAll: () => Record<string, unknown>;
    clear: () => void;
    enable: () => void;
    disable: () => void;
    isEnabled: () => boolean;
}

interface MonitorStats {
    totalTracked: number;
    currentlyVisible: number;
    totalAnomalies: number;
    anomaliesByType: Record<string, number>;
    topFlickers: Array<{ tripId: string; count: number }>;
    topTeleporters: Array<{ tripId: string; count: number }>;
    frameCount: number;
}

interface SpeedStat {
    tripId: string;
    routeId: number;
    renderedSpeedMps: number;
    renderedSpeedKmh: number;
    scheduleSpeedMps: number;
    scheduleSpeedKmh: number;
    speedRatio: number;
    distToNextStop: number | undefined;
    msToNextStop: number | undefined;
    speedAnomalyCount: number;
}

interface SessionAnomaly extends Anomaly {
    sessionMs: number;
}

interface MonitorSession {
    startedAt: string;
    durationMs: number;
    stats: MonitorStats;
    speedSnapshots: SpeedStat[][];
    anomalies: SessionAnomaly[];
}

const ANOMALY_LABELS: Record<AnomalyType, string> = {
    flicker: "Flackern",
    teleport: "Teleport",
    ghost_removal: "Geist",
    stuck: "Blockiert",
    rapid_status_change: "Schneller Statuswechsel",
    speed_anomaly: "Geschwindigkeit",
};

const ANOMALY_COLORS: Record<AnomalyType, string> = {
    flicker: "text-yellow-500",
    teleport: "text-red-500",
    ghost_removal: "text-orange-500",
    stuck: "text-blue-500",
    rapid_status_change: "text-purple-500",
    speed_anomaly: "text-red-400",
};

function getMonitor(): MonitorGlobal | null {
    return (window as Record<string, unknown>).__vehicleMonitor as MonitorGlobal | null;
}

export function VehicleMonitorPanel() {
    const [isRecording, setIsRecording] = useState(false);
    const [stats, setStats] = useState<MonitorStats | null>(null);
    const [anomalies, setAnomalies] = useState<SessionAnomaly[]>([]);
    const [speedSnapshots, setSpeedSnapshots] = useState<SpeedStat[][]>([]);
    const sessionStartRef = useRef(0);
    const prevAnomalyCountRef = useRef(0);
    const intervalRef = useRef<number | null>(null);

    const pollMonitor = useCallback(() => {
        const monitor = getMonitor();
        if (!monitor) return;

        const currentStats = monitor.getStats();
        setStats(currentStats);

        // Capture speed snapshot
        const speeds = monitor.getSpeedStats();
        if (speeds.length > 0) {
            setSpeedSnapshots(prev => [...prev, speeds]);
        }

        // Check for new anomalies since last poll
        const allAnomalies = monitor.getAnomalies(500);
        if (allAnomalies.length > prevAnomalyCountRef.current) {
            const newOnes = allAnomalies.slice(prevAnomalyCountRef.current);
            const sessionMs = performance.now() - sessionStartRef.current;
            const tagged: SessionAnomaly[] = newOnes.map(a => ({
                ...a,
                sessionMs: sessionMs + (a.timestamp - performance.now()),
            }));
            for (const a of tagged) {
                console.warn(
                    `[VehicleMonitor] ${a.type}: ${a.details} (trip=${a.tripId})`,
                );
            }
            setAnomalies(prev => [...prev, ...tagged]);
            prevAnomalyCountRef.current = allAnomalies.length;
        }
    }, []);

    const startRecording = useCallback(() => {
        const monitor = getMonitor();
        if (!monitor) {
            console.error("[VehicleMonitor] Not available — ensure vehicles are visible");
            return;
        }
        monitor.clear();
        monitor.enable();
        setAnomalies([]);
        setSpeedSnapshots([]);
        prevAnomalyCountRef.current = 0;
        sessionStartRef.current = performance.now();
        setIsRecording(true);

        console.log("[VehicleMonitor] Recording started");
        intervalRef.current = window.setInterval(pollMonitor, 2000);
        pollMonitor();
    }, [pollMonitor]);

    const stopRecording = useCallback(() => {
        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }
        // Final poll
        pollMonitor();
        setIsRecording(false);
        const monitor = getMonitor();
        monitor?.disable();
        console.log("[VehicleMonitor] Recording stopped");
    }, [pollMonitor]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (intervalRef.current) clearInterval(intervalRef.current);
            getMonitor()?.disable();
        };
    }, []);

    const downloadReport = useCallback(() => {
        const monitor = getMonitor();
        const session: MonitorSession = {
            startedAt: new Date(Date.now() - (performance.now() - sessionStartRef.current)).toISOString(),
            durationMs: performance.now() - sessionStartRef.current,
            stats: stats ?? {
                totalTracked: 0,
                currentlyVisible: 0,
                totalAnomalies: 0,
                anomaliesByType: {},
                topFlickers: [],
                topTeleporters: [],
                frameCount: 0,
            },
            speedSnapshots,
            anomalies,
        };

        if (monitor) {
            // Include current vehicle states
            (session as Record<string, unknown>).vehicleStates = monitor.getAll();
        }

        const blob = new Blob([JSON.stringify(session, null, 2)], {
            type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `vehicle-monitor-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }, [stats, speedSnapshots, anomalies]);

    const hasMonitor = getMonitor() !== null;

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Fahrzeugmonitor</h3>
                <div className="flex gap-1">
                    {!isRecording ? (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={startRecording}
                            disabled={!hasMonitor}
                            title={hasMonitor ? "Überwachung starten" : "Fahrzeuge zuerst aktivieren"}
                        >
                            <Play className="h-3.5 w-3.5 mr-1" />
                            Aufnahme
                        </Button>
                    ) : (
                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={stopRecording}
                        >
                            <Square className="h-3.5 w-3.5 mr-1" />
                            Stopp
                        </Button>
                    )}
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={downloadReport}
                        disabled={anomalies.length === 0 && !stats}
                        title="Bericht als JSON herunterladen"
                    >
                        <Download className="h-3.5 w-3.5" />
                    </Button>
                </div>
            </div>

            {!hasMonitor && (
                <p className="text-xs text-muted-foreground">
                    Fahrzeuganzeige aktivieren, um den Monitor zu starten.
                </p>
            )}

            {stats && (
                <div className="text-xs space-y-2">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                        <span className="text-muted-foreground">Fahrzeuge erfasst</span>
                        <span className="tabular-nums">{stats.totalTracked}</span>
                        <span className="text-muted-foreground">Aktuell sichtbar</span>
                        <span className="tabular-nums">{stats.currentlyVisible}</span>
                        <span className="text-muted-foreground">Frames verarbeitet</span>
                        <span className="tabular-nums">{stats.frameCount.toLocaleString()}</span>
                        <span className="text-muted-foreground">Anomalien gesamt</span>
                        <span className="tabular-nums font-medium">
                            {stats.totalAnomalies}
                        </span>
                    </div>

                    {Object.keys(stats.anomaliesByType).length > 0 && (
                        <div className="border-t pt-2">
                            <span className="text-muted-foreground block mb-1">Nach Typ</span>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                                {Object.entries(stats.anomaliesByType).map(([type, count]) => (
                                    <div key={type} className="contents">
                                        <span className={ANOMALY_COLORS[type as AnomalyType] ?? "text-muted-foreground"}>
                                            {ANOMALY_LABELS[type as AnomalyType] ?? type}
                                        </span>
                                        <span className="tabular-nums">{count}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {anomalies.length > 0 && (
                <div className="border-t pt-2">
                    <span className="text-xs text-muted-foreground block mb-1">
                        Letzte Anomalien ({anomalies.length})
                    </span>
                    <div className="max-h-48 overflow-y-auto space-y-1">
                        {anomalies.slice(-20).reverse().map((a, i) => (
                            <div key={`${a.timestamp}-${i}`} className="text-xs leading-tight">
                                <span className={`font-medium ${ANOMALY_COLORS[a.type]}`}>
                                    {ANOMALY_LABELS[a.type]}
                                </span>
                                {" "}
                                <span className="text-muted-foreground font-mono">
                                    {a.tripId.slice(0, 12)}
                                </span>
                                <p className="text-muted-foreground truncate">{a.details}</p>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
