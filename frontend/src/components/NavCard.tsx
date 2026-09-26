import type { NavState } from "../types";
import { arrowFor, formatDistance } from "../lanes";

export default function NavCard({ nav }: { nav: NavState | null }) {
  if (!nav) {
    return (
      <div className="rounded-2xl bg-surface p-4 text-white/60 ring-1 ring-white/10">
        No guidance for this frame on the selected route.
      </div>
    );
  }
  return (
    <div className="flex items-center gap-4 rounded-2xl bg-surface p-4 ring-1 ring-white/10">
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-accent text-3xl font-bold text-white">
        {arrowFor(nav.modifier ?? "straight")}
      </div>
      <div className="min-w-0">
        <div className="text-2xl font-semibold tabular-nums">{formatDistance(nav.distanceM)}</div>
        <div className="truncate text-white/80">{nav.instruction}</div>
      </div>
    </div>
  );
}
