import { useCallback, useEffect, useRef, useState } from "react";
import type { ActiveLanes, DemoRoute } from "./types";
import DriverView, { laneStatus } from "./components/DriverView";
import GuidancePanel from "./components/GuidancePanel";
import Panel from "./components/Panel";
import PlaybackBar from "./components/PlaybackBar";
import Toolbar from "./components/Toolbar";
import LaneDebug from "./components/LaneDebug";
import { DEFAULT_HORIZON_Y, laneDebug, laneTarget } from "./lanes";
import { demoUrl, loadClipIndex, openClip, pickClip, type ClipIndex } from "./clips";
import { roadName } from "./lanes";
import { Segmented } from "./components/ui";
import RouteMiniMap from "./components/RouteMiniMap";
import DataPanel from "./components/DataPanel";

// Space around the video in the page layout (header, controls row, panel header, playback bar and the
// top of the guidance panel), so the video grows into whatever height is left on screen.
const VIDEO_RESERVED_PX = 330;
// ...and in full screen, only the panel header and playback bar.
const FULLSCREEN_RESERVED_PX = 110;

const FRAME_MS = 700; // at 1x speed. SR 70 was captured at ~1 frame/s, so 1x plays it at ~1.4x real time

export default function App() {
  const [clips, setClips] = useState<ClipIndex | null>(null);
  const [clip, setClip] = useState<string | null>(null);
  const [data, setData] = useState<DemoRoute | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndexRaw] = useState(0);
  const [routeKey, setRouteKey] = useState("north");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1); // playback speed multiplier (PlaybackBar)
  const [loop, setLoop] = useState(false); // start over from the first frame at the end
  const cameraRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === cameraRef.current && !!cameraRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void cameraRef.current?.requestFullscreen();
  }, []);
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
          if (loop) return 0;
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, FRAME_MS / speed);
    return () => clearInterval(t);
  }, [playing, count, speed, loop]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setIndex(index + 1);
      else if (e.key === "ArrowLeft") setIndex(index - 1);
      else if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key.toLowerCase() === "g") setLanesOn((on) => !on);
      else if (e.key.toLowerCase() === "f") toggleFullscreen();
      else if (e.key.toLowerCase() === "d") setDebug((on) => !on);
      else if (e.key.toLowerCase() === "v" && sourceKeys) {
        const keys = sourceKeys.split(",");
        setLaneSource((cur) => keys[(keys.indexOf(cur ?? "") + 1) % keys.length]);
      }
      else return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, setIndex, sourceKeys, toggleFullscreen]);

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
  const imageSize = data.camera?.imageSize;
  const imageAspect = imageSize ? imageSize[0] / imageSize[1] : 16 / 9;
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

  const status = laneStatus(lanesOn, nav, lanes, horizonY);
  const headerLink = "flex h-7 items-center rounded-md border border-line bg-white/5 px-2.5 text-xs font-medium text-white/70 hover:bg-white/10 hover:text-white";

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-3 p-3 md:p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold tracking-tight">
            Turn<span className="text-accent">pike</span>
          </h1>
          {clips && clips.clips.length > 1 && (
            <select
              value={clip ?? ""}
              onChange={(e) => openClip(e.target.value)}
              aria-label="Clip"
              className="h-7 rounded-md border border-line bg-white/5 px-2 text-xs font-medium text-white/80"
            >
              {clips.clips.map((c) => (
                <option key={c.name} value={c.name} className="bg-surface">
                  {roadName(c.title)}
                </option>
              ))}
            </select>
          )}
          <Segmented
            ariaLabel="Route"
            value={routeKey}
            onChange={setRouteKey}
            options={Object.entries(data.routes).map(([key, r]) => ({ value: key, label: roadName(r.label) }))}
          />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-white/50">Lane-level AR guidance from public road data</span>
          {import.meta.env.DEV && (
            <nav className="flex gap-2">
              <a href={`#label=${index + 1}`} className={headerLink}>Label this frame</a>
              <a href={`#cv=${index + 1}`} className={headerLink}>CV review</a>
            </nav>
          )}
        </div>
      </header>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
        <main className="flex min-w-0 flex-col gap-3">
          <Toolbar
            data={data}
            laneSource={laneSource}
            setLaneSource={setLaneSource}
            lanesOn={lanesOn}
            setLanesOn={setLanesOn}
            arrowOn={arrowOn}
            setArrowOn={setArrowOn}
            debug={debug}
            setDebug={setDebug}
          />
          <div ref={cameraRef} className={fullscreen ? "flex h-full items-center bg-page p-3" : ""}>
            <Panel
              title="Camera"
              className={fullscreen ? "w-full" : ""}
              right={
                <>
                  {status ? (
                    <span className={`value flex min-w-0 items-center gap-1.5 ${status.ok ? "text-white/60" : "text-amber-300"}`} title={status.text}>
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.ok ? "bg-emerald-400" : "bg-amber-400"}`} />
                      <span className="truncate">{status.text}</span>
                    </span>
                  ) : (
                    <span className="value text-white/40">{lanesOn ? "no lane data" : "standard GPS"}</span>
                  )}
                  <button
                    type="button"
                    onClick={toggleFullscreen}
                    title={fullscreen ? "Exit full screen (F or Esc)" : "Full screen (F)"}
                    aria-label={fullscreen ? "Exit full screen" : "Full screen"}
                    className="flex h-6 w-6 items-center justify-center rounded border border-line bg-white/5 text-white/70 hover:bg-white/10 hover:text-white"
                  >
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
                      <path d={fullscreen ? "M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" : "M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"} />
                    </svg>
                  </button>
                </>
              }
              bodyClassName="flex flex-col gap-3 p-3"
            >
              <DriverView frame={frame} nav={nav} offRoute={offRoute} overlay={lanesOn} showArrow={arrowOn} lanes={lanes} previousLane={previousLane} untakenTurnSide={untakenTurnSide} debug={debugInfo?.rows ?? null} horizonY={horizonY} vanishingX={vanishingX} imageAspect={imageAspect}
                maxHeight={`(100vh - ${fullscreen ? FULLSCREEN_RESERVED_PX : VIDEO_RESERVED_PX}px)`} />
              <PlaybackBar index={index} count={count} setIndex={setIndex} playing={playing} setPlaying={setPlaying} speed={speed} setSpeed={setSpeed} loop={loop} setLoop={setLoop} />
            </Panel>
          </div>
          <GuidancePanel nav={nav} showLanes={lanesOn} />
          {debug && <LaneDebug nav={nav} lanes={lanes} rows={debugInfo?.rows ?? []} reason={debugInfo?.reason ?? null} countFrom={debugInfo?.countFrom ?? null} />}
        </main>
        <aside className="flex min-h-0 flex-col gap-3 lg:h-0 lg:min-h-full lg:pt-10">
          <RouteMiniMap data={data} routeKey={routeKey} setRouteKey={setRouteKey} frame={frame} className="min-h-64 flex-1" />
          <DataPanel frame={frame} nav={nav} lanes={lanes} className="min-h-64 flex-1" />
        </aside>
      </div>

      <footer className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-2 text-[11px] text-white/40">
        {data.attribution.map((a) => (
          <span key={a}>{a}</span>
        ))}
      </footer>
    </div>
  );
}
