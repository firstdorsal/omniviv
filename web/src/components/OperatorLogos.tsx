import type { SVGProps, ReactElement } from "react";

type IconProps = SVGProps<SVGSVGElement> & { className?: string };

/** Operator logo as an img tag loading a static SVG file. */
function OperatorImg({ src, alt, className }: { src: string; alt: string; className?: string }) {
    return <img src={src} alt={alt} className={`object-contain ${className ?? ""}`} />;
}

/** Generic operator badge: wide rectangle (3:2) with white text abbreviation.
 *  Used as fallback when no real logo SVG is available. */
function OperatorBadge({
    text,
    fill,
    textFill = "#fff",
    fontSize = 30,
    stroke,
    strokeWidth,
    className,
    ...props
}: IconProps & {
    text: string;
    fill: string;
    textFill?: string;
    fontSize?: number;
    stroke?: string;
    strokeWidth?: number;
}) {
    return (
        <svg viewBox="0 0 75 50" className={className} {...props}>
            <rect
                width="75" height="50" rx="8"
                fill={fill}
                stroke={stroke}
                strokeWidth={strokeWidth}
            />
            <text
                x="37.5" y="37"
                textAnchor="middle"
                fill={textFill}
                fontFamily="Arial, sans-serif"
                fontWeight="bold"
                fontSize={fontSize}
            >
                {text}
            </text>
        </svg>
    );
}

// ─── Real SVG logos (from /public/logos/operators/) ───────────────────────────

const BRBLogo = (p: IconProps) => <OperatorImg src="/logos/operators/brb.svg" alt="BRB" className={p.className} />;
const ArverioLogo = (p: IconProps) => <OperatorImg src="/logos/operators/arverio.svg" alt="Arverio" className={p.className} />;
const GoAheadLogo = (p: IconProps) => <OperatorImg src="/logos/operators/go-ahead.svg" alt="Go-Ahead" className={p.className} />;
const AgilisLogo = (p: IconProps) => <OperatorImg src="/logos/operators/agilis.svg" alt="agilis" className={p.className} />;
const AlexLogo = (p: IconProps) => <OperatorImg src="/logos/operators/alex.svg" alt="alex" className={p.className} />;
const TrilexLogo = (p: IconProps) => <OperatorImg src="/logos/operators/trilex.svg" alt="trilex" className={p.className} />;
const FlixLogo = (p: IconProps) => <OperatorImg src="/logos/operators/flixtrain.svg" alt="Flix" className={p.className} />;
const OeBBLogo = (p: IconProps) => <OperatorImg src="/logos/operators/oebb.svg" alt="ÖBB" className={p.className} />;
const SBBLogo = (p: IconProps) => <OperatorImg src="/logos/operators/sbb.svg" alt="SBB" className={p.className} />;
const MetronomLogo = (p: IconProps) => <OperatorImg src="/logos/operators/metronom.svg" alt="metronom" className={p.className} />;

// ─── Text-based fallback badges (no real logo available) ─────────────────────

