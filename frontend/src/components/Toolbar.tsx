import type { DemoRoute } from "../types";
import { Segmented, Switch } from "./ui";

interface Props {
  data: DemoRoute;
  laneSource: string | null;
  setLaneSource: (key: string) => void;
  lanesOn: boolean;
  setLanesOn: (on: boolean) => void;
  arrowOn: boolean;
  setArrowOn: (on: boolean) => void;
  debug: boolean;
  setDebug: (on: boolean) => void;
}

/** The row above the video: lane model and Debug on the left, view and Arrow on the right. */
export default function Toolbar(p: Props) {
  const sources = Object.entries(p.data.laneSources ?? {});
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        {sources.length > 0 && (
          <>
            <span className="label">Lanes</span>
            <Segmented
              ariaLabel="Lane model (V)"
              value={p.laneSource}
              onChange={p.setLaneSource}
              options={sources.map(([key, s]) => ({ value: key, label: s.label, title: `${s.method ?? s.label} · cycle with V` }))}
            />
          </>
        )}
        <Switch label="Debug" checked={p.debug} onChange={p.setDebug} tone="warn" title="Show every detected lane and how it was matched (D)" />
      </div>
      <div className="flex items-center gap-2">
        <Segmented
          ariaLabel="Guidance mode (G)"
          value={p.lanesOn ? "lanes" : "gps"}
          onChange={(v) => p.setLanesOn(v === "lanes")}
          options={[
            { value: "gps", label: "Standard GPS", title: "Toggle with G" },
            { value: "lanes", label: "Turnpike lanes", title: "Toggle with G" },
          ]}
        />
        <Switch label="Arrow" checked={p.arrowOn} onChange={p.setArrowOn} />
      </div>
    </div>
  );
}
