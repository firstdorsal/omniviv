-- osm2pgsql flex output for importing all transit data from OSM PBF.
-- Replaces Overpass API entirely.
--
-- Route geometry is built in SQL (not via as_multilinestring) to exclude
-- platform way members which would otherwise create platform outlines.
--
-- Staging tables:
--   _osm_transit_routes       – route relation metadata (NO geometry)
--   _osm_transit_ways         – individual way geometries (for building route geometry)
--   _osm_route_way_members    – which ways belong to which routes, with role
--   _osm_transit_stations     – station nodes
--   _osm_transit_platforms    – platform nodes
--   _osm_transit_stops        – stop_position nodes
--   _osm_stop_area_members    – stop_area relation membership
--   _osm_route_stop_members   – route stop/platform node members with sequence

local TRANSIT_TYPES = {
    tram = true, bus = true, subway = true,
    train = true, light_rail = true, ferry = true,
}

local MIN_ZOOM = {
    train = 6, light_rail = 9, subway = 9,
    tram = 11, bus = 13, ferry = 13,
}

-- Route relation metadata (geometry built separately in SQL)
local routes_table = osm2pgsql.define_table({
    name = '_osm_transit_routes',
    ids = { type = 'relation', id_column = 'relation_id' },
    columns = {
        { column = 'name',       type = 'text' },
        { column = 'ref',        type = 'text' },
        { column = 'route_type', type = 'text' },
        { column = 'color',      type = 'text' },
        { column = 'operator',   type = 'text' },
        { column = 'network',    type = 'text' },
        { column = 'min_zoom',   type = 'int' },
        { column = 'tags',       type = 'jsonb' },
    },
})

-- Individual way geometries (joined with route_way_members to build route geometry)
local ways_table = osm2pgsql.define_way_table('_osm_transit_ways', {
    { column = 'geom', type = 'linestring', not_null = true },
})

-- Route-to-way membership with roles (role='platform' excluded from geometry)
local route_way_members_table = osm2pgsql.define_table({
    name = '_osm_route_way_members',
    ids = { type = 'any', id_column = 'row_id' },
    columns = {
        { column = 'route_id',    type = 'int8' },
        { column = 'way_id',      type = 'int8' },
        { column = 'member_role', type = 'text' },
        { column = 'sequence',    type = 'int' },
    },
})

-- Stations
local stations_table = osm2pgsql.define_node_table('_osm_transit_stations', {
    { column = 'name',      type = 'text' },
    { column = 'ref_ifopt', type = 'text' },
    { column = 'tags',      type = 'jsonb' },
    { column = 'geom',      type = 'point', not_null = true },
})

-- Platform nodes
local platforms_table = osm2pgsql.define_node_table('_osm_transit_platforms', {
    { column = 'name',      type = 'text' },
    { column = 'ref',       type = 'text' },
    { column = 'ref_ifopt', type = 'text' },
    { column = 'tags',      type = 'jsonb' },
    { column = 'geom',      type = 'point', not_null = true },
})

-- Platform ways (physical platform outlines/lines — stored with centroid for display)
local platform_ways_table = osm2pgsql.define_way_table('_osm_transit_platform_ways', {
    { column = 'name',      type = 'text' },
    { column = 'ref',       type = 'text' },
    { column = 'ref_ifopt', type = 'text' },
    { column = 'tags',      type = 'jsonb' },
    { column = 'geom',      type = 'linestring', not_null = true },
})

-- Stop positions
local stops_table = osm2pgsql.define_node_table('_osm_transit_stops', {
    { column = 'name',      type = 'text' },
    { column = 'ref',       type = 'text' },
    { column = 'ref_ifopt', type = 'text' },
    { column = 'tags',      type = 'jsonb' },
    { column = 'geom',      type = 'point', not_null = true },
})

-- stop_area membership
local stop_areas_table = osm2pgsql.define_table({
    name = '_osm_stop_area_members',
    ids = { type = 'any', id_column = 'row_id' },
    columns = {
        { column = 'relation_id',  type = 'int8' },
        { column = 'member_id',    type = 'int8' },
        { column = 'member_type',  type = 'text' },
        { column = 'member_role',  type = 'text' },
        { column = 'station_name', type = 'text' },
    },
})

-- Route stop/platform node members with sequence
local route_stops_table = osm2pgsql.define_table({
    name = '_osm_route_stop_members',
    ids = { type = 'any', id_column = 'row_id' },
    columns = {
        { column = 'route_id',    type = 'int8' },
        { column = 'member_id',   type = 'int8' },
        { column = 'member_type', type = 'text' },
        { column = 'member_role', type = 'text' },
        { column = 'sequence',    type = 'int' },
    },
})

