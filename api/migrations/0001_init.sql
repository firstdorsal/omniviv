-- Consolidated initial schema
-- Merged from migrations 0001 through 0008

-- Enable PostGIS extension for spatial data types and functions
CREATE EXTENSION IF NOT EXISTS postgis;

-------------------------------------------------------------------------------
-- OSM data tables
-------------------------------------------------------------------------------

-- Areas from config (synced from config.yaml)
CREATE TABLE IF NOT EXISTS areas (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    south DOUBLE PRECISION NOT NULL,
    west DOUBLE PRECISION NOT NULL,
    north DOUBLE PRECISION NOT NULL,
    east DOUBLE PRECISION NOT NULL,
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- OSM Stations (public_transport=station or railway=station)
CREATE TABLE IF NOT EXISTS stations (
    osm_id BIGINT PRIMARY KEY,
    osm_type TEXT NOT NULL, -- 'node', 'way', 'relation'
    name TEXT,
    ref_ifopt TEXT, -- IFOPT identifier (ref:IFOPT tag)
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    tags JSONB, -- All OSM tags
    area_id BIGINT REFERENCES areas(id) ON DELETE CASCADE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- OSM Platforms (public_transport=platform or railway=platform)
CREATE TABLE IF NOT EXISTS platforms (
    osm_id BIGINT PRIMARY KEY,
    osm_type TEXT NOT NULL,
    name TEXT,
    ref TEXT, -- platform number/letter (e.g., "A", "1")
    ref_ifopt TEXT, -- IFOPT identifier (ref:IFOPT tag)
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    tags JSONB, -- All OSM tags
    station_id BIGINT REFERENCES stations(osm_id) ON DELETE SET NULL,
    area_id BIGINT REFERENCES areas(id) ON DELETE CASCADE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- OSM Platform Ways (physical platform outlines, stored with centroid)
-- Separate from platform nodes to avoid ID collisions between OSM node/way namespaces
CREATE TABLE IF NOT EXISTS platform_ways (
    osm_id BIGINT PRIMARY KEY,
    name TEXT,
    ref TEXT,
    ref_ifopt TEXT,
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    tags JSONB,
    station_id BIGINT REFERENCES stations(osm_id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_ways_station ON platform_ways(station_id);
CREATE INDEX IF NOT EXISTS idx_platform_ways_ref_ifopt ON platform_ways(ref_ifopt) WHERE ref_ifopt IS NOT NULL;

-- OSM Stop Positions (public_transport=stop_position)
CREATE TABLE IF NOT EXISTS stop_positions (
    osm_id BIGINT PRIMARY KEY,
    osm_type TEXT NOT NULL,
    name TEXT,
    ref TEXT,
    ref_ifopt TEXT, -- IFOPT identifier (ref:IFOPT tag)
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    tags JSONB, -- All OSM tags
    platform_id BIGINT REFERENCES platforms(osm_id) ON DELETE SET NULL,
    station_id BIGINT REFERENCES stations(osm_id) ON DELETE SET NULL,
    area_id BIGINT REFERENCES areas(id) ON DELETE CASCADE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- OSM Routes (type=route, route=tram/bus/etc)
CREATE TABLE IF NOT EXISTS routes (
    osm_id BIGINT PRIMARY KEY,
    osm_type TEXT NOT NULL, -- typically 'relation'
    name TEXT,
    ref TEXT, -- line number (e.g., "1", "2", "3")
    route_type TEXT NOT NULL, -- 'tram', 'bus', etc
    operator TEXT,
    network TEXT,
    color TEXT,
    tags JSONB, -- All OSM tags
    area_id BIGINT REFERENCES areas(id) ON DELETE CASCADE,
    geom geometry(MultiLineString, 4326),
    min_zoom INTEGER NOT NULL DEFAULT 13,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Route geometry (ordered way segments)
CREATE TABLE IF NOT EXISTS route_ways (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    route_id BIGINT NOT NULL REFERENCES routes(osm_id) ON DELETE CASCADE,
    way_osm_id BIGINT NOT NULL,
    sequence INTEGER NOT NULL, -- order in route
    geometry JSONB, -- JSON array of [lon, lat] coordinates
    -- Note: Use (route_id, sequence) not (route_id, way_osm_id, sequence)
    -- to allow circular routes where same way appears multiple times
    UNIQUE(route_id, sequence)
);

-- Route stops (ordered stop positions for a route)
CREATE TABLE IF NOT EXISTS route_stops (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    route_id BIGINT NOT NULL REFERENCES routes(osm_id) ON DELETE CASCADE,
    stop_position_id BIGINT REFERENCES stop_positions(osm_id) ON DELETE SET NULL,
    platform_id BIGINT REFERENCES platforms(osm_id) ON DELETE SET NULL,
    station_id BIGINT REFERENCES stations(osm_id) ON DELETE SET NULL,
    sequence INTEGER NOT NULL, -- order in route
    role TEXT, -- OSM role (stop, platform, etc)
    UNIQUE(route_id, sequence)
);

-- OSM table indexes
CREATE INDEX IF NOT EXISTS idx_stations_area ON stations(area_id);
CREATE INDEX IF NOT EXISTS idx_stations_name ON stations(name);
CREATE INDEX IF NOT EXISTS idx_platforms_area ON platforms(area_id);
CREATE INDEX IF NOT EXISTS idx_platforms_station ON platforms(station_id);
CREATE INDEX IF NOT EXISTS idx_platforms_area_station ON platforms(area_id, station_id);
CREATE INDEX IF NOT EXISTS idx_platforms_name_ref ON platforms(name, ref);
CREATE INDEX IF NOT EXISTS idx_platforms_ref_name ON platforms(ref, name);
CREATE INDEX IF NOT EXISTS idx_platforms_ref_ifopt ON platforms(ref_ifopt) WHERE ref_ifopt IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stop_positions_area ON stop_positions(area_id);
CREATE INDEX IF NOT EXISTS idx_stop_positions_platform ON stop_positions(platform_id);
CREATE INDEX IF NOT EXISTS idx_stop_positions_station ON stop_positions(station_id);
CREATE INDEX IF NOT EXISTS idx_stop_positions_area_station ON stop_positions(area_id, station_id);
CREATE INDEX IF NOT EXISTS idx_stop_positions_ref_ifopt ON stop_positions(ref_ifopt) WHERE ref_ifopt IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_routes_area ON routes(area_id);
CREATE INDEX IF NOT EXISTS idx_routes_type ON routes(route_type);
CREATE INDEX IF NOT EXISTS idx_routes_ref ON routes(ref);
CREATE INDEX IF NOT EXISTS idx_routes_geom ON routes USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_routes_min_zoom ON routes(min_zoom);
CREATE INDEX IF NOT EXISTS idx_route_ways_route_seq ON route_ways(route_id, sequence);
CREATE INDEX IF NOT EXISTS idx_route_stops_route ON route_stops(route_id);
CREATE INDEX IF NOT EXISTS idx_route_stops_stop_position ON route_stops(stop_position_id);
CREATE INDEX IF NOT EXISTS idx_route_stops_platform ON route_stops(platform_id);
CREATE INDEX IF NOT EXISTS idx_route_stops_station ON route_stops(station_id);

-------------------------------------------------------------------------------
-- GTFS static data tables
-------------------------------------------------------------------------------

-- GTFS Stops (from stops.txt)
CREATE TABLE IF NOT EXISTS gtfs_stops (
    stop_id TEXT PRIMARY KEY,
    stop_name TEXT,
    parent_station TEXT, -- references gtfs_stops(stop_id) for parent stations
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    geom geometry(Point, 4326) -- populated after insert from lat/lon
);

CREATE INDEX IF NOT EXISTS idx_gtfs_stops_geom ON gtfs_stops USING GIST (geom);

-- GTFS Routes (from routes.txt)
CREATE TABLE IF NOT EXISTS gtfs_routes (
    route_id TEXT PRIMARY KEY,
    route_short_name TEXT,
    route_long_name TEXT,
    route_type INTEGER, -- GTFS route_type (0=tram, 3=bus, etc)
    route_color TEXT
);

-- GTFS Trips (from trips.txt)
CREATE TABLE IF NOT EXISTS gtfs_trips (
    trip_id TEXT PRIMARY KEY,
    route_id TEXT NOT NULL REFERENCES gtfs_routes(route_id) ON DELETE CASCADE,
    service_id TEXT NOT NULL,
    trip_headsign TEXT,
    direction_id INTEGER
);

-- GTFS Stop Times (from stop_times.txt)
CREATE TABLE IF NOT EXISTS gtfs_stop_times (
    trip_id TEXT NOT NULL REFERENCES gtfs_trips(trip_id) ON DELETE CASCADE,
    stop_sequence INTEGER NOT NULL,
    stop_id TEXT NOT NULL,
    arrival_time INTEGER, -- seconds since midnight (can exceed 86400 for next-day trips)
    departure_time INTEGER, -- seconds since midnight
    PRIMARY KEY (trip_id, stop_sequence)
);

-- GTFS Calendar (from calendar.txt)
CREATE TABLE IF NOT EXISTS gtfs_calendar (
    service_id TEXT PRIMARY KEY,
    monday BOOLEAN NOT NULL,
    tuesday BOOLEAN NOT NULL,
    wednesday BOOLEAN NOT NULL,
    thursday BOOLEAN NOT NULL,
    friday BOOLEAN NOT NULL,
    saturday BOOLEAN NOT NULL,
    sunday BOOLEAN NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL
);

-- GTFS Calendar Dates / Exceptions (from calendar_dates.txt)
CREATE TABLE IF NOT EXISTS gtfs_calendar_dates (
    service_id TEXT NOT NULL,
    date DATE NOT NULL,
    exception_type INTEGER NOT NULL, -- 1=added, 2=removed
    PRIMARY KEY (service_id, date)
);

-- GTFS feed metadata (singleton row tracking load state)
CREATE TABLE IF NOT EXISTS gtfs_feed_meta (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- singleton
    loaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    stop_count BIGINT NOT NULL DEFAULT 0,
    route_count BIGINT NOT NULL DEFAULT 0,
    trip_count BIGINT NOT NULL DEFAULT 0,
    stop_time_count BIGINT NOT NULL DEFAULT 0,
    mapping_count BIGINT NOT NULL DEFAULT 0
);

-- GTFS table indexes
CREATE INDEX IF NOT EXISTS idx_gtfs_stops_parent ON gtfs_stops(parent_station);
CREATE INDEX IF NOT EXISTS idx_gtfs_stops_name ON gtfs_stops(stop_name);
CREATE INDEX IF NOT EXISTS idx_gtfs_stop_times_stop ON gtfs_stop_times(stop_id);
CREATE INDEX IF NOT EXISTS idx_gtfs_stop_times_stop_departure ON gtfs_stop_times(stop_id, departure_time);
CREATE INDEX IF NOT EXISTS idx_gtfs_trips_route ON gtfs_trips(route_id);
CREATE INDEX IF NOT EXISTS idx_gtfs_trips_service ON gtfs_trips(service_id);
CREATE INDEX IF NOT EXISTS idx_gtfs_calendar_dates_service ON gtfs_calendar_dates(service_id, date);

-------------------------------------------------------------------------------
-- IFOPT-to-GTFS stop mapping (transitional, kept during migration period)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ifopt_gtfs_mapping (
    ifopt TEXT NOT NULL PRIMARY KEY,
    gtfs_stop_id TEXT NOT NULL,
    combined_score DOUBLE PRECISION NOT NULL,
    is_manual BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ifopt_mapping_gtfs ON ifopt_gtfs_mapping(gtfs_stop_id);
CREATE INDEX IF NOT EXISTS idx_ifopt_mapping_ifopt ON ifopt_gtfs_mapping(ifopt);
CREATE INDEX IF NOT EXISTS idx_ifopt_mapping_manual ON ifopt_gtfs_mapping(is_manual);

-------------------------------------------------------------------------------
-- OSM-to-GTFS mapping tables
-------------------------------------------------------------------------------

-- Stop mapping: OSM platform/stop_position <-> GTFS stop
CREATE TABLE IF NOT EXISTS osm_gtfs_stop_mapping (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    osm_id BIGINT NOT NULL,
    osm_type TEXT NOT NULL CHECK (osm_type IN ('platform', 'stop_position')),
    gtfs_stop_id TEXT NOT NULL,
    ref_ifopt TEXT, -- stored as metadata where available
    match_method TEXT NOT NULL CHECK (match_method IN ('ifopt', 'geographic', 'manual')),
    match_score DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    is_manual BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (osm_id, osm_type)
);

CREATE INDEX IF NOT EXISTS idx_osm_gtfs_stop_gtfs_stop_id
    ON osm_gtfs_stop_mapping (gtfs_stop_id);

CREATE INDEX IF NOT EXISTS idx_osm_gtfs_stop_osm_id
    ON osm_gtfs_stop_mapping (osm_id);

CREATE INDEX IF NOT EXISTS idx_osm_gtfs_stop_ref_ifopt
    ON osm_gtfs_stop_mapping (ref_ifopt)
    WHERE ref_ifopt IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_osm_gtfs_stop_is_manual
    ON osm_gtfs_stop_mapping (is_manual);

-- Route mapping: OSM route relation <-> GTFS route
CREATE TABLE IF NOT EXISTS osm_gtfs_route_mapping (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    osm_route_id BIGINT NOT NULL,
    gtfs_route_id TEXT NOT NULL,
    match_method TEXT NOT NULL CHECK (match_method IN ('ref_match', 'stop_overlap', 'manual')),
    match_score DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    is_manual BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (osm_route_id, gtfs_route_id)
);

CREATE INDEX IF NOT EXISTS idx_osm_gtfs_route_gtfs_route_id
    ON osm_gtfs_route_mapping (gtfs_route_id);

CREATE INDEX IF NOT EXISTS idx_osm_gtfs_route_osm_route_id
    ON osm_gtfs_route_mapping (osm_route_id);

-------------------------------------------------------------------------------
-- PostGIS vector tile function for transit routes
-------------------------------------------------------------------------------

-- Martin auto-discovers this function as a vector tile source.
-- Signature: (z integer, x integer, y integer) -> bytea
-- Serves transit route geometries with zoom-dependent filtering.
CREATE OR REPLACE FUNCTION transit_routes(z integer, x integer, y integer)
RETURNS bytea AS $$
WITH bounds AS (
    SELECT ST_Transform(ST_TileEnvelope(z, x, y), 4326) AS geom_4326,
           ST_TileEnvelope(z, x, y) AS geom_3857
)
SELECT ST_AsMVT(tile, 'transit_routes', 4096, 'geom') FROM (
    SELECT
        r.osm_id, r.name, r.ref, r.route_type, r.color,
        r.operator, r.network, r.min_zoom,
        ST_AsMVTGeom(
            ST_Transform(r.geom, 3857),
            b.geom_3857,
            4096, 256, true
        ) AS geom
    FROM routes r, bounds b
    WHERE r.geom IS NOT NULL
      AND r.min_zoom <= z
      AND r.geom && b.geom_4326
      AND ST_Intersects(r.geom, b.geom_4326)
) AS tile
WHERE geom IS NOT NULL;
$$ LANGUAGE sql STABLE PARALLEL SAFE;

COMMENT ON FUNCTION transit_routes IS 'Vector tile source for transit route geometries with zoom-dependent filtering';

-------------------------------------------------------------------------------
-- PostGIS vector tile function for transit stations / stops
-------------------------------------------------------------------------------

-- Martin auto-discovers this function as a vector tile source.
-- Returns 3 MVT layers:
--   - stations: station points with min_zoom filtering
--   - stops: stop_position points (visible at z15+)
--   - platform_ways: platform way centroids (visible at z15+)
CREATE OR REPLACE FUNCTION transit_stations(z integer, x integer, y integer)
RETURNS bytea AS $$
DECLARE
    bounds_4326 geometry;
    bounds_3857 geometry;
    stations_mvt bytea;
    stops_mvt bytea;
    platform_ways_mvt bytea;
BEGIN
    bounds_3857 := ST_TileEnvelope(z, x, y);
    bounds_4326 := ST_Transform(bounds_3857, 4326);

    -- Layer 1: stations (zoom-filtered by railway tag)
    SELECT COALESCE(ST_AsMVT(tile, 'stations', 4096, 'geom'), '') INTO stations_mvt FROM (
        SELECT
            s.osm_id, s.name, s.ref_ifopt,
            CASE
                WHEN s.tags->>'railway' = 'station' THEN 6
                WHEN s.tags->>'railway' = 'halt' THEN 9
                ELSE 11
            END AS min_zoom,
            ST_AsMVTGeom(
                ST_Transform(ST_SetSRID(ST_MakePoint(s.lon, s.lat), 4326), 3857),
                bounds_3857, 4096, 256, true
            ) AS geom
        FROM stations s
        WHERE s.lat IS NOT NULL AND s.lon IS NOT NULL
          AND ST_SetSRID(ST_MakePoint(s.lon, s.lat), 4326) && bounds_4326
          AND (EXISTS (SELECT 1 FROM platforms WHERE station_id = s.osm_id)
            OR EXISTS (SELECT 1 FROM stop_positions WHERE station_id = s.osm_id)
            OR EXISTS (SELECT 1 FROM platform_ways WHERE station_id = s.osm_id))
          AND CASE
                WHEN s.tags->>'railway' = 'station' THEN z >= 6
                WHEN s.tags->>'railway' = 'halt' THEN z >= 9
                ELSE z >= 11
              END
    ) AS tile WHERE geom IS NOT NULL;

    -- Layer 2: stop positions (z15+)
    IF z >= 15 THEN
        SELECT COALESCE(ST_AsMVT(tile, 'stops', 4096, 'geom'), '') INTO stops_mvt FROM (
            SELECT
                sp.osm_id, sp.name, sp.ref, sp.ref_ifopt,
                sp.station_id,
                ST_AsMVTGeom(
                    ST_Transform(ST_SetSRID(ST_MakePoint(sp.lon, sp.lat), 4326), 3857),
                    bounds_3857, 4096, 256, true
                ) AS geom
            FROM stop_positions sp
            WHERE sp.lat IS NOT NULL AND sp.lon IS NOT NULL
              AND sp.station_id IS NOT NULL
              AND ST_SetSRID(ST_MakePoint(sp.lon, sp.lat), 4326) && bounds_4326
        ) AS tile WHERE geom IS NOT NULL;

        -- Layer 3: platform way centroids (z15+)
        SELECT COALESCE(ST_AsMVT(tile, 'platform_ways', 4096, 'geom'), '') INTO platform_ways_mvt FROM (
            SELECT
                pw.osm_id, pw.name, pw.ref, pw.ref_ifopt,
                pw.station_id,
                ST_AsMVTGeom(
                    ST_Transform(ST_SetSRID(ST_MakePoint(pw.lon, pw.lat), 4326), 3857),
                    bounds_3857, 4096, 256, true
                ) AS geom
            FROM platform_ways pw
            WHERE pw.lat IS NOT NULL AND pw.lon IS NOT NULL
              AND pw.station_id IS NOT NULL
              AND ST_SetSRID(ST_MakePoint(pw.lon, pw.lat), 4326) && bounds_4326
        ) AS tile WHERE geom IS NOT NULL;
    ELSE
        stops_mvt := '';
        platform_ways_mvt := '';
    END IF;

    RETURN stations_mvt || stops_mvt || platform_ways_mvt;
END;
$$ LANGUAGE plpgsql STABLE PARALLEL SAFE;

COMMENT ON FUNCTION transit_stations IS 'Vector tile source for transit stations, stop positions and platform ways';
