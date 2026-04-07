import { describe, it, expect } from "vitest";
import {
    FALLBACK_VEHICLE_MODEL,
    calculateSegmentDistances,
    getAllTrackDistances,
    type VehicleModel,
} from "./vehicleModels";

describe("FALLBACK_VEHICLE_MODEL", () => {
    it("has vehicleType 'unknown' to distinguish from real models", () => {
        expect(FALLBACK_VEHICLE_MODEL.vehicleType).toBe("unknown");
    });

    it("has a single segment with reasonable dimensions", () => {
        expect(FALLBACK_VEHICLE_MODEL.segments).toHaveLength(1);
        expect(FALLBACK_VEHICLE_MODEL.width).toBeGreaterThan(2);
        expect(FALLBACK_VEHICLE_MODEL.width).toBeLessThan(3);
        expect(FALLBACK_VEHICLE_MODEL.totalLength).toBeGreaterThan(10);
        expect(FALLBACK_VEHICLE_MODEL.totalLength).toBeLessThan(15);
    });
});

describe("calculateSegmentDistances", () => {
    it("single-segment model", () => {
        const model: VehicleModel = {
            ...FALLBACK_VEHICLE_MODEL,
            segments: [{ length: 12, type: "cab", height: 3.2, hasBogies: true }],
        };
        const result = calculateSegmentDistances(model);
        expect(result).toHaveLength(1);
        expect(result[0].frontDistance).toBe(0);
        expect(result[0].rearDistance).toBe(12);
        expect(result[0].index).toBe(0);
    });

    it("multi-segment model with articulation gap", () => {
        const model: VehicleModel = {
            id: "test", name: "T", manufacturer: "T", vehicleType: "bus",
            width: 2.55, totalLength: 18, articulationGap: 0.3,
            segments: [
                { length: 10, type: "cab", height: 3.3, hasBogies: true },
                { length: 7, type: "passenger", height: 3.3, hasBogies: true },
            ],
        };
        const result = calculateSegmentDistances(model);
        expect(result).toHaveLength(2);
        expect(result[1].frontDistance).toBe(10.3);
        expect(result[1].rearDistance).toBeCloseTo(17.3);
    });

    it("14-car train model", () => {
        const model: VehicleModel = {
            id: "test-ice", name: "T", manufacturer: "T", vehicleType: "rail",
            width: 3.02, totalLength: 358, articulationGap: 0.6,
            segments: [
                { length: 20.56, type: "power_car", height: 3.84, hasBogies: true },
                ...Array(12).fill({ length: 26.4, type: "second_class", height: 3.84, hasBogies: true }),
                { length: 20.56, type: "power_car", height: 3.84, hasBogies: true },
            ],
        };
        const result = calculateSegmentDistances(model);
        expect(result).toHaveLength(14);
        expect(result[13].segment.type).toBe("power_car");
    });

    it("preserves per-segment width and powered metadata", () => {
        const model: VehicleModel = {
            id: "t", name: "T", manufacturer: "T", vehicleType: "rail",
            width: 3.02, totalLength: 47, articulationGap: 0.6,
            segments: [
                { length: 20.56, type: "power_car", height: 3.84, hasBogies: true, width: 3.07, powered: true },
                { length: 26.4, type: "second_class", height: 3.84, hasBogies: true, powered: false },
            ],
        };
        const result = calculateSegmentDistances(model);
        expect(result[0].segment.width).toBe(3.07);
        expect(result[0].segment.powered).toBe(true);
        expect(result[1].segment.width).toBeUndefined();
    });

    it("respects per-segment gapAfter override", () => {
        const model: VehicleModel = {
            ...FALLBACK_VEHICLE_MODEL,
            articulationGap: 0.3,
            segments: [
                { length: 10, type: "cab", height: 3, hasBogies: true, gapAfter: 2.0 },
                { length: 8, type: "cab", height: 3, hasBogies: true },
                { length: 5, type: "cab", height: 3, hasBogies: true },
            ],
        };
        const result = calculateSegmentDistances(model);
        // First gap: gapAfter=2.0 overrides articulationGap=0.3
        expect(result[1].frontDistance).toBe(12);
        // Second gap: no override, uses articulationGap=0.3
        expect(result[2].frontDistance).toBeCloseTo(20.3);
    });

    it("accepts any string as segment type", () => {
        const model: VehicleModel = {
            ...FALLBACK_VEHICLE_MODEL,
            segments: [
                { length: 10, type: "hull", height: 5.0, hasBogies: false },
                { length: 8, type: "deck_cabin", height: 3.0, hasBogies: false },
            ],
        };
        const result = calculateSegmentDistances(model);
        expect(result[0].segment.type).toBe("hull");
        expect(result[1].segment.type).toBe("deck_cabin");
    });
});

describe("VehicleSegment.bogiePositions", () => {
    it("accepts bogie positions on segments", () => {
        const model: VehicleModel = {
            ...FALLBACK_VEHICLE_MODEL,
            segments: [
                { length: 26.4, type: "second_class", height: 3.84, hasBogies: true, bogiePositions: [3.7, 22.7] },
            ],
        };
        const result = calculateSegmentDistances(model);
        expect(result[0].segment.bogiePositions).toEqual([3.7, 22.7]);
    });

    it("preserves bogie positions through calculateSegmentDistances", () => {
        const model: VehicleModel = {
            ...FALLBACK_VEHICLE_MODEL,
            articulationGap: 0.5,
            segments: [
                { length: 25.835, type: "end_car", height: 3.89, hasBogies: true, bogiePositions: [3.7, 22.135] },
                { length: 24.775, type: "second_class", height: 3.89, hasBogies: true, bogiePositions: [3.0, 21.775] },
            ],
        };
        const result = calculateSegmentDistances(model);
        expect(result[0].segment.bogiePositions).toEqual([3.7, 22.135]);
        expect(result[1].segment.bogiePositions).toEqual([3.0, 21.775]);
    });
});

describe("getAllTrackDistances", () => {
    it("returns sorted unique distances with gapAfter support", () => {
        const model: VehicleModel = {
            ...FALLBACK_VEHICLE_MODEL,
            articulationGap: 0.3,
            segments: [
                { length: 10, type: "cab", height: 3, hasBogies: true, gapAfter: 1.0 },
                { length: 7, type: "passenger", height: 3, hasBogies: true },
            ],
        };
        const distances = getAllTrackDistances(model);
        expect(distances).toHaveLength(4);
        expect(distances[0]).toBe(0);
        expect(distances[1]).toBe(10);
        expect(distances[2]).toBe(11); // 10 + gapAfter 1.0
        expect(distances[3]).toBe(18); // 11 + 7
    });
});
