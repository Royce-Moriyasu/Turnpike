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
  const vp: Point = [0.5, 0.48];
  const top = 0.58;
  const [left, right] = [-0.45, 1.45];
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
