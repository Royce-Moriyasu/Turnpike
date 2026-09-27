"""
detect_lanes.py

Runs OpenCV lane-line detection on every frame of a baked clip (clips/<clip>/, see tools/clip.py)
and writes clips/<clip>/detected_lanes.json in the format described in vision/README.md.

It only reports WHERE the painted lines are. It never decides which lane is
correct; the bake combines this file with the Mapbox lane data.

Usage (from anywhere, paths are relative to the repo; --clip picks the clip folder, default sr70):
    python3 vision/detect_lanes.py --clip sr70
    python3 vision/detect_lanes.py --clip sr70 --debug
    python3 vision/detect_lanes.py --images ~/turnpike/data/images --debug
"""

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

# ---------- Settings (tuned on a 2048x1152 frame; pixel values auto-scale) ----------
ROI_TOP = 0.78           # search area top (the horizon)
ROI_BOTTOM = 0.97        # search area bottom (just above the photo edge)
ROI_TOP_LEFT = 0.44
ROI_TOP_RIGHT = 0.54
ROI_BOTTOM_LEFT = 0.17
ROI_BOTTOM_RIGHT = 0.98

TOPHAT_SIZE = 81         # px, should be wider than a lane line
WHITE_THRESH = 25        # how much brighter than its surroundings white paint must be
YELLOW_B = 140           # LAB "b" value above which a pixel counts as yellow

MIN_SLOPE = 0.2          # ignore lines flatter than this
CLUSTER_PX = 60          # px, segments landing this close at the bottom = same line
VP_MARGIN = 60           # px, how far past the ROI top edge a line's top may land

VP = (0.47, 0.775)       # vanishing point (x, y), from vision/README.md
VP_SIGMA = 0.06          # how fast vp_score drops as a line misses the vanishing point
ROWS = [1.0, 0.95, 0.9, 0.86, 0.83]   # heights to report x at, bottom first
MIN_COVERAGE = 0.15      # lines with less real paint than this are dropped
STRIPE_MIN = 0.3         # a stripe must be at least 30% of the expected paint width
STRIPE_MAX = 2.0         # ...and at most 2x (anything wider is a curb, car, or blob)
FLANK = 1.0              # how far beside a stripe to look for "bare road" (x stripe width)
FLANK_MAX = 0.25         # more paint than this beside a stripe = text/arrow/curb, skip it
CURVE_GAIN = 0.7         # use a curved fit only if it cuts the error by 30%+
FIT_SKIP_TOP = 0.2       # ignore the top 20% of the search area when fitting lines
MIN_SPAN = 0.4           # line paint must stretch over 40% of the fitted area
HOUGH_THRESHOLD = 15     # lower = finds fainter/shorter dashes (cleanup removes extras)
MIN_LANE_WIDTH = 0.12    # two lines closer than this (0-1 scale, bottom of ROI) = duplicate
LANE_WIDTH_RATIO = 0.6   # a lane narrower than 60% of the typical lane = fake line
YELLOW_FRACTION = 0.3    # share of a line that must sit on yellow paint to call it yellow
YELLOW_ANCHOR = True     # drop lines left of the yellow edge line (not part of our roadway)

# README formula counts gaps between dashes as missing paint, so a perfect dashed
# line can never pass. With this on, dashed coverage is judged against how much
# paint a dashed line should have. Team decision: set False to match README exactly.
DASHED_COVERAGE_FIX = True

# Mapbox numbers lanes from the road's left edge. On SR 70 the camera can't see
# that edge, so counting from the right (demo_route "laneSide") may be what the
# bake does. TEAM DECISION: must match the bake. False = count from the left.
COUNT_FROM_LANESIDE = False
CAMERA_X = 0.47          # where the car is, left to right, at the bottom of the photo
DASH_DUTY = 0.3          # rough share of a dashed line that is actually painted
METHOD = "opencv-hough-v4"
# -------------------------------------------------------------------------------------

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools"))
from clip import DEFAULT_CLIP, Clip  # noqa: E402


