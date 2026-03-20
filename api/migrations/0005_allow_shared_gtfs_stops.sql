-- Allow multiple IFOPTs to share a single GTFS stop
-- This is needed for stations where the GTFS feed has only one stop
-- but OSM has multiple platforms (one per direction).
-- The station-level fallback maps sibling platforms to the same GTFS stop.

ALTER TABLE ifopt_gtfs_mapping DROP CONSTRAINT uq_ifopt_mapping_gtfs_stop;
