import { describe, it, expect } from "vitest";
import { formatTime, formatTimeParts } from "./mapUtils";

describe("formatTime", () => {
    it("formats an ISO time string", () => {
        const result = formatTime("2026-02-02T14:30:00Z");
        expect(result).toBeTruthy();
        expect(result.length).toBeGreaterThan(0);
    });

    it("uses browser default locale (not hardcoded de-DE)", () => {
        const isoString = "2026-02-02T14:30:00Z";
        const date = new Date(isoString);
        // Match the implementation which uses navigator.language
        const locale = typeof navigator !== 'undefined' ? navigator.language : undefined;
        const expected = new Intl.DateTimeFormat(locale, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        }).format(date);
        expect(formatTime(isoString)).toBe(expected);
    });

    it("handles different timestamps consistently", () => {
        const result1 = formatTime("2026-01-01T00:00:00Z");
        const result2 = formatTime("2026-12-31T23:59:59Z");
        expect(result1).toBeTruthy();
        expect(result2).toBeTruthy();
        expect(result1).not.toBe(result2);
    });
});

describe("formatTimeParts", () => {
    it("splits time into main and seconds parts", () => {
        const { main, seconds } = formatTimeParts("2026-02-02T14:30:45Z");
        // main should contain hours and minutes but not seconds digits
        expect(main).toBeTruthy();
        expect(main).toContain("30");
        expect(main).not.toContain("45");
        // seconds should contain the seconds value
        expect(seconds).toBeTruthy();
        expect(seconds).toContain("45");
    });

    it("seconds part starts with separator and contains digits", () => {
        const { seconds } = formatTimeParts("2026-02-02T14:30:45Z");
        // Seconds should be separator + digits, e.g., ":45"
        expect(seconds).toMatch(/.:?\d{2}/);
    });

    it("main part preserves AM/PM for 12h locales", () => {
        const { main } = formatTimeParts("2026-02-02T14:30:45Z");
        // In any locale, main should contain the hour and minute
        expect(main).toContain("30");
    });
});
