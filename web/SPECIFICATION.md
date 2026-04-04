# Station & Platform Marker Specification

## Overview

The map displays 4 types of transport markers, split between user-facing (Ebenen panel) and developer-only (Debug panel).

---

## User-Facing Markers (Ebenen Panel)

### 1. Haltestellen (Station Markers)

- **Toggle:** Top-level checkbox in Ebenen panel, **visible by default**
- **Layer:** `stations-circle` + `stations-label` from `stations` vector tile source-layer
- **Appearance:** Dark grey circle (6px) with station name label
- **Zoom:** Filtered by `min_zoom` property (Hbf at z6, major rail at z8, regular at z12, bus at z13)
- **Click:** Opens a popup listing all connected platforms/stop positions at that station
- **E2E:** `platform-marker-layers.e2e.test.ts` → "stations-circle renders at Königsplatz zoom 17"

### 2. Steige (Platform Markers)

- **Toggle:** Sub-checkbox under Haltestellen, **hidden by default**, disabled when Haltestellen is off
- **Layer:** `steige-circle` + `steige-label` from `steige` vector tile source-layer
- **Appearance:** Dark circle (5px) with platform name label (A1, B2, C3, etc.)
- **Zoom:** minzoom 15
- **Click:** Opens a departure monitor for that platform showing upcoming departures
- **E2E:** `platform-marker-layers.e2e.test.ts` → "enabling Steige toggle shows steige-circle markers"

#### Position Priority (precalculated in SQL)

The `steige` source-layer merges data from 3 tables with this priority:

1. **platform_ways centroids** (priority 1) — physical platform area centroids, at the passenger-side position
2. **platforms** (priority 2) — explicit platform point nodes
3. **stop_positions** (priority 3, fallback) — on-track positions, used only when no platform_way or platform with the same display_name exists at the same station

Each feature has a `source_type` property (`platform_way`, `platform`, or `stop_position`) indicating its origin.

- **E2E:** `platform-marker-layers.e2e.test.ts` → "steige features have display_name property for labeling"
- **E2E:** `platform-marker-layers.e2e.test.ts` → "steige features include fallback stop_positions where no platform exists"

#### Connection Lines

- When Steige is enabled, dashed connection lines are drawn from each platform to its parent station marker
- **Layer:** `station-connections-vector-line` from `connections` vector tile source-layer
- **E2E:** `platform-marker-layers.e2e.test.ts` → "enabling Steige also shows connection lines to station"
- **E2E:** `platform-marker-layers.e2e.test.ts` → "debug Haltepositionen does NOT show connection lines"

#### Umrisse (Platform Outlines)

- **Toggle:** Sub-sub-checkbox under Steige, **hidden by default**, disabled when Steige is off
- **Layer:** (not yet implemented — requires platform_way line geometry in tiles)
- **E2E:** `platform-marker-layers.e2e.test.ts` → "Steige sub-toggle has Umrisse sub-sub-toggle"
- **E2E:** `platform-marker-layers.e2e.test.ts` → "Umrisse is disabled when Steige is off"

### Toggle Hierarchy

```
Ebenen (Layers Panel)
├── Haltestellen ✓ (default: on)
│   ├── Steige (default: off, disabled when Haltestellen off)
│   │   └── Umrisse (default: off, disabled when Steige off)
│   └── [connection lines shown automatically with Steige]
├── Linien ✓ (default: on)
└── POIs (default: off)
```

- **E2E:** `platform-marker-layers.e2e.test.ts` → "Steige is disabled when Haltestellen is off"
- **E2E:** `layers-panel-toggle.e2e.test.ts` → "Steige and Umrisse are disabled when Haltestellen is off"
- **E2E:** `platform-marker-layers.e2e.test.ts` → "Ebenen panel does NOT show Haltepositionen"

---

## Debug Markers (Debug Panel — only visible when debug mode is on)

### 3. Haltepositionen (Raw OSM Stop Positions)

- **Toggle:** Checkbox in Debug panel under "Haltestellenmarker" section
- **Layer:** `stops-circle` + `stops-label` from `stops` vector tile source-layer
- **Appearance:** Blue circle (5px) — shows ALL OSM `stop_position` nodes (on the track/rail)
- **Purpose:** Display raw metadata for debugging stop-to-GTFS mapping
- **Click:** Opens metadata popup showing OSM properties, GTFS mapping status
- **E2E:** `platform-marker-layers.e2e.test.ts` → "enabling Haltepositionen in debug panel shows blue stops-circle markers"
- **E2E:** `platform-marker-layers.e2e.test.ts` → "debug OSM markers are NOT visible when debug mode is off"

### 4. Plattformen (Raw OSM Platform Nodes)

- **Toggle:** Checkbox in Debug panel under "Haltestellenmarker" section
- **Layer:** `platforms-vt-circle` + `platforms-vt-label` from `platforms` vector tile source-layer
- **Appearance:** Orange circle (5px) — shows ALL OSM platform nodes with markers at their center
- **Purpose:** Display raw metadata for debugging platform geometry
- **Click:** Opens metadata popup showing OSM properties
- **E2E:** `platform-marker-layers.e2e.test.ts` → "enabling raw platforms toggle shows platforms-vt-circle markers"
- **E2E:** `platform-marker-layers.e2e.test.ts` → "debug panel has raw platforms toggle for orange platform markers"

### Independence

Debug markers are fully independent from user-facing markers. Enabling user Steige does NOT show debug stops/platforms.

- **E2E:** `platform-marker-layers.e2e.test.ts` → "debug markers are independent from user-facing markers"

---

## Click Interactions

### Station Marker Click

- Clicking a `stations-circle` feature opens a `StationPopup` showing:
  - Station name
  - List of platforms and stop positions belonging to the station
  - Each platform is clickable to open its departure monitor
- **E2E:** `platform-marker-layers.e2e.test.ts` → "clicking a station marker opens station popup with platform list"

### Steige Marker Click

- Clicking a `steige-circle` feature opens a departure monitor for that platform:
  - Shows the platform name (e.g., "Königsplatz A1")
  - Lists upcoming departures with line numbers, colors, destinations, and times
- **E2E:** `platform-marker-layers.e2e.test.ts` → "clicking a steige marker opens departure monitor"

---

## Data Pipeline

```
OSM PBF → Rust sync (stop_positions, platforms, platform_ways tables)
         → PostGIS transit_stations() SQL function
         → Martin vector tiles (stations, stops, platforms, connections, steige layers)
         → MapLibre GL layers in browser
```

- **E2E:** `stop-platform-display.e2e.test.ts` → "Database has correct stop position and platform data"
- **E2E:** `stop-platform-display.e2e.test.ts` → "tile at zoom 15 contains all required source-layers"
- **E2E:** `stop-platform-display.e2e.test.ts` → "all station infrastructure layers exist"
