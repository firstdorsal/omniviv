# API Documentation

## Overview

The Omniviv API provides real-time public transport data including stations, departures, routes, and vehicle tracking. Built with Axum (Rust).

## Base URL

- Development: `http://localhost:3000`
- Production: Configured via deployment

## Interactive Documentation

Swagger UI is available at `/swagger-ui/` when the API is running.

OpenAPI spec: `/api-docs/openapi.json`

## Endpoints

### Areas

#### List Areas
```
GET /api/areas
```

Returns all configured service areas.

#### Get Area
```
GET /api/areas/{id}
```

#### Get Area Stats
```
GET /api/areas/{id}/stats
```

Returns statistics for an area (station count, route count, etc.).

---

### Stations

#### List Stations
```
GET /api/stations
```

Returns stations with their platforms and stop positions, optionally filtered by bounding box.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| bbox | string | no | Bounding box filter: `west,south,east,north` (comma-separated) |

**Response:**
```json
{
    "stations": [
        {
            "osm_id": 12345,
            "osm_type": "relation",
            "name": "Königsplatz",
            "ref_ifopt": "de:09761:1234",
            "lat": 48.3657,
            "lon": 10.8945,
            "min_zoom": 10,
            "transport_modes": ["tram", "bus"],
            "platforms": [...],
            "stop_positions": [...],
            "platform_ways": [...]
        }
    ]
}
```

**Station fields:**

| Field | Type | Description |
|-------|------|-------------|
| osm_id | integer | OSM ID of the station (stop_area relation) |
| osm_type | string | OSM element type (e.g. `relation`) |
| name | string or null | Station name |
| ref_ifopt | string or null | IFOPT identifier |
| lat | float | Latitude |
| lon | float | Longitude |
| min_zoom | integer | Minimum map zoom level at which the station should be displayed |
| transport_modes | string[] | Transit modes serving this station (e.g. `["tram", "bus"]`). Omitted when empty. |
| platforms | array | Platform elements linked to the station |
| stop_positions | array | Stop position nodes linked to the station |
| platform_ways | array | Platform way outlines linked to the station |

#### Get Station
```
GET /api/stations/{osm_id}
```

Returns a single station by its OSM ID, including all linked platforms, stop positions, and GTFS stop mappings.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| osm_id | integer | OSM ID of the station (stop_area relation) |

**Response:** Same structure as a single entry in the list response above.

---

### Routes

#### List Routes
```
GET /api/routes
```

Returns all transit routes.

#### Get Route
```
GET /api/routes/{id}
```

Returns route details including stops.

#### Get Route Geometry
```
GET /api/routes/{id}/geometry
```

Returns the geometry for a route as line segments. The response is a JSON object with a `route_id` and an array of `segments`, where each segment is an array of `[lon, lat]` coordinate pairs.

