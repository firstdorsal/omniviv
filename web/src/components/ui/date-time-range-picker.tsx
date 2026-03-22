import * as React from "react";
import type { DayButton } from "react-day-picker";

import { cn } from "@/lib/utils";
import {
    Popover,
    PopoverAnchor,
    PopoverContent
} from "@/components/ui/popover";
import { Calendar, CalendarDayButton } from "@/components/ui/calendar";
import { DateTimeInput } from "@/components/ui/date-time-input";
import { TimePicker } from "@/components/ui/time-picker";
import { TimezoneSelector } from "@/components/ui/timezone-selector";
import {
    useDateTimeRangePicker,
    type DateTimeRange
} from "@/hooks/use-date-time-range-picker";
import {
    getDetectedTimeFormat,
    getPlaceholder
} from "@/lib/date-time-utils";

// ---------------------------------------------------------------------------
// Drag range types & context
// ---------------------------------------------------------------------------

interface DragState {
    isDragging: boolean;
    draggingEndpoint: `start` | `end` | null;
    previewRange: DateTimeRange | null;
    originalRange: DateTimeRange | null;
    startDay: Date | null;
    hasMoved: boolean;
}

const initialDragState: DragState = {
    isDragging: false,
    draggingEndpoint: null,
    previewRange: null,
    originalRange: null,
    startDay: null,
    hasMoved: false
};

interface DragContextValue {
    dragState: DragState;
    startDrag: (
        endpoint: `start` | `end`,
        originalRange: DateTimeRange,
        day: Date
    ) => void;
    updatePreview: (day: Date) => void;
    finishDrag: () => void;
    justFinishedDrag: React.RefObject<boolean>;
    /** Record the clicked day so `handleCalendarSelect` knows the exact target. */
    onDayClick: (day: Date) => void;
    disableFuture?: boolean;
    isDisabled?: boolean;
    currentRange: DateTimeRange;
}

const DragRangeContext = React.createContext<DragContextValue | null>(null);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isSameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

const stripTime = (d: Date): Date => {
    const stripped = new Date(d);
    stripped.setHours(0, 0, 0, 0);
    return stripped;
};

// Milliseconds per day for duration calculations
const MS_PER_DAY = 86_400_000;

// Stable style object to avoid re-creating on every render
const touchActionStyle = { touchAction: `none` } as const;
const touchActionNoSelectStyle = {
    touchAction: `none`,
    userSelect: `none`
} as const;

// ---------------------------------------------------------------------------
// DraggableDayButton
// ---------------------------------------------------------------------------

/**
 * Wraps `CalendarDayButton` with pointer event handlers for drag-to-resize
 * on range endpoints. Communicates with the parent via `DragRangeContext`.
 *
 * If the user clicks without moving (no drag), the click propagates normally
 * to react-day-picker's built-in selection handler. If a drag occurs,
 * `handleClickCapture` suppresses the click via the `justFinishedDrag` ref.
 */
