import { useCallback, useRef, useState } from "react";
import { ESPLoader, Transport } from "esptool-js";
import type { IEspLoaderTerminal } from "esptool-js";

export interface FlashFile {
    name: string;
    data: string; // binary string
    address: number;
}

export type ConnectionState = "disconnected" | "connecting" | "connected" | "flashing" | "erasing";

export interface FlashProgress {
    fileIndex: number;
    written: number;
    total: number;
    percentage: number;
}

export interface ChipInfo {
    chipName: string;
    features: string;
    mac: string;
    flashSize: number;
}

export interface UseEspFlasherReturn {
    state: ConnectionState;
    chipInfo: ChipInfo | null;
    logs: string[];
    flashProgress: FlashProgress | null;
    isWebSerialSupported: boolean;
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;
    flash: (files: FlashFile[], options?: { eraseAll?: boolean; compress?: boolean }) => Promise<void>;
    eraseFlash: () => Promise<void>;
    addLog: (message: string) => void;
    clearLogs: () => void;
}

function arrayBufferToBinaryString(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binaryString = "";
    for (let i = 0; i < bytes.length; i++) {
        binaryString += String.fromCharCode(bytes[i]);
    }
    return binaryString;
}

export function fileToBinaryString(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            if (reader.result instanceof ArrayBuffer) {
                resolve(arrayBufferToBinaryString(reader.result));
            } else {
                reject(new Error("Unexpected reader result type"));
            }
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
    });
}

export function useEspFlasher(): UseEspFlasherReturn {
    const [state, setState] = useState<ConnectionState>("disconnected");
    const [chipInfo, setChipInfo] = useState<ChipInfo | null>(null);
    const [logs, setLogs] = useState<string[]>([]);
    const [flashProgress, setFlashProgress] = useState<FlashProgress | null>(null);

    const transportRef = useRef<Transport | null>(null);
    const loaderRef = useRef<ESPLoader | null>(null);

    const isWebSerialSupported = "serial" in navigator;

    const addLog = useCallback((message: string) => {
        setLogs((prev) => [...prev, message]);
    }, []);

    const terminal: IEspLoaderTerminal = {
        clean: () => setLogs([]),
        writeLine: (data: string) => {
            const trimmed = data.trim();
            if (trimmed) {
                addLog(trimmed);
            }
        },
        write: (data: string) => {
            const trimmed = data.trim();
            if (trimmed) {
                addLog(trimmed);
            }
        },
    };

    const connect = useCallback(async () => {
        if (!isWebSerialSupported) {
            addLog("Web Serial API is not supported in this browser");
            return;
        }

        setState("connecting");
        addLog("Requesting serial port...");

        try {
            const port = await navigator.serial.requestPort();
            const transport = new Transport(port);
            transportRef.current = transport;

            const loader = new ESPLoader({
                transport,
                baudrate: 921600,
                romBaudrate: 115200,
                terminal,
            });
            loaderRef.current = loader;

            addLog("Connecting to device...");
            const chipType = await loader.main();
            addLog(`Connected: ${chipType}`);

            const flashSize = await loader.getFlashSize();

            setChipInfo({
                chipName: chipType,
                features: "",
                mac: "",
                flashSize,
            });

            setState("connected");
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            addLog(`Connection failed: ${message}`);
            setState("disconnected");
            transportRef.current = null;
            loaderRef.current = null;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isWebSerialSupported, addLog]);

    const disconnect = useCallback(async () => {
        try {
            if (transportRef.current) {
                await transportRef.current.disconnect();
                addLog("Disconnected");
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            addLog(`Disconnect error: ${message}`);
        } finally {
            transportRef.current = null;
            loaderRef.current = null;
            setChipInfo(null);
            setFlashProgress(null);
            setState("disconnected");
        }
    }, [addLog]);

    const flash = useCallback(
        async (files: FlashFile[], options?: { eraseAll?: boolean; compress?: boolean }) => {
            const loader = loaderRef.current;
            if (!loader) {
                addLog("Not connected to any device");
                return;
            }

            if (files.length === 0) {
                addLog("No files to flash");
                return;
            }

            setState("flashing");
            setFlashProgress(null);

            try {
                const fileArray = files.map((f) => ({
                    data: f.data,
                    address: f.address,
                }));

                addLog(`Flashing ${files.length} file(s)...`);
                for (const f of files) {
                    addLog(`  ${f.name} @ 0x${f.address.toString(16)} (${f.data.length} bytes)`);
                }

                await loader.writeFlash({
                    fileArray,
                    flashSize: "keep",
                    flashMode: "keep",
                    flashFreq: "keep",
                    eraseAll: options?.eraseAll ?? false,
                    compress: options?.compress ?? true,
                    reportProgress: (fileIndex, written, total) => {
                        setFlashProgress({
                            fileIndex,
                            written,
                            total,
                            percentage: Math.round((written / total) * 100),
                        });
                    },
                });

                addLog("Flash complete!");
                addLog("Resetting device...");
                await loader.after();
                setState("connected");
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                addLog(`Flash failed: ${message}`);
                setState("connected");
            } finally {
                setFlashProgress(null);
            }
        },
        [addLog]
    );

    const eraseFlash = useCallback(async () => {
        const loader = loaderRef.current;
        if (!loader) {
            addLog("Not connected to any device");
            return;
        }

        setState("erasing");
        addLog("Erasing entire flash... this may take a while");

        try {
            await loader.eraseFlash();
            addLog("Flash erased successfully");
            setState("connected");
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            addLog(`Erase failed: ${message}`);
            setState("connected");
        }
    }, [addLog]);

    const clearLogs = useCallback(() => {
        setLogs([]);
    }, []);

    return {
        state,
        chipInfo,
        logs,
        flashProgress,
        isWebSerialSupported,
        connect,
        disconnect,
        flash,
        eraseFlash,
        addLog,
        clearLogs,
    };
}
