import path from 'node:path';

/** Generous San Diego County bounding box (WGS84). Coordinates outside it are rejected. */
export const COUNTY_BBOX = { minLat: 32.5, maxLat: 33.55, minLon: -117.65, maxLon: -116.05 } as const;

/** Earliest date accepted for any event date (applied, issued, closed, transfer). */
export const MIN_DATE = '1900-01-01';
/** Latest date accepted for forward-looking dates such as permit or licence expiry. */
export const MAX_FUTURE_DATE = '2100-12-31';

export const USER_AGENT = 'oracle-pipeline/0.1 (public open-data loader)';

export interface Paths {
  readonly dataDir: string;
  readonly rawDir: string;
  readonly stageDir: string;
  readonly dbPath: string;
}

export function resolvePaths(dataDir: string, dbPath?: string): Paths {
  const root = path.resolve(dataDir);
  return {
    dataDir: root,
    rawDir: path.join(root, 'raw'),
    stageDir: path.join(root, 'stage'),
    dbPath: dbPath === undefined ? path.join(root, 'oracle.duckdb') : path.resolve(dbPath),
  };
}

/** A half-open change window [from, to). Either bound may be absent. Dates are YYYY-MM-DD (UTC). */
export interface Window {
  readonly from: string | null;
  readonly to: string | null;
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}
