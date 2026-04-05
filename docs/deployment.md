# Deployment

Omniviv uses [mpm (MOWS Package Manager)](https://github.com/my-own-web-services/mows/tree/main/utils/mpm) for deployment. mpm brings Helm-like templating to Docker Compose, enabling flexible configuration with Go templates, automatic secret generation, and Traefik label flattening.

## Prerequisites

-   Docker and Docker Compose
-   mpm installed ([installation instructions](https://github.com/my-own-web-services/mows/tree/main/utils/mpm#installation))

### Installing mpm

```bash
curl -fsSL https://raw.githubusercontent.com/my-own-web-services/mows/main/utils/mpm/scripts/install.sh | bash
```

## Quick Start

```bash
# Clone the repository
git clone https://github.com/firstdorsal/omniviv.git
cd omniviv/deployment

# Edit configuration
nano values.yaml

# Deploy
mpm compose up
```

## Project Structure

```
deployment/
├── values.yaml                    # Configuration values
├── mows-manifest.yaml            # Package metadata and version
├── templates/
│   ├── docker-compose.yaml       # Service definitions (Go template)
│   ├── generated-secrets.env     # Auto-generated secrets template
│   └── config/
│       ├── api/config.yaml       # API configuration template
│       ├── frontend/config.json  # Frontend configuration template
│       ├── martin/config.yaml    # Martin tile server configuration
│       └── tilegen/tilegen.yaml  # Tilegen tile builder configuration
├── provided-secrets.env          # User-provided secrets (not committed)
├── data/
│   ├── mbtiles/                  # Basemap tile data
│   ├── martin/config.yaml        # Martin runtime config (auto_publish: false)
│   └── fonts/                    # Map fonts
└── results/                      # Rendered output (generated)
```

## Configuration (values.yaml)

```yaml
routing: local # local | domain
tls: false # Enable HTTPS (requires Traefik with cert resolver)

reverseProxy:
    create: true # Create local Traefik instance
    network: rp # Docker network name

domain: example.com # Base domain for subdomains

services:
    postgres:
        image: postgres:18-alpine
        database: omniviv
        storage:
            volumeName: omniviv-postgres-data
            absolutePath: null
        shmSize: 256mb

    api:
        subdomain: omniviv-api
        corsPermissive: true
        data:
            storage:
                volumeName: omniviv-api-data
                absolutePath: null
        build:
            enabled: false # Set true to build from source
            context: ../../api
            dockerfile: Dockerfile
        image: ghcr.io/firstdorsal/omniviv-api:latest

    web:
        subdomain: omniviv
        build:
            enabled: false
            context: ../../web
            dockerfile: Dockerfile
        image: ghcr.io/firstdorsal/omniviv-frontend:latest

    martin:
        subdomain: omniviv-martin
        image: ghcr.io/maplibre/martin
        dataPath: ./data/
        cacheSeconds: 86400 # 1 day cache

    motis:
        subdomain: omniviv-motis
        image: ghcr.io/motis-project/motis:latest
        inputPath: ./data/motis/input/
        storage:
            volumeName: omniviv-motis-data
            absolutePath: null
        memLimit: 12g
```

## Routing Modes

### Local Mode (`routing: local`)

Services are accessible via `localhost` with subdomains:

-   API: `http://omniviv-api.localhost`
-   Frontend: `http://omniviv.localhost`
-   Tiles: `http://omniviv-martin.localhost`

A local Traefik instance is created when `reverseProxy.create: true`.

### Domain Mode (`routing: domain`)

Services are accessible via configured domain:

-   API: `https://omniviv-api.example.com`
-   Frontend: `https://omniviv.example.com`
-   Tiles: `https://omniviv-martin.example.com`

Requires an external Traefik instance with TLS configured. Set `reverseProxy.create: false` and ensure the `reverseProxy.network` exists.

## Commands

### Deploy

```bash
mpm compose up
```

Renders templates and runs `docker compose up -d`.

### View rendered output

```bash
cat deployment/results/docker-compose.yaml
```

### Regenerate secrets

```bash
mpm compose secrets regenerate
```

### Stop services

```bash
cd deployment/results
docker compose down
```

## Building from Source

To build images locally instead of pulling from registry:

```yaml
services:
    api:
        build:
            enabled: true
            context: ../../api
            dockerfile: Dockerfile
```

Then run `mpm compose up`.

## Map Tiles

The deployment expects map tiles in `deployment/data/mbtiles/`. You can:

1. Download pre-generated tiles for your region
2. Generate tiles using `deployment/scripts/generate-tiles.sh`

Fonts for map labels go in `deployment/data/fonts/`.

## Health Checks

-   API health: `GET /api/health` returns service health status
-   API root: `GET /` returns "Omniviv API"
-   Swagger UI: `GET /swagger-ui/`

## Volumes

-   `omniviv-postgres-data`: PostgreSQL database persistence (when using volumeName)
-   `omniviv-api-data`: API data persistence (GTFS cache, etc.)

## Troubleshooting

### Services not accessible

-   Check if Traefik is running: `docker ps | grep traefik`
-   Check Docker network: `docker network ls | grep rp`

### API can't connect to database

-   Ensure volume is mounted correctly
-   Check file permissions in container

### Templates not rendering

-   Run with verbose output: `mpm compose up -V`
-   Check `deployment/results/` for rendered files
