interface DurationProps {
    /** Duration in seconds */
    seconds: number;
    className?: string;
    /** Show full unit names ("Stunden", "Minuten") instead of abbreviations ("h", "min") */
    verbose?: boolean;
    /** Use short single-letter units: "2m", "1h 30m" */
    short?: boolean;
    /** Show only the number, no unit: "2", "1:30" — for tiny inline displays where context (e.g. a walk icon) implies the unit */
    bare?: boolean;
}

/**
 * Displays a duration with unit labels.
 *
 * Examples (default):
 *   2 minutes  → "2 min"
 *   90 minutes → "1 h 30 min"
 *   5h 5min    → "5 h 05 min"
 *
 * Examples (verbose):
 *   2 minutes  → "2 Minuten"
 *   90 minutes → "1 Stunde 30 Minuten"
 *   5h 5min    → "5 Stunden 5 Minuten"
 */
export function Duration({ seconds, className = "", verbose = false, short = false, bare = false }: DurationProps) {
    const totalMins = Math.round(seconds / 60);
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;

    if (verbose) {
        const parts: string[] = [];
        if (h > 0) parts.push(`${h} ${h === 1 ? "Stunde" : "Stunden"}`);
        if (m > 0 || h === 0) parts.push(`${m} ${m === 1 ? "Minute" : "Minuten"}`);
        return <span className={`tabular-nums ${className}`}>{parts.join(" ")}</span>;
    }

    if (bare) {
        return (
            <span className={`tabular-nums ${className}`}>
                {h > 0 ? `${h}:${String(m).padStart(2, "0")}` : m}
            </span>
        );
    }

    if (short) {
        return (
            <span className={`inline-flex items-baseline gap-0.5 tabular-nums ${className}`}>
                {h > 0 && <><span>{h}</span><span>h</span></>}
                {(m > 0 || h === 0) && <><span>{h > 0 ? String(m).padStart(2, "0") : m}</span></>}
            </span>
        );
    }

    return (
        <span className={`inline-flex items-baseline gap-0.5 tabular-nums ${className}`}>
            {h > 0 && (
                <>
                    <span>{h}</span>
                    <span>h</span>
                </>
            )}
            {(m > 0 || h === 0) && (
                <>
                    <span>{h > 0 ? String(m).padStart(2, "0") : m}</span>
                    <span>min</span>
                </>
            )}
        </span>
    );
}
