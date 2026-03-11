import { Pause, Play, RotateCcw } from "lucide-react";
import type { UseTimeSimulationResult } from "../hooks/useTimeSimulation";
import { Button } from "./ui/button";
import { DateTimePicker } from "./ui/date-time-picker";
import { Slider } from "./ui/slider";

interface TimeControlPanelProps {
    timeSimulation: UseTimeSimulationResult;
}

// Speed presets for quick selection
const SPEED_PRESETS = [1, 2, 5, 10, 30, 60];
const MIN_SPEED = 0;
const MAX_SPEED = 60;

// Time formatter - created lazily to use browser's locale at runtime
let timeFormatter: Intl.DateTimeFormat | null = null;

function getTimeFormatter(): Intl.DateTimeFormat {
    if (!timeFormatter) {
        const locale = typeof navigator !== 'undefined' ? navigator.language : undefined;
        timeFormatter = new Intl.DateTimeFormat(locale, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
    }
    return timeFormatter;
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
});

export function TimeControlPanel({ timeSimulation }: TimeControlPanelProps) {
    const { currentTime, speed, isRealTime, setTime, setSpeed, resetToRealTime, pause, resume } = timeSimulation;

    const handleSpeedChange = (value: number[]) => {
        setSpeed(value[0]);
    };

    const getSpeedLabel = (s: number) => {
        if (s === 0) return "Paused";
        return `${s}x`;
    };

    return (
        <div className="p-4">
            <h2 className="font-semibold mb-4">Time Control</h2>

            {/* Current time display */}
            <div className="mb-4 p-3 bg-muted rounded-lg">
                <div className="text-2xl font-mono tabular-nums text-center">
                    {getTimeFormatter().format(currentTime)}
                </div>
                <div className="text-sm text-muted-foreground text-center mt-1">
                    {dateFormatter.format(currentTime)}
                </div>
                <div className="text-xs text-center mt-2 text-orange-500 font-medium h-4">
                    {!isRealTime && (
                        <>Simulation Mode {speed > 0 ? `(${speed}x)` : "(Paused)"}</>
                    )}
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={resetToRealTime}
                    disabled={isRealTime}
                    className="w-full mt-2"
                >
                    <RotateCcw className="h-4 w-4 mr-2" />
                    Reset to Real-time
                </Button>
            </div>

            {/* Simulated time controls */}
            <div className="space-y-3">
                <h3 className="text-sm font-semibold text-muted-foreground">Simulated Time</h3>
                <div>
                    <DateTimePicker value={currentTime} onChange={setTime} />
                    {/* Quick time adjustments */}
                    <div className="flex justify-between mt-2">
                        {[-30, -10, -1, 1, 10, 30].map(minutes => (
                            <Button
                                key={minutes}
                                variant="ghost"
                                size="sm"
                                onClick={() => setTime(new Date(currentTime.getTime() + minutes * 60000))}
                                className="text-xs px-2"
                            >
                                {minutes > 0 ? `+${minutes}` : minutes}m
                            </Button>
                        ))}
                    </div>
                </div>

                {/* Speed control */}
                <div>
                    <div className="flex justify-between items-center mb-2">
                        <label className="text-sm font-medium">Speed</label>
                        <span className="text-sm font-mono tabular-nums bg-muted px-2 py-0.5 rounded">
                            {getSpeedLabel(speed)}
                        </span>
                    </div>
                    <Slider
                        min={MIN_SPEED}
                        max={MAX_SPEED}
                        step={1}
                        value={[speed]}
                        onValueChange={handleSpeedChange}
                    />
                    <div className="flex justify-between mt-1">
                        {SPEED_PRESETS.map(preset => (
                            <button
                                key={preset}
                                type="button"
                                onClick={() => setSpeed(preset)}
                                className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
                                    speed === preset
                                        ? "bg-primary text-primary-foreground"
                                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                                }`}
                            >
                                {preset}x
                            </button>
                        ))}
                    </div>
                </div>

                {/* Playback controls */}
                <div className="pt-2">
                    {speed === 0 ? (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={resume}
                            className="w-full"
                        >
                            <Play className="h-4 w-4 mr-2" />
                            Resume
                        </Button>
                    ) : (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={pause}
                            className="w-full"
                        >
                            <Pause className="h-4 w-4 mr-2" />
                            Pause
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}