def build_masks(img, s):
    """Return (white, yellow) masks of likely lane paint."""
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    k = max(3, int(TOPHAT_SIZE * s))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, 1))
    tophat = cv2.morphologyEx(gray, cv2.MORPH_TOPHAT, kernel)
    white = cv2.inRange(tophat, WHITE_THRESH, 255)

    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    yellow = cv2.inRange(lab[:, :, 2], YELLOW_B, 255)
    yellow[:, w // 2:] = 0  # the yellow line is always on the left
    return white, yellow


def roi_mask(h, w):
    y_top, y_bot = int(ROI_TOP * h), int(ROI_BOTTOM * h)
    poly = np.array([[
        (int(ROI_BOTTOM_LEFT * w), y_bot),
        (int(ROI_TOP_LEFT * w), y_top),
        (int(ROI_TOP_RIGHT * w), y_top),
        (int(ROI_BOTTOM_RIGHT * w), y_bot),
    ]], dtype=np.int32)
    mask = np.zeros((h, w), dtype=np.uint8)
    cv2.fillPoly(mask, poly, 255)
    return mask, poly, y_top, y_bot


def find_segments(paint, roi, y_top, y_bot, w, s, color):
    """Hough line segments that slant like lane lines and point at the horizon."""
    edges = cv2.Canny(cv2.GaussianBlur(paint, (5, 5), 0), 50, 150)
    edges = cv2.bitwise_and(edges, roi)
    lines = cv2.HoughLinesP(edges, rho=1, theta=np.pi / 180, threshold=HOUGH_THRESHOLD,
                            minLineLength=max(10, int(20 * s)),
                            maxLineGap=max(20, int(150 * s)))
    if lines is None:
        return []

    lo = ROI_TOP_LEFT * w - VP_MARGIN * s
    hi = ROI_TOP_RIGHT * w + VP_MARGIN * s
    out = []
    for x1, y1, x2, y2 in lines.reshape(-1, 4).tolist():
        if x1 == x2:
            xb = xt = float(x1)
        else:
            slope = (y2 - y1) / (x2 - x1)
            if abs(slope) < MIN_SLOPE:
                continue
            xb = x1 + (y_bot - y1) / slope
            xt = x1 + (y_top - y1) / slope
        if not (lo <= xt <= hi):
            continue
        out.append((xb, xt, color))
    return out


def cluster(segments, s):
    """Group segments that land in the same spot at the bottom into one line."""
    segments = sorted(segments)
    groups = []
    for seg in segments:
        if groups and seg[0] - groups[-1][-1][0] < CLUSTER_PX * s:
            groups[-1].append(seg)
        else:
            groups.append([seg])

    result = []
    for g in groups:
        colors = [c for _, _, c in g]
        result.append({
            "xb": float(np.mean([x for x, _, _ in g])),
            "xt": float(np.mean([x for _, x, _ in g])),
            "color": max(set(colors), key=colors.count),
            "segments": len(g),
        })
    return result


def robust_fit(ys, xs, deg, s):
    """
    Fit x = poly(y) while ignoring stray points (a curb, a crack, the next
    stripe over). Repeatedly fits, measures how far points sit from the fit,
    and throws out the ones that are clearly off. Returns (coefficients,
    rms of the kept points, mask of kept points).
    """
    keep = np.ones(len(ys), bool)
    for _ in range(5):
        coef = np.polyfit(ys[keep], xs[keep], deg)
        res = xs - np.polyval(coef, ys)
        r = res[keep]
        mad = np.median(np.abs(r - np.median(r)))
        new_keep = np.abs(res) <= max(3.0 * s, 2.5 * 1.4826 * mad)
        if new_keep.sum() < 5 or (new_keep == keep).all():
            break
        keep = new_keep
    coef = np.polyfit(ys[keep], xs[keep], deg)
    rms = float(np.sqrt(np.mean((xs[keep] - np.polyval(coef, ys[keep])) ** 2)))
    return coef, rms, keep


def refit(group, masks, y_top, y_bot, h, w, s):
    """
    Walk down the rough line row by row, find the center of the paint near it,
    and fit a clean line (or a gentle curve) through those centers. Also
    measures coverage and whether the line is solid or dashed.
    """
    mask = masks["paint"]
    a0 = (group["xb"] - group["xt"]) / (y_bot - y_top)
    b0 = group["xb"] - a0 * y_bot
    step = max(2, h // 230)
    band_top = int(ROWS[-1] * h)
    vp_y = VP[1] * h

    ys, xs, band_rows = [], [], []
    # skip the rows right under the horizon, where all lines squeeze together
    y_start = int(y_top + FIT_SKIP_TOP * (y_bot - y_top))
    for y in range(y_start, y_bot, step):
        if y >= band_top:
            band_rows.append(y)
        xp = a0 * y + b0
        frac = (y - y_top) / (y_bot - y_top)
        win = int(s * (10 + 40 * frac))
        # a real stripe is about this wide here (lines look thinner far away)
        depth = max(0.0, (y - vp_y) / (h - vp_y))
        expected = s * (3 + 32 * depth)
        lo, hi = STRIPE_MIN * expected, STRIPE_MAX * expected
        x0, x1 = max(0, int(xp) - win), min(w, int(xp) + win + 1)
        if x1 - x0 <= 1:
            continue
        row = np.concatenate(([0], (mask[y, x0:x1] > 0).astype(np.int8), [0]))
        edges = np.diff(row)
        best = None
        gap = max(2, int(FLANK * expected))
        for st, en in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)):
            if lo <= en - st <= hi:
                # a painted lane stripe has bare road on both sides of it;
                # letters, arrows, curbs and hatching have more paint right next to them
                a_st, a_en = x0 + st, x0 + en
                left = mask[y, max(0, a_st - gap):a_st]
                right = mask[y, a_en:min(w, a_en + gap)]
                flank = np.concatenate((left, right))
                if flank.size and (flank > 0).mean() > FLANK_MAX:
                    continue
                c = x0 + (st + en - 1) / 2
                if best is None or abs(c - xp) < abs(best - xp):
                    best = c
        if best is not None:
            ys.append(y)
            xs.append(best)

    if len(ys) < 5:
        return None
    ys, xs = np.array(ys, float), np.array(xs, float)

    # straight fit first; it's also what we use to check the vanishing point
    lin, rms, keep = robust_fit(ys, xs, 1, s)
    poly = lin
    # ramps curve, so try a gentle curve and keep it if it fits clearly better
    if keep.sum() >= 12:
        quad, rms_q, keep_q = robust_fit(ys, xs, 2, s)
        if rms_q < CURVE_GAIN * rms and keep_q.sum() >= 0.9 * keep.sum():
            poly, rms, keep = quad, rms_q, keep_q

    ys_in = ys[keep]
    # real lane lines run a long way down the road; words and arrows don't
    if len(ys_in) < 5 or (ys_in.max() - ys_in.min()) < MIN_SPAN * (y_bot - y_start):
        return None

    # coverage only counts rows where the paint really sits on the fitted line
    inlier_rows = set(ys_in.astype(int).tolist())
    hits = [y in inlier_rows for y in band_rows]
    coverage = float(np.mean(hits)) if hits else 0.0
    runs = sum(1 for i, hit in enumerate(hits) if hit and (i == 0 or not hits[i - 1]))
    line_type = "dashed" if runs >= 2 and coverage < 0.85 else "solid"

    # color: what fraction of the fitted line sits on yellow paint?
    yellow_hits = 0
    for y in ys_in.astype(int):
        xc = int(np.polyval(poly, y))
        x0, x1 = max(0, xc - int(8 * s)), min(w, xc + int(8 * s) + 1)
        if x1 > x0 and masks["yellow"][y, x0:x1].any():
            yellow_hits += 1
    color = "yellow" if yellow_hits / len(ys_in) >= YELLOW_FRACTION else "white"

    return {
        "a": float(lin[0]), "b": float(lin[1]),   # straight version
        "poly": [float(c) for c in poly],        # what we report (may curve)
        "rms_px": rms / s,           # in 2048-wide pixels, so scores match the README
        "coverage": coverage,
        "ymax": float(ys_in.max()),
        "color": color,
        "type": line_type,
        "segments": group["segments"],
    }


