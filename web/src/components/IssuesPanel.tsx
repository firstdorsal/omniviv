import { useState, useEffect, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { getConfig } from "../config";
import {
    IssueCategory,
    OsmIssue,
    OsmIssueType,
    TransportType,
    MatchCandidate,
    IssueListResponse,
} from "../api";
import { MappingManager, type MappingLine, type MappingMapData } from "./MappingManager";

const ISSUE_TYPE_LABELS: Record<OsmIssueType, string> = {
    [OsmIssueType.MissingIfopt]: "Missing IFOPT",
    [OsmIssueType.MissingCoordinates]: "Missing Coordinates",
    [OsmIssueType.OrphanedElement]: "Orphaned Element",
    [OsmIssueType.MissingRouteRef]: "Missing Route Ref",
    [OsmIssueType.MissingName]: "Missing Name",
    [OsmIssueType.MissingStopPosition]: "Missing Stop Position",
    [OsmIssueType.MissingPlatform]: "Missing Platform",
    [OsmIssueType.NoGtfsMatch]: "No GTFS Match",
    [OsmIssueType.AmbiguousGtfsMatch]: "Ambiguous Match",
    [OsmIssueType.LowConfidenceMatch]: "Low Confidence",
    [OsmIssueType.UnmappedGtfsStop]: "Unmapped GTFS Stop",
    [OsmIssueType.GtfsParseSkipped]: "Parse Skipped",
    [OsmIssueType.GtfsLoadFailed]: "Load Failed",
    [OsmIssueType.GtfsRtFetchFailed]: "RT Fetch Failed",
};

const ISSUE_TYPE_VARIANTS: Partial<
    Record<OsmIssueType, "default" | "secondary" | "destructive" | "outline">
> = {
    [OsmIssueType.MissingIfopt]: "default",
    [OsmIssueType.MissingCoordinates]: "destructive",
    [OsmIssueType.OrphanedElement]: "secondary",
    [OsmIssueType.MissingRouteRef]: "outline",
    [OsmIssueType.MissingName]: "secondary",
    [OsmIssueType.MissingStopPosition]: "outline",
    [OsmIssueType.MissingPlatform]: "outline",
    [OsmIssueType.NoGtfsMatch]: "destructive",
    [OsmIssueType.AmbiguousGtfsMatch]: "secondary",
    [OsmIssueType.LowConfidenceMatch]: "outline",
    [OsmIssueType.UnmappedGtfsStop]: "secondary",
    [OsmIssueType.GtfsParseSkipped]: "outline",
    [OsmIssueType.GtfsLoadFailed]: "destructive",
    [OsmIssueType.GtfsRtFetchFailed]: "destructive",
};

const TRANSPORT_TYPE_LABELS: Record<TransportType, string> = {
    [TransportType.Tram]: "Tram",
    [TransportType.Bus]: "Bus",
    [TransportType.Train]: "Train",
    [TransportType.Subway]: "Subway",
    [TransportType.Ferry]: "Ferry",
    [TransportType.Unknown]: "Unknown",
};

const TRANSPORT_TYPE_ICONS: Record<TransportType, string> = {
    [TransportType.Tram]: "🚊",
    [TransportType.Bus]: "🚌",
    [TransportType.Train]: "🚆",
    [TransportType.Subway]: "🚇",
    [TransportType.Ferry]: "⛴️",
    [TransportType.Unknown]: "❓",
};

function ScoreBar({ score, label }: { score: number; label?: string }) {
    const percentage = Math.round(score * 100);
    const colorClass =
        score >= 0.7
            ? "bg-green-500"
            : score >= 0.5
              ? "bg-yellow-500"
              : "bg-red-500";

    return (
        <div className="flex items-center gap-2">
            {label && <span className="text-xs text-muted-foreground w-16">{label}</span>}
            <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                <div
                    className={`h-full ${colorClass} transition-all`}
                    style={{ width: `${percentage}%` }}
                />
            </div>
            <span className="text-xs font-mono w-10 text-right">{percentage}%</span>
        </div>
    );
}

function MatchCandidatesTable({
    candidates,
}: {
    candidates: MatchCandidate[];
}) {
    if (candidates.length === 0) {
        return (
            <p className="text-xs text-muted-foreground py-2">
                No candidates within matching distance
            </p>
        );
    }

    return (
        <div className="mt-2 space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
                Match Candidates ({candidates.length})
            </p>
            <div className="rounded border overflow-hidden">
                <table className="w-full text-xs">
                    <thead className="bg-muted">
                        <tr>
                            <th className="text-left p-2 font-medium">GTFS Stop</th>
                            <th className="text-right p-2 font-medium w-16">Dist</th>
                            <th className="text-right p-2 font-medium w-20">Name</th>
                            <th className="text-right p-2 font-medium w-20">Score</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y">
                        {candidates.map((candidate, idx) => (
                            <tr
                                key={candidate.gtfs_stop_id}
                                className={idx === 0 ? "bg-green-50 dark:bg-green-950/30" : ""}
                            >
                                <td className="p-2">
                                    <div className="font-medium truncate max-w-[150px]">
                                        {candidate.gtfs_stop_name || candidate.gtfs_stop_id}
                                    </div>
                                    <div className="text-muted-foreground font-mono">
                                        {candidate.gtfs_stop_id}
                                    </div>
                                </td>
                                <td className="p-2 text-right font-mono">
                                    {Math.round(candidate.distance_meters)}m
                                </td>
                                <td className="p-2">
                                    <ScoreBar score={candidate.name_similarity} />
                                </td>
                                <td className="p-2">
                                    <ScoreBar score={candidate.combined_score} />
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

interface IssueItemProps {
    issue: OsmIssue;
    showCandidates?: boolean;
}

function IssueItem({ issue, showCandidates = false }: IssueItemProps) {
    const [copied, setCopied] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);
    const ifoptTag = issue.suggested_ifopt
        ? `ref:IFOPT=${issue.suggested_ifopt}`
        : null;

    const handleCopyIfopt = async () => {
        if (ifoptTag) {
            await navigator.clipboard.writeText(ifoptTag);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    const candidates = (issue.match_candidates as MatchCandidate[]) || [];
    const hasCandidates = showCandidates && candidates.length > 0;

    return (
        <li className="p-3 hover:bg-muted/50 rounded-lg">
            <div className="flex items-center justify-between gap-2 mb-1">
                <div className="flex items-center gap-2 min-w-0">
                    <Badge variant={ISSUE_TYPE_VARIANTS[issue.issue_type] || "outline"}>
                        {ISSUE_TYPE_LABELS[issue.issue_type] || issue.issue_type}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                        {issue.element_type}
                    </span>
                    <span
                        className="text-xs"
                        title={TRANSPORT_TYPE_LABELS[issue.transport_type]}
                    >
                        {TRANSPORT_TYPE_ICONS[issue.transport_type]}
                    </span>
                </div>
                {issue.osm_url && (
                    <Button variant="link" size="sm" asChild className="shrink-0">
                        <a
                            href={issue.osm_url}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Edit
                        </a>
                    </Button>
                )}
            </div>
            <p className="text-sm font-medium truncate">
                {issue.name || issue.ref || `${issue.osm_type}/${issue.osm_id}`}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                {issue.description}
            </p>

            {/* Debug info */}
            {(issue.lat !== null || issue.ref) && (
                <div className="mt-1 text-xs text-muted-foreground font-mono">
                    {issue.ref && <span>IFOPT: {issue.ref}</span>}
                    {issue.lat !== null && issue.lon !== null && (
                        <span className="ml-2">
                            ({issue.lat.toFixed(5)}, {issue.lon.toFixed(5)})
                        </span>
                    )}
                </div>
            )}

            {ifoptTag && (
                <div className="mt-2 p-2 bg-green-50 dark:bg-green-950 rounded border border-green-200 dark:border-green-800">
                    <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                            <p className="text-xs text-green-800 dark:text-green-200 font-medium">
                                Suggested tag:
                            </p>
                            <p className="text-xs text-green-700 dark:text-green-300 font-mono truncate">
                                {ifoptTag}
                            </p>
                            {issue.suggested_ifopt_name && (
                                <p className="text-xs text-green-600 dark:text-green-400 truncate">
                                    {issue.suggested_ifopt_name}
                                </p>
                            )}
                            {issue.suggested_ifopt_distance !== null && (
                                <p className="text-xs text-green-500">
                                    {issue.suggested_ifopt_distance}m away
                                </p>
                            )}
                        </div>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleCopyIfopt}
                            className="shrink-0 text-green-700 dark:text-green-300 hover:text-green-900 dark:hover:text-green-100 hover:bg-green-100 dark:hover:bg-green-900"
                        >
                            {copied ? "Copied!" : "Copy"}
                        </Button>
                    </div>
                </div>
            )}

            {hasCandidates && (
                <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
                    <CollapsibleTrigger asChild>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="mt-2 w-full justify-between text-xs"
                        >
                            <span>
                                {candidates.length} candidate{candidates.length !== 1 ? "s" : ""}{" "}
                                - best score: {Math.round((candidates[0]?.combined_score || 0) * 100)}%
                            </span>
                            <ChevronDown
                                className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                            />
                        </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                        <MatchCandidatesTable candidates={candidates} />
                    </CollapsibleContent>
                </Collapsible>
            )}
        </li>
    );
}

function IssuesList({
    issues,
    showCandidates = false,
}: {
    issues: OsmIssue[];
    showCandidates?: boolean;
}) {
    if (issues.length === 0) {
        return (
            <p className="py-8 text-center text-muted-foreground">
                No issues in this category
            </p>
        );
    }

    return (
        <ul className="divide-y">
            {issues.map((issue, idx) => (
                <IssueItem
                    key={`${issue.osm_type}-${issue.osm_id}-${idx}`}
                    issue={issue}
                    showCandidates={showCandidates}
                />
            ))}
        </ul>
    );
}

export { type MappingLine, type MappingMapData, type MappingGtfsStop } from "./MappingManager";

interface OsmIssuesPanelProps {
    onMapDataChange?: (data: MappingMapData) => void;
    onFlyTo?: (lat: number, lon: number) => void;
    initialTab?: string;
    onTabChange?: (tab: string) => void;
    initialFilter?: string;
    onFilterChange?: (filter: string) => void;
}

export function OsmIssuesPanel({ onMapDataChange, onFlyTo, initialTab, onTabChange, initialFilter, onFilterChange }: OsmIssuesPanelProps) {
    const [issues, setIssues] = useState<OsmIssue[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<string>(initialTab || "osm");

    useEffect(() => {
        const fetchIssues = async () => {
            try {
                const response = await fetch(`${getConfig().apiUrl}/api/issues`);
                if (response.ok) {
                    const data: IssueListResponse = await response.json();
                    setIssues(data.issues);
                }
            } catch (error) {
                console.error("Failed to fetch issues:", error);
            } finally {
                setIsLoading(false);
            }
        };

        fetchIssues();
    }, []);

    const issuesByCategory = useMemo(() => {
        const osm: OsmIssue[] = [];
        const gtfs: OsmIssue[] = [];
        const system: OsmIssue[] = [];

        for (const issue of issues) {
            switch (issue.category) {
                case IssueCategory.OsmDataQuality:
                    osm.push(issue);
                    break;
                case IssueCategory.GtfsMapping:
                    gtfs.push(issue);
                    break;
                case IssueCategory.DataProcessing:
                    system.push(issue);
                    break;
            }
        }

        return { osm, gtfs, system };
    }, [issues]);

    return (
        <div className="h-full flex flex-col">
            <div className="p-4 border-b">
                <h2 className="font-semibold">Data Issues ({issues.length})</h2>
            </div>

            {isLoading ? (
                <div className="flex items-center justify-center py-8 flex-1">
                    <p className="text-muted-foreground">Loading issues...</p>
                </div>
            ) : (
                <Tabs
                    value={activeTab}
                    onValueChange={(v) => { setActiveTab(v); onTabChange?.(v); }}
                    className="flex-1 flex flex-col"
                >
                    <TabsList className="mx-4 mt-2 grid grid-cols-4">
                        <TabsTrigger value="osm" className="text-xs">
                            OSM ({issuesByCategory.osm.length})
                        </TabsTrigger>
                        <TabsTrigger value="gtfs" className="text-xs">
                            GTFS ({issuesByCategory.gtfs.length})
                        </TabsTrigger>
                        <TabsTrigger value="mapping" className="text-xs">
                            Mapping
                        </TabsTrigger>
                        <TabsTrigger value="system" className="text-xs">
                            System ({issuesByCategory.system.length})
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="osm" className="flex-1 overflow-y-auto px-2 mt-0">
                        <IssuesList issues={issuesByCategory.osm} />
                    </TabsContent>

                    <TabsContent value="gtfs" className="flex-1 overflow-y-auto px-2 mt-0">
                        <IssuesList issues={issuesByCategory.gtfs} showCandidates />
                    </TabsContent>

                    <TabsContent value="mapping" className="flex-1 overflow-hidden mt-0">
                        <MappingManager
                            onMapDataChange={onMapDataChange ?? (() => {})}
                            onFlyTo={onFlyTo}
                            initialFilter={initialFilter}
                            onFilterChange={onFilterChange}
                        />
                    </TabsContent>

                    <TabsContent value="system" className="flex-1 overflow-y-auto px-2 mt-0">
                        <IssuesList issues={issuesByCategory.system} />
                    </TabsContent>
                </Tabs>
            )}

            {activeTab !== "mapping" && (
                <div className="p-3 border-t text-xs text-muted-foreground">
                    {activeTab === "osm" || activeTab === "gtfs"
                        ? 'Click "Edit" to fix issues in OpenStreetMap'
                        : `${issues.length} total issues across all categories`}
                </div>
            )}
        </div>
    );
}
