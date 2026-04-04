-- Migration: Split composite tile functions into individual functions for PMTiles generation
-- Each function returns a single MVT source-layer, enabling independent pre-generation.

-------------------------------------------------------------------------------
-- 1. Add line_geom column to platform_ways (stores original way geometry for outlines)
-------------------------------------------------------------------------------
ALTER TABLE platform_ways ADD COLUMN IF NOT EXISTS line_geom geometry(Geometry, 4326);
CREATE INDEX IF NOT EXISTS idx_platform_ways_line_geom ON platform_ways USING GIST (line_geom);

-------------------------------------------------------------------------------
-- 2. Tile generation state tracking table
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tile_generation_state (
    layer_name TEXT PRIMARY KEY,
    last_generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    generation_duration_ms BIGINT NOT NULL DEFAULT 0,
    tile_count BIGINT NOT NULL DEFAULT 0,
    file_size_bytes BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT
);

-------------------------------------------------------------------------------
-- 3. Individual tile functions (extracted from transit_stations)
-------------------------------------------------------------------------------

-- tile_stations: station markers with min_zoom filtering (all zoom levels)
CREATE OR REPLACE FUNCTION tile_stations(z integer, x integer, y integer)
RETURNS bytea
LANGUAGE plpgsql STABLE PARALLEL SAFE
AS $function$
DECLARE
    b3857 geometry;
    b4326 geometry;
BEGIN
    b3857 := ST_TileEnvelope(z, x, y);
    b4326 := ST_Transform(b3857, 4326);

    RETURN COALESCE((
        SELECT ST_AsMVT(tile, 'stations', 4096, 'geom', 'id') FROM (
            SELECT
                osm_id as id, osm_id, name, ref_ifopt, min_zoom,
                ST_AsMVTGeom(ST_Transform(geom, 3857), b3857, 4096, 4096, false) AS geom
            FROM stations s
            WHERE geom && ST_Expand(b4326, 0.01)
               OR EXISTS (SELECT 1 FROM stop_positions sp WHERE sp.station_id = s.osm_id AND sp.marker_geom && ST_Expand(b4326, 0.01))
        ) AS tile WHERE geom IS NOT NULL
    ), ''::bytea);
END;
$function$;

-- tile_routes: route geometries with zoom-dependent filtering
CREATE OR REPLACE FUNCTION tile_routes(z integer, x integer, y integer)
RETURNS bytea
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
WITH bounds AS (
    SELECT ST_Transform(ST_TileEnvelope(z, x, y), 4326) AS geom_4326,
           ST_TileEnvelope(z, x, y) AS geom_3857
)
SELECT COALESCE(ST_AsMVT(tile, 'transit_routes', 4096, 'geom'), ''::bytea) FROM (
    SELECT
        r.osm_id, r.name, r.ref, r.route_type, r.color,
        r.operator, r.network, r.min_zoom,
        ST_AsMVTGeom(
            ST_Transform(r.geom, 3857),
            b.geom_3857,
            4096, 256, true
        ) AS geom
    FROM routes r, bounds b
    WHERE r.geom IS NOT NULL
      AND r.min_zoom <= z
      AND r.geom && ST_Expand(b.geom_4326, 0.001)
) AS tile
WHERE geom IS NOT NULL;
$$;

-- tile_steige: user-facing platform markers with 3-tier priority + semicolon splitting (z15+)
CREATE OR REPLACE FUNCTION tile_steige(z integer, x integer, y integer)
RETURNS bytea
LANGUAGE plpgsql STABLE PARALLEL SAFE
AS $function$
DECLARE
    b3857 geometry;
    b4326 geometry;
