import type { FeatureCollection, Geometry } from 'geojson';
import maplibregl, {
  type GeoJSONSource,
  type Map as MapLibreMap,
  type Marker,
  type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import { circleBounds, circleRing, inCounty, type Point } from '../lib/places';
import type { MapPoint } from './mapColors';

export interface MapViewProps {
  pin: Point | null;
  radiusMiles: number | null;
  points: readonly MapPoint[];
  selectedId?: string | null;
  onPinChange?: (point: Point) => void;
  onSelect?: (id: string) => void;
  /** Jurisdiction codes whose city limits are shaded as having no permit data. */
  noDataCodes?: readonly string[];
  testId: string;
  ariaLabel: string;
}

const STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/positron';
const STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark';

/** Used only if the vector basemap cannot be fetched. */
const RASTER_FALLBACK: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

const SRC = { radius: 'ox-radius', points: 'ox-points', selected: 'ox-selected' } as const;
const POINT_LAYER = 'ox-points-dot';
/** City limits from SANDAG Municipal_Boundaries (scripts/fetch-city-limits.ts), served beside the page. */
const CITIES_URL = `${import.meta.env.BASE_URL}cities.geojson`;
const CITIES_SRC = 'ox-cities';
const NO_DATA_LAYERS = ['ox-nodata-fill', 'ox-nodata-line'] as const;

const codeFilter = (codes: readonly string[]): maplibregl.FilterSpecification => [
  'in',
  ['get', 'code'],
  ['literal', [...codes]],
];
const COUNTY_CENTER: [number, number] = [-117.0, 32.95];

type Features = FeatureCollection<Geometry>;
const EMPTY: Features = { type: 'FeatureCollection', features: [] };

const prefersDark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches;

async function resolveStyle(): Promise<string | StyleSpecification> {
  const url = prefersDark() ? STYLE_DARK : STYLE_LIGHT;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (response.ok) return url;
  } catch {
    // Fall through to the raster basemap.
  }
  return RASTER_FALLBACK;
}

function setData(map: MapLibreMap, source: string, data: Features): void {
  const target = map.getSource(source);
  if (target) (target as GeoJSONSource).setData(data);
}

function addLayers(map: MapLibreMap): void {
  const dark = prefersDark();
  const accent = dark ? '#3cc2b0' : '#0f6e64';
  for (const id of Object.values(SRC)) map.addSource(id, { type: 'geojson', data: EMPTY });
  map.addSource(CITIES_SRC, { type: 'geojson', data: CITIES_URL });
  map.addLayer({
    id: NO_DATA_LAYERS[0],
    type: 'fill',
    source: CITIES_SRC,
    filter: codeFilter([]),
    paint: { 'fill-color': dark ? '#9ca3af' : '#4b5563', 'fill-opacity': 0.28 },
  });
  map.addLayer({
    id: NO_DATA_LAYERS[1],
    type: 'line',
    source: CITIES_SRC,
    filter: codeFilter([]),
    paint: { 'line-color': dark ? '#d1d5db' : '#374151', 'line-width': 1.2, 'line-dasharray': [2, 2] },
  });
  map.addLayer({
    id: 'ox-radius-fill',
    type: 'fill',
    source: SRC.radius,
    paint: { 'fill-color': accent, 'fill-opacity': 0.07 },
  });
  map.addLayer({
    id: 'ox-radius-line',
    type: 'line',
    source: SRC.radius,
    paint: { 'line-color': accent, 'line-width': 2, 'line-dasharray': [3, 2] },
  });
  map.addLayer({
    id: POINT_LAYER,
    type: 'circle',
    source: SRC.points,
    paint: {
      'circle-radius': 5.5,
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.5,
    },
  });
  map.addLayer({
    id: 'ox-selected-ring',
    type: 'circle',
    source: SRC.selected,
    paint: {
      'circle-radius': 11,
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': dark ? '#ffffff' : '#111827',
      'circle-stroke-width': 2.5,
    },
  });
}

function pointsToFeatures(points: readonly MapPoint[]): Features {
  return {
    type: 'FeatureCollection',
    features: points.map((p) => ({
      type: 'Feature',
      properties: { id: p.id, label: p.label, color: p.color },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    })),
  };
}

