"""
yolop_masks.py

Runs YOLOPv2 (pretrained on BDD100K, no training; see vision/weights/README.md) on every frame of a
baked clip and saves two per-pixel probability masks for vision/yolop_lanes.py:

    clips/<clip>/_build/yolop/<view>/lane/<frame id>.png       lane-line paint, 0-255
    clips/<clip>/_build/yolop/<view>/drivable/<frame id>.png   drivable road, 0-255

Masks are full image size and pixel-aligned with the frame. Threshold at 128 for a yes/no mask.

The same pass decodes YOLOPv2's third output, vehicle boxes (one "vehicle" class: BDD100K's cars,
trucks and buses), and writes them for the band view to clips/<clip>/vehicles.json:
    {"frames": {"<frame id>": [{"box": [x0, y0, x1, y1], "confidence": 0.87}]}}   fractions of the image
The app turns the lane highlight red when one sits in the target lane (DriverView).

Views: a region of the frame, resized to the model's 640x384 input and the masks resized back:
    band   (default) full width, cut so the clip's horizon (clip.json camera.vanishingPoint) sits in
           the middle of the input, like the BDD100K training footage. For a camera pitched down (SR 70:
           horizon ~77.5% down) that's the bottom 45%, stretched; without it the model sees the road
           squashed into the bottom rows and hallucinates horizontal lane bands. For a level dashcam
           (horizon near the middle) it's the whole frame.
    full   the whole frame
    road   lower-middle 75% of the frame

Usage (from the repo root; the clip must be baked first):
    .venv/Scripts/python.exe vision/yolop_masks.py --clip sr70
    .venv/Scripts/python.exe vision/yolop_masks.py --clip sr70 --overlay --frames 22,25,26,40
    .venv/Scripts/python.exe vision/yolop_masks.py --clip sr70 --view both --overlay   # compare views

--frames takes UI frame numbers (1-based, as shown in the app). --overlay writes
vision_debug/yolop/<clip>/<view>/<n>_<id>.jpg: green = drivable, red = lane lines.
"""

import argparse
import json
import sys
import time
import warnings
from pathlib import Path

import cv2
import numpy as np
import torch
import torchvision

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools"))
from clip import DEFAULT_CLIP, Clip  # noqa: E402

WEIGHTS = REPO / "vision/weights/yolopv2.pt"
DEBUG = REPO / "vision_debug/yolop"


MODEL_W, MODEL_H = 640, 384   # the input size the TorchScript model was traced with
STRIDES = (8, 16, 32)         # detection grid strides, as in YOLOPv2's demo (utils.split_for_trace_model)
VEHICLE_CONF = 0.3            # objectness x class score to keep a box (YOLOPv2 demo default)
VEHICLE_IOU = 0.45            # non-maximum suppression overlap (YOLOPv2 demo default)

# (x0, y0, x1, y1) as fractions of the image. "band" is set per clip in main (band_top).
VIEWS = {
    "band": (0.0, 0.55, 1.0, 1.0),
    "full": (0.0, 0.0, 1.0, 1.0),
    "road": (0.125, 0.25, 0.875, 1.0),
}


def load_model(path):
    if not path.exists():
        raise SystemExit(f"Weights not found at {path}. See vision/weights/README.md.")
    # torch warns that TorchScript is deprecated on Python 3.14; it still loads and runs.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FutureWarning)
        return torch.jit.load(str(path), map_location="cpu").eval()


@torch.no_grad()
def band_top(horizon: float) -> float:
    """Top of the band that puts the horizon in the middle of the model's input."""
    return max(0.0, round(2 * horizon - 1, 3))


def decode_vehicles(det, crop):
    """YOLOPv2's detection head -> [{"box": [x0, y0, x1, y1], "confidence"}] as fractions of the full
    image. det is the traced model's [grids, anchor_grid]; crop is the view (x0, y0, x1, y1)."""
    grids, anchor_grid = det
    rows = []
    for i, p in enumerate(grids):
        bs, _, ny, nx = p.shape
        y = p.view(bs, 3, -1, ny, nx).permute(0, 1, 3, 4, 2).sigmoid()
        yv, xv = torch.meshgrid(torch.arange(ny), torch.arange(nx), indexing="ij")
        grid = torch.stack((xv, yv), 2).view(1, 1, ny, nx, 2).float()
        xy = (y[..., 0:2] * 2 - 0.5 + grid) * STRIDES[i]
        wh = (y[..., 2:4] * 2) ** 2 * anchor_grid[i]
        conf = y[..., 4:5] * y[..., 5:].max(-1, keepdim=True).values
        rows.append(torch.cat((xy, wh, conf), -1).reshape(-1, 5))
    b = torch.cat(rows)
    b = b[b[:, 4] >= VEHICLE_CONF]
    xyxy = torch.cat((b[:, :2] - b[:, 2:4] / 2, b[:, :2] + b[:, 2:4] / 2), 1)
    keep = torchvision.ops.nms(xyxy, b[:, 4], VEHICLE_IOU)
    cx0, cy0, cx1, cy1 = crop
    sx, sy = (cx1 - cx0) / MODEL_W, (cy1 - cy0) / MODEL_H
    clamp = lambda v: round(min(1.0, max(0.0, v)), 4)  # noqa: E731
    return [{"box": [clamp(cx0 + a * sx), clamp(cy0 + b_ * sy), clamp(cx0 + c * sx), clamp(cy0 + d * sy)],
             "confidence": round(s, 3)}
            for (a, b_, c, d), s in zip(xyxy[keep].tolist(), b[keep, 4].tolist())]


def masks_for(model, img, view):
    """(lane, drivable) probability masks, uint8 0-255, full image size."""
    lane, drivable, _ = infer(model, img, view)
    return lane, drivable


