import { LocationTypeIcon, type ResolvedLocation } from "./LocationSearch";

interface LocationLabelProps {
    location: ResolvedLocation;
    /** Platform code or track number to display after the name */
    platform?: string | null;
    className?: string;
    iconClassName?: string;
}

/** Reusable icon + name display for a resolved location, optionally with platform/track. */
export function LocationLabel({ location, platform, className = "", iconClassName = "h-4 w-4 shrink-0" }: LocationLabelProps) {
    return (
        <span className={`inline-flex items-center gap-1.5 min-w-0 ${className}`}>
            <LocationTypeIcon type={location.type} iconName={location.iconName} className={iconClassName} />
            <span className="truncate">
                {location.name}
                {platform && <span className="text-muted-foreground font-normal"> Gl. {platform}</span>}
            </span>
        </span>
    );
}
