import { describe, it, expect } from "vitest";
import { haversineDistance, findClosestPointIndex } from "./geoUtils";

describe("haversineDistance", () => {
    it("returns 0 for identical points", () => {
        expect(haversineDistance(48.37, 10.89, 48.37, 10.89)).toBe(0);
    });

    it("computes ~1km for nearby points", () => {
        // Augsburg Königsplatz to ~1km east
        const d = haversineDistance(48.3657, 10.8946, 48.3657, 10.9086);
        expect(d).toBeGreaterThan(900);
        expect(d).toBeLessThan(1100);
    });

    it("computes ~60km for Augsburg→München", () => {
        const d = haversineDistance(48.3654, 10.8856, 48.1402, 11.5583);
        expect(d).toBeGreaterThan(55000);
        expect(d).toBeLessThan(65000);
    });

    it("handles negative coordinates", () => {
        // New York to London
        const d = haversineDistance(40.7128, -74.006, 51.5074, -0.1278);
        expect(d).toBeGreaterThan(5500000);
        expect(d).toBeLessThan(5600000);
    });
});

describe("findClosestPointIndex", () => {
    const coords: [number, number][] = [
        [10.89, 48.36],  // 0: Augsburg
        [11.56, 48.14],  // 1: München
        [9.98, 48.40],   // 2: Ulm
    ];

    it("finds the exact match", () => {
        expect(findClosestPointIndex(coords, 10.89, 48.36)).toBe(0);
    });

    it("finds nearest when not exact", () => {
        // Close to München
        expect(findClosestPointIndex(coords, 11.55, 48.15)).toBe(1);
    });

    it("returns 0 for single-element array", () => {
        expect(findClosestPointIndex([[5, 5]], 10, 10)).toBe(0);
    });
});
