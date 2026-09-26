import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import type { DemoRoute } from "../types";
import { describeLane, laneTarget, lanesFromLines } from "../lanes";
import {
  bottomX,
  emptyLabelFile,
  serialize,
  withRows,
  IMG_H,
  IMG_W,
  ROWS,
  type Boundary,
  type LabelFile,
  type Pt,
} from "./labels";

// Show the road only; the horizon is at ~0.775 so everything useful is below this.
const TOP = 0.62;
// UI frame numbers (1-based) that matter most for the demo.
const HERO_FRAMES = [1, 21, 22, 23, 24, 25, 26, 28, 40];

const frameFromHash = () => Math.max(1, Number(location.hash.split("=")[1]) || 1) - 1;

export default function LabelTool() {
  const [data, setData] = useState<DemoRoute | null>(null);
  const [file, setFile] = useState<LabelFile>(emptyLabelFile);
  const [loaded, setLoaded] = useState(false);
  const [apiOk, setApiOk] = useState(true);
  const [index, setIndex] = useState(frameFromHash);
  const [active, setActive] = useState<number | null>(null);
  const [routeKey, setRouteKey] = useState("north");
  const [status, setStatus] = useState("");

  useEffect(() => {
    fetch("/demo_route.json").then((r) => r.json()).then(setData);
    fetch("/__labels")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((f: LabelFile) => {
        if (!f.frames) return;
        // Recompute row samples so older labels pick up any change to the sampling rules.
        const frames = Object.fromEntries(
          Object.entries(f.frames).map(([id, fr]) => [id, { ...fr, boundaries: fr.boundaries.map(withRows) }]),
        );
        setFile({ ...f, frames });
      })
      .catch(() => {
        setApiOk(false);
        setStatus("Dev API unavailable: use Download JSON");
      })
      .finally(() => setLoaded(true));
  }, []);

  // Autosave to data/fallback_lanes.json on every change (and once on load, which writes back
  // recomputed row samples for existing labels).
  useEffect(() => {
    if (!loaded || !apiOk) return;
    setStatus("Saving…");
    const t = setTimeout(() => {
      fetch("/__labels", { method: "PUT", body: serialize(file) })
        .then((r) => setStatus(r.ok ? "Saved ✓" : "Save failed"))
        .catch(() => setStatus("Save failed"));
    }, 400);
    return () => clearTimeout(t);
  }, [file, loaded, apiOk]);

  useEffect(() => history.replaceState(null, "", `#label=${index + 1}`), [index]);

  const frames = data?.frames ?? [];
  const frame = frames[index];
  const lines = (frame && file.frames[frame.id]?.boundaries) || [];

  const setLines = useCallback(
    (fn: (bs: Boundary[]) => Boundary[]) => {
      if (!frame) return;
      setFile((f) => {
        const next = fn(f.frames[frame.id]?.boundaries ?? []).map(withRows);
        const out = { ...f.frames };
        if (next.length) out[frame.id] = { confidence: 1, boundaries: next };
        else delete out[frame.id];
        return { ...f, frames: out };
      });
    },
    [frame],
  );

  const finishLine = useCallback(() => {
    if (active !== null && lines[active] && lines[active].points.length < 2) {
      setLines((bs) => bs.filter((_, i) => i !== active));
    }
    setActive(null);
  }, [active, lines, setLines]);

  const goTo = useCallback(
    (i: number) => {
      finishLine();
      setIndex(Math.max(0, Math.min(frames.length - 1, i)));
    },
    [finishLine, frames.length],
  );

  const undo = useCallback(() => {
    const target = active ?? lines.length - 1;
    if (target < 0) return;
    const remaining = lines[target].points.length - 1;
    setLines((bs) =>
      remaining > 0
        ? bs.map((b, i) => (i === target ? { ...b, points: b.points.slice(0, -1) } : b))
        : bs.filter((_, i) => i !== target),
    );
    setActive(remaining > 0 ? target : null);
  }, [active, lines, setLines]);

  const deleteLine = useCallback(() => {
    if (active === null) return;
    setLines((bs) => bs.filter((_, i) => i !== active));
    setActive(null);
  }, [active, setLines]);

  const restyle = useCallback(
    (fn: (b: Boundary) => Boundary) => {
      const target = active ?? lines.length - 1;
      if (target >= 0) setLines((bs) => bs.map((b, i) => (i === target ? fn(b) : b)));
    },
    [active, lines.length, setLines],
  );

  const copyPrevious = useCallback(() => {
    const prev = frames[index - 1] && file.frames[frames[index - 1].id];
    if (!prev) return;
    setLines(() => prev.boundaries.map((b) => ({ ...b, points: b.points.map((p) => [...p] as Pt) })));
    setActive(null);
  }, [frames, index, file.frames, setLines]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const k = e.key.toLowerCase();
      if (k === "enter" || k === "escape") finishLine();
      else if (k === "backspace" || k === "z") undo();
      else if (k === "delete") deleteLine();
      else if (k === "s") restyle((b) => ({ ...b, type: b.type === "solid" ? "dashed" : "solid" }));
      else if (k === "y") restyle((b) => ({ ...b, color: b.color === "yellow" ? "white" : "yellow" }));
      else if (k === "c") copyPrevious();
      else if (k === "arrowright") goTo(index + 1);
      else if (k === "arrowleft") goTo(index - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finishLine, undo, deleteLine, restyle, copyPrevious, goTo, index]);

  if (!data || !frame) return <div className="p-10 text-white/50">Loading…</div>;

  const onImageClick = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const pt: Pt = [
      +((e.clientX - r.left) / r.width).toFixed(4),
      +(TOP + ((e.clientY - r.top) / r.height) * (1 - TOP)).toFixed(4),
    ];
    if (active === null) {
      const style = lines[lines.length - 1];
      setLines((bs) => [
        ...bs,
        { x: [], type: style?.type ?? "dashed", color: style?.color ?? "white", confidence: 1, points: [pt] },
      ]);
      setActive(lines.length);
    } else {
      setLines((bs) => bs.map((b, i) => (i === active ? { ...b, points: [...b.points, pt] } : b)));
    }
  };

  // Lanes are the gaps between consecutive lines, left to right.
  const order = lines.map((_, i) => i).sort((a, b) => bottomX(lines[a]) - bottomX(lines[b]));
  const visibleLanes = Math.max(0, order.length - 1);
  const nav = frame.nav[routeKey];
  const navCount = nav?.lanes?.length ?? 0;
  const { index: target, excluded, upcoming } =
    nav && nav.preferredLane !== null && navCount && visibleLanes
      ? laneTarget(nav, lanesFromLines(order.map((i) => lines[i]), ROWS))
      : { index: null, excluded: new Set<number>(), upcoming: new Set<number>() };
  const labeledCount = frames.filter((f) => file.frames[f.id]).length;

  const px = ([x, y]: Pt) => `${x * IMG_W},${y * IMG_H}`;
  const lanePolygon = (l: Boundary, r: Boundary) => {
    const both = ROWS.map((_, j) => j).filter((j) => l.x[j] !== null && r.x[j] !== null);
    if (both.length < 2) return null;
    return [
      ...both.map((j) => px([l.x[j]!, ROWS[j]])),
      ...[...both].reverse().map((j) => px([r.x[j]!, ROWS[j]])),
    ].join(" ");
  };

  const btn = "rounded-lg bg-white/10 px-3 py-1.5 text-sm font-medium hover:bg-white/20 disabled:opacity-30";

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">
          Lane <span className="text-accent">labeling</span>
        </h1>
        <div className="flex items-center gap-4 text-sm text-white/60">
          <span>
            {labeledCount}/{frames.length} frames labeled
          </span>
          <span className={status.startsWith("Saved") ? "text-green-400" : ""}>{status}</span>
          <a href="#" className="text-accent-soft hover:underline">
            ← back to app
          </a>
        </div>
      </header>

      <div
        className="relative cursor-crosshair select-none overflow-hidden rounded-xl bg-black ring-1 ring-white/10"
        style={{ aspectRatio: IMG_W / (IMG_H * (1 - TOP)) }}
        onClick={onImageClick}
      >
        {frame.image && (
          <img
            src={frame.image}
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-bottom"
            draggable={false}
          />
        )}
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox={`0 ${TOP * IMG_H} ${IMG_W} ${(1 - TOP) * IMG_H}`}
          preserveAspectRatio="none"
        >
          {ROWS.map((r) => (
            <g key={r}>
              <line x1={0} x2={IMG_W} y1={r * IMG_H} y2={r * IMG_H} stroke="white" strokeOpacity={0.25} strokeDasharray="12 10" strokeWidth={2} />
              <text x={8} y={r * IMG_H - 6} fill="white" fillOpacity={0.5} fontSize={22}>
                y={r}
              </text>
            </g>
          ))}

          {order.slice(0, -1).map((li, k) => {
            const pts = lanePolygon(lines[li], lines[order[k + 1]]);
            if (!pts) return null;
            const isTarget = k === target;
            const isBike = excluded.has(k);
            const isUpcoming = upcoming.has(k);
            // Label at the lowest row where the lane's center is on screen (outer lanes often
            // leave the frame near the bottom); otherwise pin it inside the nearest edge.
            const [l, r] = [lines[li], lines[order[k + 1]]];
            const center = (jj: number) =>
              l.x[jj] !== null && r.x[jj] !== null ? (l.x[jj]! + r.x[jj]!) / 2 : null;
            let j = ROWS.findIndex((_, jj) => {
              const c = center(jj);
              return c !== null && c > 0.04 && c < 0.96;
            });
            if (j === -1) j = ROWS.findIndex((_, jj) => center(jj) !== null);
            const cx = Math.min(0.95, Math.max(0.05, center(j)!));
            const cy = Math.min(0.985, ROWS[j] + 0.012);
            return (
              <g key={`lane-${k}`}>
                <polygon
                  points={pts}
                  fill={isTarget ? "var(--color-accent)" : isBike || isUpcoming ? "#fbbc04" : "white"}
                  fillOpacity={isTarget ? 0.4 : isBike || isUpcoming ? 0.25 : 0.08}
                />
                <text
                  x={cx * IMG_W}
                  y={cy * IMG_H}
                  textAnchor="middle"
                  fill="white"
                  stroke="black"
                  strokeWidth={6}
                  paintOrder="stroke"
                  fontSize={34}
                  fontWeight={700}
                >
                  {isTarget
                    ? `Lane ${k + 1} ★`
                    : isBike
                      ? `Lane ${k + 1}: bike/shoulder`
                      : isUpcoming
                        ? `Lane ${k + 1}: turn lane ahead`
                        : `Lane ${k + 1}`}
                </text>
              </g>
            );
          })}

          {lines.map((b, i) => {
            const pts = [...b.points].sort((p, q) => p[1] - q[1]);
            const stroke = i === active ? "#34a853" : b.color === "yellow" ? "#fbbc04" : "var(--color-accent-soft)";
            return (
              <g key={i}>
                <polyline
                  points={pts.map(px).join(" ")}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={i === active ? 6 : 4}
                  strokeDasharray={b.type === "dashed" ? "24 16" : undefined}
                />
                {b.x.map((x, j) =>
                  x === null ? null : (
                    <circle key={j} cx={x * IMG_W} cy={ROWS[j] * IMG_H} r={5} fill={stroke} />
                  ),
                )}
                {b.points.map((p, j) => (
                  <circle
                    key={`h${j}`}
                    cx={p[0] * IMG_W}
                    cy={p[1] * IMG_H}
                    r={12}
                    fill="black"
                    fillOpacity={0.4}
                    stroke={stroke}
                    strokeWidth={4}
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      setActive(i);
                    }}
                  />
                ))}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <button className={btn} onClick={() => goTo(index - 1)} disabled={index === 0}>
              ◀ Prev
            </button>
            <span className="w-20 text-center text-sm tabular-nums text-white/70">
              {index + 1}/{frames.length}
            </span>
            <button className={btn} onClick={() => goTo(index + 1)} disabled={index === frames.length - 1}>
              Next ▶
            </button>
            <span className="mx-2 text-xs uppercase tracking-widest text-white/40">Hero</span>
            {HERO_FRAMES.map((n) => (
              <button
                key={n}
                onClick={() => goTo(n - 1)}
                className={`rounded-md px-2 py-1 text-xs tabular-nums ${
                  n - 1 === index ? "bg-accent text-white" : "bg-white/10 hover:bg-white/20"
                }`}
              >
                {n}
                {frames[n - 1] && file.frames[frames[n - 1].id] ? " ✓" : ""}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <button className={btn} onClick={finishLine} disabled={active === null}>
              Finish line (Enter)
            </button>
            <button className={btn} onClick={undo} disabled={!lines.length}>
              Undo point (Z)
            </button>
            <button className={btn} onClick={deleteLine} disabled={active === null}>
              Delete line (Del)
            </button>
            <button className={btn} onClick={() => restyle((b) => ({ ...b, type: b.type === "solid" ? "dashed" : "solid" }))} disabled={!lines.length}>
              Solid/dashed (S)
            </button>
            <button className={btn} onClick={() => restyle((b) => ({ ...b, color: b.color === "yellow" ? "white" : "yellow" }))} disabled={!lines.length}>
              White/yellow (Y)
            </button>
            <button className={btn} onClick={copyPrevious} disabled={!index || !file.frames[frames[index - 1]?.id]}>
              Copy previous frame (C)
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              className={btn}
              disabled={!apiOk}
              onClick={() => {
                setStatus("Baking…");
                fetch("/__bake", { method: "POST" })
                  .then(async (r) => setStatus(r.ok ? "Baked ✓ (app updated)" : `Bake failed: ${(await r.text()).slice(0, 120)}`))
                  .catch(() => setStatus("Bake failed"));
              }}
            >
              Re-bake demo
            </button>
            <button
              className={btn}
              onClick={() => {
                const a = document.createElement("a");
                a.href = URL.createObjectURL(new Blob([serialize(file)], { type: "application/json" }));
                a.download = "fallback_lanes.json";
                a.click();
              }}
            >
              Download JSON
            </button>
          </div>

          <p className="text-xs leading-relaxed text-white/50">
            Click along a painted line to trace it (2 clicks for straight, more for curves), then press Enter.
            Start a new click to trace the next line. Click a point to re-select its line. ← → change frame.
            Trace every visible line, including road edges. Labels save automatically to data/fallback_lanes.json.
          </p>
        </div>

        <div className="space-y-3 rounded-2xl bg-surface p-4 text-sm ring-1 ring-white/10">
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
          <Row label="Frame id">{frame.id}</Row>
          <Row label="Mapbox lanes">{navCount || "none"}</Row>
          <Row label="Mapbox target">
            {nav?.preferredLane != null && navCount
              ? `Lane ${nav.preferredLane + 1} of ${navCount} (${describeLane(nav.preferredLane, navCount)})`
              : "—"}
          </Row>
          <Row label="You traced">
            {lines.length} lines → {visibleLanes} lane{visibleLanes === 1 ? "" : "s"}
          </Row>
          {excluded.size > 0 && (
            <Row label="Not counted">
              {[...excluded].map((k) => `Lane ${k + 1}`).join(", ")} (narrow: bike lane/shoulder)
            </Row>
          )}
          {upcoming.size > 0 && (
            <Row label="Not counted yet">
              {[...upcoming].map((k) => `Lane ${k + 1}`).join(", ")} (turn lane opening ahead)
            </Row>
          )}
          <Row label="Demo will highlight">
            {target !== null ? `your Lane ${target + 1} ★` : visibleLanes && navCount ? "nothing (out of range)" : "—"}
          </Row>
          {navCount > 0 && visibleLanes > 0 && (
            <p className={`text-xs ${visibleLanes === navCount ? "text-white/50" : "text-amber-300/80"}`}>
              {visibleLanes === navCount
                ? "Your lanes match Mapbox 1:1."
                : `You traced ${visibleLanes} of Mapbox's ${navCount} lanes, so lanes are matched counting from the ${
                    nav?.laneSide ?? "right"
                  } edge. Make sure you traced every lane on that side.`}{" "}
              Check that ★ is the right physical lane for both routes.
            </p>
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
