import { useEffect, useState, type ReactNode } from "react";
import type { DemoRoute } from "../types";
import { describeLane, laneTarget, lanesFromLines, DEFAULT_HORIZON_Y } from "../lanes";
import { currentClip, demoUrl } from "../clips";
import { IMG_H, IMG_W, type LabelFile } from "./labels";

// Read-only review of a clip's detected lanes (clips/<clip>/detected_lanes.json or yolop_lanes.json,
// see vision/README.md) frame by
// frame, against the hand-traced lanes where they exist.

const CLIP = currentClip();
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

// ---- YOLOPv2 masks (vision/yolop_masks.py), served by the dev server ----
const YOLOP_VIEW = "band";
const maskUrl = (kind: "lane" | "drivable", id: string) => `/__yolop/${CLIP}/${YOLOP_VIEW}/${kind}/${id}.png`;
const COVER_TOL = 15; // px either side of a traced line
const COVER_MIN = 0.6; // share of a traced line's rows the mask must hit to count as covered

function loadMask(url: string): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, c.width, c.height));
    };
    img.onerror = reject;
    img.src = url;
  });
}

/** Transparent image, colored where the (grayscale) mask is >= 128. */
function tint(mask: ImageData, [r, g, b, a]: number[]): string {
  const out = new ImageData(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i += 4) {
    if (mask.data[i] >= 128) out.data.set([r, g, b, a], i);
  }
  const c = document.createElement("canvas");
  c.width = mask.width;
  c.height = mask.height;
  c.getContext("2d")!.putImageData(out, 0, 0);
  return c.toDataURL("image/png");
}

/** How many on-screen traced lines the lane mask sits on (same test as the Python check). */
function coverage(mask: ImageData, traced: Line[], rows: number[]) {
  const { width: w, height: h, data } = mask;
  let covered = 0;
  let total = 0;
  for (const b of traced) {
    const pts = b.x.map((x, j) => [x, rows[j]] as const).filter(([x]) => x !== null && x > 0.01 && x < 0.99);
    if (pts.length < 2) continue;
    total++;
    const hits = pts.filter(([x, r]) => {
      const y = Math.min(h - 1, Math.floor(r * h));
      const cx = Math.floor(x! * w);
      for (let px = Math.max(0, cx - COVER_TOL); px < Math.min(w, cx + COVER_TOL); px++) {
        if (data[(y * w + px) * 4] >= 128) return true;
      }
      return false;
    }).length;
    if (hits / pts.length >= COVER_MIN) covered++;
  }
  return { covered, total };
}

interface YolopState {
  status: "loading" | "ok" | "missing";
  lane?: string;
  drivable?: string;
  covered?: number;
  total?: number;
}

