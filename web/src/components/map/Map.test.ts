import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

describe("Map component security", () => {
    it("window.map is gated behind import.meta.env.DEV", () => {
        const source = readFileSync(join(__dirname, "Map.tsx"), "utf-8");

        // The window.map assignment must be inside an import.meta.env.DEV guard
        const windowMapLine = source
            .split("\n")
            .findIndex((line) => line.includes("window as any).map = this.map"));
        expect(windowMapLine, "window.map assignment not found in Map.tsx").toBeGreaterThan(-1);

        // The line before the assignment must contain the DEV check
        const lines = source.split("\n");
        const guardFound = lines
            .slice(Math.max(0, windowMapLine - 3), windowMapLine)
            .some((line) => line.includes("import.meta.env.DEV"));
        expect(guardFound, "window.map assignment must be inside an import.meta.env.DEV check").toBe(
            true,
        );
    });

    it("window.map is never assigned unconditionally", () => {
        const source = readFileSync(join(__dirname, "Map.tsx"), "utf-8");
        const lines = source.split("\n");

        // Find all lines that assign to window.map
        const assignmentLines = lines
            .map((line, i) => ({ line, i }))
            .filter(({ line }) => line.includes("window") && line.includes(".map =") && line.includes("this.map"));

        for (const { i } of assignmentLines) {
            // Each assignment must have an import.meta.env.DEV guard within 3 lines before it
            const context = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
            expect(
                context.includes("import.meta.env.DEV"),
                `window.map assignment at line ${i + 1} is not guarded by import.meta.env.DEV`,
            ).toBe(true);
        }
    });
});
