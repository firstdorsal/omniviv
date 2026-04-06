/* eslint-disable */
/* tslint:disable */
// @ts-nocheck
/*
 * ---------------------------------------------------------------
 * ## THIS FILE WAS GENERATED VIA SWAGGER-TYPESCRIPT-API        ##
 * ##                                                           ##
 * ## AUTHOR: acacode                                           ##
 * ## SOURCE: https://github.com/acacode/swagger-typescript-api ##
 * ---------------------------------------------------------------
 */

/** Transport type for both configuration and runtime detection */
export enum TransportType {
  Tram = "tram",
  Bus = "bus",
  Subway = "subway",
  Train = "train",
  Ferry = "ferry",
  Unknown = "unknown",
}

/** Types of OSM data quality issues */
export enum OsmIssueType {
  MissingIfopt = "missing_ifopt",
  MissingCoordinates = "missing_coordinates",
  OrphanedElement = "orphaned_element",
  MissingRouteRef = "missing_route_ref",
  MissingName = "missing_name",
  MissingStopPosition = "missing_stop_position",
  MissingPlatform = "missing_platform",
  MissingRef = "missing_ref",
  NoGtfsMatch = "no_gtfs_match",
  AmbiguousGtfsMatch = "ambiguous_gtfs_match",
  LowConfidenceMatch = "low_confidence_match",
  UnmappedGtfsStop = "unmapped_gtfs_stop",
  GtfsParseSkipped = "gtfs_parse_skipped",
  GtfsLoadFailed = "gtfs_load_failed",
  GtfsRtFetchFailed = "gtfs_rt_fetch_failed",
}

export enum MappingStatus {
  Unmapped = "unmapped",
  Auto = "auto",
  Manual = "manual",
}

export enum MappingFilter {
  Manual = "manual",
  Auto = "auto",
}

/** Category of issue for UI organization */
export enum IssueCategory {
  OsmDataQuality = "osm_data_quality",
  GtfsMapping = "gtfs_mapping",
  DataProcessing = "data_processing",
}

/** Type of stop event */
export enum EventType {
  Departure = "departure",
  Arrival = "arrival",
}

export interface Area {
  /** @format date-time */
  created_at: string;
  /** @format double */
  east: number;
  /** @format int64 */
  id: number;
  /** @format date-time */
  last_synced_at?: string | null;
  name: string;
  /** @format double */
  north: number;
  /** @format double */
  south: number;
  /** @format double */
  west: number;
}

export interface AreaListResponse {
  areas: Area[];
}

export interface AreaStats {
  /** @format int64 */
  area_id: number;
  area_name: string;
  /** @format int64 */
  platform_count: number;
  /** @format int64 */
  route_count: number;
  /** @format int64 */
  station_count: number;
  /** @format int64 */
  stop_position_count: number;
}

export interface CandidateStop {
  /**
   * Approximate distance in meters from the OSM stop
   * @format double
   */
  distance_meters: number;
  /**
   * Latitude
   * @format double
   */
  lat: number;
  /**
   * Longitude
   * @format double
   */
  lon: number;
  /** GTFS stop ID */
  stop_id: string;
  /** GTFS stop name */
  stop_name?: string | null;
}

export interface CoordinateDeparturesRequest {
  /** @format double */
  lat: number;
  /** @format double */
  lon: number;
  reference_time?: string | null;
}

/** A stop event (departure or arrival) */
export interface Departure {
  /**
   * Whether this trip has been cancelled (GTFS-RT schedule_relationship = CANCELED).
   * Cancelled trips should be shown with strikethrough in departure monitors
   * but NOT as active vehicles on the map.
   */
  cancelled?: boolean;
  /** Route color from GTFS or OSM (hex, e.g. "#ee1d23") */
  color?: string | null;
  /** @format int32 */
  delay_minutes?: number | null;
  /** For departures: destination; for arrivals: origin */
  destination: string;
  /** Destination stop ID (for departures) or origin stop ID (for arrivals) */
  destination_id?: string | null;
  estimated_time?: string | null;
  /** Type of stop event */
  event_type: EventType;
  /**
   * GTFS route_type: 0=tram, 1=subway, 2=rail, 3=bus, 4=ferry, etc.
   * @format int32
   */
  gtfs_route_type?: number | null;
  /** Whether this is the first stop of the trip */
  is_first_stop: boolean;
  /** Whether this is the last stop of the trip */
  is_last_stop: boolean;
  line_number: string;
  /** Operator/agency name (e.g. "DB Regio AG Bayern", "Go-Ahead") */
  operator?: string | null;
  planned_time: string;
  platform?: string | null;
  stop_ifopt: string;
  /** Unique trip identifier (GTFS trip_id) - consistent across all stops for a journey */
  trip_id?: string | null;
}

export interface ErrorResponse {
  error: string;
}

export interface GtfsStopDeparturesRequest {
  gtfs_stop_id: string;
  /** Optional reference time (ISO 8601/RFC 3339) for time simulation. */
  reference_time?: string | null;
}

