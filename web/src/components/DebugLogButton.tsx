import { Terminal } from "lucide-react";
import { useDebugMode, debugLog } from "../contexts/DebugModeContext";

/** Debug log button that uses context — renders nothing when debug mode is off. */
export function DebugLogButton({ label, data, className }: { label: string; data: unknown; className?: string }) {
    const { enabled, debugLog: log } = useDebugMode();
    if (!enabled) return null;
    return (
        <span
            role="button"
            tabIndex={-1}
            className={`shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground cursor-pointer ${className ?? ""}`}
            onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                log(label, data);
            }}
            onMouseDown={(e) => e.preventDefault()}
            title={`Log ${label}`}
            aria-label={`Log ${label} to console`}
        >
            <Terminal className="h-3.5 w-3.5" />
        </span>
    );
}

/** Debug log button that takes enabled as a prop — for map popups outside React tree. */
export function DebugLogButtonDirect({ label, data, enabled, className }: { label: string; data: unknown; enabled: boolean; className?: string }) {
    if (!enabled) return null;
    return (
        <span
            role="button"
            tabIndex={-1}
            className={`shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground cursor-pointer ${className ?? ""}`}
            onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                debugLog(label, data);
            }}
            onMouseDown={(e) => e.preventDefault()}
            title={`Log ${label}`}
            aria-label={`Log ${label} to console`}
        >
            <Terminal className="h-3.5 w-3.5" />
        </span>
    );
}
