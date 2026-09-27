# Clips

A clip is one drive: a route, the photos taken along it, and the lanes detected in them. Each clip is
a folder here; the app lists every built clip in its clip menu.

```
clips/<name>/
  clip.json            route(s) + camera                    ← you write this
  frames.json          photo manifest                       ← from pipeline/fetch_mapillary.py (or your own)
  images/              the photos
  labels.json          hand-traced lanes (labeling tool)    ← optional
  mapbox_<route>.json  cached Mapbox routes                 ← generated (fetched once)
  yolop_lanes.json     YOLOPv2 lanes                        ← generated
  detected_lanes.json  OpenCV lanes                         ← generated (with --opencv)
  _build/              YOLOPv2 masks (git-ignored)          ← generated
```

The app reads what the build writes to `frontend/public/clips/<name>/` (`demo.json` + `images/`) and the
clip list `frontend/public/clips/index.json`.

## Add a clip

1. **Photos.** Get a Mapillary image id from the drive (the `pKey=` in the web URL) and run
   (needs `MAPILLARY_TOKEN` in your terminal or `.env`):
   ```bash
   .venv/Scripts/python.exe pipeline/fetch_mapillary.py <image id> <name>
   ```
   Or bring your own: `images/` plus a `frames.json` like
   `{"frames": [{"image_id", "lat", "lon", "compass_angle", "captured_at" (ms), "file": "images/<id>.jpg"}]}`.

2. **`clip.json`.**
   ```json
   {
     "title": "SR 70 to I-95 (Fort Pierce, FL)",
     "origin": [-80.398568, 27.41274],
     "originBearing": 70,
     "primaryRoute": "north",
     "routes": {
       "north": {"label": "I-95 North · Daytona Beach", "destination": [-80.389239, 27.415502]},
       "south": {"label": "I-95 South · West Palm Beach", "destination": [-80.389369, 27.414368]}
     },
     "camera": {"vanishingPoint": [0.47, 0.775]},
     "maxFrames": 60
   }
   ```
   - `origin` / `destination`: `[lng, lat]`. Start where the photos are already on the road you want;
     `originBearing` (compass degrees of travel) keeps Mapbox from snapping onto the wrong side of a
     divided road.
   - `routes`: one or more destinations sharing the origin (the app's route switch). `primaryRoute` is
     the one the photos actually drive.
   - `camera.vanishingPoint`: where lane lines meet, as fractions of the image `[x, y]`; `y` is the
     horizon. Open a photo and eyeball it. It sets the YOLOPv2 crop, the lane tracking rows and the
     frontend's perspective check. SR 70 (phone pitched down): `[0.47, 0.775]`; a level dashcam: `y ≈ 0.5`.
   - `maxFrames` (optional): thin dense clips to about this many evenly spaced frames.

3. **Build** (needs `MAPBOX_TOKEN` the first time, to fetch the route):
   ```bash
   .venv/Scripts/python.exe tools/build_clip.py <name>
   ```
   Bake → YOLOPv2 masks → YOLOPv2 lanes → bake again. Add `--opencv` for the OpenCV detector too, or
   `--bake-only` after changing only `clip.json` / labels. `--all` builds every clip.

4. Refresh the app and pick the clip from the menu. Press **D** for the lane debug view.