**Response:**
```json
{
    "route_id": 12345678,
    "segments": [
        [[10.8945, 48.3657], [10.8950, 48.3660], [10.8960, 48.3665]],
        [[10.8960, 48.3665], [10.8970, 48.3670]]
    ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| route_id | integer | OSM ID of the route |
| segments | array of arrays | Each segment is an array of `[lon, lat]` pairs forming a line string |

#### Get Route Colors
```
GET /api/routes/colors
```

Returns distinct route line colors and types. Lightweight endpoint intended for color lookups in the frontend without fetching full route geometry.

**Response:**
```json
{
    "entries": [
        {
            "ref": "1",
            "route_type": "tram",
            "color": "#E30613",
            "operator": "Stadtwerke Augsburg",
            "network": "AVV"
        }
    ]
}
```

#### Search Routes
```
POST /api/routes/search
```

Searches routes using filters provided in the request body. This is the POST equivalent of the query-parameter filters on `GET /api/routes`, useful when filter values contain special characters.

**Request:**
```json
{
    "route_type": "tram",
    "ref": "1",
    "name_contains": "München",
    "operator": "Stadtwerke",
    "near_lat": 48.3657,
    "near_lon": 10.8945
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| route_type | string | no | Filter by route type (e.g. `"tram"`, `"bus"`) |
| ref | string | no | Filter by route ref (e.g. `"RE 9"`, `"506"`). Spaces are ignored for matching. |
| name_contains | string | no | Substring search on route name |
| operator | string | no | Substring match on operator name |
| near_lat | float | no | Latitude to search near (~30km radius). Only filters when `ref`, `name_contains`, or `operator` is also provided. |
| near_lon | float | no | Longitude to search near (~30km radius). Only filters when `ref`, `name_contains`, or `operator` is also provided. |

**Response:**
```json
{
    "routes": [
        {
            "osm_id": 12345678,
            "osm_type": "relation",
            "name": "Linie 1",
            "ref": "1",
            "route_type": "tram",
            "operator": "Stadtwerke Augsburg",
            "network": "AVV",
            "color": "#E30613"
        }
    ]
}
```

#### Get Visible Routes
```
POST /api/routes/visible
```

Returns routes with their geometry that intersect the given viewport at the given zoom level. Routes with a `min_zoom` greater than the requested zoom are excluded.

**Request:**
```json
{
    "bbox": [10.85, 48.34, 10.93, 48.40],
    "zoom": 13
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| bbox | [float, float, float, float] | yes | Bounding box as `[west, south, east, north]` in WGS84 |
| zoom | integer | yes | Current map zoom level |

**Response:**
```json
{
    "routes": [
        {
            "osm_id": 12345678,
            "name": "Linie 1",
            "ref": "1",
            "route_type": "tram",
            "color": "#E30613",
            "min_zoom": 10,
            "segments": [[[10.89, 48.36], [10.90, 48.37]]]
        }
    ]
}
```

---

### Departures

#### List All Departures
```
GET /api/departures
```

Returns all upcoming departures across all stops.

**Response:**
```json
{
    "departures": [
        {
            "stop_ifopt": "de:09761:1234:0:1",
            "line_number": "1",
            "destination": "Lechhausen",
            "destination_id": "de:09761:5678:0:1",
            "planned_time": "2024-01-15T10:30:00+01:00",
            "estimated_time": "2024-01-15T10:31:00+01:00",
            "delay_minutes": 1,
            "event_type": "departure",
            "trip_id": "123456789-1",
            "cancelled": false
        }
    ]
}
```

#### Get Departures by Stop
```
POST /api/departures/by-stop
```

**Request:**
```json
{
    "stop_ifopt": "de:09761:1234:0:1",
    "reference_time": "2025-02-06T14:00:00Z"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| stop_ifopt | string | yes | IFOPT identifier of the stop |
| reference_time | string | no | ISO 8601 timestamp for time simulation. When provided, departures are computed from the static GTFS schedule around this time instead of using live real-time data. |

**Response:**
```json
{
    "stop_ifopt": "de:09761:1234:0:1",
    "mapped_gtfs_stop_id": "de:09761:1234:0:1",
    "departures": [...]
}
```

#### Get Departures by GTFS Stop
```
POST /api/departures/by-gtfs-stop
```

Returns departures for a specific GTFS stop by its stop_id, bypassing IFOPT mapping. Departures are always computed from the static GTFS schedule.

**Request:**
```json
{
    "gtfs_stop_id": "de:09761:1234:0:1",
    "reference_time": "2025-02-06T14:00:00Z"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| gtfs_stop_id | string | yes | GTFS stop ID |
| reference_time | string | no | ISO 8601 timestamp for time simulation. Defaults to current time. |

**Response:**
```json
{
    "gtfs_stop_id": "de:09761:1234:0:1",
    "departures": [...]
}
```

#### Get Departures by Coordinates
```
POST /api/departures/by-coordinates
```

Returns departures for the nearest OSM stop position or platform to the given coordinates.

**Request:**
```json
{
    "lat": 48.3657,
    "lon": 10.8945,
    "reference_time": "2025-02-06T14:00:00Z"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| lat | float | yes | Latitude (WGS84) |
| lon | float | yes | Longitude (WGS84) |
| reference_time | string | no | ISO 8601 timestamp for time simulation. Defaults to current time. |

**Response:** Same structure as the by-stop response.

#### Get Departures by OSM ID
```
POST /api/departures/by-osm-id
```

Returns departures for an OSM stop position or platform identified by its OSM node/way/relation ID. Uses the `osm_gtfs_stop_mapping` table directly.

**Request:**
```json
{
    "osm_id": 123456789,
    "reference_time": "2025-02-06T14:00:00Z"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| osm_id | integer | yes | OSM ID of the stop position or platform |
| reference_time | string | no | ISO 8601 timestamp for time simulation. Defaults to current time. |

**Response:** Same structure as the by-stop response.

---

### Vehicles

#### Get Vehicles by Route
```
POST /api/vehicles/by-route
```

Returns all vehicles currently operating on a route with their stop sequences.

**Request:**
```json
{
    "route_id": 12345678
}
```

**Response:**
```json
{
    "route_id": 12345678,
    "line_number": "1",
    "vehicles": [
        {
            "trip_id": "123456789-1",
            "line_number": "1",
            "destination": "Lechhausen",
            "origin": "Haunstetten Nord",
            "next_trip_id": "987654321-1",
            "stops": [
                {
                    "stop_ifopt": "de:09761:1234:0:1",
                    "stop_name": "Königsplatz",
                    "sequence": 5,
                    "lat": 48.3657,
                    "lon": 10.8945,
                    "arrival_time": "2024-01-15T10:29:00+01:00",
                    "arrival_time_estimated": "2024-01-15T10:30:00+01:00",
                    "departure_time": "2024-01-15T10:30:00+01:00",
                    "departure_time_estimated": "2024-01-15T10:31:00+01:00",
                    "delay_minutes": 1
                }
            ]
        }
    ]
}
```

---

### Issues

#### List Issues
```
GET /api/issues
```

Returns detected OSM data quality issues (missing stop references, etc.).

**Response:**
```json
{
    "issues": [
        {
            "issue_type": "MissingStopRef",
            "osm_id": 12345,
            "osm_type": "node",
            "name": "Some Stop",
            "area_name": "Augsburg"
        }
    ]
}
```

---

### GTFS Stops

#### List GTFS Stops
```
GET /api/gtfs-stops
```

Returns GTFS stops with coordinates. By default, only returns leaf stops (stops that have actual departures). Use the bounding box parameters to filter by geographic area.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| stop_ids | string | - | Comma-separated list of stop IDs to fetch directly |
| search | string | - | Case-insensitive substring search on stop name |
| min_lat | float | - | Minimum latitude for bounding box filter |
| max_lat | float | - | Maximum latitude for bounding box filter |
| min_lon | float | - | Minimum longitude for bounding box filter |
| max_lon | float | - | Maximum longitude for bounding box filter |
| parent_station | string | - | Filter by parent station ID |
| leaf_only | bool | true | Only return stops that have trips visiting them (skipped when stop_ids is set) |
| offset | int | 0 | Offset for pagination |
| limit | int | 100 | Maximum results (max: 1000) |

**Example Request:**
```
GET /api/gtfs-stops?min_lat=48.3&max_lat=48.4&min_lon=10.8&max_lon=10.9&limit=50
```

**Response:**
```json
{
    "stops": [
        {
            "stop_id": "de:09761:1234:0:1",
            "stop_name": "Königsplatz",
            "parent_station": "de:09761:1234",
            "lat": 48.3657,
            "lon": 10.8945
        }
    ],
    "total_count": 150,
    "offset": 0,
    "limit": 50,
    "has_more": true
}
```

---

### Mapping

Endpoints for managing OSM-to-GTFS stop mappings. These allow manual curation of the stop mappings used to link OSM stops to GTFS stops. OSM stops are identified primarily by their OSM ID; IFOPT is supported for backwards compatibility.

#### Set Manual Mapping
```
POST /api/mapping/set
```

Creates or replaces a mapping for the given OSM stop with a user-curated GTFS stop assignment. Manual mappings are preserved across auto-rebuild cycles. Enforces a 1:1 relationship -- if the GTFS stop was previously mapped to a different OSM stop, that mapping is evicted. At least one of `osm_id` or `ifopt` must be provided.

**Request:**
```json
{
    "osm_id": 123456789,
    "ifopt": "de:09761:1234:0:1",
    "gtfs_stop_id": "de:09761:1234:0:1"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| osm_id | integer | one of osm_id/ifopt | OSM ID of the stop (primary identifier) |
| ifopt | string | one of osm_id/ifopt | IFOPT identifier of the stop (backwards compatibility) |
| gtfs_stop_id | string | yes | The GTFS stop ID to map to |

**Response:**
```json
{
    "success": true,
    "message": "Mapped 123456789 -> de:09761:1234:0:1"
}
```

#### Remove Manual Mapping
```
POST /api/mapping/remove
```

Removes a manual (user-curated) mapping. The OSM stop will be re-matched automatically on the next auto-rebuild cycle. Only removes manual mappings, not auto-generated ones. At least one of `osm_id` or `ifopt` must be provided.

**Request:**
```json
{
    "osm_id": 123456789,
    "ifopt": "de:09761:1234:0:1"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| osm_id | integer | one of osm_id/ifopt | OSM ID of the stop (primary identifier) |
| ifopt | string | one of osm_id/ifopt | IFOPT identifier of the stop (backwards compatibility) |

**Response:**
```json
{
    "removed_count": 1
}
```

#### Get Mapping Status
```
POST /api/mapping/status
```

Returns a summary of OSM-to-GTFS mapping statistics and a paginated list of mapping entries. Each entry includes the OSM stop info, current mapping status, and optionally nearby GTFS candidate stops.

**Request:**
```json
{
    "unmapped_only": false,
    "include_candidates": true,
    "filter": "manual",
    "search": "Konigsplatz",
    "limit": 50,
    "offset": 0
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| unmapped_only | bool | no | Only return unmapped OSM stops (default: false) |
| include_candidates | bool | no | Include nearby GTFS candidate stops for each entry (default: false) |
| filter | string | no | Filter by mapping type: `manual` or `auto` |
| search | string | no | Case-insensitive search on IFOPT, name, or OSM ID |
| limit | int | no | Maximum entries to return (default: 50, max: 200) |
| offset | int | no | Offset for pagination (default: 0) |

**Response:**
```json
{
    "total_osm_stop_count": 300,
    "total_ifopt_count": 200,
    "mapped_count": 150,
    "manual_count": 10,
    "auto_count": 140,
    "unmapped_count": 50,
    "entries": [
        {
            "osm_id": 123456789,
            "osm_type": "node",
            "ifopt": "de:09761:1234:0:1",
            "name": "Konigsplatz",
            "lat": 48.3657,
            "lon": 10.8945,
            "status": "manual",
            "gtfs_stop_id": "de:09761:1234:0:1",
            "gtfs_stop_name": "Konigsplatz",
            "gtfs_stop_lat": 48.3658,
            "gtfs_stop_lon": 10.8946,
            "match_method": "ifopt",
            "match_score": 1.0,
            "candidates": [
                {
                    "stop_id": "de:09761:1234:0:2",
                    "stop_name": "Konigsplatz",
                    "lat": 48.3659,
                    "lon": 10.8947,
                    "distance_meters": 15.3
                }
            ]
        }
    ],
    "has_more": true
}
```

`MappingEntry` fields:

| Field | Type | Description |
|-------|------|-------------|
| osm_id | integer | OSM ID of the stop |
| osm_type | string | OSM element type: `platform` or `stop_position` |
| ifopt | string or null | IFOPT identifier (if the stop has one) |
| name | string or null | Name of the OSM stop |
| lat | float | Latitude |
| lon | float | Longitude |
| status | string | Mapping status: `unmapped`, `auto`, or `manual` |
| gtfs_stop_id | string or null | Mapped GTFS stop ID (if mapped) |
| gtfs_stop_name | string or null | Mapped GTFS stop name (if mapped) |
| gtfs_stop_lat | float or null | Latitude of the mapped GTFS stop (if mapped) |
| gtfs_stop_lon | float or null | Longitude of the mapped GTFS stop (if mapped) |
| match_method | string or null | Method used for matching: `ifopt`, `geographic`, or `manual` |
| match_score | float or null | Matching score (if auto-mapped) |
| candidates | array | Nearby GTFS candidate stops (only when `include_candidates` is true) |

---

## WebSocket Endpoints

### Vehicle Updates
```
WS /api/ws/vehicles
```

Real-time vehicle position and trip updates. Supports route-based subscriptions.

#### Connection Established

On connection, the server sends a welcome message:

**Server message:**
```json
{
    "type": "connected",
    "message": "Connected to Omniviv vehicle updates"
}
```

#### Error Messages

If an error occurs, the server sends:

```json
{
    "type": "error",
    "message": "Error description"
}
```

#### Subscribe to Routes

**Client message:**
```json
{
    "type": "subscribe",
    "route_ids": [12345, 67890],
    "reference_time": "2025-02-06T14:00:00Z"
}
```

The optional `reference_time` enables time simulation mode (for viewing past/future schedules).

**Server response - Initial data:**
```json
{
    "type": "vehicles",
    "routes": [
        {
            "route_id": 12345,
            "line_number": "1",
            "vehicles": [...]
        }
    ]
}
```

**Server response - Incremental updates:**
```json
{
    "type": "vehicles_update",
    "changes": [
        {"action": "add", "route_id": 12345, "vehicle": {...}},
        {"action": "update", "route_id": 12345, "vehicle": {...}},
        {"action": "remove", "route_id": 12345, "trip_id": "123"}
    ]
}
```

#### Connection Limits

- Maximum 100 route subscriptions per connection

---

## Error Handling

Errors are returned as JSON with appropriate HTTP status codes:

```json
{
    "error": "Route not found"
}
```

Common status codes:
- `200` - Success
- `400` - Bad request (invalid input)
- `404` - Resource not found
- `500` - Internal server error

---

## CORS

CORS is configured via `config.yaml`:

**Development (permissive):**
```yaml
cors_permissive: true
```

**Production (restricted):**
```yaml
cors_permissive: false
cors_origins:
    - "https://omniviv.example.com"
```
