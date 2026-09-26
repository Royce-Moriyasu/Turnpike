import sys
from pathlib import Path

import cv2
import numpy as np

# ---------- Settings you can tune ----------
ROI_TOP = 0.78           # where the search area starts (0 = top of photo, 1 = bottom)
ROI_BOTTOM = 0.97        # stop just above the bottom edge of the photo
ROI_TOP_LEFT = 0.44      # left x of the top edge (fraction of width)
ROI_TOP_RIGHT = 0.54     # right x of the top edge
ROI_BOTTOM_LEFT = 0.17   # left x of the bottom edge
ROI_BOTTOM_RIGHT = 0.95  # right x of the bottom edge

TOPHAT_SIZE = 81         # should be wider than a lane line, in pixels
WHITE_THRESH = 25        # how much brighter than its surroundings paint must be
YELLOW_B = 140           # how yellow a pixel must be (128 = neutral)

MIN_SLOPE = 0.3          # ignore lines flatter than this
CLUSTER_PX = 120         # lines landing within this many pixels = same boundary
VP_MARGIN = 60           # how far past the top edge a line's top may land
# -------------------------------------------

if len(sys.argv) != 2:
    sys.exit("Usage: python3 lane_test.py <path_to_image>")

img = cv2.imread(sys.argv[1])
if img is None:
    sys.exit(f"Couldn't read {sys.argv[1]}")

out = Path("lane_output")
out.mkdir(exist_ok=True)
h, w = img.shape[:2]

# Step 1a: white paint = thin things brighter than their surroundings
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (TOPHAT_SIZE, 1))
tophat = cv2.morphologyEx(gray, cv2.MORPH_TOPHAT, kernel)
white = cv2.inRange(tophat, WHITE_THRESH, 255)
cv2.imwrite(str(out / "1a_white.jpg"), white)

# Step 1b: yellow paint = high "b" value in LAB color
lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
yellow = cv2.inRange(lab[:, :, 2], YELLOW_B, 255)
yellow[:, w // 2:] = 0  # yellow line is always on the left side
cv2.imwrite(str(out / "1b_yellow.jpg"), yellow)

paint = cv2.bitwise_or(white, yellow)
cv2.imwrite(str(out / "1_paint_mask.jpg"), paint)

# Step 2: edges of the paint
edges = cv2.Canny(cv2.GaussianBlur(paint, (5, 5), 0), 50, 150)
cv2.imwrite(str(out / "2_edges.jpg"), edges)

# Step 3: only look at the road ahead
y_top, y_bot = int(ROI_TOP * h), int(ROI_BOTTOM * h)
roi = np.array([[
    (int(ROI_BOTTOM_LEFT * w), y_bot),
    (int(ROI_TOP_LEFT * w), y_top),
    (int(ROI_TOP_RIGHT * w), y_top),
    (int(ROI_BOTTOM_RIGHT * w), y_bot),
]], dtype=np.int32)
mask = np.zeros_like(edges)
cv2.fillPoly(mask, roi, 255)
masked = cv2.bitwise_and(edges, mask)
cv2.imwrite(str(out / "3_masked.jpg"), masked)

# Step 4: find line segments
lines = cv2.HoughLinesP(masked, rho=1, theta=np.pi / 180, threshold=20,
                        minLineLength=20, maxLineGap=150)

debug = img.copy()
cv2.polylines(debug, roi, True, (255, 0, 0), 3)

# Step 5: keep slanted lines and stretch each across the search area
extended = []
if lines is not None:
    for x1, y1, x2, y2 in lines.reshape(-1, 4).tolist():
        if x1 == x2:
            xb, xt = x1, x1
        else:
            slope = (y2 - y1) / (x2 - x1)
            if abs(slope) < MIN_SLOPE:
                continue
            xb = x1 + (y_bot - y1) / slope
            xt = x1 + (y_top - y1) / slope
        if not (ROI_TOP_LEFT * w - VP_MARGIN <= xt <= ROI_TOP_RIGHT * w + VP_MARGIN):
            continue  # doesn't point at the horizon, so not a lane line
        cv2.line(debug, (x1, y1), (x2, y2), (0, 255, 0), 3)
        extended.append((xb, xt))

# Step 6: group lines that land in the same spot into one boundary
extended.sort()
boundaries = []
for xb, xt in extended:
    if boundaries and xb - boundaries[-1][-1][0] < CLUSTER_PX:
        boundaries[-1].append((xb, xt))
    else:
        boundaries.append([(xb, xt)])

result = img.copy()
for group in boundaries:
    xb = int(np.mean([g[0] for g in group]))
    xt = int(np.mean([g[1] for g in group]))
    cv2.line(result, (xb, y_bot), (xt, y_top), (0, 0, 255), 6)

lane_count = max(len(boundaries) - 1, 0)
label = f"Boundaries: {len(boundaries)}  Lanes: {lane_count}"
cv2.putText(result, label, (40, 80), cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 0, 255), 4)

cv2.imwrite(str(out / "4_raw_lines.jpg"), debug)
cv2.imwrite(str(out / "5_boundaries.jpg"), result)
print(label)
