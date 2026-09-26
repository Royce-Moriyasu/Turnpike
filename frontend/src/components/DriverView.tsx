import type { Frame, NavState, Point } from "../types";
import { placeholderLanes, polygonIndexFor } from "../lanes";

interface Props {
  frame: Frame;
  nav: NavState | null;
  offRoute: boolean;
}

const toPoints = (poly: Point[]) => poly.map(([x, y]) => `${x},${y}`).join(" ");

// The clip is mostly sky; show only the bottom of each frame. Polygons stay in
// full-image coordinates and the SVG viewBox crops them the same way.
const CROP_TOP = 0.42;
const IMAGE_ASPECT = 2048 / 1152;

export default function DriverView({ frame, nav, offRoute }: Props) {
  const navCount = nav?.lanes?.length ?? 0;
  const polygons = frame.lanePolygons ?? (navCount ? placeholderLanes(navCount) : []);
  const target =
    nav && nav.preferredLane !== null && navCount
      ? polygonIndexFor(nav.preferredLane, navCount, polygons.length, nav.laneSide)
      : null;
  const imminent = nav ? nav.distanceM < 120 : false;

  return (
    <div
      className="relative overflow-hidden rounded-2xl bg-black ring-1 ring-white/10"
      style={{ aspectRatio: IMAGE_ASPECT / (1 - CROP_TOP) }}
    >
      {frame.image ? (
        <img
          src={frame.image}
          alt="Street-level view"
          className="absolute inset-0 h-full w-full select-none object-cover object-bottom"
          draggable={false}
        />
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
      </svg>

      {offRoute && (
        <div className="absolute inset-x-0 top-0 bg-red-600/80 py-2 text-center text-sm font-semibold">
          Past the fork: this frame is off the selected route
        </div>
      )}
      {!frame.lanePolygons && target !== null && (
        <div className="absolute bottom-2 right-3 rounded bg-black/60 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/60">
          placeholder lane geometry
        </div>
      )}
    </div>
  );
}
