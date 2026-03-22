interface DurationProps {
    /** Duration in seconds */
    seconds: number;
    className?: string;
}

/**
 * Displays a duration. Shows "min" suffix when the parent container
 * is wide enough (via CSS container query), omits it when narrow.
 *
 * Wrap a parent element with `@container` class to enable responsive "min".
 */
export function Duration({ seconds, className = "" }: DurationProps) {
    const totalMins = Math.round(seconds / 60);
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;

    return (
        <span className={`inline-flex items-baseline gap-0.5 tabular-nums ${className}`}>
            {h > 0 && (
                <>
                    <span>{h}</span>
                    <span>h</span>
                </>
            )}
            {(m > 0 || h === 0) && <span>{m}</span>}
            <span className="hidden @min-[8rem]:inline">min</span>
        </span>
    );
}
