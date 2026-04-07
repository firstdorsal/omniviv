import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VehicleModelLoader } from "./VehicleModelLoader";
import { FALLBACK_VEHICLE_MODEL, DEFAULT_INTER_UNIT_GAP } from "./vehicleModels";

// ── Test data ───────────────────────────────────────────────────────────

const MOCK_MANIFEST = {
    version: 1,
    models: {
        "test-tram": { vehicleType: "tram", lods: ["lowPoly"] },
        "test-bus": { vehicleType: "bus", lods: ["lowPoly"] },
        "test-train": { vehicleType: "rail", lods: ["lowPoly"] },
    },
    defaults: {
        augsburg: { tram: "test-tram", bus: "test-bus", rail: "test-train" },
    },
};

const MOCK_TRAM = {
    kind: "simple",
    id: "test-tram",
    name: "Test Tram",
    manufacturer: "TestCo",
    vehicleType: "tram",
    width: 2.3,
    totalLength: 42,
    articulationGap: 0.3,
    lods: {
        lowPoly: {
            segments: [
                { length: 7.2, type: "cab", height: 3.4, hasBogies: true },
                { length: 6.8, type: "passenger", height: 3.4, hasBogies: false },
            ],
        },
    },
};

const MOCK_BUS = {
    kind: "simple",
    id: "test-bus",
    name: "Test Bus",
    manufacturer: "TestCo",
    vehicleType: "bus",
    width: 2.55,
    totalLength: 12,
    articulationGap: 0,
    lods: {
        lowPoly: {
            segments: [{ length: 12, type: "cab", height: 3.3, hasBogies: true }],
        },
    },
};

const MOCK_TRAIN = {
    kind: "consist",
    id: "test-train",
    name: "Test Train",
    manufacturer: "TestRail",
    vehicleType: "rail",
    width: 3.02,
    cars: {
        "power-car": { length: 20.56, height: 3.84, type: "power_car", powered: true, width: 3.07, bogiePositions: [3.4, 17.16] },
        "first-class": { length: 26.4, height: 3.84, type: "first_class", powered: false, bogiePositions: [3.7, 22.7] },
        "second-class": { length: 26.4, height: 3.84, type: "second_class", powered: false, bogiePositions: [3.7, 22.7] },
        "dining": { length: 26.4, height: 4.295, type: "dining", powered: false, bogiePositions: [3.7, 22.7] },
    },
    metadata: { wikidataId: "Q999999", maxSpeedKmh: 280, tractionType: "electric", operators: ["TestRail AG"] },
    consists: {
        full: {
            cars: ["power-car", "second-class", "second-class", "dining", "first-class", "power-car"],
            couplingGap: 0.6,
            metadata: { seatingCapacity: 500, massTonnes: 400 },
        },
        short: {
            cars: ["power-car", "second-class", "power-car"],
            couplingGap: 0.6,
        },
    },
    defaultConsist: "full",
};

// ── Helpers ─────────────────────────────────────────────────────────────

function mockFetch() {
    const impl = vi.fn((url: string) => {
        let body: unknown;
        if (url.endsWith("manifest.json")) body = MOCK_MANIFEST;
        else if (url.includes("test-tram")) body = MOCK_TRAM;
        else if (url.includes("test-bus")) body = MOCK_BUS;
        else if (url.includes("test-train")) body = MOCK_TRAIN;
        else return Promise.resolve({ ok: false, status: 404 } as Response);
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
    });
    vi.stubGlobal("fetch", impl);
    return impl;
}

function createLoader() {
    return new VehicleModelLoader("augsburg", "/vehicle-models");
}

// ── Core loader tests ───────────────────────────────────────────────────

