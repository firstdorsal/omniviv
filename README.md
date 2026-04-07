# Omniviv

A real-time public transport visualization platform.

## Screenshots

![Real-time 3D Tram Tracking](docs/screenshots/main-map.png)

![Königsplatz Station View](docs/screenshots/koenigsplatz-station.png)

## Features

### Working

-   Real-time tram tracking with smooth position interpolation
-   3D map visualization with extruded buildings
-   WebSocket-based live vehicle updates
-   Multiple tram lines with distinct colors
-   Station and platform markers with labels
-   Dark/light mode support
-   Context menu (copy coordinates, measure distance)
-   Departure pinning sidebar for quick access to favorite stops
-   Location search with recent search history
-   Route planner UI with MOTIS integration
-   GTFS-RT cancellation detection
-   Trip linking for vehicle continuity
-   Time simulation / time control
-   GTFS-to-OSM mapping manager
-   ESP device flasher (browser-based firmware flashing)

### Partially Working

-   **Collision avoidance**: Basic implementation exists but not fully reliable
-   **Rendezvous blinking**: Flashes green when trams are about to depart (timing may need tuning)
-   **Navigation routing**: Route planning UI with MOTIS backend (basic integration complete, refinements ongoing)
-   **Offline departure boards**: GTFS bundle download and client-side departure computation (API and IndexedDB storage implemented, UI integration pending)

### Planned / Not Yet Implemented

-   End of line rotation (vehicle turnaround animation at terminus)
-   Support for all vehicle types (buses, trains, ferries, etc.)
-   Realistic 3D vehicle models at closer zoom levels
-   Dark mode for map tiles/style
-   3D terrain with underground tunnel visualization
-   Day/night cycle and weather visualization
-   Offline map tiles
-   "Leave now" traffic light indicator for optimal departure timing
-   First-person driver's seat view for vehicles
-   Multiple city/area support
-   General map improvements (POIs, local events, etc.)
-   Historical data and statistics

## Architecture

-   **API**: Rust-based backend using Axum
-   **Web**: React frontend with MapLibre GL
-   **MOTIS**: Multi-modal routing engine for trip planning
-   **Firmware**: ESP32-S3 display firmware for physical departure boards (PlatformIO)
-   **Deployment**: docker compose with mpm compose

## Quick Start

### Using Docker Compose

Requires [mpm](https://github.com/my-own-web-services/mows/tree/main/utils/mpm) for deployment:

```bash
# Install mpm
curl -fsSL https://raw.githubusercontent.com/my-own-web-services/mows/main/utils/mpm/scripts/install.sh | bash

# Clone and deploy
git clone https://github.com/firstdorsal/omniviv.git
cd omniviv/deployment
nano values.yaml  # Configure as needed
mpm compose up
```

See [docs/deployment.md](docs/deployment.md) for detailed deployment instructions.

### Development

**API:**

```bash
cd api
cargo run
```

**Web:**

```bash
cd web
pnpm install
pnpm dev
```

## Documentation

See the [docs](docs/) folder for detailed documentation.

## Docker Images

Docker images are automatically built and published to GitHub Container Registry:

-   `ghcr.io/firstdorsal/omniviv-api`
-   `ghcr.io/firstdorsal/omniviv-frontend`

See [docs/releasing.md](docs/releasing.md) for the full release workflow.

## License

[Add license information here]

# Other work

Live Display:

https://germany.motis-project.org/
https://xn--live-pnv-r4a.de/
https://travic.app/

# Data

## Germany

### Bahn-Vorhersage: Geparste deutschlandweite Verspätungsdaten

https://mobilithek.info/offers/938616012299546624

### DELFI-Realtime GTFS-RT Trip Updates

https://mobilithek.info/offers/858688352316981248