def line_confidence(fit, w, h):
    fit_score = math.exp(-fit["rms_px"] / 4)
    coverage = fit["coverage"]
    if DASHED_COVERAGE_FIX and fit["type"] == "dashed":
        coverage = min(1.0, coverage / DASH_DUTY)
    x_at_vp = (fit["a"] * VP[1] * h + fit["b"]) / w
    vp_score = math.exp(-0.5 * ((x_at_vp - VP[0]) / VP_SIGMA) ** 2)
    return fit_score * coverage * vp_score


def sample_rows(fit, w, h):
    """x (0-1) of the line at each row in ROWS; None if unknown or a long guess."""
    xs = []
    for r in ROWS:
        y = r * h
        if y > fit["ymax"] + 0.10 * h:   # too far below any real detection
            xs.append(None)
            continue
        x = x_at(fit, y, w)
        xs.append(round(x, 3) if -0.1 <= x <= 1.1 else None)
    return xs


def x_at(fit, y, w):
    return float(np.polyval(fit["poly"], y)) / w


def clean_up(fits, h, w):
    """
    Remove lines that can't be real lane boundaries:
      1. anything left of the yellow edge line (it's not our roadway)
      2. the weaker of two lines that cross or sit closer than a lane width
    Returns (kept fits, number dropped).
    """
    start = len(fits)
    if YELLOW_ANCHOR:
        yellows = [i for i, f in enumerate(fits) if f["color"] == "yellow"]
        if yellows:
            anchor = max(yellows, key=lambda i: fits[i]["conf"])
            fits = fits[anchor:]

    y_bot, y_mid = ROI_BOTTOM * h, ROWS[-1] * h
    changed = True
    while changed and len(fits) > 1:
        changed = False
        gaps = [x_at(r, y_bot, w) - x_at(l, y_bot, w) for l, r in zip(fits, fits[1:])]
        # lanes on the same road are about the same width, so a gap much
        # narrower than the typical one means one of its two lines is fake
        typical = float(np.median(gaps)) if len(gaps) >= 2 else None
        for i, gap_bot in enumerate(gaps):
            left, right = fits[i], fits[i + 1]
            gap_mid = x_at(right, y_mid, w) - x_at(left, y_mid, w)
            too_narrow = typical is not None and gap_bot < LANE_WIDTH_RATIO * typical
            if gap_bot < MIN_LANE_WIDTH or gap_mid <= 0 or too_narrow:
                del fits[pick_fake(fits, i, y_bot, w)]
                changed = True
                break
    return fits, start - len(fits)