describe("VehicleModelLoader", () => {
    let fetchMock: ReturnType<typeof mockFetch>;
    beforeEach(() => { fetchMock = mockFetch(); });
    afterEach(() => { vi.restoreAllMocks(); });

    it("loads manifest and preloads default models", async () => {
        const loader = createLoader();
        expect(loader.ready).toBe(false);
        await loader.init();
        expect(loader.ready).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(4); // manifest + 3 models
    });

    it("init is idempotent — second call is a no-op", async () => {
        const loader = createLoader();
        await loader.init();
        fetchMock.mockClear();
        await loader.init();
        expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    it("returns cached models synchronously after init", async () => {
        const loader = createLoader();
        await loader.init();
        expect(loader.getModel("test-tram")!.id).toBe("test-tram");
        expect(loader.getModel("test-bus")!.id).toBe("test-bus");
        expect(loader.getModel("test-train")!.id).toBe("test-train");
    });

    it("returns null for unknown model IDs", () => {
        const loader = createLoader();
        expect(loader.getModel("nonexistent")).toBeNull();
    });

    it("getDefaultModel returns correct model for vehicle type", async () => {
        const loader = createLoader();
        await loader.init();
        expect(loader.getDefaultModel("tram").id).toBe("test-tram");
        expect(loader.getDefaultModel("bus").id).toBe("test-bus");
        expect(loader.getDefaultModel("rail").id).toBe("test-train");
    });

    it("getDefaultModel returns fallback for unknown vehicle type", async () => {
        const loader = createLoader();
        await loader.init();
        expect(loader.getDefaultModel("ferry").id).toBe(FALLBACK_VEHICLE_MODEL.id);
    });

    it("getDefaultModel returns fallback before init", () => {
        const loader = createLoader();
        expect(loader.getDefaultModel("tram").id).toBe(FALLBACK_VEHICLE_MODEL.id);
    });

    it("deduplicates concurrent loadModel calls", async () => {
        const loader = createLoader();
        await loader.init();
        fetchMock.mockClear();
        const [a, b] = await Promise.all([loader.loadModel("test-tram"), loader.loadModel("test-tram")]);
        expect(a).toBe(b);
        expect(fetchMock).toHaveBeenCalledTimes(0); // cached from init
    });

    it("handles fetch failure gracefully", async () => {
        const loader = createLoader();
        await loader.init();
        const result = await loader.loadModel("nonexistent-model");
        expect(result).toBeNull();
    });

    it("getSegmentDistances caches results", async () => {
        const loader = createLoader();
        await loader.init();
        const model = loader.getModel("test-bus")!;
        const d1 = loader.getSegmentDistances(model);
        const d2 = loader.getSegmentDistances(model);
        expect(d1).toBe(d2);
    });

    it("getAvailableModelIds lists all models", async () => {
        const loader = createLoader();
        await loader.init();
        expect(loader.getAvailableModelIds()).toContain("test-train");
    });

    it("getManifestEntry returns metadata", async () => {
        const loader = createLoader();
        await loader.init();
        expect(loader.getManifestEntry("test-tram")).toEqual({ vehicleType: "tram", lods: ["lowPoly"] });
    });
});

// ── Error handling (QA-2, QA-3, QA-5, QA-6) ────────────────────────────

describe("VehicleModelLoader — error handling", () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it("manifest 404 causes init to throw", async () => {
        vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 404 } as Response)));
        const loader = createLoader();
        await expect(loader.init()).rejects.toThrow("Failed to load vehicle model manifest");
        expect(loader.ready).toBe(false);
    });

    it("manifest malformed JSON causes init to throw", async () => {
        vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
            ok: true,
            json: () => Promise.reject(new SyntaxError("Unexpected token")),
        } as unknown as Response)));
        const loader = createLoader();
        await expect(loader.init()).rejects.toThrow("Unexpected token");
        expect(loader.ready).toBe(false);
    });

    it("model with missing kind field fails with descriptive error", async () => {
        const badModel = { id: "bad", name: "Bad", manufacturer: "X", vehicleType: "bus", width: 2 };
        vi.stubGlobal("fetch", vi.fn((url: string) => {
            const body = url.endsWith("manifest.json")
                ? { version: 1, models: { bad: { vehicleType: "bus", lods: ["lowPoly"] } }, defaults: { augsburg: { bus: "bad" } } }
                : badModel;
            return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
        }));
        const loader = createLoader();
        await loader.init(); // swallows the error via fetchModel catch
        expect(loader.getModel("bad")).toBeNull();
    });

    it("consist with missing defaultConsist key returns null", async () => {
        const badTrain = {
            kind: "consist", id: "bad-train", name: "Bad", manufacturer: "X",
            vehicleType: "rail", width: 3,
            cars: { "a": { length: 10, height: 3, type: "cab" } },
            consists: { "real": { cars: ["a"], couplingGap: 0.5 } },
            defaultConsist: "nonexistent",
        };
        vi.stubGlobal("fetch", vi.fn((url: string) => {
            const body = url.endsWith("manifest.json")
                ? { version: 1, models: { "bad-train": { vehicleType: "rail", lods: ["lowPoly"] } }, defaults: { augsburg: { rail: "bad-train" } } }
                : badTrain;
            return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
        }));
        const loader = createLoader();
        await loader.init();
        expect(loader.getModel("bad-train")).toBeNull();
    });

    it("consist with missing car reference returns null", async () => {
        const badTrain = {
            kind: "consist", id: "bad-train2", name: "Bad", manufacturer: "X",
            vehicleType: "rail", width: 3,
            cars: { "a": { length: 10, height: 3, type: "cab" } },
            consists: { "main": { cars: ["a", "nonexistent-car"], couplingGap: 0.5 } },
            defaultConsist: "main",
        };
        vi.stubGlobal("fetch", vi.fn((url: string) => {
            const body = url.endsWith("manifest.json")
                ? { version: 1, models: { "bad-train2": { vehicleType: "rail", lods: ["lowPoly"] } }, defaults: { augsburg: { rail: "bad-train2" } } }
                : badTrain;
            return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
        }));
        const loader = createLoader();
        await loader.init();
        expect(loader.getModel("bad-train2")).toBeNull();
    });

    it("getDefaultModel with unknown city returns fallback", async () => {
        const loader = new VehicleModelLoader("munich", "/vehicle-models");
        mockFetch();
        await loader.init();
        expect(loader.getDefaultModel("tram").id).toBe(FALLBACK_VEHICLE_MODEL.id);
    });

    it("negative-cache: failed model IDs are not re-fetched", async () => {
        const fetchImpl = mockFetch();
        const loader = createLoader();
        await loader.init();
        fetchImpl.mockClear();

        await loader.loadModel("does-not-exist");
        await loader.loadModel("does-not-exist");
        // Only one fetch despite two calls (second hits negative cache)
        expect(fetchImpl.mock.calls.filter(([url]: [string]) => url.includes("does-not-exist"))).toHaveLength(1);
    });

    it("rejects model IDs with path traversal characters", async () => {
        const fetchImpl = mockFetch();
        const loader = createLoader();
        await loader.init();
        fetchImpl.mockClear();

        const result = await loader.loadModel("../../etc/passwd");
        expect(result).toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled(); // rejected before fetch
    });
});

