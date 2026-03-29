#!/usr/bin/env bash
#
# Generate MBTiles using Planetiler
# - Germany at high detail (zoom 0-15)
# - World overview at lower detail (zoom 0-7)
#
# Usage:
#   ./generate-tiles.sh                           # Generate both Germany and world
#   ./generate-tiles.sh germany                   # Generate only Germany
#   ./generate-tiles.sh world                     # Generate only world
#   MAX_ZOOM=14 ./generate-tiles.sh germany       # Custom zoom level
#

set -e

# Configuration
GERMANY_MIN_ZOOM="${MIN_ZOOM:-0}"
GERMANY_MAX_ZOOM="${MAX_ZOOM:-15}"
WORLD_MIN_ZOOM="${WORLD_MIN_ZOOM:-0}"
WORLD_MAX_ZOOM="${WORLD_MAX_ZOOM:-7}"

GERMANY_OSM_URL="https://download.geofabrik.de/europe/germany-latest.osm.pbf"
WORLD_OSM_URL="https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf"

GERMANY_OUTPUT="data/maptiles/germany.mbtiles"
WORLD_OUTPUT="data/maptiles/world.mbtiles"

PLANETILER_VERSION="${PLANETILER_VERSION:-latest}"

# Germany bounding box
GERMANY_BBOX="5.8663,47.2701,15.0419,55.0581"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }

# Check Docker
if ! command -v docker &> /dev/null; then
    log_error "Docker is required but not installed!"
    exit 1
fi

# Parse command line argument
TARGET="${1:-all}"

generate_germany() {
    log_info "=== Germany MBTiles Generator ==="
    log_info "Zoom levels: $GERMANY_MIN_ZOOM to $GERMANY_MAX_ZOOM"
    log_info "Output: $GERMANY_OUTPUT"
    log_info "Expected time: 30-90 minutes (depending on zoom level and system)"
    log_info ""

    # Create data directory
    mkdir -p data
    cd data

    # Download OSM data if not exists
    OSM_FILE="germany-latest.osm.pbf"
    if [ ! -f "$OSM_FILE" ]; then
        log_info "Downloading Germany OSM data from Geofabrik (~4GB)..."
        curl -L -o "$OSM_FILE" "$GERMANY_OSM_URL"
        log_success "Download complete!"
    else
        log_info "Using existing OSM data: $OSM_FILE"
        log_info "Delete this file to download fresh data"
    fi

    cd ..

    # Run Planetiler
    log_info "Running Planetiler for Germany..."

    docker run --user $(id -u):$(id -g) -v "$(pwd)/data:/data" ghcr.io/onthegomap/planetiler:$PLANETILER_VERSION \
        --download \
        --area=germany \
        --osm-path=/data/$OSM_FILE \
        --output=/data/germany-output.mbtiles \
        --bounds=$GERMANY_BBOX \
        --minzoom=$GERMANY_MIN_ZOOM \
        --maxzoom=$GERMANY_MAX_ZOOM

    # Check if output exists
    if [ ! -f "data/germany-output.mbtiles" ]; then
        log_error "Germany generation failed - output file not found!"
        return 1
    fi

    # Backup existing file if it exists
    if [ -f "$GERMANY_OUTPUT" ]; then
        BACKUP_FILE="germany-$(date +%Y%m%d).mbtiles.backup"
        log_info "Backing up existing $GERMANY_OUTPUT to $BACKUP_FILE"
        mv "$GERMANY_OUTPUT" "$BACKUP_FILE"
    fi

    # Move to final location
    mv data/germany-output.mbtiles "$GERMANY_OUTPUT"

    FILE_SIZE=$(du -h "$GERMANY_OUTPUT" | cut -f1)
    log_success "Germany tiles complete! Size: $FILE_SIZE"
}