const DraggableDayButton = (props: React.ComponentProps<typeof DayButton>) => {
    const dragContext = React.useContext(DragRangeContext);
    const { day, modifiers, ...rest } = props;

    const handlePointerDown = (e: React.PointerEvent) => {
        if (!dragContext || dragContext.isDisabled) return;
        if (modifiers.disabled) return;
        if (e.button !== 0) return;

        // Only support drag on endpoints of a complete range
        const hasCompleteRange =
            dragContext.currentRange.from !== undefined &&
            dragContext.currentRange.to !== undefined;
        if (!hasCompleteRange) return;

        const isStart = modifiers.range_start;
        const isEnd = modifiers.range_end;
        if (!isStart && !isEnd) return;

        let endpoint: `start` | `end`;
        if (isStart && isEnd) {
            // Single-day range — drag to extend the end
            endpoint = `end`;
        } else if (isStart) {
            endpoint = `start`;
        } else {
            endpoint = `end`;
        }

        // We intentionally do NOT call e.preventDefault() here so that
        // a click without drag movement still propagates to rdp's button
        // handler for normal range selection. For actual drags,
        // handleClickCapture suppresses the click via justFinishedDrag.
        dragContext.startDrag(endpoint, { ...dragContext.currentRange }, day.date);
    };

    const handlePointerOver = () => {
        if (!dragContext || !dragContext.dragState.isDragging) return;
        if (modifiers.disabled) return;

        if (dragContext.disableFuture) {
            const endOfToday = new Date();
            endOfToday.setHours(23, 59, 59, 999);
            if (day.date > endOfToday) return;
        }

        dragContext.updatePreview(day.date);
    };

    const handlePointerUp = () => {
        if (!dragContext || !dragContext.dragState.isDragging) return;
        dragContext.finishDrag();
    };

    const handleClickCapture = (e: React.MouseEvent) => {
        // Capture phase fires BEFORE rdp's button onClick (bubble phase),
        // so record the clicked day here for handleCalendarSelect to use.
        dragContext?.onDayClick(day.date);

        // Suppress the click after a drag-to-resize so rdp doesn't also
        // process it as a normal range selection.
        if (dragContext?.justFinishedDrag.current) {
            e.preventDefault();
            e.stopPropagation();
        }
    };

    const isEndpoint = modifiers.range_start || modifiers.range_end;
    const hasCompleteRange =
        dragContext &&
        dragContext.currentRange.from !== undefined &&
        dragContext.currentRange.to !== undefined;

    return (
        <span
            onPointerDown={handlePointerDown}
            onPointerOver={handlePointerOver}
            onPointerUp={handlePointerUp}
            onClickCapture={handleClickCapture}
            className={cn(
                `inline-flex`,
                !dragContext?.isDisabled &&
                    !modifiers.disabled &&
                    hasCompleteRange &&
                    isEndpoint &&
                    !dragContext?.dragState.isDragging &&
                    `cursor-grab [&_button]:cursor-grab`,
                dragContext?.dragState.isDragging &&
                    `cursor-grabbing [&_button]:cursor-grabbing`
            )}
            style={
                dragContext?.dragState.isDragging
                    ? touchActionNoSelectStyle
                    : touchActionStyle
            }
        >
            <CalendarDayButton day={day} modifiers={modifiers} {...rest} />
        </span>
    );
};

// ---------------------------------------------------------------------------
// DateTimeRangePickerProps
// ---------------------------------------------------------------------------

/** Props for the `DateTimeRangePicker` component. */
interface DateTimeRangePickerProps {
    /** Controlled range value. Omit for uncontrolled mode. */
    value?: DateTimeRange;
    /** Initial range when uncontrolled. */
    defaultValue?: DateTimeRange;
    /** Called when the range changes. */
    onChange?: (range: DateTimeRange) => void;
    /** Time display format. Defaults to the user's locale preference. */
    timeFormat?: `12h` | `24h`;
    /** Whether to show a seconds column. Defaults to `false`. */
    showSeconds?: boolean;
    /** Whether to show the timezone selector. Defaults to `false`. */
    showTimezone?: boolean;
    /** IANA timezone string (e.g. `"America/New_York"`). */
    timeZone?: string;
    /** Called when the user changes the timezone. */
    onTimezoneChange?: (tz: string) => void;
    /** Position of the time pickers relative to the calendar. */
    timeLayout?: `below` | `beside`;
    /** Custom placeholder for the start date input. */
    startPlaceholder?: string;
    /** Custom placeholder for the end date input. */
    endPlaceholder?: string;
    /** Disables the entire picker. */
    disabled?: boolean;
    /** Prevents selecting dates in the future. */
    disableFuture?: boolean;
    /** Show a days/nights duration summary below the inputs. */
    showDuration?: boolean;
    /** Additional CSS class for the root element. */
    className?: string;
}

// ---------------------------------------------------------------------------
// DateTimeRangePicker
// ---------------------------------------------------------------------------

