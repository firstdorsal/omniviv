-- Add block_id and shape_id columns to gtfs_trips for vehicle continuity
-- tracking and shape-based geometry. The columns and index are created
-- IF NOT EXISTS so this migration is safe to re-run on databases that
-- already have them applied (e.g. instances upgraded from a checkout
-- that briefly contained an out-of-tree migration with this version).

ALTER TABLE gtfs_trips
    ADD COLUMN IF NOT EXISTS block_id TEXT,
    ADD COLUMN IF NOT EXISTS shape_id TEXT;

CREATE INDEX IF NOT EXISTS idx_gtfs_trips_block
    ON gtfs_trips (block_id) WHERE block_id IS NOT NULL;
