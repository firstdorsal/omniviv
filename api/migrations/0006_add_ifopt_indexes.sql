CREATE INDEX IF NOT EXISTS idx_platforms_ref_ifopt ON platforms(ref_ifopt) WHERE ref_ifopt IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stop_positions_ref_ifopt ON stop_positions(ref_ifopt) WHERE ref_ifopt IS NOT NULL;
