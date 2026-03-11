-- Enforce 1:1 relationship between IFOPT and GTFS stops
-- Each IFOPT maps to exactly one GTFS stop and vice versa

-- First, remove duplicates: keep only the highest-scoring mapping per gtfs_stop_id
DELETE FROM ifopt_gtfs_mapping a
USING ifopt_gtfs_mapping b
WHERE a.gtfs_stop_id = b.gtfs_stop_id
  AND a.ifopt <> b.ifopt
  AND (a.combined_score < b.combined_score
       OR (a.combined_score = b.combined_score AND a.ifopt > b.ifopt));

-- Drop the composite primary key
ALTER TABLE ifopt_gtfs_mapping DROP CONSTRAINT ifopt_gtfs_mapping_pkey;

-- Add single-column primary key on ifopt (one IFOPT -> one GTFS stop)
ALTER TABLE ifopt_gtfs_mapping ADD PRIMARY KEY (ifopt);

-- Add unique constraint on gtfs_stop_id (one GTFS stop -> one IFOPT)
ALTER TABLE ifopt_gtfs_mapping ADD CONSTRAINT uq_ifopt_mapping_gtfs_stop UNIQUE (gtfs_stop_id);
