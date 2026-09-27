import { useCallback, useEffect, useState } from "react";
import type { ActiveLanes, DemoRoute } from "./types";
import DriverView from "./components/DriverView";
import NavCard from "./components/NavCard";
import LaneGuidance from "./components/LaneGuidance";
import LaneDebug from "./components/LaneDebug";
import { DEFAULT_HORIZON_Y, laneDebug, laneTarget } from "./lanes";
import { demoUrl, loadClipIndex, openClip, pickClip, type ClipIndex } from "./clips";
import RouteMiniMap from "./components/RouteMiniMap";
import DataPanel from "./components/DataPanel";
import Controls from "./components/Controls";

const FRAME_MS = 700; // SR 70 was captured at ~1 frame/s; this plays at ~1.4x

export default function App() {
  const [clips, setClips] = useState<ClipIndex | null>(null);
  const [clip, setClip] = useState<string | null>(null);
  const [data, setData] = useState<DemoRoute | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndexRaw] = useState(0);
  const [routeKey, setRouteKey] = useState("north");
  const [playing, setPlaying] = useState(false);
  const [lanesOn, setLanesOn] = useState(true); // false = "before": a standard GPS with no lane guidance
  const [arrowOn, setArrowOn] = useState(true);
  const [laneSource, setLaneSource] = useState<string | null>(null); // which lane geometry to draw (V cycles)
  const [debug, setDebug] = useState(false); // lane debug view: every detected lane and how it was matched (D)

  useEffect(() => {
    loadClipIndex()
      .then((idx) => {
        setClips(idx);
        const name = pickClip(idx);
        setClip(name);
        return fetch(demoUrl(name));
      })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.url}: HTTP ${r.status}`))))
      .then((d: DemoRoute) => {
        setData(d);
        setRouteKey(d.primaryRoute);
        setLaneSource(Object.keys(d.laneSources ?? {})[0] ?? null);
        // Preload every frame so autoplay doesn't stutter.
        d.frames.forEach((f) => f.image && (new Image().src = f.image));
      })
      .catch((e) => setError(String(e)));
  }, []);

  const count = data?.frames.length ?? 0;
  const sources = data?.laneSources ?? {};
  const sourceKeys = Object.keys(sources).join(",");
  const setIndex = useCallback((i: number) => setIndexRaw(Math.max(0, Math.min(count - 1, i))), [count]);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setIndexRaw((i) => {
        if (i >= count - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, FRAME_MS);
    return () => clearInterval(t);
  }, [playing, count]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setIndex(index + 1);
      else if (e.key === "ArrowLeft") setIndex(index - 1);
      else if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key.toLowerCase() === "g") setLanesOn((on) => !on);
      else if (e.key.toLowerCase() === "d") setDebug((on) => !on);
      else if (e.key.toLowerCase() === "v" && sourceKeys) {
        const keys = sourceKeys.split(",");
        setLaneSource((cur) => keys[(keys.indexOf(cur ?? "") + 1) % keys.length]);
      }
      else return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, setIndex, sourceKeys]);

  if (error) {
    return (
      <div className="mx-auto max-w-xl p-10 text-white/80">
        <h1 className="mb-3 text-2xl font-semibold">No demo data yet</h1>
        <p className="mb-2">Couldn't load the clip ({error}). Build it from the repo root:</p>
        <pre className="rounded bg-white/10 p-3 text-sm">.venv/Scripts/python.exe tools/build_clip.py --all</pre>
      </div>
    );
  }
  if (!data) return <div className="p-10 text-white/50">Loading…</div>;

  const frame = data.frames[index];
  const nav = frame.nav[routeKey] ?? null;
  const offRoute = nav === null && frame.nav[data.primaryRoute] !== null;
  const set = laneSource ? frame.laneSets?.[laneSource] : undefined;
  const lanes: ActiveLanes = laneSource
    ? {
        source: laneSource,
        label: sources[laneSource]?.label ?? laneSource,
        polygons: set?.polygons ?? null,
        confidence: set?.confidence ?? null,
        drivable: set?.drivable ?? null,
      }
    : { source: frame.polygonSource ?? null, label: "labeled", polygons: frame.lanePolygons, confidence: null };
  const horizonY = data.camera?.horizonY ?? DEFAULT_HORIZON_Y;
  const vanishingX = data.camera?.vanishingPoint[0] ?? 0.5;
  const debugInfo = debug && nav && lanes.polygons ? laneDebug(nav, lanes.polygons, horizonY, lanes.drivable) : null;
  const previousFrame = data.frames[index - 1];
  const previousNav = previousFrame?.nav[routeKey] ?? null;
  const previousSet = previousFrame && laneSource ? previousFrame.laneSets?.[laneSource] : undefined;
  const previousPolygons = previousFrame
    ? (laneSource ? previousSet?.polygons : previousFrame.lanePolygons)
    : null;
  const previousMatch = previousNav && previousPolygons
    ? laneTarget(previousNav, previousPolygons, horizonY, previousSet?.drivable ?? null)
    : null;
  const previousLane = previousMatch?.index != null ? previousPolygons![previousMatch.index] : null;
  const currentMatch = nav && lanes.polygons ? laneTarget(nav, lanes.polygons, horizonY, lanes.drivable) : null;
  const sameTargetLane = previousMatch?.index != null && previousMatch.index === currentMatch?.index &&
    previousNav?.preferredLane === nav?.preferredLane;
  const untakenTurnSide = sameTargetLane && previousFrame && previousNav &&
    (previousNav.maneuverType === "fork" || previousNav.maneuverType === "turn")
    ? Object.entries(previousFrame.nav).find(([key, alternate]) =>
        key !== routeKey && alternate &&
        (alternate.maneuverType === "fork" || alternate.maneuverType === "turn") &&
        alternate.laneSide && alternate.laneSide !== previousNav.laneSide,
      )?.[1]?.laneSide ?? null
    : null;

  return (
    <div className="mx-auto max-w-7xl p-4 md:p-6">
      <header className="mb-4 flex items-baseline justify-between">
        <div className="flex items-baseline gap-4">
          <h1 className="text-2xl font-bold tracking-tight">
            Turn<span className="text-accent">pike</span>
          </h1>
          {clips && clips.clips.length > 1 && (
            <select
              value={clip ?? ""}
              onChange={(e) => openClip(e.target.value)}
              aria-label="Clip"
              className="rounded-md bg-white/10 px-2 py-1 text-sm text-white/80"
            >
              {clips.clips.map((c) => (
                <option key={c.name} value={c.name} className="bg-surface">
                  {c.title}
                </option>
              ))}
            </select>
          )}
        </div>
        <span className="text-sm text-white/50">
          Lane-level AR guidance from public road data
          {import.meta.env.DEV && (
            <>
              <a href={`#label=${index + 1}`} className="ml-4 text-accent-soft hover:underline">
                Label this frame →
              </a>
              <a href={`#cv=${index + 1}`} className="ml-4 text-accent-soft hover:underline">
                CV review →
              </a>
            </>
          )}
        </span>
      </header>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <main className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {Object.keys(sources).length > 0 ? (
              <div className="flex items-center gap-2" role="group" aria-label="Lane geometry source (V)">
                <span className="text-xs uppercase tracking-widest text-white/40">Lanes</span>
                <div className="flex rounded-lg bg-white/5 p-1">
                  {Object.entries(sources).map(([key, src]) => (
                    <button
                      key={key}
                      onClick={() => setLaneSource(key)}
                      aria-pressed={laneSource === key}
                      title={`${src.method ?? src.label} · cycle with V`}
                      className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                        laneSource === key ? "bg-white/20 text-white" : "text-white/60 hover:text-white"
                      }`}
                    >
                      {src.label}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setDebug((on) => !on)}
                  aria-pressed={debug}
                  title="Show every detected lane and how it was matched (D)"
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ${
                    debug ? "bg-amber-400/20 text-amber-200 ring-amber-400/50" : "text-white/60 ring-white/10 hover:text-white"
                  }`}
                >
                  Debug
                </button>
              </div>
            ) : (
              <span />
            )}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded-lg bg-white/5 p-1" role="group" aria-label="Guidance mode (G)">
                {[
                  { on: false, label: "Standard GPS" },
                  { on: true, label: "Turnpike lanes" },
                ].map((m) => (
                  <button
                    key={m.label}
                    onClick={() => setLanesOn(m.on)}
                    aria-pressed={lanesOn === m.on}
                    title="Toggle with G"
                    className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                      lanesOn === m.on ? "bg-accent text-white" : "text-white/70 hover:text-white"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={arrowOn}
                onClick={() => setArrowOn((on) => !on)}
                className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2 text-sm font-medium text-white/80 hover:text-white"
              >
                Arrow
                <span className={`relative h-5 w-9 rounded-full transition-colors ${arrowOn ? "bg-accent" : "bg-white/20"}`}>
                  <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${arrowOn ? "translate-x-4" : ""}`} />
                </span>
              </button>
            </div>
          </div>
          <DriverView frame={frame} nav={nav} offRoute={offRoute} overlay={lanesOn} showArrow={arrowOn} lanes={lanes} previousLane={previousLane} untakenTurnSide={untakenTurnSide} debug={debugInfo?.rows ?? null} horizonY={horizonY} vanishingX={vanishingX} />
          <NavCard nav={nav} />
          {lanesOn && <LaneGuidance nav={nav} />}
          {debug && <LaneDebug nav={nav} lanes={lanes} rows={debugInfo?.rows ?? []} reason={debugInfo?.reason ?? null} countFrom={debugInfo?.countFrom ?? null} />}
          <Controls
            data={data}
            index={index}
            setIndex={setIndex}
            playing={playing}
            setPlaying={setPlaying}
            routeKey={routeKey}
            setRouteKey={setRouteKey}
          />
        </main>
        <aside className="space-y-4">
          <RouteMiniMap data={data} routeKey={routeKey} setRouteKey={setRouteKey} frame={frame} />
          <DataPanel data={data} frame={frame} nav={nav} lanes={lanes} />
        </aside>
      </div>
    </div>
  );
}
