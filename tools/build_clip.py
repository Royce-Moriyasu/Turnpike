"""Build a clip end to end: bake -> YOLOPv2 masks -> YOLOPv2 lanes -> (OpenCV lanes) -> bake again.

    .venv/Scripts/python.exe tools/build_clip.py sr70           # one clip
    .venv/Scripts/python.exe tools/build_clip.py --all          # every clip under clips/
    .venv/Scripts/python.exe tools/build_clip.py sr70 --opencv  # also re-run the OpenCV detector
    .venv/Scripts/python.exe tools/build_clip.py sr70 --bake-only

The first bake places the photos on the route and writes the clip's demo.json and images, which the
detectors read (their confidence uses the Mapbox target lane). The second bake picks up the lanes they
wrote. Adding a clip = a folder clips/<name>/ with clip.json, frames.json and images/ (clips/README.md).
"""

import argparse
import subprocess
import sys
import time
from pathlib import Path

from clip import REPO, Clip, all_clips

PY = sys.executable


def run(step: str, *args: str) -> None:
    print(f"\n=== {step}")
    started = time.time()
    result = subprocess.run([PY, *args], cwd=REPO)
    if result.returncode:
        sys.exit(f"'{step}' failed (exit {result.returncode})")
    print(f"--- {step}: {time.time() - started:.1f}s")


def build(name: str, opencv: bool, bake_only: bool, refresh: bool) -> None:
    clip = Clip(name)
    print(f"\n######## {clip.name}: {clip.title}")
    bake = ["bake/bake_route.py", "--clip", name] + (["--refresh"] if refresh else [])
    run("bake (frames + navigation)", *bake)
    if bake_only:
        return
    run("YOLOPv2 masks", "vision/yolop_masks.py", "--clip", name)
    run("YOLOPv2 lanes", "vision/yolop_lanes.py", "--clip", name)
    if opencv:
        run("OpenCV lanes", "vision/detect_lanes.py", "--clip", name)
    run("bake (with lanes)", "bake/bake_route.py", "--clip", name)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("clips", nargs="*", help=f"clip names (available: {', '.join(all_clips())})")
    ap.add_argument("--all", action="store_true", help="build every clip")
    ap.add_argument("--opencv", action="store_true", help="also run the OpenCV detector (vision/detect_lanes.py)")
    ap.add_argument("--bake-only", action="store_true", help="only bake (no detectors)")
    ap.add_argument("--refresh", action="store_true", help="re-fetch Mapbox routes")
    args = ap.parse_args()
    names = all_clips() if args.all else args.clips
    if not names:
        ap.error("name a clip or pass --all")
    for name in names:
        build(name, args.opencv, args.bake_only, args.refresh)
    print(f"\nDone: {', '.join(names)}. Refresh the app.")


if __name__ == "__main__":
    main()
