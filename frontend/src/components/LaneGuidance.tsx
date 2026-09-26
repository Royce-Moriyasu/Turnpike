import type { ReactNode } from "react";
import type { NavState } from "../types";
import { describeLane, formatDistance, isUsable } from "../lanes";
import LaneStrip from "./LaneStrip";

/**
 * Which lane to be in, from Mapbox lane data: in words, as a lane diagram, and as the
 * lane index the vision layer should find boundaries for.
 */
export default function LaneGuidance({ nav }: { nav: NavState | null }) {
  if (!nav) return null;
  const lanes = nav.lanes ?? [];
  const n = lanes.length;
  const target = nav.preferredLane;
  const usable = lanes.filter(isUsable).length;
  const imminent = nav.distanceM < 150;

  let headline: ReactNode;
  let detail: string;
  if (!n) {
    headline = <>Any lane</>;
    detail = "Mapbox reports no lane restrictions before the next maneuver";
  } else if (target === null) {
    headline = <>Use a highlighted lane</>;
    detail = `${usable} of ${n} lanes continue on your route`;
  } else if (n === 1) {
    headline = <>Stay in your lane</>;
    detail = "Single lane";
  } else {
    headline = (
      <>
        Use the <span className="text-accent-soft uppercase">{describeLane(target, n)}</span>
      </>
    );
    detail =
      (usable > 1 ? `${usable - 1} other lane${usable > 2 ? "s" : ""} also allowed · ` : "Only allowed lane · ") +
      (nav.laneSource && nav.laneSource.distanceM >= 10
        ? `lanes ${formatDistance(nav.laneSource.distanceM)} ahead`
        : "lanes at this point");
  }

  return (
    <div
      className={[
        "rounded-2xl bg-surface p-4 ring-1 transition-shadow",
        imminent && n ? "ring-2 ring-accent" : "ring-white/10",
      ].join(" ")}
    >
      <div className="mb-2 text-xs uppercase tracking-widest text-white/50">Lane guidance</div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xl font-semibold">{headline}</div>
          <div className="mt-1 text-sm text-white/60">{detail}</div>
          {n > 0 && !!nav.laneReasons?.length && (
            <ul className="mt-2 space-y-1">
              {nav.laneReasons.map((reason) => (
                <li key={reason} className="flex items-start gap-2 text-sm text-accent-soft">
                  <span aria-hidden className="mt-0.5 text-xs">ⓘ</span>
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {n > 0 && <LaneStrip nav={nav} />}
      </div>
      {n > 0 && target !== null && (
        <div className="mt-3 border-t border-white/10 pt-2 font-mono text-xs text-white/50">
          vision target: lane {target + 1} of {n} from left ({n - target} from right) · index {target}
        </div>
      )}
    </div>
  );
}
