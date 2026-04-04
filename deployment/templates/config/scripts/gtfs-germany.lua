-- Reclassify German GTFS route types for correct MOTIS transit mode filtering.
--
-- The gtfs-germany feed uses generic route_type=2 (Rail) for all rail services.
-- This script reclassifies long-distance services to extended route types so
-- MOTIS can filter them via transitModes (e.g. Deutschland-Ticket = Nahverkehr only).
--
-- Mapping:
--   DB Fernverkehr AG (route_type=2) -> HIGH_SPEED_RAIL_SERVICE (101)
--   FlixTrain (route_type=2) -> LONG_DISTANCE_TRAINS_SERVICE (102)
--   Flixbus (route_type=3) -> COACH_SERVICE (200)

function process_route(route)
    local agency_name = route:get_agency():get_name()
    local rt = route:get_route_type()

    -- DB Fernverkehr: all rail services -> high speed rail
    if rt == 2 and agency_name == "DB Fernverkehr AG" then
        route:set_route_type(HIGH_SPEED_RAIL_SERVICE)
    end

    -- FlixTrain: rail -> long distance
    if rt == 2 and (agency_name == "FlixTrain" or agency_name == "Flixtrain") then
        route:set_route_type(LONG_DISTANCE_TRAINS_SERVICE)
    end

    -- Flixbus: bus -> coach
    if rt == 3 and (agency_name == "Flixbus" or agency_name == "FlixBus") then
        route:set_route_type(COACH_SERVICE)
    end

    return true
end
