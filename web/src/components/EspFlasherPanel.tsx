import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Cpu, Download, Eye, EyeOff, Plug, PlugZap, Search, Trash2, Upload, Zap } from "lucide-react";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Progress } from "./ui/progress";
import { ScrollArea } from "./ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { type FlashFile, fileToBinaryString, useEspFlasher } from "../hooks/useEspFlasher";

// --- Custom firmware tab types ---

interface FileEntry {
    file: File;
    address: number;
    addressInput: string;
}

const DEFAULT_OFFSETS: Record<string, number> = {
    "bootloader.bin": 0x0,
    "partition-table.bin": 0x8000,
    "partitions.bin": 0x8000,
    "ota_data_initial.bin": 0xd000,
    "firmware.bin": 0x10000,
    "app.bin": 0x10000,
};

function guessAddress(filename: string): number {
    const lower = filename.toLowerCase();
    for (const [pattern, address] of Object.entries(DEFAULT_OFFSETS)) {
        if (lower.includes(pattern)) {
            return address;
        }
    }
    if (lower.endsWith(".bin")) {
        return 0x10000;
    }
    return 0x0;
}

function parseAddress(input: string): number | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
    const num = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? parseInt(trimmed, 16) : parseInt(trimmed, 10);
    return isNaN(num) || num < 0 ? null : num;
}

// --- Departure Board config binary builder ---

interface DepartureBoardConfig {
    wifi_ssid: string;
    wifi_password: string;
    api_url: string;
    stop_ifopt: string;
}

function buildConfigBin(config: DepartureBoardConfig): string {
    const json = JSON.stringify(config);
    const encoder = new TextEncoder();
    const jsonBytes = encoder.encode(json);

    // 4 bytes magic "OMNI" + 4 bytes length + JSON + padding to 4096
    const totalSize = 4096;
    const buffer = new Uint8Array(totalSize);
    buffer.fill(0xff);

    // Magic: "OMNI" as little-endian uint32 = 0x494E4D4F
    buffer[0] = 0x4f; // 'O'
    buffer[1] = 0x4d; // 'M'
    buffer[2] = 0x4e; // 'N'
    buffer[3] = 0x49; // 'I'

    // JSON length as little-endian uint32
    buffer[4] = jsonBytes.length & 0xff;
    buffer[5] = (jsonBytes.length >> 8) & 0xff;
    buffer[6] = (jsonBytes.length >> 16) & 0xff;
    buffer[7] = (jsonBytes.length >> 24) & 0xff;

    // JSON payload
    buffer.set(jsonBytes, 8);

    // Convert to binary string
    let binaryString = "";
    for (let i = 0; i < buffer.length; i++) {
        binaryString += String.fromCharCode(buffer[i]);
    }
    return binaryString;
}

// --- Firmware manifest types ---

interface FirmwareManifestFile {
    name: string;
    offset: number;
}

interface FirmwareManifest {
    version: string;
    board: string;
    description: string;
    configOffset: number;
    files: FirmwareManifestFile[];
}

// --- Stop search result type ---

interface StopResult {
    stop_id: string;
    stop_name: string | null;
}

// --- Departure Board Tab ---

