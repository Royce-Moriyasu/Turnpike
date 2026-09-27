"""
yolop_lanes.py

Turns YOLOPv2 lane masks (from vision/yolop_masks.py) into lane lines and writes
clips/<clip>/yolop_lanes.json in the same format as the hand labels and detect_lanes.py
(see vision/README.md), so the bake and the React overlay can use it directly.

Why not just feed the mask into detect_lanes.py? Its fitting is tuned for thin painted stripes
that span the whole search area. The learned mask draws lines 25-80 px wide (upscaled from the
model's 640 px output), and outer lines leave the frame sideways before reaching the bottom, so
detect_lanes merges or drops them. The mask is clean, so a direct approach works better:

  1. Follow each line up the image row by row, matching each row's mask stripes to the lines
     being tracked. A line that enters from the side higher up starts a new track.
  2. Fit x = poly(y) to each track (detect_lanes.robust_fit), joining collinear pieces (dashes).
  3. Solid/dashed and white/yellow come from the photo's paint; confidence uses the same formula
     as detect_lanes.py, so the sources are comparable.
  4. Each lane's share of YOLOPv2's drivable area ("drivable", one per lane). The model marks only
     the road we are on, so a "lane" across a median (the opposing roadway's lines, seen during a
     turn) scores low and the frontend won't count or highlight it (lanes.ts).

Reads clips/<clip>/_build/yolop/band/{lane,drivable}/ and writes clips/<clip>/yolop_lanes.json. The tracking band
and vanishing point come from the clip's camera (clip.json camera.vanishingPoint).

Usage (from the repo root; run vision/yolop_masks.py first):
    .venv/Scripts/python.exe vision/yolop_lanes.py --clip sr70
    .venv/Scripts/python.exe vision/yolop_lanes.py --clip sr70 --debug   # overlays in vision_debug/yolop_lanes/<clip>/
"""

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import detect_lanes as dl  # noqa: E402  (shared fitting, confidence and sanity helpers)
from clip import DEFAULT_CLIP, Clip  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
DEBUG = REPO / "vision_debug/yolop_lanes"
METHOD = "yolopv2-mask-tracks-v1"

ROWS = dl.ROWS                # heights reported, bottom first (set per clip in use_camera)
# SR 70's rows as fractions of the distance from its horizon (0.775) to the bottom of the image, so
# other cameras sample the same part of the road: [1, 0.778, 0.556, 0.378, 0.244]
ROW_DEPTHS = [(r - 0.775) / (1 - 0.775) for r in dl.ROWS]
# Rows are set per clip from the camera's horizon in use_camera (values shown are SR 70's).
BAND_TOP = 0.81               # track up to here (horizon + 0.035); above it the lines crowd together
BAND_BOTTOM = 0.97            # ...and from here (below is dashboard)
STEP_PX = 3                   # row step while tracking (at 1152 px tall)
MAX_RUN_FRAC = 0.10           # a mask stripe wider than this share of the width is a merged blob
MATCH_PX = 28                 # how far a stripe may sit from a track's predicted x (at 2048 wide)
PATIENCE_ROWS = 30            # rows a track may go unmatched (dash gaps) before it ends
MIN_POINTS = 8
MIN_SPAN = 0.05               # a track must cover at least this much of the image height
MERGE_PX = 18                 # tracks whose fits agree this closely are the same line
CURVE_GAIN = 0.85             # use a curved fit if it cuts the error by 15%+. detect_lanes.py asks for 30%, but
                              # YOLOPv2's lines are 25-80 px thick, so their error stays high even when a
                              # curve follows the line (on the Post Road clip most curving lines stayed straight)
SAME_LINE = 0.02             # two final lines closer than this on average over the rows they share = duplicate
MAX_FLATNESS = 5.0            # a line running sideways faster than this (image widths per image height) is
                              # a stop bar or crosswalk: lane lines head for the vanishing point (edge lines
                              # on SR 70 / clip2 / clip3 reach ~4.5; a stop bar at the Post Road light, 6.5)
PAINT_PX = 16                 # how close photo paint must be to count toward solid/yellow (mask lines
                              # are thick and not always centered on the paint)
