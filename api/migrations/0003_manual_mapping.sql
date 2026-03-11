-- Add manual mapping support to ifopt_gtfs_mapping table
-- Allows preserving user-curated mappings across auto-rebuild cycles

ALTER TABLE ifopt_gtfs_mapping ADD COLUMN is_manual BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ifopt_gtfs_mapping ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Index for efficient deletion of auto-generated mappings during rebuild
CREATE INDEX idx_ifopt_mapping_manual ON ifopt_gtfs_mapping(is_manual);
