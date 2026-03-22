import * as React from "react";
import { TZDate } from "@date-fns/tz";
import type { DateRange } from "react-day-picker";
import {
    formatDateTime,
    parseDateTimeString,
    type DateTimeFormatOptions
} from "@/lib/date-time-utils";

/** A date range with optional start and end. */
interface DateTimeRange {
    from: Date | undefined;
    to: Date | undefined;
}

/** Options for the `useDateTimeRangePicker` hook. */
interface UseDateTimeRangePickerOptions {
    /** Controlled range value. Pass `undefined` for uncontrolled mode. */
    value?: DateTimeRange;
    /** Initial range when uncontrolled. */
    defaultValue?: DateTimeRange;
    /** Called when the range changes. */
    onChange?: (range: DateTimeRange) => void;
    /** Time display format. Defaults to `"24h"`. */
    timeFormat?: `12h` | `24h`;
    /** Whether to include seconds. Defaults to `false`. */
    showSeconds?: boolean;
    /** IANA timezone string. When set, dates are wrapped in `TZDate`. */
    timeZone?: string;
}

/** Return value of `useDateTimeRangePicker`. */
interface UseDateTimeRangePickerReturn {
    /** The current date range. */
    range: DateTimeRange;
    /** Text input value for the start date. */
    startInputValue: string;
    /** Text input value for the end date. */
    endInputValue: string;
    /** Whether the start input has been modified since last sync. */
    isStartDirty: boolean;
    /** Whether the end input has been modified since last sync. */
    isEndDirty: boolean;
    /** The calendar month currently displayed. */
    month: Date;
    /** Whether the popover is open. */
    isOpen: boolean;
    /** Programmatically set the range (updates inputs and month). */
    setRange: (range: DateTimeRange) => void;
    /** Update the start text input value. */
    setStartInputValue: (value: string) => void;
    /** Update the end text input value. */
    setEndInputValue: (value: string) => void;
    /** Attempt to parse and apply the start input value. */
    confirmStartInput: () => void;
    /** Attempt to parse and apply the end input value. Rejects if end < start. */
    confirmEndInput: () => void;
    /** Set the displayed calendar month. */
    setMonth: (month: Date) => void;
    /** Toggle the popover open state. */
    setIsOpen: (open: boolean) => void;
    /** Record the day the user clicked. Must be wired to Calendar's `onDayClick`. */
    handleDayClick: (day: Date) => void;
    /** Handle calendar range selection. Preserves existing times. */
    handleCalendarSelect: (range: DateRange | undefined) => void;
    /** Handle start time picker changes. */
    handleStartTimeChange: (date: Date) => void;
    /** Handle end time picker changes. */
    handleEndTimeChange: (date: Date) => void;
    /** Finalize a drag-to-resize operation. Preserves existing times. */
    handleDragEnd: (newRange: DateTimeRange) => void;
}

/**
 * Copies hours, minutes, and seconds from `source` onto `target` (mutates target).
 * Used to preserve time components when the date changes via calendar or drag.
 */
const preserveTime = (target: Date, source: Date): void => {
    target.setHours(source.getHours(), source.getMinutes(), source.getSeconds());
};

