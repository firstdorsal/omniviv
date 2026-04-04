#!/bin/bash
# Enrich a GTFS zip with extended route types for long-distance services.
#
# The German GTFS feed classifies all rail as route_type=2 (generic Rail).
# MOTIS needs extended route types to correctly filter by transit mode:
#   101 = High Speed Rail (ICE, TGV, RJX)
#   102 = Long Distance Rail (IC, EC, EN, NJ)
#   200 = Coach (long-distance bus, e.g. Flixbus)
#
# This allows MOTIS to exclude long-distance when filtering by
# transitModes=REGIONAL_RAIL (which only matches route_type=2 after
# ICE/IC have been moved to 101/102).
#
# Usage:
#   bash enrich-gtfs-route-types.sh [GTFS_ZIP]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GTFS_ZIP="${1:-${GTFS_ZIP:-${SCRIPT_DIR}/../data/motis/input/gtfs-germany.zip}}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ ! -f "$GTFS_ZIP" ]; then
    echo -e "${RED}ERROR: GTFS zip not found at $GTFS_ZIP${NC}" >&2
    exit 1
fi

for cmd in python3 zipinfo; do
    if ! command -v "$cmd" &>/dev/null; then
        echo -e "${RED}ERROR: $cmd is required but not installed${NC}" >&2
        exit 1
    fi
done

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

echo -e "${YELLOW}Enriching GTFS route types in $GTFS_ZIP${NC}"

# Extract routes.txt and agency.txt
unzip -o -j "$GTFS_ZIP" routes.txt agency.txt -d "$WORK_DIR" 2>/dev/null

if [ ! -f "$WORK_DIR/routes.txt" ]; then
    echo -e "${RED}ERROR: routes.txt not found in GTFS zip${NC}" >&2
    exit 1
fi

# Count before
BEFORE=$(grep -c "," "$WORK_DIR/routes.txt" || true)

python3 << 'PYTHON_SCRIPT' "$WORK_DIR"
import csv
import sys
import os

work_dir = sys.argv[1]

# Load agency mapping: agency_id -> agency_name
agencies = {}
agency_file = os.path.join(work_dir, "agency.txt")
if os.path.exists(agency_file):
    with open(agency_file, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            agencies[row.get("agency_id", "")] = row.get("agency_name", "")

# Long-distance agency patterns -> extended route_type
# Only reclassify route_type=2 (Rail) and route_type=3 (Bus for coaches)
AGENCY_RULES = {
    # High Speed Rail (101)
    "DB Fernverkehr": 101,
    # Long Distance Rail (102) - could add more here
    # Coach / Long-distance bus (200)
    "Flixbus": 200,
    "FlixTrain": 101,
    "BlaBlaBus": 200,
}

# Route name pattern rules (applied after agency rules, only for route_type=2)
import re
NAME_RULES = [
    (re.compile(r"^ICE\b", re.IGNORECASE), 101),   # High Speed Rail
    (re.compile(r"^IC\b", re.IGNORECASE), 102),     # Long Distance
    (re.compile(r"^EC\b", re.IGNORECASE), 102),     # EuroCity
    (re.compile(r"^TGV\b", re.IGNORECASE), 101),    # TGV
    (re.compile(r"^RJX?\b", re.IGNORECASE), 101),   # Railjet
    (re.compile(r"^THA\b", re.IGNORECASE), 101),    # Thalys
    (re.compile(r"^NJ\b", re.IGNORECASE), 102),     # Nightjet
    (re.compile(r"^EN\b", re.IGNORECASE), 102),     # EuroNight
    (re.compile(r"^FLX\b", re.IGNORECASE), 101),    # FlixTrain
]

routes_file = os.path.join(work_dir, "routes.txt")
output_file = os.path.join(work_dir, "routes_new.txt")

changed = 0
total = 0

with open(routes_file, "r", encoding="utf-8-sig") as fin, \
     open(output_file, "w", encoding="utf-8", newline="") as fout:
    reader = csv.DictReader(fin)
    writer = csv.DictWriter(fout, fieldnames=reader.fieldnames, extrasaction="ignore")
    writer.writeheader()

    for row in reader:
        total += 1
        route_type = int(row.get("route_type", "0"))
        agency_id = row.get("agency_id", "")
        agency_name = agencies.get(agency_id, "")
        route_short_name = row.get("route_short_name", "")

        new_type = route_type

        # Rule 1: Agency-based reclassification
        if route_type in (2, 3):
            for pattern, ext_type in AGENCY_RULES.items():
                if pattern.lower() in agency_name.lower():
                    new_type = ext_type
                    break

        # Rule 2: Route name pattern (only for route_type=2, not already reclassified)
        if new_type == route_type and route_type == 2:
            for regex, ext_type in NAME_RULES:
                if regex.match(route_short_name):
                    new_type = ext_type
                    break

        if new_type != route_type:
            changed += 1
            row["route_type"] = str(new_type)

        writer.writerow(row)

os.replace(output_file, routes_file)
print(f"Processed {total} routes, reclassified {changed} to extended types")
PYTHON_SCRIPT

# Update the zip with the modified routes.txt
cd "$WORK_DIR"
zip -j "$GTFS_ZIP" routes.txt >/dev/null

AFTER=$(grep -c "," "$WORK_DIR/routes.txt" || true)
echo -e "${GREEN}Done. Routes: $BEFORE -> $AFTER (same count = no rows lost)${NC}"
