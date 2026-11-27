export interface Point {
  lat: number;
  lon: number;
}

export interface Place extends Point {
  id: string;
  name: string;
}

/** Eight well-known spots in the county, the same set the roofing CRM offers. */
export const PLACES: readonly Place[] = [
  { id: 'downtown', name: 'Downtown San Diego', lat: 32.7157, lon: -117.1611 },
  { id: 'la-jolla', name: 'La Jolla', lat: 32.8328, lon: -117.2713 },
  { id: 'chula-vista', name: 'Chula Vista', lat: 32.6401, lon: -117.0842 },
  { id: 'oceanside', name: 'Oceanside', lat: 33.1959, lon: -117.3795 },
  { id: 'escondido', name: 'Escondido', lat: 33.1192, lon: -117.0864 },
  { id: 'el-cajon', name: 'El Cajon', lat: 32.7948, lon: -116.9625 },
  { id: 'carlsbad', name: 'Carlsbad', lat: 33.1581, lon: -117.3506 },
  { id: 'encinitas', name: 'Encinitas', lat: 33.037, lon: -117.292 },
];

export const DEFAULT_PLACE: Place = {
  id: 'downtown',
  name: 'Downtown San Diego',
  lat: 32.7157,
  lon: -117.1611,
};

export const COUNTY_BBOX = { minLat: 32.5, maxLat: 33.55, minLon: -117.65, maxLon: -116.05 };
export const MAX_RADIUS_MILES = 25;

export const inCounty = (p: Point): boolean =>
  p.lat >= COUNTY_BBOX.minLat &&
  p.lat <= COUNTY_BBOX.maxLat &&
  p.lon >= COUNTY_BBOX.minLon &&
  p.lon <= COUNTY_BBOX.maxLon;

const MILES_PER_DEG_LAT = 69.0;

function spans(center: Point, radiusMiles: number): { dLat: number; dLon: number } {
  return {
    dLat: radiusMiles / MILES_PER_DEG_LAT,
    dLon: radiusMiles / (MILES_PER_DEG_LAT * Math.cos((center.lat * Math.PI) / 180)),
  };
}

/** A closed ring approximating a circle of `radiusMiles` around a point, as [lon, lat] pairs. */
export function circleRing(center: Point, radiusMiles: number, steps = 72): [number, number][] {
  const { dLat, dLon } = spans(center, radiusMiles);
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const angle = (i / steps) * 2 * Math.PI;
    ring.push([center.lon + dLon * Math.cos(angle), center.lat + dLat * Math.sin(angle)]);
  }
  return ring;
}

export function circleBounds(center: Point, radiusMiles: number): [number, number, number, number] {
  const { dLat, dLon } = spans(center, radiusMiles);
  return [center.lon - dLon, center.lat - dLat, center.lon + dLon, center.lat + dLat];
}
