-- Add clip_bbox support to transit_stations() and transit_routes() so
-- low-zoom tiles contain only data within the generation bbox.
--
-- Background:
--   The tile SQL function gets called with (z, x, y) and produces MVT
--   content for that tile. At high zoom the tile's bbox is small so the
--   function naturally returns only local data. At low zoom one tile
--   covers huge territory (e.g. z6 covers all of southern Germany),
--   so the function returns data for every station/route in that area —
--   not just the area the operator wanted to generate.
--
--   Previously we worked around this by raising tilegen's `min_zoom` to 10
--   so low-zoom tiles were simply skipped. That left z<10 blank, which
--   isn't what the user wants — they want to zoom out and still see the
--   Augsburg stations, just no Munich etc.
--
-- Fix:
--   martin-cp can pass a URL query to the function as a jsonb parameter
--   (when the function has the 4-arg signature `fn(z,x,y,query_params)`).
--   Tilegen now passes `clip_w`, `clip_s`, `clip_e`, `clip_n` with the
--   resolved generation bbox, and the function uses that to:
--     1. Early-exit with empty MVT if the tile doesn't touch the clip bbox
--        (saves cost on most tiles at low zoom).
--     2. Intersect the per-sub-query bbox with the clip bbox so only
--        data inside the generation bbox is returned.
--
--   We only expose the 4-arg signature. An earlier version of this file
--   also kept a 3-arg wrapper for backwards-compat, but martin-cp's source
--   resolver non-deterministically chose between the two overloads (it
--   picked 4-arg for transit_stations but 3-arg for transit_routes in the
--   same run, silently ignoring the --url-query flag for routes). With
--   only the 4-arg form present there is no ambiguity.

-- Drop the old 3-arg signatures so we can recreate cleanly. IF EXISTS so
-- the migration is re-runnable.
DROP FUNCTION IF EXISTS public.transit_stations(integer, integer, integer);
DROP FUNCTION IF EXISTS public.transit_routes(integer, integer, integer);

-------------------------------------------------------------------------------
-- transit_stations (4-arg, with optional clip_bbox from query_params)
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transit_stations(
    z integer, x integer, y integer, query_params jsonb
)
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
    clip_bbox geometry;
    nearby_station_ids bigint[];