const DateTimeRangePicker = ({
    value,
    defaultValue,
    onChange,
    timeFormat = getDetectedTimeFormat(),
    showSeconds = false,
    showTimezone = false,
    timeZone,
    onTimezoneChange,
    timeLayout = `below`,
    startPlaceholder,
    endPlaceholder,
    disabled,
    disableFuture,
    showDuration,
    className
}: DateTimeRangePickerProps) => {
    const picker = useDateTimeRangePicker({
        value,
        defaultValue,
        onChange,
        timeFormat,
        showSeconds,
        timeZone
    });

    // ---- Drag state ----------------------------------------------------------

    const [dragState, setDragState] = React.useState<DragState>(initialDragState);
    const dragStateRef = React.useRef(dragState);
    dragStateRef.current = dragState;

    const justFinishedDrag = React.useRef(false);

    // Keep a stable ref to handleDragEnd so finishDrag has zero dependencies
    const handleDragEndRef = React.useRef(picker.handleDragEnd);
    handleDragEndRef.current = picker.handleDragEnd;

    const startDrag = React.useCallback(
        (
            endpoint: `start` | `end`,
            originalRange: DateTimeRange,
            day: Date
        ) => {
            setDragState({
                isDragging: true,
                draggingEndpoint: endpoint,
                previewRange: null,
                originalRange,
                startDay: day,
                hasMoved: false
            });
        },
        []
    );

    const updatePreview = React.useCallback((day: Date) => {
        setDragState((prev) => {
            if (!prev.isDragging || !prev.originalRange) return prev;

            const moved = prev.startDay ? !isSameDay(day, prev.startDay) : true;
            if (!moved && !prev.hasMoved) return prev;

            let from: Date | undefined;
            let to: Date | undefined;

            if (prev.draggingEndpoint === `start`) {
                from = day;
                to = prev.originalRange.to;
            } else {
                from = prev.originalRange.from;
                to = day;
            }

            // Auto-swap so from <= to
            if (from && to && stripTime(from) > stripTime(to)) {
                [from, to] = [to, from];
            }

            return {
                ...prev,
                hasMoved: true,
                previewRange: { from, to }
            };
        });
    }, []);

    const finishDrag = React.useCallback(() => {
        const prev = dragStateRef.current;

        if (!prev.isDragging) return;

        if (prev.hasMoved && prev.previewRange) {
            handleDragEndRef.current(prev.previewRange);
            justFinishedDrag.current = true;
            requestAnimationFrame(() => {
                justFinishedDrag.current = false;
            });
        }

        setDragState(initialDragState);
    }, []);

    const cancelDrag = React.useCallback(() => {
        setDragState(initialDragState);
    }, []);

    // Global pointerup safety net
    React.useEffect(() => {
        if (!dragState.isDragging) return;

        const onPointerUp = () => finishDrag();
        window.addEventListener(`pointerup`, onPointerUp);
        return () => window.removeEventListener(`pointerup`, onPointerUp);
    }, [dragState.isDragging, finishDrag]);

    // Cancel drag when popover closes
    React.useEffect(() => {
        if (!picker.isOpen && dragState.isDragging) cancelDrag();
    }, [picker.isOpen, dragState.isDragging, cancelDrag]);

    // Cancel drag on month navigation
    const { setMonth: pickerSetMonth } = picker;
    const handleMonthChange = React.useCallback(
        (month: Date) => {
            if (dragStateRef.current.isDragging) cancelDrag();
            pickerSetMonth(month);
        },
        [cancelDrag, pickerSetMonth]
    );

    // ---- Drag context value --------------------------------------------------

    const dragContextValue = React.useMemo<DragContextValue>(
        () => ({
            dragState,
            startDrag,
            updatePreview,
            finishDrag,
            justFinishedDrag,
            onDayClick: picker.handleDayClick,
            disableFuture,
            isDisabled: disabled,
            currentRange: picker.range
        }),
        [
            dragState,
            startDrag,
            updatePreview,
            finishDrag,
            picker.handleDayClick,
            disableFuture,
            disabled,
            picker.range
        ]
    );

    // ---- Display range -------------------------------------------------------

    const displayRange =
        dragState.isDragging && dragState.previewRange
            ? dragState.previewRange
            : picker.range;

    // ---- Placeholder ---------------------------------------------------------

    const placeholderBase = getPlaceholder({ timeFormat, showSeconds });

    // ---- Duration ------------------------------------------------------------

    const durationText = React.useMemo(() => {
        if (!picker.range.from || !picker.range.to) return null;
        const nights = Math.floor(
            (stripTime(picker.range.to).getTime() -
                stripTime(picker.range.from).getTime()) /
                MS_PER_DAY
        );
        if (nights < 0) return null;
        const days = nights + 1;
        return `${days} day${days !== 1 ? `s` : ``}, ${nights} night${nights !== 1 ? `s` : ``}`;
    }, [picker.range.from, picker.range.to]);

    // ---- Render --------------------------------------------------------------

    return (
        <Popover open={picker.isOpen} onOpenChange={picker.setIsOpen}>
            <PopoverAnchor asChild={true}>
                <div
                    className={cn(
                        `flex flex-col gap-2 sm:flex-row sm:items-center`,
                        className
                    )}
                >
                    <div className={`flex-1`}>
                        <div
                            className={
                                `mb-1 text-xs font-medium text-muted-foreground`
                            }
                        >
                            Start
                        </div>
                        <DateTimeInput
                            value={picker.startInputValue}
                            onChange={picker.setStartInputValue}
                            onConfirm={picker.confirmStartInput}
                            onCalendarClick={() =>
                                picker.setIsOpen(!picker.isOpen)
                            }
                            isDirty={picker.isStartDirty}
                            placeholder={startPlaceholder ?? placeholderBase}
                            disabled={disabled}
                            aria-label={`Start date and time`}
                        />
                    </div>
                    <span
                        className={`text-muted-foreground hidden pt-5 text-sm sm:inline`}
                    >
                        &ndash;
                    </span>
                    <div className={`flex-1`}>
                        <div
                            className={
                                `mb-1 text-xs font-medium text-muted-foreground`
                            }
                        >
                            End
                        </div>
                        <DateTimeInput
                            value={picker.endInputValue}
                            onChange={picker.setEndInputValue}
                            onConfirm={picker.confirmEndInput}
                            onCalendarClick={() =>
                                picker.setIsOpen(!picker.isOpen)
                            }
                            isDirty={picker.isEndDirty}
                            placeholder={endPlaceholder ?? placeholderBase}
                            disabled={disabled}
                            aria-label={`End date and time`}
                        />
                    </div>
                </div>
            </PopoverAnchor>
            {showDuration && durationText && (
                <div className={`mt-1 text-xs text-muted-foreground`}>
                    {durationText}
                </div>
            )}
            <PopoverContent
                className={`w-auto p-0`}
                align={`start`}
                onOpenAutoFocus={(e) => e.preventDefault()}
            >
                <DragRangeContext.Provider value={dragContextValue}>
                    <div
                        className={cn(
                            `flex`,
                            timeLayout === `beside` ? `flex-row` : `flex-col`
                        )}
                    >
                        <Calendar
                            mode={`range`}
                            selected={
                                displayRange.from || displayRange.to
                                    ? {
                                          from: displayRange.from,
                                          to: displayRange.to
                                      }
                                    : undefined
                            }
                            onSelect={picker.handleCalendarSelect}
                            month={picker.month}
                            onMonthChange={handleMonthChange}
                            disabled={disabled ? () => true : undefined}
                            disableFuture={disableFuture}
                            numberOfMonths={2}
                            timeZone={timeZone}
                            components={{
                                DayButton: DraggableDayButton
                            }}
                        />
                        <div
                            className={cn(
                                `flex flex-col`,
                                timeLayout === `beside`
                                    ? `border-l`
                                    : `border-t`
                            )}
                        >
                            <div
                                className={cn(
                                    `flex flex-col gap-2 px-3 py-2`,
                                    timeLayout === `below` &&
                                        `sm:flex-row sm:gap-6`
                                )}
                            >
                                <div>
                                    <div
                                        className={`mb-1 text-xs font-medium text-muted-foreground`}
                                    >
                                        Start time
                                    </div>
                                    <TimePicker
                                        date={picker.range.from}
                                        onChange={picker.handleStartTimeChange}
                                        timeFormat={timeFormat}
                                        showSeconds={showSeconds}
                                        disabled={
                                            disabled || !picker.range.from
                                        }
                                    />
                                </div>
                                <div>
                                    <div
                                        className={`mb-1 text-xs font-medium text-muted-foreground`}
                                    >
                                        End time
                                    </div>
                                    <TimePicker
                                        date={picker.range.to}
                                        onChange={picker.handleEndTimeChange}
                                        timeFormat={timeFormat}
                                        showSeconds={showSeconds}
                                        disabled={disabled || !picker.range.to}
                                    />
                                </div>
                            </div>
                            {showTimezone && onTimezoneChange && (
                                <div className={`border-t px-3 py-2`}>
                                    <div
                                        className={`mb-1 text-xs font-medium text-muted-foreground`}
                                    >
                                        Timezone
                                    </div>
                                    <TimezoneSelector
                                        value={timeZone}
                                        onChange={onTimezoneChange}
                                        disabled={disabled}
                                    />
                                </div>
                            )}
                        </div>
                    </div>
                </DragRangeContext.Provider>
            </PopoverContent>
        </Popover>
    );
};

export { DateTimeRangePicker };
export type { DateTimeRangePickerProps };
