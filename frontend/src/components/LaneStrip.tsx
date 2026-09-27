import type { NavState } from "../types";
import { isUsable } from "../lanes";
import LaneArrow from "./LaneArrow";

/** Mapbox's lanes, left to right: filled and glowing = your lane, outlined = also allowed, dimmed = wrong lane. */
export default function LaneStrip({ nav }: { nav: NavState }) {
  const lanes = nav.lanes ?? [];
  return (
    <div className="flex items-end justify-center gap-1.5">
      {lanes.map((lane, i) => {
        const preferred = i === nav.preferredLane;
        const usable = isUsable(lane);
        return (
          <div key={i}>
            <div
              className={[
                "flex h-10 w-10 items-center justify-center rounded-lg",
                preferred
                  ? "bg-accent font-bold text-white shadow-[0_0_12px_var(--color-accent)] ring-2 ring-white"
                  : usable
                    ? "text-accent-soft ring-2 ring-accent-soft/60"
                    : "text-white/25 ring-1 ring-white/15",
              ].join(" ")}
              title={`${lane.indications.join(" / ")}${usable ? "" : " (not on your route)"}`}
            >
              <LaneArrow indications={lane.indications} className="h-7 w-7" />
            </div>
          </div>
        );
      })}
    </div>
  );
}
