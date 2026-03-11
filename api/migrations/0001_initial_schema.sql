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

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_stations_area ON stations(area_id);
CREATE INDEX IF NOT EXISTS idx_stations_name ON stations(name);
CREATE INDEX IF NOT EXISTS idx_platforms_area ON platforms(area_id);
CREATE INDEX IF NOT EXISTS idx_platforms_station ON platforms(station_id);
CREATE INDEX IF NOT EXISTS idx_platforms_area_station ON platforms(area_id, station_id);
CREATE INDEX IF NOT EXISTS idx_platforms_name_ref ON platforms(name, ref);
CREATE INDEX IF NOT EXISTS idx_platforms_ref_name ON platforms(ref, name);
CREATE INDEX IF NOT EXISTS idx_stop_positions_area ON stop_positions(area_id);
CREATE INDEX IF NOT EXISTS idx_stop_positions_platform ON stop_positions(platform_id);
CREATE INDEX IF NOT EXISTS idx_stop_positions_station ON stop_positions(station_id);
CREATE INDEX IF NOT EXISTS idx_stop_positions_area_station ON stop_positions(area_id, station_id);
CREATE INDEX IF NOT EXISTS idx_routes_area ON routes(area_id);
CREATE INDEX IF NOT EXISTS idx_routes_type ON routes(route_type);
CREATE INDEX IF NOT EXISTS idx_routes_ref ON routes(ref);
CREATE INDEX IF NOT EXISTS idx_route_ways_route_seq ON route_ways(route_id, sequence);
CREATE INDEX IF NOT EXISTS idx_route_stops_route ON route_stops(route_id);
CREATE INDEX IF NOT EXISTS idx_route_stops_stop_position ON route_stops(stop_position_id);
CREATE INDEX IF NOT EXISTS idx_route_stops_platform ON route_stops(platform_id);
CREATE INDEX IF NOT EXISTS idx_route_stops_station ON route_stops(station_id);
