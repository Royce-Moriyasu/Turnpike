import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { DemoRoute, Frame } from "../types";
import MiniMap from "./MiniMap";
import Panel from "./Panel";
import { Segmented } from "./ui";
import {
  ALTERNATE_HIT_LAYER, MAP_STYLE, addRouteLayers, boundsOf, calloutElement, destinationElement,
  positionElement, positionOnRoute, routeLayerData, setRouteLayerData,
} from "./routeMapLayers";

const TOKEN: string | undefined = import.meta.env.VITE_MAPBOX_TOKEN;
const FOLLOW_ZOOM = 16;
const PADDING = 36;
// The other route's card follows the car, this far below the position dot so it doesn't cover it.
const CALLOUT_BELOW_DOT_PX = 16;

type Camera = "overview" | "follow";

interface Props {
  data: DemoRoute;
  routeKey: string;
  setRouteKey: (key: string) => void;
  frame: Frame;
  className?: string; // on the panel, e.g. flex-1 to fill the column
}

/**
 * The ROUTE panel: a Mapbox mini-map with the active route (colored by traffic when the bake has
 * it), alternates, ETA callouts and position/destination markers. Without a Mapbox token
 * it falls back to the plain SVG route (MiniMap).
 */
export default function RouteMiniMap(props: Props) {
  if (!TOKEN) return <MiniMap data={props.data} routeKey={props.routeKey} frame={props.frame} className={props.className} />;
  return <MapboxMiniMap {...props} token={TOKEN} />;
}

function MapboxMiniMap({ data, routeKey, setRouteKey, frame, className, token }: Props & { token: string }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markers = useRef<mapboxgl.Marker[]>([]);
  const position = useRef<mapboxgl.Marker | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [camera, setCamera] = useState<Camera>("follow");
  const setRouteKeyRef = useRef(setRouteKey);
  setRouteKeyRef.current = setRouteKey;

  const active = data.routes[routeKey];
  const [posLng, posLat] = positionOnRoute(data, routeKey, frame); // on the route line, not raw GPS

  // create the map once; remove it on unmount
  useEffect(() => {
    if (!container.current) return;
    const map = new mapboxgl.Map({
      accessToken: token,
      container: container.current,
      style: MAP_STYLE,
      bounds: boundsOf(Object.values(data.routes).map((r) => r.geometry)),
      fitBoundsOptions: { padding: PADDING },
      attributionControl: false,
      pitchWithRotate: false,
    });
    map.scrollZoom.disable();
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(new mapboxgl.AttributionControl({ compact: true }), "bottom-left");
    map.on("load", () => {
      addRouteLayers(map);
      map.on("click", ALTERNATE_HIT_LAYER, (e) => {
        const key = e.features?.[0]?.properties?.routeKey;
        if (typeof key === "string") setRouteKeyRef.current(key);
      });
      map.on("mouseenter", ALTERNATE_HIT_LAYER, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", ALTERNATE_HIT_LAYER, () => (map.getCanvas().style.cursor = ""));
      setLoaded(true);
    });
    position.current = new mapboxgl.Marker({ element: positionElement(), rotationAlignment: "map" })
      .setLngLat([posLng, posLat]).addTo(map);
    mapRef.current = map;
    // the panel's height follows the page layout, so keep the canvas in step with it
    const resize = new ResizeObserver(() => map.resize());
    resize.observe(container.current);
    return () => {
      resize.disconnect();
      map.remove();
      mapRef.current = null;
      position.current = null;
      setLoaded(false);
    };
    // created once; the effects below keep it in sync with the props
  }, [token]);

  // route lines: active (traffic colors, traveled part gray) over the alternates
  useEffect(() => {
    const map = mapRef.current;
    if (map && loaded) setRouteLayerData(map, routeLayerData(data, routeKey, frame.progressM));
  }, [loaded, data, routeKey, frame.progressM]);

  // callouts and destination pin
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const add = (m: mapboxgl.Marker) => markers.current.push(m.addTo(map));
    // One card per other route, with the same distance as the maneuver card (to that route's next
    // maneuver from here) and the time for it at the route's average speed. The active route has
    // no card: the maneuver card already shows it.
    for (const [key, r] of Object.entries(data.routes)) {
      const routeNav = frame.nav[key];
      if (key === routeKey || !routeNav) continue;
      const main = r.map?.main;
      const durationS = main?.durationS ?? r.durationS ?? 0;
      const speed = durationS > 0 ? (main?.distanceM ?? r.distanceM) / durationS : 0; // m/s
      const bubble = calloutElement(
        { durationS: speed > 0 ? routeNav.distanceM / speed : 0, distanceM: routeNav.distanceM, toll: main?.toll ?? false },
        false,
      );
      bubble.classList.add("route-callout-below");
      bubble.addEventListener("click", () => setRouteKey(key));
      // Rides with the car: that route's point at the car's distance along it (the same spot as the
      // position dot while the routes share the road), just below the dot.
      add(new mapboxgl.Marker({ element: bubble, anchor: "top", offset: [0, CALLOUT_BELOW_DOT_PX] })
        .setLngLat(positionOnRoute(data, key, frame)));
    }
    add(new mapboxgl.Marker({ element: destinationElement(), anchor: "bottom" }).setLngLat(active.geometry[active.geometry.length - 1]));
    return () => {
      markers.current.forEach((m) => m.remove());
      markers.current = [];
    };
  }, [data, routeKey, active, frame, setRouteKey]);

  // current position and heading
  useEffect(() => {
    position.current?.setLngLat([posLng, posLat]).setRotation(frame.heading ?? 0);
  }, [posLng, posLat, frame.heading]);

  // camera: whole route, or follow the car rotated to its heading
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (camera === "follow") {
      map.easeTo({ center: [posLng, posLat], zoom: FOLLOW_ZOOM, bearing: frame.heading ?? 0, duration: 600 });
    } else {
      map.fitBounds(boundsOf([active.geometry]), { padding: PADDING, bearing: 0, duration: 600 });
    }
  }, [camera, active, posLng, posLat, frame.heading]);

  return (
    <Panel
      title="Route"
      className={className}
      bodyClassName="p-0"
      right={
        <Segmented
          size="sm"
          ariaLabel="Map camera"
          value={camera}
          onChange={setCamera}
          options={[{ value: "overview", label: "Overview" }, { value: "follow", label: "Follow" }]}
        />
      }
    >
      <div ref={container} className="route-minimap h-full min-h-48 w-full overflow-hidden rounded-b-lg" />
    </Panel>
  );
}
