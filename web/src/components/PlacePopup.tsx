import { useEffect, useState } from "react";
import { getCityPopulation, formatPopulation } from "../data/cityPopulations";

interface PlacePopupProps {
    name: string;
    placeClass: string;
}

export function PlacePopup({ name, placeClass }: PlacePopupProps) {
    const [population, setPopulation] = useState<number | null>(null);

    useEffect(() => {
        getCityPopulation(name).then((result) => {
            if (result) setPopulation(result.population);
        });
    }, [name]);

    const typeLabel =
        placeClass === "city" || placeClass === "town"
            ? "Stadt"
            : placeClass === "village"
              ? "Gemeinde"
              : "Ort";

    return (
        <div className="p-3 min-w-[140px]">
            <div className="font-semibold text-sm">{name}</div>
            <div className="text-xs text-muted-foreground">
                {typeLabel}
                {population != null && (
                    <span> · {formatPopulation(population)} Einwohner</span>
                )}
            </div>
        </div>
    );
}
