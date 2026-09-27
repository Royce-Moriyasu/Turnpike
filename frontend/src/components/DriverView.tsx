import { useEffect, useMemo, useRef, useState } from "react";
import type { ActiveLanes, Frame, NavState, Point } from "../types";
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
}

const toPoints = (poly: Point[]) => poly.map(([x, y]) => `${x},${y}`).join(" ");

// Show the road, not the sky: crop to just above the horizon (SR 70's camera looks down, so most of
// its frame is sky). Polygons stay in full-image coordinates and the SVG viewBox crops them the same way.
const cropTopFor = (horizonY: number) => Math.min(0.6, Math.max(0, horizonY - 0.355));
const IMAGE_ASPECT = 2048 / 1152;

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

export default function DriverView({ frame, nav, offRoute, overlay, showArrow, lanes, previousLane, untakenTurnSide, debug, horizonY }: Props) {
  const CROP_TOP = cropTopFor(horizonY);
  const navCount = nav?.lanes?.length ?? 0;
  // Only detected lanes are drawn: no lanes for this frame means no highlight (Mapbox guidance still shows).
  const polygons = lanes.polygons ?? [];
  // No target lane means no highlight: that is the whole "standard GPS" view.
  const match = overlay && nav && nav.preferredLane !== null && navCount ? laneTarget(nav, polygons, horizonY) : null;
  const target = match?.index ?? null;
  const targetLane = target !== null ? polygons[target] : null;
  const trimmedLane = useMemo(() => trimUntakenBranch(targetLane, previousLane, untakenTurnSide), [targetLane, previousLane, untakenTurnSide]);
  const highlightedLane = useSmoothLane(trimmedLane);
  const imminent = nav ? nav.distanceM < 120 : false;
  // The compact arrow sits within the lane; its bearing follows bottom midpoint to top midpoint.
  const arrowLane = trimmedLane;
  const topY = arrowLane ? Math.max(CROP_TOP, Math.min(...arrowLane.map(([, y]) => y))) : 0;
  const bottomY = arrowLane ? Math.min(1, Math.max(...arrowLane.map(([, y]) => y))) : 0;
  const laneHeight = bottomY - topY;
  const upperY = topY + laneHeight * 0.08;
  const lowerY = bottomY - laneHeight * 0.08;
  const arrowY = topY + laneHeight * 0.4;
  const upperSpan = arrowLane ? spanAt(arrowLane, upperY) : null;
  const lowerSpan = arrowLane ? spanAt(arrowLane, lowerY) : null;
  const arrowSpan = arrowLane ? spanAt(arrowLane, arrowY) : null;
  const arrowX = arrowSpan ? (arrowSpan[0] + arrowSpan[1]) / 2 : 0.5;
  const arrowAngle = upperSpan && lowerSpan
    ? Math.atan2(
        ((upperSpan[0] + upperSpan[1] - lowerSpan[0] - lowerSpan[1]) / 2) * Math.cos(52 * Math.PI / 180),
        (lowerY - upperY) / IMAGE_ASPECT,
      ) * 180 / Math.PI
    : 0;
  const arrowWidth = Math.min(
    7.3,
    arrowSpan ? (arrowSpan[1] - arrowSpan[0]) * 55 : 7.3,
    upperSpan ? (upperSpan[1] - upperSpan[0]) * 45 : 7.3,
    (laneHeight / IMAGE_ASPECT) * 100,
  );

  return (
    <div
      className="relative overflow-hidden rounded-2xl bg-black ring-1 ring-white/10"
      style={{ aspectRatio: IMAGE_ASPECT / (1 - CROP_TOP) }}
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
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={imminent ? 0.7 : 0.5} />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0} />
          </linearGradient>
        </defs>
        {highlightedLane && (
            <polygon
              points={toPoints(highlightedLane)}
              fill="url(#lane-fill)"
              stroke="var(--color-accent-soft)"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              className="lane-pulse"
            />
        )}
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

      {showArrow && arrowLane && upperSpan && lowerSpan && arrowSpan && laneHeight > 0.04 && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
          style={{
            left: `${arrowX * 100}%`,
            top: `${((arrowY - CROP_TOP) / (1 - CROP_TOP)) * 100}%`,
            width: `${arrowWidth}%`,
          }}
          role="img"
          aria-label="Follow highlighted lane"
        >
          <svg
            className="direction-arrow block w-full"
            viewBox="0 0 64 64"
            style={{ transform: `perspective(160px) rotateX(52deg) rotate(${arrowAngle}deg)` }}
            aria-hidden="true"
          >
            <path d="M32 53V15 M18 29 32 15 46 29" fill="none" stroke="#42ffae" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      )}

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
