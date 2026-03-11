import { useState } from "react";
import { Cpu, Moon, Sun } from "lucide-react";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import { Label } from "./ui/label";
import { EspFlasherDialog } from "./EspFlasherDialog";
import { featureManager } from "./vehicles/features";
import type { RendezvousState } from "../hooks/useRendezvous";

interface FeaturesPanelProps {
    isDark: boolean;
    onThemeChange: (isDark: boolean) => void;
    rendezvousEnabled: boolean;
    onRendezvousChange: (enabled: boolean) => void;
    rendezvousState: RendezvousState | null;
    shouldFlash: boolean;
}

export function FeaturesPanel({
    isDark,
    onThemeChange,
    rendezvousEnabled,
    onRendezvousChange,
    rendezvousState,
    shouldFlash,
}: FeaturesPanelProps) {
    const [features, setFeatures] = useState(featureManager.getAllFeatures());
    const [espDialogOpen, setEspDialogOpen] = useState(false);

    const handleToggle = (featureId: string) => {
        featureManager.toggleFeature(featureId);
        setFeatures(featureManager.getAllFeatures());
    };

    return (
        <div className="p-4">
            <h2 className="font-semibold mb-4">Settings</h2>

            {/* Style Settings */}
            <div className="mb-6">
                <h3 className="text-sm font-medium text-muted-foreground mb-3">Style</h3>
                <div className="space-y-4">
                    <div className="flex items-center gap-3">
                        <Switch
                            id="dark-mode"
                            checked={isDark}
                            onCheckedChange={onThemeChange}
                        />
                        <div className="flex items-center gap-2">
                            {isDark ? (
                                <Moon className="h-4 w-4" />
                            ) : (
                                <Sun className="h-4 w-4" />
                            )}
                            <Label htmlFor="dark-mode" className="font-medium cursor-pointer">
                                {isDark ? "Dark mode" : "Light mode"}
                            </Label>
                        </div>
                    </div>
                </div>
            </div>

            {/* Simulation Settings */}
            <div>
                <h3 className="text-sm font-medium text-muted-foreground mb-3">Simulation</h3>
                <div className="space-y-4">
                    {/* Königsplatz Rendezvous */}
                    <div className="flex items-start gap-3">
                        <Switch
                            id="rendezvous"
                            checked={rendezvousEnabled}
                            onCheckedChange={onRendezvousChange}
                        />
                        <div className="space-y-1 flex-1">
                            <Label htmlFor="rendezvous" className="font-medium cursor-pointer">
                                Königsplatz Rendezvous
                            </Label>
                            <p className="text-sm text-muted-foreground">
                                Building lights up when trams meet (20:30-00:00)
                            </p>
                            {rendezvousEnabled && rendezvousState && (
                                <div className="mt-2 p-2 rounded bg-muted text-xs">
                                    <div className="flex items-center gap-2">
                                        <span
                                            className={`w-3 h-3 rounded-full shrink-0 ${
                                                rendezvousState.isRendezvous ? "bg-green-500" : "bg-blue-600"
                                            } ${shouldFlash ? "animate-pulse" : ""}`}
                                        />
                                        <span>
                                            {rendezvousState.isRendezvous
                                                ? `Rendezvous! ${rendezvousState.tramCount} trams`
                                                : `Waiting (${rendezvousState.tramCount} tram${rendezvousState.tramCount !== 1 ? "s" : ""})`}
                                        </span>
                                    </div>
                                </div>
                            )}
                            {rendezvousEnabled && !rendezvousState && (
                                <div className="mt-2 p-2 rounded bg-muted text-xs text-muted-foreground">
                                    Inactive (outside 20:30-00:00 or not dark)
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Other features from feature manager */}
                    {features.map((feature) => (
                        <div key={feature.id} className="flex items-start gap-3">
                            <Switch
                                id={feature.id}
                                checked={feature.enabled}
                                onCheckedChange={() => handleToggle(feature.id)}
                            />
                            <div className="space-y-1">
                                <Label htmlFor={feature.id} className="font-medium cursor-pointer">
                                    {feature.name}
                                </Label>
                                <p className="text-sm text-muted-foreground">
                                    {feature.description}
                                </p>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Tools */}
            <div className="mt-6 pt-4 border-t">
                <h3 className="text-sm font-medium text-muted-foreground mb-3">Tools</h3>
                <Button
                    variant="outline"
                    className="w-full gap-2"
                    onClick={() => setEspDialogOpen(true)}
                >
                    <Cpu className="h-4 w-4" />
                    ESP32 Flasher
                </Button>
            </div>

            <EspFlasherDialog open={espDialogOpen} onOpenChange={setEspDialogOpen} />
        </div>
    );
}
