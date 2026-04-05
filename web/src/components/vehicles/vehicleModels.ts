/**
 * Vehicle model type definitions and utilities for 3D visualization.
 *
 * ## Conceptual hierarchy
 *
 * The data model distinguishes three levels that mirror real-world operations:
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  VehicleModel  (Level 1 — Blueprint / Baureihe)                    │
 * │  The design specification of a vehicle *type*.                     │
 * │  Defines car catalog, available consists, dimensions, metadata.    │
 * │  Examples: "ICE 3 BR 403", "Siemens Combino", "MAN Lion's City"   │
 * │  One model → many physical units built from the same design.       │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │  VehicleUnit  (Level 2 — Physical Instance / Triebzug)             │
 * │  A specific manufactured vehicle identified by serial number.      │
 * │  References exactly one VehicleModel.                              │
 * │  For EMUs (ICE 3/4): the complete trainset is one unit.            │
 * │  For buses/trams: the individual vehicle is one unit.              │
 * │  Examples: "Tz 303 'Dortmund'" (an ICE 3 set),                    │
 * │            Combino #821 (an Augsburg tram)                         │
 * │  NOTE: Forward-looking — no unit store/registry is implemented     │
 * │  yet.  The interface exists so callers can model unit-level data   │
 * │  when operator APIs (e.g. DB Wagenreihung) provide it.            │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │  VehicleFormation  (Level 3 — Running Assembly / Zugverband)       │
 * │  The actual vehicle(s) as coupled for a specific service.          │
 * │  Ordered list of one or more VehicleUnits, each with orientation.  │
 * │  Changes per-trip based on demand, maintenance, and operations.    │
 * │  The first entry (index 0) is the operational front of the train   │
 * │  in the current direction of travel.                               │
 * │  Examples:                                                         │
 * │    • Single tram on line 1                        → 1 unit         │
 * │    • ICE 3 Doppeltraktion (two sets coupled)      → 2 units        │
 * │    • ICE 2 Flügelzug before split at Hamm         → 2 units        │
 * │    • Articulated bus (Gelenkbus)                  → 1 unit         │
 * │      (articulation is within the model, NOT a second unit)         │
 * └─────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * The **Trip / Service** (GTFS trip_id) is a fourth conceptual level
 * that already exists in the codebase.  A trip references a formation
 * (when known) or falls back to a default model from the route type.
 *
 * ## Key distinctions
 *
 * | Concept              | Is one vehicle? | Example                           |
 * |----------------------|-----------------|-----------------------------------|
 * | Articulated bus      | Yes (1 unit)    | MAN Lion's City 18 — 2 sections   |
 * | Articulated tram     | Yes (1 unit)    | Combino — 7 sections              |
 * | Double tram          | No (2 units)    | Two Combinos coupled for capacity  |
 * | ICE 3 single         | Yes (1 unit)    | 8-car EMU set                     |
 * | ICE 3 Doppeltraktion | No (2 units)    | Two 8-car sets coupled = 16 cars  |
 * | ICE 2 Flügelzug      | No (2 units)    | Two half-sets, split at station    |
 * | Loco + coaches       | No (n units)    | Locomotive = 1 unit, coaches = 1+ |
 *
 * ## Segment type conventions
 *
 * {@link VehicleSegment.type} uses {@link WellKnownSegmentType} for
 * autocomplete of common values, but accepts any string so new vehicle
 * categories (ferries, aircraft, scooters …) can be added without code
 * changes.
 */

// ── Segment types ───────────────────────────────────────────────────────

/**
 * Well-known segment type values that get IDE autocomplete.
 * Any other `string` is also accepted for extensibility.
 */
export type WellKnownSegmentType =
    | 'cab' | 'passenger' | 'articulation'
    | 'power_car' | 'driving_trailer' | 'end_car'
    | 'first_class' | 'second_class' | 'dining' | 'bistro' | 'service'
    | 'coupling';

/** Extensible segment type — well-known values get autocomplete, any string is valid. */
export type SegmentType = WellKnownSegmentType | (string & {});

// ── Segments (building blocks) ──────────────────────────────────────────

export interface VehicleSegment {
    /** Length of this segment in meters */
    length: number;
    /** Semantic segment type — used for styling in future LODs. */
    type: SegmentType;
    /** Height of this segment in meters (for 3D extrusion) */
    height: number;
    /**
     * Whether this segment has bogies / wheel assemblies.
     * Note: for consist-based models, this defaults to `true` unless
     * the car definition explicitly sets `hasBogies: false`.
     */
    hasBogies: boolean;
    /** Per-segment width override in meters (falls back to VehicleModel.width) */
    width?: number;
    /** Whether this segment carries traction motors */
    powered?: boolean;
    /**
     * Gap *after* this segment in meters, overriding VehicleModel.articulationGap.
     * Used for variable gaps — e.g., the larger coupling gap between two
     * formation units vs. the tighter gap between cars within one unit.
     */
    gapAfter?: number;
}

// ── Level 1: VehicleModel (Blueprint / Baureihe) ────────────────────────

