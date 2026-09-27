import { useEffect, useMemo, useRef, useState } from "react";
import type { ActiveLanes, Frame, NavState, Point, Vehicle } from "../types";
import { laneTarget, type LaneDebugRow } from "../lanes";
import { STATUS_STYLE } from "./LaneDebug";

interface Props {
  frame: Frame;
  nav: NavState | null;
  offRoute: boolean;
  overlay: boolean; // false = standard GPS: no lane highlight
  showArrow: boolean;
  lanes: ActiveLanes; // the selected lane source's geometry for this frame
  previousLane: Point[] | null; // same route and lane source in the preceding frame
  untakenTurnSide: "left" | "right" | null;
  debug?: LaneDebugRow[] | null; // lane debug view: outline and label every detected lane
  horizonY: number; // the clip's camera (demo.camera.horizonY)
  vanishingX: number; // ...and where its lane lines meet across the image (demo.camera.vanishingPoint[0])
  imageAspect: number; // the photos' width / height (demo.camera.imageSize): 16:9 dashcam, 4:3 phone
}

const toPoints = (poly: Point[]) => poly.map(([x, y]) => `${x},${y}`).join(" ");

// Show the road, not the sky: crop to just above the horizon (SR 70's camera looks down, so most of
// its frame is sky). Polygons stay in full-image coordinates and the SVG viewBox crops them the same way.
const cropTopFor = (horizonY: number) => Math.min(0.6, Math.max(0, horizonY - 0.355));

const imgClass = "absolute inset-0 h-full w-full select-none object-cover object-bottom";

/**
 * Crossfade between frames: the new frame fades in over the previous one. Moving forward, the
 * previous frame also zooms toward the vanishing point as it fades, which reads as driving.
 */
function FrameImages({ frame }: { frame: Frame }) {
  const [layers, setLayers] = useState<{ cur: Frame; prev: Frame | null }>({ cur: frame, prev: null });
  if (layers.cur.id !== frame.id) setLayers({ cur: frame, prev: layers.cur }); // track the previous frame
  const prev = layers.prev;
  const forward = prev ? frame.progressM > prev.progressM : false;
  return (
    <>
      {prev?.image && (
        <img
          key={`prev-${prev.id}`}
          src={prev.image}
          alt=""
          className={`${imgClass} ${forward ? "frame-out-forward" : "frame-out"}`}
          draggable={false}
        />
      )}
      <img key={frame.id} src={frame.image!} alt="Street-level view" className={`${imgClass} frame-in`} draggable={false} />
    </>
  );
}

/** Horizontal center of a polygon at image row y (falls back to the mean x). */
function centerAt(poly: Point[], y: number): number {
  const xs: number[] = [];
  poly.forEach(([x1, y1], i) => {
    const [x2, y2] = poly[(i + 1) % poly.length];
    if ((y1 - y) * (y2 - y) <= 0 && y1 !== y2) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
  });
  const pts = xs.length >= 2 ? xs : poly.map((p) => p[0]);
  return (Math.min(...pts) + Math.max(...pts)) / 2;
}

