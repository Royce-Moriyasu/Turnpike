import type { ReactNode } from "react";
import type { NavState } from "../types";
import { describeLane, formatDistance, isUsable, roadName } from "../lanes";
import LaneStrip from "./LaneStrip";

/**
 * Which lane to be in, from Mapbox lane data: in words and as a lane diagram. The panel around it
 * is GuidancePanel; visionTarget() is its debug footer.
 */
export default function LaneGuidance({ nav, compact = false }: { nav: NavState; compact?: boolean }) {
  const lanes = nav.lanes ?? [];
  const n = lanes.length;
  const target = nav.preferredLane;
  const usable = lanes.filter(isUsable).length;

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

  if (compact) {
    // one row: the recommendation and the lane arrows (theater mode)
    return (
      <div className="flex items-center gap-4">
        <div className="text-base font-semibold whitespace-nowrap">{headline}</div>
        {n > 0 && <LaneStrip nav={nav} />}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-base font-semibold">{headline}</div>
        <div className="mt-1 text-white/60">{detail}</div>
        {n > 0 && !!nav.laneReasons?.length && (
          <ul className="mt-2 space-y-1">
            {nav.laneReasons.map((reason) => (
              <li key={reason} className="flex items-start gap-2 text-accent-soft">
                <span aria-hidden className="text-xs">ⓘ</span>
                <span>{roadName(reason)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {n > 0 && <LaneStrip nav={nav} />}
    </div>
  );
}

/** "vision target: lane 1 of 2 from left (2 from right) · index 0", or null without a target. */
export function visionTarget(nav: NavState): string | null {
  const n = nav.lanes?.length ?? 0;
  const t = nav.preferredLane;
  return n > 0 && t !== null ? `vision target: lane ${t + 1} of ${n} from left (${n - t} from right) · index ${t}` : null;
}
