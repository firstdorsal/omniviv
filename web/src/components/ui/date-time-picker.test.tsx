import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DateTimePicker } from "./date-time-picker";

describe("DateTimePicker", () => {
    it("displays the local date and time, not UTC", () => {
        // Feb 2, 2026, 00:30 local time — in UTC this could be Feb 1
        const localDate = new Date(2026, 1, 2, 0, 30, 0);
        render(<DateTimePicker value={localDate} onChange={() => {}} />);

        // The new DateTimeInput renders a single text input with combined date+time
        const input = screen.getByDisplayValue("2026-02-02 00:30");
        expect(input).toBeInTheDocument();
    });

    it("displays the local time in 24h format", () => {
        const localDate = new Date(2026, 1, 2, 14, 30, 0);
        render(<DateTimePicker value={localDate} onChange={() => {}} />);

        const input = screen.getByDisplayValue("2026-02-02 14:30");
        expect(input).toBeInTheDocument();
    });

    it("handles end of year correctly", () => {
        // Dec 31 local time — in UTC could be Jan 1 next year
        const localDate = new Date(2026, 11, 31, 23, 45, 0);
        render(<DateTimePicker value={localDate} onChange={() => {}} />);

        const input = screen.getByDisplayValue("2026-12-31 23:45");
        expect(input).toBeInTheDocument();
    });
});
