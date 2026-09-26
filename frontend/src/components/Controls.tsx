import type { DemoRoute } from "../types";

interface Props {
  data: DemoRoute;
  index: number;
  setIndex: (i: number) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  routeKey: string;
  setRouteKey: (k: string) => void;
}

const btn = "rounded-lg bg-white/10 px-4 py-2 font-medium hover:bg-white/20 disabled:opacity-30";

export default function Controls({ data, index, setIndex, playing, setPlaying, routeKey, setRouteKey }: Props) {
  const last = data.frames.length - 1;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex rounded-lg bg-white/5 p-1">
        {Object.entries(data.routes).map(([key, route]) => (
          <button
            key={key}
            onClick={() => setRouteKey(key)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              key === routeKey ? "bg-accent text-white" : "text-white/70 hover:text-white"
            }`}
          >
            {route.label}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <button className={btn} onClick={() => setIndex(index - 1)} disabled={index === 0}>
          ◀ Back
        </button>
        <button
          className={btn}
          onClick={() => {
            if (!playing && index === last) setIndex(0);
            setPlaying(!playing);
          }}
        >
          {playing ? "❚❚ Pause" : "▶ Drive"}
        </button>
        <button className={btn} onClick={() => setIndex(index + 1)} disabled={index === last}>
          Next ▶
        </button>
      </div>
      <input
        type="range"
        min={0}
        max={last}
        value={index}
        onChange={(e) => setIndex(Number(e.target.value))}
        className="min-w-40 flex-1 accent-[var(--color-accent)]"
        aria-label="Frame"
      />
      <span className="text-sm tabular-nums text-white/50">
        {index + 1}/{last + 1}
      </span>
    </div>
  );
}
