import type { StationPlatform, StationStopPosition } from "../api";

// Extract platform identifier from ref, or from IFOPT ID (last segment after colon)
export function getPlatformDisplayName(platform: StationPlatform | StationStopPosition): string {
    if (platform.ref) return platform.ref;
    if (platform.ref_ifopt) {
        const lastSegment = platform.ref_ifopt.split(":").pop();
        if (lastSegment) return lastSegment.toUpperCase();
    }
    return "?";
}

// Time formatter - created lazily to use browser's locale at runtime
let timeFormatter: Intl.DateTimeFormat | null = null;

function getTimeFormatter(): Intl.DateTimeFormat {
    if (!timeFormatter) {
        // Use navigator.language explicitly to respect browser locale
        const locale = typeof navigator !== 'undefined' ? navigator.language : undefined;
        timeFormatter = new Intl.DateTimeFormat(locale, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
    }
    return timeFormatter;
}

// Format time from ISO string using the browser's locale
export function formatTime(isoString: string): string {
    const date = new Date(isoString);
    return getTimeFormatter().format(date);
}
