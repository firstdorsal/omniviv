/**
 * On-demand loader for vehicle 3D model definitions.
 *
 * Model data lives in /vehicle-models/*.json (served statically by the web
 * server) and is fetched lazily.  A manifest file lists all available models
 * and their default assignments per city / vehicle-type.
 *
 * Two JSON formats are supported (discriminated by `kind`):
 *
 *   1. **`kind: "simple"`** (trams, buses, scooters, …):
 *      `lods.lowPoly.segments` contains a flat array of segments.
 *      `totalLength` must be provided manually.
 *
 *   2. **`kind: "consist"`** (trains with variable car counts):
 *      `cars` defines a reusable catalog of car types with dimensions.
 *      `consists` maps named configurations to ordered car lists.
 *      `totalLength` is computed from the resolved segments + gaps.
 */

import { calculateSegmentDistances, DEFAULT_INTER_UNIT_GAP, FALLBACK_VEHICLE_MODEL, type VehicleFormation, type VehicleModel, type VehicleModelMetadata, type VehicleSegment } from "./vehicleModels";

// ── Model ID validation ─────────────────────────────────────────────────

/** Only lowercase alphanumeric and hyphens; prevents path traversal. */
const VALID_MODEL_ID = /^[a-z0-9][a-z0-9\-]*[a-z0-9]$|^[a-z0-9]$/;

// ── JSON schema types (what the .json files contain) ────────────────────

/** A single car type in the reusable catalog (trains). */
interface CarDefinition {
    length: number;
    height: number;
    type: string;
    powered?: boolean;
    width?: number;
    hasBogies?: boolean;
    /** Bogie centerline positions in meters from the front of the car */
    bogiePositions?: number[];
}

/** A named train configuration referencing cars from the catalog. */
interface ConsistDefinition {
    cars: string[];
    couplingGap: number;
    metadata?: VehicleModelMetadata;
}

interface SimpleModelDefinition {
    kind: "simple";
    id: string;
    name: string;
    manufacturer: string;
    vehicleType: string;
    width: number;
    totalLength: number;
    articulationGap: number;
    lods: {
        lowPoly: {
            segments: VehicleSegment[];
        };
    };
    metadata?: VehicleModelMetadata;
}

interface ConsistModelDefinition {
    kind: "consist";
    id: string;
    name: string;
    manufacturer: string;
    vehicleType: string;
    width: number;
    cars: Record<string, CarDefinition>;
    consists: Record<string, ConsistDefinition>;
    defaultConsist: string;
    metadata?: VehicleModelMetadata;
}

type VehicleModelDefinition = SimpleModelDefinition | ConsistModelDefinition;

interface ManifestEntry {
    vehicleType: string;
    /** Available LOD levels — currently only "lowPoly" is implemented. */
    lods: string[];
}

interface VehicleModelManifest {
    version: number;
    models: Record<string, ManifestEntry>;
    defaults: Record<string, Record<string, string>>;
}

// ── Cached segment distances ────────────────────────────────────────────

export type SegmentDistances = ReturnType<typeof calculateSegmentDistances>;

// ── Loader ──────────────────────────────────────────────────────────────

export class VehicleModelLoader {
    private manifest: VehicleModelManifest | null = null;
    private cache = new Map<string, VehicleModel>();
    private failedIds = new Set<string>();
    private segmentDistanceCache = new Map<string, SegmentDistances>();
    private loading = new Map<string, Promise<VehicleModel | null>>();
    private readonly baseUrl: string;
    private readonly city: string;
    private _ready = false;

    constructor(city: string, baseUrl = "/vehicle-models") {
        this.city = city;
        this.baseUrl = baseUrl;
    }

    // ── Lifecycle ───────────────────────────────────────────────────────

    /**
     * Fetch the manifest and preload all default models for the configured city.
     * Idempotent �� calling again after success is a no-op.
     */
    async init(): Promise<void> {
        if (this._ready) return;
        await this.loadManifest();
        await this.preloadDefaults();
        this._ready = true;
    }

    /** True after init() has resolved (all default models cached). */
    get ready(): boolean {
        return this._ready;
    }

    // ── Async fetching ──────────────────────────────────────────────────

    private async loadManifest(): Promise<void> {
        const resp = await fetch(`${this.baseUrl}/manifest.json`);
        if (!resp.ok) {
            throw new Error(`Failed to load vehicle model manifest: ${resp.status}`);
        }
        this.manifest = await resp.json();
    }

    private async preloadDefaults(): Promise<void> {
        if (!this.manifest) return;
        const defaults = this.manifest.defaults[this.city];
        if (!defaults) return;
        const modelIds = new Set(Object.values(defaults));
        await Promise.all([...modelIds].map((id) => this.loadModel(id)));
    }

