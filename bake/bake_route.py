"""Bake the demo: Mapbox lane guidance + a Mapillary image sequence -> demo_route.json.

    python bake/bake_route.py --image-id <mapillary image id>   # real imagery
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

load_dotenv(ROOT / ".env")

# SR 70 (Okeechobee Rd) eastbound onto I-95, Fort Pierce FL. Both routes share the
# approach and split at the ramp fork, so the same frames get a different lane per route.
ROUTES = {
    "north": {"label": "I-95 North · Daytona Beach",
              "origin": (-80.395166, 27.413656), "destination": (-80.389239, 27.415502)},
    "south": {"label": "I-95 South · West Palm Beach",
              "origin": (-80.395166, 27.413656), "destination": (-80.389369, 27.414368)},
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


def preferred_lane(lanes: list[dict], side: str | None) -> int | None:
    """Mapbox says which lanes are usable; we pick the usable lane nearest the maneuver side."""
    usable = [i for i, l in enumerate(lanes) if l.get("active")] or \
             [i for i, l in enumerate(lanes) if l.get("valid")]
    if not usable:
        return None
    if side == "right":
        return max(usable)
    if side == "left":
        return min(usable)
    return usable[0] if len(usable) == 1 else None


class RouteModel:
    def __init__(self, key: str, response: dict):
        route = response["routes"][0]
        self.key = key
        self.line = Polyline(route["geometry"]["coordinates"])
        self.steps = route["legs"][0]["steps"]
        self.maneuver_s = [self.line.cum[st["intersections"][0]["geometry_index"]] for st in self.steps]

        # Every intersection that carries lane data, with the maneuver those lanes serve:
        # lanes at a step's own maneuver point serve that maneuver; later ones serve the next.
        self.lane_points = []
        for k, step in enumerate(self.steps):
            for j, inter in enumerate(step["intersections"]):
                if not inter.get("lanes"):
                    continue
                m = k if j == 0 else k + 1
                while m < len(self.steps) - 1 and side_of(self.steps[m]["maneuver"].get("modifier")) is None:
                    m += 1
                self.lane_points.append({
                    "s": self.line.cum[inter["geometry_index"]],
                    "location": inter["location"],
                    "lanes": inter["lanes"],
                    "side": side_of(self.steps[min(m, len(self.steps) - 1)]["maneuver"].get("modifier")),
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
        lanes = [{k2: l[k2] for k2 in ("indications", "valid", "active", "valid_indication") if k2 in l}
                 for l in lp["lanes"]] if lp else None

        return {
            "instruction": instruction,
            "maneuverType": man["type"],
            "modifier": man.get("modifier"),
            "distanceM": round(max(0.0, self.maneuver_s[k] - s), 1),
            "lanes": lanes,
            "preferredLane": preferred_lane(lp["lanes"], lp["side"]) if lp else None,
            "laneSide": lp["side"] if lp else None,
            "laneSource": {"lng": lp["location"][0], "lat": lp["location"][1],
                           "distanceM": round(max(0.0, lp["s"] - s), 1)} if lp else None,
        }


# ---------------------------------------------------------------- data sources

def load_mapbox(key: str, refresh: bool) -> dict:
    cache = DATA / f"mapbox_{key}.json"
    if cache.exists() and not refresh:
        return json.loads(cache.read_text(encoding="utf-8"))
    token = os.getenv("MAPBOX_TOKEN") or sys.exit("MAPBOX_TOKEN missing from .env")
    cfg = ROUTES[key]
    coords = ";".join(f"{lng},{lat}" for lng, lat in (cfg["origin"], cfg["destination"]))
    r = requests.get(
        f"https://api.mapbox.com/directions/v5/mapbox/driving/{coords}",
        params={"steps": "true", "banner_instructions": "true", "geometries": "geojson",
                "overview": "full", "access_token": token},
        timeout=30,
    )
    r.raise_for_status()
    resp = r.json()
    cache.write_text(json.dumps(resp, indent=1), encoding="utf-8")
    print(f"  fetched Mapbox route '{key}' -> {cache.relative_to(ROOT)}")
    return resp


def mly_get(path: str, **params) -> dict:
    token = os.getenv("MAPILLARY_TOKEN") or sys.exit("MAPILLARY_TOKEN missing from .env")
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


def synthetic_frames(primary: RouteModel) -> list[dict]:
    frames = []
    s = 0.0
    while s <= primary.line.length:
        lng, lat = primary.line.point_at(s)
        frames.append({"id": f"synthetic-{int(s)}", "image": None, "lng": lng, "lat": lat,
                       "heading": round(primary.line.bearing_at(s), 1), "capturedAt": None, "s": s})
        s += 20
    return frames


# ---------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
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
    else:
        seq, frames = mapillary_frames(args.image_id, primary)

    polygons = json.loads((DATA / "fallback_lanes.json").read_text(encoding="utf-8"))
    for f in frames:
        f["nav"] = {}
        for key, model in models.items():
            s, off = model.line.project(f["lng"], f["lat"])
            f["nav"][key] = model.state_at(s) if off <= MAX_OFF_ROUTE_M else None
        f["progressM"] = round(f.pop("s"), 1)
        f["lanePolygons"] = polygons.get(f["id"])

    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "mode": "synthetic" if args.synthetic else "mapillary",
        "sequenceId": seq,
        "primaryRoute": PRIMARY_ROUTE,
        "routes": {k: {"label": ROUTES[k]["label"], "geometry": m.line.coords,
                       "distanceM": round(m.line.length, 1)} for k, m in models.items()},
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
