import { lazy, Suspense } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Loader2 } from "lucide-react";

const EspFlasherPanel = lazy(() =>
    import("./EspFlasherPanel").then((m) => ({ default: m.EspFlasherPanel }))
);

interface EspFlasherDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function EspFlasherDialog({ open, onOpenChange }: EspFlasherDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl h-[80vh] flex flex-col p-0">
                <DialogHeader className="px-6 pt-6 pb-0">
                    <DialogTitle>ESP32 Flasher</DialogTitle>
                    <DialogDescription>
                        Firmware über Web Serial auf ESP32-Geräte flashen
                    </DialogDescription>
                </DialogHeader>
                <div className="flex-1 min-h-0 overflow-y-auto">
                    <Suspense
                        fallback={
                            <div className="flex items-center justify-center h-full">
                                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                            </div>
                        }
                    >
                        <EspFlasherPanel />
                    </Suspense>
                </div>
            </DialogContent>
        </Dialog>
    );
}
