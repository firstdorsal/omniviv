-- GTFS Agencies (from agency.txt)
CREATE TABLE IF NOT EXISTS gtfs_agencies (
    agency_id TEXT PRIMARY KEY,
    agency_name TEXT NOT NULL
);

-- Add agency_id to gtfs_routes
ALTER TABLE gtfs_routes ADD COLUMN IF NOT EXISTS agency_id TEXT;
