import type { ReactNode } from "react";

interface DepartureMonitorHeaderProps {
    title: string;
    stationName?: string;
    /** ID lines displayed in monospace (e.g. IFOPT, GTFS ID) */
    ids?: { label?: string; value: string }[];
    /** Extra content below IDs (e.g. assignment status) */
    extra?: ReactNode;
    /** Action buttons rendered on the right */
    actions?: ReactNode;
}

export function DepartureMonitorHeader({ title, stationName, ids, extra, actions }: DepartureMonitorHeaderProps) {
    return (
        <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold">{title}</div>
                {stationName && <div className="text-xs text-muted-foreground">{stationName}</div>}
                {ids?.map(({ label, value }, i) => (
                    <div key={`${label ?? ""}:${value}:${i}`} className="text-xs text-muted-foreground font-mono">
                        {label ? `${label}: ${value}` : value}
                    </div>
                ))}
                {extra}
            </div>
            {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
        </div>
    );
}