// ── Consist resolution ──────────────────────────────────────────────────

describe("VehicleModelLoader — consist resolution", () => {
    let fetchMock: ReturnType<typeof mockFetch>;
    beforeEach(() => { fetchMock = mockFetch(); });
    afterEach(() => { vi.restoreAllMocks(); });

    it("resolves consist into flat segments", async () => {
        const loader = createLoader();
        await loader.init();
        const model = loader.getModel("test-train")!;
        expect(model.segments).toHaveLength(6);
        expect(model.metadata?.consistName).toBe("full");
    });

    it("uses car catalog dimensions for each segment", async () => {
        const loader = createLoader();
        await loader.init();
        const model = loader.getModel("test-train")!;
        expect(model.segments[0].type).toBe("power_car");
        expect(model.segments[0].width).toBe(3.07);
        expect(model.segments[3].type).toBe("dining");
        expect(model.segments[3].height).toBe(4.295);
    });

    it("computes totalLength from segments + gaps", async () => {
        const loader = createLoader();
        await loader.init();
        const model = loader.getModel("test-train")!;
        const expectedBody = 20.56 + 26.4 + 26.4 + 26.4 + 26.4 + 20.56;
        expect(model.totalLength).toBeCloseTo(expectedBody + 5 * 0.6);
    });

    it("merges model-level and consist-level metadata", async () => {
        const loader = createLoader();
        await loader.init();
        const model = loader.getModel("test-train")!;
        expect(model.metadata!.wikidataId).toBe("Q999999");
        expect(model.metadata!.maxSpeedKmh).toBe(280);
        expect(model.metadata!.seatingCapacity).toBe(500);
        expect(model.metadata!.consistName).toBe("full");
    });

    it("uses hasBogies from CarDefinition when provided", async () => {
        const trainWithBogieOverride = {
            ...MOCK_TRAIN,
            id: "bogie-test",
            cars: {
                ...MOCK_TRAIN.cars,
                "no-bogie": { length: 10, height: 3, type: "service", hasBogies: false },
            },
            consists: {
                ...MOCK_TRAIN.consists,
                full: { ...MOCK_TRAIN.consists.full, cars: ["power-car", "no-bogie", "power-car"] },
            },
        };
        vi.stubGlobal("fetch", vi.fn((url: string) => {
            const body = url.endsWith("manifest.json")
                ? { version: 1, models: { "bogie-test": { vehicleType: "rail", lods: ["lowPoly"] } }, defaults: { augsburg: { rail: "bogie-test" } } }
                : trainWithBogieOverride;
            return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
        }));
        const loader = createLoader();
        await loader.init();
        const model = loader.getModel("bogie-test")!;
        expect(model.segments[1].hasBogies).toBe(false);
    });

    it("passes bogiePositions from CarDefinition through to segments", async () => {
        const loader = createLoader();
        mockFetch();
        await loader.init();
        const model = loader.getModel("test-train")!;
        // power-car has bogiePositions [3.4, 17.16]
        expect(model.segments[0].bogiePositions).toEqual([3.4, 17.16]);
        // second-class has bogiePositions [3.7, 22.7]
        expect(model.segments[1].bogiePositions).toEqual([3.7, 22.7]);
        // dining (index 3 in the consist)
        expect(model.segments[3].bogiePositions).toEqual([3.7, 22.7]);
    });
});

