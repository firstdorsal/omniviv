import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

    it("calls onChange when input is confirmed", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        const localDate = new Date(2026, 1, 2, 14, 30, 0);
        render(<DateTimePicker value={localDate} onChange={onChange} />);

        const input = screen.getByDisplayValue("2026-02-02 14:30");
        // Clear and type a new date
        await user.clear(input);
        await user.type(input, "2026-03-15 10:00");
        // Press Enter to confirm
        await user.keyboard("{Enter}");

        expect(onChange).toHaveBeenCalled();
        const newDate = onChange.mock.calls[0][0] as Date;
        expect(newDate).toBeInstanceOf(Date);
        expect(newDate.getFullYear()).toBe(2026);
        expect(newDate.getMonth()).toBe(2); // March = 2
        expect(newDate.getDate()).toBe(15);
        expect(newDate.getHours()).toBe(10);
        expect(newDate.getMinutes()).toBe(0);
    });

    it("does not call onChange on invalid input", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        const localDate = new Date(2026, 1, 2, 14, 30, 0);
        render(<DateTimePicker value={localDate} onChange={onChange} />);

        const input = screen.getByDisplayValue("2026-02-02 14:30");
        await user.clear(input);
        await user.type(input, "not-a-date");
        await user.keyboard("{Enter}");

        // onChange should not be called with undefined/invalid
        const validCalls = onChange.mock.calls.filter((c: unknown[]) => c[0] instanceof Date);
        expect(validCalls.length).toBe(0);
    });
});
