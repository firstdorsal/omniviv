/**
 * Circular waypoint marker with a centered letter (A, B, C, …).
 * Used in the route planning inputs, the expanded itinerary detail,
 * and as map markers.
 *
 * Renders as SVG so the letter is always pixel-perfectly centered
 * (avoids CSS text-baseline alignment issues).
 */

interface WaypointMarkerProps {
    /** 0-based index → rendered as A, B, C, … */
    index: number;
    /** Pixel size of the marker */
    size?: number;
    className?: string;
    onClick?: () => void;
}

export function WaypointMarker({ index, size = 24, className = "", onClick }: WaypointMarkerProps) {
    const letter = String.fromCharCode(65 + index);
    const r = size / 2;
    const strokeW = size >= 24 ? 2 : 1.5;
    const fontSize = Math.round(size * 0.42);

    return (
        <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            className={`shrink-0 ${onClick ? "cursor-pointer" : ""} ${className}`}
            onClick={onClick}
        >
            <circle
                cx={r} cy={r} r={r - strokeW / 2}
                fill="var(--background, transparent)"
                stroke="currentColor"
                strokeWidth={strokeW}
            />
            <text
                x={r} y={r}
                textAnchor="middle"
                dominantBaseline="central"
                fill="currentColor"
                fontSize={fontSize}
                fontWeight="bold"
                fontFamily="ui-monospace, monospace"
            >
                {letter}
            </text>
        </svg>
    );
}

/**
 * Create a DOM element for use as a maplibre marker.
 * Returns a styled div matching the WaypointMarker appearance.
 */
export function createWaypointMarkerElement(index: number, size = 32): HTMLElement {
    const letter = String.fromCharCode(65 + index);
    const strokeW = 2.5;
    const r = size / 2;
    const fontSize = Math.round(size * 0.42);

    const el = document.createElement("div");
    el.className = "nav-waypoint-marker";
    el.style.cssText = `width:${size}px;height:${size}px;cursor:default;user-select:none;filter:drop-shadow(0 1px 3px rgba(0,0,0,.3));`;
    el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${r}" cy="${r}" r="${r - strokeW / 2}" fill="var(--background)" stroke="var(--foreground)" stroke-width="${strokeW}" />
        <text x="${r}" y="${r}" text-anchor="middle" dominant-baseline="central" fill="var(--foreground)" font-size="${fontSize}" font-weight="bold" font-family="ui-monospace, monospace">${letter}</text>
    </svg>`;
    return el;
}
