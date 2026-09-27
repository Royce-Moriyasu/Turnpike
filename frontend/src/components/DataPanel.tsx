import type { ReactNode } from "react";
import type { ActiveLanes, Frame, NavState } from "../types";
import Panel from "./Panel";

interface Props {
  frame: Frame;
  nav: NavState | null;
  lanes: ActiveLanes;
  className?: string;
}

// The bake uses a frame's detected lanes when their confidence is at least this (vision/README.md).
const LOW_CONFIDENCE = 0.6;

function Section({ title, badge, children }: { title: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <div className="border-b border-line last:border-0">
      <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-2">
        <span className="label">{title}</span>
        {badge}
      </div>
      <dl className="pb-1">{children}</dl>
    </div>
  );
}

function Row({ label, children, tone }: { label: string; children: ReactNode; tone?: "warn" | "muted" }) {
  const color = tone === "warn" ? "text-amber-300" : tone === "muted" ? "text-white/40" : "text-white/90";
  return (
    <div className="flex items-baseline justify-between gap-3 px-3 py-1 odd:bg-white/[0.02]">
      <dt className="shrink-0 text-white/50">{label}</dt>
      <dd className={`value min-w-0 truncate text-right ${color}`}>{children}</dd>
    </div>
  );
}

function WarnBadge({ children, title }: { children: ReactNode; title: string }) {
  return (
    <span title={title} className="rounded border border-amber-400/40 bg-amber-400/10 px-1.5 text-[11px] font-medium text-amber-300">
      ⚠ {children}
    </span>
  );
}

export default function DataPanel({ frame, nav, lanes, className }: Props) {
  const navCount = nav?.lanes?.length ?? 0;
  const lanePos = (i: number | null) => {
    if (i === null || !navCount) return "—";
    if (i === navCount - 1) return `${i + 1} of ${navCount} (rightmost)`;
    if (i === 0) return `1 of ${navCount} (leftmost)`;
    return `${i + 1} of ${navCount}`;
  };
  const seen = lanes.polygons?.length ?? null;
  const mismatch = seen !== null && navCount > 0 && seen !== navCount;
  const lowConfidence = lanes.confidence != null && lanes.confidence < LOW_CONFIDENCE;

  return (
    <Panel title="Public road data" className={className} bodyClassName="overflow-y-auto">
      <Section title="Location">
        <Row label="Position">{frame.lat.toFixed(5)}, {frame.lng.toFixed(5)}</Row>
        <Row label="Heading">{frame.heading !== null ? `${Math.round(frame.heading)}°` : "—"}</Row>
        <Row label="Route progress">{Math.round(frame.progressM)} m</Row>
      </Section>
      <Section title="Guidance">
        <Row label="Maneuver">{nav ? `${nav.maneuverType}${nav.modifier ? ` · ${nav.modifier}` : ""}` : "—"}</Row>
        <Row label="Lane data" tone={nav?.laneSource ? undefined : "muted"}>
          {nav?.laneSource ? `${Math.round(nav.laneSource.distanceM)} m ahead` : "none ahead"}
        </Row>
        <Row label="Recommended lane">{lanePos(nav?.preferredLane ?? null)}</Row>
      </Section>
      <Section
        title="Vision"
        badge={mismatch && (
          <WarnBadge title={`Vision sees ${seen} lanes, Mapbox lists ${navCount}`}>{seen} vs {navCount} lanes</WarnBadge>
        )}
      >
        <Row label="Lanes" tone={seen === null ? "muted" : mismatch ? "warn" : undefined}>
          {seen !== null ? `${seen} detected` : navCount ? "none detected" : "—"}
        </Row>
        <Row label="Model">{lanes.label}</Row>
        <Row label="Confidence" tone={lanes.confidence == null ? "muted" : lowConfidence ? "warn" : undefined}>
          {lanes.confidence != null ? lanes.confidence.toFixed(2) : "—"}
        </Row>
      </Section>
      <Section title="Source">
        <Row label="Imagery">{frame.image ? `Mapillary ${frame.id}` : "synthetic"}</Row>
        <Row label="Captured" tone={frame.capturedAt ? undefined : "muted"}>{frame.capturedAt?.slice(0, 10) ?? "—"}</Row>
      </Section>
    </Panel>
  );
}
