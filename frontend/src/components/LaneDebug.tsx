import type { ActiveLanes, NavState } from "../types";
import { arrowFor, bikeLaneRatio, laneShapeLimits, type LaneDebugRow, type LaneStatus } from "../lanes";

// Shared with DriverView's debug overlay.
export const STATUS_STYLE: Record<LaneStatus, { color: string; label: string }> = {
  target: { color: "#4285f4", label: "target" },
  counted: { color: "#e8eaed", label: "matched" },
  outside: { color: "#9aa0a6", label: "no Mapbox lane" },
  bike: { color: "#fbbc04", label: "bike/shoulder" },
  upcoming: { color: "#fa7b17", label: "turn lane ahead" },
  shape: { color: "#ea4335", label: "odd shape" },
  otherRoad: { color: "#80868b", label: "other roadway" },
};

interface Props {
  nav: NavState | null;
  lanes: ActiveLanes;
  rows: LaneDebugRow[];
  reason: string | null; // why nothing is highlighted, if so
  countFrom: "left" | "right" | null; // side the lanes were actually counted from
}

/** Table explaining how the visible lanes were matched to Mapbox's lanes for this frame. */
export default function LaneDebug({ nav, lanes, rows, reason, countFrom }: Props) {
  const mb = nav?.lanes ?? [];
  return (
    <div className="rounded-2xl bg-surface p-4 text-sm ring-1 ring-amber-400/40">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs uppercase tracking-widest text-amber-300/80">Lane debug · {lanes.label}</span>
        <span className="font-mono text-xs text-white/50">
          {lanes.polygons ? `${lanes.polygons.length} visible` : "no lanes detected"} · Mapbox {mb.length} ·
          count from {countFrom ?? nav?.laneAnchor ?? nav?.laneSide ?? "—"}
          {countFrom && countFrom !== nav?.laneSide ? ` (turn side ${nav?.laneSide})` : ""}
          {nav?.laneAhead ? ` · turn lanes ahead L${nav.laneAhead.left} R${nav.laneAhead.right}` : ""}
          {lanes.confidence != null ? ` · conf ${lanes.confidence.toFixed(2)}` : ""}
        </span>
      </div>

      {reason && rows.length > 0 && (
        <p className="mb-2 text-xs text-red-300">No highlight: {reason}</p>
      )}

      {mb.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1 font-mono text-xs text-white/60">
          <span className="mr-1">Mapbox:</span>
          {mb.map((l, i) => (
            <span
              key={i}
              className={`rounded px-1.5 py-0.5 ${
                i === nav!.preferredLane ? "bg-accent text-white" : l.allowed ? "bg-white/15" : "bg-white/5 text-white/30"
              }`}
              title={l.indications.join(" / ")}
            >
              M{i + 1} {l.indications.map(arrowFor).join("")}
            </span>
          ))}
        </div>
      )}

      {rows.length > 0 ? (
        <table className="w-full font-mono text-xs">
          <thead className="text-left text-white/40">
            <tr>
              <th className="py-1 font-normal">lane</th>
              <th className="font-normal">status</th>
              <th className="font-normal">→ Mapbox</th>
              <th className="text-right font-normal">bottom width</th>
              <th className="text-right font-normal" title={`bike rule: < ${bikeLaneRatio} at every row`}>
                ratio to neighbor
              </th>
              <th
                className="text-right font-normal"
                title={`width / (row - horizon); a real lane is ${laneShapeLimits.k[0]}-${laneShapeLimits.k[1]}`}
              >
                k
              </th>
              <th
                className="text-right font-normal"
                title={`k at the bottom / k at the top: > ${laneShapeLimits.closing} means the edges meet before the horizon`}
              >
                narrows ahead
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.lane} className="border-t border-white/5">
                <td className="py-1">L{r.lane + 1}</td>
                <td style={{ color: STATUS_STYLE[r.status].color }}>{STATUS_STYLE[r.status].label}</td>
                <td>{r.mapboxLane !== null ? `M${r.mapboxLane + 1} ${mb[r.mapboxLane]?.indications.map(arrowFor).join("")}` : "—"}</td>
                <td className="text-right">{r.bottomWidth?.toFixed(3) ?? "—"}</td>
                <td className={`text-right ${r.ratio !== null && r.ratio < bikeLaneRatio ? "text-amber-300" : ""}`}>
                  {r.ratio?.toFixed(2) ?? "—"}
                </td>
                <td
                  className={`text-right ${
                    r.k !== null && (r.k < laneShapeLimits.k[0] || r.k > laneShapeLimits.k[1]) ? "text-red-300" : ""
                  }`}
                >
                  {r.k?.toFixed(2) ?? "—"}
                </td>
                <td className={`text-right ${r.closing !== null && r.closing > laneShapeLimits.closing ? "text-red-300" : ""}`}>
                  {r.closing === null ? "—" : Number.isFinite(r.closing) ? `${r.closing.toFixed(2)}×` : "∞"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-xs text-white/50">No {lanes.label} lanes detected on this frame, so nothing is highlighted.</p>
      )}
    </div>
  );
}