export interface GtfsStopDeparturesResponse {
  departures: Departure[];
  gtfs_stop_id: string;
}

export interface GtfsStopResponse {
  /** @format double */
  lat: number;
  /** @format double */
  lon: number;
  parent_station?: string | null;
  stop_id: string;
  stop_name?: string | null;
}

export interface GtfsStopsListResponse {
  /** Whether there are more results after this page */
  has_more: boolean;
  /**
   * Maximum number of results returned
   * @min 0
   */
  limit: number;
  /**
   * Current offset in the result set
   * @min 0
   */
  offset: number;
  stops: GtfsStopResponse[];
  /**
   * Total number of stops matching the filter criteria
   * @min 0
   */
  total_count: number;
}

export interface HealthResponse {
  /**
   * Number of GTFS routes in the database
   * @format int64
   */
  gtfs_route_count: number;
  /** Whether the static GTFS schedule has been loaded into PostgreSQL */
  gtfs_schedule_loaded: boolean;
  /**
   * Number of GTFS stops in the database
   * @format int64
   */
  gtfs_stop_count: number;
  /**
   * Number of GTFS trips in the database
   * @format int64
   */
  gtfs_trip_count: number;
  /** Whether the service is running */
  healthy: boolean;
  /**
   * Number of IFOPT-to-GTFS stop mappings
   * @format int64
   */
  ifopt_mapping_count: number;
}

export interface IssueListResponse {
  /** @min 0 */
  count: number;
  issues: OsmIssue[];
}

export interface MappingEntry {
  /** Nearby GTFS candidate stops (only if include_candidates is true) */
  candidates: CandidateStop[];
  /** Current mapped GTFS stop ID (if mapped) */
  gtfs_stop_id?: string | null;
  /**
   * Latitude of the mapped GTFS stop (if mapped)
   * @format double
   */
  gtfs_stop_lat?: number | null;
  /**
   * Longitude of the mapped GTFS stop (if mapped)
   * @format double
   */
  gtfs_stop_lon?: number | null;
  /** Current mapped GTFS stop name (if mapped) */
  gtfs_stop_name?: string | null;
  /** IFOPT identifier (if available) */
  ifopt?: string | null;
  /**
   * Latitude of the OSM stop
   * @format double
   */
  lat: number;
  /**
   * Longitude of the OSM stop
   * @format double
   */
  lon: number;
  /** Match method used (ifopt, geographic, manual) */
  match_method?: string | null;
  /**
   * Matching score (if auto-mapped)
   * @format double
   */
  match_score?: number | null;
  /** Name of the OSM stop (from platforms or stop_positions) */
  name?: string | null;
  /**
   * OSM ID of the stop
   * @format int64
   */
  osm_id: number;
  /** OSM type (platform or stop_position) */
  osm_type: string;
  /** Current mapping status */
  status: MappingStatus;
}

export interface MappingStatusRequest {
  /** Filter by manual-only or auto-only mappings */
  filter?: null | MappingFilter;
  /** Include nearby GTFS candidate stops for each entry */
  include_candidates?: boolean;
  /**
   * Maximum number of entries to return (default: 50, max: 200)
   * @min 0
   */
  limit?: number;
  /**
   * Offset for pagination
   * @min 0
   */
  offset?: number;
  /** Case-insensitive search on IFOPT, name, or OSM ID */
  search?: string | null;
  /** Only return unmapped OSM stops (those without a mapping in osm_gtfs_stop_mapping) */
  unmapped_only?: boolean;
}

export interface MappingStatusResponse {
  /**
   * Number of auto-generated mappings
   * @min 0
   */
  auto_count: number;
  /** Paginated list of mapping entries */
  entries: MappingEntry[];
  /** Whether there are more entries after this page */
  has_more: boolean;
  /**
   * Number of manually set mappings
   * @min 0
   */
  manual_count: number;
  /**
   * Number of OSM stops that have a mapping (manual or auto) in osm_gtfs_stop_mapping
   * @min 0
   */
  mapped_count: number;
  /**
   * Total number of OSM stops with IFOPT identifiers (subset of total)
   * @min 0
   */
  total_ifopt_count: number;
  /**
   * Total number of OSM stops (platforms + stop_positions)
   * @min 0
   */
  total_osm_stop_count: number;
  /**
   * Number of OSM stops without any mapping
   * @min 0
   */
  unmapped_count: number;
}

/** A candidate GTFS stop match with route-based matching details */
export interface MatchCandidate {
  /**
   * Distance in meters from OSM stop
   * @format double
   */
  distance_meters: number;
  /** GTFS stop ID */
  gtfs_stop_id: string;
  /** GTFS stop name */
  gtfs_stop_name?: string | null;
  /** Whether this candidate shares at least one route with the OSM stop */
  is_definitive: boolean;
  /** Human-readable shared route names (e.g. "Tram 1", "Bus 5") */
  shared_routes: string[];
}

