import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { className?: string };

/**
 * Go-Ahead Baden-Württemberg / Bayern logo.
 * Green rounded rectangle with white "go" text.
 */
export function GoAheadLogo({ className, ...props }: IconProps) {
    return (
        <svg viewBox="0 0 100 50" className={className} {...props}>
            <rect width="100" height="50" rx="8" fill="#95C11F" />
            <text
                x="50" y="35"
                textAnchor="middle"
                fill="#fff"
                fontFamily="Arial, sans-serif"
                fontWeight="bold"
                fontSize="30"
            >
                go.
            </text>
        </svg>
    );
}

/**
 * agilis logo. Orange rounded rectangle with white "agilis" text.
 */
export function AgilisLogo({ className, ...props }: IconProps) {
    return (
        <svg viewBox="0 0 100 50" className={className} {...props}>
            <rect width="100" height="50" rx="8" fill="#E87722" />
            <text
                x="50" y="35"
                textAnchor="middle"
                fill="#fff"
                fontFamily="Arial, sans-serif"
                fontWeight="bold"
                fontSize="22"
            >
                agilis
            </text>
        </svg>
    );
}

/**
 * alex (Die Länderbahn) logo. Green rounded rectangle with white "alex" text.
 */
export function AlexLogo({ className, ...props }: IconProps) {
    return (
        <svg viewBox="0 0 100 50" className={className} {...props}>
            <rect width="100" height="50" rx="8" fill="#006F3C" />
            <text
                x="50" y="35"
                textAnchor="middle"
                fill="#fff"
                fontFamily="Arial, sans-serif"
                fontWeight="bold"
                fontSize="26"
            >
                alex
            </text>
        </svg>
    );
}

/**
 * BRB (Bayerische Regiobahn) / Meridian logo.
 * Dark blue rounded rectangle with white "BRB" text.
 */
export function BRBLogo({ className, ...props }: IconProps) {
    return (
        <svg viewBox="0 0 100 50" className={className} {...props}>
            <rect width="100" height="50" rx="8" fill="#003D7C" />
            <text
                x="50" y="35"
                textAnchor="middle"
                fill="#fff"
                fontFamily="Arial, sans-serif"
                fontWeight="bold"
                fontSize="26"
            >
                BRB
            </text>
        </svg>
    );
}

/**
 * Arverio Bayern (GYRE) logo.
 * Purple/magenta rounded rectangle with white "arverio" text.
 */
export function ArverioLogo({ className, ...props }: IconProps) {
    return (
        <svg viewBox="0 0 100 50" className={className} {...props}>
            <rect width="100" height="50" rx="8" fill="#8B1FA9" />
            <text
                x="50" y="35"
                textAnchor="middle"
                fill="#fff"
                fontFamily="Arial, sans-serif"
                fontWeight="bold"
                fontSize="20"
            >
                arverio
            </text>
        </svg>
    );
}

/**
 * ÖBB (Österreichische Bundesbahnen) logo.
 * Red rounded rectangle with white "ÖBB" text.
 */
export function OeBBLogo({ className, ...props }: IconProps) {
    return (
        <svg viewBox="0 0 100 50" className={className} {...props}>
            <rect width="100" height="50" rx="8" fill="#E2001A" />
            <text
                x="50" y="35"
                textAnchor="middle"
                fill="#fff"
                fontFamily="Arial, sans-serif"
                fontWeight="bold"
                fontSize="28"
            >
                ÖBB
            </text>
        </svg>
    );
}

/**
 * SBB (Schweizerische Bundesbahnen) logo.
 * Red rounded rectangle with white "SBB" text.
 */
export function SBBLogo({ className, ...props }: IconProps) {
    return (
        <svg viewBox="0 0 100 50" className={className} {...props}>
            <rect width="100" height="50" rx="8" fill="#EB0000" />
            <text
                x="50" y="35"
                textAnchor="middle"
                fill="#fff"
                fontFamily="Arial, sans-serif"
                fontWeight="bold"
                fontSize="28"
            >
                SBB
            </text>
        </svg>
    );
}

/**
 * Länderbahn / trilex logo.
 * Green rounded rectangle with white "DLB" text.
 */
export function LaenderbahnLogo({ className, ...props }: IconProps) {
    return (
        <svg viewBox="0 0 100 50" className={className} {...props}>
            <rect width="100" height="50" rx="8" fill="#006F3C" />
            <text
                x="50" y="35"
                textAnchor="middle"
                fill="#fff"
                fontFamily="Arial, sans-serif"
                fontWeight="bold"
                fontSize="26"
            >
                DLB
            </text>
        </svg>
    );
}

/**
 * SNCF logo. Blue/violet rounded rectangle with white "SNCF" text.
 */
export function SNCFLogo({ className, ...props }: IconProps) {
    return (
        <svg viewBox="0 0 100 50" className={className} {...props}>
            <rect width="100" height="50" rx="8" fill="#2C2D72" />
            <text
                x="50" y="35"
                textAnchor="middle"
                fill="#fff"
                fontFamily="Arial, sans-serif"
                fontWeight="bold"
                fontSize="24"
            >
                SNCF
            </text>
        </svg>
    );
}

