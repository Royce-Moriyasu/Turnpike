# Turnpike

Lane-level AR navigation from public road data. Mapbox tells us which lane to be in, vision finds
that lane in the driver's view, and we highlight it on the road.

Demo route: SR 70 (Okeechobee Rd) eastbound onto I-95 in Fort Pierce, FL. The North and South routes
share the approach, so the same frames highlight a different lane depending on the destination.

## Layout

```
bake/       Python: Mapbox route + Mapillary sequence -> frontend/public/demo_route.json
data/       Cached Mapbox responses, fallback_lanes.json (hand-labeled lane polygons)
frontend/   Vite + React + TypeScript + Tailwind
vision/     OpenCV lane detection (writes the same format as fallback_lanes.json)
```

## Setup

```bash
cp .env.example .env                       # add MAPBOX_TOKEN and MAPILLARY_TOKEN
python -m pip install -r bake/requirements.txt
cd frontend && npm install
```

## Run

```bash
# 1. Bake the demo data (any image id from the Mapillary clip: the pKey= value in its URL)
python bake/bake_route.py --image-id <mapillary image id>
#    ...or without imagery, to test navigation logic:
python bake/bake_route.py --synthetic

# 2. Frontend
cd frontend && npm run dev                 # http://localhost:5173
```

Keys: `←`/`→` step frames, `Space` plays/pauses.

## How the lane is chosen

At each intersection Mapbox returns the lane layout (left → right), with each lane's painted turn
arrows (`indications`, e.g. `left | through | through | through | right`). For every such point the bake:

1. Works out the **movement** the route makes at the decision those lanes describe: the maneuver itself
   at a maneuver point (e.g. "slight left" at a fork), or what the route does at the next junction it
   drives through (usually "straight").
2. Marks as **allowed** the lanes whose arrows permit that movement (falling back to through lanes).
3. Picks the allowed lane **nearest the side of the next turn**: rightmost before a right-side ramp,
   leftmost before a keep-left fork.

Mapbox's own `active`/`valid` flags are only used when no lane's arrows match. We don't trust them
first because Mapbox infers them where OpenStreetMap has no lane tags. On our route that inference
wrongly marked the rightmost through lane on SR 70 as I-95 South only, when the real footage shows it
is the lane that reaches I-95 North. See `choose_lane()` in `bake/bake_route.py`.

## Lane polygons (vision contract)

`data/fallback_lanes.json`, keyed by frame id. Each frame is a list of visible lane polygons, sorted
left → right, points in normalized image coordinates (0–1, origin top-left):

```json
{
  "1234567890": [
    [[0.10, 1.0], [0.42, 1.0], [0.49, 0.58], [0.45, 0.58]],
    [[0.42, 1.0], [0.78, 1.0], [0.53, 0.58], [0.49, 0.58]]
  ]
}
```

If a frame shows fewer lanes than the Mapbox data, the frontend aligns them from the maneuver side
(it counts from the right edge for right-side maneuvers). Re-run the bake after editing polygons.
Frames with no polygons get placeholder geometry, labeled as such in the UI.

## Data sources

- Route and lane guidance: Mapbox Directions API (© Mapbox, © OpenStreetMap contributors)
- Street-level imagery: Mapillary, CC-BY-SA 4.0 (attribution is shown in the app)
