import { format, isValid, parse } from "date-fns";

/** Options controlling the date-time string format. */
interface DateTimeFormatOptions {
    /** Whether to use 12-hour or 24-hour time display. */
    timeFormat: `12h` | `24h`;
    /** Whether to include seconds in the time display. */
    showSeconds: boolean;
}

/**
 * Returns the date-fns format string for the given options.
 * E.g. `"yyyy-MM-dd HH:mm"` for 24h without seconds.
 */
const getFormatString = (options: DateTimeFormatOptions): string => {
    const { timeFormat, showSeconds } = options;
    const timePart =
        timeFormat === `12h`
            ? showSeconds
                ? `hh:mm:ss a`
                : `hh:mm a`
            : showSeconds
              ? `HH:mm:ss`
              : `HH:mm`;
    return `yyyy-MM-dd ${timePart}`;
};

/**
 * Returns a human-readable placeholder string for the given format options.
 * E.g. `"yyyy-MM-dd HH:mm"` or `"yyyy-MM-dd hh:mm:ss AM/PM"`.
 */
const getPlaceholder = (options: DateTimeFormatOptions): string => {
    const { timeFormat, showSeconds } = options;
    if (timeFormat === `24h`) {
        return showSeconds ? `yyyy-MM-dd HH:mm:ss` : `yyyy-MM-dd HH:mm`;
    }
    return showSeconds ? `yyyy-MM-dd hh:mm:ss AM/PM` : `yyyy-MM-dd hh:mm AM/PM`;
};

/**
 * Parses a date-time string using the format defined by the given options.
 *
 * @param input - The date-time string to parse.
 * @param options - Format options controlling the expected input format.
 * @param referenceDate - Base date used by date-fns for missing components.
 * @returns The parsed Date, or null if the input is invalid.
 */
const parseDateTimeString = (
    input: string,
    options: DateTimeFormatOptions,
    referenceDate: Date
): Date | null => {
    const formatStr = getFormatString(options);
    const parsed = parse(input.trim(), formatStr, referenceDate);
    return isValid(parsed) ? parsed : null;
};

/**
 * Formats a Date into a string using the format defined by the given options.
 *
 * @param date - The date to format.
 * @param options - Format options controlling the output format.
 * @returns The formatted date-time string.
 */
const formatDateTime = (
    date: Date,
    options: DateTimeFormatOptions
): string => {
    const formatStr = getFormatString(options);
    return format(date, formatStr);
};

/**
 * Detects the user's locale-preferred time format by inspecting
 * `Intl.DateTimeFormat`. Falls back to 24h on error.
 */
const detectTimeFormat = (): `12h` | `24h` => {
    try {
        const resolved = new Intl.DateTimeFormat(undefined, {
            hour: `numeric`
        }).resolvedOptions();
        return resolved.hourCycle === `h11` || resolved.hourCycle === `h12`
            ? `12h`
            : `24h`;
    } catch {
        return `24h`;
    }
};

let cachedDetectedFormat: `12h` | `24h` | null = null;

/**
 * Returns the detected locale time format, cached after first call.
 * Uses `detectTimeFormat()` internally.
 */
const getDetectedTimeFormat = (): `12h` | `24h` => {
    if (cachedDetectedFormat === null) {
        cachedDetectedFormat = detectTimeFormat();
    }
    return cachedDetectedFormat;
};

export {
    formatDateTime,
    getDetectedTimeFormat,
    getFormatString,
    getPlaceholder,
    parseDateTimeString
};
export type { DateTimeFormatOptions };
