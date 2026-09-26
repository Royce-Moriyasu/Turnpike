import { useEffect, useState, type ReactNode } from "react";
import type { DemoRoute } from "../types";
import { describeLane, polygonIndexFor } from "../lanes";
import { IMG_H, IMG_W, type LabelFile } from "./labels";

// Read-only review of the OpenCV output (data/detected_lanes.json, see vision/README.md) frame by
// frame, against the hand-traced lanes where they exist.

const TOP = 0.62; // same road crop as the labeling tool
const GOOD = 0.6; // confidence the bake is expected to trust
const MATCH_MAX = 0.06; // a CV line farther than this (0-1) from a traced line doesn't count as a match

interface CvBoundary {
  x: (number | null)[];
  type: "solid" | "dashed";
  color: "white" | "yellow";
  confidence: number;
}
interface CvFrame {
  confidence: number;
  boundaries: CvBoundary[];
  debug?: Record<string, unknown>;
}
interface CvFile {
  method: string;
  generatedAt: string;
  rows: number[];
  frames: Record<string, CvFrame>;
}
type Line = { x: (number | null)[] };

const frameFromHash = () => Math.max(1, Number(location.hash.split("=")[1]) || 1) - 1;
const confColor = (c: number) => (c >= GOOD ? "#34a853" : c >= 0.3 ? "#fbbc04" : "#ea4335");
const bottomX = (b: Line) => b.x.slice(0, 3).find((x) => x !== null) ?? null;

/** Match each traced line to the nearest unused CV line; mean error in 2048-px, plus misses/extras. */
function compare(truth: Line[], cv: Line[]) {
  const visible = truth.filter((b) => {
    const x = bottomX(b);
    return x !== null && x > -0.05 && x < 1.05;
  });
  const used = new Set<number>();
  const errs: number[] = [];
  for (const t of visible) {
    let best: [number, number] | null = null;
    cv.forEach((c, j) => {
      if (used.has(j)) return;
      const common = t.x.map((_, k) => k).filter((k) => t.x[k] !== null && c.x[k] !== null);
      if (!common.length) return;
      const e = common.reduce((s, k) => s + Math.abs(t.x[k]! - c.x[k]!), 0) / common.length;
      if (!best || e < best[0]) best = [e, j];
    });
    if (best && best[0] < MATCH_MAX) {
      used.add(best[1]);
      errs.push(best[0] * IMG_W);
    }
  }
  return {
    matched: errs.length,
    total: visible.length,
    meanPx: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null,
    extra: cv.length - used.size,
  };
}

