# Architecture

## Overview

Omniviv is a real-time public transport visualization platform consisting of four main services:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│    Frontend     │────▶│       API       │────▶│     Martin      │
│    (React)      │◀────│     (Rust)      │     │  (Tile Server)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                        ▲
        │    WebSocket          │                        │ MBTiles
        │◀──────────────────────│               ┌────────┴────────┐
                                │               │     Tilegen     │
                         ┌──────┴──────┐        │  (Tile Builder) │
                         │ PostgreSQL  │◀───────└─────────────────┘
                         │  Database   │
                         └─────────────┘
                                │
                         ┌──────┴──────┐
                         │  External   │
                         │    APIs     │
                         │(GTFS-RT,OSM)│
                         └─────────────┘
```

## Services

### Frontend (web/)

- **Framework**: React 19 with TypeScript
- **Build Tool**: Vite 7
- **Styling**: Tailwind CSS 4 with shadcn/ui components
- **Map**: MapLibre GL for 3D map visualization
- **Communication**: REST API + WebSocket for real-time updates

Key features:
- Real-time vehicle position interpolation
- 3D building extrusion
- Dark/light mode support
- Custom map controls (zoom, compass, scale)
- Station popup with departure information

### API (api/)

- **Framework**: Axum 0.8 (Rust async web framework)
- **Runtime**: Tokio
- **Database**: PostgreSQL via SQLx
- **Documentation**: OpenAPI via utoipa + utoipauto (auto-discovery), Swagger UI at `/swagger-ui/` (requires `dev-tools` feature)

#### Modules

```
api/src/
├── api/                 # REST endpoints
│   ├── departures/     # Real-time departure data
│   ├── gtfs_stops/     # GTFS stop queries
│   ├── issues/         # OSM data quality issues
│   ├── mapping/        # OSM-to-GTFS stop mapping
│   ├── routes/         # Transit route geometries
│   ├── stations/       # Station and platform info
│   ├── vehicles/       # Vehicle tracking
│   │   ├── builder.rs  # Vehicle state construction from departures
│   │   └── list.rs     # Vehicle list endpoint
│   ├── ws.rs           # WebSocket handlers
│   ├── schedule_cache.rs # TTL-based schedule cache
│   ├── state.rs        # Shared application state (AppState)
│   ├── utils.rs        # API utility functions
│   └── error.rs        # API error types
├── providers/          # External data sources
│   └── timetables/     # Timetable API integrations
│       └── gtfs/
│           ├── mod.rs              # GtfsProvider (schedule + RT)
│           ├── static_data/        # GTFS ZIP download, parsing, and mapping
│           │   ├── mod.rs          # Module re-exports
│           │   ├── types.rs        # GTFS data types
│           │   ├── csv.rs          # CSV parsing from GTFS ZIP
│           │   ├── db.rs           # Schedule DB load/query
│           │   ├── download.rs     # ZIP download with HTTP caching
│           │   ├── mapping.rs      # OSM-to-GTFS stop mapping logic
│           │   └── utils.rs        # Internal utilities
│           ├── realtime.rs         # GTFS-RT protobuf processing
│           └── error.rs            # GTFS error types
├── sync/               # Background synchronization
│   ├── mod.rs          # SyncManager orchestration
│   ├── types.rs        # Shared types (Departure, etc.)
│   └── issues.rs       # Issue detection
├── config.rs           # Configuration management
├── openapi.rs          # OpenAPI spec definition (utoipauto auto-discovery)
├── bin/
│   └── generate_openapi.rs  # Build-time OpenAPI JSON generator
└── main.rs             # Application entry point
```

### Martin (Tile Server)

- **Image**: `ghcr.io/maplibre/martin`
- Serves pre-generated vector tiles (MBTiles) for the map — `auto_publish: false` (no SQL functions exposed)
- Serves fonts for map labels and sprites for POI icons
- Auto-discovers MBTiles files from `/mbtiles` (basemap) and `/tiles/transit` (transit layers)
- Configured with caching headers via Traefik

### Tilegen (Tile Builder)

- **Image**: `ghcr.io/firstdorsal/omniviv-tilegen`
- Pre-generates transit vector tiles from PostGIS using `martin-cp`
- Pre-generates basemap tiles from OSM PBF using Planetiler
- Configured via `tilegen.yaml` with per-layer bbox, zoom range, and regen interval
- Tracks generation state in PostgreSQL (`tile_generation_state` table)
- Runs on a configurable interval (`check_interval`), regenerating layers whose interval has elapsed

## Data Flow

### Initial Load
1. Frontend loads configuration from `/config.json`
2. Frontend loads route colors/types from `/api/routes/colors`
3. Stations and route line geometry are loaded via Martin vector tiles (not API)
4. Frontend renders map with stations and routes from vector tiles

### Vehicle Display (Viewport-Aware)
1. Map fires viewport changes (bbox + zoom) on pan/zoom
2. Frontend queries `POST /api/routes/visible` with bbox and zoom (debounced 300ms)
3. Only routes with `min_zoom <= zoom` in the viewport are returned
4. Frontend subscribes to those route IDs via WebSocket (`/api/ws/vehicles`)
5. Tracked/pinned vehicles are always included in the subscription regardless of viewport

### Real-time Updates
1. SyncManager loads static GTFS schedule on startup (downloaded ZIP, cached on disk)
2. GTFS-RT protobuf feed is polled every 15 seconds for real-time trip updates
3. Schedule-only departures are generated for trips without RT data
4. Vehicle positions are calculated from departure/arrival times
5. Updates broadcast via WebSocket (`/api/ws/vehicles`)
6. Frontend interpolates vehicle positions between updates using route geometry

### OSM Data Sync

OSM data is sourced from two paths:

- **Stations, platforms, stop positions**: Fetched live from the Overpass API per configured area bounding box. This provides fine-grained stop-level topology.
- **Routes and route geometry**: Imported Germany-wide from a PBF extract via `osm2pgsql` (runs as a separate init container). This provides route relations with their full geometry (ways).

Both data sources are stored in PostgreSQL. During sync:
1. On startup, API fetches stop-level data from Overpass API for each configured area
2. Route data is already present from the PBF import (route_stops, route_ways)
3. Relations between stations, platforms, and routes are resolved
4. Missing stop references are tracked as issues
5. `min_zoom` is precomputed per station for fast tile rendering

## WebSocket Channels

### `/api/ws/vehicles`
Real-time vehicle position updates for the map.

## Health Checks

### API Health (`/api/health`)

Returns the service health status including GTFS schedule load state:
```json
{
    "healthy": true,
    "gtfs_schedule_loaded": true,
    "gtfs_stop_count": 680000,
    "gtfs_route_count": 25000,
    "gtfs_trip_count": 1500000,
    "ifopt_mapping_count": 150
}
```

`healthy` is `true` only when the database is reachable. Reachability is
checked with a `SELECT 1` query that must complete within a 2-second timeout.
If the timeout is exceeded or the query fails, `healthy` is `false`.

### Infrastructure Health

Docker Compose configures health checks for each service:

| Service | Endpoint | Check | Interval | Timeout |
|---------|----------|-------|----------|---------|
| API | `/api/health` | HTTP 200 | 30s | 10s |
| Web | `/` | HTTP 200 | 30s | 5s |
| Martin | `/health` | HTTP 200 | 30s | 5s |

## Database Schema

PostgreSQL stores:

**Migration structure:**
- `0001_init.sql` — all tables (OSM data, GTFS data, mapping tables, PostGIS vector tile functions)
- `0002_gtfs_agencies.sql` — adds the `gtfs_agencies` table and the `agency_id` column on `gtfs_routes`

**OSM data tables (`0001_init.sql`):**
- **stations**: Transit stations with coordinates; has a `geom` (Point) column for PostGIS queries
- **platforms**: Platform nodes within stations; has a `geom` (Point) column
- **platform_ways**: Physical platform outlines stored as centroids (separate from `platforms` to avoid OSM node/way ID collisions); has a `geom` (Point) column
- **stop_positions**: Exact stop locations
- **routes**: Transit routes with geometry
- **route_ways**: Route geometry as ordered way segments
- **route_stops**: Stop sequence for each route

**GTFS data tables (`0001_init.sql` + `0002_gtfs_agencies.sql`):**
- **gtfs_stops**: GTFS stops from stops.txt (~680k rows for the Germany feed); has a `geom` (Point) column populated from lat/lon after insert
- **gtfs_routes**: GTFS routes from routes.txt; includes `route_color` and `agency_id` columns
- **gtfs_trips**: GTFS trips from trips.txt (~1.5M rows)
- **gtfs_stop_times**: GTFS stop times from stop_times.txt (~31.5M rows)
- **gtfs_calendar**: Service calendars from calendar.txt
- **gtfs_calendar_dates**: Calendar exceptions from calendar_dates.txt
- **gtfs_agencies**: Transit agencies from agency.txt (`agency_id`, `agency_name`)
- **gtfs_feed_meta**: Singleton row tracking GTFS load state and counts

**OSM-to-GTFS mapping tables (`0001_init.sql`):**
- **osm_gtfs_stop_mapping**: Primary mapping table keyed by `osm_id` + `osm_type`; maps OSM platforms and stop positions to GTFS stops with `match_method`, `match_score`, and optional `ref_ifopt` metadata
- **osm_gtfs_route_mapping**: Maps OSM route relations to GTFS routes by `ref` match, stop overlap, or manual assignment

**Legacy mapping table (`0001_init.sql`, transitional):**
- **ifopt_gtfs_mapping**: IFOPT-to-GTFS stop mappings keyed by IFOPT string; kept during the migration period to `osm_gtfs_stop_mapping`

Departures for real-time display are held in-memory (DepartureStore), while the full GTFS
static schedule is stored in PostgreSQL and cached in-memory per stop with a 5-minute TTL
(ScheduleCache) to avoid per-request DB rebuilds during time simulation.

## WebSocket Limits

- Maximum 100 route subscriptions per connection

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `ADMIN_API_KEY` | No | API key for `/api/mapping/*` write endpoints. Minimum 16 characters recommended. Supports `ADMIN_API_KEY_FILE` convention for reading from a file. |

### API (`config.yaml`)
```yaml
cors_permissive: true  # For development

gtfs_sync:
    static_feed_url: "https://download.gtfs.de/germany/free/latest.zip"
    realtime_feed_url: "https://realtime.gtfs.de/realtime-free.pb"
    cache_dir: "./data/gtfs"
    timezone: "Europe/Berlin"        # IANA timezone for GTFS schedule times (default: Europe/Berlin)
    static_refresh_hours: 24         # Re-download interval (default: 24)
    realtime_interval_secs: 15
    time_horizon_minutes: 120
```

### Frontend (`config.json`)
```json
{
    "apiUrl": "http://localhost:3000",
    "martinUrl": "http://localhost:3001"
}
```

## Resource Requirements

### API Service

| Resource | Minimum | Recommended | Notes |
|----------|---------|-------------|-------|
| Memory | 512 MB | 1 GB | Higher for larger GTFS feeds |
| CPU | 1 core | 2 cores | Burst during sync operations |
| Disk | 500 MB | 2 GB | GTFS cache, PostgreSQL data |

The 1 GB memory limit (as configured in docker-compose) accommodates:
- GTFS static schedule import processing
- GTFS-RT protobuf parsing overhead
- PostgreSQL connection pool and query buffers

### Web Service

| Resource | Minimum | Notes |
|----------|---------|-------|
| Memory | 256 MB | Static file serving only |
| CPU | 0.5 core | [feoco](https://github.com/pektin-dns/feoco) serving static assets |

## Development Setup

### Prerequisites

- **Rust** (latest stable): Install via [rustup](https://rustup.rs/)
- **Node.js** (23+): For frontend development
- **pnpm** (9.x): Package manager for frontend
