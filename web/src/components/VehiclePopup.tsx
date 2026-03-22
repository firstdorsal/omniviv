import { LineBadge } from "./LineBadge";

interface VehiclePopupProps {
    tripId: string;
    lineNumber: string;
    destination: string;
    status: string;
    delayMinutes: number | null;
    currentStopName: string | null;
    nextStopName: string | null;
    routeColors: Map<string, string>;
}

export function VehiclePopup({
    tripId,
    lineNumber,
    destination,
    status,
    delayMinutes,
    currentStopName,
    nextStopName,
    routeColors,
}: VehiclePopupProps) {
    const routeColor = routeColors.get(lineNumber);

    const getStatusText = () => {
        switch (status) {
            case "waiting":
                return currentStopName ? `Wartet an ${currentStopName}` : "Wartet auf Abfahrt";
            case "at_stop":
                return currentStopName ? `An ${currentStopName}` : "An Haltestelle";
            case "in_transit":
                return nextStopName ? `Unterwegs nach ${nextStopName}` : "Unterwegs";
            case "approaching":
                return nextStopName ? `Nähert sich ${nextStopName}` : "Nähert sich Haltestelle";
            case "completed":
                return "Fahrt beendet";
            default:
                return status;
        }
    };

    const getDelayDisplay = () => {
        // Handle null, undefined, string "null", or 0
        if (delayMinutes == null || delayMinutes === 0) {
            return <span className="text-green-600 font-medium">Pünktlich</span>;
        }
        const delay = Number(delayMinutes);
        if (isNaN(delay)) {
            return <span className="text-green-600 font-medium">Pünktlich</span>;
        }
        if (delay > 0) {
            return <span className="text-red-600 font-medium">+{delay} Min Verspätung</span>;
        }
        return <span className="text-blue-600 font-medium">{Math.abs(delay)} Min zu früh</span>;
    };

    return (
        <div className="p-4 pr-8 min-w-48">
            {/* Header with line number and destination */}
            <div className="flex items-center gap-3">
                <LineBadge line={lineNumber} color={routeColor} variant="circle" />
                <div>
                    <div className="font-semibold text-gray-900">{destination}</div>
                    <div className="text-sm text-gray-500">Linie {lineNumber}</div>
                </div>
            </div>

            {/* Status and delay */}
            <div className="mt-3 border-t pt-2 space-y-1 text-sm">
                <div className="flex justify-between gap-4">
                    <span className="text-gray-600">Status:</span>
                    <span className="text-gray-900 text-right">{getStatusText()}</span>
                </div>
                <div className="flex justify-between gap-4">
                    <span className="text-gray-600">Verspätung:</span>
                    {getDelayDisplay()}
                </div>
                <div className="flex justify-between gap-4">
                    <span className="text-gray-600">Fahrt-ID:</span>
                    <span className="text-gray-500 font-mono text-xs">{tripId}</span>
                </div>
            </div>
        </div>
    );
}
