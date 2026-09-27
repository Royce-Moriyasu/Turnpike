import { Switch } from "./ui";

interface Props {
  index: number;
  count: number;
  setIndex: (i: number) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  speed: number; // playback speed multiplier
  setSpeed: (s: number) => void;
  loop: boolean; // start over at the end
  setLoop: (on: boolean) => void;
}

const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 3, 4];

const iconBtn =
  "flex h-7 w-7 items-center justify-center rounded-md border border-line bg-white/5 text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-white/5";

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current" aria-hidden="true">
    <path d={d} />
  </svg>
);

/** Under the video: step/play buttons, a scrubber and the frame counter. */
export default function PlaybackBar({ index, count, setIndex, playing, setPlaying, speed, setSpeed, loop, setLoop }: Props) {
  const last = count - 1;
  return (
    <div className="flex items-center gap-3">
      <div className="flex gap-1">
        <button className={iconBtn} onClick={() => setIndex(index - 1)} disabled={index === 0} title="Previous frame (←)" aria-label="Previous frame">
          <Icon d="M3 3h2v10H3zM13 3v10L6 8z" />
        </button>
        <button
          className={iconBtn}
          onClick={() => {
            if (!playing && index === last) setIndex(0);
            setPlaying(!playing);
          }}
          title={playing ? "Pause (space)" : "Drive (space)"}
          aria-label={playing ? "Pause" : "Drive"}
        >
          <Icon d={playing ? "M4 3h3v10H4zM9 3h3v10H9z" : "M4 2.5v11L13 8z"} />
        </button>
        <button className={iconBtn} onClick={() => setIndex(index + 1)} disabled={index === last} title="Next frame (→)" aria-label="Next frame">
          <Icon d="M11 3h2v10h-2zM3 3v10l7-5z" />
        </button>
      </div>
      <input
        type="range"
        min={0}
        max={last}
        value={index}
        onChange={(e) => setIndex(Number(e.target.value))}
        className="scrubber min-w-0 flex-1"
        aria-label="Frame"
      />
      <span className="value text-white/60">
        {String(index + 1).padStart(String(count).length, " ")} / {count}
      </span>
      <label className="flex items-center gap-2 border-l border-line pl-3" title="Playback speed">
        <span className="label">Speed</span>
        <input
          type="range"
          min={0}
          max={SPEEDS.length - 1}
          step={1}
          value={SPEEDS.indexOf(speed)}
          onChange={(e) => setSpeed(SPEEDS[Number(e.target.value)])}
          className="scrubber w-20"
          aria-label="Playback speed"
        />
        <span className="value w-10 text-right text-white/80">{speed}×</span>
      </label>
      <Switch label="Loop" checked={loop} onChange={setLoop} title="Start over from the first frame at the end" />
    </div>
  );
}
