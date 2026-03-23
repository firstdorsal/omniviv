import { formatTimeParts } from "./map/mapUtils";

interface LiveTimeProps {
    /** ISO 8601 time string to display. */
    time: string;
    /** Whether this is a live/estimated time (vs. scheduled). */
    isLive: boolean;
    /** Delay in minutes: positive = late, negative = early, 0/null = on time. */
    delayMinutes: number | null;
}

/**
 * Renders a departure/arrival time with:
 * - Dimmed seconds (same color, lower opacity)
 * - Color coding for live times: foreground (on time), destructive (late), green (early)
 * - A small pulsing dot indicator for live data
 * - Scheduled (non-live) times stay in muted-foreground
 */
export function LiveTime({ time, isLive, delayMinutes }: LiveTimeProps) {
    const { main, seconds } = formatTimeParts(time);
    const delay = delayMinutes ?? 0;

    if (!isLive) {
        return (
            <span className="text-muted-foreground tabular-nums whitespace-nowrap">
                {main}{seconds && <span className="opacity-40 tracking-normal">{seconds}</span>}
            </span>
        );
    }

    // Live time: color based on delay status
    let colorClass: string;
    let dotClass: string;
    if (delay > 0) {
        colorClass = "text-destructive";
        dotClass = "bg-destructive";
    } else if (delay < 0) {
        colorClass = "text-green-600 dark:text-green-500";
        dotClass = "bg-green-600 dark:bg-green-500";
    } else {
        colorClass = "text-foreground";
        dotClass = "bg-foreground";
    }

    return (
        <span className={`${colorClass} tabular-nums inline-flex items-center gap-1 whitespace-nowrap`}>
            <span className="relative flex h-1.5 w-1.5 shrink-0">
                <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-50 ${dotClass}`} />
                <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${dotClass}`} />
            </span>
            <span>{main}{seconds && <span className="opacity-40 tracking-normal">{seconds}</span>}</span>
        </span>
    );
}
