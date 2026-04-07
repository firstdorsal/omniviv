-- Per-run history of tile generation. Tilegen inserts one row per layer per
-- completed (or failed) generation cycle so the diagnostics panel can show
-- a timeline of past runs alongside the live progress.
CREATE TABLE IF NOT EXISTS tile_generation_history (
    id BIGSERIAL PRIMARY KEY,
    layer_name TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    duration_ms BIGINT NOT NULL,
    tiles_done BIGINT NOT NULL DEFAULT 0,
    tiles_total BIGINT NOT NULL DEFAULT 0,
    file_size_bytes BIGINT NOT NULL DEFAULT 0,
    bbox_west DOUBLE PRECISION,
    bbox_south DOUBLE PRECISION,
    bbox_east DOUBLE PRECISION,
    bbox_north DOUBLE PRECISION,
    min_zoom INTEGER,
    max_zoom INTEGER,
    area_label TEXT,
    status TEXT NOT NULL,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_tile_gen_history_layer_time
    ON tile_generation_history (layer_name, completed_at DESC);

COMMENT ON TABLE tile_generation_history IS
    'One row per completed or failed tile generation run. Used by the diagnostics panel.';
