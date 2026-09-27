"""Where a clip's files live. Every script goes through this instead of hard-coding paths.

A clip is one drive: a folder clips/<name>/ with

    clip.json            route(s) and camera (see clips/README.md)
    frames.json          photo manifest: image_id, lat, lon, compass_angle, captured_at, file
    images/              the photos (frames.json "file" paths are relative to the clip folder)
    labels.json          hand-traced lanes (labeling tool), optional
    mapbox_<route>.json  cached Mapbox Directions responses (fetched by the bake if missing)
    detected_lanes.json  OpenCV lanes (vision/detect_lanes.py)
    yolop_lanes.json     YOLOPv2 lanes (vision/yolop_lanes.py)
    _build/              generated scratch (YOLOPv2 masks); git-ignored

and the app reads what the bake writes to frontend/public/clips/<name>/ (demo.json + images/).
"""

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CLIPS = REPO / "clips"
PUBLIC_CLIPS = REPO / "frontend" / "public" / "clips"
DEFAULT_CLIP = "sr70"


class Clip:
    def __init__(self, name: str):
        self.name = name
        self.root = CLIPS / name
        path = self.root / "clip.json"
        if not path.exists():
            sys.exit(f"No clip '{name}': expected {path.relative_to(REPO)}. Clips: {', '.join(all_clips()) or 'none'}")
        self.config = json.loads(path.read_text(encoding="utf-8"))

    # ---- inputs (clips/<name>/)
    @property
    def title(self) -> str:
        return self.config.get("title", self.name)

    @property
    def frames(self) -> Path:
        return self.root / "frames.json"

    @property
    def images(self) -> Path:
        return self.root / "images"

    @property
    def labels(self) -> Path:
        return self.root / "labels.json"

    @property
    def detected(self) -> Path:
        return self.root / "detected_lanes.json"

    @property
    def yolop_lanes(self) -> Path:
        return self.root / "yolop_lanes.json"

    def mapbox(self, route: str) -> Path:
        return self.root / f"mapbox_{route}.json"

    def masks(self, view: str, kind: str) -> Path:
        """YOLOPv2 masks: kind is 'lane' or 'drivable'."""
        return self.root / "_build" / "yolop" / view / kind

    # ---- camera
    @property
    def vanishing_point(self) -> tuple[float, float]:
        """Where lane lines meet, as fractions of the image (x, y). y is the horizon."""
        vp = self.config.get("camera", {}).get("vanishingPoint", [0.5, 0.5])
        return float(vp[0]), float(vp[1])

    @property
    def horizon(self) -> float:
        return self.vanishing_point[1]

    # ---- outputs (frontend/public/clips/<name>/)
    @property
    def public(self) -> Path:
        return PUBLIC_CLIPS / self.name

    @property
    def demo(self) -> Path:
        return self.public / "demo.json"

    @property
    def public_images(self) -> Path:
        return self.public / "images"

    @property
    def images_url(self) -> str:
        return f"/clips/{self.name}/images"


def all_clips() -> list[str]:
    return sorted(p.parent.name for p in CLIPS.glob("*/clip.json"))


def write_index() -> Path:
    """frontend/public/clips/index.json: the baked clips the app can switch between."""
    entries = []
    for name in all_clips():
        clip = Clip(name)
        if clip.demo.exists():
            frames = len(json.loads(clip.demo.read_text(encoding="utf-8"))["frames"])
            entries.append({"name": name, "title": clip.title, "frames": frames})
    PUBLIC_CLIPS.mkdir(parents=True, exist_ok=True)
    out = PUBLIC_CLIPS / "index.json"
    out.write_text(json.dumps({"default": DEFAULT_CLIP, "clips": entries}, indent=1), encoding="utf-8")
    return out