SOLID_MIN = 0.85              # share of rows with paint to call a line solid
SLIVER = 0.5                  # an inner lane narrower than this x both neighbors has a fake line
SUPPORT_TOP = 0.86            # judge a line's mask support below this row (horizon + 0.085)
MIN_SUPPORT = 0.25            # a line inside the frame there with less mask than this is a fake extension
MIN_SUPPORT_ROWS = 5          # ...judged only if it is inside the frame on at least this many rows
X_LIMIT = (-0.1, 1.1)         # report x only this far outside the frame (as detect_lanes.py)
EXTRAPOLATE = 0.10            # report rows at most this far (of image height) past the detections
DRIVABLE_ACROSS = (0.2, 0.35, 0.5, 0.65, 0.8)  # where across a lane to sample the drivable mask
DRIVABLE_STEPS = 6            # samples between consecutive report rows
DRIVABLE_MIN_SAMPLES = 8      # fewer samples inside the frame than this: unknown (None)


def recover_bike_dividers(boundaries, cv_boundaries):
    """Restore a solid bike-lane edge missed by the YOLOPv2 mask.

    Require two adjacent, confident solid paint detections from the photo, with
    exactly one already represented by a YOLOPv2 boundary. Their narrow spacing
    is evidence of a separate bike lane rather than a new full-width road lane.
    """
    def same_line(a, b):
        shared = [(x, y) for x, y in zip(a["x"], b["x"])
                  if x is not None and y is not None]
        return len(shared) >= 3 and max(abs(x - y) for x, y in shared) <= 0.025

    result = list(boundaries)
    for left, right in zip(cv_boundaries, cv_boundaries[1:]):
        if any(b["type"] != "solid" or b.get("confidence", 0) < 0.5 for b in (left, right)):
            continue
        if left["x"][0] is None or right["x"][0] is None:
            continue
        bottom_gap = abs(left["x"][0] - right["x"][0])
        top_gap = abs(left["x"][-1] - right["x"][-1]) if left["x"][-1] is not None and right["x"][-1] is not None else 0
        if not (0.09 <= bottom_gap <= 0.25 and 0.035 <= top_gap <= 0.12):
            continue
        matches = [any(same_line(cv, b) for b in result) for cv in (left, right)]
        if matches.count(True) != 1:
            continue
        missing = right if matches[0] else left
        result.append(dict(missing))
    return sorted(result, key=lambda b: next((x for x in reversed(b["x"]) if x is not None), math.inf))


def stripes(row, w):
    """Centers of mask runs in one row, skipping runs too wide to be a single line."""
    edges = np.diff(np.concatenate(([0], row, [0])))
    out = []
    for st, en in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)):
        if 3 <= en - st <= MAX_RUN_FRAC * w:
            out.append((st + en - 1) / 2)
    return out


def track_lines(mask, s):
    """Follow mask stripes from the bottom up. Returns a list of (ys, xs) arrays."""
    h, w = mask.shape
    y0, y1 = int(BAND_BOTTOM * h), int(BAND_TOP * h)
    step = max(1, int(STEP_PX * h / 1152))
    tracks = []  # dicts: ys, xs, idle
    for y in range(y0, y1, -step):
        xs = stripes(mask[y] > 0, w)
        live = [t for t in tracks if t["idle"] <= PATIENCE_ROWS]
        # predicted x of each live track at this row (line through its last few points)
        pred = []
        for t in live:
            if len(t["ys"]) >= 3:
                a, b = np.polyfit(t["ys"][-6:], t["xs"][-6:], 1)
                pred.append(a * y + b)
            else:
                pred.append(t["xs"][-1])
        pairs = sorted((abs(px - x), ti, xi) for ti, px in enumerate(pred) for xi, x in enumerate(xs))
        used_t, used_x = set(), set()
        for d, ti, xi in pairs:
            if d > MATCH_PX * s or ti in used_t or xi in used_x:
                continue
            used_t.add(ti)
            used_x.add(xi)
            live[ti]["ys"].append(y)
            live[ti]["xs"].append(xs[xi])
            live[ti]["idle"] = 0
        for ti, t in enumerate(live):
            if ti not in used_t:
                t["idle"] += 1
        for xi, x in enumerate(xs):
            if xi not in used_x:
                tracks.append({"ys": [y], "xs": [x], "idle": 0})
    return [(np.array(t["ys"], float), np.array(t["xs"], float)) for t in tracks
            if len(t["ys"]) >= MIN_POINTS and (max(t["ys"]) - min(t["ys"])) >= MIN_SPAN * h]