/** Well-known traction types with autocomplete. */
export type TractionType = 'electric' | 'diesel' | 'biogas' | 'hybrid' | 'battery' | 'hydrogen' | (string & {});

/**
 * Factual metadata about a vehicle model.
 * Populated from the on-demand JSON files; all fields optional.
 */
export interface VehicleModelMetadata {
    /** Wikidata entity ID (e.g., "Q702311" for ICE 1) */
    wikidataId?: string;
    /** Maximum operating speed in km/h */
    maxSpeedKmh?: number;
    /** Year the model entered revenue service */
    inServiceSince?: number;
    /** Number of units / sets built or ordered */
    unitsBuilt?: number;
    /** Official type designation (e.g., "BR 401", "NF8") */
    designation?: string;
    /** Traction type */
    tractionType?: TractionType;
    /** Power supply standard: "15kV 16.7Hz AC", "750V DC", "overhead catenary", etc. */
    powerSupply?: string;
    /** Total installed traction power in kW */
    powerKw?: number;
    /** Track gauge in mm (1435 = standard, 1000 = metre gauge) */
    gaugeMm?: number;
    /** Mass of a single unit / consist in tonnes */
    massTonnes?: number;
    /** Seating capacity in default configuration */
    seatingCapacity?: number;
    /** Operator name(s) */
    operators?: string[];
    /** Country ISO 3166-1 alpha-2 codes */
    countries?: string[];
    /** Whether the vehicle is low-floor */
    lowFloor?: boolean;
    /** Floor height above rail / road surface in mm */
    floorHeightMm?: number;
    /**
     * Name of the resolved consist (for trains with multiple configurations).
     * Only present on models loaded via the consist system.
     */
    consistName?: string;
}

/**
 * **Level 1 — Blueprint / Baureihe**
 *
 * The design specification of a vehicle *type*.  Defines the physical
 * dimensions, car layout (via segments), and factual metadata.
 *
 * A VehicleModel is NOT a physical vehicle — it's the class/blueprint from
 * which many identical units are built.  Use {@link VehicleUnit} for a
 * specific physical instance.
 *
 * Model data is served on demand from `/vehicle-models/*.json` and loaded
 * by VehicleModelLoader.  Two JSON formats exist:
 *   - **simple** (`kind: "simple"`): flat segment array for trams/buses.
 *     `totalLength` must be provided manually in the JSON.
 *   - **consist** (`kind: "consist"`): car catalog + named configurations
 *     for trains.  `totalLength` is computed automatically by the loader.
 */
export interface VehicleModel {
    /** Unique identifier for this model */
    id: string;
    /** Display name */
    name: string;
    /** Manufacturer */
    manufacturer: string;
    /**
     * Vehicle category — maps to GTFS/OSM route_type values.
     * Examples: "tram", "bus", "rail", "subway", "ferry"
     */
    vehicleType: string;
    /** Default body width in meters (segments may override via VehicleSegment.width) */
    width: number;
    /** Total length in meters (sum of segment lengths + gaps) */
    totalLength: number;
    /** Segments from front to back (for the active LOD) */
    segments: VehicleSegment[];
    /**
     * Default gap between segments in meters.
     * Individual segments can override via {@link VehicleSegment.gapAfter}.
     */
    articulationGap: number;
    /** Factual metadata (Wikidata ID, max speed, capacity, consist name, etc.) */
    metadata?: VehicleModelMetadata;
}

// ── Level 2: VehicleUnit (Physical Instance / Triebzug) ─────────────────

/**
 * **Level 2 — Physical Instance / Triebzug**
 *
 * A specific manufactured vehicle identified by a serial/fleet number.
 * References exactly one {@link VehicleModel}.
 *
 * Forward-looking: no unit store or registry is implemented yet.
 * The interface exists so callers can model unit-level data when
 * operator APIs (e.g. DB Wagenreihung) provide it.
 */
export interface VehicleUnit {
    /** Unique identifier for this physical unit */
    unitId: string;
    /** Reference to the {@link VehicleModel} blueprint */
    modelId: string;
    /**
     * Which consist variant this unit uses.
     * Falls back to the model's `defaultConsist` if not set.
     * Only relevant for models that define multiple consists (trains).
     */
    consistName?: string;
    /** Fleet or serial number (e.g., "Tz 303" for an ICE 3 set) */
    fleetNumber?: string;
    /** Human-readable name (German trains are often named after cities) */
    name?: string;
    /** Home depot / maintenance facility */
    depot?: string;
}

// ── Level 3: VehicleFormation (Running Assembly / Zugverband) ───────────

/**
 * One entry in a {@link VehicleFormation} — either a known physical unit
 * or just a model reference when the exact unit is unknown.
 */
