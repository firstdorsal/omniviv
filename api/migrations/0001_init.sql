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
    geom geometry(Point, 4326),
    min_zoom INT NOT NULL DEFAULT 12, -- Precomputed zoom level for tile rendering
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
    geom geometry(Point, 4326),
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
    geom geometry(Point, 4326),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_ways_geom ON platform_ways USING GIST (geom);
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
    geom geometry(Point, 4326),
    marker_geom geometry(Point, 4326),
    connection_geom geometry(LineString, 4326),
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
CREATE INDEX IF NOT EXISTS idx_stations_geom ON stations USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_stations_area ON stations(area_id);
CREATE INDEX IF NOT EXISTS idx_stations_name ON stations(name);
CREATE INDEX IF NOT EXISTS idx_platforms_area ON platforms(area_id);
CREATE INDEX IF NOT EXISTS idx_platforms_geom ON platforms USING GIST (geom);
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
CREATE INDEX IF NOT EXISTS idx_stop_positions_geom ON stop_positions USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_stop_positions_marker_geom ON stop_positions USING GIST (marker_geom);
CREATE INDEX IF NOT EXISTS idx_stop_positions_connection_geom ON stop_positions USING GIST (connection_geom);
CREATE INDEX IF NOT EXISTS idx_routes_area ON routes(area_id);
CREATE INDEX IF NOT EXISTS idx_routes_type ON routes(route_type);
CREATE INDEX IF NOT EXISTS idx_routes_ref ON routes(ref);
CREATE INDEX IF NOT EXISTS idx_routes_geom ON routes USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_routes_min_zoom ON routes(min_zoom);
CREATE INDEX IF NOT EXISTS idx_routes_color_ref ON routes(ref, route_type, color, operator, network) WHERE ref IS NOT NULL AND color IS NOT NULL;
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
-- IFOPT-to-GTFS stop mapping (DEPRECATED — kept for transition period only)
-- Primary mapping is now osm_gtfs_stop_mapping below. This table will be removed
-- once all code paths are migrated to the OSM ID-based mapping.
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
      AND r.geom && ST_Expand(b.geom_4326, 0.001)
) AS tile
WHERE geom IS NOT NULL;
$$ LANGUAGE sql STABLE PARALLEL SAFE;

COMMENT ON FUNCTION transit_routes IS 'Vector tile source for transit route geometries with zoom-dependent filtering';

-------------------------------------------------------------------------------
-- PostGIS vector tile function for transit stations / stops
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transit_stations(z integer, x integer, y integer)
 RETURNS bytea
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$
DECLARE
    stations_mvt bytea;
    stops_mvt bytea;
    platforms_mvt bytea;
    connections_mvt bytea;
    steige_mvt bytea;
    outlines_mvt bytea;
    b3857 geometry;
    b4326 geometry;
