// Hand labels use the same format as the OpenCV output (see vision/README.md), so the bake
// treats them identically. `points` keeps the raw clicks so a frame can be re-edited.

export const ROWS = [1.0, 0.95, 0.9, 0.86, 0.83];
export const IMG_W = 2048;
export const IMG_H = 1152;
// How far past the clicked points a traced line is extended. Covers the whole row range, so two
// clicks anywhere on a (straight) line give it a value at every row.
const MAX_EXTRAPOLATE = 0.2;

export type Pt = [number, number]; // normalized [x, y]

export interface Boundary {
  x: (number | null)[];
  type: "solid" | "dashed";
  color: "white" | "yellow";
  confidence: number;
  points: Pt[];
}

export interface LabelFile {
  version: 1;
  method: string;
  imageSize: [number, number];
  rows: number[];
  frames: Record<string, { confidence: number; boundaries: Boundary[] }>;
}

export const emptyLabelFile = (): LabelFile => ({
  version: 1,
  method: "hand-labeled",
  imageSize: [IMG_W, IMG_H],
  rows: ROWS,
  frames: {},
});

/** x of a traced line at image row y: interpolate between clicks, short linear extrapolation beyond. */
export function xAtRow(points: Pt[], y: number): number | null {
  if (points.length < 2) return null;
  const p = [...points].sort((a, b) => a[1] - b[1]);
  let i = p.findIndex((q) => q[1] >= y);
  if (i === -1) {
    if (y - p[p.length - 1][1] > MAX_EXTRAPOLATE) return null;
    i = p.length - 1;
  } else if (i === 0) {
    if (p[0][1] - y > MAX_EXTRAPOLATE) return null;
    i = 1;
  }
  const [x1, y1] = p[i - 1];
  const [x2, y2] = p[i];
  const x = y2 === y1 ? (x1 + x2) / 2 : x1 + ((y - y1) / (y2 - y1)) * (x2 - x1);
  return +x.toFixed(3);
}

export const withRows = (b: Boundary): Boundary => ({ ...b, x: ROWS.map((r) => xAtRow(b.points, r)) });

export const bottomX = (b: Boundary) =>
  b.x.find((x) => x !== null) ?? (b.points.length ? Math.max(...b.points.map((p) => p[0])) : Infinity);

/** File contents: lines sorted left to right, unfinished lines (< 2 clicks) dropped. */
export function serialize(file: LabelFile): string {
  const frames: LabelFile["frames"] = {};
  for (const [id, fr] of Object.entries(file.frames)) {
    const boundaries = fr.boundaries.filter((b) => b.points.length >= 2).sort((a, b) => bottomX(a) - bottomX(b));
    if (boundaries.length) frames[id] = { confidence: 1, boundaries };
  }
  return JSON.stringify({ ...file, frames }, null, 1);
}
