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
│   ├── gtfs_stops/     # GTFS stop queries
│   ├── issues/         # OSM data quality issues
│   ├── mapping/        # IFOPT-to-GTFS stop mapping
│   ├── routes/         # Transit route geometries
│   ├── stations/       # Station and platform info
│   ├── vehicles/       # Vehicle tracking
│   └── ws.rs           # WebSocket handlers
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
static schedule is stored in PostgreSQL and queried on demand for time simulation.

## WebSocket Limits

- Maximum 100 route subscriptions per connection

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
    static_refresh_hours: 6          # Shorter intervals for timely pickup of service changes
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
| CPU | 0.5 core | feoco serving static assets |

## Development Setup

### Prerequisites

- **Rust** (1.83+): Install via [rustup](https://rustup.rs/)
- **Node.js** (23+): For frontend development
- **pnpm** (9.x): Package manager for frontend