    /** Fetch a model by ID. Deduplicates concurrent requests; remembers permanent failures. */
    async loadModel(modelId: string): Promise<VehicleModel | null> {
        if (this.cache.has(modelId)) return this.cache.get(modelId)!;
        if (this.failedIds.has(modelId)) return null;

        const inFlight = this.loading.get(modelId);
        if (inFlight) return inFlight;

        const promise = this.fetchModel(modelId);
        this.loading.set(modelId, promise);
        try {
            const model = await promise;
            if (model) {
                this.cache.set(modelId, model);
                this.segmentDistanceCache.set(model.id, calculateSegmentDistances(model));
            } else {
                this.failedIds.add(modelId);
            }
            return model;
        } finally {
            this.loading.delete(modelId);
        }
    }

    // ── Synchronous cache access (hot path in render loop) ──────────────

    /** Get a cached model by ID — returns null if not loaded yet. */
    getModel(modelId: string): VehicleModel | null {
        return this.cache.get(modelId) ?? null;
    }

    /**
     * Get the default model for a vehicle/route type.
     * Returns FALLBACK_VEHICLE_MODEL if the manifest isn't loaded or no
     * default is configured for the given type.
     */
    getDefaultModel(vehicleType: string): VehicleModel {
        if (!this.manifest) return FALLBACK_VEHICLE_MODEL;
        const defaults = this.manifest.defaults[this.city];
        if (!defaults) return FALLBACK_VEHICLE_MODEL;
        const modelId = defaults[vehicleType];
        if (!modelId) return FALLBACK_VEHICLE_MODEL;
        return this.cache.get(modelId) ?? FALLBACK_VEHICLE_MODEL;
    }

    /**
     * Get pre-computed segment distances for a model.
     * Computed once on load and cached for the lifetime of the model.
     */
    getSegmentDistances(model: VehicleModel): SegmentDistances {
        let cached = this.segmentDistanceCache.get(model.id);
        if (!cached) {
            cached = calculateSegmentDistances(model);
            this.segmentDistanceCache.set(model.id, cached);
        }
        return cached;
    }

    // ── Formation resolution ───────────────────────────────────────────

    /**
     * Resolve a {@link VehicleFormation} into a single flat VehicleModel
     * that the renderer can consume directly.
     *
     * Returns null if any referenced model is not loaded.
     */
    resolveFormation(formation: VehicleFormation): VehicleModel | null {
        if (formation.units.length === 0) return null;

        // Single-unit shortcut
        if (formation.units.length === 1) {
            const entry = formation.units[0];
            const model = this.cache.get(entry.modelId);
            if (!model) return null;
            if (!entry.reversed) return model;
            return {
                ...model,
                segments: [...model.segments].reverse(),
            };
        }

        const interGap = formation.interUnitGap ?? DEFAULT_INTER_UNIT_GAP;
        const allSegments: VehicleSegment[] = [];
        let maxWidth = 0;
        const resolvedModels: VehicleModel[] = [];

        for (let unitIndex = 0; unitIndex < formation.units.length; unitIndex++) {
            const entry = formation.units[unitIndex];
            const model = this.cache.get(entry.modelId);
            if (!model) return null;

            resolvedModels.push(model);
            maxWidth = Math.max(maxWidth, model.width);

            const unitSegments = entry.reversed
                ? [...model.segments].reverse()
                : [...model.segments];

            for (let segIndex = 0; segIndex < unitSegments.length; segIndex++) {
                const segment = { ...unitSegments[segIndex] };

                const isLastSegmentOfUnit = segIndex === unitSegments.length - 1;
                const isLastUnit = unitIndex === formation.units.length - 1;
                if (isLastSegmentOfUnit && !isLastUnit) {
                    segment.gapAfter = interGap;
                }

                allSegments.push(segment);
            }
        }

        const firstUnitModel = resolvedModels[0];
        let totalLength = 0;
        for (let i = 0; i < allSegments.length; i++) {
            totalLength += allSegments[i].length;
            if (i < allSegments.length - 1) {
                totalLength += allSegments[i].gapAfter ?? firstUnitModel.articulationGap;
            }
        }

        // Encode reversed state into the ID to prevent cache collisions
        const unitKeys = formation.units.map(
            (u) => `${u.modelId}${u.reversed ? ':R' : ''}`
        );

        return {
            id: `formation:${unitKeys.join('+')}`,
            name: resolvedModels.map((m) => m.name).join(' + '),
            manufacturer: firstUnitModel.manufacturer,
            vehicleType: firstUnitModel.vehicleType,
            width: maxWidth,
            totalLength,
            articulationGap: firstUnitModel.articulationGap,
            segments: allSegments,
            metadata: firstUnitModel.metadata,
        };
    }

