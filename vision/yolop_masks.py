"""
yolop_masks.py

Runs YOLOPv2 (pretrained on BDD100K, no training; see vision/weights/README.md) on every demo frame
and saves two per-pixel probability masks for the OpenCV pipeline:

    data/yolop/<view>/lane/<frame id>.png       lane-line paint, 0-255
    data/yolop/<view>/drivable/<frame id>.png   drivable road, 0-255

Masks are full image size (2048x1152) and pixel-aligned with the frame, so detect_lanes.py can use
them next to (or instead of) its own paint mask. Threshold at 128 for a yes/no mask.

Views: a region of the frame, resized to the model's 640x384 input and the masks resized back:
    band   (default) full width, from 55% down: puts the horizon (~77.5% down in this clip) in the
           middle of the input like the BDD100K training footage. Stretches the image vertically;
           without this the model sees the road squashed into the bottom rows and hallucinates
           horizontal lane bands.
    full   the whole frame (horizon near the bottom: expect bad lane masks)
    road   lower-middle 75% of the frame (horizon still low)

Usage (from the repo root):
    .venv/Scripts/python.exe vision/yolop_masks.py                          # all frames, band view
    .venv/Scripts/python.exe vision/yolop_masks.py --overlay --frames 22,25,26,40
    .venv/Scripts/python.exe vision/yolop_masks.py --view both --overlay     # compare views

--frames takes UI frame numbers (1-based, as shown in the app). --overlay writes
vision_debug/yolop/<view>/<n>_<id>.jpg: green = drivable, red = lane lines.
"""

import argparse
import json
import time
import warnings
from pathlib import Path

import cv2
import numpy as np
import torch

REPO = Path(__file__).resolve().parent.parent
WEIGHTS = REPO / "vision/weights/yolopv2.pt"
ROUTE = REPO / "frontend/public/demo_route.json"
IMAGES = REPO / "frontend/public/route"
OUT = REPO / "data/yolop"
DEBUG = REPO / "vision_debug/yolop"


MODEL_W, MODEL_H = 640, 384   # the input size the TorchScript model was traced with

# (x0, y0, x1, y1) as fractions of the image.
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
def masks_for(model, img, view):
    """(lane, drivable) probability masks, uint8 0-255, full image size."""
    H, W = img.shape[:2]
    x0, y0, x1, y1 = VIEWS[view]
    X0, Y0, X1, Y1 = int(x0 * W), int(y0 * H), int(x1 * W), int(y1 * H)
    crop = img[Y0:Y1, X0:X1]

    inp = cv2.resize(crop, (MODEL_W, MODEL_H), interpolation=cv2.INTER_AREA)
    tensor = torch.from_numpy(np.ascontiguousarray(inp[:, :, ::-1].transpose(2, 0, 1)))  # BGR->RGB, HWC->CHW
    tensor = tensor.float().div(255.0).unsqueeze(0)

    _, seg, ll = model(tensor)
    # seg: (1, 2, h, w) softmax over [not drivable, drivable]; ll: (1, 1, h, w) lane probability
    drivable = seg[0, 1].numpy()
    lane = ll[0, 0].numpy()

    out = []
    for m in (lane, drivable):
        full = np.zeros((H, W), np.uint8)
        full[Y0:Y1, X0:X1] = cv2.resize((m * 255).clip(0, 255).astype(np.uint8), (X1 - X0, Y1 - Y0),
                                        interpolation=cv2.INTER_LINEAR)
        out.append(full)
    return out


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
    parser.add_argument("--view", choices=[*VIEWS, "both"], default="band")
    parser.add_argument("--frames", help="comma-separated UI frame numbers (1-based); default: all")
    parser.add_argument("--overlay", action="store_true", help="also write overlay images to vision_debug/yolop/")
    parser.add_argument("--weights", type=Path, default=WEIGHTS)
    args = parser.parse_args()

    frames = json.loads(ROUTE.read_text(encoding="utf-8"))["frames"]
    wanted = range(1, len(frames) + 1) if not args.frames else [int(n) for n in args.frames.split(",")]
    views = list(VIEWS) if args.view == "both" else [args.view]
    model = load_model(args.weights)

    for view in views:
        (OUT / view / "lane").mkdir(parents=True, exist_ok=True)
        (OUT / view / "drivable").mkdir(parents=True, exist_ok=True)
        if args.overlay:
            (DEBUG / view).mkdir(parents=True, exist_ok=True)
        print(f"View: {view}")
        started = time.time()
        for n in wanted:
            fid = frames[n - 1]["id"]
            img = cv2.imread(str(IMAGES / f"{fid}.jpg"))
            if img is None:
                print(f"  [{n:2d}] {fid}  SKIPPED (image not found)")
                continue
            lane, drivable = masks_for(model, img, view)
            cv2.imwrite(str(OUT / view / "lane" / f"{fid}.png"), lane)
            cv2.imwrite(str(OUT / view / "drivable" / f"{fid}.png"), drivable)
            if args.overlay:
                cv2.imwrite(str(DEBUG / view / f"{n:02d}_{fid}.jpg"), overlay(img, lane, drivable, view))
            band = slice(int(0.83 * img.shape[0]), img.shape[0])  # the rows the lane format reports
            print(f"  [{n:2d}] {fid}  lane px (road band): {int((lane[band] >= 128).sum()):6d}   "
                  f"drivable (road band): {(drivable[band] >= 128).mean():.0%}")
        print(f"  {len(wanted)} frames in {time.time() - started:.1f}s -> {OUT / view}")
    if args.overlay:
        print(f"Overlays in {DEBUG}")


if __name__ == "__main__":
    main()