def pick_fake(fits, i, y_bot, w):
    """
    Lines i and i+1 can't both be real. Keep whichever leaves the lanes most
    even in width (real lanes are about the same width). If that doesn't
    settle it, drop the one with lower confidence.
    """
    def spread(lines):
        xs = [x_at(f, y_bot, w) for f in lines]
        gaps = [b - a for a, b in zip(xs, xs[1:])]
        return float(np.std(gaps)) if len(gaps) >= 2 else None

    without_left = spread(fits[:i] + fits[i + 1:])
    without_right = spread(fits[:i + 1] + fits[i + 2:])
    if without_left is not None and without_right is not None \
            and abs(without_left - without_right) > 0.02:
        return i if without_left < without_right else i + 1
    return i if fits[i]["conf"] < fits[i + 1]["conf"] else i + 1


def sanity(boundaries):
    """1 if the lines make physical sense, else 0 (with a reason)."""
    for left, right in zip(boundaries, boundaries[1:]):
        common = [j for j in range(len(ROWS))
                  if left["x"][j] is not None and right["x"][j] is not None]
        if not common:
            continue
        widths = [right["x"][j] - left["x"][j] for j in common]
        if any(wd <= 0 for wd in widths):
            return 0, "lines cross"
        if not (0.15 <= widths[0] <= 0.6):
            return 0, f"lane width {widths[0]:.2f} at bottom is out of range"
        if len(widths) > 1 and widths[-1] >= widths[0]:
            return 0, "lane does not narrow toward the horizon"
    return 1, None