BEGIN
    IF z < 15 THEN RETURN ''::bytea; END IF;

    b3857 := ST_TileEnvelope(z, x, y);
    b4326 := ST_Transform(b3857, 4326);

    RETURN COALESCE((
        SELECT ST_AsMVT(tile, 'steige', 4096, 'geom', 'id') FROM (
            SELECT DISTINCT ON (station_id, display_name) * FROM (
                -- Tier 1: platform_ways (physical platform areas — centroid is at passenger side)
                SELECT
                    pw.osm_id as id, pw.osm_id, pw.name, pw.ref as platform_ref, pw.ref_ifopt, pw.station_id,
                    'platform_way'::text as source_type,
                    1 as priority,
                    UPPER(TRIM(dn_part.dn)) as display_name,
                    (SELECT sp2.osm_id FROM stop_positions sp2
                     WHERE sp2.station_id = pw.station_id AND sp2.geom IS NOT NULL
                       AND (sp2.ref = TRIM(dn_part.dn) OR sp2.ref = pw.ref
                            OR UPPER(split_part(sp2.ref_ifopt, ':', array_length(string_to_array(sp2.ref_ifopt, ':'), 1))) = UPPER(TRIM(dn_part.dn)))
                     LIMIT 1
                    ) as stop_osm_id,
                    ST_X(pw.geom) as lon, ST_Y(pw.geom) as lat,
                    ST_AsMVTGeom(ST_Transform(pw.geom, 3857), b3857, 4096, 4096, false) AS geom
                FROM platform_ways pw,
                LATERAL unnest(string_to_array(
                    COALESCE(pw.ref, UPPER(split_part(pw.ref_ifopt, ':', array_length(string_to_array(pw.ref_ifopt, ':'), 1))), (pw.osm_id % 1000)::text),
                    ';'
                )) AS dn_part(dn)
                WHERE pw.station_id IS NOT NULL
                  AND pw.geom IS NOT NULL
                  AND (pw.geom && ST_Expand(b4326, 0.01) OR EXISTS (
                      SELECT 1 FROM stations s WHERE s.osm_id = pw.station_id AND s.geom && ST_Expand(b4326, 0.01)
                  ))

                UNION ALL

                -- Tier 2: platforms (point nodes)
                SELECT
                    p.osm_id as id, p.osm_id, p.name, p.ref as platform_ref, p.ref_ifopt, p.station_id,
                    'platform'::text as source_type,
                    2 as priority,
                    UPPER(TRIM(dn_part.dn)) as display_name,
                    (SELECT sp2.osm_id FROM stop_positions sp2
                     WHERE sp2.station_id = p.station_id AND sp2.geom IS NOT NULL
                       AND (sp2.ref = TRIM(dn_part.dn) OR sp2.ref = p.ref
                            OR UPPER(split_part(sp2.ref_ifopt, ':', array_length(string_to_array(sp2.ref_ifopt, ':'), 1))) = UPPER(TRIM(dn_part.dn)))
                     LIMIT 1
                    ) as stop_osm_id,
                    ST_X(p.geom) as lon, ST_Y(p.geom) as lat,
                    ST_AsMVTGeom(ST_Transform(p.geom, 3857), b3857, 4096, 4096, false) AS geom
                FROM platforms p,
                LATERAL unnest(string_to_array(
                    COALESCE(p.ref, UPPER(split_part(p.ref_ifopt, ':', array_length(string_to_array(p.ref_ifopt, ':'), 1))), (p.osm_id % 1000)::text),
                    ';'
                )) AS dn_part(dn)
                WHERE p.station_id IS NOT NULL
                  AND p.geom IS NOT NULL
                  AND (p.geom && ST_Expand(b4326, 0.01) OR EXISTS (
                      SELECT 1 FROM stations s WHERE s.osm_id = p.station_id AND s.geom && ST_Expand(b4326, 0.01)
                  ))

                UNION ALL

                -- Tier 3: stop_positions (on-track fallback)
                SELECT
                    sp.osm_id as id, sp.osm_id, sp.name, sp.ref as platform_ref, sp.ref_ifopt, sp.station_id,
                    'stop_position'::text as source_type,
                    3 as priority,
                    UPPER(TRIM(dn_part.dn)) as display_name,
                    sp.osm_id as stop_osm_id,
                    ST_X(sp.geom) as lon, ST_Y(sp.geom) as lat,
                    ST_AsMVTGeom(ST_Transform(sp.geom, 3857), b3857, 4096, 4096, false) AS geom
                FROM stop_positions sp,
                LATERAL unnest(string_to_array(
                    COALESCE(sp.ref, UPPER(split_part(sp.ref_ifopt, ':', array_length(string_to_array(sp.ref_ifopt, ':'), 1))), (sp.osm_id % 1000)::text),
                    ';'
                )) AS dn_part(dn)
                WHERE sp.station_id IS NOT NULL
                  AND sp.geom IS NOT NULL
                  AND (sp.geom && ST_Expand(b4326, 0.01) OR EXISTS (
                      SELECT 1 FROM stations s WHERE s.osm_id = sp.station_id AND s.geom && ST_Expand(b4326, 0.01)
                  ))
            ) combined
            ORDER BY station_id, display_name, priority
        ) AS tile WHERE geom IS NOT NULL
    ), ''::bytea);
