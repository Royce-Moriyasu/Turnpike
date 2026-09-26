import type { ReactNode } from "react";
import type { DemoRoute, Frame, NavState } from "../types";

interface Props {
  data: DemoRoute;
  frame: Frame;
  nav: NavState | null;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-white/5 py-1.5 last:border-0">
      <dt className="text-white/50">{label}</dt>
      <dd className="text-right tabular-nums">{children}</dd>
    </div>
  );
}

export default function DataPanel({ data, frame, nav }: Props) {
  const navCount = nav?.lanes?.length ?? 0;
  const lanePos = (i: number | null) => {
    if (i === null || !navCount) return "—";
    if (i === navCount - 1) return `${i + 1} of ${navCount} (rightmost)`;
    if (i === 0) return `1 of ${navCount} (leftmost)`;
    return `${i + 1} of ${navCount}`;
  };
  const vision = frame.lanePolygons
    ? `${frame.lanePolygons.length} lanes (labeled)`
    : navCount
      ? "placeholder geometry"
      : "—";

  return (
    <div className="rounded-2xl bg-neutral-900 p-4 text-sm ring-1 ring-white/10">
      <div className="mb-2 text-xs uppercase tracking-widest text-white/50">Public road data</div>
      <dl>
        <Row label="Position">
          {frame.lat.toFixed(5)}, {frame.lng.toFixed(5)}
        </Row>
        <Row label="Heading">{frame.heading !== null ? `${Math.round(frame.heading)}°` : "—"}</Row>
        <Row label="Route progress">{Math.round(frame.progressM)} m</Row>
        <Row label="Maneuver">
          {nav ? `${nav.maneuverType}${nav.modifier ? ` · ${nav.modifier}` : ""}` : "—"}
        </Row>
        <Row label="Lane data">
          {nav?.laneSource ? `${Math.round(nav.laneSource.distanceM)} m ahead` : "none ahead"}
        </Row>
        <Row label="Recommended lane">{lanePos(nav?.preferredLane ?? null)}</Row>
        <Row label="Vision">{vision}</Row>
        <Row label="Imagery">{frame.image ? `Mapillary ${frame.id}` : "synthetic"}</Row>
        {frame.capturedAt && <Row label="Captured">{frame.capturedAt.slice(0, 10)}</Row>}
      </dl>
      <div className="mt-3 space-y-1 text-[11px] leading-snug text-white/40">
        {data.attribution.map((a) => (
          <div key={a}>{a}</div>
        ))}
      </div>
    </div>
  );
}
