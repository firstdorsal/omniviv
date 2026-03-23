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

Returns all stations with their platforms and stop positions.

**Response:**
```json
{
    "stations": [
        {
            "osm_id": 12345,
            "name": "Königsplatz",
            "ref_ifopt": "de:09761:1234",
            "lat": 48.3657,
            "lon": 10.8945,
            "platforms": [...],
            "stop_positions": [...]
        }
    ]
}
```

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

Returns GeoJSON geometry for the route.

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
            "planned_time": "2024-01-15T10:30:00+01:00",
            "estimated_time": "2024-01-15T10:31:00+01:00",
            "delay_minutes": 1,
            "event_type": "departure",
            "trip_id": "123456789-1"
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

Endpoints for managing IFOPT-to-GTFS stop mappings. These allow manual curation of the stop mappings used to link OSM stops (identified by IFOPT) to GTFS stops.

#### Set Manual Mapping
```
POST /api/mapping/set
```

Creates or replaces a mapping for the given IFOPT with a user-curated GTFS stop assignment. Manual mappings are preserved across auto-rebuild cycles. Enforces a 1:1 relationship -- if the GTFS stop was previously mapped to a different IFOPT, that mapping is evicted.

**Request:**
```json
{
    "ifopt": "de:09761:1234:0:1",
    "gtfs_stop_id": "de:09761:1234:0:1"
}
```

**Response:**
```json
{
    "success": true,
    "message": "Mapped de:09761:1234:0:1 -> de:09761:1234:0:1"
}
```

#### Remove Manual Mapping
```
POST /api/mapping/remove
```

Removes a manual (user-curated) mapping. The IFOPT will be re-matched automatically on the next auto-rebuild cycle. Only removes manual mappings, not auto-generated ones.

**Request:**
```json
{
    "ifopt": "de:09761:1234:0:1"
}
```

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

Returns a summary of IFOPT-to-GTFS mapping statistics and a paginated list of mapping entries. Each entry includes the OSM stop info, current mapping status, and optionally nearby GTFS candidate stops.

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
| unmapped_only | bool | no | Only return unmapped IFOPTs (default: false) |
| include_candidates | bool | no | Include nearby GTFS candidate stops for each entry (default: false) |
| filter | string | no | Filter by mapping type: `manual` or `auto` |
| search | string | no | Case-insensitive search on IFOPT name or identifier |
| limit | int | no | Maximum entries to return (default: 50, max: 200) |
| offset | int | no | Offset for pagination (default: 0) |

**Response:**
```json
{
    "total_ifopt_count": 200,
    "mapped_count": 150,
    "manual_count": 10,
    "auto_count": 140,
    "unmapped_count": 50,
    "entries": [
        {
            "ifopt": "de:09761:1234:0:1",
            "name": "Konigsplatz",
            "lat": 48.3657,
            "lon": 10.8945,
            "status": "manual",
            "gtfs_stop_id": "de:09761:1234:0:1",
            "gtfs_stop_name": "Konigsplatz",
            "gtfs_stop_lat": 48.3658,
            "gtfs_stop_lon": 10.8946,
            "combined_score": 1.0,
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
