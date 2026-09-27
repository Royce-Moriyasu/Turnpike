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

// Perspective check. On a flat road a lane's width in the image at row y is k * (y - horizon),
// with the same k for every lane, since lanes are all ~3.6 m wide. Measured on this clip's
// hand-traced lanes: k median 2.0 (10-90%: 1.5-2.7), and it stays within a factor of ~1.6 across a
// lane's rows because both edges head for the vanishing point.
//  - A lane that NARROWS ahead faster than that (k at the bottom row / k at the top row > LANE_CLOSING)
//    has edges that meet before the horizon, which no real lane does: e.g. the curb-and-island shape
//    just past the Crossroads signal. Rejected.
//  - A lane that WIDENS ahead is still opening (a taper, e.g. the SOUTH lane just after the ramp
//    splits). Real, so it's judged by its width at the far end, where it's fully formed.
//  - Otherwise the median k must be a lane's: not several lanes merged, not a sliver. The range is
//    wide on purpose: the ramp's real lanes near the fork measure 0.9-1.3.
export const DEFAULT_HORIZON_Y = 0.775; // SR 70's camera; each clip's is in its demo.json (camera.horizonY)
const LANE_K_RANGE: [number, number] = [0.7, 3.5];
const LANE_CLOSING = 2.0;
const MIN_ROW_DEPTH = 0.03; // rows closer to the horizon than this are too squashed to measure

export interface LaneShape {
  k: number | null; // width / (row - horizon): the median, or the far end's for an opening lane
  closing: number | null; // k at the bottom row / k at the top row (> 1: narrows ahead)
  ok: boolean;
}

export function laneShape(poly: Point[], horizonY: number = DEFAULT_HORIZON_Y): LaneShape {
  const ks = [...widthsByRow(poly)]
    .map(([key, w]) => [key / 1000 - horizonY, w] as const)
    .filter(([depth]) => depth >= MIN_ROW_DEPTH)
    .sort((a, b) => a[0] - b[0]) // top (far) row first
    .map(([depth, w]) => w / depth);
  if (ks.length < 2) return { k: ks[0] ?? null, closing: null, ok: true }; // too little to judge
  const kTop = ks[0];
  const kBottom = ks[ks.length - 1];
  const closing = kTop > 0 ? kBottom / kTop : Infinity;
  const opening = closing < 1 / LANE_CLOSING;
  const k = opening ? kTop : [...ks].sort((a, b) => a - b)[Math.floor(ks.length / 2)];
  return { k, closing, ok: closing <= LANE_CLOSING && k >= LANE_K_RANGE[0] && k <= LANE_K_RANGE[1] };
}

export const laneShapeLimits = { k: LANE_K_RANGE, closing: LANE_CLOSING };

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

export interface LaneTargetResult {
  index: number | null; // lane to highlight, or null (see reason)
  excluded: Set<number>; // bike lanes / shoulders
  upcoming: Set<number>; // turn lanes opening ahead that the snapshot doesn't list yet
  implausible: Set<number>; // travel lanes failing the perspective check (laneShape)
  otherRoad: Set<number>; // lanes beyond a bike lane that separates our branch from the road we left
  offRoad: Set<number>; // lanes that are mostly not drivable road (YOLOPv2's drivable area)
  counted: number[]; // the lanes matched to Mapbox's, left to right
  countFrom: "left" | "right" | null; // the side counted from
  reason: string | null; // why there is no target
}

// An inner lane narrower than this x both neighbors (and not opening or closing ahead) is a bike
// lane, e.g. a keyhole bike lane between SR 70 and the I-95 ramp. Relative to the same frame, so
// it doesn't depend on the camera.
const INNER_BIKE_RATIO = 0.5;

