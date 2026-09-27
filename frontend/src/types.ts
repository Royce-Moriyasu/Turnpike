// Mirrors the output of bake/bake_route.py. Lane indices are always LEFT -> RIGHT.

export type Point = [number, number]; // normalized image coords, 0..1

export interface Lane {
  indications: string[];
  valid: boolean;
  active?: boolean; // Mapbox's flag (inferred by Mapbox when map data is missing)
  allowed?: boolean; // ours: this lane's arrows allow the movement the route makes here
  valid_indication?: string;
}

export interface NavState {
  instruction: string;
  maneuverType: string;
  modifier: string | null;
  distanceM: number;
  lanes: Lane[] | null;
  preferredLane: number | null;
  laneSide: "left" | "right" | null; // side of the turn ahead: which allowed lane is preferred
  laneAnchor?: "left" | "right" | null; // side to count visible lanes from when matching (bake: _lane_matching)
  laneAhead?: { left: number; right: number } | null; // turn lanes opening ahead that this snapshot doesn't list
  laneMovement?: string | null; // what the route does where these lanes apply, e.g. "straight"
  laneBasis?: "arrows" | "mapbox" | null; // how allowed lanes were decided
  laneToward?: string | null; // where the next turn leads, e.g. "I 95"
  laneReasons?: string[]; // why this lane, e.g. "Lane 5 only turns right"
  laneSource: { lng: number; lat: number; distanceM: number } | null;
}

/** One lane source's geometry for a frame (bake: LANE_SOURCES). */
export interface LaneSet {
  polygons: Point[][] | null;
  confidence: number | null;
  drivable?: (number | null)[] | null; // share of each polygon that is drivable road (YOLOPv2 only)
}

/** The lanes the overlay is drawing, and where they came from. */
export interface ActiveLanes {
  source: string | null; // e.g. "yolop"
  label: string; // e.g. "YOLOPv2"
  polygons: Point[][] | null;
  confidence: number | null;
  drivable?: (number | null)[] | null; // per polygon, see LaneSet
}

/** A YOLOPv2 vehicle detection (vision/yolop_masks.py): box as fractions of the image. */
export interface Vehicle {
  box: [number, number, number, number]; // x0, y0, x1, y1
  confidence: number;
}

export interface Frame {
  id: string;
  image: string | null;
  lng: number;
  lat: number;
  heading: number | null;
  headingSource?: "camera" | "route";
  capturedAt: string | null;
  progressM: number;
  nav: Record<string, NavState | null>;
  lanePolygons: Point[][] | null; // default source's lanes (see laneSets)
  polygonSource?: string | null;
  laneSets?: Record<string, LaneSet>; // every lane source's geometry for this frame
  vehicles?: Vehicle[]; // YOLOPv2 vehicle boxes
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
  laneSources?: Record<string, { label: string; method: string | null }>; // in preference order
  clip?: { name: string; title: string };
  camera?: {
    vanishingPoint: [number, number]; // from the clip's clip.json
    horizonY: number;
    imageSize?: [number, number] | null; // the photos' [width, height]
  };
}