const useDateTimeRangePicker = (
    options: UseDateTimeRangePickerOptions
): UseDateTimeRangePickerReturn => {
    const {
        value: controlledValue,
        defaultValue,
        onChange,
        timeFormat = `24h`,
        showSeconds = false,
        timeZone
    } = options;

    const isControlled = controlledValue !== undefined;
    const formatOptions = React.useMemo<DateTimeFormatOptions>(
        () => ({ timeFormat, showSeconds }),
        [timeFormat, showSeconds]
    );

    const [internalRange, setInternalRange] = React.useState<DateTimeRange>(
        defaultValue ?? { from: undefined, to: undefined }
    );
    const range = isControlled ? controlledValue : internalRange;

    const [startInputValue, setStartInputValue] = React.useState(
        range.from ? formatDateTime(range.from, formatOptions) : ``
    );
    const [endInputValue, setEndInputValue] = React.useState(
        range.to ? formatDateTime(range.to, formatOptions) : ``
    );
    const [isStartDirty, setIsStartDirty] = React.useState(false);
    const [isEndDirty, setIsEndDirty] = React.useState(false);
    const [month, setMonth] = React.useState(range.from ?? new Date());
    const [isOpen, setIsOpen] = React.useState(false);

    const updateRange = React.useCallback(
        (newRange: DateTimeRange) => {
            if (!isControlled) {
                setInternalRange(newRange);
            }
            onChange?.(newRange);
        },
        [isControlled, onChange]
    );

    const formatDate = React.useCallback(
        (d: Date | undefined): string => (d ? formatDateTime(d, formatOptions) : ``),
        [formatOptions]
    );

    // Sync inputs when controlled value changes
    const prevControlledRef = React.useRef(controlledValue);
    React.useEffect(() => {
        if (isControlled && controlledValue !== prevControlledRef.current) {
            setStartInputValue(formatDate(controlledValue.from));
            setEndInputValue(formatDate(controlledValue.to));
            setIsStartDirty(false);
            setIsEndDirty(false);
            if (controlledValue.from) setMonth(controlledValue.from);
        }
        prevControlledRef.current = controlledValue;
    }, [controlledValue, isControlled, formatDate]);

    const wrapTZ = React.useCallback(
        (d: Date): Date => (timeZone ? new TZDate(d, timeZone) : d),
        [timeZone]
    );

    const handleSetStartInput = (val: string) => {
        setStartInputValue(val);
        setIsStartDirty(true);
    };

    const handleSetEndInput = (val: string) => {
        setEndInputValue(val);
        setIsEndDirty(true);
    };

    const confirmStartInput = () => {
        if (!isStartDirty) return;
        const referenceDate = timeZone ? new TZDate(new Date(), timeZone) : new Date();
        const parsed = parseDateTimeString(startInputValue, formatOptions, referenceDate);
        if (parsed) {
            const finalDate = wrapTZ(parsed);
            const newRange = { ...range, from: finalDate };
            updateRange(newRange);
            setMonth(finalDate);
            setStartInputValue(formatDate(finalDate));
            setIsStartDirty(false);
        } else {
            setStartInputValue(formatDate(range.from));
            setIsStartDirty(false);
        }
    };

    const confirmEndInput = () => {
        if (!isEndDirty) return;
        const referenceDate = timeZone ? new TZDate(new Date(), timeZone) : new Date();
        const parsed = parseDateTimeString(endInputValue, formatOptions, referenceDate);
        if (parsed) {
            const finalDate = wrapTZ(parsed);
            // Validate end >= start
            if (range.from && finalDate < range.from) {
                setEndInputValue(formatDate(range.to));
                setIsEndDirty(false);
                return;
            }
            const newRange = { ...range, to: finalDate };
            updateRange(newRange);
            setEndInputValue(formatDate(finalDate));
            setIsEndDirty(false);
        } else {
            setEndInputValue(formatDate(range.to));
            setIsEndDirty(false);
        }
    };

    // Tracks the exact day the user clicked, set by `handleDayClick` which
    // fires (via rdp's `onDayClick`) before `handleCalendarSelect`.
    const lastClickedDayRef = React.useRef<Date | undefined>(undefined);

    const handleDayClick = (day: Date) => {
        lastClickedDayRef.current = day;
    };

    const handleCalendarSelect = (dateRange: DateRange | undefined) => {
        const clickedDay = lastClickedDayRef.current;
        lastClickedDayRef.current = undefined;

        if (!dateRange) {
            updateRange({ from: undefined, to: undefined });
            setStartInputValue(``);
            setEndInputValue(``);
            setIsStartDirty(false);
            setIsEndDirty(false);
            return;
        }

        // 3-click cycle: only accept rdp's "to" value when we are explicitly
        // in the "selecting end" phase — i.e. "from" is set but "to" is not.
        // In all other cases (empty range, or complete range), the click sets
        // a new "from" and clears "to".
        const isSelectingTo = range.from !== undefined && range.to === undefined;

        let newFrom: Date | undefined;
        let newTo: Date | undefined;

        if (isSelectingTo) {
            newFrom = dateRange.from ? new Date(dateRange.from) : undefined;
            newTo = dateRange.to ? new Date(dateRange.to) : undefined;
        } else {
            // Use the actual clicked day (from onDayClick) as the new "from",
            // falling back to rdp's from value.
            newFrom = clickedDay
                ? new Date(clickedDay)
                : (dateRange.from ? new Date(dateRange.from) : undefined);
            newTo = undefined;
        }

        // Preserve existing times
        if (newFrom && range.from) preserveTime(newFrom, range.from);
        if (newTo && range.to) preserveTime(newTo, range.to);

        const finalFrom = newFrom ? wrapTZ(newFrom) : undefined;
        const finalTo = newTo ? wrapTZ(newTo) : undefined;
        const newRange = { from: finalFrom, to: finalTo };

        updateRange(newRange);
        setStartInputValue(formatDate(finalFrom));
        setEndInputValue(formatDate(finalTo));
        setIsStartDirty(false);
        setIsEndDirty(false);
    };

    const handleStartTimeChange = (newDate: Date) => {
        const finalDate = wrapTZ(newDate);
        const newRange = { ...range, from: finalDate };
        updateRange(newRange);
        setStartInputValue(formatDate(finalDate));
        setIsStartDirty(false);
    };

    const handleEndTimeChange = (newDate: Date) => {
        const finalDate = wrapTZ(newDate);
        const newRange = { ...range, to: finalDate };
        updateRange(newRange);
        setEndInputValue(formatDate(finalDate));
        setIsEndDirty(false);
    };

    const handleDragEnd = (newRange: DateTimeRange) => {
        const newFrom = newRange.from ? new Date(newRange.from) : undefined;
        const newTo = newRange.to ? new Date(newRange.to) : undefined;

        // Preserve existing times from the original range
        if (newFrom && range.from) preserveTime(newFrom, range.from);
        if (newTo && range.to) preserveTime(newTo, range.to);

        const finalFrom = newFrom ? wrapTZ(newFrom) : undefined;
        const finalTo = newTo ? wrapTZ(newTo) : undefined;
        const finalRange = { from: finalFrom, to: finalTo };

        updateRange(finalRange);
        setStartInputValue(formatDate(finalFrom));
        setEndInputValue(formatDate(finalTo));
        setIsStartDirty(false);
        setIsEndDirty(false);
    };

    const setRangeExposed = (newRange: DateTimeRange) => {
        updateRange(newRange);
        setStartInputValue(formatDate(newRange.from));
        setEndInputValue(formatDate(newRange.to));
        setIsStartDirty(false);
        setIsEndDirty(false);
        if (newRange.from) setMonth(newRange.from);
    };

    return {
        range,
        startInputValue,
        endInputValue,
        isStartDirty,
        isEndDirty,
        month,
        isOpen,
        setRange: setRangeExposed,
        setStartInputValue: handleSetStartInput,
        setEndInputValue: handleSetEndInput,
        confirmStartInput,
        confirmEndInput,
        setMonth,
        setIsOpen,
        handleDayClick,
        handleCalendarSelect,
        handleStartTimeChange,
        handleEndTimeChange,
        handleDragEnd
    };
};

export { useDateTimeRangePicker };
export type { DateTimeRange, UseDateTimeRangePickerOptions, UseDateTimeRangePickerReturn };
