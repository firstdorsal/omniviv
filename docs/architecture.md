# Architecture

## Overview

Omniviv is a real-time public transport visualization platform consisting of three main services:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│    Frontend     │────▶│       API       │────▶│     Martin      │
│    (React)      │◀────│     (Rust)      │     │  (Tile Server)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │
        │    WebSocket          │
        │◀──────────────────────│
                                │
                         ┌──────┴──────┐
                         │ PostgreSQL  │
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
- **Documentation**: OpenAPI via utoipa with Swagger UI at `/swagger-ui`

#### Modules

```
api/src/
├── api/                 # REST endpoints
│   ├── areas/          # Service area management
│   ├── departures/     # Real-time departure data
│   ├── gtfs_stops/     # GTFS stop queries for offline
│   ├── issues/         # OSM data quality issues
│   ├── offline/        # Offline bundle generation
│   │   ├── mod.rs      # Bundle endpoints
│   │   └── error.rs    # Offline error types
│   ├── routes/         # Transit route geometries
│   ├── stations/       # Station and platform info
│   ├── vehicles/       # Vehicle tracking
│   └── ws.rs           # WebSocket handlers
├── middleware/          # Request middleware
│   └── rate_limit.rs   # Rate limiting for bundle downloads
├── providers/          # External data sources
│   ├── osm.rs          # OpenStreetMap data fetching
│   └── timetables/     # Timetable API integrations
│       └── gtfs/
│           ├── mod.rs         # GtfsProvider (schedule + RT)
│           ├── static_data.rs # GTFS ZIP download/parsing
│           ├── realtime.rs    # GTFS-RT protobuf processing
│           └── error.rs       # GTFS error types
├── sync/               # Background synchronization
│   ├── mod.rs          # SyncManager orchestration
│   ├── types.rs        # Shared types (Departure, etc.)
│   └── issues.rs       # Issue detection
├── config.rs           # Configuration management
└── main.rs             # Application entry point
proto/
└── gtfs_bundle.proto   # Protobuf schema for offline bundles
```

### Martin (Tile Server)

- **Image**: `ghcr.io/maplibre/martin`
- Serves vector tiles (MBTiles format) for the map
- Serves fonts for map labels
- Configured with caching headers via Traefik

## Data Flow

### Initial Load
1. Frontend loads configuration from `/config.json`
2. Frontend requests station, route, and area data from API
3. API queries PostgreSQL database (populated by sync)
4. Frontend renders map with stations and routes

### Real-time Updates
1. SyncManager loads static GTFS schedule on startup (downloaded ZIP, cached on disk)
2. GTFS-RT protobuf feed is polled every 15 seconds for real-time trip updates
3. Schedule-only departures are generated for trips without RT data
4. Vehicle positions are calculated from departure/arrival times
5. Updates broadcast via WebSocket (`/api/ws/vehicles`)
6. Frontend interpolates vehicle positions between updates

### OSM Data Sync
1. On startup, API fetches transit data from Overpass API
2. Stations, platforms, stop positions, and routes are stored in PostgreSQL
3. Missing stop references are tracked as issues

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

### Infrastructure Health

Docker Compose configures health checks for each service:

| Service | Endpoint | Check | Interval | Timeout |
|---------|----------|-------|----------|---------|
| API | `/api/health` | HTTP 200 | 30s | 10s |
| Web | `/` | HTTP 200 | 30s | 5s |
| Martin | `/health` | HTTP 200 | 30s | 5s |

## Database Schema

PostgreSQL stores:

**OSM data tables (migration 0001):**
- **areas**: Configured service areas with bounding boxes
- **stations**: Transit stations with coordinates
- **platforms**: Platform nodes within stations
- **stop_positions**: Exact stop locations
- **routes**: Transit routes with geometry
- **route_ways**: Route geometry as ordered way segments
- **route_stops**: Stop sequence for each route

**GTFS data tables (migration 0002):**
- **gtfs_stops**: GTFS stops from stops.txt (~680k rows for the Germany feed)
- **gtfs_routes**: GTFS routes from routes.txt
- **gtfs_trips**: GTFS trips from trips.txt (~1.5M rows)
- **gtfs_stop_times**: GTFS stop times from stop_times.txt (~31.5M rows)
- **gtfs_calendar**: Service calendars from calendar.txt
- **gtfs_calendar_dates**: Calendar exceptions from calendar_dates.txt
- **ifopt_gtfs_mapping**: IFOPT-to-GTFS stop mappings (auto-generated and manual)
- **gtfs_feed_meta**: Singleton row tracking GTFS load state and counts

Departures for real-time display are held in-memory (DepartureStore), while the full GTFS
static schedule is stored in PostgreSQL and queried on demand for time simulation and offline bundles.

## Offline Subsystem