// ── Formation resolution ────────────────────────────────────────────────

describe("VehicleModelLoader — formation resolution", () => {
    beforeEach(() => { mockFetch(); });
    afterEach(() => { vi.restoreAllMocks(); });

    it("single-unit formation returns model as-is", async () => {
        const loader = createLoader();
        await loader.init();
        const result = loader.resolveFormation({ units: [{ modelId: "test-bus" }] });
        expect(result!.id).toBe("test-bus");
    });

    it("double traction concatenates with inter-unit gap", async () => {
        const loader = createLoader();
        await loader.init();
        const result = loader.resolveFormation({
            units: [{ modelId: "test-bus" }, { modelId: "test-bus" }],
            interUnitGap: 2.0,
        });
        expect(result!.segments).toHaveLength(2);
        expect(result!.segments[0].gapAfter).toBe(2.0);
        expect(result!.segments[1].gapAfter).toBeUndefined();
    });

    it("uses DEFAULT_INTER_UNIT_GAP when not specified", async () => {
        const loader = createLoader();
        await loader.init();
        const result = loader.resolveFormation({
            units: [{ modelId: "test-bus" }, { modelId: "test-bus" }],
        });
        expect(result!.segments[0].gapAfter).toBe(DEFAULT_INTER_UNIT_GAP);
    });

    it("reversed single unit has segments in reverse order", async () => {
        const loader = createLoader();
        await loader.init();
        const result = loader.resolveFormation({
            units: [{ modelId: "test-tram", reversed: true }],
        });
        expect(result!.segments[0].type).toBe("passenger");
        expect(result!.segments[1].type).toBe("cab");
    });

    it("reversed unit in multi-unit formation", async () => {
        const loader = createLoader();
        await loader.init();
        const result = loader.resolveFormation({
            units: [
                { modelId: "test-tram" },
                { modelId: "test-tram", reversed: true },
            ],
            interUnitGap: 1.0,
        });
        // First unit: cab, passenger
        expect(result!.segments[0].type).toBe("cab");
        expect(result!.segments[1].type).toBe("passenger");
        // Second unit reversed: passenger, cab
        expect(result!.segments[2].type).toBe("passenger");
        expect(result!.segments[3].type).toBe("cab");
    });

    it("triple traction has gaps between all units", async () => {
        const loader = createLoader();
        await loader.init();
        const result = loader.resolveFormation({
            units: [
                { modelId: "test-bus" },
                { modelId: "test-bus" },
                { modelId: "test-bus" },
            ],
            interUnitGap: 2.0,
        });
        expect(result!.segments).toHaveLength(3);
        expect(result!.segments[0].gapAfter).toBe(2.0);
        expect(result!.segments[1].gapAfter).toBe(2.0);
        expect(result!.segments[2].gapAfter).toBeUndefined();
    });

    it("mixed model formation uses max width", async () => {
        const loader = createLoader();
        await loader.init();
        const result = loader.resolveFormation({
            units: [{ modelId: "test-tram" }, { modelId: "test-bus" }],
            interUnitGap: 1.0,
        });
        expect(result!.width).toBe(Math.max(2.3, 2.55));
    });

    it("formation ID encodes reversed state", async () => {
        const loader = createLoader();
        await loader.init();
        const forward = loader.resolveFormation({
            units: [{ modelId: "test-bus" }, { modelId: "test-bus" }],
        });
        const reversed = loader.resolveFormation({
            units: [{ modelId: "test-bus" }, { modelId: "test-bus", reversed: true }],
        });
        expect(forward!.id).not.toBe(reversed!.id);
        expect(reversed!.id).toContain(":R");
    });

    it("returns null for missing model", async () => {
        const loader = createLoader();
        await loader.init();
        expect(loader.resolveFormation({ units: [{ modelId: "nope" }] })).toBeNull();
    });

    it("empty formation returns null", async () => {
        const loader = createLoader();
        await loader.init();
        expect(loader.resolveFormation({ units: [] })).toBeNull();
    });

    it("gapAfter is respected by calculateSegmentDistances", async () => {
        const loader = createLoader();
        await loader.init();
        const result = loader.resolveFormation({
            units: [{ modelId: "test-bus" }, { modelId: "test-bus" }],
            interUnitGap: 2.0,
        });
        const distances = loader.getSegmentDistances(result!);
        expect(distances[1].frontDistance).toBe(14); // 12 + 2.0 gap
    });
});

