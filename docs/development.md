# Development

## Prerequisites

- **Rust** (latest stable) - for the API
- **Node.js** 23+ with pnpm - for the frontend
- **Docker** (optional) - for containerized development

## Project Structure

```
omniviv/
├── api/                    # Rust backend
│   ├── src/
│   │   ├── api/           # REST endpoints
│   │   ├── providers/     # External data sources
│   │   ├── sync/          # Background synchronization
│   │   ├── config.rs      # Configuration
│   │   └── main.rs        # Entry point
│   ├── migrations/        # PostgreSQL migrations
│   ├── config.yaml        # Default config
│   ├── Cargo.toml
│   └── Dockerfile
├── web/                    # React frontend
│   ├── src/
│   ├── public/
│   │   └── config.json    # Runtime configuration
│   ├── package.json
│   └── Dockerfile
├── deployment/             # mpm deployment configs
│   ├── values.yaml
│   ├── templates/
│   └── data/
└── docs/                   # Documentation
```

## Running Locally

### API (Backend)

```bash
cd api
cargo run
```

The API runs on `http://localhost:3000`.

**Endpoints:**
- API root: http://localhost:3000
- Swagger UI: http://localhost:3000/swagger-ui

**With dev tools:**
```bash
cargo run --features dev-tools
```

Enables:
- SQL Viewer: http://localhost:3000/sql-viewer
- Tracing Console: http://localhost:3000/tracing

### Frontend

```bash
cd web
pnpm install
pnpm dev
```

The frontend runs on `http://localhost:5174`.

Configure API URL in `web/public/config.json`:
```json
{
    "apiUrl": "http://localhost:3000",
    "martinUrl": "http://localhost:3001"
}
```

### Hot Reload

Both servers watch for file changes:
- Frontend: Instant HMR via Vite
- Backend: Restart required (use `cargo-watch` for auto-restart)

```bash
# Optional: auto-restart backend
cargo install cargo-watch
cargo watch -x run
```

## Code Style

### Rust
- Use `cargo fmt` for formatting
- Use `cargo clippy` for linting
- Follow standard Rust conventions

### TypeScript/React
- Use ESLint: `pnpm lint`
- Fix issues: `pnpm lint:fix`
- Use Tailwind CSS and shadcn components
- No inline styles

### Adding shadcn Components
```bash
cd web
pnpm dlx shadcn@latest add <component>
```

## Testing

### API
```bash
cd api
cargo test
```

### Frontend
```bash
cd web
pnpm test        # Run once
pnpm test:watch  # Watch mode
```

## API Client Generation

After modifying API endpoints:
1. Ensure the API is running
2. Run the generation script:

```bash
cd api
./generate-api.sh
```

This updates the TypeScript client in the frontend based on the OpenAPI spec.

## Database

The API uses PostgreSQL as its database, managed via SQLx migrations. The database is provisioned automatically by the docker-compose setup.

The `DATABASE_URL` environment variable must point to a running PostgreSQL instance:
```
DATABASE_URL=postgresql://user:password@localhost:5432/omniviv
```

### Migrations

Migrations run automatically on startup. To add a new migration:

```bash
cd api
sqlx migrate add <name>
```

Edit the generated file in `api/migrations/`.

### Reset Database

Drop and recreate the PostgreSQL database, then restart the API:
```bash
# Via docker-compose
docker compose down -v  # removes the postgres volume
docker compose up -d

# Or manually
psql -U postgres -c "DROP DATABASE omniviv;"
psql -U postgres -c "CREATE DATABASE omniviv;"
cargo run
```

## Configuration

### API Config (`api/config.yaml`)

```yaml
# CORS - use permissive for development
cors_permissive: true

# Service areas
areas:
    - name: "Augsburg"
      bounding_box:
          south: 48.20
          west: 10.75
          north: 48.48
          east: 11.05
      transport_types:
          - tram
          # - bus  # Can overwhelm Overpass API
```

### Frontend Config (`web/public/config.json`)

```json
{
    "apiUrl": "http://localhost:3000",
    "martinUrl": "http://localhost:3001"
}
```

## GTFS Data

The API uses GTFS (General Transit Feed Specification) for departure and vehicle data:

- **Static GTFS**: A ZIP file containing stops, routes, trips, stop_times, calendars. Downloaded once and cached in `api/data/gtfs/`. Re-downloaded every 6 hours (configurable via `static_refresh_hours`). Shorter intervals ensure timely pickup of service changes like strikes; HTTP conditional requests avoid unnecessary data transfer.
- **GTFS-RT**: A protobuf feed with real-time trip updates (delays, cancellations). Polled every 15 seconds (configurable via `realtime_interval_secs`).
- **IFOPT mapping**: GTFS numeric stop IDs are mapped to IFOPT identifiers (from OSM) using spatial proximity matching.

### Configuration (`api/config.yaml`)

```yaml
gtfs_sync:
    static_feed_url: "https://download.gtfs.de/germany/free/latest.zip"
    realtime_feed_url: "https://realtime.gtfs.de/realtime-free.pb"
    cache_dir: "./data/gtfs"        # Where the ZIP is cached
    static_refresh_hours: 6          # Re-download interval (shorter for timely pickup of service changes)
    realtime_interval_secs: 15       # RT poll interval
    time_horizon_minutes: 120        # Show departures up to 2h in future
```

### Cache Directory

The GTFS cache is stored at `api/data/gtfs/` (covered by `api/.gitignore`). On first startup, the ~216MB ZIP is downloaded, which takes 1-3 minutes. Subsequent startups use the cached file.

## Debugging

### API Logs

```bash
# Default logging
cargo run

# Debug level
RUST_LOG=debug cargo run

# Trace level (very verbose)
RUST_LOG=trace cargo run

# Specific module
RUST_LOG=omniviv_api::sync=debug cargo run
```

### Frontend DevTools

- React DevTools browser extension
- Browser Network tab for API calls
- Browser Console for errors

## Common Issues

### API client out of sync
Run `./generate-api.sh` in the api directory after changing endpoints.

### Database connection issues
Ensure PostgreSQL is running and the `DATABASE_URL` environment variable is set correctly. Check that the PostgreSQL container is healthy with `docker compose ps`.

### CORS errors
Ensure `cors_permissive: true` in `api/config.yaml` for development.

### Port conflicts
- API default: 3000
- Frontend default: 5174

Change ports if conflicts exist:
```bash
# Frontend
cd web && pnpm dev --port 3001

# API - edit main.rs or use environment variable
```

### OSM data not loading
The Overpass API has rate limits. If too many areas/transport types are configured, requests may fail. Start with a small area and few transport types.
