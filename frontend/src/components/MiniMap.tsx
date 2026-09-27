import type { DemoRoute, Frame } from "../types";
import Panel from "./Panel";
import { positionOnRoute } from "./routeMapLayers";

interface Props {
  data: DemoRoute;
  routeKey: string;
  frame: Frame;
  className?: string;
}

export default function MiniMap({ data, routeKey, frame, className }: Props) {
  const all = Object.values(data.routes).flatMap((r) => r.geometry);
  const lngs = all.map((p) => p[0]);
  const lats = all.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...lngs), Math.max(...lngs), Math.min(...lats), Math.max(...lats)];
  const kx = Math.cos((((minY + maxY) / 2) * Math.PI) / 180); // shrink longitude to keep shapes true
  const w = (maxX - minX) * kx;
  const h = maxY - minY;
  const pad = Math.max(w, h) * 0.08;
  const project = ([lng, lat]: [number, number]) => [(lng - minX) * kx + pad, maxY - lat + pad];
  const path = (g: [number, number][]) => g.map((p) => project(p).join(",")).join(" ");
  const [cx, cy] = project(positionOnRoute(data, routeKey, frame));
  const vb = `0 0 ${w + 2 * pad} ${h + 2 * pad}`;
  const r = Math.max(w, h) * 0.02;

  return (
    <Panel title="Route" className={className}>
      <svg viewBox={vb} className="h-full min-h-48 w-full">
        {Object.entries(data.routes)
          .sort(([a]) => (a === routeKey ? 1 : -1))
          .map(([key, route]) => (
            <polyline
              key={key}
              points={path(route.geometry)}
              fill="none"
              stroke={key === routeKey ? "var(--color-accent)" : "rgba(232,234,237,0.25)"}
              strokeWidth={key === routeKey ? 4 : 2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        <circle cx={cx} cy={cy} r={r} fill="#fff" stroke="#000" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
    </Panel>
  );
}