/** MapLibre map with a search pin, a radius ring and result dots. No API key is needed. */
export default function MapView(props: MapViewProps) {
  const { pin, radiusMiles, points, selectedId, testId, ariaLabel, noDataCodes } = props;
  const noDataKey = (noDataCodes ?? []).join(',');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const handlersRef = useRef({ onPinChange: props.onPinChange, onSelect: props.onSelect });
  handlersRef.current = { onPinChange: props.onPinChange, onSelect: props.onSelect };
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let map: MapLibreMap | null = null;

    void resolveStyle().then((style) => {
      if (cancelled) return;
      try {
        map = new maplibregl.Map({
          container,
          style,
          center: COUNTY_CENTER,
          zoom: 8.6,
          attributionControl: { compact: true },
        });
      } catch (error) {
        setFailed(error instanceof Error ? error.message : 'The map could not start.');
        return;
      }
      mapRef.current = map;
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      map.on('load', () => {
        if (cancelled || !map) return;
        addLayers(map);
        setReady(true);
      });
      map.on('click', (event) => {
        if (!map) return;
        const hits = map.getLayer(POINT_LAYER)
          ? map.queryRenderedFeatures(event.point, { layers: [POINT_LAYER] })
          : [];
        const id = hits[0]?.properties?.id as unknown;
        if (typeof id === 'string') {
          handlersRef.current.onSelect?.(id);
          return;
        }
        const point = { lat: event.lngLat.lat, lon: event.lngLat.lng };
        if (inCounty(point)) handlersRef.current.onPinChange?.(point);
      });
      map.on('mouseenter', POINT_LAYER, (event) => {
        if (!map) return;
        map.getCanvas().style.cursor = 'pointer';
        const feature = event.features?.[0];
        const label = feature?.properties?.label as unknown;
        if (feature?.geometry.type === 'Point' && typeof label === 'string') {
          popupRef.current?.remove();
          const [lon, lat] = feature.geometry.coordinates as [number, number];
          popupRef.current = new maplibregl.Popup({ closeButton: false, offset: 10 })
            .setLngLat([lon, lat])
            .setText(label)
            .addTo(map);
        }
      });
      map.on('mouseleave', POINT_LAYER, () => {
        if (map) map.getCanvas().style.cursor = '';
        popupRef.current?.remove();
      });
    });

    return () => {
      cancelled = true;
      markerRef.current?.remove();
      markerRef.current = null;
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    markerRef.current?.remove();
    markerRef.current = null;
    if (pin) {
      markerRef.current = new maplibregl.Marker({ color: prefersDark() ? '#3cc2b0' : '#0f6e64' })
        .setLngLat([pin.lon, pin.lat])
        .addTo(map);
    }
    if (pin && radiusMiles !== null && radiusMiles > 0) {
      setData(map, SRC.radius, {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Polygon', coordinates: [circleRing(pin, radiusMiles)] },
          },
        ],
      });
      const [w, s, e, n] = circleBounds(pin, radiusMiles);
      map.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        { padding: 36, duration: 400, maxZoom: 15 },
      );
    } else {
      setData(map, SRC.radius, EMPTY);
      if (pin) map.easeTo({ center: [pin.lon, pin.lat], zoom: 12, duration: 400 });
    }
  }, [ready, pin, radiusMiles]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    setData(map, SRC.points, pointsToFeatures(points));
    if (!pin && points.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      for (const p of points) bounds.extend([p.lon, p.lat]);
      map.fitBounds(bounds, { padding: 40, duration: 400, maxZoom: 14 });
    }
  }, [ready, points, pin]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const codes = noDataKey ? noDataKey.split(',') : [];
    for (const layer of NO_DATA_LAYERS) {
      if (map.getLayer(layer)) map.setFilter(layer, codeFilter(codes));
    }
  }, [ready, noDataKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const selected = points.find((p) => p.id === selectedId);
    setData(map, SRC.selected, selected ? pointsToFeatures([selected]) : EMPTY);
  }, [ready, points, selectedId]);

  return (
    <div
      className="map-wrap"
      data-testid={testId}
      data-map-ready={ready ? 'true' : 'false'}
      data-point-count={points.length}
      data-no-data-codes={noDataKey}
    >
      <div ref={containerRef} className="map-canvas" role="application" aria-label={ariaLabel} />
      {failed ? (
        <p className="map-overlay map-failed" role="alert">
          The map could not be drawn ({failed}). The results table below still works.
        </p>
      ) : null}
    </div>
  );
}