def process_frame(img, frame, route_key):
    h, w = img.shape[:2]
    s = w / 2048
    white, yellow = build_masks(img, s)
    roi, _, y_top, y_bot = roi_mask(h, w)

    segments = (find_segments(white, roi, y_top, y_bot, w, s, "white")
                + find_segments(yellow, roi, y_top, y_bot, w, s, "yellow"))
    masks = {"yellow": yellow, "paint": cv2.bitwise_or(white, yellow)}

    fits = []
    for group in cluster(segments, s):
        fit = refit(group, masks, y_top, y_bot, h, w, s)
        if fit and fit["coverage"] >= MIN_COVERAGE:
            fits.append(fit)
    fits.sort(key=lambda f: x_at(f, h, w))  # left to right at the bottom row
    for fit in fits:
        fit["conf"] = line_confidence(fit, w, h)
    fits, dropped = clean_up(fits, h, w)

    boundaries = []
    for fit in fits:
        boundaries.append({
            "x": sample_rows(fit, w, h),
            "type": fit["type"],
            "color": fit["color"],
            "confidence": round(fit["conf"], 3),
        })

    # ----- frame confidence, per vision/README.md -----
    debug = {"segments": len(segments), "route": route_key}
    if dropped:
        debug["dropped"] = dropped
    nav = (frame.get("nav") or {}).get(route_key) or {}
    lanes, pref = nav.get("lanes"), nav.get("preferredLane")

    if not boundaries:
        conf = 0.0
        debug["reason"] = "no lines found"
    else:
        san, why = sanity(boundaries)
        if why:
            debug["reason"] = why
        if lanes and pref is not None:
            n = len(boundaries)
            count_factor = min(1.0, n / (len(lanes) + 1))

            # which side lane numbers are counted from (see COUNT_FROM_LANESIDE)
            side = "left"
            if COUNT_FROM_LANESIDE and nav.get("laneSide") == "right":
                side = "right"
            if side == "left":
                li = pref
            else:
                li = n - 2 - (len(lanes) - 1 - pref)
            debug["countedFrom"] = side

            # lane numbers only line up if we can see a line on the counting
            # side of the car. If every line is to the car's right (or left),
            # we've missed lines, so the numbering is almost surely shifted.
            bottoms = [x_at(f, h, w) for f in fits]
            anchor_seen = (min(bottoms) < CAMERA_X) if side == "left" else (max(bottoms) > CAMERA_X)

            if not anchor_seen:
                target = 0.0
                debug.setdefault("reason", f"no line found {side} of the car, lane numbers unreliable")
            elif 0 <= li and li + 1 < n:
                target = min(boundaries[li]["confidence"], boundaries[li + 1]["confidence"])
            else:
                target = 0.0
                debug.setdefault("reason", f"lines for target lane {pref} not found")
        else:
            count_factor = 1.0
            target = min(b["confidence"] for b in boundaries)
            debug["note"] = "no Mapbox lane data for this frame"
        conf = target * san * count_factor

    entry = {"confidence": round(conf, 3), "boundaries": boundaries, "debug": debug}
    return entry, fits