function DepartureBoardTab({
    isConnected,
    isBusy,
    flash,
    addLog,
}: {
    isConnected: boolean;
    isBusy: boolean;
    flash: (files: FlashFile[], options?: { eraseAll?: boolean; compress?: boolean }) => Promise<void>;
    addLog: (message: string) => void;
}) {
    const [wifiSsid, setWifiSsid] = useState("");
    const [wifiPassword, setWifiPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [apiUrl, setApiUrl] = useState("");
    const [stopIfopt, setStopIfopt] = useState("");
    const [stopSearch, setStopSearch] = useState("");
    const [stopResults, setStopResults] = useState<StopResult[]>([]);
    const [showStopResults, setShowStopResults] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState("");
    const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const stopResultsRef = useRef<HTMLDivElement>(null);

    // Pre-fill API URL from app config
    useEffect(() => {
        fetch("/config.json")
            .then((r) => r.json())
            .then((cfg: { apiUrl?: string }) => {
                if (cfg.apiUrl) {
                    setApiUrl(cfg.apiUrl);
                }
            })
            .catch(() => {});
    }, []);

    // Close stop results dropdown when clicking outside
    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (stopResultsRef.current && !stopResultsRef.current.contains(e.target as Node)) {
                setShowStopResults(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    // Search stops as user types (uses direct fetch with server-side search param)
    const searchStops = useCallback(
        (query: string) => {
            if (searchTimeoutRef.current) {
                clearTimeout(searchTimeoutRef.current);
            }

            if (query.length < 2) {
                setStopResults([]);
                setShowStopResults(false);
                return;
            }

            searchTimeoutRef.current = setTimeout(async () => {
                try {
                    const params = new URLSearchParams({
                        search: query,
                        limit: "20",
                        leaf_only: "true",
                    });
                    const baseUrl = apiUrl || "";
                    const res = await fetch(`${baseUrl}/api/gtfs-stops?${params}`);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const data: { stops: Array<{ stop_id: string; stop_name: string | null }> } = await res.json();
                    setStopResults(data.stops.slice(0, 10).map((s) => ({ stop_id: s.stop_id, stop_name: s.stop_name })));
                    setShowStopResults(data.stops.length > 0);
                } catch {
                    setStopResults([]);
                    setShowStopResults(false);
                }
            }, 300);
        },
        [apiUrl]
    );

    const handleStopSearchChange = useCallback(
        (value: string) => {
            setStopSearch(value);
            searchStops(value);
        },
        [searchStops]
    );

    const selectStop = useCallback((stopId: string, stopName: string | null) => {
        setStopIfopt(stopId);
        setStopSearch(stopName ?? stopId);
        setShowStopResults(false);
    }, []);

    const canFlash = isConnected && !isBusy && !downloading && wifiSsid.trim() !== "" && wifiPassword.trim() !== "" && apiUrl.trim() !== "" && stopIfopt.trim() !== "";

    const handleFlashDepartureBoard = useCallback(async () => {
        if (!canFlash) return;

        setDownloading(true);
        addLog("Downloading firmware...");

        try {
            // Fetch manifest
            setDownloadProgress("Fetching manifest...");
            const manifestResponse = await fetch("/firmware/manifest.json");
            if (!manifestResponse.ok) {
                throw new Error(`Failed to fetch manifest: ${manifestResponse.status}`);
            }
            const manifest: FirmwareManifest = await manifestResponse.json();
            addLog(`Firmware v${manifest.version} for ${manifest.board}`);

            // Fetch firmware binaries
            const flashFiles: FlashFile[] = [];
            for (const file of manifest.files) {
                setDownloadProgress(`Downloading ${file.name}...`);
                addLog(`Downloading ${file.name}...`);
                const binResponse = await fetch(`/firmware/${file.name}`);
                if (!binResponse.ok) {
                    throw new Error(`Failed to fetch ${file.name}: ${binResponse.status}`);
                }
                const arrayBuffer = await binResponse.arrayBuffer();
                const bytes = new Uint8Array(arrayBuffer);
                let data = "";
                for (let i = 0; i < bytes.length; i++) {
                    data += String.fromCharCode(bytes[i]);
                }
                flashFiles.push({ name: file.name, data, address: file.offset });
            }

            // Build config binary
            setDownloadProgress("Building config...");
            addLog("Building config partition...");
            const configData = buildConfigBin({
                wifi_ssid: wifiSsid,
                wifi_password: wifiPassword,
                api_url: apiUrl,
                stop_ifopt: stopIfopt,
            });
            flashFiles.push({
                name: "config.bin",
                data: configData,
                address: manifest.configOffset,
            });

            setDownloading(false);
            setDownloadProgress("");

            // Flash all files
            addLog(`Flashing ${flashFiles.length} files...`);
            await flash(flashFiles, { eraseAll: false, compress: true });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            addLog(`Error: ${message}`);
            setDownloading(false);
            setDownloadProgress("");
        }
    }, [canFlash, wifiSsid, wifiPassword, apiUrl, stopIfopt, flash, addLog]);

    return (
        <div className="space-y-4">
            {/* WiFi credentials */}
            <div className="space-y-2">
                <h3 className="text-sm font-medium text-muted-foreground">WiFi</h3>
                <div className="space-y-2">
                    <div>
                        <Label htmlFor="wifi-ssid" className="text-xs">
                            SSID
                        </Label>
                        <Input id="wifi-ssid" placeholder="Network name" value={wifiSsid} onChange={(e) => setWifiSsid(e.target.value)} disabled={isBusy || downloading} />
                    </div>
                    <div>
                        <Label htmlFor="wifi-password" className="text-xs">
                            Password
                        </Label>
                        <div className="relative">
                            <Input id="wifi-password" type={showPassword ? "text" : "password"} placeholder="Network password" value={wifiPassword} onChange={(e) => setWifiPassword(e.target.value)} disabled={isBusy || downloading} className="pr-9" />
                            <Button type="button" variant="ghost" size="icon" className="absolute right-0 top-0 h-9 w-9" onClick={() => setShowPassword((v) => !v)} tabIndex={-1}>
                                {showPassword ? <EyeOff className="h-4 w-4 text-muted-foreground" /> : <Eye className="h-4 w-4 text-muted-foreground" />}
                            </Button>
                        </div>
                    </div>
                </div>
            </div>

            {/* API URL */}
            <div className="space-y-2">
                <h3 className="text-sm font-medium text-muted-foreground">API</h3>
                <div>
                    <Label htmlFor="api-url" className="text-xs">
                        URL
                    </Label>
                    <Input id="api-url" placeholder="https://api.example.com" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} disabled={isBusy || downloading} />
                </div>
            </div>

            {/* Stop */}
            <div className="space-y-2">
                <h3 className="text-sm font-medium text-muted-foreground">Stop</h3>
                <div className="relative" ref={stopResultsRef}>
                    <div className="relative">
                        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                        <Input
                            placeholder="Stop ID or search..."
                            value={stopSearch}
                            onChange={(e) => {
                                handleStopSearchChange(e.target.value);
                                setStopIfopt(e.target.value);
                            }}
                            disabled={isBusy || downloading}
                            className="pl-8"
                        />
                    </div>
                    {showStopResults && stopResults.length > 0 && (
                        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
                            <div className="max-h-48 overflow-y-auto p-1">
                                {stopResults.map((stop) => (
                                    <button
                                        key={stop.stop_id}
                                        type="button"
                                        onClick={() => selectStop(stop.stop_id, stop.stop_name)}
                                        className="flex w-full flex-col rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                                    >
                                        <span className="font-medium">{stop.stop_name ?? stop.stop_id}</span>
                                        <span className="text-xs text-muted-foreground">{stop.stop_id}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Download progress */}
            {downloading && downloadProgress && (
                <div className="flex items-center gap-2 rounded-md border p-2">
                    <Download className="h-4 w-4 animate-pulse text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">{downloadProgress}</span>
                </div>
            )}

            {/* Flash button */}
            <Button onClick={handleFlashDepartureBoard} disabled={!canFlash} className="w-full gap-2">
                <Zap className="h-4 w-4" />
                Flash Departure Board
            </Button>
        </div>
    );
}

// --- Custom Firmware Tab ---

function CustomFirmwareTab({
    isConnected,
    isBusy,
    flash,
    flashProgress,
}: {
    isConnected: boolean;
    isBusy: boolean;
    flash: (files: FlashFile[], options?: { eraseAll?: boolean; compress?: boolean }) => Promise<void>;
    flashProgress: { fileIndex: number; percentage: number } | null;
}) {
    const [files, setFiles] = useState<FileEntry[]>([]);
    const [eraseAll, setEraseAll] = useState(false);
    const [compress, setCompress] = useState(true);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFiles = e.target.files;
        if (!selectedFiles) return;

        const newEntries: FileEntry[] = Array.from(selectedFiles).map((file) => {
            const address = guessAddress(file.name);
            return {
                file,
                address,
                addressInput: `0x${address.toString(16)}`,
            };
        });

        setFiles((prev) => [...prev, ...newEntries]);

        if (fileInputRef.current) {
            fileInputRef.current.value = "";
        }
    }, []);

    const removeFile = useCallback((index: number) => {
        setFiles((prev) => prev.filter((_, i) => i !== index));
    }, []);

    const updateAddress = useCallback((index: number, input: string) => {
        setFiles((prev) =>
            prev.map((entry, i) => {
                if (i !== index) return entry;
                const parsed = parseAddress(input);
                return {
                    ...entry,
                    addressInput: input,
                    address: parsed ?? entry.address,
                };
            })
        );
    }, []);

    const handleFlash = useCallback(async () => {
        if (files.length === 0) return;

        const flashFiles: FlashFile[] = [];
        for (const entry of files) {
            const data = await fileToBinaryString(entry.file);
            flashFiles.push({
                name: entry.file.name,
                data,
                address: entry.address,
            });
        }

        await flash(flashFiles, { eraseAll, compress });
    }, [files, flash, eraseAll, compress]);

    return (
        <div className="space-y-4">
            {/* Files */}
            <div className="space-y-2">
                <h3 className="text-sm font-medium text-muted-foreground">Firmware Files</h3>

                {files.length > 0 && (
                    <div className="space-y-2">
                        {files.map((entry, i) => (
                            <div key={`${entry.file.name}-${i}`} className="flex items-center gap-2 rounded-md border p-2">
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-xs font-medium">{entry.file.name}</p>
                                    <p className="text-xs text-muted-foreground">{(entry.file.size / 1024).toFixed(1)} KB</p>
                                </div>
                                <div className="flex items-center gap-1">
                                    <span className="text-xs text-muted-foreground">@</span>
                                    <input
                                        type="text"
                                        value={entry.addressInput}
                                        onChange={(e) => updateAddress(i, e.target.value)}
                                        className="h-7 w-20 rounded border bg-background px-1.5 font-mono text-xs"
                                        disabled={isBusy}
                                    />
                                </div>
                                <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => removeFile(i)} disabled={isBusy}>
                                    <Trash2 className="h-3 w-3" />
                                </Button>
                            </div>
                        ))}
                    </div>
                )}

                <input ref={fileInputRef} type="file" accept=".bin,.img,.elf" multiple onChange={handleFileSelect} className="hidden" />
                <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={isBusy} className="w-full gap-2">
                    <Upload className="h-4 w-4" />
                    Add Files
                </Button>
            </div>

            {/* Flash Options */}
            <div className="space-y-2">
                <h3 className="text-sm font-medium text-muted-foreground">Options</h3>
                <label className="flex cursor-pointer items-center gap-3">
                    <Checkbox checked={compress} onCheckedChange={(checked) => setCompress(checked === true)} disabled={isBusy} />
                    <Label className="cursor-pointer text-sm">Compress data</Label>
                </label>
                <label className="flex cursor-pointer items-center gap-3">
                    <Checkbox checked={eraseAll} onCheckedChange={(checked) => setEraseAll(checked === true)} disabled={isBusy} />
                    <Label className="cursor-pointer text-sm">Erase all before flash</Label>
                </label>
            </div>

            {/* Flash Progress */}
            {flashProgress && (
                <div className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                        <span>
                            File {flashProgress.fileIndex + 1}/{files.length}
                        </span>
                        <span>{flashProgress.percentage}%</span>
                    </div>
                    <Progress value={flashProgress.percentage} />
                </div>
            )}

            {/* Actions */}
            <Button onClick={handleFlash} disabled={!isConnected || files.length === 0 || isBusy} className="w-full gap-2">
                <Zap className="h-4 w-4" />
                Flash
            </Button>
        </div>
    );
}

// --- Main Panel ---

export function EspFlasherPanel() {
    const { state, chipInfo, logs, flashProgress, isWebSerialSupported, connect, disconnect, flash, eraseFlash, addLog, clearLogs } = useEspFlasher();

    const isConnected = state === "connected";
    const isBusy = state === "flashing" || state === "erasing" || state === "connecting";

    return (
        <div className="space-y-4 p-4">
            {!isWebSerialSupported && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    <p className="text-sm text-destructive">Web Serial API is not supported. Use Chrome or Edge.</p>
                </div>
            )}

            {/* Connection */}
            <div className="space-y-2">
                <h3 className="text-sm font-medium text-muted-foreground">Connection</h3>
                {state === "disconnected" ? (
                    <Button onClick={connect} disabled={!isWebSerialSupported} className="w-full gap-2">
                        <Plug className="h-4 w-4" />
                        Connect
                    </Button>
                ) : (
                    <Button onClick={disconnect} variant="outline" disabled={isBusy} className="w-full gap-2">
                        <PlugZap className="h-4 w-4" />
                        {state === "connecting" ? "Connecting..." : "Disconnect"}
                    </Button>
                )}
            </div>

            {/* Chip Info */}
            {chipInfo && (
                <div className="rounded-md border p-3">
                    <div className="flex items-center gap-2">
                        <Cpu className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm font-medium">{chipInfo.chipName}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">Flash: {chipInfo.flashSize >= 1024 * 1024 ? `${chipInfo.flashSize / (1024 * 1024)}MB` : `${chipInfo.flashSize / 1024}KB`}</p>
                </div>
            )}

            {/* Tabbed firmware interface */}
            <Tabs defaultValue="departure-board">
                <TabsList className="w-full">
                    <TabsTrigger value="departure-board" className="flex-1">
                        Departure Board
                    </TabsTrigger>
                    <TabsTrigger value="custom" className="flex-1">
                        Custom Firmware
                    </TabsTrigger>
                </TabsList>
                <TabsContent value="departure-board">
                    <DepartureBoardTab isConnected={isConnected} isBusy={isBusy} flash={flash} addLog={addLog} />
                </TabsContent>
                <TabsContent value="custom">
                    <CustomFirmwareTab isConnected={isConnected} isBusy={isBusy} flash={flash} flashProgress={flashProgress} />
                </TabsContent>
            </Tabs>

            {/* Erase */}
            <Button variant="destructive" onClick={eraseFlash} disabled={!isConnected || isBusy} className="w-full gap-2">
                <Trash2 className="h-4 w-4" />
                Erase Flash
            </Button>

            {/* Flash Progress */}
            {flashProgress && (
                <div className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                        <span>Flashing...</span>
                        <span>{flashProgress.percentage}%</span>
                    </div>
                    <Progress value={flashProgress.percentage} />
                </div>
            )}

            {/* Log */}
            <div>
                <div className="mb-1 flex items-center justify-between">
                    <h3 className="text-sm font-medium text-muted-foreground">Log</h3>
                    <Button variant="ghost" size="sm" onClick={clearLogs} className="h-6 px-2 text-xs">
                        Clear
                    </Button>
                </div>
                <ScrollArea className="h-48 rounded-md border bg-muted/30">
                    <div className="p-2 font-mono text-xs">
                        {logs.length === 0 ? (
                            <p className="text-muted-foreground">No log output yet</p>
                        ) : (
                            logs.map((line, i) => (
                                <div key={i} className="whitespace-pre-wrap break-all leading-relaxed">
                                    {line}
                                </div>
                            ))
                        )}
                    </div>
                </ScrollArea>
            </div>
        </div>
    );
}
