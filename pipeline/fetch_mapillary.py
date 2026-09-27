import json
import os
import sys
import time
from pathlib import Path

import requests

TOKEN = os.environ.get("MAPILLARY_TOKEN", "").strip()
API = "https://graph.mapillary.com"

FIELDS = ",".join([
    "id",
    "computed_geometry",
    "geometry",
    "computed_compass_angle",
    "compass_angle",
    "captured_at",
    "thumb_2048_url",
])

# Writes a clip folder: clips/<clip>/frames.json + images/ (see tools/clip.py). "file" paths in
# frames.json are relative to that folder.
REPO = Path(__file__).resolve().parent.parent
OUT_DIR = None  # set in main from the clip name
IMG_DIR = None


def api_get(url, params=None):
    params = dict(params or {})
    params["access_token"] = TOKEN
    response = requests.get(url, params=params, timeout=30)
    response.raise_for_status()
    return response.json()


def main():
    if not TOKEN:
        sys.exit("MAPILLARY_TOKEN is not set. Set it in your terminal first.")
    if len(sys.argv) != 3:
        sys.exit("Usage: python3 pipeline/fetch_mapillary.py <image_id> <clip name>   "
                 "(writes clips/<clip>/frames.json + images/; add a clip.json there to bake it)")

    global OUT_DIR, IMG_DIR
    start_image_id, clip_name = sys.argv[1], sys.argv[2]
    OUT_DIR = REPO / "clips" / clip_name
    IMG_DIR = OUT_DIR / "images"

    sequence_id = api_get(f"{API}/{start_image_id}", {"fields": "sequence"})["sequence"]
    print(f"Sequence ID: {sequence_id}")

    listing = api_get(f"{API}/image_ids", {"sequence_id": sequence_id})
    image_ids = [item["id"] for item in listing["data"]]
    print(f"Found {len(image_ids)} frames. Downloading...")

    IMG_DIR.mkdir(parents=True, exist_ok=True)
    frames = []

    for i, image_id in enumerate(image_ids, start=1):
        try:
            meta = api_get(f"{API}/{image_id}", {"fields": FIELDS})

            geometry = meta.get("computed_geometry") or meta.get("geometry")
            angle = meta.get("computed_compass_angle", meta.get("compass_angle"))
            lon, lat = geometry["coordinates"]

            image_path = IMG_DIR / f"{image_id}.jpg"
            if not image_path.exists():
                picture = requests.get(meta["thumb_2048_url"], timeout=60)
                picture.raise_for_status()
                image_path.write_bytes(picture.content)

            frames.append({
                "image_id": image_id,
                "lat": lat,
                "lon": lon,
                "compass_angle": angle,
                "captured_at": meta["captured_at"],
                "file": f"images/{image_id}.jpg",
            })
            print(f"  [{i}/{len(image_ids)}] {image_id} ok")

        except Exception as error:
            print(f"  [{i}/{len(image_ids)}] {image_id} skipped: {error}")

        time.sleep(0.1)

    frames.sort(key=lambda frame: frame["captured_at"])

    output = {"sequence_id": sequence_id, "frame_count": len(frames), "frames": frames}
    (OUT_DIR / "frames.json").write_text(json.dumps(output, indent=2))
    print(f"\nDone. Saved {len(frames)} frames to {OUT_DIR}/")


if __name__ == "__main__":
    main()