/**
 * Metronom logo. Orange/yellow rounded rectangle with white "me" text.
 */
export function MetronomLogo({ className, ...props }: IconProps) {
    return (
        <svg viewBox="0 0 100 50" className={className} {...props}>
            <rect width="100" height="50" rx="8" fill="#F5A623" />
            <text
                x="50" y="35"
                textAnchor="middle"
                fill="#fff"
                fontFamily="Arial, sans-serif"
                fontWeight="bold"
                fontSize="28"
            >
                me
            </text>
        </svg>
    );
}

/**
 * erixx logo. Green rounded rectangle with white "erixx" text.
 */
export function ErixxLogo({ className, ...props }: IconProps) {
    return (
        <svg viewBox="0 0 100 50" className={className} {...props}>
            <rect width="100" height="50" rx="8" fill="#009640" />
            <text
                x="50" y="35"
                textAnchor="middle"
                fill="#fff"
                fontFamily="Arial, sans-serif"
                fontWeight="bold"
                fontSize="22"
            >
                erixx
            </text>
        </svg>
    );
}

/**
 * National Express logo. White rounded rectangle with red "NX" text.
 */
export function NationalExpressLogo({ className, ...props }: IconProps) {
    return (
        <svg viewBox="0 0 100 50" className={className} {...props}>
            <rect width="100" height="50" rx="8" fill="#fff" stroke="#E30613" strokeWidth="3" />
            <text
                x="50" y="36"
                textAnchor="middle"
                fill="#E30613"
                fontFamily="Arial, sans-serif"
                fontWeight="bold"
                fontSize="28"
            >
                NX
            </text>
        </svg>
    );
}

/**
 * Eurobahn logo. Blue rounded rectangle with white "EB" text.
 */
export function EurobahnLogo({ className, ...props }: IconProps) {
    return (
        <svg viewBox="0 0 100 50" className={className} {...props}>
            <rect width="100" height="50" rx="8" fill="#003399" />
            <text
                x="50" y="35"
                textAnchor="middle"
                fill="#fff"
                fontFamily="Arial, sans-serif"
                fontWeight="bold"
                fontSize="28"
            >
                EB
            </text>
        </svg>
    );
}

/**
 * NordWestBahn logo. Blue rounded rectangle with white "NWB" text.
 */
export function NordWestBahnLogo({ className, ...props }: IconProps) {
    return (
        <svg viewBox="0 0 100 50" className={className} {...props}>
            <rect width="100" height="50" rx="8" fill="#004990" />
            <text
                x="50" y="35"
                textAnchor="middle"
                fill="#fff"
                fontFamily="Arial, sans-serif"
                fontWeight="bold"
                fontSize="22"
            >
                NWB
            </text>
        </svg>
    );
}

/**
 * vlexx logo. Red rounded rectangle with white "vlexx" text.
 */
export function VlexxLogo({ className, ...props }: IconProps) {
    return (
        <svg viewBox="0 0 100 50" className={className} {...props}>
            <rect width="100" height="50" rx="8" fill="#C8102E" />
            <text
                x="50" y="35"
                textAnchor="middle"
                fill="#fff"
                fontFamily="Arial, sans-serif"
                fontWeight="bold"
                fontSize="22"
            >
                vlexx
            </text>
        </svg>
    );
}

/**
 * HLB (Hessische Landesbahn) logo. Blue rounded rectangle with white "HLB" text.
 */
export function HLBLogo({ className, ...props }: IconProps) {
    return (
        <svg viewBox="0 0 100 50" className={className} {...props}>
            <rect width="100" height="50" rx="8" fill="#003F7D" />
            <text
                x="50" y="35"
                textAnchor="middle"
                fill="#fff"
                fontFamily="Arial, sans-serif"
                fontWeight="bold"
                fontSize="26"
            >
                HLB
            </text>
        </svg>
    );
}

export type OperatorLogoComponent = (props: IconProps) => JSX.Element;

/**
 * Maps normalized operator names from GTFS agency_name to their logo components.
 * The matching is done by checking if the agency_name contains the key substring.
 */
const OPERATOR_MATCHERS: [string, OperatorLogoComponent][] = [
    // Specific operators (checked before DB Regio catch-all)
    ["Go-Ahead", GoAheadLogo],
    ["agilis", AgilisLogo],
    ["alex", AlexLogo],
    ["trilex", LaenderbahnLogo],
    ["vogtlandbahn", LaenderbahnLogo],
    ["Länderbahn", LaenderbahnLogo],
    ["GYRE", ArverioLogo],
    ["Arverio", ArverioLogo],
    ["Meridian", BRBLogo],
    ["BRB", BRBLogo],
    ["Bayerische Regiobahn", BRBLogo],
    ["ÖBB", OeBBLogo],
    ["SBB", SBBLogo],
    ["SNCF", SNCFLogo],
    ["metronom", MetronomLogo],
    ["erixx", ErixxLogo],
    ["National Express", NationalExpressLogo],
    ["eurobahn", EurobahnLogo],
    ["NordWestBahn", NordWestBahnLogo],
    ["vlexx", VlexxLogo],
    ["Hessische Landesbahn", HLBLogo],
    ["Südostbayernbahn", BRBLogo],
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
