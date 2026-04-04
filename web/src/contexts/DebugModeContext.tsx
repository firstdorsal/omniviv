import { createContext, useContext, useMemo, type ReactNode } from "react";

interface DebugModeContextValue {
    enabled: boolean;
    debugLog: (label: string, data: unknown) => void;
}

const LABEL_STYLE = "background: #6366f1; color: white; padding: 2px 6px; border-radius: 4px; font-weight: bold;";

/** Log a labelled data object to the browser console with styled grouping. */
export function debugLog(label: string, data: unknown): void {
    console.groupCollapsed(`%c${label}`, LABEL_STYLE);
    try {
        // Deep-clone to expand full object (avoid lazy evaluation of live refs)
        console.log(JSON.parse(JSON.stringify(data)));
    } catch {
        // Fallback for non-serializable data (Map, circular refs, etc.)
        console.log(data);
    }
    console.groupEnd();
}

const DebugModeContext = createContext<DebugModeContextValue>({
    enabled: false,
    debugLog,
});

export function DebugModeProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
    const value = useMemo<DebugModeContextValue>(() => ({ enabled, debugLog }), [enabled]);
    return <DebugModeContext.Provider value={value}>{children}</DebugModeContext.Provider>;
}

export function useDebugMode(): DebugModeContextValue {
    return useContext(DebugModeContext);
}