def draw_debug(img, fits, entry, path):
    h, w = img.shape[:2]
    out = img.copy()
    _, poly, _, _ = roi_mask(h, w)
    cv2.polylines(out, poly, True, (255, 0, 0), 3)
    for fit, b in zip(fits, entry["boundaries"]):
        y0, y1 = int(ROWS[-1] * h), h - 1
        pts = np.array([(int(np.polyval(fit["poly"], y)), y)
                        for y in range(y0, y1 + 1, 4)], dtype=np.int32)
        p0 = tuple(pts[0])
        color = (0, 215, 255) if b["color"] == "yellow" else (0, 0, 255)
        cv2.polylines(out, [pts], False, color, 6)
        cv2.putText(out, f'{b["type"]} {b["confidence"]:.2f}', (p0[0] - 60, y0 - 15),
                    cv2.FONT_HERSHEY_SIMPLEX, 1, color, 3)
    label = f'lines: {len(fits)}  frame conf: {entry["confidence"]:.2f}'
    reason = entry["debug"].get("reason")
    cv2.putText(out, label, (40, 80), cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 0, 255), 4)
    if reason:
        cv2.putText(out, reason, (40, 150), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (0, 0, 255), 3)
    cv2.imwrite(str(path), out)


def find_image(frame_id, dirs):
    for d in dirs:
        p = d / f"{frame_id}.jpg"
        if p.exists():
            return p
    return None


def main():
    parser = argparse.ArgumentParser(description="Detect painted lane lines for every demo frame.")
    parser.add_argument("--clip", default=DEFAULT_CLIP, help=f"clip folder under clips/ (default {DEFAULT_CLIP}); "
                        "sets the defaults below and the vanishing point from its clip.json")
    parser.add_argument("--route-file", type=Path, help="baked clip JSON (default: the clip's demo.json)")
    parser.add_argument("--images", type=Path, help="folder of <frame id>.jpg images")
    parser.add_argument("--out", type=Path, help="output (default: clips/<clip>/detected_lanes.json)")
    parser.add_argument("--route", help="north or south (default: primaryRoute)")
    parser.add_argument("--debug", action="store_true", help="save overlay images to vision_debug/")
    args = parser.parse_args()
    global VP
    clip = Clip(args.clip)
    VP = clip.vanishing_point
    args.route_file = args.route_file or clip.demo
    args.out = args.out or clip.detected

    demo = json.loads(args.route_file.read_text())
    route_key = args.route or demo.get("primaryRoute") or "north"
    frames = demo["frames"]

    image_dirs = [d.expanduser() for d in [
        args.images,
        clip.public_images,
        Path("~/turnpike/data/images"),
    ] if d is not None]

    debug_dir = REPO / "vision_debug"
    if args.debug:
        debug_dir.mkdir(exist_ok=True)

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
        path = find_image(fid, image_dirs)
        if path is None:
            print(f"  [{i:2d}/{len(frames)}] {fid}  SKIPPED (image not found)")
            continue
        img = cv2.imread(str(path))
        if img is None:
            print(f"  [{i:2d}/{len(frames)}] {fid}  SKIPPED (could not read image)")
            continue

        if result["imageSize"] is None:
            result["imageSize"] = [img.shape[1], img.shape[0]]

        entry, fits = process_frame(img, frame, route_key)
        result["frames"][fid] = entry

        if args.debug:
            draw_debug(img, fits, entry, debug_dir / f"{i:03d}_{fid}.jpg")

        reason = entry["debug"].get("reason", "")
        print(f"  [{i:2d}/{len(frames)}] {fid}  lines: {len(entry['boundaries'])}  "
              f"conf: {entry['confidence']:.2f}  {reason}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2))
    done = len(result["frames"])
    good = sum(1 for f in result["frames"].values() if f["confidence"] >= 0.6)
    print(f"\nWrote {args.out}  ({done} frames, {good} with confidence >= 0.6)")
    if args.debug:
        print(f"Debug images in {debug_dir}")


if __name__ == "__main__":
    main()
