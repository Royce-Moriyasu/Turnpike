"""Bake the demo: Mapbox lane guidance + a Mapillary image sequence -> demo_route.json.

    python bake/bake_route.py --frames                          # images from pipeline/data/frames.json
    python bake/bake_route.py --image-id <mapillary image id>   # fetch the sequence from Mapillary
    python bake/bake_route.py --synthetic                       # no imagery; frames sampled along the route

Mapbox responses are cached in data/mapbox_<route>.json (use --refresh to re-fetch).
Lane polygons come from data/fallback_lanes.json (keyed by frame id) until OpenCV replaces them.
Output: frontend/public/demo_route.json and frontend/public/route/<id>.jpg
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PUBLIC = ROOT / "frontend" / "public"
IMG_DIR = PUBLIC / "route"
OUT = PUBLIC / "demo_route.json"
PIPELINE_FRAMES = ROOT / "pipeline" / "data" / "frames.json"

load_dotenv(ROOT / ".env")

# SR 70 (Okeechobee Rd) eastbound onto I-95, Fort Pierce FL. Both routes share the
# approach and split at the ramp fork, so the same frames get a different lane per route.
# Origin is where the Mapillary clip is already eastbound on SR 70; the bearing keeps Mapbox
# from snapping it onto the westbound side of the divided road.
ORIGIN, ORIGIN_BEARING = (-80.398568, 27.41274), 70
ROUTES = {
    "north": {"label": "I-95 North · Daytona Beach",
              "origin": ORIGIN, "destination": (-80.389239, 27.415502)},
    "south": {"label": "I-95 South · West Palm Beach",
              "origin": ORIGIN, "destination": (-80.389369, 27.414368)},
}
PRIMARY_ROUTE = "north"  # the Mapillary clip takes I-95 North

MAX_OFF_ROUTE_M = 20      # frames farther than this from the route are dropped
MAX_HEADING_DIFF = 60     # reject images facing away from the direction of travel
MIN_FRAME_SPACING_M = 6
MAX_FRAMES = 40
LANE_LOOKAHEAD_M = 400    # only show lane guidance this close to the lane data point

GRAPH = "https://graph.mapillary.com"
MLY_FIELDS = "id,computed_geometry,geometry,compass_angle,computed_compass_angle,captured_at,thumb_2048_url,is_pano"


# ---------------------------------------------------------------- geometry

EARTH_R = 6371000.0


def to_xy(lng: float, lat: float, lat0: float) -> tuple[float, float]:
    """Local equirectangular projection in meters (fine at route scale)."""
    return (math.radians(lng) * EARTH_R * math.cos(math.radians(lat0)),
            math.radians(lat) * EARTH_R)


def angle_diff(a: float, b: float) -> float:
    return abs((a - b + 180) % 360 - 180)


class Polyline:
    def __init__(self, coords: list[list[float]]):
        self.coords = coords
        self.lat0 = coords[0][1]
        self.xy = [to_xy(lng, lat, self.lat0) for lng, lat in coords]
        self.cum = [0.0]
        for (x1, y1), (x2, y2) in zip(self.xy, self.xy[1:]):
            self.cum.append(self.cum[-1] + math.hypot(x2 - x1, y2 - y1))
        self.length = self.cum[-1]

    def project(self, lng: float, lat: float) -> tuple[float, float]:
        """Return (distance along the line, perpendicular offset), both in meters."""
        px, py = to_xy(lng, lat, self.lat0)
        best_off, best_s = float("inf"), 0.0
        for i, ((x1, y1), (x2, y2)) in enumerate(zip(self.xy, self.xy[1:])):
            dx, dy = x2 - x1, y2 - y1
            seg2 = dx * dx + dy * dy
            t = 0.0 if seg2 == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / seg2))
            off = math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
            if off < best_off:
                best_off, best_s = off, self.cum[i] + t * math.sqrt(seg2)
        return best_s, best_off

    def point_at(self, s: float) -> tuple[float, float]:
        s = max(0.0, min(self.length, s))
        for i in range(len(self.cum) - 1):
            if self.cum[i + 1] >= s:
                seg = self.cum[i + 1] - self.cum[i]
                t = 0.0 if seg == 0 else (s - self.cum[i]) / seg
                (lng1, lat1), (lng2, lat2) = self.coords[i], self.coords[i + 1]
                return lng1 + t * (lng2 - lng1), lat1 + t * (lat2 - lat1)
        return tuple(self.coords[-1])

    def bearing_at(self, s: float) -> float:
        a = to_xy(*self.point_at(s - 3), self.lat0)
        b = to_xy(*self.point_at(s + 3), self.lat0)
        return math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])) % 360


# ---------------------------------------------------------------- navigation

def side_of(modifier: str | None) -> str | None:
    if modifier and "right" in modifier:
        return "right"
    if modifier and "left" in modifier:
        return "left"
    return None


# Lane arrows that can make each movement, best match first. "none" is an unmarked lane,
# which OSM uses for plain through lanes.
ARROWS_FOR = {
    "straight": ["straight", "none"],
    "slight right": ["slight right", "right", "sharp right"],
    "right": ["right", "slight right", "sharp right"],
    "sharp right": ["sharp right", "right", "slight right"],
    "slight left": ["slight left", "left", "sharp left"],
    "left": ["left", "slight left", "sharp left"],
    "sharp left": ["sharp left", "left", "slight left"],
    "uturn": ["uturn"],
}


def turn_through(inter: dict) -> str:
    """The movement the route makes through a junction, from its entry and exit bearings."""
    if "in" not in inter or "out" not in inter:
        return "straight"
    heading_in = (inter["bearings"][inter["in"]] + 180) % 360
    delta = (inter["bearings"][inter["out"]] - heading_in + 540) % 360 - 180  # + = right
    size = abs(delta)
    if size < 25:
        return "straight"
    side = "right" if delta > 0 else "left"
    if size < 60:
        return f"slight {side}"
    return side if size < 135 else f"sharp {side}"


def lanes_for_movement(lanes: list[dict], movement: str) -> list[int]:
    """Lanes whose painted arrows allow the movement. Falls back to through lanes, since a
    ramp or fork that leaves at a shallow angle is often tagged as 'through'."""
    for arrow in ARROWS_FOR.get(movement, []) + ARROWS_FOR["straight"]:
        match = [i for i, l in enumerate(lanes) if arrow in l.get("indications", [])]
        if match:
            return match
    return []


def choose_lane(lanes: list[dict], movement: str, side: str | None) -> tuple[list[int], int | None, str]:
    """(allowed lanes, preferred lane, basis). Uses the lane arrows; Mapbox's own active/valid
    flags only when no arrow matches, because Mapbox infers them when map data is missing."""
    allowed, basis = lanes_for_movement(lanes, movement), "arrows"
    if not allowed:
        allowed = [i for i, l in enumerate(lanes) if l.get("active")] or \
                  [i for i, l in enumerate(lanes) if l.get("valid")]
        basis = "mapbox"
    if not allowed:
        return [], None, basis
    if side == "right":
        return allowed, max(allowed), basis
    if side == "left":
        return allowed, min(allowed), basis
    if len(allowed) == 1:
        return allowed, allowed[0], basis
    # No turn ahead to lean toward: let Mapbox break the tie if it singles out one allowed lane.
    mapbox = [i for i in allowed if lanes[i].get("active")]
    return allowed, mapbox[0] if len(mapbox) == 1 else None, basis


class RouteModel:
    def __init__(self, key: str, response: dict):
        route = response["routes"][0]
        self.key = key
        self.line = Polyline(route["geometry"]["coordinates"])
        self.steps = route["legs"][0]["steps"]
        self.maneuver_s = [self.line.cum[st["intersections"][0]["geometry_index"]] for st in self.steps]

        # Every intersection that carries lane data. For each: the movement the route makes there
        # (which lanes' arrows allow it) and the side of the next turn (which of those lanes to pick).
        self.lane_points = []
        last = len(self.steps) - 1
        points = [(k, j, inter) for k, step in enumerate(self.steps) for j, inter in enumerate(step["intersections"])]
        for p, (k, j, inter) in enumerate(points):
            if not inter.get("lanes"):
                continue
            # Side: the next maneuver that actually turns (lanes at a maneuver point serve it).
            m = k if j == 0 else k + 1
            while m < last and side_of(self.steps[m]["maneuver"].get("modifier")) is None:
                m += 1
            turn_step = self.steps[min(m, last)]
            side = side_of(turn_step["maneuver"].get("modifier"))
            toward = turn_step.get("destinations") or turn_step.get("name") or None

            # Movement: what the route does at the decision these lanes describe, which is the
            # first maneuver point or junction (3+ roads) at or after this point. A plain node on
            # the road carries the lanes of the junction ahead of it.
            #  - maneuver point: the maneuver itself (e.g. "slight left" at the fork)
            #  - junction we drive through: from its entry/exit bearings, usually straight
            dk, dj, decision = next(
                ((kk, jj, it) for kk, jj, it in points[p:] if jj == 0 or len(it.get("bearings", [])) > 2),
                (k, j, inter),
            )
            if dj == 0:
                maneuver = self.steps[dk]["maneuver"]
                movement = "straight" if maneuver["type"] in ("depart", "arrive") \
                    else maneuver.get("modifier") or "straight"
            else:
                movement = turn_through(decision)

            allowed, preferred, basis = choose_lane(inter["lanes"], movement, side)
            self.lane_points.append({
                "s": self.line.cum[inter["geometry_index"]],
                "location": inter["location"],
                "lanes": inter["lanes"],
                "side": side,
                "toward": toward,
                "movement": movement,
                "allowed": allowed,
                "preferred": preferred,
                "basis": basis,
            })

    def state_at(self, s: float) -> dict:
        # Next maneuver strictly ahead (skip depart).
        k = next((i for i in range(1, len(self.steps)) if self.maneuver_s[i] > s + 1), len(self.steps) - 1)
        step = self.steps[k]
        man = step["maneuver"]
        instruction = man["instruction"]
        if man["type"] == "arrive":
            prev = self.steps[k - 1]
            instruction = f"Continue toward {prev.get('destinations') or prev.get('name') or 'destination'}."

        lp = next((p for p in self.lane_points if p["s"] >= s - 3), None)
        if lp and lp["s"] - s > LANE_LOOKAHEAD_M:
            lp = None
        lanes = [{**{k2: l[k2] for k2 in ("indications", "valid", "active", "valid_indication") if k2 in l},
                  "allowed": i in lp["allowed"]}
                 for i, l in enumerate(lp["lanes"])] if lp else None

        return {
            "instruction": instruction,
            "maneuverType": man["type"],
            "modifier": man.get("modifier"),
            "distanceM": round(max(0.0, self.maneuver_s[k] - s), 1),
            "lanes": lanes,
            "preferredLane": lp["preferred"] if lp else None,
            "laneSide": lp["side"] if lp else None,
            "laneMovement": lp["movement"] if lp else None,
            "laneBasis": lp["basis"] if lp else None,
            "laneToward": lp["toward"] if lp else None,
            "laneSource": {"lng": lp["location"][0], "lat": lp["location"][1],
                           "distanceM": round(max(0.0, lp["s"] - s), 1)} if lp else None,
        }


TURN_WORDS = {
    "left": "turns left", "slight left": "bears left", "sharp left": "turns sharp left",
    "right": "turns right", "slight right": "bears right", "sharp right": "turns sharp right",
    "straight": "goes straight", "uturn": "makes U-turns",
}


def lane_reasons(nav: dict, others: dict[str, dict]) -> list[str]:
    """Plain-language reasons for the recommended lane, for the lane guidance card.

    First the lanes a driver would be tempted into (not allowed, between our lane and the side of
    the turn, else right next to it) and what they're for; then why this allowed lane over others.
    `others` are the other routes' nav states for the same frame: if one of them uses a lane we
    avoid, that route's name is the clearest explanation ("Lane 2 is for I-95 South").
    """
    lanes, target, side = nav["lanes"], nav["preferredLane"], nav["laneSide"]
    if not lanes or target is None:
        return []
    allowed = [i for i, l in enumerate(lanes) if l["allowed"]]

    if side == "right":
        avoid = [i for i in range(target + 1, len(lanes)) if i not in allowed]
    elif side == "left":
        avoid = [i for i in range(target) if i not in allowed]
    else:
        avoid = []
    if not avoid:
        avoid = [i for i in (target - 1, target + 1) if 0 <= i < len(lanes) and i not in allowed]

    reasons = []
    for i in avoid:
        other = next((ROUTES[k]["label"].split(" · ")[0] for k, o in others.items()
                      if o["lanes"] and len(o["lanes"]) == len(lanes) and o["preferredLane"] == i), None)
        arrows = [a for a in lanes[i]["indications"] if a != "none"]
        if other:
            reasons.append(f"Lane {i + 1} is for {other}")
        elif arrows:
            reasons.append(f"Lane {i + 1} only {' or '.join(TURN_WORDS.get(a, a) for a in arrows)}")
    if side and len(allowed) > 1:
        reasons.append(f"Stay {side} for {nav['laneToward']}" if nav.get("laneToward") else f"Stay {side}")
    return reasons[:3]


# ---------------------------------------------------------------- data sources

def load_mapbox(key: str, refresh: bool) -> dict:
    cache = DATA / f"mapbox_{key}.json"
    if cache.exists() and not refresh:
        return json.loads(cache.read_text(encoding="utf-8"))
    token = os.getenv("MAPBOX_TOKEN") or sys.exit("MAPBOX_TOKEN not set (set it in this terminal, or add it to .env)")
    cfg = ROUTES[key]
    coords = ";".join(f"{lng},{lat}" for lng, lat in (cfg["origin"], cfg["destination"]))
    try:
        r = requests.get(
            f"https://api.mapbox.com/directions/v5/mapbox/driving/{coords}",
            params={"steps": "true", "banner_instructions": "true", "geometries": "geojson",
                    "overview": "full", "bearings": f"{ORIGIN_BEARING},45;", "access_token": token},
            timeout=30,
        )
        r.raise_for_status()
    except requests.RequestException as e:
        # Mapbox takes the token in the URL; never let it reach the console.
        sys.exit(f"Mapbox request for '{key}' failed: {str(e).replace(token, '<MAPBOX_TOKEN>')}")
    resp = r.json()
    for wp in resp["waypoints"]:
        if wp["distance"] > 15:
            print(f"  warning: {key} waypoint snapped {wp['distance']:.0f} m to '{wp['name']}'")
    cache.write_text(json.dumps(resp, indent=1), encoding="utf-8")
    print(f"  fetched Mapbox route '{key}' -> {cache.relative_to(ROOT)}")
    return resp


def mly_get(path: str, **params) -> dict:
    token = os.getenv("MAPILLARY_TOKEN") or sys.exit("MAPILLARY_TOKEN not set (set it in this terminal, or add it to .env)")
    r = requests.get(f"{GRAPH}/{path}", params=params,
                     headers={"Authorization": f"OAuth {token}"}, timeout=30)
    r.raise_for_status()
    return r.json()


def fetch_sequence(image_id: str) -> tuple[str, list[dict]]:
    seq = mly_get(image_id, fields="sequence")["sequence"]
    ids = [d["id"] for d in mly_get("image_ids", sequence_id=seq)["data"]]
    print(f"  sequence {seq}: {len(ids)} images")
    images = []
    for i in range(0, len(ids), 50):
        chunk = ids[i:i + 50]
        try:
            images += mly_get("images", image_ids=",".join(chunk), fields=MLY_FIELDS)["data"]
        except requests.HTTPError:
            images += [mly_get(x, fields=MLY_FIELDS) for x in chunk]
    return seq, images


def download(url: str, dest: Path) -> None:
    if dest.exists():
        return
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    dest.write_bytes(r.content)


# ---------------------------------------------------------------- frames

def thin(candidates: list[dict], span: float) -> list[dict]:
    spacing = max(MIN_FRAME_SPACING_M, span / MAX_FRAMES)
    kept, last = [], -math.inf
    for c in candidates:
        if c["s"] - last >= spacing:
            kept.append(c)
            last = c["s"]
    return kept


def mapillary_frames(image_id: str, primary: RouteModel) -> tuple[str, list[dict]]:
    seq, images = fetch_sequence(image_id)
    candidates = []
    for img in images:
        if img.get("is_pano"):
            continue
        geom = img.get("computed_geometry") or img.get("geometry")
        if not geom:
            continue
        lng, lat = geom["coordinates"]
        s, off = primary.line.project(lng, lat)
        heading = img.get("computed_compass_angle", img.get("compass_angle"))
        if off > MAX_OFF_ROUTE_M or not (0 < s < primary.line.length):
            continue
        if heading is not None and angle_diff(heading, primary.line.bearing_at(s)) > MAX_HEADING_DIFF:
            continue
        candidates.append({"id": img["id"], "lng": lng, "lat": lat, "s": s, "heading": heading,
                           "captured_at": img.get("captured_at"), "url": img.get("thumb_2048_url")})
    if not candidates:
        sys.exit("No usable images from that sequence near the route. Check the image id / route.")
    candidates.sort(key=lambda c: c["s"])
    kept = thin(candidates, candidates[-1]["s"] - candidates[0]["s"])
    print(f"  {len(candidates)} images on route, keeping {len(kept)}")

    IMG_DIR.mkdir(parents=True, exist_ok=True)
    frames = []
    for c in kept:
        download(c["url"], IMG_DIR / f"{c['id']}.jpg")
        captured = datetime.fromtimestamp(c["captured_at"] / 1000, tz=timezone.utc).isoformat() \
            if c["captured_at"] else None
        frames.append({"id": c["id"], "image": f"/route/{c['id']}.jpg", "lng": c["lng"], "lat": c["lat"],
                       "heading": c["heading"], "capturedAt": captured, "s": c["s"]})
    return seq, frames


def manifest_frames(path: Path, primary: RouteModel) -> tuple[str | None, list[dict]]:
    """Frames from pipeline/fetch_mapillary.py output, in capture order.

    Keeps the longest time-contiguous run of on-route frames (so a later pass over the same
    road can't interleave), drops GPS glitches that jump backwards along the route, and
    replaces compass headings that disagree with the direction of travel.
    """
    manifest = json.loads(path.read_text(encoding="utf-8"))
    base = path.parent.parent  # "file" paths are relative to pipeline/

    runs, run, last_s = [], [], -math.inf
    for f in sorted(manifest["frames"], key=lambda f: f["captured_at"]):
        s, off = primary.line.project(f["lon"], f["lat"])
        if off > MAX_OFF_ROUTE_M or not (0 < s < primary.line.length):
            if run:
                runs.append(run)
            run, last_s = [], -math.inf
            continue
        if s < last_s - 2:
            print(f"  dropped {f['image_id']}: position jumps back {last_s - s:.0f} m (GPS glitch)")
            continue
        run.append((f, s))
        last_s = s
    if run:
        runs.append(run)
    if not runs:
        sys.exit(f"No frames in {path} are on the route.")
    best = max(runs, key=len)
    print(f"  {sum(map(len, runs))} frames on route in {len(runs)} run(s); using {len(best)}")

    IMG_DIR.mkdir(parents=True, exist_ok=True)
    keep = {f"{f['image_id']}.jpg" for f, _ in best}
    for old in IMG_DIR.glob("*.jpg"):
        if old.name not in keep:
            old.unlink()

    frames = []
    for f, s in best:
        shutil.copy2(base / f["file"], IMG_DIR / f"{f['image_id']}.jpg")
        heading, source = f.get("compass_angle"), "camera"
        route_bearing = primary.line.bearing_at(s)
        if heading is None or angle_diff(heading, route_bearing) > MAX_HEADING_DIFF:
            print(f"  {f['image_id']}: heading {heading} disagrees with route ({route_bearing:.0f}), using route")
            heading, source = round(route_bearing, 1), "route"
        frames.append({
            "id": f["image_id"], "image": f"/route/{f['image_id']}.jpg", "lng": f["lon"], "lat": f["lat"],
            "heading": heading, "headingSource": source,
            "capturedAt": datetime.fromtimestamp(f["captured_at"] / 1000, tz=timezone.utc).isoformat(),
            "s": s,
        })
    return manifest.get("sequence_id"), frames


def synthetic_frames(primary: RouteModel) -> list[dict]:
    frames = []
    s = 0.0
    while s <= primary.line.length:
        lng, lat = primary.line.point_at(s)
        frames.append({"id": f"synthetic-{int(s)}", "image": None, "lng": lng, "lat": lat,
                       "heading": round(primary.line.bearing_at(s), 1), "capturedAt": None, "s": s})
        s += 20
    return frames


def boundaries_to_polygons(frame: dict, rows: list[float]) -> list[list[list[float]]]:
    """Lane i = the space between boundary i and i+1 (vision/README.md format), as a polygon."""
    def bottom_x(b):
        return next((x for x in b["x"] if x is not None), math.inf)

    lines = sorted(frame["boundaries"], key=bottom_x)
    lanes = []
    for left, right in zip(lines, lines[1:]):
        both = [j for j, r in enumerate(rows) if left["x"][j] is not None and right["x"][j] is not None]
        if len(both) < 2:
            continue  # can't draw a lane from fewer than two shared rows
        lanes.append([[left["x"][j], rows[j]] for j in both] +
                     [[right["x"][j], rows[j]] for j in reversed(both)])
    return lanes


def load_lane_polygons(path: Path) -> dict[str, list]:
    """Polygons per frame id. Accepts the boundary format (vision/README.md) or legacy raw polygons."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if "frames" not in data:
        return data
    return {fid: lanes for fid, fr in data["frames"].items()
            if (lanes := boundaries_to_polygons(fr, data["rows"]))}


# Lane geometry sources, all in the vision/README.md boundary format. The frontend can switch
# between them; the first one present is the default.
LANE_SOURCES = {
    "yolop": ("YOLOPv2", DATA / "yolop_lanes.json"),
    "opencv": ("OpenCV", DATA / "detected_lanes.json"),
    "labeled": ("Hand-traced", DATA / "fallback_lanes.json"),
}


def load_lane_sources() -> tuple[dict[str, dict], dict[str, dict]]:
    """({source: {frame id: polygons}}, {source: {label, method, confidence by frame id}})."""
    polygons, info = {}, {}
    for key, (label, path) in LANE_SOURCES.items():
        if not path.exists():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        polygons[key] = load_lane_polygons(path)
        frames = data.get("frames", {})
        info[key] = {"label": label, "method": data.get("method"),
                     "confidence": {fid: fr.get("confidence") for fid, fr in frames.items()}}
    return polygons, info


# ---------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--frames", nargs="?", const=str(PIPELINE_FRAMES), metavar="PATH",
                     help="use a frames.json manifest (default: pipeline/data/frames.json)")
    src.add_argument("--image-id", help="any Mapillary image id from the clip (pKey= in the web URL)")
    src.add_argument("--synthetic", action="store_true", help="no imagery; sample frames along the route")
    ap.add_argument("--refresh", action="store_true", help="re-fetch Mapbox routes instead of using data/ cache")
    args = ap.parse_args()

    print("Loading routes")
    models = {k: RouteModel(k, load_mapbox(k, args.refresh)) for k in ROUTES}
    primary = models[PRIMARY_ROUTE]

    print("Building frames")
    if args.synthetic:
        seq, frames = None, synthetic_frames(primary)
    elif args.frames:
        seq, frames = manifest_frames(Path(args.frames), primary)
    else:
        seq, frames = mapillary_frames(args.image_id, primary)

    lane_polys, lane_info = load_lane_sources()
    print("Lane sources: " + ", ".join(f"{k} ({len(p)} frames)" for k, p in lane_polys.items()))
    for f in frames:
        f["nav"] = {}
        for key, model in models.items():
            s, off = model.line.project(f["lng"], f["lat"])
            f["nav"][key] = model.state_at(s) if off <= MAX_OFF_ROUTE_M else None
        for key, nav in f["nav"].items():
            if nav:
                nav["laneReasons"] = lane_reasons(nav, {k: o for k, o in f["nav"].items() if k != key and o})
        f["progressM"] = round(f.pop("s"), 1)
        # Every source's geometry, so the frontend can switch between them; lanePolygons is the
        # first source (in LANE_SOURCES order) that has lanes for this frame.
        f["laneSets"] = {k: {"polygons": polys.get(f["id"]), "confidence": lane_info[k]["confidence"].get(f["id"])}
                         for k, polys in lane_polys.items()}
        f["polygonSource"] = next((k for k, v in f["laneSets"].items() if v["polygons"]), None)
        f["lanePolygons"] = f["laneSets"][f["polygonSource"]]["polygons"] if f["polygonSource"] else None

    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "mode": "synthetic" if args.synthetic else "mapillary",
        "sequenceId": seq,
        "primaryRoute": PRIMARY_ROUTE,
        "routes": {k: {"label": ROUTES[k]["label"], "geometry": m.line.coords,
                       "distanceM": round(m.line.length, 1)} for k, m in models.items()},
        "laneSources": {k: {"label": v["label"], "method": v["method"]} for k, v in lane_info.items()},
        "frames": frames,
        "attribution": [
            "Route and lane guidance: Mapbox Directions API (© Mapbox, © OpenStreetMap contributors)",
            "Street-level imagery: Mapillary, CC-BY-SA 4.0",
        ],
    }
    OUT.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"Wrote {OUT.relative_to(ROOT)} with {len(frames)} frames")
    for f in frames:
        row = []
        for key in ROUTES:
            n = f["nav"][key]
            row.append(f"{key}: lane {n['preferredLane']}/{len(n['lanes'] or [])} {n['distanceM']:>5}m"
                       if n else f"{key}: off route")
        print(f"  {f['progressM']:>6}m  " + "  |  ".join(row))


if __name__ == "__main__":
    main()
