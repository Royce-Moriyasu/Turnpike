# Turnpike

Lane-level AR navigation from public road data. Mapbox tells us which lane to be in, vision finds
that lane in the driver's view, and we highlight it on the road.

Clips (drives) live in `clips/`; the app switches between them from its clip menu:
- **sr70**: SR 70 (Okeechobee Rd) eastbound onto I-95 in Fort Pierce, FL. The North and South routes
  share the approach, so the same frames highlight a different lane depending on the destination.

## Layout

```
clips/      One folder per drive: clip.json, frames.json + images/, labels, cached Mapbox routes,
            detected lanes. See clips/README.md to add one.
tools/      clip.py (where a clip's files live), build_clip.py (build a clip end to end)
bake/       Mapbox route + photos + lanes -> frontend/public/clips/<clip>/demo.json
vision/     Lane detectors: YOLOPv2 (yolop_masks.py -> yolop_lanes.py) and OpenCV (detect_lanes.py)
pipeline/   fetch_mapillary.py: download a Mapillary sequence into a clip folder
frontend/   Vite + React + TypeScript + Tailwind
```

## Setup

```bash
cp .env.example .env        # add MAPBOX_TOKEN and MAPILLARY_TOKEN (or set them in your terminal)
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r vision/requirements.txt -r bake/requirements.txt -r pipeline/requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu
cd frontend && npm install
```

YOLOPv2 needs its weights in `vision/weights/` (see `vision/weights/README.md`).

## Run

```bash
.venv/Scripts/python.exe tools/build_clip.py --all     # bake + YOLOPv2 lanes for every clip
cd frontend && npm run dev                             # http://localhost:5173
```

The built clips are committed, so the app runs without Python. Rebuild a clip after changing its
photos, `clip.json`, the detectors or the bake (`tools/build_clip.py <clip>`; `--bake-only` for just the
bake). Changes to the frontend's matching rules (`frontend/src/lanes.ts`) need only a browser refresh.

Keys: `←`/`→` step frames, `Space` plays/pauses, `G` standard GPS vs lanes, `V` lane source, `D` lane debug.
Dev tools (dev server only): **Label this frame** (`#label`, hand tracing) and **CV review** (`#cv`).

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
first because Mapbox infers them where OpenStreetMap has no lane tags. On SR 70 that inference
wrongly marked the rightmost through lane as I-95 South only, when the real footage shows it is the
lane that reaches I-95 North. See `choose_lane()` in `bake/bake_route.py`.

The frontend then matches Mapbox's lanes to the detected lanes (`laneTarget()` in
`frontend/src/lanes.ts`): it sets aside bike lanes and turn lanes that are opening but not yet in the
snapshot, counts from the side our road is on, and only highlights when the lane shapes it counted
across are plausible for the clip's camera. The debug view (`D`) shows each step.

## Lane geometry (detector output)

Every detector writes the same format (`vision/README.md`): per frame, the painted lines left → right,
each sampled at fixed image rows (`x` per row, 0–1 of the image width), with a confidence. The bake
turns consecutive lines into lane polygons, one set per detector, and the app's lane switch (`V`)
picks between YOLOPv2, OpenCV and hand-traced.

## Data sources

- Route and lane guidance: Mapbox Directions API (© Mapbox, © OpenStreetMap contributors)
- Street-level imagery: Mapillary, CC-BY-SA 4.0 (attribution is shown in the app)