const LaenderbahnLogo = (p: IconProps) => <OperatorBadge text="DLB" fill="#006F3C" {...p} />;
const SNCFLogo = (p: IconProps) => <OperatorBadge text="SNCF" fill="#2C2D72" fontSize={24} {...p} />;
const ErixxLogo = (p: IconProps) => <OperatorBadge text="erixx" fill="#009640" fontSize={22} {...p} />;
const NationalExpressLogo = (p: IconProps) => <OperatorBadge text="NX" fill="#fff" textFill="#E30613" stroke="#E30613" strokeWidth={3} {...p} />;
const EurobahnLogo = (p: IconProps) => <OperatorBadge text="EB" fill="#003399" {...p} />;
const NordWestBahnLogo = (p: IconProps) => <OperatorBadge text="NWB" fill="#004990" {...p} />;
const VlexxLogo = (p: IconProps) => <OperatorBadge text="vlexx" fill="#C8102E" fontSize={22} {...p} />;
const HLBLogo = (p: IconProps) => <OperatorBadge text="HLB" fill="#003F7D" {...p} />;
const WestfalenbahnLogo = (p: IconProps) => <OperatorBadge text="WFB" fill="#E30613" {...p} />;
const ODEGLogo = (p: IconProps) => <OperatorBadge text="ODEG" fill="#0054A6" fontSize={24} {...p} />;
const CantusLogo = (p: IconProps) => <OperatorBadge text="cant" fill="#E30613" fontSize={24} {...p} />;
const TransdevLogo = (p: IconProps) => <OperatorBadge text="TD" fill="#00A3E0" {...p} />;
const NetineraLogo = (p: IconProps) => <OperatorBadge text="NTR" fill="#003D7C" {...p} />;
const EnnoLogo = (p: IconProps) => <OperatorBadge text="enno" fill="#009640" fontSize={24} {...p} />;
const ABRLogo = (p: IconProps) => <OperatorBadge text="ABR" fill="#E30613" {...p} />;
const RTBLogo = (p: IconProps) => <OperatorBadge text="RTB" fill="#0054A6" {...p} />;
const StartLogo = (p: IconProps) => <OperatorBadge text="start" fill="#E30613" fontSize={20} {...p} />;
const RBLogo = (p: IconProps) => <OperatorBadge text="RB" fill="#0054A6" {...p} />;

export type OperatorLogoComponent = (props: IconProps) => ReactElement;

/**
 * Maps GTFS agency_name substrings to their logo components.
 * Checked in order; first match wins. More specific matches come first.
 */
const OPERATOR_MATCHERS: [string, OperatorLogoComponent][] = [
    // Real SVG logos
    ["Flix", FlixLogo],
    ["Go-Ahead", GoAheadLogo],
    ["agilis", AgilisLogo],
    ["alex", AlexLogo],
    ["trilex", TrilexLogo],
    ["GYRE", ArverioLogo],
    ["GYRB", ArverioLogo],
    ["Arverio", ArverioLogo],
    ["Meridian", BRBLogo],
    ["BRB", BRBLogo],
    ["Bayerische Regiobahn", BRBLogo],
    ["Südostbayernbahn", BRBLogo],
    ["ÖBB", OeBBLogo],
    ["SBB", SBBLogo],
    ["metronom", MetronomLogo],
    // Text-based fallbacks
    ["vogtlandbahn", LaenderbahnLogo],
    ["Länderbahn", LaenderbahnLogo],
    ["oberpfalzbahn", LaenderbahnLogo],
    ["SNCF", SNCFLogo],
    ["erixx", ErixxLogo],
    ["enno", EnnoLogo],
    ["National Express", NationalExpressLogo],
    ["eurobahn", EurobahnLogo],
    ["Keolis", EurobahnLogo],
    ["NordWestBahn", NordWestBahnLogo],
    ["vlexx", VlexxLogo],
    ["Hessische Landesbahn", HLBLogo],
    ["Westfalenbahn", WestfalenbahnLogo],
    ["ODEG", ODEGLogo],
    ["Ostdeutsche Eisenbahn", ODEGLogo],
    ["cantus", CantusLogo],
    ["Transdev", TransdevLogo],
    ["Netinera", NetineraLogo],
    ["Abellio", ABRLogo],
    ["RTB", RTBLogo],
    ["Regiobahn", RBLogo],
    ["START", StartLogo],
];

/**
 * Get the operator logo component for a given GTFS agency name.
 * Returns null if no matching operator logo is found (e.g. for DB Regio,
 * which uses the standard DB icon already shown by LineBadge).
 */
export function getOperatorLogo(agencyName: string | null | undefined): OperatorLogoComponent | null {
    if (!agencyName) return null;
    for (const [key, logo] of OPERATOR_MATCHERS) {
        if (agencyName.includes(key)) return logo;
    }
    return null;
}
