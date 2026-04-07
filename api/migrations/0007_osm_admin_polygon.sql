-- Build administrative boundary polygons (GeoJSON) on demand from the slim
-- osm2pgsql tables. Used by the diagnostics panel to display the actual
-- shape of a Bundesland (or Germany) being generated, instead of a bbox.
--
-- Maps user-friendly area names ("bayern", "nrw", "germany") to the OSM
-- admin relation id and assembles the polygon by joining members.

CREATE OR REPLACE FUNCTION osm_admin_relation_id(area_name TEXT) RETURNS BIGINT AS $$
BEGIN
    -- Normalize: lowercase, no spaces
    RETURN (
        SELECT CASE LOWER(REPLACE(area_name, ' ', ''))
            -- Whole country
            WHEN 'germany' THEN 51477
            WHEN 'deutschland' THEN 51477
            WHEN 'de' THEN 51477
            -- 16 Bundesländer with German + English aliases + ISO codes
            WHEN 'baden-wurttemberg' THEN 62611
            WHEN 'baden-württemberg' THEN 62611
            WHEN 'baden-wuerttemberg' THEN 62611
            WHEN 'bw' THEN 62611
            WHEN 'bayern' THEN 2145268
            WHEN 'bavaria' THEN 2145268
            WHEN 'by' THEN 2145268
            WHEN 'berlin' THEN 62422
            WHEN 'be' THEN 62422
            WHEN 'brandenburg' THEN 62504
            WHEN 'bb' THEN 62504
            WHEN 'bremen' THEN 62718
            WHEN 'hb' THEN 62718
            WHEN 'hamburg' THEN 62782
            WHEN 'hh' THEN 62782
            WHEN 'hessen' THEN 62650
            WHEN 'hesse' THEN 62650
            WHEN 'he' THEN 62650
            WHEN 'mecklenburg-vorpommern' THEN 28322
            WHEN 'mecklenburg-western-pomerania' THEN 28322
            WHEN 'mv' THEN 28322
            WHEN 'niedersachsen' THEN 62771
            WHEN 'lower-saxony' THEN 62771
            WHEN 'ni' THEN 62771
            WHEN 'nordrhein-westfalen' THEN 62761
            WHEN 'north-rhine-westphalia' THEN 62761
            WHEN 'nrw' THEN 62761
            WHEN 'rheinland-pfalz' THEN 62341
            WHEN 'rhineland-palatinate' THEN 62341
            WHEN 'rp' THEN 62341
            WHEN 'saarland' THEN 62372
            WHEN 'sl' THEN 62372
            WHEN 'sachsen' THEN 62467
            WHEN 'saxony' THEN 62467
            WHEN 'sn' THEN 62467
            WHEN 'sachsen-anhalt' THEN 62607
            WHEN 'saxony-anhalt' THEN 62607
            WHEN 'st' THEN 62607
            WHEN 'schleswig-holstein' THEN 51529
            WHEN 'sh' THEN 51529
            WHEN 'thuringen' THEN 62366
            WHEN 'thüringen' THEN 62366
            WHEN 'thueringen' THEN 62366
            WHEN 'thuringia' THEN 62366
            WHEN 'th' THEN 62366
            ELSE NULL
        END
    );
END;
$$ LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE;

COMMENT ON FUNCTION osm_admin_relation_id(TEXT) IS
    'Map user-friendly area name to OSM admin relation id for the 16 German Bundesländer + Germany.';

-- Assemble a polygon for an OSM admin relation by joining its outer member
-- ways and node coordinates. Returns a GeoJSON Feature with the simplified
-- polygon geometry (tolerance 0.005° ~500m, plenty for a status display).
CREATE OR REPLACE FUNCTION osm_admin_polygon(area_name TEXT)
RETURNS JSONB AS $$
DECLARE
    rel_id BIGINT;
    polygon_geom GEOMETRY;
    feature JSONB;
BEGIN
    rel_id := osm_admin_relation_id(area_name);
    IF rel_id IS NULL THEN
        RETURN NULL;
    END IF;

    WITH way_members AS (
        SELECT (m->>'ref')::bigint AS way_id
        FROM planet_osm_rels, jsonb_array_elements(members) AS m
        WHERE id = rel_id
          AND m->>'type' = 'W'
          AND m->>'role' = 'outer'
    ),
    way_lines AS (
        SELECT
            ST_MakeLine(array_agg(
                ST_SetSRID(ST_MakePoint(n.lon::float / 1e7, n.lat::float / 1e7), 4326)
                ORDER BY o.idx
            )) AS geom
        FROM way_members wm
        JOIN planet_osm_ways w ON w.id = wm.way_id
        CROSS JOIN LATERAL unnest(w.nodes) WITH ORDINALITY AS o(node_id, idx)
        JOIN planet_osm_nodes n ON n.id = o.node_id
        GROUP BY wm.way_id
    )
    SELECT ST_SimplifyPreserveTopology(
        ST_BuildArea(ST_LineMerge(ST_Collect(geom))),
        0.005
    )
    INTO polygon_geom
    FROM way_lines;

    IF polygon_geom IS NULL THEN
        RETURN NULL;
    END IF;

    feature := jsonb_build_object(
        'type', 'Feature',
        'properties', jsonb_build_object('name', area_name, 'osm_relation_id', rel_id),
        'geometry', ST_AsGeoJSON(polygon_geom)::jsonb
    );
    RETURN feature;
END;
$$ LANGUAGE plpgsql STABLE PARALLEL SAFE;

COMMENT ON FUNCTION osm_admin_polygon(TEXT) IS
    'Return a GeoJSON Feature with the simplified outer polygon for a named German Bundesland or Germany. NULL for unknown names or missing OSM data.';
