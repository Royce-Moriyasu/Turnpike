import type { ActiveLanes, Frame, Lane, NavState } from "./types";
import { bikeLikeLanes, laneTarget } from "./lanes";

/** Stabilize a lane decision across the frames leading to the same maneuver. */
export function laneDecision(
  frames: Frame[],
  index: number,
  routeKey: string,
  vision: ActiveLanes,
): NavState | null {
  const current = frames[index]?.nav[routeKey] ?? null;
  if (!current) return null;

  const sameDecision = (candidate: NavState | null) => candidate !== null &&
    candidate.instruction === current.instruction &&
    candidate.maneuverType === current.maneuverType &&
    candidate.modifier === current.modifier;

  // Stay within this maneuver and a short stretch of the route. A new instruction
  // starts a new decision, even when two consecutive instructions both say "right".
  const nearby: { nav: NavState; distance: number }[] = [];
  for (const direction of [-1, 1]) {
    for (let step = direction; Math.abs(step) <= 10; step += direction) {
      const frame = frames[index + step];
      if (!frame || Math.abs(frame.progressM - frames[index].progressM) > 180) break;
      const nav = frame.nav[routeKey] ?? null;
      if (!sameDecision(nav)) break;
      if (nav?.lanes?.length && nav.preferredLane !== null) nearby.push({ nav, distance: Math.abs(step) });
    }
  }
  if (current.lanes?.length && current.preferredLane !== null) nearby.push({ nav: current, distance: 0 });
  nearby.sort((a, b) => b.nav.lanes!.length - a.nav.lanes!.length || a.distance - b.distance);
  const reference = nearby[0]?.nav;
  if (!reference?.lanes?.length || reference.preferredLane === null) return current;

  let lanes = reference.lanes;
  let preferred: number | null = reference.preferredLane;
  const visible = vision.polygons?.length ?? 0;
  const travel = visible - bikeLikeLanes(vision.polygons ?? [], lanes.length, vision.source === "yolop").size;
  // YOLOPv2 may reveal lanes that Mapbox has not counted yet. Require reasonably
  // confident geometry, then treat the Mapbox lanes as the maneuver-side subset.
  if (travel > lanes.length && (vision.confidence ?? 0) >= 0.5) {
    const extra = travel - lanes.length;
    const filler = (lane: Lane): Lane => ({ ...lane, indications: [...lane.indications] });
    if (reference.laneSide === "left") {
      lanes = [...lanes, ...Array.from({ length: extra }, () => filler(lanes[lanes.length - 1]))];
    } else {
      lanes = [...Array.from({ length: extra }, () => filler(lanes[0])), ...lanes];
      preferred += extra;
    }
  }

  // A Mapbox lane recommendation is not a detected road overlay. If YOLOPv2 has
  // no usable polygon for the target, do not instruct the driver into an unseen lane.
  if (vision.source === "yolop" &&
      (!vision.polygons || laneTarget(preferred, lanes.length, vision.polygons, reference.laneSide, true).index === null)) {
    preferred = null;
  }
  if (lanes === current.lanes && preferred === current.preferredLane) return current;
  return { ...current, lanes, preferredLane: preferred, laneSide: reference.laneSide };
}