def fit(ys, xs, s):
    """Straight fit, or a gentle curve if it fits better (as detect_lanes.refit, with a lower bar:
    CURVE_GAIN)."""
    lin, rms, keep = dl.robust_fit(ys, xs, 1, s)
    poly = lin
    if keep.sum() >= 12:
        quad, rms_q, keep_q = dl.robust_fit(ys, xs, 2, s)
        if rms_q < CURVE_GAIN * rms and keep_q.sum() >= 0.9 * keep.sum():
            poly, rms, keep = quad, rms_q, keep_q
    return {"lin": lin, "poly": poly, "rms_px": rms / s, "ys": ys[keep], "xs": xs[keep]}


def merge_collinear(lines, h, s):
    """Join tracks of the same line (e.g. dash pieces) whose fits agree across the band."""
    ys_band = np.linspace(BAND_TOP * h, BAND_BOTTOM * h, 12)
    merged = True
    while merged:
        merged = False
        for i in range(len(lines)):
            for j in range(i + 1, len(lines)):
                a, b = lines[i], lines[j]
                d = np.mean(np.abs(np.polyval(a["poly"], ys_band) - np.polyval(b["poly"], ys_band)))
                if d < MERGE_PX * s:
                    lines[i] = fit(np.concatenate((a["ys"], b["ys"])), np.concatenate((a["xs"], b["xs"])), s)
                    del lines[j]
                    merged = True
                    break
            if merged:
                break
    return lines


def support(line, mask, h, w, s, with_rows=False):
    """Share of the lower band rows (inside the frame) where the mask sits on this line."""
    ys = np.arange(int(SUPPORT_TOP * h), int(BAND_BOTTOM * h), max(1, int(STEP_PX * h / 1152)))
    xs = np.polyval(line["poly"], ys)
    inside = (xs >= 0) & (xs < w)
    tol = max(2, int(PAINT_PX * s))
    share = float(np.mean([mask[y, max(0, int(x) - tol):int(x) + tol + 1].any()
                           for y, x in zip(ys[inside], xs[inside])])) if inside.any() else 0.0
    return (share, int(inside.sum())) if with_rows else share


def drop_slivers(lines, mask, h, w, s):
    """Remove fake lines that split a lane into a sliver. Only inner lanes are checked: an outer
    narrow lane may be a real bike lane or shoulder, which the frontend handles (lanes.ts). Of the
    sliver's two lines, the one with less mask under it in the lower rows goes: there the real
    lines are distinct, while a fake one is usually a track from the crowded rows near the horizon
    extended down over bare road."""
    ys = np.array([r * h for r in ROWS])
    changed = True
    while changed and len(lines) >= 4:
        changed = False
        xs = [np.polyval(ln["poly"], ys) / w for ln in lines]
        on_screen = [(x >= X_LIMIT[0]) & (x <= X_LIMIT[1]) for x in xs]
        widths = [b - a for a, b in zip(xs, xs[1:])]
        for i in range(1, len(widths) - 1):
            # compare only rows where all four lines around the lane are on screen; an extrapolated
            # line far outside the frame says nothing about lane widths
            rows = on_screen[i - 1] & on_screen[i] & on_screen[i + 1] & on_screen[i + 2]
            if rows.any() and np.all(widths[i][rows] < SLIVER * widths[i - 1][rows]) \
                    and np.all(widths[i][rows] < SLIVER * widths[i + 1][rows]):
                weaker = i if support(lines[i], mask, h, w, s) < support(lines[i + 1], mask, h, w, s) else i + 1
                del lines[weaker]
                changed = True
                break
    return lines


def describe(line, paint, yellow, h, w, s):
    """Solid/dashed, white/yellow, coverage and confidence for one fitted line."""
    ys = np.arange(int(BAND_TOP * h), int(BAND_BOTTOM * h), max(1, int(STEP_PX * h / 1152)))
    xs = np.polyval(line["poly"], ys)
    inside = (xs >= 0) & (xs < w)
    ys, xs = ys[inside], xs[inside].astype(int)
    tol = max(2, int(PAINT_PX * s))
    near = lambda m: np.array([m[y, max(0, x - tol):x + tol + 1].any() for y, x in zip(ys, xs)])  # noqa: E731
    painted = near(paint) if len(ys) else np.array([])
    yellowish = near(yellow) if len(ys) else np.array([])
    detected = set(line["ys"].astype(int).tolist())
    coverage = (sum(1 for y in ys if any(abs(y - d) <= STEP_PX for d in detected)) / len(ys)) if len(ys) else 0.0
    line_type = "solid" if len(painted) and painted.mean() >= SOLID_MIN else "dashed"
    color = "yellow" if len(yellowish) and yellowish.mean() >= dl.YELLOW_FRACTION else "white"
    x_at_vp = np.polyval(line["lin"], dl.VP[1] * h) / w
    vp_score = math.exp(-0.5 * ((x_at_vp - dl.VP[0]) / dl.VP_SIGMA) ** 2)
    conf = math.exp(-line["rms_px"] / 4) * coverage * vp_score
    return line_type, color, conf


