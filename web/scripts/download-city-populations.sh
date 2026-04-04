#!/bin/bash
set -euo pipefail

# Downloads German city population data from GeoNames (cities with pop > 1000)
# Source: https://download.geonames.org/export/dump/
# License: Creative Commons Attribution 4.0
#
# Run periodically to update population figures.
# Output: web/public/data/city-populations.json

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$SCRIPT_DIR/../public/data"
OUT_FILE="$OUT_DIR/city-populations.json"
TMP_DIR=$(mktemp -d)

trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading GeoNames cities1000.zip..."
curl -sL "https://download.geonames.org/export/dump/cities1000.zip" -o "$TMP_DIR/cities1000.zip"

echo "Extracting..."
unzip -qo "$TMP_DIR/cities1000.zip" -d "$TMP_DIR"

echo "Filtering German cities and generating JSON..."
mkdir -p "$OUT_DIR"

# GeoNames cities1000.txt format (tab-separated):
# 0:geonameid 1:name 2:asciiname 3:alternatenames 4:lat 5:lon
# 6:feature_class 7:feature_code 8:country_code 9:cc2
# 10:admin1 11:admin2 12:admin3 13:admin4
# 14:population 15:elevation 16:dem 17:timezone 18:modification_date
#
# Filter: country_code == "DE", feature_class == "P" (populated place), population > 0
# Sort by population descending
python3 -c "
import csv, json, sys

cities = []
with open('$TMP_DIR/cities1000.txt', encoding='utf-8') as f:
    reader = csv.reader(f, delimiter='\t')
    for row in reader:
        if len(row) < 19:
            continue
        country = row[8]
        feature_class = row[6]
        population = int(row[14]) if row[14] else 0
        if country != 'DE' or feature_class != 'P' or population <= 0:
            continue
        name = row[1]
        ascii_name = row[2]
        cities.append({
            'name': name,
            'ascii': ascii_name,
            'pop': population,
        })

# Sort by population descending
cities.sort(key=lambda c: c['pop'], reverse=True)

print(f'Found {len(cities)} German cities with population data', file=sys.stderr)
top10 = ', '.join(c['name'] + ' (' + str(c['pop']) + ')' for c in cities[:10])
print(f'Top 10: {top10}', file=sys.stderr)

with open('$OUT_FILE', 'w', encoding='utf-8') as out:
    json.dump(cities, out, ensure_ascii=False, separators=(',', ':'))
"

SIZE=$(wc -c < "$OUT_FILE")
COUNT=$(python3 -c "import json; print(len(json.load(open('$OUT_FILE'))))")
echo "Generated $OUT_FILE ($COUNT cities, ${SIZE} bytes)"