BEGIN
    b3857 := ST_TileEnvelope(z, x, y);
    b4326 := ST_Transform(b3857, 4326);

    -- Parse optional clip_bbox from query_params. When set, the tile only
    -- contains data inside the intersection of (tile_bbox, clip_bbox).
    IF query_params ? 'clip_w' THEN
        clip_bbox := ST_MakeEnvelope(
            (query_params->>'clip_w')::double precision,
            (query_params->>'clip_s')::double precision,
            (query_params->>'clip_e')::double precision,
            (query_params->>'clip_n')::double precision,
            4326
        );
        -- Early exit when the tile doesn't touch the clip bbox at all —
        -- most low-zoom tiles fall in this bucket, making them essentially
        -- free to "generate".
        IF NOT (b4326 && clip_bbox) THEN
            RETURN ''::bytea;
        END IF;
        bbox_expanded := ST_Intersection(ST_Expand(b4326, 0.01), clip_bbox);
    ELSE
        bbox_expanded := ST_Expand(b4326, 0.01);
    END IF;

    -- Precompute station IDs near the (clipped) tile bbox. Filtered by
    -- min_zoom <= z so we don't pull in stations that wouldn't be visible
    -- at this zoom anyway.
    SELECT COALESCE(array_agg(osm_id), ARRAY[]::bigint[])
      INTO nearby_station_ids
      FROM stations
      WHERE geom && bbox_expanded AND min_zoom <= z;

    -- 1. Stations (filtered by min_zoom <= z and the clipped bbox).
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
                    SELECT sp.osm_id, sp.name, sp.ref, sp.ref_ifopt, sp.station_id, sp.geom
                    FROM stop_positions sp
                    WHERE sp.station_id IS NOT NULL AND sp.geom IS NOT NULL
                      AND sp.geom && bbox_expanded
                    UNION
                    SELECT sp.osm_id, sp.name, sp.ref, sp.ref_ifopt, sp.station_id, sp.geom
                    FROM stop_positions sp
                    WHERE sp.station_id = ANY(nearby_station_ids) AND sp.geom IS NOT NULL
                ) sp
            ) sub
        ) AS tile WHERE geom IS NOT NULL;

        -- 3. Connections
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
                    SELECT sp.station_id, sp.connection_geom, sp.marker_geom, sp.ref, sp.ref_ifopt, sp.name
                    FROM stop_positions sp
                    WHERE sp.connection_geom IS NOT NULL
                      AND sp.marker_geom && bbox_expanded
                    UNION
                    SELECT sp.station_id, sp.connection_geom, sp.marker_geom, sp.ref, sp.ref_ifopt, sp.name
                    FROM stop_positions sp
                    WHERE sp.connection_geom IS NOT NULL
                      AND sp.station_id = ANY(nearby_station_ids)
                ) sp
            ) sub
            ORDER BY station_id, display_name, connection_geom
        ) AS tile WHERE geom IS NOT NULL;

        -- 4. Platforms (debug)
        SELECT COALESCE(ST_AsMVT(tile, 'platforms', 4096, 'geom', 'id'), ''::bytea) INTO platforms_mvt FROM (
            SELECT
                pw.osm_id as id, pw.osm_id, pw.name, pw.ref as platform_ref, pw.ref_ifopt, pw.station_id,
                COALESCE(pw.ref, UPPER(split_part(pw.ref_ifopt, ':', array_length(string_to_array(pw.ref_ifopt, ':'), 1))), (pw.osm_id % 1000)::text) as display_name,
                ST_X(pw.geom) as lon, ST_Y(pw.geom) as lat,
                ST_AsMVTGeom(ST_Transform(pw.geom, 3857), b3857, 4096, 4096, false) AS geom
            FROM platform_ways pw
            WHERE pw.station_id IS NOT NULL AND pw.geom && bbox_expanded
            UNION ALL
            SELECT
                p.osm_id as id, p.osm_id, p.name, p.ref as platform_ref, p.ref_ifopt, p.station_id,
                COALESCE(p.ref, UPPER(split_part(p.ref_ifopt, ':', array_length(string_to_array(p.ref_ifopt, ':'), 1))), (p.osm_id % 1000)::text) as display_name,
                ST_X(p.geom) as lon, ST_Y(p.geom) as lat,
                ST_AsMVTGeom(ST_Transform(p.geom, 3857), b3857, 4096, 4096, false) AS geom
            FROM platforms p
            WHERE p.station_id IS NOT NULL AND p.geom && bbox_expanded
        ) AS tile WHERE geom IS NOT NULL;

        -- 5. Steige (user-facing platform markers, 3-tier priority)
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
                    SELECT * FROM platform_ways pw
                    WHERE pw.station_id IS NOT NULL AND pw.geom IS NOT NULL
                      AND pw.geom && bbox_expanded
                    UNION
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

                -- Tier 3: stop_positions
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

        -- 6. Platform outlines
        SELECT COALESCE(ST_AsMVT(tile, 'platform_outlines', 4096, 'geom', 'id'), ''::bytea) INTO outlines_mvt FROM (
            SELECT
                pw.osm_id as id, pw.osm_id, pw.name, pw.ref as platform_ref, pw.ref_ifopt, pw.station_id,
                COALESCE(pw.ref, UPPER(split_part(pw.ref_ifopt, ':', array_length(string_to_array(pw.ref_ifopt, ':'), 1))), pw.name) as display_name,
                ST_AsMVTGeom(ST_Transform(pw.line_geom, 3857), b3857, 4096, 4096, false) AS geom
            FROM (
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

-------------------------------------------------------------------------------
-- transit_routes (4-arg, with optional clip_bbox)
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transit_routes(
    z integer, x integer, y integer, query_params jsonb
)
 RETURNS bytea
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$
DECLARE
    b3857 geometry;
    b4326 geometry;
    clip_bbox geometry;
    bbox_4326 geometry;
BEGIN
    b3857 := ST_TileEnvelope(z, x, y);
    b4326 := ST_Transform(b3857, 4326);

    IF query_params ? 'clip_w' THEN
        clip_bbox := ST_MakeEnvelope(
            (query_params->>'clip_w')::double precision,
            (query_params->>'clip_s')::double precision,
            (query_params->>'clip_e')::double precision,
            (query_params->>'clip_n')::double precision,
            4326
        );
        IF NOT (b4326 && clip_bbox) THEN
            RETURN ''::bytea;
        END IF;
        bbox_4326 := ST_Intersection(ST_Expand(b4326, 0.002), clip_bbox);
    ELSE
        bbox_4326 := ST_Expand(b4326, 0.002);
    END IF;

    RETURN COALESCE((
        SELECT ST_AsMVT(tile, 'transit_routes', 4096, 'geom') FROM (
            SELECT
                r.osm_id, r.name, r.ref, r.route_type, r.color,
                r.operator, r.network, r.min_zoom,
                ST_AsMVTGeom(
                    ST_Transform(
                        ST_ClipByBox2D(r.geom, bbox_4326),
                        3857
                    ),
                    b3857,
                    4096, 256, true
                ) AS geom
            FROM routes r
            WHERE r.geom IS NOT NULL
              AND r.min_zoom <= z
              AND r.geom && bbox_4326
        ) AS tile
        WHERE geom IS NOT NULL
    ), ''::bytea);
END;
$function$;