// ── ICE JSON validation (against real files) ────────────────────────────

describe("VehicleModelLoader — ICE JSON validation", () => {
    afterEach(() => { vi.restoreAllMocks(); });

    async function loadRealModel(filename: string) {
        const { readFileSync } = await import("fs");
        const { join } = await import("path");
        const filePath = join(__dirname, "../../../public/vehicle-models", filename);
        const data = JSON.parse(readFileSync(filePath, "utf-8"));

        const mockManifest = {
            version: 1,
            models: { [data.id]: { vehicleType: data.vehicleType, lods: ["lowPoly"] } },
            defaults: { augsburg: { [data.vehicleType]: data.id } },
        };
        vi.stubGlobal("fetch", vi.fn((url: string) => {
            const body = url.endsWith("manifest.json") ? mockManifest : data;
            return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
        }));
        const loader = new VehicleModelLoader("augsburg", "/vehicle-models");
        await loader.init();
        return loader.getModel(data.id)!;
    }

    it("Combino Augsburg: 7 sections, 2.3m wide", async () => {
        const model = await loadRealModel("siemens-combino-augsburg.json");
        expect(model.segments).toHaveLength(7);
        expect(model.width).toBe(2.3);
        expect(model.metadata?.wikidataId).toBe("Q392615");
        expect(model.metadata?.gaugeMm).toBe(1000);
    });

    it("ICE 1: 14 cars with metadata", async () => {
        const model = await loadRealModel("ice-1.json");
        expect(model.segments).toHaveLength(14);
        expect(model.segments[0].type).toBe("power_car");
        expect(model.metadata?.wikidataId).toBe("Q702311");
        expect(model.metadata?.maxSpeedKmh).toBe(280);
        const dining = model.segments.find((s) => s.type === "dining");
        expect(dining!.height).toBe(4.295);
    });

    it("ICE 2: 8-car half-set with wider power car", async () => {
        const model = await loadRealModel("ice-2.json");
        expect(model.segments).toHaveLength(8);
        expect(model.segments[0].width).toBe(3.07);
        expect(model.segments[7].type).toBe("driving_trailer");
    });

    it("ICE 3: 8-car EMU with distributed power", async () => {
        const model = await loadRealModel("ice-3.json");
        expect(model.segments).toHaveLength(8);
        expect(model.segments[0].powered).toBe(true);
        expect(model.segments[7].powered).toBe(true);
    });

    it("ICE 4: 12-car default with per-consist metadata", async () => {
        const model = await loadRealModel("ice-4.json");
        expect(model.segments).toHaveLength(12);
        expect(model.metadata?.wikidataId).toBe("Q121602394");
        expect(model.metadata?.maxSpeedKmh).toBe(265);
        expect(model.metadata?.seatingCapacity).toBe(830);
        // End cars are shorter than middle cars
        expect(model.segments[0].height).toBeLessThan(model.segments[1].height);
    });

    it("ICE models have bogie positions for rigid-body rendering", async () => {
        for (const file of ["ice-1.json", "ice-2.json", "ice-3.json", "ice-4.json"]) {
            const model = await loadRealModel(file);
            for (const seg of model.segments) {
                expect(seg.bogiePositions, `${file}: segment "${seg.type}" missing bogiePositions`).toBeDefined();
                expect(seg.bogiePositions!.length, `${file}: segment "${seg.type}" needs ≥2 bogie positions`).toBeGreaterThanOrEqual(2);
                // Bogies must lie within the segment body
                for (const pos of seg.bogiePositions!) {
                    expect(pos).toBeGreaterThanOrEqual(0);
                    expect(pos).toBeLessThanOrEqual(seg.length);
                }
            }
        }
    });

    it("all JSON files have kind discriminant", async () => {
        const { readFileSync, readdirSync } = await import("fs");
        const { join } = await import("path");
        const dir = join(__dirname, "../../../public/vehicle-models");
        const files = readdirSync(dir).filter((f) => f !== "manifest.json" && f.endsWith(".json"));
        for (const file of files) {
            const data = JSON.parse(readFileSync(join(dir, file), "utf-8"));
            expect(data.kind, `${file} missing kind`).toMatch(/^(simple|consist)$/);
        }
    });
});