END;
$function$;

-- tile_platform_outlines: physical platform way geometries as lines (z16+)
CREATE OR REPLACE FUNCTION tile_platform_outlines(z integer, x integer, y integer)
RETURNS bytea
LANGUAGE plpgsql STABLE PARALLEL SAFE
AS $function$
DECLARE
    b3857 geometry;
    b4326 geometry;
BEGIN
    IF z < 16 THEN RETURN ''::bytea; END IF;

    b3857 := ST_TileEnvelope(z, x, y);
    b4326 := ST_Transform(b3857, 4326);

    RETURN COALESCE((
        SELECT ST_AsMVT(tile, 'platform_outlines', 4096, 'geom', 'id') FROM (
            SELECT
                pw.osm_id as id, pw.osm_id, pw.name, pw.ref as platform_ref, pw.ref_ifopt, pw.station_id,
                COALESCE(pw.ref, UPPER(split_part(pw.ref_ifopt, ':', array_length(string_to_array(pw.ref_ifopt, ':'), 1))), pw.name) as display_name,
                ST_AsMVTGeom(ST_Transform(pw.line_geom, 3857), b3857, 4096, 4096, false) AS geom
            FROM platform_ways pw
            WHERE pw.station_id IS NOT NULL
              AND pw.line_geom IS NOT NULL
              AND (pw.line_geom && ST_Expand(b4326, 0.01) OR EXISTS (
                  SELECT 1 FROM stations s WHERE s.osm_id = pw.station_id AND s.geom && ST_Expand(b4326, 0.01)
              ))
        ) AS tile WHERE geom IS NOT NULL
    ), ''::bytea);
END;
$function$;

-- tile_debug_stops: raw OSM stop_positions (z15+, debug only)
CREATE OR REPLACE FUNCTION tile_debug_stops(z integer, x integer, y integer)
RETURNS bytea
LANGUAGE plpgsql STABLE PARALLEL SAFE
AS $function$
DECLARE
    b3857 geometry;
    b4326 geometry;
BEGIN
    IF z < 15 THEN RETURN ''::bytea; END IF;

    b3857 := ST_TileEnvelope(z, x, y);
    b4326 := ST_Transform(b3857, 4326);

    RETURN COALESCE((
        SELECT ST_AsMVT(tile, 'stops', 4096, 'geom', 'id') FROM (
            SELECT
                osm_id as id, osm_id, name, ref, ref_ifopt, station_id, display_name,
                ST_X(geom) as lon, ST_Y(geom) as lat,
                ST_AsMVTGeom(ST_Transform(geom, 3857), b3857, 4096, 4096, false) AS geom
            FROM (
                SELECT
                    sp.osm_id, sp.name, sp.ref, sp.ref_ifopt, sp.station_id, sp.geom,
                    COALESCE(
                        ref,
                        UPPER(split_part(ref_ifopt, ':', array_length(string_to_array(ref_ifopt, ':'), 1))),
                        name,
                        (osm_id % 1000)::text
                    ) as display_name
                FROM stop_positions sp
                WHERE station_id IS NOT NULL
                  AND sp.geom IS NOT NULL
                  AND (sp.geom && ST_Expand(b4326, 0.01) OR EXISTS (
                      SELECT 1 FROM stations s WHERE s.osm_id = sp.station_id AND s.geom && ST_Expand(b4326, 0.01)
                  ))
            ) sub
        ) AS tile WHERE geom IS NOT NULL
    ), ''::bytea);
END;
$function$;