-- Track which ways are members of transit route relations
local route_way_ids = {}

function osm2pgsql.process_node(object)
    local pt = object.tags['public_transport']
    local rw = object.tags.railway

    if pt == 'station' or rw == 'station' or rw == 'halt' then
        stations_table:insert({
            name      = object.tags.name,
            ref_ifopt = object.tags['ref:IFOPT'],
            tags      = object.tags,
            geom      = object:as_point(),
        })
    end

    if pt == 'platform' or rw == 'platform' then
        platforms_table:insert({
            name      = object.tags.name,
            ref       = object.tags.ref,
            ref_ifopt = object.tags['ref:IFOPT'],
            tags      = object.tags,
            geom      = object:as_point(),
        })
    end

    if pt == 'stop_position' then
        stops_table:insert({
            name      = object.tags.name,
            ref       = object.tags.ref,
            ref_ifopt = object.tags['ref:IFOPT'],
            tags      = object.tags,
            geom      = object:as_point(),
        })
    end
end

function osm2pgsql.select_relation_members(relation)
    if relation.tags.type == 'route' and TRANSIT_TYPES[relation.tags.route] then
        return { ways = osm2pgsql.way_member_ids(relation) }
    end
    -- Also request way members from stop_area relations (for platform ways)
    if relation.tags.type == 'public_transport' and
       (relation.tags.public_transport == 'stop_area' or relation.tags.public_transport == 'stop_area_group') then
        return { ways = osm2pgsql.way_member_ids(relation) }
    end
end

function osm2pgsql.process_way(object)
    -- Only store ways that are members of transit route relations
    if route_way_ids[object.id] then
        ways_table:insert({
            geom = object:as_linestring(),
        })
    end

    -- Platform ways (physical platform outlines)
    local pt = object.tags['public_transport']
    local rw = object.tags.railway
    if pt == 'platform' or rw == 'platform' then
        platform_ways_table:insert({
            name      = object.tags.name,
            ref       = object.tags.ref,
            ref_ifopt = object.tags['ref:IFOPT'],
            tags      = object.tags,
            geom      = object:as_linestring(),
        })
    end
end

function osm2pgsql.process_relation(object)
    -- Route relations
    if object.tags.type == 'route' and TRANSIT_TYPES[object.tags.route] then
        local route_type = object.tags.route
        local color = object.tags.colour or object.tags.color
        if color and color:match('^%x%x%x%x%x%x$') then
            color = '#' .. color
        end

        -- Store route metadata (no geometry — built in SQL from non-platform ways)
        routes_table:insert({
            name       = object.tags.name,
            ref        = object.tags.ref,
            route_type = route_type,
            color      = color,
            operator   = object.tags.operator,
            network    = object.tags.network,
            min_zoom   = MIN_ZOOM[route_type] or 13,
            tags       = object.tags,
        })

        -- Track way members with roles and sequence
        local way_seq = 0
        local stop_seq = 0
        for _, member in ipairs(object.members) do
            if member.type == 'w' then
                way_seq = way_seq + 1
                route_way_ids[member.ref] = true
                route_way_members_table:insert({
                    route_id    = object.id,
                    way_id      = member.ref,
                    member_role = member.role or '',
                    sequence    = way_seq,
                })
            end
            if member.type == 'n' and (member.role == 'stop' or member.role == 'platform') then
                stop_seq = stop_seq + 1
                route_stops_table:insert({
                    route_id    = object.id,
                    member_id   = member.ref,
                    member_type = 'node',
                    member_role = member.role,
                    sequence    = stop_seq,
                })
            end
        end
    end

    -- stop_area relations
    if object.tags.type == 'public_transport' and object.tags.public_transport == 'stop_area' then
        for _, member in ipairs(object.members) do
            stop_areas_table:insert({
                relation_id  = object.id,
                member_id    = member.ref,
                member_type  = member.type == 'n' and 'node' or (member.type == 'w' and 'way' or 'relation'),
                member_role  = member.role or '',
                station_name = object.tags.name,
            })
        end
    end

    -- stop_area_group relations (group multiple stop_areas that belong to the same station)
    if object.tags.type == 'public_transport' and object.tags.public_transport == 'stop_area_group' then
        for _, member in ipairs(object.members) do
            stop_areas_table:insert({
                relation_id  = object.id,
                member_id    = member.ref,
                member_type  = member.type == 'n' and 'node' or (member.type == 'w' and 'way' or 'relation'),
                member_role  = member.role or '',
                station_name = object.tags.name,
            })
        end
    end
end
