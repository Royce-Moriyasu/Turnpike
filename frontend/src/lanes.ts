import type { Point } from "./types";

const ARROWS: Record<string, string> = {
  straight: "↑",
  "slight right": "↗",
  right: "→",
  "sharp right": "↘",
  "slight left": "↖",
  left: "←",
  "sharp left": "↙",
  uturn: "↶",
};

export const arrowFor = (indication: string) => ARROWS[indication] ?? "•";

const ORDINAL = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];

/** "rightmost lane", "2nd lane from the left", ... for lane i of n (0 = leftmost). */
export function describeLane(i: number, n: number): string {
  if (n === 1) return "only lane";
  if (i === n - 1) return "rightmost lane";
  if (i === 0) return "leftmost lane";
  if (n % 2 === 1 && i === (n - 1) / 2) return "middle lane";
  const fromRight = n - 1 - i;
  return fromRight <= i ? `${ORDINAL[fromRight + 1]} lane from the right` : `${ORDINAL[i + 1]} lane from the left`;
}

// `allowed` is the bake's decision from the lane arrows; Mapbox's own flags are the fallback.
export const isUsable = (lane: { allowed?: boolean; active?: boolean; valid: boolean }) =>
  lane.allowed ?? lane.active ?? lane.valid;

export function formatDistance(m: number): string {
  const ft = m * 3.28084;
  if (ft < 1000) return `${Math.round(ft / 10) * 10} ft`;
  return `${(m / 1609.34).toFixed(1)} mi`;
}

/**
 * Stand-in lane geometry until real polygons exist (fallback_lanes.json or OpenCV):
 * n lanes fanned out from a vanishing point. Clearly approximate — the data panel says so.
 */
export function placeholderLanes(n: number): Point[][] {
  // Tuned to the Mapillary clip: horizon sits ~77% down the frame.
  const vp: Point = [0.47, 0.775];
  const top = 0.8;
  const laneWidthAtBottom = 0.55;
  const left = 0.5 - (laneWidthAtBottom * n) / 2;
  const right = 0.5 + (laneWidthAtBottom * n) / 2;
  const t = (1 - top) / (1 - vp[1]);
  const bottomX = (i: number) => left + ((right - left) * i) / n;
  const topX = (i: number) => bottomX(i) + (vp[0] - bottomX(i)) * t;
  return Array.from({ length: n }, (_, i) => [
    [bottomX(i), 1],
    [bottomX(i + 1), 1],
    [topX(i + 1), top],
    [topX(i), top],
  ]);
}

/** Lane polygons from boundary lines sorted left to right (the vision/README.md format). */
export function lanesFromLines(lines: { x: (number | null)[] }[], rows: number[]): Point[][] {
  return lines.slice(0, -1).map((l, i) => {
    const r = lines[i + 1];
    const both = rows.map((_, j) => j).filter((j) => l.x[j] !== null && r.x[j] !== null);
    if (both.length < 2) return [];
    return [
      ...both.map((j): Point => [l.x[j]!, rows[j]]),
      ...[...both].reverse().map((j): Point => [r.x[j]!, rows[j]]),
    ];
  });
}

// A bike lane (~1.5 m) is well under half a travel lane (~3.5 m) wide. Perspective shrinks lanes
// equally at a given image row, so compare an outer lane with its neighbor row by row.
const BIKE_LANE_RATIO = 0.55;

function widthsByRow(poly: Point[]): Map<number, number> {
  const xsByRow = new Map<number, number[]>();
  for (const [x, y] of poly) {
    const key = Math.round(y * 1000);
    xsByRow.set(key, [...(xsByRow.get(key) ?? []), x]);
  }
  const widths = new Map<number, number>();
  for (const [key, xs] of xsByRow) if (xs.length >= 2) widths.set(key, Math.max(...xs) - Math.min(...xs));
  return widths;
}

/**
 * Outer lanes that look like a bike lane or shoulder rather than a travel lane: narrower than
 * BIKE_LANE_RATIO x their neighbor at every row both span. Mapbox only counts travel lanes, so
 * these must not be counted when matching. Only applied while we see MORE lanes than Mapbox has:
 * with lanes out of frame, a narrow outer lane is as likely a real lane squeezed by perspective
 * (e.g. the right-turn lane at the Crossroads signal), and dropping it would shift the highlight.
 * The right side is checked first (bike lanes run on the right in the US).
 */
export function bikeLikeLanes(lanes: Point[][], navCount: number): Set<number> {
  const out = new Set<number>();
  let extra = lanes.length - navCount;
  if (lanes.length < 2 || extra <= 0) return out;
  const narrow = (i: number, neighbor: number) => {
    const a = widthsByRow(lanes[i]);
    const b = widthsByRow(lanes[neighbor]);
    const shared = [...a.keys()].filter((k) => b.has(k));
    return shared.length > 0 && shared.every((k) => a.get(k)! < BIKE_LANE_RATIO * b.get(k)!);
  };
  const last = lanes.length - 1;
  if (extra > 0 && narrow(last, last - 1)) {
    out.add(last);
    extra--;
  }
  if (extra > 0 && lanes.length - out.size >= 2 && narrow(0, 1)) out.add(0);
  return out;
}

/**
 * Which visible lane to highlight: skips bike-like outer lanes, then matches Mapbox's lane to
 * the remaining travel lanes (see polygonIndexFor). Returns the index into `lanes`.
 */
export function laneTarget(
  navIndex: number,
  navCount: number,
  lanes: Point[][],
  side: "left" | "right" | null,
): { index: number | null; excluded: Set<number> } {
  const excluded = bikeLikeLanes(lanes, navCount);
  const travel = lanes.map((_, i) => i).filter((i) => !excluded.has(i));
  const t = polygonIndexFor(navIndex, navCount, travel.length, side);
  return { index: t === null ? null : travel[t], excluded };
}

/**
 * Map a navigation lane index to a visible polygon index. When the image shows fewer
 * lanes than the data, align from the maneuver side (e.g. count from the right edge
 * for a right-side maneuver), which stays stable as the camera changes lanes.
 */
export function polygonIndexFor(
  navIndex: number,
  navCount: number,
  polyCount: number,
  side: "left" | "right" | null,
): number | null {
  const idx = side === "left" ? navIndex : navIndex - (navCount - polyCount);
  return idx >= 0 && idx < polyCount ? idx : null;
}