-- tile_debug_platforms: raw OSM platform nodes (z15+, debug only)
CREATE OR REPLACE FUNCTION tile_debug_platforms(z integer, x integer, y integer)
RETURNS bytea
LANGUAGE plpgsql STABLE PARALLEL SAFE
AS $function$
DECLARE
    b3857 geometry;
    b4326 geometry;
BEGIN
    IF z < 15 THEN RETURN ''::bytea; END IF;

    b3857 := ST_TileEnvelope(z, x, y);
    b4326 := ST_Transform(b3857, 4326);

    RETURN COALESCE((
        SELECT ST_AsMVT(tile, 'platforms', 4096, 'geom', 'id') FROM (
            SELECT
                p.osm_id as id, p.osm_id, p.name, p.ref as platform_ref, p.ref_ifopt, p.station_id,
                COALESCE(
                    p.ref,
                    UPPER(split_part(p.ref_ifopt, ':', array_length(string_to_array(p.ref_ifopt, ':'), 1))),
                    p.name,
                    (p.osm_id % 1000)::text
                ) as display_name,
                ST_X(p.geom) as lon, ST_Y(p.geom) as lat,
                ST_AsMVTGeom(ST_Transform(p.geom, 3857), b3857, 4096, 4096, false) AS geom
            FROM platforms p
            WHERE p.station_id IS NOT NULL
              AND (p.geom && ST_Expand(b4326, 0.01) OR EXISTS (
                  SELECT 1 FROM stations s WHERE s.osm_id = p.station_id AND s.geom && ST_Expand(b4326, 0.01)
              ))
        ) AS tile WHERE geom IS NOT NULL
    ), ''::bytea);
END;
$function$;

-- tile_debug_connections: dashed lines from stop positions to stations (z15+, debug only)
CREATE OR REPLACE FUNCTION tile_debug_connections(z integer, x integer, y integer)
RETURNS bytea
LANGUAGE plpgsql STABLE PARALLEL SAFE
AS $function$
DECLARE
    b3857 geometry;
    b4326 geometry;
BEGIN
    IF z < 15 THEN RETURN ''::bytea; END IF;

    b3857 := ST_TileEnvelope(z, x, y);
    b4326 := ST_Transform(b3857, 4326);

    RETURN COALESCE((
        SELECT ST_AsMVT(tile, 'connections', 4096, 'geom', 'id') FROM (
            SELECT DISTINCT ON (station_id, display_name)
                (station_id) as id,
                ST_AsMVTGeom(ST_Transform(connection_geom, 3857), b3857, 4096, 4096, false) AS geom,
                station_id, display_name
            FROM (
                SELECT
                    sp.station_id, sp.connection_geom, sp.marker_geom,
                    COALESCE(sp.ref, UPPER(split_part(sp.ref_ifopt, ':', array_length(string_to_array(sp.ref_ifopt, ':'), 1))), sp.name) as display_name
                FROM stop_positions sp
                WHERE connection_geom IS NOT NULL
                  AND (marker_geom && ST_Expand(b4326, 0.01) OR EXISTS (
                      SELECT 1 FROM stations s WHERE s.osm_id = sp.station_id AND s.geom && ST_Expand(b4326, 0.01)
                  ))
            ) sub
            ORDER BY station_id, display_name, connection_geom
        ) AS tile WHERE geom IS NOT NULL
    ), ''::bytea);
END;
$function$;

-------------------------------------------------------------------------------
-- 4. Comments
-------------------------------------------------------------------------------
COMMENT ON FUNCTION tile_stations IS 'Individual tile function: station markers with min_zoom filtering';
COMMENT ON FUNCTION tile_routes IS 'Individual tile function: route geometries with zoom-dependent filtering';
COMMENT ON FUNCTION tile_steige IS 'Individual tile function: user-facing platform markers (3-tier priority)';
COMMENT ON FUNCTION tile_platform_outlines IS 'Individual tile function: physical platform way outlines';
COMMENT ON FUNCTION tile_debug_stops IS 'Individual tile function: raw OSM stop_positions (debug)';
COMMENT ON FUNCTION tile_debug_platforms IS 'Individual tile function: raw OSM platform nodes (debug)';
COMMENT ON FUNCTION tile_debug_connections IS 'Individual tile function: stop-to-station connection lines (debug)';