export interface FormationEntry {
    /**
     * Reference to a {@link VehicleModel} id.
     * Always required — determines dimensions and car layout.
     */
    modelId: string;
    /**
     * Reference to a specific {@link VehicleUnit}.
     * Optional — often unknown from GTFS data alone; requires
     * operator-specific APIs (e.g., DB Wagenreihung API).
     */
    unitId?: string;
    /**
     * Which consist variant to use for this unit.
     * Not yet implemented — reserved for future use when
     * `resolveFormation` gains consist-aware model loading.
     */
    consistName?: string;
    /**
     * Whether this unit is reversed (rear facing direction of travel).
     *
     * Physical car order stays the same, but the "front" of the unit
     * points toward the rear of the formation.  Relevant for:
     *   - ICE 2 push-pull (Steuerwagen leading)
     *   - Doppeltraktion where sets face each other
     *   - Future LODs that render asymmetric vehicles
     */
    reversed?: boolean;
}

/**
 * **Level 3 — Running Assembly / Zugverband**
 *
 * The actual assembled vehicle(s) as coupled for a specific service.
 * This is what physically exists on the track / road at a given moment.
 *
 * A formation is an ordered list of {@link FormationEntry} items.
 * Index 0 is the operational front of the formation (the end facing
 * the direction of travel).
 *
 * ## Common patterns
 *
 * | Pattern                 | Units | Example                                    |
 * |-------------------------|-------|--------------------------------------------|
 * | Single vehicle          | 1     | One tram, one bus, one ICE 3 set           |
 * | Doppeltraktion          | 2     | Two ICE 3 sets coupled end-to-end          |
 * | Flügelzug (wing train)  | 2     | Two ICE 2 half-sets, split at Hamm         |
 * | Double tram             | 2     | Two Combinos coupled for peak capacity     |
 * | Loco + coaches          | 2+    | BR 101 locomotive + Intercity coach set    |
 * | Mixed coupling          | 2     | ICE 3 (BR 403) + ICE 3neo (BR 408)        |
 *
 * ## NOT a formation (these are within a single unit's model)
 *
 * - Articulated bus sections (Gelenkbus) → one unit, model has 2 segments
 * - Tram articulation modules → one unit, model has 7 segments
 * - ICE 1 power car + middle cars → one unit, model has 14-car consist
 */
export interface VehicleFormation {
    /**
     * Ordered list of units from the front of the formation to the rear.
     * Most formations have exactly 1 entry.
     */
    units: FormationEntry[];
    /**
     * Gap between coupled units in meters.
     * This is typically larger than the within-unit articulationGap
     * (1.0–2.0 m between coupled sets vs 0.3–0.6 m between cars).
     * Defaults to {@link DEFAULT_INTER_UNIT_GAP} if not specified.
     */
    interUnitGap?: number;
}

// ── Constants ───────────────────────────────────────────────────────────

/** Default coupling gap between formation units when not specified (meters). */
export const DEFAULT_INTER_UNIT_GAP = 1.5;

/** Approximate meters per degree of latitude at the equator. */
export const METERS_PER_DEGREE_AT_EQUATOR = 111_320;

/** Minimum segment body length in meters below which polygon rendering is skipped. */
export const MIN_SEGMENT_RENDER_LENGTH = 0.1;

/**
 * Minimal fallback model used before on-demand models have loaded, or
 * when the real model fails to load.  Uses vehicleType "unknown" so it
 * is visually distinguishable from a correctly loaded bus model.
 */
export const FALLBACK_VEHICLE_MODEL: VehicleModel = {
    id: 'fallback',
    name: 'Fallback',
    manufacturer: 'Generic',
    vehicleType: 'unknown',
    width: 2.55,
    totalLength: 12,
    articulationGap: 0,
    segments: [
        { length: 12, type: 'cab', height: 3.2, hasBogies: true },
    ],
};

/** Animation frame interval in milliseconds (shared between Map and VehicleRenderer). */
export const ANIMATION_INTERVAL = 50;

// ── Geometry utilities ──────────────────────────────────────────────────

/**
 * Calculate the distances from the front of the vehicle to each segment's
 * front and rear endpoints.  Used for track-following visualization.
 *
 * Respects per-segment {@link VehicleSegment.gapAfter} overrides,
 * falling back to {@link VehicleModel.articulationGap}.
 */
export function calculateSegmentDistances(model: VehicleModel): Array<{
    frontDistance: number;
    rearDistance: number;
    segment: VehicleSegment;
    index: number;
}> {
    const result: Array<{
        frontDistance: number;
        rearDistance: number;
        segment: VehicleSegment;
        index: number;
    }> = [];
    let currentDistance = 0;

    for (let i = 0; i < model.segments.length; i++) {
        const segment = model.segments[i];
        result.push({
            frontDistance: currentDistance,
            rearDistance: currentDistance + segment.length,
            segment,
            index: i,
        });
        const gap = segment.gapAfter ?? model.articulationGap;
        currentDistance += segment.length + gap;
    }

    return result;
}

/**
 * Get all unique distances along the vehicle that need track positions.
 * Utility for future LOD rendering; not used in the current box renderer.
 */
export function getAllTrackDistances(model: VehicleModel): number[] {
    const distances = new Set<number>();
    let currentDistance = 0;

    for (const segment of model.segments) {
        distances.add(currentDistance);
        distances.add(currentDistance + segment.length);
        const gap = segment.gapAfter ?? model.articulationGap;
        currentDistance += segment.length + gap;
    }

    return Array.from(distances).sort((a, b) => a - b);
}
