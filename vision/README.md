# Vision output format

The OpenCV pipeline writes `data/detected_lanes.json`. It reports **where the painted lane lines are**,
and nothing else. It never decides which lane is correct: the bake combines this with Mapbox lane data.

See [`detected_lanes.example.json`](detected_lanes.example.json) for a full example using real frames.

## Coordinates

- Normalized to the image: `x` 0 = left edge, 1 = right edge; `y` 0 = top, 1 = bottom.
- The horizon in this clip is at y ≈ 0.775, so all rows sit below it.

## Structure

```jsonc
{
  "version": 1,
  "method": "opencv-hough-v1",   // free text, shown in the UI
  "imageSize": [2048, 1152],     // pixels, for reference
  "rows": [1.0, 0.95, 0.9, 0.86, 0.83],   // heights every line is sampled at, bottom first
  "frames": {
    "<frame id>": {              // Mapillary image id, same as demo_route.json
      "confidence": 0.86,        // 0–1, can we trust this frame's lines?
      "boundaries": [            // painted lines, sorted LEFT -> RIGHT by x at the bottom row
        { "x": [...], "type": "solid|dashed", "color": "white|yellow", "confidence": 0.92 }
      ],
      "debug": { }               // optional, anything useful; ignored by the bake
    }
  }
}
```

`boundaries[i].x[j]` is the x of **line i** at height **`rows[j]`**.

## Rules

1. **Sort boundaries left to right** by their x at the bottom row (use the lowest non-null row).
2. **Lane i is the space between `boundaries[i]` and `boundaries[i + 1]`.** N lines give N−1 lanes.
3. **`null`** means the line isn't known at that row (occluded, too close to the horizon, not detected).
4. **x may be slightly outside 0–1** when a reliable fit runs off the edge of the frame (e.g. `1.03`).
   Use `null` instead if the value is a long extrapolation.
5. **Every frame the pipeline ran on gets an entry**, even a bad one, with a low `confidence`.
   A missing frame means "not processed".

## Confidence

Per line: `fit_score * coverage * vp_score`

- `fit_score = exp(-rms_px / 4)`: how tightly the detected points fit the line
- `coverage`: fraction of the row span with real detections (not extrapolated)
- `vp_score`: does the line, extended upward, pass near the vanishing point (≈ 0.47, 0.775)?

Per frame: `min(line conf of the target lane's two lines) * sanity * count_factor`

- `sanity` is 0 if lines cross, lane widths at the bottom row are outside ~0.15–0.6, or widths
  don't shrink toward the horizon; otherwise 1
- `count_factor` = lines found ÷ lines expected (Mapbox lane count + 1), capped at 1
- The target lane is `preferredLane` in `frontend/public/demo_route.json`

The bake uses a frame's lines when `confidence` ≥ the threshold (start at 0.6, calibrate against
the hand-labeled frames), otherwise it falls back to hand labels.

## The three example frames

| Frame | What it shows |
|---|---|
| `337539458390495` | Ramp fork with NORTH/SOUTH painted: 3 lines, 2 lanes, high confidence. Right edge curves and runs slightly off-frame (`1.03`). |
| `172160751802378` | Crossroads Pkwy signal: 4 lines, 3 visible lanes of Mapbox's 5. Leftmost line is hidden by cars in the bottom rows (`null`), rightmost runs off-frame. |
| `132173049325117` | Start of the ramp: only 1 line found, so confidence is low and the bake falls back. |

The x values in the example are traced approximately from the images; they show the format, not
ground truth.
