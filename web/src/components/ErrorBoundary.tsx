import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
    children: ReactNode;
    fallback?: ReactNode;
}

interface ErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    constructor(props: ErrorBoundaryProps) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
        console.error("ErrorBoundary caught an error:", error, errorInfo);
    }

    render(): ReactNode {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }

            return (
                <div className="flex items-center justify-center h-full bg-muted">
                    <div className="max-w-md p-6 bg-background rounded-lg shadow-lg">
                        <h2 className="text-xl font-semibold text-destructive mb-2">Etwas ist schiefgelaufen</h2>
                        <p className="text-muted-foreground mb-4">
                            Ein unerwarteter Fehler ist aufgetreten. Bitte lade die Seite neu.
                        </p>
                        {this.state.error && (
                            <details className="text-sm text-muted-foreground">
                                <summary className="cursor-pointer hover:text-foreground">Fehlerdetails</summary>
                                <pre className="mt-2 p-2 bg-muted rounded overflow-auto text-xs">
                                    {this.state.error.message}
                                </pre>
                            </details>
                        )}
                        <button
                            onClick={() => window.location.reload()}
                            className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors"
                        >
                            Seite neu laden
                        </button>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}