export interface OsmIdDeparturesRequest {
  /** @format int64 */
  osm_id: number;
  reference_time?: string | null;
}

/** An OSM data quality issue detected during sync */
export interface OsmIssue {
  /**
   * Record count affected (for bulk issues like parse errors)
   * @format int32
   * @min 0
   */
  affected_count?: number | null;
  /** Category for UI organization (derived from issue_type) */
  category: IssueCategory;
  description: string;
  detected_at: string;
  element_type: string;
  /** Error message from underlying operation */
  error_message?: string | null;
  /** GTFS stop ID (for GTFS mapping issues) */
  gtfs_stop_id?: string | null;
  /** GTFS stop name (for GTFS mapping issues) */
  gtfs_stop_name?: string | null;
  /** Types of OSM data quality issues */
  issue_type: OsmIssueType;
  /** @format double */
  lat?: number | null;
  /** @format double */
  lon?: number | null;
  /** Candidate matches with scoring details (for GTFS mapping issues) */
  match_candidates?: any[] | null;
  name?: string | null;
  /** @format int64 */
  osm_id: number;
  osm_type: string;
  osm_url: string;
  /** The ref tag value (e.g., platform letter "a", "b") */
  ref?: string | null;
  /** Source file (for parse errors) */
  source_file?: string | null;
  /** Suggested IFOPT (for missing_ifopt issues) */
  suggested_ifopt?: string | null;
  /**
   * Distance in meters to the suggested stop
   * @format int32
   * @min 0
   */
  suggested_ifopt_distance?: number | null;
  /** Name of the stop that was matched */
  suggested_ifopt_name?: string | null;
  /** Transport type for both configuration and runtime detection */
  transport_type: TransportType;
}

export interface RemoveMappingRequest {
  /** The IFOPT identifier to remove the manual mapping for (backwards compatibility) */
  ifopt?: string | null;
  /**
   * The OSM ID to remove the manual mapping for (primary identifier)
   * @format int64
   */
  osm_id?: number | null;
}

export interface RemoveMappingResponse {
  /**
   * @format int64
   * @min 0
   */
  removed_count: number;
}

export interface Route {
  color?: string | null;
  name?: string | null;
  network?: string | null;
  operator?: string | null;
  /** @format int64 */
  osm_id: number;
  osm_type: string;
  ref?: string | null;
  route_type: string;
}

export interface RouteColorEntry {
  color?: string | null;
  network?: string | null;
  operator?: string | null;
  ref?: string | null;
  route_type: string;
}

export interface RouteColorsResponse {
  entries: RouteColorEntry[];
}

export type RouteDetail = Route & {
  stops: RouteStop[];
};

export interface RouteGeometry {
  /** @format int64 */
  route_id: number;
  segments: number[][][];
}

export interface RouteListResponse {
  routes: Route[];
}

/** Request body for POST /api/routes/search */
export interface RouteSearchRequest {
  /**
   * City filter — substring match against name, operator, and network
   * (e.g., "augsburg" matches AVV/Augsburger Verkehrsgesellschaft routes).
   */
  city?: string | null;
  /**
   * When true, deduplicate variants of the same line by (ref, route_type, operator).
   * One representative route per group is returned. Default: true.
   */
  deduplicate?: boolean | null;
  /**
   * Maximum number of results to return (default 100, max 500)
   * @format int64
   */
  limit?: number | null;
  /** Search routes whose name contains this text (e.g., "München") */
  name_contains?: string | null;
  /**
   * Filter to routes near this latitude (searches within ~30km)
   * @format double
   */
  near_lat?: number | null;
  /**
   * Filter to routes near this longitude (searches within ~30km)
   * @format double
   */
  near_lon?: number | null;
  /** Filter by operator (substring match) */
  operator?: string | null;
  /**
   * Free-text query that matches against route ref OR name (case-insensitive substring).
   * When set, all routes where ref starts with the query OR name contains it are returned.
   */
  query?: string | null;
  /** Filter by route ref (e.g., "RE 9", "506"). Spaces are ignored for matching. */
  ref?: string | null;
  /** Filter by route type (e.g., "tram", "bus") */
  route_type?: string | null;
}

export interface RouteStop {
  /** @format int64 */
  platform_id?: number | null;
  role?: string | null;
  /** @format int32 */
  sequence: number;
  /** @format int64 */
  station_id?: number | null;
  station_name?: string | null;
  /** @format int64 */
  stop_position_id?: number | null;
}

export interface SetMappingRequest {
  /** The GTFS stop ID to map to */
  gtfs_stop_id: string;
  /** The IFOPT identifier of the OSM stop (for backwards compatibility) */
  ifopt?: string | null;
  /**
   * The OSM ID of the stop (primary identifier for the new mapping system)
   * @format int64
   */
  osm_id?: number | null;
}

export interface SetMappingResponse {
  message: string;
  success: boolean;
}

