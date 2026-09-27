// Layers, sources and marker elements for the ROUTE mini-map (RouteMiniMap.tsx).
import type { Feature, FeatureCollection, LineString } from "geojson";
import type { GeoJSONSource, Map as MapboxMap } from "mapbox-gl";
import type { Congestion, DemoRoute, MapRouteSummary } from "../types";
import { arrowFor, formatDistance } from "../lanes";

// Swap to "mapbox://styles/mapbox/navigation-day-v1" (or light-v11) for a light map.
export const MAP_STYLE = "mapbox://styles/mapbox/navigation-night-v1";

export const COLORS = {
  route: "#4285f4",
  casing: "#1a3d7c",
  moderate: "#f9ab00",
  heavy: "#ea4335",
  severe: "#a50e0e",
  traveled: "#9aa0a6",
  alternate: "#9aa0a6",
  alternateCasing: "#4a4d52",
};

type LngLat = [number, number];

// ---------------------------------------------------------------- geometry

const EARTH_M = 6371008.8;

function metersBetween([lng1, lat1]: LngLat, [lng2, lat2]: LngLat): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(a));
}

/** Distance from the start of the line to each vertex, in meters. */
function cumulative(line: LngLat[]): number[] {
  const out = [0];
  for (let i = 1; i < line.length; i++) out.push(out[i - 1] + metersBetween(line[i - 1], line[i]));
  return out;
}

/** The point `m` meters along the line (clamped to its ends). */
export function pointAlong(line: LngLat[], m: number): LngLat {
  const cum = cumulative(line);
  if (m <= 0) return line[0];
  for (let i = 1; i < line.length; i++) {
    if (cum[i] >= m) {
      const t = (m - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
      return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t];
    }
  }
  return line[line.length - 1];
}

/** The part of the line between `from` and `to` meters along it. */
function slice(line: LngLat[], from: number, to: number): LngLat[] {
  const cum = cumulative(line);
  const inner = line.filter((_, i) => cum[i] > from && cum[i] < to);
  return [pointAlong(line, from), ...inner, pointAlong(line, to)];
}

const lengthOf = (line: LngLat[]) => cumulative(line).at(-1) ?? 0;

export function boundsOf(lines: LngLat[][]): [LngLat, LngLat] {
  const pts = lines.flat();
  const lngs = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
}

// ---------------------------------------------------------------- features

type LineProps = { congestion?: Congestion; routeKey?: string };
type Lines = FeatureCollection<LineString, LineProps>;

const line = (coordinates: LngLat[], properties: LineProps = {}): Feature<LineString, LineProps> =>
  ({ type: "Feature", geometry: { type: "LineString", coordinates }, properties });

const collection = (features: Feature<LineString, LineProps>[]): Lines => ({ type: "FeatureCollection", features });

/** The part still ahead of `progressM`, split into runs of equal congestion (all "low" without data). */
function aheadByCongestion(traffic: MapRouteSummary | null, geometry: LngLat[], progressM: number): Lines {
  if (!traffic?.congestion || traffic.congestion.length !== traffic.geometry.length - 1) {
    return collection([line(slice(geometry, progressM, lengthOf(geometry)), { congestion: "low" })]);
  }
  const cum = cumulative(traffic.geometry);
  const runs: Feature<LineString, LineProps>[] = [];
  traffic.congestion.forEach((c, i) => {
    if (cum[i + 1] <= progressM) return; // traveled
    const start: LngLat = cum[i] < progressM ? pointAlong(traffic.geometry, progressM) : traffic.geometry[i];
    const last = runs.at(-1);
    if (last && last.properties.congestion === c) last.geometry.coordinates.push(traffic.geometry[i + 1]);
    else runs.push(line([start, traffic.geometry[i + 1]], { congestion: c }));
  });
  return collection(runs);
}

export interface RouteLayerData {
  alternates: Lines; // the clip's other routes (clickable, routeKey set) and Mapbox's alternatives
  traveled: Lines;
  ahead: Lines;
}

export function routeLayerData(data: DemoRoute, activeKey: string, progressM: number): RouteLayerData {
  const active = data.routes[activeKey];
  const others = Object.entries(data.routes)
    .filter(([key]) => key !== activeKey)
    .map(([key, r]) => line(r.geometry, { routeKey: key }));
  const mapboxAlts = (active.map?.alternatives ?? []).map((a) => line(a.geometry));
  return {
    alternates: collection([...mapboxAlts, ...others]),
    traveled: collection(progressM > 0 ? [line(slice(active.geometry, 0, progressM))] : []),
    ahead: aheadByCongestion(active.map?.main ?? null, active.geometry, progressM),
  };
}

