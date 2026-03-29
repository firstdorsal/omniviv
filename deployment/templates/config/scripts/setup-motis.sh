#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT_DIR="${SCRIPT_DIR}/../data/motis/input"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

mkdir -p "$INPUT_DIR"

echo -e "${GREEN}=== MOTIS Data Setup ===${NC}"

# Download Germany OSM PBF
OSM_FILE="$INPUT_DIR/germany-latest.osm.pbf"
if [ -f "$OSM_FILE" ]; then
    echo -e "${YELLOW}OSM file exists, checking for updates...${NC}"
    HTTP_CODE=$(curl -sL -o /dev/null -w "%{http_code}" \
        -z "$OSM_FILE" \
        "https://download.geofabrik.de/europe/germany-latest.osm.pbf")
    if [ "$HTTP_CODE" = "304" ]; then
        echo -e "${GREEN}OSM file is up to date${NC}"
    elif [ "$HTTP_CODE" = "200" ]; then
        echo -e "${YELLOW}Downloading updated OSM data (~4.4 GB)...${NC}"
        curl -L -o "$OSM_FILE" "https://download.geofabrik.de/europe/germany-latest.osm.pbf"
        echo -e "${GREEN}OSM download complete${NC}"
    else
        echo -e "${RED}OSM download returned HTTP $HTTP_CODE${NC}"
    fi
else
    echo -e "${YELLOW}Downloading Germany OSM data (~4.4 GB)...${NC}"
    curl -L -o "$OSM_FILE" "https://download.geofabrik.de/europe/germany-latest.osm.pbf"
    echo -e "${GREEN}OSM download complete${NC}"
fi

# Download GTFS Germany feed
GTFS_FILE="$INPUT_DIR/gtfs-germany.zip"
echo -e "${YELLOW}Downloading GTFS Germany feed (~230 MB)...${NC}"
curl -L -o "$GTFS_FILE" "https://download.gtfs.de/germany/free/latest.zip"
echo -e "${GREEN}GTFS download complete${NC}"

# Copy MOTIS config
CONFIG_SRC="${SCRIPT_DIR}/../results/config/motis/config.yml"
if [ -f "$CONFIG_SRC" ]; then
    cp "$CONFIG_SRC" "$INPUT_DIR/config.yml"
    echo -e "${GREEN}MOTIS config copied${NC}"
else
    echo -e "${YELLOW}No rendered config found at $CONFIG_SRC, using template directly${NC}"
    cp "${SCRIPT_DIR}/../templates/config/motis/config.yml" "$INPUT_DIR/config.yml"
fi

# Enrich GTFS feed with OSM route colors (requires running database)
if [ -n "${DATABASE_URL:-}" ]; then
    echo ""
    echo -e "${YELLOW}Enriching GTFS feed with route colors from database...${NC}"
    bash "${SCRIPT_DIR}/enrich-gtfs-colors.sh" "$GTFS_FILE" "$DATABASE_URL"
else
    echo ""
    echo -e "${YELLOW}DATABASE_URL not set, skipping GTFS color enrichment${NC}"
    echo -e "Run separately after the API has built route mappings:"
    echo -e "  ${YELLOW}bash ${SCRIPT_DIR}/enrich-gtfs-colors.sh${NC}"
fi

echo ""
echo -e "${GREEN}=== Setup complete ===${NC}"
echo -e "Files in $INPUT_DIR:"
ls -lh "$INPUT_DIR"
echo ""
echo -e "Next steps:"
echo -e "  1. Run ${YELLOW}mpm compose up${NC} to start all services"
echo -e "  2. MOTIS will import data on first start (takes ~20-30 min for Germany)"
echo -e "  3. Access MOTIS at ${YELLOW}http://omniviv-motis.localhost${NC}"