The offline subsystem enables clients to download GTFS schedule data for local storage and compute departures client-side.

### Bundle Generation

- **Endpoint**: `GET /api/offline/bundle/{area_id}`
- **Format**: Protocol Buffers (protobuf)
- **Filtering**: Only includes stops within the area bounding box and their associated trips, routes, calendars
- **Rate Limited**: ~10 requests per minute per IP via SmartIpKeyExtractor

### Frontend Storage

The frontend stores offline data in IndexedDB:
- **bundleMeta**: Bundle metadata for cache validation
- **stops**: GTFS stops indexed by area
- **routes**: GTFS routes indexed by area
- **trips**: GTFS trips indexed by area and service
- **stopTimes**: Stop times indexed by area, trip, and stop
- **calendars**: Calendar rules indexed by area
- **calendarDates**: Calendar exceptions indexed by area and service

### Schedule Engine

Client-side TypeScript implementation of departure computation:
1. Query active services for the reference date (calendar + exceptions)
2. Find stop times for requested stops within time horizon
3. Convert GTFS times (including >24h) to wall clock times
4. Apply any cached real-time delays from WebSocket updates

## Rate Limiting

The API implements rate limiting to prevent abuse, particularly on resource-intensive endpoints like bundle downloads.

### Implementation

- **Crate**: `tower_governor` (wraps the `governor` rate limiting crate for Tower/Axum)
- **Key Extractor**: `SmartIpKeyExtractor` checks headers in order:
  1. `X-Forwarded-For`
  2. `X-Real-IP`
  3. `Forwarded`
  4. Falls back to peer IP

This works correctly when running behind a reverse proxy like Traefik, which sets these headers.

### Bundle Download Limits

Endpoint: `/api/offline/bundle/{area_id}` and `/api/offline/bundle/{area_id}/meta`

- **Rate**: 1 token replenished every 6 seconds (~10 per minute)
- **Burst**: 5 requests allowed in burst
- **Response on limit**: HTTP 429 Too Many Requests

### WebSocket Limits

- Maximum 100 route subscriptions per connection
- Maximum 10 area subscriptions per connection
- No per-message rate limit (subscription limits prevent resource exhaustion)

### Troubleshooting

If rate limiting doesn't work as expected:
1. Verify Traefik/proxy is setting `X-Forwarded-For` header
2. Ensure proxy strips client-supplied headers to prevent spoofing
3. Check logs for rate limit hits

## Configuration

### API (`config.yaml`)
```yaml
cors_permissive: true  # For development
areas:
    - name: "Augsburg"
      bounding_box:
          south: 48.20
          west: 10.75
          north: 48.48
          east: 11.05
      transport_types:
          - tram

gtfs_sync:
    static_feed_url: "https://download.gtfs.de/germany/free/latest.zip"
    realtime_feed_url: "https://realtime.gtfs.de/realtime-free.pb"
    cache_dir: "./data/gtfs"
    static_refresh_hours: 24
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
- Concurrent bundle generation for multiple areas
- GTFS-RT protobuf parsing overhead
- PostgreSQL connection pool and query buffers

### Web Service

| Resource | Minimum | Notes |
|----------|---------|-------|
| Memory | 256 MB | Static file serving only |
| CPU | 0.5 core | Nginx serving static assets |

## Protobuf Schema

The offline bundle uses Protocol Buffers for compact serialization.

### Schema Location

`api/proto/gtfs_bundle.proto`

### Message Types

```protobuf
message GtfsBundle {
    BundleMeta meta = 1;
    repeated Stop stops = 2;
    repeated Route routes = 3;
    repeated Trip trips = 4;
    repeated StopTime stop_times = 5;
    repeated Calendar calendars = 6;
    repeated CalendarDate calendar_dates = 7;
}
```

See the proto file for complete field definitions.

### Estimated Bundle Sizes

| Area Type | Stops | Trips | Bundle (compressed) |
|-----------|-------|-------|---------------------|
| Small city | ~200 | ~2,000 | ~500 KB |
| Medium city | ~800 | ~8,000 | ~2 MB |
| Large city | ~2,000 | ~15,000 | ~5 MB |

## Development Setup

### Prerequisites

- **Rust** (1.83+): Install via [rustup](https://rustup.rs/)
- **Node.js** (22+): For frontend development
- **pnpm** (9.x): Package manager for frontend
- **protobuf-compiler**: Required for building the API

#### Installing protobuf-compiler

**Ubuntu/Debian:**
```bash
apt install protobuf-compiler
```

**macOS:**
```bash
brew install protobuf
```

**NixOS:**
```bash
nix-shell -p protobuf
```

The API uses `prost-build` to compile `.proto` files at build time. If protobuf is not installed, the build will fail with an error about missing `protoc`.