def infer(model, img, view):
    """(lane, drivable, vehicles): masks_for's masks plus decode_vehicles' boxes."""
    H, W = img.shape[:2]
    x0, y0, x1, y1 = VIEWS[view]
    X0, Y0, X1, Y1 = int(x0 * W), int(y0 * H), int(x1 * W), int(y1 * H)
    crop = img[Y0:Y1, X0:X1]

    inp = cv2.resize(crop, (MODEL_W, MODEL_H), interpolation=cv2.INTER_AREA)
    tensor = torch.from_numpy(np.ascontiguousarray(inp[:, :, ::-1].transpose(2, 0, 1)))  # BGR->RGB, HWC->CHW
    tensor = tensor.float().div(255.0).unsqueeze(0)

    det, seg, ll = model(tensor)
    # seg: (1, 2, h, w) softmax over [not drivable, drivable]; ll: (1, 1, h, w) lane probability
    drivable = seg[0, 1].numpy()
    lane = ll[0, 0].numpy()

    out = []
    for m in (lane, drivable):
        full = np.zeros((H, W), np.uint8)
        full[Y0:Y1, X0:X1] = cv2.resize((m * 255).clip(0, 255).astype(np.uint8), (X1 - X0, Y1 - Y0),
                                        interpolation=cv2.INTER_LINEAR)
        out.append(full)
    return out[0], out[1], decode_vehicles(det, (x0, y0, x1, y1))


def overlay(img, lane, drivable, view):
    out = img.copy()
    green = drivable >= 128
    out[green] = (0.6 * out[green] + 0.4 * np.array([0, 200, 0])).astype(np.uint8)
    out[lane >= 128] = (0, 0, 255)
    H, W = img.shape[:2]
    x0, y0, x1, y1 = VIEWS[view]
    cv2.rectangle(out, (int(x0 * W), int(y0 * H)), (int(x1 * W) - 1, int(y1 * H) - 1), (255, 200, 0), 4)
    return cv2.resize(out, (W // 2, H // 2), interpolation=cv2.INTER_AREA)


def main():
    parser = argparse.ArgumentParser(description="YOLOPv2 lane-line and drivable-area masks for every demo frame.")
    parser.add_argument("--clip", default=DEFAULT_CLIP, help=f"clip folder under clips/ (default {DEFAULT_CLIP})")
    parser.add_argument("--view", choices=[*VIEWS, "both"], default="band")
    parser.add_argument("--frames", help="comma-separated UI frame numbers (1-based); default: all")
    parser.add_argument("--overlay", action="store_true", help="also write overlay images to vision_debug/yolop/<clip>/")
    parser.add_argument("--weights", type=Path, default=WEIGHTS)
    args = parser.parse_args()

    clip = Clip(args.clip)
    if not clip.demo.exists():
        sys.exit(f"{clip.demo.relative_to(REPO)} not found: bake the clip first (bake/bake_route.py --clip {clip.name})")
    frames = json.loads(clip.demo.read_text(encoding="utf-8"))["frames"]
    VIEWS["band"] = (0.0, band_top(clip.horizon), 1.0, 1.0)
    print(f"Clip '{clip.name}': horizon {clip.horizon}, band view from {VIEWS['band'][1]:.0%} down")
    wanted = range(1, len(frames) + 1) if not args.frames else [int(n) for n in args.frames.split(",")]
    views = list(VIEWS) if args.view == "both" else [args.view]
    model = load_model(args.weights)
    vehicles_file = {"version": 1, "method": f"yolopv2-detect conf>={VEHICLE_CONF}", "frames": {}}
    if args.frames and clip.vehicles.exists():  # a partial run updates only those frames
        vehicles_file = json.loads(clip.vehicles.read_text(encoding="utf-8"))

    for view in views:
        clip.masks(view, "lane").mkdir(parents=True, exist_ok=True)
        clip.masks(view, "drivable").mkdir(parents=True, exist_ok=True)
        if args.overlay:
            (DEBUG / clip.name / view).mkdir(parents=True, exist_ok=True)
        print(f"View: {view}")
        started = time.time()
        for n in wanted:
            fid = frames[n - 1]["id"]
            img = cv2.imread(str(clip.public_images / f"{fid}.jpg"))
            if img is None:
                print(f"  [{n:2d}] {fid}  SKIPPED (image not found)")
                continue
            lane, drivable, vehicles = infer(model, img, view)
            if view == "band":
                vehicles_file["frames"][fid] = vehicles
            cv2.imwrite(str(clip.masks(view, "lane") / f"{fid}.png"), lane)
            cv2.imwrite(str(clip.masks(view, "drivable") / f"{fid}.png"), drivable)
            if args.overlay:
                cv2.imwrite(str(DEBUG / clip.name / view / f"{n:02d}_{fid}.jpg"), overlay(img, lane, drivable, view))
            band = slice(int(0.83 * img.shape[0]), img.shape[0])  # the rows the lane format reports
            print(f"  [{n:2d}] {fid}  lane px (road band): {int((lane[band] >= 128).sum()):6d}   "
                  f"drivable (road band): {(drivable[band] >= 128).mean():.0%}   vehicles: {len(vehicles)}")
        print(f"  {len(wanted)} frames in {time.time() - started:.1f}s -> {clip.masks(view, 'lane').parent}")
    if "band" in views:
        clip.vehicles.write_text(json.dumps(vehicles_file, indent=1), encoding="utf-8")
        print(f"Vehicles -> {clip.vehicles.relative_to(REPO)}")
    if args.overlay:
        print(f"Overlays in {DEBUG}")


if __name__ == "__main__":
    main()
