import type { ComponentType, SVGProps } from "react";
import { BusIcon, DBIcon, SBahnIcon, TramIcon, TrainIcon, UBahnIcon } from "./TransitIcons";

/** Transit mode values from the MOTIS API and our own TransportType enum. */
export type TransitMode = "TRAM" | "tram" | "BUS" | "bus" | "RAIL" | "TRAIN" | "train" | "SUBWAY" | "subway" | "FERRY" | "ferry" | string;

type IconComponent = ComponentType<SVGProps<SVGSVGElement> & { className?: string }>;

const MODE_ICONS: Record<string, IconComponent> = {
    tram: TramIcon,
    bus: BusIcon,
    train: TrainIcon,
    rail: TrainIcon,
    subway: UBahnIcon,
};

function getModeIcon(mode?: string, line?: string): IconComponent | null {
    if (line) {
        // S-Bahn lines (e.g. "S1", "S12") get the S-Bahn icon
        if (/^S\d/i.test(line)) return SBahnIcon;
        // ICE/IC lines get the DB icon
        if (/^ICE?\b/i.test(line)) return DBIcon;
    }
    if (!mode) return null;
    return MODE_ICONS[mode.toLowerCase()] ?? null;
}

/**
 * Returns "white" or "black" depending on which gives better contrast
 * against the given hex background color (WCAG relative luminance).
 */
function contrastTextColor(hex: string): "white" | "black" {
    const raw = hex.replace("#", "");
    const r = parseInt(raw.substring(0, 2), 16) / 255;
    const g = parseInt(raw.substring(2, 4), 16) / 255;
    const b = parseInt(raw.substring(4, 6), 16) / 255;
    // sRGB → linear
    const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const luminance = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
    return luminance > 0.179 ? "black" : "white";
}

interface LineBadgeProps {
    /** Line number / short name to display */
    line: string;
    /** Route color (hex). Falls back to gray when not provided. */
    color?: string;
    /** Transit mode (e.g. "TRAM", "BUS", "RAIL", "tram", "bus"). Shows an icon when provided. */
    mode?: TransitMode;
    /** Display variant */
    variant?: "inline" | "pill" | "circle" | "text";
    className?: string;
}

const FALLBACK_COLOR = "#6b7280";

/**
 * Reusable transit line badge with optional German transit mode icon inside.
 */
export function LineBadge({ line, color, mode, variant = "inline", className = "" }: LineBadgeProps) {
    const bg = color || FALLBACK_COLOR;
    const Icon = getModeIcon(mode, line);
    const textColor = contrastTextColor(bg);

    switch (variant) {
        case "circle":
            return (
                <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-lg shrink-0 ${className}`}
                    style={{ backgroundColor: bg, color: textColor }}
                >
                    {Icon ? <Icon className="h-5 w-5 shrink-0" /> : null}
                    {line}
                </div>
            );
        case "pill":
            return (
                <span
                    className={`inline-flex items-center gap-1 rounded-md text-xs font-mono font-semibold px-1.5 h-6 border ${className}`}
                    style={{ borderColor: bg, backgroundColor: bg, color: textColor }}
                >
                    {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
                    {line}
                </span>
            );
        case "text":
            return (
                <span
                    className={`inline-flex items-center gap-1 h-6 font-mono font-semibold ${className}`}
                    style={{ color: bg }}
                >
                    {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
                    {line}
                </span>
            );
        default: // inline
            return (
                <span
                    className={`inline-flex items-center gap-1 rounded px-1.5 h-6 font-mono font-bold text-xs leading-none ${className}`}
                    style={{ backgroundColor: bg, color: textColor }}
                    data-testid={`line-badge-${line}`}
                    data-line={line}
                    data-color={bg}
                >
                    {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
                    {line}
                </span>
            );
    }
}