BEGIN
    b3857 := ST_TileEnvelope(z, x, y);
    b4326 := ST_Transform(b3857, 4326);

    -- 1. Stations (Explicit ID)
    -- min_zoom is precomputed by the API during station sync
    SELECT COALESCE(ST_AsMVT(tile, 'stations', 4096, 'geom', 'id'), ''::bytea) INTO stations_mvt FROM (
        SELECT
            osm_id as id, osm_id, name, ref_ifopt, min_zoom,
            ST_AsMVTGeom(ST_Transform(geom, 3857), b3857, 4096, 4096, false) AS geom
        FROM stations s
        WHERE geom && ST_Expand(b4326, 0.01)
           OR EXISTS (SELECT 1 FROM stop_positions sp WHERE sp.station_id = s.osm_id AND sp.marker_geom && ST_Expand(b4326, 0.01))
    ) AS tile WHERE geom IS NOT NULL;

    -- 2. Stops (Explicit ID)
    IF z >= 15 THEN
        -- 2. Stop positions — exact OSM stop_position locations (on the track/rail)
        SELECT COALESCE(ST_AsMVT(tile, 'stops', 4096, 'geom', 'id'), ''::bytea) INTO stops_mvt FROM (
            SELECT
                osm_id as id, osm_id, name, ref, ref_ifopt, station_id, display_name,
                ST_X(geom) as lon, ST_Y(geom) as lat,
                ST_AsMVTGeom(ST_Transform(geom, 3857), b3857, 4096, 4096, false) AS geom
            FROM (
                SELECT
                    sp.osm_id, sp.name, sp.ref, sp.ref_ifopt, sp.station_id, sp.geom,
                    COALESCE(
                        ref,
                        UPPER(split_part(ref_ifopt, ':', array_length(string_to_array(ref_ifopt, ':'), 1))),
                        name,
                        (osm_id % 1000)::text
                    ) as display_name
                FROM stop_positions sp
                WHERE station_id IS NOT NULL
                  AND sp.geom IS NOT NULL
                  AND (sp.geom && ST_Expand(b4326, 0.01) OR EXISTS (
                      SELECT 1 FROM stations s WHERE s.osm_id = sp.station_id AND s.geom && ST_Expand(b4326, 0.01)
                  ))
            ) sub
        ) AS tile WHERE geom IS NOT NULL;

        -- 3. Connections (Explicit ID)
        SELECT COALESCE(ST_AsMVT(tile, 'connections', 4096, 'geom', 'id'), ''::bytea) INTO connections_mvt FROM (
            SELECT DISTINCT ON (station_id, display_name)
                (station_id) as id, -- Consistent ID for the connection group
                ST_AsMVTGeom(ST_Transform(connection_geom, 3857), b3857, 4096, 4096, false) AS geom,
                station_id, display_name
            FROM (
                SELECT 
                    sp.station_id, sp.connection_geom, sp.marker_geom,
                    COALESCE(sp.ref, UPPER(split_part(sp.ref_ifopt, ':', array_length(string_to_array(sp.ref_ifopt, ':'), 1))), sp.name) as display_name
                FROM stop_positions sp
                WHERE connection_geom IS NOT NULL 
                  AND (marker_geom && ST_Expand(b4326, 0.01) OR EXISTS (
                      SELECT 1 FROM stations s WHERE s.osm_id = sp.station_id AND s.geom && ST_Expand(b4326, 0.01)
                  ))
            ) sub
            ORDER BY station_id, display_name, connection_geom
        ) AS tile WHERE geom IS NOT NULL;
        -- 4. Platforms (physical platform nodes, z15+)
        SELECT COALESCE(ST_AsMVT(tile, 'platforms', 4096, 'geom', 'id'), ''::bytea) INTO platforms_mvt FROM (
            SELECT
                p.osm_id as id, p.osm_id, p.name, p.ref as platform_ref, p.ref_ifopt, p.station_id,
                COALESCE(
                    p.ref,
                    UPPER(split_part(p.ref_ifopt, ':', array_length(string_to_array(p.ref_ifopt, ':'), 1))),
                    p.name,
                    (p.osm_id % 1000)::text
                ) as display_name,
                ST_X(p.geom) as lon, ST_Y(p.geom) as lat,
                ST_AsMVTGeom(ST_Transform(p.geom, 3857), b3857, 4096, 4096, false) AS geom
            FROM platforms p
            WHERE p.station_id IS NOT NULL
              AND (p.geom && ST_Expand(b4326, 0.01) OR EXISTS (
                  SELECT 1 FROM stations s WHERE s.osm_id = p.station_id AND s.geom && ST_Expand(b4326, 0.01)
              ))
        ) AS tile WHERE geom IS NOT NULL;
        -- 5. Steige (user-facing platform markers with 3-tier position priority)
        -- Priority: platform_ways centroids (physical passenger area) > platforms (point nodes)
        --         > stop_positions (on-track fallback, only when no platform/platform_way matches)
        -- Each row carries stop_osm_id: the OSM ID of the associated stop_position that has
        -- a GTFS mapping, used by the frontend to fetch departures via /api/departures/by-osm-id.
        -- Semicolons in ref or ref_ifopt (e.g. "A;B") are split into separate rows.
        SELECT COALESCE(ST_AsMVT(tile, 'steige', 4096, 'geom', 'id'), ''::bytea) INTO steige_mvt FROM (
            SELECT DISTINCT ON (station_id, display_name) * FROM (
                -- Tier 1: platform_ways (physical platform areas — centroid is at passenger side)
                SELECT
                    pw.osm_id as id, pw.osm_id, pw.name, pw.ref as platform_ref, pw.ref_ifopt, pw.station_id,
                    'platform_way'::text as source_type,
                    1 as priority,
                    UPPER(TRIM(dn_part.dn)) as display_name,
                    (SELECT sp2.osm_id FROM stop_positions sp2
                     WHERE sp2.station_id = pw.station_id AND sp2.geom IS NOT NULL
                       AND (sp2.ref = TRIM(dn_part.dn) OR sp2.ref = pw.ref
                            OR UPPER(split_part(sp2.ref_ifopt, ':', array_length(string_to_array(sp2.ref_ifopt, ':'), 1))) = UPPER(TRIM(dn_part.dn)))
                     LIMIT 1
                    ) as stop_osm_id,
                    ST_X(pw.geom) as lon, ST_Y(pw.geom) as lat,
                    ST_AsMVTGeom(ST_Transform(pw.geom, 3857), b3857, 4096, 4096, false) AS geom
                FROM platform_ways pw,
                LATERAL unnest(string_to_array(
                    COALESCE(pw.ref, UPPER(split_part(pw.ref_ifopt, ':', array_length(string_to_array(pw.ref_ifopt, ':'), 1))), (pw.osm_id % 1000)::text),
                    ';'
                )) AS dn_part(dn)
                WHERE pw.station_id IS NOT NULL
                  AND pw.geom IS NOT NULL
                  AND (pw.geom && ST_Expand(b4326, 0.01) OR EXISTS (
                      SELECT 1 FROM stations s WHERE s.osm_id = pw.station_id AND s.geom && ST_Expand(b4326, 0.01)
                  ))

                UNION ALL

                -- Tier 2: platforms (point nodes — explicit platform markers)
                SELECT
                    p.osm_id as id, p.osm_id, p.name, p.ref as platform_ref, p.ref_ifopt, p.station_id,
                    'platform'::text as source_type,
                    2 as priority,
                    UPPER(TRIM(dn_part.dn)) as display_name,
                    (SELECT sp2.osm_id FROM stop_positions sp2
                     WHERE sp2.station_id = p.station_id AND sp2.geom IS NOT NULL
                       AND (sp2.ref = TRIM(dn_part.dn) OR sp2.ref = p.ref
                            OR UPPER(split_part(sp2.ref_ifopt, ':', array_length(string_to_array(sp2.ref_ifopt, ':'), 1))) = UPPER(TRIM(dn_part.dn)))
                     LIMIT 1
                    ) as stop_osm_id,
                    ST_X(p.geom) as lon, ST_Y(p.geom) as lat,
                    ST_AsMVTGeom(ST_Transform(p.geom, 3857), b3857, 4096, 4096, false) AS geom
                FROM platforms p,
                LATERAL unnest(string_to_array(
                    COALESCE(p.ref, UPPER(split_part(p.ref_ifopt, ':', array_length(string_to_array(p.ref_ifopt, ':'), 1))), (p.osm_id % 1000)::text),
                    ';'
                )) AS dn_part(dn)
                WHERE p.station_id IS NOT NULL
                  AND p.geom IS NOT NULL
                  AND (p.geom && ST_Expand(b4326, 0.01) OR EXISTS (
                      SELECT 1 FROM stations s WHERE s.osm_id = p.station_id AND s.geom && ST_Expand(b4326, 0.01)
                  ))

                UNION ALL

                -- Tier 3: stop_positions (on-track fallback) — stop_osm_id is its own osm_id
                SELECT
                    sp.osm_id as id, sp.osm_id, sp.name, sp.ref as platform_ref, sp.ref_ifopt, sp.station_id,
                    'stop_position'::text as source_type,
                    3 as priority,
                    UPPER(TRIM(dn_part.dn)) as display_name,
                    sp.osm_id as stop_osm_id,
                    ST_X(sp.geom) as lon, ST_Y(sp.geom) as lat,
                    ST_AsMVTGeom(ST_Transform(sp.geom, 3857), b3857, 4096, 4096, false) AS geom
                FROM stop_positions sp,
                LATERAL unnest(string_to_array(
                    COALESCE(sp.ref, UPPER(split_part(sp.ref_ifopt, ':', array_length(string_to_array(sp.ref_ifopt, ':'), 1))), (sp.osm_id % 1000)::text),
                    ';'
                )) AS dn_part(dn)
                WHERE sp.station_id IS NOT NULL
                  AND sp.geom IS NOT NULL
                  AND (sp.geom && ST_Expand(b4326, 0.01) OR EXISTS (
                      SELECT 1 FROM stations s WHERE s.osm_id = sp.station_id AND s.geom && ST_Expand(b4326, 0.01)
                  ))
            ) combined
            ORDER BY station_id, display_name, priority
        ) AS tile WHERE geom IS NOT NULL;

        -- 6. Platform outlines (physical platform way geometries as lines, z16+)
        SELECT COALESCE(ST_AsMVT(tile, 'platform_outlines', 4096, 'geom', 'id'), ''::bytea) INTO outlines_mvt FROM (
            SELECT
                pw.osm_id as id, pw.osm_id, pw.name, pw.ref as platform_ref, pw.ref_ifopt, pw.station_id,
                COALESCE(pw.ref, UPPER(split_part(pw.ref_ifopt, ':', array_length(string_to_array(pw.ref_ifopt, ':'), 1))), pw.name) as display_name,
                ST_AsMVTGeom(ST_Transform(pw.line_geom, 3857), b3857, 4096, 4096, false) AS geom
            FROM platform_ways pw
            WHERE pw.station_id IS NOT NULL
              AND pw.line_geom IS NOT NULL
              AND (pw.line_geom && ST_Expand(b4326, 0.01) OR EXISTS (
                  SELECT 1 FROM stations s WHERE s.osm_id = pw.station_id AND s.geom && ST_Expand(b4326, 0.01)
              ))
        ) AS tile WHERE geom IS NOT NULL;
    ELSE
        stops_mvt := ''::bytea;
        platforms_mvt := ''::bytea;
        connections_mvt := ''::bytea;
        steige_mvt := ''::bytea;
        outlines_mvt := ''::bytea;
    END IF;

    RETURN stations_mvt || stops_mvt || platforms_mvt || connections_mvt || steige_mvt || outlines_mvt;
END;
$function$;

COMMENT ON FUNCTION transit_stations IS 'Vector tile source for transit stations and stop positions';