/** Horizontal extent where a lane polygon crosses an image row. */
function spanAt(poly: Point[], y: number): [number, number] | null {
  const xs: number[] = [];
  poly.forEach(([x1, y1], i) => {
    const [x2, y2] = poly[(i + 1) % poly.length];
    if (y1 === y2) {
      if (y1 === y) xs.push(x1, x2);
    } else if (y >= Math.min(y1, y2) && y <= Math.max(y1, y2)) {
      xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
  });
  return xs.length >= 2 ? [Math.min(...xs), Math.max(...xs)] : null;
}

/**
 * Run a lane down to the bottom of the image. Detections often stop short of it (the lines near the
 * camera leave the frame or aren't found), which leaves a short highlight floating on the road.
 * Lane polygons (bake) are the left edge bottom to top, then the right edge top to bottom; each edge
 * continues straight along its lowest segment. Always adds the two points, so the point count stays
 * the same from frame to frame (useSmoothLane only animates between equal counts).
 */
function extendToBottom(poly: Point[]): Point[] {
  const half = poly.length / 2;
  if (poly.length < 4 || !Number.isInteger(half)) return poly;
  const extend = ([x0, y0]: Point, [x1, y1]: Point): Point =>
    y0 >= 1 || y0 === y1 ? [x0, Math.max(y0, 1)] : [x0 + ((1 - y0) * (x0 - x1)) / (y0 - y1), 1];
  const left = extend(poly[0], poly[1]);
  const right = extend(poly[poly.length - 1], poly[poly.length - 2]);
  return [left, ...poly, right];
}

// A vehicle is "in our lane" when the middle of its box's bottom edge (where it meets the road) is in
// the highlighted lane, or just past the lane's far end: up to this x the far end's ground distance.
const VEHICLE_AHEAD = 1.5;
const VEHICLE_MIN_CONFIDENCE = 0.4;
const VEHICLE_MAX_WIDTH = 0.6; // wider boxes are the camera car's own hood, not traffic

function insidePolygon([x, y]: Point, poly: Point[]): boolean {
  let inside = false;
  poly.forEach(([x1, y1], i) => {
    const [x2, y2] = poly[(i + 1) % poly.length];
    if (y1 > y !== y2 > y && x < x1 + ((y - y1) / (y2 - y1)) * (x2 - x1)) inside = !inside;
  });
  return inside;
}

/** The lane (extended to the bottom) plus a short stretch past its far end, each edge continued
 * along its farthest segment. Ground distance ~ 1 / (y - horizon), as for the chevrons. */
function laneWithRunway(lane: Point[], horizonY: number): Point[] {
  const half = lane.length / 2;
  if (lane.length < 4 || !Number.isInteger(half)) return lane;
  const [leftTop, leftBelow] = [lane[half - 1], lane[half - 2]];
  const [rightTop, rightBelow] = [lane[half], lane[half + 1]];
  const top = Math.min(leftTop[1], rightTop[1]);
  if (top <= horizonY + 0.005) return lane;
  const ahead = horizonY + (top - horizonY) / VEHICLE_AHEAD;
  const along = ([x0, y0]: Point, [x1, y1]: Point): Point =>
    y0 === y1 ? [x0, ahead] : [x0 + ((ahead - y0) * (x0 - x1)) / (y0 - y1), ahead];
  return [...lane.slice(0, half), along(leftTop, leftBelow), along(rightTop, rightBelow), ...lane.slice(half)];
}

// Red means "that lane is occupied, wait before moving over". Once we are in the target lane, the
// vehicle ahead is just the one we're following, so the highlight stays blue. We are in the lane when
// the camera's path (from the bottom middle of the image toward the vanishing point) runs within
// this many lane widths of the lane's center, at the lane's nearest detected row: 0.5 = anywhere
// between its lines.
const IN_LANE = 0.5;

/** Signed distance from the lane's center to the camera's path, in lane widths (+ = camera to the
 * right), at the lane's lowest detected row; null if the lane has no width there. */
export function cameraOffset(lane: Point[], horizonY: number, vanishingX: number): number | null {
  const y = Math.max(...lane.map(([, py]) => py));
  const span = spanAt(lane, y);
  if (!span || span[1] - span[0] <= 0 || y <= horizonY) return null;
  const cameraX = 0.5 + ((vanishingX - 0.5) * (1 - y)) / (1 - horizonY);
  return (cameraX - (span[0] + span[1]) / 2) / (span[1] - span[0]);
}

function vehicleInLane(vehicles: Vehicle[] | undefined, lane: Point[] | null, horizonY: number): boolean {
  if (!vehicles?.length || !lane) return false;
  const zone = laneWithRunway(lane, horizonY);
  return vehicles.some(({ box: [x0, , x1, y1], confidence }) =>
    confidence >= VEHICLE_MIN_CONFIDENCE && x1 - x0 <= VEHICLE_MAX_WIDTH && insidePolygon([(x0 + x1) / 2, y1], zone));
}

// Direction chevrons painted on the highlighted lane, like road markings. They sit at even steps of
// ground distance, so they shrink and bunch up toward the horizon as paint would. On a flat road a
// row's distance is proportional to 1 / (y - horizon); z below is that distance in units of the
// bottom row's (z = 1 at y = 1). Each chevron's corners come from the lane's edges at its own rows, so
// it also follows the lane around a curve.
const CHEVRONS = 3;
const CHEVRON_NEAR = 1.15; // distance of the nearest chevron (bottom row = 1)
const CHEVRON_SPREAD = 2.8; // farthest chevron at most this x the nearest's distance
const CHEVRON_LENGTH = 0.32; // tip ahead of the base, as a share of the distance
const CHEVRON_THICKNESS = 0.09; // arm thickness, as a share of the distance
const CHEVRON_HALF_WIDTH = 0.2; // arm reach, as a share of the lane width

function laneChevrons(lane: Point[], horizonY: number): Point[][] {
  const top = Math.min(...lane.map(([, y]) => y));
  if (top <= horizonY + 0.01) return [];
  const row = (z: number) => horizonY + (1 - horizonY) / z;
  const zTop = (1 - horizonY) / (top - horizonY);
  const zFar = Math.min(CHEVRON_NEAR * CHEVRON_SPREAD, zTop / (1 + CHEVRON_LENGTH) / 1.05);
  if (zFar <= CHEVRON_NEAR) return [];
  const at = (z: number) => {
    const y = row(z);
    const span = spanAt(lane, y);
    return span && { y, c: (span[0] + span[1]) / 2, r: (span[1] - span[0]) * CHEVRON_HALF_WIDTH };
  };
  const out: Point[][] = [];
  for (let k = 0; k < CHEVRONS; k++) {
    const z = CHEVRON_NEAR * (zFar / CHEVRON_NEAR) ** (k / (CHEVRONS - 1));
    const [base, tip] = [at(z), at(z * (1 + CHEVRON_LENGTH))];
    const [innerBase, innerTip] = [at(z / (1 + CHEVRON_THICKNESS)), at((z * (1 + CHEVRON_LENGTH)) / (1 + CHEVRON_THICKNESS))];
    if (!base || !tip || !innerBase || !innerTip) continue;
    out.push([
      [base.c - base.r, base.y],
      [tip.c, tip.y],
      [base.c + base.r, base.y],
      [innerBase.c + innerBase.r, innerBase.y],
      [innerTip.c, innerTip.y],
      [innerBase.c - innerBase.r, innerBase.y],
    ]);
  }
  return out;
}

// Turn cue: when the route turns soon (Mapbox's next maneuver), the highlight runs on to the turn and
// bends that way, ending in an arrowhead. It's drawn on the road with the chevrons' flat-road model,
// anchored to the lane's far end (center xTop, width wTop at row yTop). A road point `along` lane
// widths past the far end and `across` lane widths right of the lane's center is at
//   s = 1 + along * wTop / CAMERA_FOCAL      (distance relative to the far end's)
//   y = horizon + (yTop - horizon) / s,   x = vanishingX + (xTop - vanishingX + across * wTop) / s
// since a lane wTop wide in the image is CAMERA_FOCAL / wTop lane widths away.
const TURN_CUE_M = 60; // show within this many meters of the turn
const TURN_TYPES = new Set(["turn", "end of road"]);
const CAMERA_FOCAL = 0.6; // focal length in image widths (a typical dashcam); sets the curve's depth
const LANE_WIDTH_M = 3.6;
const TURN_STARTS_M = 6; // Mapbox's maneuver point is mid-intersection; the curve starts this much before
const TURN_RADIUS = 2.2; // lane widths (~8 m, a curb-side turn)
const TURN_HALF_WIDTH = 0.2; // ribbon, lane widths
const TURN_HEAD = { halfWidth: 0.55, length: 1.0 };
const TURN_ANGLE: Record<string, number> = { "slight right": 45, right: 90, "sharp right": 120, "slight left": -45, left: -90, "sharp left": -120 };

function turnCue(lane: Point[], nav: NavState | null, horizonY: number, vanishingX: number): Point[] | null {
  const angle = nav && TURN_TYPES.has(nav.maneuverType) && nav.modifier ? TURN_ANGLE[nav.modifier] : undefined;
  if (angle === undefined || nav!.distanceM > TURN_CUE_M) return null;
  const half = lane.length / 2;
  if (lane.length < 4 || !Number.isInteger(half)) return null;
  const [[xl, yl], [xr, yr]] = [lane[half - 1], lane[half]]; // far end: left and right edges
  const yTop = Math.min(yl, yr);
  const wTop = xr - xl;
  if (yTop <= horizonY + 0.01 || wTop <= 0) return null;
  const xTop = (xl + xr) / 2;
  const farEnd = CAMERA_FOCAL / wTop; // lane widths
  // straight on from the far end to where the turn starts, then the bend
  const lead = Math.max(0.2, (nav!.distanceM - TURN_STARTS_M) / LANE_WIDTH_M - farEnd);
  const project = (across: number, along: number): Point => {
    const sc = 1 + (along * wTop) / CAMERA_FOCAL;
    return [vanishingX + (xTop - vanishingX + across * wTop) / sc, horizonY + (yTop - horizonY) / sc];
  };
  const dir = Math.sign(angle);
  const sweep = (Math.abs(angle) * Math.PI) / 180;
  // centerline: position and heading (unit vector across/along) at each step
  const steps: { a: number; l: number; ta: number; tl: number }[] = [{ a: 0, l: 0, ta: 0, tl: 1 }];
  for (let i = 0; i <= 12; i++) {
    const th = (sweep * i) / 12;
    steps.push({
      a: dir * TURN_RADIUS * (1 - Math.cos(th)),
      l: lead + TURN_RADIUS * Math.sin(th),
      ta: dir * Math.sin(th),
      tl: Math.cos(th),
    });
  }
  const offset = ({ a, l, ta, tl }: (typeof steps)[number], by: number) => project(a - tl * by, l + ta * by); // + = left
  const end = steps[steps.length - 1];
  const tip = project(end.a + end.ta * TURN_HEAD.length, end.l + end.tl * TURN_HEAD.length);
  return [
    ...steps.map((p) => offset(p, TURN_HALF_WIDTH)),
    offset(end, TURN_HEAD.halfWidth),
    tip,
    offset(end, -TURN_HEAD.halfWidth),
    ...steps.reverse().map((p) => offset(p, -TURN_HALF_WIDTH)),
  ];
}

/** Keep an untaken turn branch from widening the highlighted through lane. */
function trimUntakenBranch(lane: Point[] | null, previous: Point[] | null, side: "left" | "right" | null): Point[] | null {
  if (!lane || !previous || !side) return lane;
  const topY = Math.max(Math.min(...lane.map(([, y]) => y)), Math.min(...previous.map(([, y]) => y))) + 0.01;
  const now = spanAt(lane, topY);
  const before = spanAt(previous, topY);
  if (!now || !before || now[1] - now[0] - (before[1] - before[0]) < 0.04) return lane;

  const bottomY = Math.min(Math.max(...lane.map(([, y]) => y)), Math.max(...previous.map(([, y]) => y))) - 0.015;
  const nowBottom = spanAt(lane, bottomY);
  const beforeBottom = spanAt(previous, bottomY);
  if (!nowBottom || !beforeBottom) return lane;
  const containsCenter = ([left, right]: [number, number]) => left <= 0.5 && right >= 0.5;
  // A lane switch moves the highlighted lane relative to the camera; use the new detection then.
  if (containsCenter(nowBottom) !== containsCenter(beforeBottom) ||
      Math.abs(centerAt(lane, bottomY) - centerAt(previous, bottomY)) > 0.1) return lane;

  // Widening must be on the side of the turn we did not take.
  if (side === "right" && now[1] - before[1] < now[0] - before[0] + 0.04) return lane;
  if (side === "left" && before[0] - now[0] < before[1] - now[1] + 0.04) return lane;
  return lane.map(([x, y], i) => {
    if ((side === "right" && i < lane.length / 2) || (side === "left" && i >= lane.length / 2)) return [x, y];
    const current = spanAt(lane, y);
    const prior = spanAt(previous, y);
    if (!current || !prior) return [x, y];
    const width = prior[1] - prior[0];
    return [side === "right" ? current[0] + width : current[1] - width, y];
  });
}

/** Keep the highlight mounted and move it between nearby detections. */
function useSmoothLane(next: Point[] | null): Point[] | null {
  const [current, setCurrent] = useState<Point[] | null>(next);
  const currentRef = useRef<Point[] | null>(next);

  useEffect(() => {
    const from = currentRef.current;
    if (!next || !from || from.length !== next.length ||
        Math.abs(centerAt(from, 0.85) - centerAt(next, 0.85)) > 0.12 ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      currentRef.current = next;
      setCurrent(next);
      return;
    }

    const start = performance.now();
    let request: number;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 450);
      const eased = t * t * (3 - 2 * t);
      const points: Point[] = from.map(([x, y], i) => [
        x + (next[i][0] - x) * eased,
        y + (next[i][1] - y) * eased,
      ]);
      currentRef.current = points;
      setCurrent(points);
      if (t < 1) request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [next]);

  return current;
}

export default function DriverView({ frame, nav, offRoute, overlay, showArrow, lanes, previousLane, untakenTurnSide, debug, horizonY, vanishingX, imageAspect }: Props) {
  const CROP_TOP = cropTopFor(horizonY);
  const navCount = nav?.lanes?.length ?? 0;
  // Only detected lanes are drawn: no lanes for this frame means no highlight (Mapbox guidance still shows).
  const polygons = lanes.polygons ?? [];
  // No target lane means no highlight, tag or badge: that is the whole "standard GPS" view.
  const match = overlay && nav && nav.preferredLane !== null && navCount ? laneTarget(nav, polygons, horizonY, lanes.drivable) : null;
  const target = match?.index ?? null;
  const targetLane = target !== null ? polygons[target] : null;
  const trimmedLane = useMemo(() => trimUntakenBranch(targetLane, previousLane, untakenTurnSide), [targetLane, previousLane, untakenTurnSide]);
  const highlightedLane = useSmoothLane(trimmedLane);
  const imminent = nav ? nav.distanceM < 120 : false;
  const shownLane = highlightedLane && extendToBottom(highlightedLane);
  const chevrons = showArrow && shownLane ? laneChevrons(shownLane, horizonY) : [];
  // Red when a vehicle is in the target lane and we aren't in it yet (judged on the detected lane, not
  // the animated one).
  const offset = trimmedLane ? cameraOffset(trimmedLane, horizonY, vanishingX) : null;
  const inTargetLane = offset !== null && Math.abs(offset) <= IN_LANE;
  const blocked = !inTargetLane && vehicleInLane(frame.vehicles, trimmedLane && extendToBottom(trimmedLane), horizonY);
  const laneColor = blocked ? "var(--color-danger)" : "var(--color-accent)";
  const turn = shownLane ? turnCue(shownLane, nav, horizonY, vanishingX) : null;

  return (
    <div
      className="relative overflow-hidden rounded-2xl bg-black ring-1 ring-white/10"
      style={{ aspectRatio: imageAspect / (1 - CROP_TOP) }}
    >
      {frame.image ? (
        <FrameImages frame={frame} />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-b from-sky-900/60 via-slate-800 to-neutral-700">
          <div className="absolute inset-x-0 top-3 text-center text-xs uppercase tracking-widest text-white/50">
            Synthetic frame · run the bake with --frames for real imagery
          </div>
        </div>
      )}

      <svg
        className="absolute inset-0 h-full w-full"
        viewBox={`0 ${CROP_TOP} 1 ${1 - CROP_TOP}`}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="lane-fill" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" className="lane-stop" style={{ stopColor: laneColor }} stopOpacity={imminent ? 0.7 : 0.5} />
            <stop offset="100%" className="lane-stop" style={{ stopColor: laneColor }} stopOpacity={0} />
          </linearGradient>
        </defs>
        {highlightedLane && (
            <polygon
              points={toPoints(shownLane!)}
              fill="url(#lane-fill)"
              stroke={blocked ? "var(--color-danger-soft)" : "var(--color-accent-soft)"}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              className="lane-pulse lane-outline"
            />
        )}
        {turn && (
          <polygon
            points={toPoints(turn)}
            className="turn-cue"
            style={{ fill: laneColor, stroke: blocked ? "var(--color-danger-soft)" : "var(--color-accent-soft)" }}
            strokeWidth={2}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {/* nearest first, so the brightening wave runs away from the driver */}
        {chevrons.map((pts, k) => (
          <polygon
            key={`chev${k}`}
            points={toPoints(pts)}
            className="lane-chevron"
            style={{ animationDelay: `${k * 0.22}s` }}
          />
        ))}
        {debug &&
          lanes.polygons &&
          debug.map((row) => (
            <polygon
              key={`dbg${row.lane}`}
              points={toPoints(lanes.polygons![row.lane])}
              fill={STATUS_STYLE[row.status].color}
              fillOpacity={row.status === "target" ? 0 : 0.12}
              stroke={STATUS_STYLE[row.status].color}
              strokeWidth={row.status === "target" ? 3 : 2}
              strokeDasharray={row.status === "bike" || row.status === "upcoming" ? "6 4" : undefined}
              vectorEffect="non-scaling-stroke"
            />
          ))}
      </svg>

      {debug &&
        lanes.polygons &&
        debug.map((row) => {
          const poly = lanes.polygons![row.lane];
          const y = Math.min(0.97, Math.max(0.86, Math.max(...poly.map((p) => p[1])) - 0.015));
          const x = Math.min(0.97, Math.max(0.03, centerAt(poly, y)));
          return (
            <div
              key={`dbgl${row.lane}`}
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-black/75 px-1.5 py-0.5 font-mono text-[10px] font-bold md:text-xs"
              style={{ left: `${x * 100}%`, top: `${((y - CROP_TOP) / (1 - CROP_TOP)) * 100}%`, color: STATUS_STYLE[row.status].color }}
            >
              L{row.lane + 1}
              {row.mapboxLane !== null ? ` → M${row.mapboxLane + 1}` : ` · ${STATUS_STYLE[row.status].label}`}
            </div>
          );
        })}

      {offRoute && (
        <div className="absolute inset-x-0 top-0 bg-red-600/85 py-2 text-center text-sm font-semibold">
          Past the fork: this frame is off the selected route
        </div>
      )}
      {!overlay && (
        <div className="absolute left-3 top-3 rounded-md bg-black/60 px-2 py-1 text-xs font-semibold uppercase tracking-wider text-white/80">
          Standard GPS
        </div>
      )}
      {overlay && navCount > 0 && (
        <div className="absolute bottom-2 right-3 rounded bg-black/60 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/60">
          {!lanes.polygons
            ? `No ${lanes.label} lanes detected`
            : target === null
              ? `No ${lanes.label} lane match${match?.reason ? `: ${match.reason}` : ""}`
              : `${lanes.label} lanes`}
        </div>
      )}
    </div>
  );
}