export interface Station {
  /** @format double */
  lat: number;
  /** @format double */
  lon: number;
  /**
   * Minimum zoom level at which this station should be shown
   * @format int32
   */
  min_zoom: number;
  name?: string | null;
  /** @format int64 */
  osm_id: number;
  osm_type: string;
  platform_ways: StationPlatformWay[];
  platforms: StationPlatform[];
  ref_ifopt?: string | null;
  stop_positions: StationStopPosition[];
  /** Transport modes serving this station (e.g. ["tram", "bus"]) */
  transport_modes?: string[];
}

/** Platform info nested in station response */
export interface StationPlatform {
  /** GTFS stop IDs matched to this platform via spatial matching */
  gtfs_stop_ids: string[];
  /** @format double */
  lat: number;
  /** @format double */
  lon: number;
  name?: string | null;
  /** @format int64 */
  osm_id: number;
  ref?: string | null;
  ref_ifopt?: string | null;
}

/** Platform way info (physical platform outline centroid) nested in station response */
export interface StationPlatformWay {
  /** @format double */
  lat: number;
  /** @format double */
  lon: number;
  name?: string | null;
  /** @format int64 */
  osm_id: number;
  ref?: string | null;
  ref_ifopt?: string | null;
}

/** Stop position info nested in station response */
export interface StationStopPosition {
  /** GTFS stop IDs matched to this stop position via spatial matching */
  gtfs_stop_ids: string[];
  /** @format double */
  lat: number;
  /** @format double */
  lon: number;
  name?: string | null;
  /** @format int64 */
  osm_id: number;
  /** @format int64 */
  platform_id?: number | null;
  ref?: string | null;
  ref_ifopt?: string | null;
}

export interface StopDeparturesRequest {
  /**
   * Optional reference time (ISO 8601/RFC 3339) for time simulation.
   * When provided, departures are computed from the static GTFS schedule
   * around this time instead of using live real-time data.
   */
  reference_time?: string | null;
  stop_ifopt: string;
}

export interface StopDeparturesResponse {
  departures: Departure[];
  /** The GTFS stop ID mapped to this IFOPT (if any) */
  mapped_gtfs_stop_id?: string | null;
  stop_ifopt: string;
}

export interface Vehicle {
  /** Route color from GTFS (hex, e.g. "#ee1d23") */
  color?: string | null;
  /** Final destination of this vehicle */
  destination: string;
  /**
   * GTFS route_type: 0=tram, 1=subway, 2=rail, 3=bus, 4=ferry, etc.
   * @format int32
   */
  gtfs_route_type?: number | null;
  /** Line number (e.g., "1", "2", "3") */
  line_number: string;
  /**
   * The trip_id of the next trip this physical vehicle will operate.
   * Set when the vehicle loops back (e.g., tram reaching end of line
   * and starting the return trip). Used for seamless follow-mode
   * transitions and vehicle reuse rendering.
   */
  next_trip_id?: string | null;
  /** Operator/agency name (e.g. "DB Regio AG Bayern", "Go-Ahead") */
  operator?: string | null;
  /** Origin of this vehicle's journey */
  origin?: string | null;
  /** All stops this vehicle will visit, in order */
  stops: VehicleStop[];
  /** Unique trip identifier (GTFS trip_id) */
  trip_id: string;
}

export interface VehicleStop {
  /** Arrival time at this stop */
  arrival_time?: string | null;
  /** Estimated arrival time (real-time, if available) */
  arrival_time_estimated?: string | null;
  /**
   * Delay in minutes (positive = late, negative = early)
   * @format int32
   */
  delay_minutes?: number | null;
  /** Departure time from this stop */
  departure_time?: string | null;
  /** Estimated departure time (real-time, if available) */
  departure_time_estimated?: string | null;
  /**
   * Latitude
   * @format double
   */
  lat: number;
  /**
   * Longitude
   * @format double
   */
  lon: number;
  /**
   * Sequence number on the route
   * @format int32
   */
  sequence: number;
  /** Stop IFOPT identifier */
  stop_ifopt: string;
  /** Stop name (if available) */
  stop_name?: string | null;
}

export interface VehiclesByRouteRequest {
  /**
   * Optional reference time (ISO 8601/RFC 3339) for time simulation.
   * When provided, departures are computed from the static GTFS schedule.
   */
  reference_time?: string | null;
  /**
   * The OSM route ID to get vehicles for
   * @format int64
   */
  route_id: number;
}

export interface VehiclesByRouteResponse {
  line_number?: string | null;
  /** @format int64 */
  route_id: number;
  vehicles: Vehicle[];
}

export interface VisibleRoute {
  color?: string | null;
  /** @format int32 */
  min_zoom: number;
  name?: string | null;
  /** @format int64 */
  osm_id: number;
  ref?: string | null;
  route_type: string;
  segments: number[][][];
}

export interface VisibleRoutesRequest {
  /** Bounding box: [west, south, east, north] in WGS84 */
  bbox: number[];
  /**
   * Current zoom level — only routes with min_zoom <= zoom are returned
   * @format int32
   */
  zoom: number;
}

