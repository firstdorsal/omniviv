# AI Test: All durations must use the Duration component

## Rule

Every place in the codebase that displays a time duration to the user **must** use the `Duration` component from `src/components/Duration.tsx`. Raw formatting like `` `${minutes} min` `` or manual hour/minute calculations rendered inline are not allowed.

## Why

The `Duration` component ensures consistent formatting:
- Durations over 60 minutes are shown as `Xh YY` (with zero-padded minutes)
- The "min" suffix is responsive (hidden on narrow containers)
- Tabular number formatting is applied for alignment

Without this component, durations like 257 minutes would display as "257 min" instead of "4h 17 min".

## How to verify

1. Search the entire `web/src/` directory for patterns that format durations without the `Duration` component:
   - `Math.round(*.duration / 60)` followed by `min` in the same JSX expression
   - `Math.floor(*.duration / 60)` used for hour/minute display without `<Duration>`
   - Template literals or string concatenation containing `min` near a `/60` or `/ 60` division
   - Any `.duration` property being divided by 60 and rendered directly in JSX

2. Confirm that every file importing or using a `duration` field in a rendered context also imports `Duration` from `./Duration` or `../Duration` (path may vary).

3. Allowed exceptions:
   - Non-rendered calculations (e.g., sorting, filtering, comparing durations)
   - Test files that assert on duration values
   - Duration values passed as props to the `Duration` component itself
   - **Signed delays** (e.g. "+3 min", "-1 min") that represent schedule deviation, not trip duration — these use a sign prefix which `Duration` does not support
   - **Relative countdown timers** (e.g. "5 min" until departure, "jetzt", "30 s") that show time remaining until an event — these have different formatting rules (seconds, "jetzt" threshold, switch to absolute time after 59 min)

## Expected result

Zero violations. Every user-visible duration in the app renders through the `Duration` component.

## Files to check

- `src/components/NavigationPanel.tsx` — route itinerary leg durations
- `src/components/DepartureTable.tsx` — departure time displays
- `src/components/DepartureMonitor.tsx` — departure monitors
- Any other component that receives a `duration` field (in seconds) and displays it