function innerBikeLanes(lanes: Point[][], horizonY: number): Set<number> {
  const shapes = lanes.map((p) => laneShape(p, horizonY));
  const out = new Set<number>();
  for (let i = 1; i < lanes.length - 1; i++) {
    const { k, closing } = shapes[i];
    const left = shapes[i - 1].k;
    const right = shapes[i + 1].k;
    if (k === null || closing === null || left === null || right === null) continue;
    const steady = closing <= LANE_CLOSING && closing >= 1 / LANE_CLOSING;
    if (steady && k < INNER_BIKE_RATIO * Math.min(left, right)) out.add(i);
  }
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

// A lane with less than this share of drivable road (YOLOPv2's drivable area) isn't a lane we can
// drive in: during a turn YOLOPv2 also finds the opposing roadway's lines across the median, and
// those "lanes" cover no drivable area; so do gore islands at a fork. Kept low: turn lanes that are
// just opening and shoulders score 0.3-0.6 and are handled by the other rules.
export const DRIVABLE_MIN = 0.25;

/**
 * Which visible lane to highlight, as an index into `lanes`. Before matching visible lanes to
 * Mapbox's lanes it sets aside lanes Mapbox doesn't count:
 *  - `excluded`: bike lanes / shoulders (bikeLikeLanes)
 *  - `offRoad`: lanes that are mostly not drivable road (`drivable`: share per lane from the
 *    detector, null = unknown), e.g. the opposing roadway seen across a median during a turn
 *  - `upcoming`: turn lanes already opening that the current snapshot doesn't list yet
 *    (nav.laneAhead), taken from the matching edge only while we see more lanes than Mapbox has
 * then counts from nav.laneAnchor (the side our road is on; falls back to the turn side).
 */
export function laneTarget(
  nav: LaneMatchNav,
  lanes: Point[][],
  horizonY: number = DEFAULT_HORIZON_Y,
  drivable: (number | null)[] | null = null,
): LaneTargetResult {
  const navCount = nav.lanes?.length ?? 0;
  const excluded = new Set<number>();
  const upcoming = new Set<number>();
  const implausible = new Set<number>();
  const otherRoad = new Set<number>();
  const offRoad = new Set(
    lanes.map((_, i) => i).filter((i) => drivable?.[i] != null && drivable[i]! < DRIVABLE_MIN),
  );
  const result = (index: number | null, counted: number[], countFrom: "left" | "right" | null, reason: string | null) =>
    ({ index, excluded, upcoming, implausible, otherRoad, offRoad, counted, countFrom, reason });
  if (nav.preferredLane === null || !navCount || !lanes.length) {
    return result(null, [], null, lanes.length ? "no Mapbox lane target" : "no lanes");
  }

  bikeLikeLanes(lanes, navCount, nav.lanes).forEach((i) => excluded.add(i));
  innerBikeLanes(lanes, horizonY).forEach((i) => excluded.add(i));
  let travel = lanes.map((_, i) => i).filter((i) => !excluded.has(i) && !offRoad.has(i));
  for (let k = 0; k < (nav.laneAhead?.right ?? 0) && travel.length > navCount; k++) upcoming.add(travel.pop()!);
  for (let k = 0; k < (nav.laneAhead?.left ?? 0) && travel.length > navCount; k++) upcoming.add(travel.shift()!);
  if (upcoming.size) {
    // With the turn lane set aside, the new edge lane may itself be a bike lane: US "keyhole" bike
    // lanes run between the through lanes and a right-turn lane (e.g. approaching Crossroads Pkwy).
    bikeLikeLanes(travel.map((i) => lanes[i]), navCount, nav.lanes).forEach((j) => excluded.add(travel[j]));
    travel = travel.filter((i) => !excluded.has(i));
  }

  let side = nav.laneAnchor ?? nav.laneSide;
  let minLanes = Math.min(2, navCount);
  // Don't count across a bike lane on a branch: just after a ramp or fork (the bake set laneAnchor
  // to the side we branched to), a bike lane between the lanes separates our branch from the road
  // we left, so Mapbox's lanes are only the ones on the branch side. Count them from the bike lane,
  // a fixed edge (the branch's outer edge may still be opening), and one lane is enough evidence.
  // On an ordinary road the lanes beyond a keyhole bike lane are a turn lane Mapbox does count,
  // which the rules above handle.
  const onBranch = !!nav.laneAnchor && nav.laneAnchor !== nav.laneSide;
  const bikeBetween = (a: number, b: number) => [...excluded].some((e) => e > a && e < b);
  if (onBranch && travel.some((i, j) => j > 0 && bikeBetween(travel[j - 1], i))) {
    const groups: number[][] = [[travel[0]]];
    travel.slice(1).forEach((i, j) => {
      if (bikeBetween(travel[j], i)) groups.push([]);
      groups[groups.length - 1].push(i);
    });
    const keep = side === "left" ? groups[0] : groups[groups.length - 1];
    travel.filter((i) => !keep.includes(i)).forEach((i) => otherRoad.add(i));
    travel = keep;
    side = side === "left" ? "right" : "left";
    minLanes = 1;
  }

  const t = polygonIndexFor(nav.preferredLane, navCount, travel.length, side);
  travel.forEach((i) => !laneShape(lanes[i], horizonY).ok && implausible.add(i));
  if (t === null) return result(null, travel, side, "lanes don't line up with Mapbox's");

  // Evidence rules: only highlight when the count that reached the target can be trusted.
  //  - every lane counted on the way (from the counting edge to the target) must have a lane's shape
  //  - at least 2 trustworthy lanes (1 is enough only if Mapbox has 1): with a single lane, the
  //    count is a guess, and any lane-like shape would "win"
  const path = side === "left" ? travel.slice(0, t + 1) : travel.slice(t);
  if (path.some((i) => implausible.has(i))) return result(null, travel, side, "odd lane shape where lanes are counted");
  if (travel.filter((i) => !implausible.has(i)).length < minLanes) {
    return result(null, travel, side, "too few lanes to anchor the count");
  }
  return result(travel[t], travel, side, null);
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

export type LaneStatus = "target" | "counted" | "outside" | "bike" | "upcoming" | "shape" | "otherRoad" | "offRoad";

export interface LaneDebugRow {
  lane: number; // index into the visible lanes, left to right
  status: LaneStatus; // outside = a travel lane with no Mapbox lane to match (lanes don't line up)
  mapboxLane: number | null; // Mapbox lane index it was matched to
  bottomWidth: number | null; // width at the lowest row it spans (0-1 of image width)
  ratio: number | null; // widest ratio to its inward neighbor over shared rows (bike rule: all < BIKE_LANE_RATIO)
  k: number | null; // perspective check (laneShape)
  closing: number | null;
  drivable: number | null; // share of the lane that is drivable road (offRoad below DRIVABLE_MIN)
}

export const bikeLaneRatio = BIKE_LANE_RATIO;

/** Per-lane explanation of laneTarget: what each visible lane was matched to, and why. */
export function laneDebug(
  nav: LaneMatchNav,
  lanes: Point[][],
  horizonY: number = DEFAULT_HORIZON_Y,
  drivable: (number | null)[] | null = null,
): { rows: LaneDebugRow[]; reason: string | null; countFrom: "left" | "right" | null } {
  const { index, excluded, upcoming, implausible, otherRoad, offRoad, counted, countFrom, reason } =
    laneTarget(nav, lanes, horizonY, drivable);
  const navCount = nav.lanes?.length ?? 0;
  const travel = counted;
  const offset = countFrom === "left" ? 0 : navCount - travel.length; // Mapbox index = travel position + offset
  const widths = lanes.map(widthsByRow);
  const bottom = (w: Map<number, number>) => (w.size ? w.get(Math.max(...w.keys()))! : null);

  const rows = lanes.map((_, i) => {
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
      : offRoad.has(i)
      ? "offRoad"
      : upcoming.has(i)
        ? "upcoming"
        : otherRoad.has(i)
          ? "otherRoad"
          : implausible.has(i)
            ? "shape"
            : i === index
              ? "target"
              : mapboxLane === null
                ? "outside"
                : "counted";
    const shape = laneShape(lanes[i], horizonY);
    return {
      lane: i, status, mapboxLane, bottomWidth: bottom(widths[i]), ratio, k: shape.k, closing: shape.closing,
      drivable: drivable?.[i] ?? null,
    };
  });
  return { rows, reason, countFrom };
}

/** Display only: "I 95" -> "I-95" (also US/SR/CR routes), as road names are usually written. */
export const roadName = (text: string) => text.replace(/\b(I|US|SR|CR)\s(\d+)/g, "$1-$2");