export interface VisibleRoutesResponse {
  routes: VisibleRoute[];
}

export type QueryParamsType = Record<string | number, any>;
export type ResponseFormat = keyof Omit<Body, "body" | "bodyUsed">;

export interface FullRequestParams extends Omit<RequestInit, "body"> {
  /** set parameter to `true` for call `securityWorker` for this request */
  secure?: boolean;
  /** request path */
  path: string;
  /** content type of request body */
  type?: ContentType;
  /** query params */
  query?: QueryParamsType;
  /** format of response (i.e. response.json() -> format: "json") */
  format?: ResponseFormat;
  /** request body */
  body?: unknown;
  /** base url */
  baseUrl?: string;
  /** request cancellation token */
  cancelToken?: CancelToken;
}

export type RequestParams = Omit<
  FullRequestParams,
  "body" | "method" | "query" | "path"
>;

export interface ApiConfig<SecurityDataType = unknown> {
  baseUrl?: string;
  baseApiParams?: Omit<RequestParams, "baseUrl" | "cancelToken" | "signal">;
  securityWorker?: (
    securityData: SecurityDataType | null,
  ) => Promise<RequestParams | void> | RequestParams | void;
  customFetch?: typeof fetch;
}

export interface HttpResponse<D extends unknown, E extends unknown = unknown>
  extends Response {
  data: D;
  error: E;
}

type CancelToken = Symbol | string | number;

export enum ContentType {
  Json = "application/json",
  JsonApi = "application/vnd.api+json",
  FormData = "multipart/form-data",
  UrlEncoded = "application/x-www-form-urlencoded",
  Text = "text/plain",
}

export class HttpClient<SecurityDataType = unknown> {
  public baseUrl: string = "";
  private securityData: SecurityDataType | null = null;
  private securityWorker?: ApiConfig<SecurityDataType>["securityWorker"];
  private abortControllers = new Map<CancelToken, AbortController>();
  private customFetch = (...fetchParams: Parameters<typeof fetch>) =>
    fetch(...fetchParams);

  private baseApiParams: RequestParams = {
    credentials: "same-origin",
    headers: {},
    redirect: "follow",
    referrerPolicy: "no-referrer",
  };

  constructor(apiConfig: ApiConfig<SecurityDataType> = {}) {
    Object.assign(this, apiConfig);
  }

  public setSecurityData = (data: SecurityDataType | null) => {
    this.securityData = data;
  };

  protected encodeQueryParam(key: string, value: any) {
    const encodedKey = encodeURIComponent(key);
    return `${encodedKey}=${encodeURIComponent(typeof value === "number" ? value : `${value}`)}`;
  }

  protected addQueryParam(query: QueryParamsType, key: string) {
    return this.encodeQueryParam(key, query[key]);
  }

  protected addArrayQueryParam(query: QueryParamsType, key: string) {
    const value = query[key];
    return value.map((v: any) => this.encodeQueryParam(key, v)).join("&");
  }

  protected toQueryString(rawQuery?: QueryParamsType): string {
    const query = rawQuery || {};
    const keys = Object.keys(query).filter(
      (key) => "undefined" !== typeof query[key],
    );
    return keys
      .map((key) =>
        Array.isArray(query[key])
          ? this.addArrayQueryParam(query, key)
          : this.addQueryParam(query, key),
      )
      .join("&");
  }

  protected addQueryParams(rawQuery?: QueryParamsType): string {
    const queryString = this.toQueryString(rawQuery);
    return queryString ? `?${queryString}` : "";
  }

  private contentFormatters: Record<ContentType, (input: any) => any> = {
    [ContentType.Json]: (input: any) =>
      input !== null && (typeof input === "object" || typeof input === "string")
        ? JSON.stringify(input)
        : input,
    [ContentType.JsonApi]: (input: any) =>
      input !== null && (typeof input === "object" || typeof input === "string")
        ? JSON.stringify(input)
        : input,
    [ContentType.Text]: (input: any) =>
      input !== null && typeof input !== "string"
        ? JSON.stringify(input)
        : input,
    [ContentType.FormData]: (input: any) => {
      if (input instanceof FormData) {
        return input;
      }

      return Object.keys(input || {}).reduce((formData, key) => {
        const property = input[key];
        formData.append(
          key,
          property instanceof Blob
            ? property
            : typeof property === "object" && property !== null
              ? JSON.stringify(property)
              : `${property}`,
        );
        return formData;
      }, new FormData());
    },
    [ContentType.UrlEncoded]: (input: any) => this.toQueryString(input),
  };

  protected mergeRequestParams(
    params1: RequestParams,
    params2?: RequestParams,
  ): RequestParams {
    return {
      ...this.baseApiParams,
      ...params1,
      ...(params2 || {}),
      headers: {
        ...(this.baseApiParams.headers || {}),
        ...(params1.headers || {}),
        ...((params2 && params2.headers) || {}),
      },
    };
  }

