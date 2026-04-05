# Vehicle Model Definitions

Static JSON files describing vehicle 3D geometries, loaded on demand by the frontend.

## Adding a new model

1. Create `<model-id>.json` in this directory (ID: lowercase alphanumeric + hyphens)
2. Add an entry in `manifest.json` under `models`
3. Optionally add it as a default for a city/vehicle-type in `manifest.json` → `defaults`

## Two JSON formats

Every model file must have a `kind` field: `"simple"` or `"consist"`.

### Simple format (trams, buses, scooters, ferries)

Use when the vehicle is a fixed set of segments. You must calculate `totalLength` yourself.

```json
{
  "kind": "simple",
  "id": "man-lions-city-12",
  "name": "MAN Lion's City 12",
  "manufacturer": "MAN",
  "vehicleType": "bus",
  "width": 2.55,
  "totalLength": 12.185,
  "articulationGap": 0,
  "lods": {
    "box": {
      "segments": [
        { "length": 12.185, "type": "cab", "height": 3.3, "hasBogies": true }
      ]
    }
  },
  "metadata": {
    "wikidataId": "Q1881162"
  }
}
```

### Consist format (trains with variable configurations)

Use when the vehicle has named car types and multiple possible configurations.
`totalLength` is computed automatically from the resolved consist.

```json
{
  "kind": "consist",
  "id": "ice-3",
  "name": "ICE 3 (BR 403)",
  "manufacturer": "Siemens / Bombardier",
  "vehicleType": "rail",
  "width": 2.95,
  "cars": {
    "end-car": { "length": 25.835, "height": 3.89, "type": "end_car", "powered": true },
    "middle":  { "length": 24.775, "height": 3.89, "type": "second_class" }
  },
  "consists": {
    "single": {
      "cars": ["end-car", "middle", "middle", "middle", "middle", "middle", "middle", "end-car"],
      "couplingGap": 0.5
    }
  },
  "defaultConsist": "single",
  "metadata": { "wikidataId": "Q1151795", "maxSpeedKmh": 330 }
}
```

## Field reference

### Required fields (both formats)
| Field | Type | Description |
|-------|------|-------------|
| `kind` | `"simple"` \| `"consist"` | Format discriminant |
| `id` | string | Unique ID (lowercase, hyphens) |
| `name` | string | Display name |
| `manufacturer` | string | Manufacturer name |
| `vehicleType` | string | GTFS/OSM route type: `"tram"`, `"bus"`, `"rail"`, `"subway"`, `"ferry"` |
| `width` | number | Default body width in meters |

### Simple-only fields
| Field | Type | Description |
|-------|------|-------------|
| `totalLength` | number | Total length in meters (must be manually correct) |
| `articulationGap` | number | Gap between segments in meters |
| `lods.box.segments` | array | Ordered segments from front to back |

### Consist-only fields
| Field | Type | Description |
|-------|------|-------------|
| `cars` | object | Car type catalog: `{ "car-id": { length, height, type, ... } }` |
| `consists` | object | Named configurations: `{ "name": { cars: [...], couplingGap } }` |
| `defaultConsist` | string | Key into `consists` — must match exactly |

### Car definition fields
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `length` | number | yes | Body length in meters |
| `height` | number | yes | Body height in meters |
| `type` | string | yes | Segment type for styling |
| `powered` | boolean | no | Has traction motors? |
| `width` | number | no | Width override (falls back to model width) |
| `hasBogies` | boolean | no | Has wheel assemblies? Default: true |

### Metadata (optional, both formats)
| Field | Type | Description |
|-------|------|-------------|
| `wikidataId` | string | Wikidata Q-number (e.g., "Q702311") |
| `maxSpeedKmh` | number | Max operating speed |
| `inServiceSince` | number | Year entered service |
| `unitsBuilt` | number | Units built/ordered |
| `designation` | string | Official type (e.g., "BR 401") |
| `tractionType` | string | "electric", "diesel", "biogas", etc. |
| `powerSupply` | string | "15kV 16.7Hz AC", "750V DC", etc. |
| `powerKw` | number | Total traction power |
| `gaugeMm` | number | Track gauge (1435=standard, 1000=metre) |
| `massTonnes` | number | Mass of one unit/consist |
| `seatingCapacity` | number | Seats in default config |
| `operators` | string[] | Operator names |
| `countries` | string[] | ISO country codes |
| `lowFloor` | boolean | Low-floor vehicle? |

Per-consist metadata overrides are merged on top of model-level metadata.

## Manifest (`manifest.json`)

```json
{
  "version": 1,
  "models": {
    "model-id": { "vehicleType": "rail", "lods": ["box"] }
  },
  "defaults": {
    "augsburg": { "tram": "siemens-combino-augsburg", "bus": "man-lions-city-12" }
  }
}
```

The `lods` array lists available LOD levels. Currently only `"box"` (fill-extrusion polygons) is implemented.
