import { useState } from "react";
import type { ActiveLanes, Frame, NavState, Point } from "../types";
import { laneTarget, type LaneDebugRow } from "../lanes";
import { STATUS_STYLE } from "./LaneDebug";

interface Props {
  frame: Frame;
  nav: NavState | null;
  offRoute: boolean;
  overlay: boolean; // false = standard GPS: no lane highlight
  lanes: ActiveLanes; // the selected lane source's geometry for this frame
  debug?: LaneDebugRow[] | null; // lane debug view: outline and label every detected lane
  horizonY: number; // the clip's camera (demo.camera.horizonY)
}

const toPoints = (poly: Point[]) => poly.map(([x, y]) => `${x},${y}`).join(" ");

// Show the road, not the sky: crop to just above the horizon (SR 70's camera looks down, so most of
// its frame is sky). Polygons stay in full-image coordinates and the SVG viewBox crops them the same way.
const cropTopFor = (horizonY: number) => Math.min(0.6, Math.max(0, horizonY - 0.355));
const IMAGE_ASPECT = 2048 / 1152;
const TAG_Y = 0.9; // where the "your lane" tag sits on the road, in image coords

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

export default function DriverView({ frame, nav, offRoute, overlay, lanes, debug, horizonY }: Props) {
  const CROP_TOP = cropTopFor(horizonY);
  const navCount = nav?.lanes?.length ?? 0;
  // Only detected lanes are drawn: no lanes for this frame means no highlight (Mapbox guidance still shows).
  const polygons = lanes.polygons ?? [];
  // No target lane means no highlight, tag or badge: that is the whole "standard GPS" view.
  const match = overlay && nav && nav.preferredLane !== null && navCount ? laneTarget(nav, polygons, horizonY) : null;
  const target = match?.index ?? null;
  const imminent = nav ? nav.distanceM < 120 : false;

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
        key={`overlay-${frame.id}`}
        className="frame-in absolute inset-0 h-full w-full"
        viewBox={`0 ${CROP_TOP} 1 ${1 - CROP_TOP}`}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="lane-fill" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={imminent ? 0.7 : 0.5} />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0} />
          </linearGradient>
        </defs>
        {polygons.map((poly, i) =>
          i === target ? (
            <polygon
              key={i}
              points={toPoints(poly)}
              fill="url(#lane-fill)"
              stroke="var(--color-accent-soft)"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              className="lane-pulse"
            />
          ) : null,
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

      {target !== null && (
        <div
          key={`tag-${frame.id}`}
          className="frame-in pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent px-3 py-1 text-xs font-bold uppercase tracking-wider text-white shadow-lg ring-2 ring-white md:text-sm"
          style={{
            left: `${Math.min(0.88, Math.max(0.12, centerAt(polygons[target], TAG_Y))) * 100}%`,
            top: `${((TAG_Y - CROP_TOP) / (1 - CROP_TOP)) * 100}%`,
          }}
        >
          ▲ Your lane
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