// ---------------------------------------------------------------- layers

const SOURCES = ["alternates", "traveled", "ahead"] as const;
export const ALTERNATE_HIT_LAYER = "alternates-hit";

/** Add the route sources and layers (bottom to top: alternates, traveled, active route). */
export function addRouteLayers(map: MapboxMap): void {
  const empty = collection([]);
  for (const id of SOURCES) map.addSource(id, { type: "geojson", data: empty });
  const round = { "line-cap": "round", "line-join": "round" } as const;

  map.addLayer({ id: "alternates-casing", type: "line", source: "alternates", layout: round,
    paint: { "line-color": COLORS.alternateCasing, "line-width": 8 } });
  map.addLayer({ id: "alternates-line", type: "line", source: "alternates", layout: round,
    paint: { "line-color": COLORS.alternate, "line-width": 5 } });
  // invisible and wide, so the thin gray line is easy to click
  map.addLayer({ id: ALTERNATE_HIT_LAYER, type: "line", source: "alternates", layout: round,
    filter: ["has", "routeKey"], paint: { "line-color": "#000", "line-opacity": 0, "line-width": 18 } });

  map.addLayer({ id: "traveled-line", type: "line", source: "traveled", layout: round,
    paint: { "line-color": COLORS.traveled, "line-width": 6, "line-opacity": 0.7 } });

  map.addLayer({ id: "ahead-casing", type: "line", source: "ahead", layout: round,
    paint: { "line-color": COLORS.casing, "line-width": 10 } });
  map.addLayer({ id: "ahead-line", type: "line", source: "ahead", layout: round,
    paint: {
      "line-width": 7,
      "line-color": ["match", ["get", "congestion"],
        "moderate", COLORS.moderate, "heavy", COLORS.heavy, "severe", COLORS.severe, COLORS.route],
    } });
}

export function setRouteLayerData(map: MapboxMap, layers: RouteLayerData): void {
  for (const id of SOURCES) map.getSource<GeoJSONSource>(id)?.setData(layers[id]);
}

// ---------------------------------------------------------------- marker elements

function el(className: string, html = ""): HTMLDivElement {
  const div = document.createElement("div");
  div.className = className;
  div.innerHTML = html;
  return div;
}

/** Blue dot with a white ring and a heading cone (the marker is rotated to the heading). */
export function positionElement(): HTMLDivElement {
  return el("route-position", `
    <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
      <path d="M22 2 L31 20 A10 10 0 0 0 13 20 Z" fill="${COLORS.route}" fill-opacity="0.45" />
      <circle cx="22" cy="22" r="8" fill="${COLORS.route}" stroke="#fff" stroke-width="3" />
    </svg>`);
}

/** Red teardrop pin (anchor: bottom). */
export function destinationElement(): HTMLDivElement {
  return el("route-destination", `
    <svg width="26" height="36" viewBox="0 0 26 36" aria-hidden="true">
      <path d="M13 35 C13 35 1 21 1 13 A12 12 0 0 1 25 13 C25 21 13 35 13 35 Z" fill="#ea4335" stroke="#a50e0e" stroke-width="1.5" />
      <circle cx="13" cy="13" r="4.5" fill="#7c1109" />
    </svg>`);
}

/** Small blue badge with the same arrow as the maneuver card. */
export function maneuverElement(modifier: string | null): HTMLDivElement {
  return el("route-maneuver", arrowFor(modifier ?? "straight"));
}

/** ETA card like Google Maps': blue for the active route, white for alternates. */
export function calloutElement(summary: { durationS: number; distanceM: number; toll: boolean }, active: boolean): HTMLDivElement {
  const minutes = Math.max(1, Math.round(summary.durationS / 60));
  const toll = summary.toll ? `<span class="route-callout-toll">Toll</span>` : "";
  return el(`route-callout ${active ? "route-callout-active" : ""}`,
    `<strong>${minutes} min</strong><span>${formatDistance(summary.distanceM)}</span>${toll}`);
}

/** A point `share` of the way along the line: callouts sit at different shares so they don't stack. */
export const shareAlong = (geometry: LngLat[], share: number) => pointAlong(geometry, lengthOf(geometry) * share);
