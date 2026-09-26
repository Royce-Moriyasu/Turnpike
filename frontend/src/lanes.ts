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