def flatness(xs):
    """Steepest sideways run of a sampled line: |dx| / |dy| between consecutive report rows (image
    widths per image height)."""
    pts = [(r, x) for r, x in zip(ROWS, xs) if x is not None]
    return max((abs((x2 - x1) / (r2 - r1)) for (r1, x1), (r2, x2) in zip(pts, pts[1:])), default=0.0)


def same_line(xs, other):
    """Two sampled lines are one line: within SAME_LINE of each other on average over the rows both
    have. Not just at the top row: near the horizon every line converges (on a camera pitched up, the
    top row can be only ~8% of the image below it), so separate lines can meet there."""
    gaps = [abs(a - b) for a, b in zip(xs, other) if a is not None and b is not None]
    return bool(gaps) and sum(gaps) / len(gaps) < SAME_LINE


def x_at(line, y):
    """The line's x at row y: its fit where it was detected; beyond either end, straight on along
    the fit's direction there (a curve's formula swings off quickly past the paint it was fit to)."""
    y_lo, y_hi = line["ys"].min(), line["ys"].max()
    end = min(max(y, y_lo), y_hi)
    slope = np.polyval(np.polyder(line["poly"]), end)
    return float(np.polyval(line["poly"], end) + slope * (y - end))


def sample(line, h, w):
    y_lo, y_hi = line["ys"].min(), line["ys"].max()
    xs = []
    for r in ROWS:
        y = r * h
        if y > y_hi + EXTRAPOLATE * h or y < y_lo - EXTRAPOLATE * h:
            xs.append(None)
            continue
        x = x_at(line, y) / w
        xs.append(round(x, 3) if X_LIMIT[0] <= x <= X_LIMIT[1] else None)
    return xs


VEHICLE_MIN_CONF = 0.4        # vehicle boxes counted as road (same filters as the app's DriverView)
VEHICLE_MAX_WIDTH = 0.6


def with_vehicles(drivable, vehicles):
    """The drivable mask with detected vehicles filled in as road. YOLOPv2's drivable area stops at
    a car, so a lane with a car in it (e.g. queued at a light) would score as not drivable and be
    dropped (lanes.ts DRIVABLE_MIN); cars sit on the road, so the road under their box counts."""
    if drivable is None or not vehicles:
        return drivable
    out = drivable.copy()
    h, w = out.shape
    for v in vehicles:
        x0, y0, x1, y1 = v["box"]
        if v["confidence"] >= VEHICLE_MIN_CONF and x1 - x0 <= VEHICLE_MAX_WIDTH:
            out[int(y0 * h):int(y1 * h) + 1, int(x0 * w):int(x1 * w) + 1] = 255
    return out


def lane_drivable(boundaries, drivable, h, w):
    """Share of each lane (left to right, as the bake pairs boundaries into lanes) that YOLOPv2 calls
    drivable, sampled across the lane between the report rows where both its lines are known."""
    def bottom_x(b):
        return next((x for x in b["x"] if x is not None), math.inf)

    lines = sorted(boundaries, key=bottom_x)
    out = []
    for left, right in zip(lines, lines[1:]):
        both = [j for j, x in enumerate(left["x"]) if x is not None and right["x"][j] is not None]
        hits = []
        for a, b in zip(both, both[1:]):
            for t in np.linspace(0, 1, DRIVABLE_STEPS, endpoint=False):
                y = ROWS[a] + t * (ROWS[b] - ROWS[a])
                xl = left["x"][a] + t * (left["x"][b] - left["x"][a])
                xr = right["x"][a] + t * (right["x"][b] - right["x"][a])
                for f in DRIVABLE_ACROSS:
                    x = xl + f * (xr - xl)
                    if 0 <= x < 1 and 0 <= y < 1:
                        hits.append(drivable[int(y * h), int(x * w)] >= 128)
        out.append(round(float(np.mean(hits)), 2) if len(hits) >= DRIVABLE_MIN_SAMPLES else None)
    return out