function useYolop(frameId: string | undefined, traced: Line[] | null, rows: number[] | undefined): YolopState {
  const [state, setState] = useState<YolopState>({ status: "loading" });
  useEffect(() => {
    if (!frameId || !rows) return;
    let cancelled = false;
    setState({ status: "loading" });
    Promise.all([loadMask(maskUrl("lane", frameId)), loadMask(maskUrl("drivable", frameId))])
      .then(([lane, drivable]) => {
        if (cancelled) return;
        setState({
          status: "ok",
          lane: tint(lane, [234, 67, 53, 210]),
          drivable: tint(drivable, [52, 168, 83, 80]),
          ...(traced ? coverage(lane, traced, rows) : {}),
        });
      })
      .catch(() => !cancelled && setState({ status: "missing" }));
    return () => {
      cancelled = true;
    };
  }, [frameId, traced, rows]);
  return state;
}
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
  const [show, setShow] = useState({ cv: true, labels: true, target: true, yolop: true, drivable: false });
  // Which detected lines to review: YOLOPv2-based (vision/yolop_lanes.py) or OpenCV (detect_lanes.py).
  const [detSource, setDetSource] = useState<"yolop" | "opencv">("yolop");

  useEffect(() => {
    fetch(demoUrl(CLIP)).then((r) => r.json()).then(setData);
    fetch(`/__labels?clip=${CLIP}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((f) => f?.frames && setLabels(f));
  }, []);

  useEffect(() => {
    setError(null);
    fetch(`/__detected?clip=${CLIP}&source=${detSource}`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(await r.text())))
      .then(setCv)
      .catch((e) => setError(String(e)));
  }, [detSource]);

  useEffect(() => history.replaceState(null, "", `#cv=${index + 1}`), [index]);

  const count = data?.frames.length ?? 0;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setIndex((i) => Math.min(count - 1, i + 1));
      else if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
      else if (e.key.toLowerCase() === "l") setShow((s) => ({ ...s, labels: !s.labels }));
      else if (e.key.toLowerCase() === "c") setShow((s) => ({ ...s, cv: !s.cv }));
      else if (e.key.toLowerCase() === "y") setShow((s) => ({ ...s, yolop: !s.yolop }));
      else if (e.key.toLowerCase() === "d") setShow((s) => ({ ...s, drivable: !s.drivable }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count]);

  const currentId = data?.frames[index]?.id;
  const yolop = useYolop(currentId, (currentId && labels?.frames[currentId]?.boundaries) || null, cv?.rows);

  if (error)
    return (
      <div className="mx-auto max-w-xl p-10 text-white/80">
        <h1 className="mb-3 text-2xl font-semibold">No CV output</h1>
        <p className="mb-3 text-sm">{error}</p>
        <button
          className="mr-4 rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
          onClick={() => setDetSource(detSource === "yolop" ? "opencv" : "yolop")}
        >
          Review {detSource === "yolop" ? "OpenCV" : "YOLOPv2"} lines instead
        </button>
        <a href="#" className="text-accent-soft hover:underline">← back to app</a>
      </div>
    );
  if (!data || !cv) return <div className="p-10 text-white/50">Loading…</div>;

  // Road crop: from a little above the clip's horizon (SR 70: 0.62), as in the labeling tool.
  const horizonY = data.camera?.horizonY ?? DEFAULT_HORIZON_Y;
  const TOP = Math.max(0, horizonY - 0.155);
  // the box takes the photos' shape (overlays below are drawn in IMG_W x IMG_H units, stretched to fit)
  const size = data.camera?.imageSize;
  const aspect = size ? size[0] / size[1] : IMG_W / IMG_H;

  const frame = data.frames[index];
  const det = cv.frames[frame.id];
  const traced = labels?.frames[frame.id]?.boundaries ?? null;
  const rows = cv.rows;
  const nav = frame.nav[routeKey];
  const navCount = nav?.lanes?.length ?? 0;
  const cvLanes = Math.max(0, (det?.boundaries.length ?? 0) - 1);
  const { index: target, excluded, upcoming } =
    det && nav && nav.preferredLane !== null && navCount && cvLanes
      ? laneTarget(nav, lanesFromLines(det.boundaries, rows), horizonY)
      : { index: null, excluded: new Set<number>(), upcoming: new Set<number>() };
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
        <div className="flex flex-wrap items-center gap-4 text-sm text-white/60">
          <div className="flex rounded-lg bg-white/5 p-1" role="group" aria-label="Detected lines to review">
            {(["yolop", "opencv"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setDetSource(k)}
                aria-pressed={detSource === k}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                  detSource === k ? "bg-accent text-white" : "text-white/60 hover:text-white"
                }`}
              >
                {k === "yolop" ? "YOLOPv2 lines" : "OpenCV lines"}
              </button>
            ))}
          </div>
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
        style={{ aspectRatio: aspect / (1 - TOP) }}
      >
        {frame.image && (
          <img src={frame.image} alt="" className="absolute inset-0 h-full w-full object-cover object-bottom" />
        )}
        {show.drivable && yolop.drivable && (
          <img src={yolop.drivable} alt="" className="pointer-events-none absolute inset-0 h-full w-full object-cover object-bottom" />
        )}
        {show.yolop && yolop.lane && (
          <img src={yolop.lane} alt="" className="pointer-events-none absolute inset-0 h-full w-full object-cover object-bottom" />
        )}
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox={`0 ${TOP * IMG_H} ${IMG_W} ${(1 - TOP) * IMG_H}`}
          preserveAspectRatio="none"
        >
          {rows.map((r) => (
            <line key={r} x1={0} x2={IMG_W} y1={r * IMG_H} y2={r * IMG_H} stroke="white" strokeOpacity={0.15} strokeDasharray="12 10" strokeWidth={2} />
          ))}
          {show.target &&
            det &&
            [...excluded, ...upcoming].map((k) => {
              const poly = lanePoly(det.boundaries[k], det.boundaries[k + 1]);
              return poly ? <polygon key={`bike${k}`} points={poly} fill="#fbbc04" fillOpacity={0.3} /> : null;
            })}
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
          <span style={{ color: "#ff6d00" }}>━ {detSource === "yolop" ? "YOLOPv2" : "OpenCV"} line (conf)</span>
          <span className="text-accent-soft">┅ hand-traced</span>
          <span className="text-accent">▮ CV lane the demo would highlight</span>
          <span style={{ color: "#ea4335" }}>▮ YOLOPv2 lane mask</span>
          <span style={{ color: "#fbbc04" }}>▮ bike lane/shoulder (not counted)</span>
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
            {toggle("yolop", "YOLOPv2 lanes", "Y")}
            {toggle("drivable", "YOLOPv2 drivable", "D")}
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
              {excluded.size > 0 && (
                <Row label="Not counted">
                  {[...excluded].map((k) => `CV lane ${k + 1}`).join(", ")} (bike lane/shoulder)
                </Row>
              )}
              {upcoming.size > 0 && (
                <Row label="Not counted yet">
                  {[...upcoming].map((k) => `CV lane ${k + 1}`).join(", ")} (turn lane opening ahead)
                </Row>
              )}
              <Row label="Would highlight">{target !== null ? `CV lane ${target + 1}` : "nothing"}</Row>
              <Row label={`${detSource === "yolop" ? "YOLOPv2" : "OpenCV"} lines vs traced`}>
                {cmp
                  ? `${cmp.matched}/${cmp.total} lines matched${cmp.meanPx !== null ? `, ${cmp.meanPx.toFixed(1)} px off` : ""}${cmp.extra ? `, ${cmp.extra} extra` : ""}`
                  : "not traced"}
              </Row>
              <Row label="YOLOPv2 mask vs traced">
                {yolop.status === "loading"
                  ? "…"
                  : yolop.status === "missing"
                    ? "no mask: run vision/yolop_masks.py"
                    : yolop.total !== undefined
                      ? `${yolop.covered}/${yolop.total} lines covered`
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
