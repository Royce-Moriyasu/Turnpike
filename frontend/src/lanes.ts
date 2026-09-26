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

const TURN_ARROWS = {
  right: ["right", "slight right", "sharp right"],
  left: ["left", "slight left", "sharp left", "uturn"],
};

/**
 * Outer lanes that look like a bike lane or shoulder rather than a travel lane: narrower than
 * BIKE_LANE_RATIO x their neighbor at every row both span. Mapbox only counts travel lanes, so
 * these must not be counted when matching.
 *
 * A narrow outer lane is excluded when either
 *  - we see MORE lanes than Mapbox has (there's an extra lane to explain), or
 *  - Mapbox's lane on that edge has no turn arrow. Mapbox lists turn lanes but never bike lanes,
 *    so if its edge lane goes straight, a narrow extra lane beyond it can't be a turn lane.
 * Otherwise it's kept: with lanes out of frame, a narrow edge lane next to a Mapbox turn lane is
 * likely that turn lane squeezed by perspective (e.g. the right-turn lane at the Crossroads signal).
 * The right side is checked first (bike lanes run on the right in the US).
 */
export function bikeLikeLanes(
  lanes: Point[][],
  navCount: number,
  navLanes?: { indications: string[] }[] | null,
): Set<number> {
  const out = new Set<number>();
  if (lanes.length < 2) return out;
  let extra = lanes.length - navCount;
  const noTurnLane = (side: "left" | "right") => {
    const edge = navLanes?.length ? navLanes[side === "right" ? navLanes.length - 1 : 0] : null;
    return !!edge && !edge.indications.some((a) => TURN_ARROWS[side].includes(a));
  };
  const narrow = (i: number, neighbor: number) => {
    const a = widthsByRow(lanes[i]);
    const b = widthsByRow(lanes[neighbor]);
    const shared = [...a.keys()].filter((k) => b.has(k));
    return shared.length > 0 && shared.every((k) => a.get(k)! < BIKE_LANE_RATIO * b.get(k)!);
  };
  const last = lanes.length - 1;
  if ((extra > 0 || noTurnLane("right")) && narrow(last, last - 1)) {
    out.add(last);
    extra--;
  }
  if ((extra > 0 || noTurnLane("left")) && lanes.length - out.size >= 2 && narrow(0, 1)) out.add(0);
  return out;
}

/** The parts of a route's nav state that lane matching needs (see NavState). */
export interface LaneMatchNav {
  preferredLane: number | null;
  lanes: { indications: string[] }[] | null;
  laneSide: "left" | "right" | null;
  laneAnchor?: "left" | "right" | null;
  laneAhead?: { left: number; right: number } | null;
}

/**
 * Which visible lane to highlight, as an index into `lanes`. Before matching visible lanes to
 * Mapbox's lanes it sets aside lanes Mapbox doesn't count:
 *  - `excluded`: bike lanes / shoulders (bikeLikeLanes)
 *  - `upcoming`: turn lanes already opening that the current snapshot doesn't list yet
 *    (nav.laneAhead), taken from the matching edge only while we see more lanes than Mapbox has
 * then counts from nav.laneAnchor (the side our road is on; falls back to the turn side).
 */
export function laneTarget(
  nav: LaneMatchNav,
  lanes: Point[][],
): { index: number | null; excluded: Set<number>; upcoming: Set<number> } {
  const navCount = nav.lanes?.length ?? 0;
  const excluded = new Set<number>();
  const upcoming = new Set<number>();
  if (nav.preferredLane === null || !navCount || !lanes.length) return { index: null, excluded, upcoming };

  bikeLikeLanes(lanes, navCount, nav.lanes).forEach((i) => excluded.add(i));
  let travel = lanes.map((_, i) => i).filter((i) => !excluded.has(i));
  for (let k = 0; k < (nav.laneAhead?.right ?? 0) && travel.length > navCount; k++) upcoming.add(travel.pop()!);
  for (let k = 0; k < (nav.laneAhead?.left ?? 0) && travel.length > navCount; k++) upcoming.add(travel.shift()!);
  if (upcoming.size) {
    // With the turn lane set aside, the new edge lane may itself be a bike lane: US "keyhole" bike
    // lanes run between the through lanes and a right-turn lane (e.g. approaching Crossroads Pkwy).
    bikeLikeLanes(travel.map((i) => lanes[i]), navCount, nav.lanes).forEach((j) => excluded.add(travel[j]));
    travel = travel.filter((i) => !excluded.has(i));
  }

  const t = polygonIndexFor(nav.preferredLane, navCount, travel.length, nav.laneAnchor ?? nav.laneSide);
  return { index: t === null ? null : travel[t], excluded, upcoming };
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

// ---- Debug: why each visible lane was (or wasn't) matched ----

export type LaneStatus = "target" | "counted" | "outside" | "bike" | "upcoming";

export interface LaneDebugRow {
  lane: number; // index into the visible lanes, left to right
  status: LaneStatus; // outside = a travel lane with no Mapbox lane to match (lanes don't line up)
  mapboxLane: number | null; // Mapbox lane index it was matched to
  bottomWidth: number | null; // width at the lowest row it spans (0-1 of image width)
  ratio: number | null; // widest ratio to its inward neighbor over shared rows (bike rule: all < BIKE_LANE_RATIO)
}

export const bikeLaneRatio = BIKE_LANE_RATIO;

/** Per-lane explanation of laneTarget: what each visible lane was matched to, and why. */
export function laneDebug(nav: LaneMatchNav, lanes: Point[][]): LaneDebugRow[] {
  const { index, excluded, upcoming } = laneTarget(nav, lanes);
  const navCount = nav.lanes?.length ?? 0;
  const travel = lanes.map((_, i) => i).filter((i) => !excluded.has(i) && !upcoming.has(i));
  const side = nav.laneAnchor ?? nav.laneSide;
  const offset = side === "left" ? 0 : navCount - travel.length; // Mapbox index = travel position + offset
  const widths = lanes.map(widthsByRow);
  const bottom = (w: Map<number, number>) => (w.size ? w.get(Math.max(...w.keys()))! : null);

  return lanes.map((_, i) => {
    // inward neighbor: toward the middle of the visible lanes (what the bike rule compares against)
    const neighbor = lanes.length < 2 ? null : i < (lanes.length - 1) / 2 ? i + 1 : i - 1;
    let ratio: number | null = null;
    if (neighbor !== null) {
      const shared = [...widths[i].keys()].filter((k) => widths[neighbor].has(k) && widths[neighbor].get(k)! > 0);
      if (shared.length) ratio = Math.max(...shared.map((k) => widths[i].get(k)! / widths[neighbor].get(k)!));
    }
    const pos = travel.indexOf(i);
    const m = pos === -1 ? null : pos + offset;
    const mapboxLane = m !== null && m >= 0 && m < navCount ? m : null;
    const status: LaneStatus = excluded.has(i)
      ? "bike"
      : upcoming.has(i)
        ? "upcoming"
        : i === index
          ? "target"
          : mapboxLane === null
            ? "outside"
            : "counted";
    return { lane: i, status, mapboxLane, bottomWidth: bottom(widths[i]), ratio };
  });
}
