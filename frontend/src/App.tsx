import { useCallback, useEffect, useState } from "react";
import type { DemoRoute } from "./types";
import DriverView from "./components/DriverView";
import NavCard from "./components/NavCard";
import LaneStrip from "./components/LaneStrip";
import MiniMap from "./components/MiniMap";
import DataPanel from "./components/DataPanel";
import Controls from "./components/Controls";

const FRAME_MS = 700; // the clip was captured at ~1 frame/s; this plays at ~1.4x

export default function App() {
  const [data, setData] = useState<DemoRoute | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndexRaw] = useState(0);
  const [routeKey, setRouteKey] = useState("north");
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    fetch("/demo_route.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: DemoRoute) => {
        setData(d);
        setRouteKey(d.primaryRoute);
        // Preload every frame so autoplay doesn't stutter.
        d.frames.forEach((f) => f.image && (new Image().src = f.image));
      })
      .catch((e) => setError(String(e)));
  }, []);

  const count = data?.frames.length ?? 0;
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
      } else return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, setIndex]);

  if (error) {
    return (
      <div className="mx-auto max-w-xl p-10 text-white/80">
        <h1 className="mb-3 text-2xl font-semibold">No demo data yet</h1>
        <p className="mb-2">Couldn't load /demo_route.json ({error}). Generate it from the repo root:</p>
        <pre className="rounded bg-white/10 p-3 text-sm">python bake/bake_route.py --image-id &lt;mapillary id&gt;</pre>
      </div>
    );
  }
  if (!data) return <div className="p-10 text-white/50">Loading…</div>;

  const frame = data.frames[index];
  const nav = frame.nav[routeKey] ?? null;
  const offRoute = nav === null && frame.nav[data.primaryRoute] !== null;

  return (
    <div className="mx-auto max-w-7xl p-4 md:p-6">
      <header className="mb-4 flex items-baseline justify-between">
        <h1 className="text-2xl font-bold tracking-tight">
          Turn<span className="text-accent">pike</span>
        </h1>
        <span className="text-sm text-white/50">Lane-level AR guidance from public road data</span>
      </header>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <main className="space-y-4">
          <DriverView frame={frame} nav={nav} offRoute={offRoute} />
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <NavCard nav={nav} />
            </div>
            <LaneStrip nav={nav} />
          </div>
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
          <MiniMap data={data} routeKey={routeKey} frame={frame} />
          <DataPanel data={data} frame={frame} nav={nav} />
        </aside>
      </div>
    </div>
  );
}