export default function CvReview() {
  const [data, setData] = useState<DemoRoute | null>(null);
  const [cv, setCv] = useState<CvFile | null>(null);
  const [labels, setLabels] = useState<LabelFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(frameFromHash);
  const [routeKey, setRouteKey] = useState("north");
  const [show, setShow] = useState({ cv: true, labels: true, target: true });

  useEffect(() => {
    fetch("/demo_route.json").then((r) => r.json()).then(setData);
    fetch("/__detected")
      .then(async (r) => (r.ok ? r.json() : Promise.reject(await r.text())))
      .then(setCv)
      .catch((e) => setError(String(e)));
    fetch("/__labels")
      .then((r) => (r.ok ? r.json() : null))
      .then((f) => f?.frames && setLabels(f));
  }, []);

  useEffect(() => history.replaceState(null, "", `#cv=${index + 1}`), [index]);

  const count = data?.frames.length ?? 0;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setIndex((i) => Math.min(count - 1, i + 1));
      else if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
      else if (e.key.toLowerCase() === "l") setShow((s) => ({ ...s, labels: !s.labels }));
      else if (e.key.toLowerCase() === "c") setShow((s) => ({ ...s, cv: !s.cv }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count]);

  if (error)
    return (
      <div className="mx-auto max-w-xl p-10 text-white/80">
        <h1 className="mb-3 text-2xl font-semibold">No CV output</h1>
        <p className="mb-3 text-sm">{error}</p>
        <a href="#" className="text-accent-soft hover:underline">← back to app</a>
      </div>
    );
  if (!data || !cv) return <div className="p-10 text-white/50">Loading…</div>;

  const frame = data.frames[index];
  const det = cv.frames[frame.id];
  const traced = labels?.frames[frame.id]?.boundaries ?? null;
  const rows = cv.rows;
  const nav = frame.nav[routeKey];
  const navCount = nav?.lanes?.length ?? 0;
  const cvLanes = Math.max(0, (det?.boundaries.length ?? 0) - 1);
  const target =
    nav && nav.preferredLane !== null && navCount && cvLanes
      ? polygonIndexFor(nav.preferredLane, navCount, cvLanes, nav.laneSide)
      : null;
  const cmp = det && traced ? compare(traced, det.boundaries) : null;

  const allConf = data.frames.map((f) => cv.frames[f.id]?.confidence ?? null);
  const scored = allConf.filter((c): c is number => c !== null);
  const pts = (b: Line, rs: number[]) =>
    b.x
      .map((x, j) => (x === null ? null : `${x * IMG_W},${rs[j] * IMG_H}`))
      .filter(Boolean)
      .join(" ");
  const lanePoly = (l: CvBoundary, r: CvBoundary) => {
    const both = rows.map((_, j) => j).filter((j) => l.x[j] !== null && r.x[j] !== null);
    if (both.length < 2) return null;
    return [
      ...both.map((j) => `${l.x[j]! * IMG_W},${rows[j] * IMG_H}`),
      ...[...both].reverse().map((j) => `${r.x[j]! * IMG_W},${rows[j] * IMG_H}`),
    ].join(" ");
  };
  const toggle = (k: keyof typeof show, label: string, key: string) => (
    <label className="flex cursor-pointer items-center gap-1.5 text-sm text-white/80">
      <input type="checkbox" checked={show[k]} onChange={() => setShow((s) => ({ ...s, [k]: !s[k] }))} />
      {label} <span className="text-white/40">({key})</span>
    </label>
  );

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">
          CV <span className="text-accent">review</span>
        </h1>
        <div className="flex items-center gap-4 text-sm text-white/60">
          <span>
            {cv.method} · {scored.filter((c) => c >= GOOD).length}/{count} frames ≥ {GOOD}
          </span>
          <a href={`#label=${index + 1}`} className="text-accent-soft hover:underline">label this frame</a>
          <a href="#" className="text-accent-soft hover:underline">← back to app</a>
        </div>
      </header>

      {/* Confidence of every frame; click to jump. Dot = hand-traced frame. */}
      <div className="flex gap-0.5">
        {data.frames.map((f, i) => {
          const c = allConf[i];
          return (
            <button
              key={f.id}
              onClick={() => setIndex(i)}
              title={`Frame ${i + 1}: ${c === null ? "no CV entry" : `confidence ${c.toFixed(2)}`}`}
              className={`relative h-8 flex-1 rounded-sm ${i === index ? "ring-2 ring-white" : ""}`}
              style={{ background: c === null ? "#3c4043" : confColor(c), opacity: i === index ? 1 : 0.75 }}
            >
              {labels?.frames[f.id] && <span className="absolute inset-x-0 bottom-0.5 text-[9px] text-black">●</span>}
            </button>
          );
        })}
      </div>

      <div
        className="relative overflow-hidden rounded-xl bg-black ring-1 ring-white/10"
        style={{ aspectRatio: IMG_W / (IMG_H * (1 - TOP)) }}
      >
        {frame.image && (
          <img src={frame.image} alt="" className="absolute inset-0 h-full w-full object-cover object-bottom" />
        )}
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox={`0 ${TOP * IMG_H} ${IMG_W} ${(1 - TOP) * IMG_H}`}
          preserveAspectRatio="none"
        >
          {rows.map((r) => (
            <line key={r} x1={0} x2={IMG_W} y1={r * IMG_H} y2={r * IMG_H} stroke="white" strokeOpacity={0.15} strokeDasharray="12 10" strokeWidth={2} />
          ))}
          {show.target && det && target !== null && lanePoly(det.boundaries[target], det.boundaries[target + 1]) && (
            <polygon
              points={lanePoly(det.boundaries[target], det.boundaries[target + 1])!}
              fill="var(--color-accent)"
              fillOpacity={0.5}
              stroke="var(--color-accent-soft)"
              strokeWidth={5}
            />
          )}
          {show.labels &&
            traced?.map((b, i) => (
              <polyline key={`gt${i}`} points={pts(b, rows)} fill="none" stroke="var(--color-accent-soft)" strokeWidth={4} strokeDasharray="6 8" />
            ))}
          {show.cv &&
            det?.boundaries.map((b, i) => {
              const bottom = b.x.findIndex((x) => x !== null);
              const color = b.color === "yellow" ? "#fbbc04" : "#ff6d00";
              return (
                <g key={`cv${i}`}>
                  <polyline
                    points={pts(b, rows)}
                    fill="none"
                    stroke={color}
                    strokeWidth={7}
                    strokeDasharray={b.type === "dashed" ? "28 14" : undefined}
                  />
                  {bottom !== -1 && (
                    <text
                      x={Math.min(0.93, Math.max(0.04, b.x[bottom]!)) * IMG_W}
                      y={rows[bottom] * IMG_H - 14}
                      textAnchor="middle"
                      fill={color}
                      stroke="black"
                      strokeWidth={6}
                      paintOrder="stroke"
                      fontSize={34}
                      fontWeight={700}
                    >
                      {b.confidence.toFixed(2)}
                    </text>
                  )}
                </g>
              );
            })}
        </svg>
        <div className="absolute left-3 top-3 flex gap-3 rounded-md bg-black/60 px-2 py-1 text-xs">
          <span style={{ color: "#ff6d00" }}>━ CV line (conf)</span>
          <span className="text-accent-soft">┅ hand-traced</span>
          <span className="text-accent">▮ CV lane the demo would highlight</span>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <button className="rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20" onClick={() => setIndex(Math.max(0, index - 1))}>
              ◀ Prev
            </button>
            <span className="w-16 text-center text-sm tabular-nums text-white/70">
              {index + 1}/{count}
            </span>
            <button className="rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20" onClick={() => setIndex(Math.min(count - 1, index + 1))}>
              Next ▶
            </button>
            {toggle("cv", "CV lines", "C")}
            {toggle("labels", "Hand-traced", "L")}
            {toggle("target", "Target lane", "")}
          </div>
          <p className="text-xs text-white/40">
            Strip: green ≥ {GOOD}, amber ≥ 0.3, red below; ● marks hand-traced frames. CV output from {cv.generatedAt}.
            Re-run <code>python vision/detect_lanes.py</code> and refresh to see changes.
          </p>
        </div>

        <div className="space-y-2 rounded-2xl bg-surface p-4 text-sm ring-1 ring-white/10">
          <div className="flex rounded-lg bg-white/5 p-1">
            {Object.entries(data.routes).map(([key, r]) => (
              <button
                key={key}
                onClick={() => setRouteKey(key)}
                className={`flex-1 rounded-md px-2 py-1 text-xs font-medium ${key === routeKey ? "bg-accent text-white" : "text-white/70"}`}
              >
                {r.label.split(" · ")[0]}
              </button>
            ))}
          </div>
          {!det ? (
            <p className="text-white/60">No CV entry for this frame.</p>
          ) : (
            <>
              <Row label="Frame confidence">
                <span style={{ color: confColor(det.confidence) }}>{det.confidence.toFixed(2)}</span>
              </Row>
              {"reason" in (det.debug ?? {}) && (
                <p className="text-xs text-amber-300/80">{String(det.debug!.reason)}</p>
              )}
              <Row label="CV lines → lanes">
                {det.boundaries.length} → {cvLanes}
              </Row>
              <Row label="Mapbox target">
                {nav?.preferredLane != null && navCount ? `Lane ${nav.preferredLane + 1} of ${navCount} (${describeLane(nav.preferredLane, navCount)})` : "—"}
              </Row>
              <Row label="Would highlight">{target !== null ? `CV lane ${target + 1}` : "nothing"}</Row>
              <Row label="vs hand-traced">
                {cmp
                  ? `${cmp.matched}/${cmp.total} lines matched${cmp.meanPx !== null ? `, ${cmp.meanPx.toFixed(1)} px off` : ""}${cmp.extra ? `, ${cmp.extra} extra` : ""}`
                  : "not traced"}
              </Row>
              <div className="mt-2 space-y-1 border-t border-white/10 pt-2 font-mono text-xs text-white/60">
                {det.boundaries.map((b, i) => (
                  <div key={i}>
                    line {i + 1}: {b.color} {b.type} · conf {b.confidence.toFixed(2)} · bottom x{" "}
                    {bottomX(b)?.toFixed(2) ?? "—"}
                  </div>
                ))}
                {det.debug && (
                  <div className="pt-1 text-white/40">
                    {Object.entries(det.debug)
                      .filter(([k]) => k !== "reason")
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(" · ")}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-white/50">{label}</span>
      <span className="text-right tabular-nums">{children}</span>
    </div>
  );
}
