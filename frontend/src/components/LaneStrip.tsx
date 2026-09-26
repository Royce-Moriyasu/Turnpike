import type { NavState } from "../types";
import { arrowFor } from "../lanes";

export default function LaneStrip({ nav }: { nav: NavState | null }) {
  const lanes = nav?.lanes;
  if (!lanes?.length) {
    return <div className="text-sm text-white/40">No lane data ahead</div>;
  }
  return (
    <div className="flex gap-1.5">
      {lanes.map((lane, i) => {
        const preferred = i === nav!.preferredLane;
        const usable = lane.active ?? lane.valid;
        return (
          <div
            key={i}
            className={[
              "flex h-12 min-w-12 flex-col items-center justify-center rounded-lg px-2 text-lg leading-none",
              preferred
                ? "bg-accent font-bold text-white shadow-[0_0_16px_var(--color-accent)]"
                : usable
                  ? "bg-white/15 text-white"
                  : "bg-white/5 text-white/30",
            ].join(" ")}
            title={lane.indications.join(" / ")}
          >
            <span>{lane.indications.map(arrowFor).join("")}</span>
          </div>
        );
      })}
    </div>
  );
}