def frame_confidence(boundaries, nav):
    """Same idea as detect_lanes.process_frame: the target lane's weaker line x sanity x count."""
    if not boundaries:
        return 0.0, "no lines found"
    san, why = dl.sanity(boundaries)
    lanes, pref = (nav or {}).get("lanes"), (nav or {}).get("preferredLane")
    if not lanes or pref is None:
        return round(min(b["confidence"] for b in boundaries) * san, 3), why or "no Mapbox lane data"
    n = len(boundaries)
    # count from the same side as the frontend: laneAnchor (bake: _lane_matching), else the turn side
    li = pref if (nav.get("laneAnchor") or nav.get("laneSide")) == "left" else n - 2 - (len(lanes) - 1 - pref)
    if not (0 <= li and li + 1 < n):
        return 0.0, why or f"lines for target lane {pref} not found"
    target = min(boundaries[li]["confidence"], boundaries[li + 1]["confidence"])
    return round(target * san * min(1.0, n / (len(lanes) + 1)), 3), why


def process(img, mask, drivable, frame, route_key):
    h, w = img.shape[:2]
    s = w / 2048
    white, yellow = dl.build_masks(img, s)
    lines = [fit(ys, xs, s) for ys, xs in track_lines(mask, s)]
    lines = merge_collinear(lines, h, s)
    lines.sort(key=lambda ln: np.polyval(ln["poly"], ROWS[-1] * h))  # left to right near the top
    lines = [ln for ln in lines
             if (sr := support(ln, mask, h, w, s, with_rows=True))[1] < MIN_SUPPORT_ROWS or sr[0] >= MIN_SUPPORT]
    lines = drop_slivers(lines, mask, h, w, s)

    boundaries, kept = [], []
    for ln in lines:
        xs = sample(ln, h, w)
        if sum(x is not None for x in xs) < 2:
            continue
        if kept and same_line(xs, boundaries[-1]["x"]):
            continue  # duplicate of the previous line
        if flatness(xs) > MAX_FLATNESS:
            continue  # stop bar / crosswalk, not a lane line
        line_type, color, conf = describe(ln, cv2.bitwise_or(white, yellow), yellow, h, w, s)
        boundaries.append({"x": xs, "type": line_type, "color": color, "confidence": round(conf, 3)})
        kept.append(ln)

    # Yellow anchor (as detect_lanes.clean_up): the yellow edge line is the left side of our
    # roadway, so lines left of it belong to another road (e.g. SR 70 beside the I-95 ramp).
    yellows = [i for i, b in enumerate(boundaries) if b["color"] == "yellow"]
    if dl.YELLOW_ANCHOR and yellows:
        anchor = max(yellows, key=lambda i: boundaries[i]["confidence"])
        boundaries, kept = boundaries[anchor:], kept[anchor:]

    nav = (frame.get("nav") or {}).get(route_key)
    conf, reason = frame_confidence(boundaries, nav)
    debug = {"tracks": len(lines), "route": route_key}
    if reason:
        debug["reason"] = reason
    entry = {"confidence": conf, "boundaries": boundaries, "debug": debug}
    if drivable is not None:
        entry["drivable"] = lane_drivable(boundaries, drivable, h, w)
    return entry, kept


