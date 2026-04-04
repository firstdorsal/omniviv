import { describe, it, expect, beforeAll, vi } from "vitest";
import { getCityPopulation, formatPopulation } from "./cityPopulations";

// Mock fetch to return a small test dataset
beforeAll(() => {
    const testData = [
        { name: "Berlin", ascii: "Berlin", pop: 3426354 },
        { name: "München", ascii: "Munchen", pop: 1260391 },
        { name: "Frankfurt am Main", ascii: "Frankfurt am Main", pop: 650000 },
        { name: "Augsburg", ascii: "Augsburg", pop: 259196 },
        { name: "Lauingen", ascii: "Lauingen", pop: 11068 },
        { name: "Freiburg im Breisgau", ascii: "Freiburg im Breisgau", pop: 230940 },
        { name: "Frankfurt", ascii: "Frankfurt", pop: 650000 },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(testData),
    }));
});

describe("getCityPopulation", () => {
    it("finds exact match", async () => {
        const result = await getCityPopulation("Berlin");
        expect(result).toEqual({ population: 3426354, name: "Berlin" });
    });

    it("is case-insensitive", async () => {
        const result = await getCityPopulation("berlin");
        expect(result).toEqual({ population: 3426354, name: "Berlin" });
    });

    it("matches ASCII name", async () => {
        const result = await getCityPopulation("Munchen");
        expect(result).toEqual({ population: 1260391, name: "München" });
    });

    it("strips parenthetical suffix: Lauingen (Donau) → Lauingen", async () => {
        const result = await getCityPopulation("Lauingen (Donau)");
        expect(result).toEqual({ population: 11068, name: "Lauingen" });
    });

    it("strips 'am/an der/im/bei' suffix", async () => {
        const result = await getCityPopulation("Freiburg im Breisgau");
        expect(result).not.toBeNull();
        expect(result!.name).toBe("Freiburg im Breisgau");
    });

    it("returns null for unknown city", async () => {
        const result = await getCityPopulation("Nonexistentville");
        expect(result).toBeNull();
    });

    it("returns null for empty string", async () => {
        const result = await getCityPopulation("");
        expect(result).toBeNull();
    });
});

describe("formatPopulation", () => {
    it("formats with German-style separators", () => {
        expect(formatPopulation(1260391)).toMatch(/1[\.\s]260[\.\s]391/);
    });

    it("formats small numbers without separator", () => {
        expect(formatPopulation(42)).toBe("42");
    });
});
