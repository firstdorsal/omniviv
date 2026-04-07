-- Lower the zoom cutoff for stops/platforms/connections/steige/outlines from
-- z >= 15 to z >= 14 in the composite transit_stations() function.
--
-- The frontend source `transit-stations` has maxzoom=14, so MapLibre overzooms
-- z14 tiles for z15+. This means the layer data must be present at z14 (not
-- only at z15) for steige/platform markers and station connection lines to
-- appear at all zoom levels.
--
-- Re-creates the entire function with `IF z >= 14 THEN` instead of `>= 15`.

CREATE OR REPLACE FUNCTION public.transit_stations(z integer, x integer, y integer)
 RETURNS bytea
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
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
BEGIN
    b3857 := ST_TileEnvelope(z, x, y);
    b4326 := ST_Transform(b3857, 4326);

    -- 1. Stations (Explicit ID)
    -- min_zoom is precomputed by the API during station sync
    SELECT COALESCE(ST_AsMVT(tile, 'stations', 4096, 'geom', 'id'), ''::bytea) INTO stations_mvt FROM (
        SELECT
            osm_id as id, osm_id, name, ref_ifopt, min_zoom,
            ST_AsMVTGeom(ST_Transform(geom, 3857), b3857, 4096, 4096, false) AS geom
        FROM stations s
        WHERE geom && ST_Expand(b4326, 0.01)
           OR EXISTS (SELECT 1 FROM stop_positions sp WHERE sp.station_id = s.osm_id AND sp.marker_geom && ST_Expand(b4326, 0.01))
    ) AS tile WHERE geom IS NOT NULL;

    -- 2-6. Stops, connections, platforms, steige, outlines (z >= 14 so the
    -- frontend can overzoom z14 tiles up to display zoom levels)
    IF z >= 14 THEN
        -- 2. Stop positions — exact OSM stop_position locations (on the track/rail)
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
                FROM stop_positions sp
                WHERE station_id IS NOT NULL
                  AND sp.geom IS NOT NULL
                  AND (sp.geom && ST_Expand(b4326, 0.01) OR EXISTS (
                      SELECT 1 FROM stations s WHERE s.osm_id = sp.station_id AND s.geom && ST_Expand(b4326, 0.01)
                  ))
            ) sub
        ) AS tile WHERE geom IS NOT NULL;

        -- 3. Connections (Explicit ID)
        SELECT COALESCE(ST_AsMVT(tile, 'connections', 4096, 'geom', 'id'), ''::bytea) INTO connections_mvt FROM (
            SELECT DISTINCT ON (station_id, display_name)
                (station_id) as id, -- Consistent ID for the connection group
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
            WHERE pw.station_id IS NOT NULL AND pw.geom && ST_Expand(b4326, 0.01)
            UNION ALL
            -- Platform point nodes (for stops without platform_ways)
            SELECT
                p.osm_id as id, p.osm_id, p.name, p.ref as platform_ref, p.ref_ifopt, p.station_id,
                COALESCE(p.ref, UPPER(split_part(p.ref_ifopt, ':', array_length(string_to_array(p.ref_ifopt, ':'), 1))), (p.osm_id % 1000)::text) as display_name,
                ST_X(p.geom) as lon, ST_Y(p.geom) as lat,
                ST_AsMVTGeom(ST_Transform(p.geom, 3857), b3857, 4096, 4096, false) AS geom
            FROM platforms p
            WHERE p.station_id IS NOT NULL AND p.geom && ST_Expand(b4326, 0.01)
        ) AS tile WHERE geom IS NOT NULL;
        -- 5. Steige (user-facing platform markers with 3-tier position priority)
        -- Priority: platform_ways centroids (physical passenger area) > platforms (point nodes)
        --         > stop_positions (on-track fallback, only when no platform/platform_way matches)
        -- Each row carries stop_osm_id: the OSM ID of the associated stop_position that has
        -- a GTFS mapping, used by the frontend to fetch departures via /api/departures/by-osm-id.
        -- Semicolons in ref or ref_ifopt (e.g. "A;B") are split into separate rows.
        SELECT COALESCE(ST_AsMVT(tile, 'steige', 4096, 'geom', 'id'), ''::bytea) INTO steige_mvt FROM (
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

                -- Tier 2: platforms (point nodes — explicit platform markers)
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

                -- Tier 3: stop_positions (on-track fallback) — stop_osm_id is its own osm_id
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
        ) AS tile WHERE geom IS NOT NULL;

        -- 6. Platform outlines (physical platform way geometries as lines)
        SELECT COALESCE(ST_AsMVT(tile, 'platform_outlines', 4096, 'geom', 'id'), ''::bytea) INTO outlines_mvt FROM (
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
