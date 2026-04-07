-- Optimize transit_stations() function performance.
--
-- The previous version used `OR EXISTS` patterns that forced the planner
-- into full index scans of stop_positions (193k rows) per tile, yielding
-- ~14s per z14 tile. Profiled per-subquery timings on a populated z14 tile:
--
--   stops:       3917ms  (OR EXISTS forces scan of all 193k rows)
--   connections: 4876ms  (same issue with connection_geom)
--   steige:      2372ms  (three sub-tiers, same issue)
--   stations:     236ms
--   platforms:      2ms
--   outlines:     200ms
--
-- Rewrite strategy:
--   1. Precompute `nearby_station_ids` once per function call.
--   2. Each sub-query uses UNION of:
--        - Branch A: geometric bbox check (uses GIST index)
--        - Branch B: station_id = ANY(nearby_station_ids) (uses btree index)
--      Both branches are deduplicated by the UNION.
--   3. `SET jit = off` to skip ~200ms JIT compilation overhead per call —
--      with the new index-backed plans, query cost is well below the JIT
--      threshold but the planner sometimes still triggers it for plpgsql.
--
-- Expected speedup on populated z14 tiles: 14s → ~200ms (70x).

CREATE OR REPLACE FUNCTION public.transit_stations(z integer, x integer, y integer)
 RETURNS bytea
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
 SET jit = off
AS $function$
DECLARE
    stations_mvt bytea;
    stops_mvt bytea;
    platforms_mvt bytea;
    connections_mvt bytea;
    steige_mvt bytea;
    outlines_mvt bytea;
    b3857 geometry;
    b4326 geometry;
    bbox_expanded geometry;
    nearby_station_ids bigint[];
