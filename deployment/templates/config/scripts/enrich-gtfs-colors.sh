#!/bin/bash
# Enrich a GTFS zip with route colors from the database.
#
# After the API has built the OSM<->GTFS route mapping and injected colors
# into gtfs_routes.route_color, this script patches routes.txt inside the
# GTFS zip so MOTIS (and any other consumer) picks up the correct colors.
#
# Usage:
#   bash enrich-gtfs-colors.sh [GTFS_ZIP] [DATABASE_URL]
#
# If arguments are omitted the script reads from the environment:
#   GTFS_ZIP      - path to the GTFS zip (default: ../data/motis/input/gtfs-germany.zip)
#   DATABASE_URL   - PostgreSQL connection string

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GTFS_ZIP="${1:-${GTFS_ZIP:-${SCRIPT_DIR}/../data/motis/input/gtfs-germany.zip}}"
DATABASE_URL="${2:-${DATABASE_URL:-}}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ -z "$DATABASE_URL" ]; then
    echo -e "${RED}ERROR: DATABASE_URL not set and not passed as argument${NC}" >&2
    echo "Usage: bash enrich-gtfs-colors.sh [GTFS_ZIP] [DATABASE_URL]" >&2
    exit 1
fi

if [ ! -f "$GTFS_ZIP" ]; then
    echo -e "${RED}ERROR: GTFS zip not found at $GTFS_ZIP${NC}" >&2
    exit 1
fi

for cmd in psql python3 zipinfo; do
    if ! command -v "$cmd" &>/dev/null; then
        echo -e "${RED}ERROR: $cmd is required but not installed${NC}" >&2
        exit 1
    fi
done

echo -e "${GREEN}=== Enriching GTFS feed with OSM route colors ===${NC}"
echo -e "GTFS zip: ${YELLOW}${GTFS_ZIP}${NC}"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

# Export route colors from the database (route_id -> color hex without #)
echo -e "${YELLOW}Querying route colors from database...${NC}"
psql "$DATABASE_URL" -t -A -F $'\t' -c "
    SELECT route_id, REPLACE(route_color, '#', '')
    FROM gtfs_routes
    WHERE route_color IS NOT NULL AND route_color != ''
" > "$WORK_DIR/colors.tsv"

COLOR_COUNT=$(wc -l < "$WORK_DIR/colors.tsv")
if [ "$COLOR_COUNT" -eq 0 ]; then
    echo -e "${YELLOW}No route colors found in database, nothing to enrich${NC}"
    exit 0
fi
echo -e "${GREEN}Found ${COLOR_COUNT} routes with colors${NC}"

# Extract routes.txt from the zip
echo -e "${YELLOW}Extracting routes.txt...${NC}"
unzip -o -j "$GTFS_ZIP" routes.txt -d "$WORK_DIR" >/dev/null

# Patch routes.txt with the colors
python3 - "$WORK_DIR/routes.txt" "$WORK_DIR/colors.tsv" "$WORK_DIR/routes_enriched.txt" <<'PYTHON_SCRIPT'
import csv
import sys

routes_path = sys.argv[1]
colors_path = sys.argv[2]
output_path = sys.argv[3]

# Load color mapping: route_id -> color (hex without #)
colors = {}
with open(colors_path, 'r') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        parts = line.split('\t')
        if len(parts) == 2:
            route_id, color = parts
            # Strip leading # if present, GTFS spec uses bare hex
            colors[route_id] = color.lstrip('#')

# Read routes.txt, patch route_color column
patched = 0
with open(routes_path, 'r', newline='', encoding='utf-8-sig') as infile:
    reader = csv.DictReader(infile)
    fieldnames = list(reader.fieldnames or [])

    # Ensure route_color column exists
    if 'route_color' not in fieldnames:
        fieldnames.append('route_color')

    # Also ensure route_text_color exists (for contrast)
    if 'route_text_color' not in fieldnames:
        fieldnames.append('route_text_color')

    rows = []
    for row in reader:
        route_id = row.get('route_id', '')
        existing_color = (row.get('route_color') or '').strip()

        if route_id in colors and not existing_color:
            row['route_color'] = colors[route_id]
            # White text is generally safe for transit colors
            if not (row.get('route_text_color') or '').strip():
                row['route_text_color'] = 'FFFFFF'
            patched += 1

        rows.append(row)

with open(output_path, 'w', newline='', encoding='utf-8') as outfile:
    writer = csv.DictWriter(outfile, fieldnames=fieldnames, extrasaction='ignore')
    writer.writeheader()
    writer.writerows(rows)

print(f"Patched {patched} routes with colors (out of {len(rows)} total)")
PYTHON_SCRIPT

# Replace routes.txt in the zip
echo -e "${YELLOW}Updating routes.txt in GTFS zip...${NC}"
cp "$WORK_DIR/routes_enriched.txt" "$WORK_DIR/routes.txt"
(cd "$WORK_DIR" && zip -j "$GTFS_ZIP" routes.txt >/dev/null)

echo -e "${GREEN}=== GTFS enrichment complete ===${NC}"
echo -e "Updated: ${YELLOW}${GTFS_ZIP}${NC}"
echo ""
echo -e "${YELLOW}Note:${NC} If MOTIS has already imported this feed, you need to"
echo -e "delete the import cache and re-import:"
echo -e "  docker exec omniviv-motis rm -f /data/import_done"
echo -e "  docker restart omniviv-motis"