def draw_debug(img, kept, entry, path):
    h, w = img.shape[:2]
    out = img.copy()
    for ln, b in zip(kept, entry["boundaries"]):
        ys = np.arange(int(ROWS[-1] * h), h, 4)
        pts = np.array([(int(np.polyval(ln["poly"], y)), y) for y in ys], np.int32)
        color = (0, 215, 255) if b["color"] == "yellow" else (0, 0, 255)
        cv2.polylines(out, [pts], False, color, 6)
    cv2.putText(out, f'lines: {len(kept)}  conf: {entry["confidence"]:.2f}', (40, 80),
                cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 0, 255), 4)
    cv2.imwrite(str(path), cv2.resize(out, (w // 2, h // 2)))


def use_camera(clip: Clip) -> None:
    """Tracking rows and vanishing point from the clip's camera (clip.json)."""
    global BAND_TOP, SUPPORT_TOP, ROWS
    horizon = clip.horizon
    ROWS = [round(horizon + f * (1 - horizon), 3) for f in ROW_DEPTHS]
    BAND_TOP = round(horizon + 0.035, 4)
    SUPPORT_TOP = round(horizon + 0.085, 4)
    dl.VP = clip.vanishing_point  # used by the confidence (line points at the vanishing point)


def main():
    parser = argparse.ArgumentParser(description="Lane lines from YOLOPv2 lane masks.")
    parser.add_argument("--clip", default=DEFAULT_CLIP, help=f"clip folder under clips/ (default {DEFAULT_CLIP})")
    parser.add_argument("--route", help="route key for the confidence's target lane (default: the clip's primaryRoute)")
    parser.add_argument("--out", type=Path, help="output file (default: clips/<clip>/yolop_lanes.json)")
    parser.add_argument("--debug", action="store_true", help=f"save overlays to {DEBUG.relative_to(REPO)}/<clip>/")
    args = parser.parse_args()

    clip = Clip(args.clip)
    use_camera(clip)
    masks = clip.masks("band", "lane")
    drivable_masks = clip.masks("band", "drivable")
    out = args.out or clip.yolop_lanes
    debug_dir = DEBUG / clip.name
    if not clip.demo.exists():
        sys.exit(f"{clip.demo.relative_to(REPO)} not found: bake the clip first (bake/bake_route.py --clip {clip.name})")
    demo = json.loads(clip.demo.read_text(encoding="utf-8"))
    cv_frames = (json.loads(clip.detected.read_text(encoding="utf-8")).get("frames", {})
                 if clip.detected.exists() else {})
    vehicles = (json.loads(clip.vehicles.read_text(encoding="utf-8")).get("frames", {})
                if clip.vehicles.exists() else {})  # from yolop_masks.py
    route_key = args.route or demo.get("primaryRoute") or "north"
    frames = demo["frames"]
    if args.debug:
        debug_dir.mkdir(parents=True, exist_ok=True)

    result = {
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "method": METHOD,
        "imageSize": None,
        "rows": ROWS,
        "frames": {},
    }
    print(f"Route: {route_key}   Frames: {len(frames)}")
    for i, frame in enumerate(frames, start=1):
        fid = frame["id"]
        img = cv2.imread(str(clip.public_images / f"{fid}.jpg"))
        mask = cv2.imread(str(masks / f"{fid}.png"), cv2.IMREAD_GRAYSCALE)
        if img is None or mask is None:
            print(f"  [{i:2d}/{len(frames)}] {fid}  SKIPPED ({'image' if img is None else 'mask'} not found)")
            continue
        result["imageSize"] = result["imageSize"] or [img.shape[1], img.shape[0]]
        drivable = with_vehicles(cv2.imread(str(drivable_masks / f"{fid}.png"), cv2.IMREAD_GRAYSCALE),
                                 vehicles.get(fid))
        entry, kept = process(img, (mask >= 128).astype(np.uint8) * 255, drivable, frame, route_key)
        if args.debug:
            draw_debug(img, kept, entry, debug_dir / f"{i:03d}_{fid}.jpg")
        repaired = recover_bike_dividers(entry["boundaries"],
                                         cv_frames.get(fid, {}).get("boundaries", []))
        if len(repaired) != len(entry["boundaries"]):
            added = len(repaired) - len(entry["boundaries"])
            entry["boundaries"] = repaired
            entry["confidence"], reason = frame_confidence(repaired, (frame.get("nav") or {}).get(route_key))
            entry["debug"]["recoveredBikeDividers"] = added
            if drivable is not None:  # one share per lane: the added line splits a lane in two
                entry["drivable"] = lane_drivable(repaired, drivable, img.shape[0], img.shape[1])
            if reason:
                entry["debug"]["reason"] = reason
            else:
                entry["debug"].pop("reason", None)
        result["frames"][fid] = entry
        print(f"  [{i:2d}/{len(frames)}] {fid}  lines: {len(entry['boundaries'])}  "
              f"conf: {entry['confidence']:.2f}  {entry['debug'].get('reason', '')}")

    if not result["frames"]:
        sys.exit(f"No masks found in {masks}. Run vision/yolop_masks.py --clip {clip.name} first.")
    out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    good = sum(1 for f in result["frames"].values() if f["confidence"] >= 0.6)
    print(f"\nWrote {out.relative_to(REPO)}  ({len(result['frames'])} frames, {good} with confidence >= 0.6)")


if __name__ == "__main__":
    main()
