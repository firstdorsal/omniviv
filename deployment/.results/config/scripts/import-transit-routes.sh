
#!/bin/sh
#
# Import transit data from OSM PBF into PostgreSQL via osm2pgsql.
# Replaces Overpass API entirely for stations, platforms, stops, and routes.

set -eu

POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_DB="${POSTGRES_DB:-omniviv}"
PBF_PATH="${PBF_PATH:-/data/germany-latest.osm.pbf}"
PBF_URL="${PBF_URL:-https://download.geofabrik.de/europe/germany-latest.osm.pbf}"
SKIP_DOWNLOAD="${SKIP_DOWNLOAD:-false}"

# Set up .pgpass for password authentication
# (osm2pgsql's -U flag and PGPASSWORD env var are unreliable across builds)
echo "${POSTGRES_HOST}:${POSTGRES_PORT}:${POSTGRES_DB}:${POSTGRES_USER}:${POSTGRES_PASSWORD}" > ~/.pgpass
chmod 600 ~/.pgpass

# Download PBF if needed
if [ "$SKIP_DOWNLOAD" != "true" ] && [ ! -f "$PBF_PATH" ]; then
    echo "[INFO] Downloading PBF from ${PBF_URL}..."
    curl -L -o "$PBF_PATH" "$PBF_URL"
    echo "[OK] Download complete"
elif [ -f "$PBF_PATH" ]; then
    echo "[INFO] Using existing PBF: $PBF_PATH"
else
    echo "[ERROR] PBF not found at $PBF_PATH"
    exit 1
fi

echo "[INFO] Running osm2pgsql (this may take 30-90 minutes for Germany)..."
osm2pgsql \
    --create \
    --output=flex \
    --style=/scripts/transit.lua \
    -d "$POSTGRES_DB" \
    -U "$POSTGRES_USER" \
    -H "$POSTGRES_HOST" \
    -P "$POSTGRES_PORT" \
    --log-level=info \
    "$PBF_PATH"

echo "[OK] osm2pgsql import complete. Staging tables ready for API merge."