    // ── Manifest queries ────────────────────────────────────────────────

    /** All model IDs listed in the manifest. */
    getAvailableModelIds(): string[] {
        return this.manifest ? Object.keys(this.manifest.models) : [];
    }

    /** Manifest metadata for a model (vehicleType, available LODs). */
    getManifestEntry(modelId: string): ManifestEntry | null {
        return this.manifest?.models[modelId] ?? null;
    }

    // ── Internal ────────────────────────────────────────────────────────

    private async fetchModel(modelId: string): Promise<VehicleModel | null> {
        if (!VALID_MODEL_ID.test(modelId)) {
            console.warn(`[VehicleModelLoader] Rejected invalid model ID: ${modelId}`);
            return null;
        }
        try {
            const resp = await fetch(`${this.baseUrl}/${modelId}.json`);
            if (!resp.ok) return null;
            const data = await resp.json();
            return this.parseModel(data);
        } catch (error) {
            console.warn(`[VehicleModelLoader] Failed to load model "${modelId}":`, error);
            return null;
        }
    }

    /**
     * Parse and validate a model definition.
     * Detects the format via the `kind` discriminant.
     */
    private parseModel(data: unknown): VehicleModel {
        this.validateCommonFields(data);
        const obj = data as Record<string, unknown>;
        if (obj.kind === 'consist') {
            return this.resolveConsist(data as ConsistModelDefinition);
        }
        return this.parseSimpleModel(data as SimpleModelDefinition);
    }

    /** Minimal structural validation that catches the most common errors early. */
    private validateCommonFields(data: unknown): void {
        if (typeof data !== 'object' || data === null) {
            throw new Error('Model definition must be a JSON object');
        }
        const obj = data as Record<string, unknown>;
        if (typeof obj.id !== 'string' || obj.id.length === 0) {
            throw new Error('Model definition missing required "id" field');
        }
        if (typeof obj.vehicleType !== 'string') {
            throw new Error(`Model "${obj.id}" missing required "vehicleType" field`);
        }
        if (typeof obj.width !== 'number' || obj.width <= 0) {
            throw new Error(`Model "${obj.id}" has invalid "width": ${obj.width}`);
        }
        if (obj.kind !== 'simple' && obj.kind !== 'consist') {
            throw new Error(`Model "${obj.id}" has unknown "kind": ${obj.kind}. Must be "simple" or "consist".`);
        }
    }

    private parseSimpleModel(data: SimpleModelDefinition): VehicleModel {
        if (!data.lods?.lowPoly?.segments || !Array.isArray(data.lods.lowPoly.segments)) {
            throw new Error(`Simple model "${data.id}" missing "lods.lowPoly.segments" array`);
        }
        return {
            id: data.id,
            name: data.name,
            manufacturer: data.manufacturer,
            vehicleType: data.vehicleType,
            width: data.width,
            totalLength: data.totalLength,
            articulationGap: data.articulationGap,
            segments: data.lods.lowPoly.segments,
            metadata: data.metadata,
        };
    }

    private resolveConsist(data: ConsistModelDefinition): VehicleModel {
        const consistDef = data.consists[data.defaultConsist];
        if (!consistDef) {
            throw new Error(
                `Consist "${data.defaultConsist}" not found in model "${data.id}". ` +
                `Available: ${Object.keys(data.consists).join(', ')}`
            );
        }

        const segments: VehicleSegment[] = [];
        for (const carId of consistDef.cars) {
            const car = data.cars[carId];
            if (!car) {
                throw new Error(
                    `Car "${carId}" not found in model "${data.id}". ` +
                    `Available: ${Object.keys(data.cars).join(', ')}`
                );
            }
            segments.push({
                length: car.length,
                type: car.type,
                height: car.height,
                hasBogies: car.hasBogies ?? true,
                width: car.width,
                powered: car.powered,
                bogiePositions: car.bogiePositions,
            });
        }

        const bodyLength = segments.reduce((sum, s) => sum + s.length, 0);
        const gapCount = Math.max(0, segments.length - 1);
        const totalLength = bodyLength + gapCount * consistDef.couplingGap;

        const metadata: VehicleModelMetadata | undefined =
            (data.metadata ?? consistDef.metadata) !== undefined
                ? { ...data.metadata, ...consistDef.metadata, consistName: data.defaultConsist }
                : undefined;

        return {
            id: data.id,
            name: data.name,
            manufacturer: data.manufacturer,
            vehicleType: data.vehicleType,
            width: data.width,
            totalLength,
            articulationGap: consistDef.couplingGap,
            segments,
            metadata,
        };
    }
}
