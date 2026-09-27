import type { NavState } from "../types";
import { formatDistance, roadName } from "../lanes";
import LaneArrow from "./LaneArrow";
import LaneGuidance, { visionTarget } from "./LaneGuidance";
import Panel from "./Panel";

interface Props {
  nav: NavState | null;
  showLanes: boolean; // false in the "Standard GPS" view: maneuver only
  compact?: boolean; // one row: maneuver, then recommendation and lane arrows (theater mode)
}

/** The next maneuver (top row) and which lane to be in (bottom row), with the vision target as a footer. */
export default function GuidancePanel({ nav, showLanes, compact = false }: Props) {
  if (!nav) {
    return (
      <Panel title="Guidance">
        <p className="text-white/60">No guidance for this frame on the selected route.</p>
      </Panel>
    );
  }
  const imminent = showLanes && nav.distanceM < 150 && !!nav.lanes?.length;
  const footer = showLanes ? visionTarget(nav) : null;
  return (
    <Panel
      title="Guidance"
      tone={imminent ? "accent" : "default"}
      right={<span className="value text-white/50">{nav.maneuverType}{nav.modifier ? ` · ${nav.modifier}` : ""}</span>}
      bodyClassName=""
    >
      <div className={`flex items-center gap-3 p-3 ${compact ? "flex-wrap" : ""}`}>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent text-white">
          <LaneArrow indications={[nav.modifier ?? "straight"]} className="h-7 w-7" />
        </div>
        <div className="text-2xl font-semibold tabular-nums">{formatDistance(nav.distanceM)}</div>
        <div className="min-w-0 truncate text-white/80">{roadName(nav.instruction)}</div>
        {compact && showLanes && (
          <div className="ml-auto">
            <LaneGuidance nav={nav} compact />
          </div>
        )}
      </div>
      {!compact && showLanes && (
        <div className="border-t border-line p-3">
          <LaneGuidance nav={nav} />
        </div>
      )}
      {footer && !compact && <div className="value border-t border-line px-3 py-2 text-white/50">{footer}</div>}
    </Panel>
  );
}
