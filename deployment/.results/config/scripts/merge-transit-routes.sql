
-- Merge osm2pgsql staging table into application schema.
-- Run after osm2pgsql import creates _osm_transit_routes.
-- Safe to run multiple times (idempotent).

DO $$
BEGIN
    -- Only run if staging table exists
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '_osm_transit_routes') THEN
        RAISE NOTICE 'Merging _osm_transit_routes into routes...';

        -- Ensure columns exist
        ALTER TABLE routes ADD COLUMN IF NOT EXISTS geom geometry(MultiLineString, 4326);
        ALTER TABLE routes ADD COLUMN IF NOT EXISTS min_zoom integer NOT NULL DEFAULT 13;

        -- Upsert from staging table
        INSERT INTO routes (osm_id, osm_type, name, ref, route_type, color, operator, network, min_zoom, geom, tags, updated_at)
        SELECT
            osm_id, 'relation', name, ref, route_type, color, operator, network,
            min_zoom, geom, tags, NOW()
        FROM _osm_transit_routes
        ON CONFLICT (osm_id) DO UPDATE SET
            name       = EXCLUDED.name,
            ref        = EXCLUDED.ref,
            route_type = EXCLUDED.route_type,
            color      = EXCLUDED.color,
            operator   = EXCLUDED.operator,
            network    = EXCLUDED.network,
            min_zoom   = EXCLUDED.min_zoom,
            geom       = EXCLUDED.geom,
            tags       = EXCLUDED.tags,
            updated_at = NOW();

        -- Spatial index
        CREATE INDEX IF NOT EXISTS idx_routes_geom ON routes USING GIST (geom);
        CREATE INDEX IF NOT EXISTS idx_routes_min_zoom ON routes (min_zoom);

        -- Drop staging table
        DROP TABLE _osm_transit_routes;

        RAISE NOTICE 'Merge complete.';
    ELSE
        RAISE NOTICE 'No staging table _osm_transit_routes found, skipping merge.';
    END IF;
END $$;