  protected createAbortSignal = (
    cancelToken: CancelToken,
  ): AbortSignal | undefined => {
    if (this.abortControllers.has(cancelToken)) {
      const abortController = this.abortControllers.get(cancelToken);
      if (abortController) {
        return abortController.signal;
      }
      return void 0;
    }

    const abortController = new AbortController();
    this.abortControllers.set(cancelToken, abortController);
    return abortController.signal;
  };

  public abortRequest = (cancelToken: CancelToken) => {
    const abortController = this.abortControllers.get(cancelToken);

    if (abortController) {
      abortController.abort();
      this.abortControllers.delete(cancelToken);
    }
  };

  public request = async <T = any, E = any>({
    body,
    secure,
    path,
    type,
    query,
    format,
    baseUrl,
    cancelToken,
    ...params
  }: FullRequestParams): Promise<HttpResponse<T, E>> => {
    const secureParams =
      ((typeof secure === "boolean" ? secure : this.baseApiParams.secure) &&
        this.securityWorker &&
        (await this.securityWorker(this.securityData))) ||
      {};
    const requestParams = this.mergeRequestParams(params, secureParams);
    const queryString = query && this.toQueryString(query);
    const payloadFormatter = this.contentFormatters[type || ContentType.Json];
    const responseFormat = format || requestParams.format;

    return this.customFetch(
      `${baseUrl || this.baseUrl || ""}${path}${queryString ? `?${queryString}` : ""}`,
      {
        ...requestParams,
        headers: {
          ...(requestParams.headers || {}),
          ...(type && type !== ContentType.FormData
            ? { "Content-Type": type }
            : {}),
        },
        signal:
          (cancelToken
            ? this.createAbortSignal(cancelToken)
            : requestParams.signal) || null,
        body:
          typeof body === "undefined" || body === null
            ? null
            : payloadFormatter(body),
      },
    ).then(async (response) => {
      const r = response as HttpResponse<T, E>;
      r.data = null as unknown as T;
      r.error = null as unknown as E;

      const responseToParse = responseFormat ? response.clone() : response;
      const data = !responseFormat
        ? r
        : await responseToParse[responseFormat]()
            .then((data) => {
              if (r.ok) {
                r.data = data;
              } else {
                r.error = data;
              }
              return r;
            })
            .catch((e) => {
              r.error = e;
              return r;
            });

      if (cancelToken) {
        this.abortControllers.delete(cancelToken);
      }

      if (!response.ok) throw data;
      return data;
    });
  };
}

/**
 * @title Omniviv API
 * @version 0.2.0
 * @license
 */
export class Api<
  SecurityDataType extends unknown,
