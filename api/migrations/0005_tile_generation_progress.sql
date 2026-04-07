-- Add live progress tracking columns to tile_generation_state.
-- Tilegen periodically updates these columns while a layer is being generated
-- so the frontend's diagnostics panel can show a live progress bar.

ALTER TABLE tile_generation_state
    ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'idle',
    ADD COLUMN IF NOT EXISTS tiles_done BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS tiles_total BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS current_zoom INTEGER,
    ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS bbox_west DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS bbox_south DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS bbox_east DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS bbox_north DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS min_zoom INTEGER,
    ADD COLUMN IF NOT EXISTS max_zoom INTEGER,
    ADD COLUMN IF NOT EXISTS area_label TEXT;

COMMENT ON COLUMN tile_generation_state.phase IS
    'idle | running | committing | completed | failed';
COMMENT ON COLUMN tile_generation_state.tiles_done IS
    'Tiles already written to the (tmp) mbtiles file. Updated periodically.';
COMMENT ON COLUMN tile_generation_state.tiles_total IS
    'Estimated total tiles for the configured bbox + zoom range.';
COMMENT ON COLUMN tile_generation_state.current_zoom IS
    'Highest zoom level that has tiles in the in-progress mbtiles.';
COMMENT ON COLUMN tile_generation_state.area_label IS
    'Human-readable area description (e.g. "bayern", "germany", "10.85,48.33,10.93,48.39").';
