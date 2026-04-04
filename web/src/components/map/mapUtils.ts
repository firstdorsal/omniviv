import type { StationPlatform, StationStopPosition } from "../api";

// Extract platform identifier from ref, or from IFOPT ID (last segment after colon)
export function getPlatformDisplayName(platform: StationPlatform | StationStopPosition): string {
    if (platform.ref) {
        // Split compound refs like "A;B" and return first part
        // The full compound ref should be handled by callers that need all parts
        const first = platform.ref.split(";")[0].trim();
        if (first) return first;
    }
    if (platform.ref_ifopt) {
        // Split compound IFOPTs like "de:...:A;de:...:B" and use suffix of first
        const firstIfopt = platform.ref_ifopt.split(";")[0].trim();
        const lastSegment = firstIfopt.split(":").pop();
        if (lastSegment) return lastSegment.toUpperCase();
    }
    // Use last 3 digits of OSM ID as a short numeric label
    return String(platform.osm_id % 1000);
}

// Time formatters - created lazily to use browser's locale at runtime
let timeFormatterWithSeconds: Intl.DateTimeFormat | null = null;
let timeFormatterNoSeconds: Intl.DateTimeFormat | null = null;

function getTimeFormatter(includeSeconds: boolean = true): Intl.DateTimeFormat {
    if (includeSeconds) {
        if (!timeFormatterWithSeconds) {
            const locale = typeof navigator !== 'undefined' ? navigator.language : undefined;
            timeFormatterWithSeconds = new Intl.DateTimeFormat(locale, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
            });
        }
        return timeFormatterWithSeconds;
    }
    if (!timeFormatterNoSeconds) {
        const locale = typeof navigator !== 'undefined' ? navigator.language : undefined;
        timeFormatterNoSeconds = new Intl.DateTimeFormat(locale, {
            hour: "2-digit",
            minute: "2-digit",
        });
    }
    return timeFormatterNoSeconds;
}

// Format time from ISO string using the browser's locale
export function formatTime(isoString: string, includeSeconds: boolean = true): string {
    const date = new Date(isoString);
    return getTimeFormatter(includeSeconds).format(date);
}

/** Split a formatted time into the main part (HH:MM + AM/PM) and the seconds part (:SS).
 *  Works with both 24h (14:30:45) and 12h (03:30:45 PM) locales. */
export function formatTimeParts(isoString: string): { main: string; seconds: string } {
    const parts = getTimeFormatter().formatToParts(new Date(isoString));
    // Find the index of the "second" part and its preceding separator
    const secondIdx = parts.findIndex(p => p.type === "second");
    if (secondIdx < 0) {
        return { main: getTimeFormatter().format(new Date(isoString)), seconds: "" };
    }
    // The literal immediately before "second" is the separator (e.g., ":")
    const sepIdx = secondIdx > 0 && parts[secondIdx - 1].type === "literal" ? secondIdx - 1 : -1;

    let main = "";
    let seconds = "";
    for (let i = 0; i < parts.length; i++) {
        if (i === sepIdx || i === secondIdx) {
            seconds += parts[i].value;
        } else {
            main += parts[i].value;
        }
    }
    return { main, seconds };
}