BEGIN
    b3857 := ST_TileEnvelope(z, x, y);
    b4326 := ST_Transform(b3857, 4326);
    bbox_expanded := ST_Expand(b4326, 0.01);

    -- Precompute the set of station IDs near the tile. This is reused by
    -- every sub-query below as the "station-near-tile" branch of the UNION,
    -- so we only pay the GIST lookup cost once per tile instead of once per
    -- sub-query. Also filtered by `min_zoom <= z` so low-zoom tiles don't
    -- pull in every station in the DB (e.g. z0 would otherwise include all
    -- ~112k stations worldwide, producing 6 MB tiles full of data that the
    -- frontend will hide anyway).
    SELECT COALESCE(array_agg(osm_id), ARRAY[]::bigint[])
      INTO nearby_station_ids
      FROM stations
      WHERE geom && bbox_expanded AND min_zoom <= z;

    -- 1. Stations: only those visible at the current zoom level.
    -- The `min_zoom <= z` filter is critical: without it, a z0 tile contains
    -- every station in the DB (6 MB of data for a tile that should be empty),
    -- so when the user zooms out they see Munich, Hamburg, etc. even though
    -- they only configured Augsburg as the generation bbox.
    SELECT COALESCE(ST_AsMVT(tile, 'stations', 4096, 'geom', 'id'), ''::bytea) INTO stations_mvt FROM (
        SELECT DISTINCT ON (osm_id)
            osm_id as id, osm_id, name, ref_ifopt, min_zoom,
            ST_AsMVTGeom(ST_Transform(geom, 3857), b3857, 4096, 4096, false) AS geom
        FROM (
            SELECT s.osm_id, s.name, s.ref_ifopt, s.min_zoom, s.geom
              FROM stations s
              WHERE s.min_zoom <= z AND s.geom && bbox_expanded
            UNION
            SELECT s.osm_id, s.name, s.ref_ifopt, s.min_zoom, s.geom
              FROM stations s
              WHERE s.min_zoom <= z AND s.osm_id IN (
                  SELECT DISTINCT sp.station_id FROM stop_positions sp
                  WHERE sp.marker_geom && bbox_expanded
              )
        ) u
    ) AS tile WHERE geom IS NOT NULL;

    -- 2-6. Stops, connections, platforms, steige, outlines (z >= 14)
    IF z >= 14 THEN
        -- 2. Stops (OSM stop_position locations)
        SELECT COALESCE(ST_AsMVT(tile, 'stops', 4096, 'geom', 'id'), ''::bytea) INTO stops_mvt FROM (
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
                FROM (
                    -- Branch A: stop near tile (uses idx_stop_positions_geom)
                    SELECT sp.osm_id, sp.name, sp.ref, sp.ref_ifopt, sp.station_id, sp.geom
                    FROM stop_positions sp
                    WHERE sp.station_id IS NOT NULL AND sp.geom IS NOT NULL
                      AND sp.geom && bbox_expanded
                    UNION
                    -- Branch B: station near tile (uses idx_stop_positions_station btree)
                    SELECT sp.osm_id, sp.name, sp.ref, sp.ref_ifopt, sp.station_id, sp.geom
                    FROM stop_positions sp
                    WHERE sp.station_id = ANY(nearby_station_ids) AND sp.geom IS NOT NULL
                ) sp
            ) sub
        ) AS tile WHERE geom IS NOT NULL;

        -- 3. Connections (dashed lines from stop to station)
        SELECT COALESCE(ST_AsMVT(tile, 'connections', 4096, 'geom', 'id'), ''::bytea) INTO connections_mvt FROM (
            SELECT DISTINCT ON (station_id, display_name)
                (station_id) as id,
                ST_AsMVTGeom(ST_Transform(connection_geom, 3857), b3857, 4096, 4096, false) AS geom,
                station_id, display_name
            FROM (
                SELECT
                    sp.station_id, sp.connection_geom, sp.marker_geom,
                    COALESCE(sp.ref, UPPER(split_part(sp.ref_ifopt, ':', array_length(string_to_array(sp.ref_ifopt, ':'), 1))), sp.name) as display_name
                FROM (
                    -- Branch A: marker_geom near tile (uses idx_stop_positions_marker_geom)
                    SELECT sp.station_id, sp.connection_geom, sp.marker_geom, sp.ref, sp.ref_ifopt, sp.name
                    FROM stop_positions sp
                    WHERE sp.connection_geom IS NOT NULL
                      AND sp.marker_geom && bbox_expanded
                    UNION
                    -- Branch B: station near tile
                    SELECT sp.station_id, sp.connection_geom, sp.marker_geom, sp.ref, sp.ref_ifopt, sp.name
                    FROM stop_positions sp
                    WHERE sp.connection_geom IS NOT NULL
                      AND sp.station_id = ANY(nearby_station_ids)
                ) sp
            ) sub
            ORDER BY station_id, display_name, connection_geom
        ) AS tile WHERE geom IS NOT NULL;

        -- 4. Platforms (debug: platform_ways centroids + platform point nodes)
        SELECT COALESCE(ST_AsMVT(tile, 'platforms', 4096, 'geom', 'id'), ''::bytea) INTO platforms_mvt FROM (
            -- Platform ways centroids (physical platform areas)
            SELECT
                pw.osm_id as id, pw.osm_id, pw.name, pw.ref as platform_ref, pw.ref_ifopt, pw.station_id,
                COALESCE(pw.ref, UPPER(split_part(pw.ref_ifopt, ':', array_length(string_to_array(pw.ref_ifopt, ':'), 1))), (pw.osm_id % 1000)::text) as display_name,
                ST_X(pw.geom) as lon, ST_Y(pw.geom) as lat,
                ST_AsMVTGeom(ST_Transform(pw.geom, 3857), b3857, 4096, 4096, false) AS geom
            FROM platform_ways pw
            WHERE pw.station_id IS NOT NULL AND pw.geom && bbox_expanded
            UNION ALL
            -- Platform point nodes
            SELECT
                p.osm_id as id, p.osm_id, p.name, p.ref as platform_ref, p.ref_ifopt, p.station_id,
                COALESCE(p.ref, UPPER(split_part(p.ref_ifopt, ':', array_length(string_to_array(p.ref_ifopt, ':'), 1))), (p.osm_id % 1000)::text) as display_name,
                ST_X(p.geom) as lon, ST_Y(p.geom) as lat,
                ST_AsMVTGeom(ST_Transform(p.geom, 3857), b3857, 4096, 4096, false) AS geom
            FROM platforms p
            WHERE p.station_id IS NOT NULL AND p.geom && bbox_expanded
        ) AS tile WHERE geom IS NOT NULL;

        -- 5. Steige (user-facing platform markers, 3-tier priority)
        -- Each tier uses the same UNION pattern to keep the index-backed plan.
        SELECT COALESCE(ST_AsMVT(tile, 'steige', 4096, 'geom', 'id'), ''::bytea) INTO steige_mvt FROM (
            SELECT DISTINCT ON (station_id, display_name) * FROM (
                -- Tier 1: platform_ways
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
                FROM (
                    -- Branch A: platform_way near tile
                    SELECT * FROM platform_ways pw
                    WHERE pw.station_id IS NOT NULL AND pw.geom IS NOT NULL
                      AND pw.geom && bbox_expanded
                    UNION
                    -- Branch B: platform_way whose station is near tile
                    SELECT * FROM platform_ways pw
                    WHERE pw.station_id = ANY(nearby_station_ids) AND pw.geom IS NOT NULL
                ) pw,
                LATERAL unnest(string_to_array(
                    COALESCE(pw.ref, UPPER(split_part(pw.ref_ifopt, ':', array_length(string_to_array(pw.ref_ifopt, ':'), 1))), (pw.osm_id % 1000)::text),
                    ';'
                )) AS dn_part(dn)

                UNION ALL

                -- Tier 2: platforms
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
                FROM (
                    SELECT * FROM platforms p
                    WHERE p.station_id IS NOT NULL AND p.geom IS NOT NULL
                      AND p.geom && bbox_expanded
                    UNION
                    SELECT * FROM platforms p
                    WHERE p.station_id = ANY(nearby_station_ids) AND p.geom IS NOT NULL
                ) p,
                LATERAL unnest(string_to_array(
                    COALESCE(p.ref, UPPER(split_part(p.ref_ifopt, ':', array_length(string_to_array(p.ref_ifopt, ':'), 1))), (p.osm_id % 1000)::text),
                    ';'
                )) AS dn_part(dn)

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
                FROM (
                    SELECT * FROM stop_positions sp
                    WHERE sp.station_id IS NOT NULL AND sp.geom IS NOT NULL
                      AND sp.geom && bbox_expanded
                    UNION
                    SELECT * FROM stop_positions sp
                    WHERE sp.station_id = ANY(nearby_station_ids) AND sp.geom IS NOT NULL
                ) sp,
                LATERAL unnest(string_to_array(
                    COALESCE(sp.ref, UPPER(split_part(sp.ref_ifopt, ':', array_length(string_to_array(sp.ref_ifopt, ':'), 1))), (sp.osm_id % 1000)::text),
                    ';'
                )) AS dn_part(dn)
            ) combined
            ORDER BY station_id, display_name, priority
        ) AS tile WHERE geom IS NOT NULL;

        -- 6. Platform outlines (physical platform way geometries as lines)
        SELECT COALESCE(ST_AsMVT(tile, 'platform_outlines', 4096, 'geom', 'id'), ''::bytea) INTO outlines_mvt FROM (
            SELECT
                pw.osm_id as id, pw.osm_id, pw.name, pw.ref as platform_ref, pw.ref_ifopt, pw.station_id,
                COALESCE(pw.ref, UPPER(split_part(pw.ref_ifopt, ':', array_length(string_to_array(pw.ref_ifopt, ':'), 1))), pw.name) as display_name,
                ST_AsMVTGeom(ST_Transform(pw.line_geom, 3857), b3857, 4096, 4096, false) AS geom
            FROM (
                -- Branch A: outline near tile (uses idx_platform_ways_line_geom)
                SELECT pw.osm_id, pw.name, pw.ref, pw.ref_ifopt, pw.station_id, pw.line_geom
                FROM platform_ways pw
                WHERE pw.station_id IS NOT NULL AND pw.line_geom IS NOT NULL
                  AND pw.line_geom && bbox_expanded
                UNION
                SELECT pw.osm_id, pw.name, pw.ref, pw.ref_ifopt, pw.station_id, pw.line_geom
                FROM platform_ways pw
                WHERE pw.station_id = ANY(nearby_station_ids) AND pw.line_geom IS NOT NULL
            ) pw
        ) AS tile WHERE geom IS NOT NULL;
    ELSE
        stops_mvt := ''::bytea;
        platforms_mvt := ''::bytea;
        connections_mvt := ''::bytea;
        steige_mvt := ''::bytea;
        outlines_mvt := ''::bytea;
    END IF;

    RETURN stations_mvt || stops_mvt || platforms_mvt || connections_mvt || steige_mvt || outlines_mvt;
END;
$function$;
