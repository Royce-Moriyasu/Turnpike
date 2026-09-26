// Mirrors the output of bake/bake_route.py. Lane indices are always LEFT -> RIGHT.

export type Point = [number, number]; // normalized image coords, 0..1

export interface Lane {
  indications: string[];
  valid: boolean;
  active?: boolean;
  valid_indication?: string;
}

export interface NavState {
  instruction: string;
  maneuverType: string;
  modifier: string | null;
  distanceM: number;
  lanes: Lane[] | null;
  preferredLane: number | null;
  laneSide: "left" | "right" | null;
  laneSource: { lng: number; lat: number; distanceM: number } | null;
}

export interface Frame {
  id: string;
  image: string | null;
  lng: number;
  lat: number;
  heading: number | null;
  capturedAt: string | null;
  progressM: number;
  nav: Record<string, NavState | null>;
  lanePolygons: Point[][] | null;
}

export interface RouteInfo {
  label: string;
  geometry: [number, number][]; // [lng, lat]
  distanceM: number;
}

export interface DemoRoute {
  generatedAt: string;
  mode: "mapillary" | "synthetic";
  sequenceId: string | null;
  primaryRoute: string;
  routes: Record<string, RouteInfo>;
  frames: Frame[];
  attribution: string[];
}
