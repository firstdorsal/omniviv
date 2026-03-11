-- GTFS static data tables
-- Loaded from the all-Germany GTFS feed (~680K stops, ~1.5M trips, ~31.5M stop_times)

-- GTFS Stops (from stops.txt)
CREATE TABLE IF NOT EXISTS gtfs_stops (
    stop_id TEXT PRIMARY KEY,
    stop_name TEXT,
    parent_station TEXT, -- references gtfs_stops(stop_id) for parent stations
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION
);

-- GTFS Routes (from routes.txt)
CREATE TABLE IF NOT EXISTS gtfs_routes (
    route_id TEXT PRIMARY KEY,
    route_short_name TEXT,
    route_long_name TEXT,
    route_type INTEGER -- GTFS route_type (0=tram, 3=bus, etc)
);

-- GTFS Trips (from trips.txt)
CREATE TABLE IF NOT EXISTS gtfs_trips (
    trip_id TEXT PRIMARY KEY,
    route_id TEXT NOT NULL REFERENCES gtfs_routes(route_id) ON DELETE CASCADE,
    service_id TEXT NOT NULL,
    trip_headsign TEXT,
    direction_id INTEGER
);

-- GTFS Stop Times (from stop_times.txt) — ~31.5M rows
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

-- IFOPT-to-GTFS stop mapping (computed at schedule load time)
CREATE TABLE IF NOT EXISTS ifopt_gtfs_mapping (
    ifopt TEXT NOT NULL,
    gtfs_stop_id TEXT NOT NULL,
    combined_score DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (ifopt, gtfs_stop_id)
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

-- Critical indexes for query performance
CREATE INDEX IF NOT EXISTS idx_gtfs_stops_parent ON gtfs_stops(parent_station);
CREATE INDEX IF NOT EXISTS idx_gtfs_stops_name ON gtfs_stops(stop_name);
CREATE INDEX IF NOT EXISTS idx_gtfs_stop_times_stop ON gtfs_stop_times(stop_id);
CREATE INDEX IF NOT EXISTS idx_gtfs_stop_times_stop_departure ON gtfs_stop_times(stop_id, departure_time);
CREATE INDEX IF NOT EXISTS idx_gtfs_trips_route ON gtfs_trips(route_id);
CREATE INDEX IF NOT EXISTS idx_gtfs_trips_service ON gtfs_trips(service_id);
CREATE INDEX IF NOT EXISTS idx_gtfs_calendar_dates_service ON gtfs_calendar_dates(service_id, date);
CREATE INDEX IF NOT EXISTS idx_ifopt_mapping_gtfs ON ifopt_gtfs_mapping(gtfs_stop_id);
CREATE INDEX IF NOT EXISTS idx_ifopt_mapping_ifopt ON ifopt_gtfs_mapping(ifopt);
