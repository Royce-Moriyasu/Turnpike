import type { NavState } from "../types";
import { arrowFor, isUsable } from "../lanes";

/** Mapbox's lanes, left to right: filled = your lane, outlined = also allowed, dimmed = wrong lane. */
export default function LaneStrip({ nav }: { nav: NavState }) {
  const lanes = nav.lanes ?? [];
  return (
    <div className="flex items-end justify-center gap-1.5">
      {lanes.map((lane, i) => {
        const preferred = i === nav.preferredLane;
        const usable = isUsable(lane);
        return (
          <div key={i} className="flex flex-col items-center gap-1">
            <div
              className={[
                "flex h-12 min-w-12 items-center justify-center rounded-lg px-2 text-2xl leading-none md:h-14 md:min-w-14",
                preferred
                  ? "bg-accent font-bold text-white shadow-[0_0_20px_var(--color-accent)] ring-2 ring-white"
                  : usable
                    ? "text-accent-soft ring-2 ring-accent-soft/60"
                    : "text-white/25 ring-1 ring-white/15",
              ].join(" ")}
              title={`${lane.indications.join(" / ")}${usable ? "" : " (not on your route)"}`}
            >
              {lane.indications.map(arrowFor).join("")}
            </div>
            <div className={`h-2 text-[10px] font-bold ${preferred ? "text-white" : "text-transparent"}`}>▲</div>
          </div>
        );
      })}
    </div>
  );
}