generate_world() {
    log_info "=== World Overview MBTiles Generator ==="
    log_info "Zoom levels: $WORLD_MIN_ZOOM to $WORLD_MAX_ZOOM"
    log_info "Output: $WORLD_OUTPUT"
    log_info ""
    log_warning "This downloads planet.osm.pbf (~70GB) - only needed for world overview"
    log_warning "For most use cases, Natural Earth data (downloaded automatically) is sufficient"
    log_info ""

    # Create data directory
    mkdir -p data
    cd data

    # For world tiles at low zoom, we can use Natural Earth + low-zoom OSM
    # Planetiler downloads Natural Earth automatically with --download
    OSM_FILE="planet-latest.osm.pbf"

    if [ ! -f "$OSM_FILE" ]; then
        log_info "Downloading Planet OSM data (~70GB)..."
        log_info "This will take a while..."
        curl -L -o "$OSM_FILE" "$WORLD_OSM_URL"
        log_success "Download complete!"
    else
        log_info "Using existing OSM data: $OSM_FILE"
    fi

    cd ..

    # Run Planetiler for world
    log_info "Running Planetiler for world..."

    docker run --user $(id -u):$(id -g) -v "$(pwd)/data:/data" ghcr.io/onthegomap/planetiler:$PLANETILER_VERSION \
        --download \
        --osm-path=/data/$OSM_FILE \
        --output=/data/world-output.mbtiles \
        --minzoom=$WORLD_MIN_ZOOM \
        --maxzoom=$WORLD_MAX_ZOOM

    # Check if output exists
    if [ ! -f "data/world-output.mbtiles" ]; then
        log_error "World generation failed - output file not found!"
        return 1
    fi

    # Backup existing file if it exists
    if [ -f "$WORLD_OUTPUT" ]; then
        BACKUP_FILE="world-$(date +%Y%m%d).mbtiles.backup"
        log_info "Backing up existing $WORLD_OUTPUT to $BACKUP_FILE"
        mv "$WORLD_OUTPUT" "$BACKUP_FILE"
    fi

    # Move to final location
    mv data/world-output.mbtiles "$WORLD_OUTPUT"

    FILE_SIZE=$(du -h "$WORLD_OUTPUT" | cut -f1)
    log_success "World tiles complete! Size: $FILE_SIZE"
}

generate_world_natural_earth() {
    log_info "=== World Overview (Natural Earth only) ==="
    log_info "Zoom levels: $WORLD_MIN_ZOOM to $WORLD_MAX_ZOOM"
    log_info "Output: $WORLD_OUTPUT"
    log_info "Using Natural Earth data only (no planet download required)"
    log_info ""

    # Create data directory
    mkdir -p data

    # Run Planetiler with only Natural Earth data
    log_info "Running Planetiler with Natural Earth data..."

    docker run --user $(id -u):$(id -g) -v "$(pwd)/data:/data" ghcr.io/onthegomap/planetiler:$PLANETILER_VERSION \
        --download \
        --only-download \
        --output=/data/world-output.mbtiles

    # Now run again to generate tiles from Natural Earth
    docker run --user $(id -u):$(id -g) -v "$(pwd)/data:/data" ghcr.io/onthegomap/planetiler:$PLANETILER_VERSION \
        --output=/data/world-output.mbtiles \
        --minzoom=$WORLD_MIN_ZOOM \
        --maxzoom=$WORLD_MAX_ZOOM \
        --skip-osm

    if [ -f "data/world-output.mbtiles" ]; then
        if [ -f "$WORLD_OUTPUT" ]; then
            BACKUP_FILE="world-$(date +%Y%m%d).mbtiles.backup"
            mv "$WORLD_OUTPUT" "$BACKUP_FILE"
        fi
        mv data/world-output.mbtiles "$WORLD_OUTPUT"
        FILE_SIZE=$(du -h "$WORLD_OUTPUT" | cut -f1)
        log_success "World tiles complete! Size: $FILE_SIZE"
    else
        log_warning "Natural Earth only generation may not work - falling back to Germany tiles for low zoom"
    fi
}

cleanup() {
    log_info "Cleaning up temporary data..."
    rm -rf data/sources data/tmp 2>/dev/null || true
    log_success "Cleanup complete!"
}

# Ask for confirmation (skip if SKIP_CONFIRM is set)
if [ -z "$SKIP_CONFIRM" ]; then
    case "$TARGET" in
        germany)
            log_info "Will generate Germany tiles (zoom $GERMANY_MIN_ZOOM-$GERMANY_MAX_ZOOM)"
            ;;
        world)
            log_info "Will generate World tiles (zoom $WORLD_MIN_ZOOM-$WORLD_MAX_ZOOM)"
            log_warning "This requires downloading planet.osm.pbf (~70GB)!"
            ;;
        world-light)
            log_info "Will generate World tiles using Natural Earth data only"
            ;;
        all)
            log_info "Will generate:"
            log_info "  - Germany (zoom $GERMANY_MIN_ZOOM-$GERMANY_MAX_ZOOM)"
            log_info "  - World overview using Natural Earth"
            ;;
        *)
            log_error "Unknown target: $TARGET"
            log_info "Usage: $0 [germany|world|world-light|all]"
            exit 1
            ;;
    esac

    read -p "Continue? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Cancelled."
        exit 0
    fi
fi

# Execute based on target
case "$TARGET" in
    germany)
        generate_germany
        ;;
    world)
        generate_world
        ;;
    world-light)
        generate_world_natural_earth
        ;;
    all)
        generate_germany
        # For world overview, Natural Earth is usually sufficient at low zoom
        # The Germany tiles will include Natural Earth context at low zoom anyway
        log_info ""
        log_info "Note: Germany tiles already include world context at low zoom levels"
        log_info "from Natural Earth data. A separate world tiles file is optional."
        ;;
esac

cleanup

log_info ""
log_info "To use the tiles with TileServer GL:"
log_info "  Restart the tile server:"
log_info "    docker compose down && docker compose up -d"
log_info ""
log_success "Done!"