> extends HttpClient<SecurityDataType> {
  api = {
    /**
     * No description
     *
     * @tags areas
     * @name ListAreas
     * @summary List all configured areas
     * @request GET:/api/areas
     */
    listAreas: (params: RequestParams = {}) =>
      this.request<AreaListResponse, ErrorResponse>({
        path: `/api/areas`,
        method: "GET",
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags areas
     * @name GetArea
     * @summary Get a specific area by ID
     * @request GET:/api/areas/{id}
     */
    getArea: (id: number, params: RequestParams = {}) =>
      this.request<Area, ErrorResponse>({
        path: `/api/areas/${id}`,
        method: "GET",
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags areas
     * @name GetAreaStats
     * @summary Get statistics for an area
     * @request GET:/api/areas/{id}/stats
     */
    getAreaStats: (id: number, params: RequestParams = {}) =>
      this.request<AreaStats, ErrorResponse>({
        path: `/api/areas/${id}/stats`,
        method: "GET",
        format: "json",
        ...params,
      }),

    /**
 * No description
 *
 * @tags departures
 * @name GetDeparturesByCoordinates
 * @summary Find the nearest GTFS stop by coordinates and return its departures.
Used for stops without ref:IFOPT in OSM (e.g. München U-Bahn).
 * @request POST:/api/departures/by-coordinates
 */
    getDeparturesByCoordinates: (
      data: CoordinateDeparturesRequest,
      params: RequestParams = {},
    ) =>
      this.request<GtfsStopDeparturesResponse, any>({
        path: `/api/departures/by-coordinates`,
        method: "POST",
        body: data,
        type: ContentType.Json,
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags departures
     * @name GetDeparturesByGtfsStop
     * @summary Get departures for a specific GTFS stop by its stop_id, bypassing IFOPT mapping
     * @request POST:/api/departures/by-gtfs-stop
     */
    getDeparturesByGtfsStop: (
      data: GtfsStopDeparturesRequest,
      params: RequestParams = {},
    ) =>
      this.request<GtfsStopDeparturesResponse, ErrorResponse>({
        path: `/api/departures/by-gtfs-stop`,
        method: "POST",
        body: data,
        type: ContentType.Json,
        format: "json",
        ...params,
      }),

    /**
     * @description Primary path: query `osm_gtfs_stop_mapping` directly for the GTFS stop ID. This is the most efficient path and works for all mapped stops regardless of whether they have IFOPT tags. Fallback: if no mapping exists, look up coordinates from the OSM element and use coordinate-based GTFS stop lookup.
     *
     * @tags departures
     * @name GetDeparturesByOsmId
     * @summary Find departures for an OSM stop position/platform by its osm_id.
     * @request POST:/api/departures/by-osm-id
     */
    getDeparturesByOsmId: (
      data: OsmIdDeparturesRequest,
      params: RequestParams = {},
    ) =>
      this.request<GtfsStopDeparturesResponse, any>({
        path: `/api/departures/by-osm-id`,
        method: "POST",
        body: data,
        type: ContentType.Json,
        format: "json",
        ...params,
      }),

    /**
     * @description Accepts both IFOPT strings (e.g. "de:09761:101:31:A3") and OSM-based identifiers (e.g. "osm:12345678") in the `stop_ifopt` field. For OSM IDs, queries `osm_gtfs_stop_mapping` by `osm_id`. For IFOPT strings, queries `osm_gtfs_stop_mapping` by `ref_ifopt`, falling back to the legacy `ifopt_gtfs_mapping` table.
     *
     * @tags departures
     * @name GetDeparturesByStop
     * @summary Get departures for a specific stop by IFOPT ID or OSM stop ID.
     * @request POST:/api/departures/by-stop
     */
    getDeparturesByStop: (
      data: StopDeparturesRequest,
      params: RequestParams = {},
    ) =>
      this.request<StopDeparturesResponse, ErrorResponse>({
        path: `/api/departures/by-stop`,
        method: "POST",
        body: data,
        type: ContentType.Json,
        format: "json",
        ...params,
      }),

    /**
     * @description Returns GTFS stops with coordinates. By default, only returns leaf stops (stops that have actual departures). Use the bounding box parameters to filter by geographic area.
     *
     * @tags gtfs-stops
     * @name ListGtfsStops
     * @summary List GTFS stops
     * @request GET:/api/gtfs-stops
     */
    listGtfsStops: (
      query?: {
        /** Comma-separated list of stop IDs to fetch */
        stop_ids?: string | null;
        /** Case-insensitive substring search on stop name */
        search?: string | null;
        /**
         * Minimum latitude for bounding box filter
         * @format double
         */
        min_lat?: number | null;
        /**
         * Maximum latitude for bounding box filter
         * @format double
         */
        max_lat?: number | null;
        /**
         * Minimum longitude for bounding box filter
         * @format double
         */
        min_lon?: number | null;
        /**
         * Maximum longitude for bounding box filter
         * @format double
         */
        max_lon?: number | null;
        /** Filter by parent station ID */
        parent_station?: string | null;
        /** Only return leaf stops (stops that have trips visiting them) */
        leaf_only?: boolean;
        /**
         * Offset for pagination (default: 0)
         * @min 0
         */
        offset?: number;
        /**
         * Maximum number of results to return (default: 100, max: 1000)
         * @min 0
         */
        limit?: number;
      },
      params: RequestParams = {},
    ) =>
      this.request<GtfsStopsListResponse, any>({
        path: `/api/gtfs-stops`,
        method: "GET",
        query: query,
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags health
     * @name HealthCheck
     * @summary Health check endpoint
     * @request GET:/api/health
     */
    healthCheck: (params: RequestParams = {}) =>
      this.request<HealthResponse, any>({
        path: `/api/health`,
        method: "GET",
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags issues
     * @name ListIssues
     * @summary List all OSM data quality issues
     * @request GET:/api/issues
     */
    listIssues: (params: RequestParams = {}) =>
      this.request<IssueListResponse, any>({
        path: `/api/issues`,
        method: "GET",
        format: "json",
        ...params,
      }),

    /**
     * @description Only removes manual (user-curated) mappings. The stop will be re-matched automatically on the next auto-rebuild cycle. At least one of osm_id or ifopt must be provided. Removes from both osm_gtfs_stop_mapping and the legacy ifopt_gtfs_mapping table.
     *
     * @tags mapping
     * @name RemoveMapping
     * @summary Remove a manual OSM-to-GTFS stop mapping
     * @request POST:/api/mapping/remove
     */
    removeMapping: (data: RemoveMappingRequest, params: RequestParams = {}) =>
      this.request<RemoveMappingResponse, void>({
        path: `/api/mapping/remove`,
        method: "POST",
        body: data,
        type: ContentType.Json,
        format: "json",
        ...params,
      }),

    /**
     * @description Creates or replaces a mapping for the given OSM stop (by osm_id or IFOPT) with a user-curated GTFS stop assignment. Manual mappings are preserved across auto-rebuild cycles. At least one of osm_id or ifopt must be provided. Dual-writes to both osm_gtfs_stop_mapping and the legacy ifopt_gtfs_mapping table.
     *
     * @tags mapping
     * @name SetMapping
     * @summary Set a manual OSM-to-GTFS stop mapping
     * @request POST:/api/mapping/set
     */
    setMapping: (data: SetMappingRequest, params: RequestParams = {}) =>
      this.request<SetMappingResponse, void>({
        path: `/api/mapping/set`,
        method: "POST",
        body: data,
        type: ContentType.Json,
        format: "json",
        ...params,
      }),

    /**
     * @description Returns a summary of OSM-to-GTFS mapping statistics and a paginated list of mapping entries. Each entry includes the OSM stop info, current mapping status, and optionally nearby GTFS candidate stops. Queries from `osm_gtfs_stop_mapping` as the primary source.
     *
     * @tags mapping
     * @name MappingStatus
     * @summary Get mapping status overview with optional candidates
     * @request POST:/api/mapping/status
     */
    mappingStatus: (data: MappingStatusRequest, params: RequestParams = {}) =>
      this.request<MappingStatusResponse, void>({
        path: `/api/mapping/status`,
        method: "POST",
        body: data,
        type: ContentType.Json,
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags routes
     * @name ListRoutes
     * @summary List all routes, optionally filtered by type
     * @request GET:/api/routes
     */
    listRoutes: (
      query?: {
        /** Filter by route type (e.g., "tram", "bus") */
        route_type?: string | null;
        /** Filter by route ref (e.g., "RE 9", "506"). Spaces are ignored for matching. */
        ref?: string | null;
        /** Search routes whose name contains this text (e.g., "München") */
        name_contains?: string | null;
        /** Filter by operator (substring match, e.g., "Augsburger" matches "Augsburger Verkehrsgesellschaft") */
        operator?: string | null;
        /**
         * Filter to routes near this latitude (used with `near_lon`, searches within ~30km)
         * @format double
         */
        near_lat?: number | null;
        /**
         * Filter to routes near this longitude (used with `near_lat`, searches within ~30km)
         * @format double
         */
        near_lon?: number | null;
      },
      params: RequestParams = {},
    ) =>
      this.request<RouteListResponse, ErrorResponse>({
        path: `/api/routes`,
        method: "GET",
        query: query,
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags routes
     * @name GetRouteColors
     * @summary Get distinct route line colors and types (lightweight, for color lookups)
     * @request GET:/api/routes/colors
     */
    getRouteColors: (params: RequestParams = {}) =>
      this.request<RouteColorsResponse, any>({
        path: `/api/routes/colors`,
        method: "GET",
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags routes
     * @name SearchRoutes
     * @summary Search routes with filters (POST body)
     * @request POST:/api/routes/search
     */
    searchRoutes: (data: RouteSearchRequest, params: RequestParams = {}) =>
      this.request<RouteListResponse, ErrorResponse>({
        path: `/api/routes/search`,
        method: "POST",
        body: data,
        type: ContentType.Json,
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags routes
     * @name GetVisibleRoutes
     * @summary Get routes with geometry visible in the given viewport and zoom level
     * @request POST:/api/routes/visible
     */
    getVisibleRoutes: (
      data: VisibleRoutesRequest,
      params: RequestParams = {},
    ) =>
      this.request<VisibleRoutesResponse, ErrorResponse>({
        path: `/api/routes/visible`,
        method: "POST",
        body: data,
        type: ContentType.Json,
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags routes
     * @name GetRoute
     * @summary Get a single route with its stops
     * @request GET:/api/routes/{route_id}
     */
    getRoute: (routeId: number, params: RequestParams = {}) =>
      this.request<RouteDetail, ErrorResponse>({
        path: `/api/routes/${routeId}`,
        method: "GET",
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags routes
     * @name GetRouteGeometry
     * @summary Get the geometry of a route as line segments
     * @request GET:/api/routes/{route_id}/geometry
     */
    getRouteGeometry: (routeId: number, params: RequestParams = {}) =>
      this.request<RouteGeometry, ErrorResponse>({
        path: `/api/routes/${routeId}/geometry`,
        method: "GET",
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags stations
     * @name GetStation
     * @summary Get a single station by its OSM ID
     * @request GET:/api/stations/{osm_id}
     */
    getStation: (osmId: number, params: RequestParams = {}) =>
      this.request<Station, ErrorResponse>({
        path: `/api/stations/${osmId}`,
        method: "GET",
        format: "json",
        ...params,
      }),

    /**
     * No description
     *
     * @tags vehicles
     * @name GetVehiclesByRoute
     * @summary Get all vehicles currently on a route with their stop sequences
     * @request POST:/api/vehicles/by-route
     */
    getVehiclesByRoute: (
      data: VehiclesByRouteRequest,
      params: RequestParams = {},
    ) =>
      this.request<VehiclesByRouteResponse, ErrorResponse>({
        path: `/api/vehicles/by-route`,
        method: "POST",
        body: data,
        type: ContentType.Json,
        format: "json",
        ...params,
      }),
  };
}
