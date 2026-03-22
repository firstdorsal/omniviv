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

function getModeIcon(mode?: string): IconComponent | null {
    if (!mode) return null;
    return MODE_ICONS[mode.toLowerCase()] ?? null;
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
    const Icon = getModeIcon(mode);

    switch (variant) {
        case "circle":
            return (
                <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-lg shrink-0 ${className}`}
                    style={{ backgroundColor: bg }}
                >
                    {Icon ? <Icon className="h-5 w-5 shrink-0" /> : null}
                    {line}
                </div>
            );
        case "pill":
            return (
                <span
                    className={`inline-flex items-center gap-1 rounded-md text-xs font-mono font-semibold px-1.5 h-6 border text-white ${className}`}
                    style={{ borderColor: bg, backgroundColor: bg }}
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
                    className={`inline-flex items-center gap-1 rounded px-1.5 h-6 font-mono font-bold text-white text-xs leading-none ${className}`}
                    style={{ backgroundColor: bg }}
                >
                    {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
                    {line}
                </span>
            );
    }
}
