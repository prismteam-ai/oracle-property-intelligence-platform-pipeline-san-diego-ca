import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { COUNTY_BBOX } from '../config.js';
import { ARTIFACTS, type Coverage } from '../publish/exportArtifacts.js';
import { MAX_QUERY_ROWS, guardSelect } from './sqlGuard.js';
import type { Param, Store } from './store.js';

const EARTH_RADIUS_MILES = 3958.7613;
const MILES_PER_DEGREE = 69.0;
export const MAX_RADIUS_MILES = 25;

/** Input contract of `findRoofingLeads`. Checked here, at the door, for every caller. */
export const leadSearchInput = z.object({
  center: z.object({
    lat: z.number().min(COUNTY_BBOX.minLat).max(COUNTY_BBOX.maxLat),
    lon: z.number().min(COUNTY_BBOX.minLon).max(COUNTY_BBOX.maxLon),
  }),
  radiusMiles: z.number().positive().max(MAX_RADIUS_MILES).default(1),
  minRoofAgeYears: z.number().int().min(0).max(150).default(15),
  minOpenYears: z.number().min(0).max(60).default(0),
  signal: z.enum(['any', 'aged_roof', 'open_permit', 'both']).default('any'),
  permitStatus: z.enum(['any', 'open', 'closed']).default('any'),
  /** Only parcels whose last recorded ownership document is at least this many years old. */
  minYearsSinceTransfer: z.number().min(0).max(120).optional(),
  /** `no` is the available proxy for an out-of-area owner (see `out_of_area_basis`). */
  ownerOccupied: z.enum(['any', 'yes', 'no']).default('any'),
  sort: z.enum(['score', 'distance', 'roof_age', 'open_days']).default('score'),
  limit: z.number().int().min(1).max(500).default(200),
  offset: z.number().int().min(0).default(0),
});
export type LeadSearchInput = z.infer<typeof leadSearchInput>;

const num = z.coerce.number();
const intOrNull = z.coerce.number().int().nullable();
const text = z.string().nullable();

const leadRow = z.object({
  apn: z.string(),
  address: text,
  unit: text.optional(),
  city: text,
  zip: text,
  lat: num,
  lon: num,
  distanceMiles: num,
  roofYear: intOrNull,
  roofAgeYears: intOrNull,
  roofBasis: z.enum(['last_roofing_permit', 'year_built', 'unknown']),
  roofConfidence: text,
  openRoofPermits: z.coerce.number().int(),
  longestOpenDays: intOrNull,
  topOpenPermitId: text,
  topOpenContractor: text,
  topOpenLicenseNo: text,
  ownerOccupied: z.boolean().nullable(),
  lastTransferDate: text,
  useType: text,
});
export type LeadRow = z.infer<typeof leadRow>;

export interface JurisdictionCoverage {
  code: string;
  name: string;
  parcels: number;
  permitFeed: boolean;
}

export interface LeadSearchResult {
  total: number;
  agedRoofCount: number;
  openPermitCount: number;
  asOf: string;
  /** Says plainly when part of the search area has no permit data, so a zero is never silent. */
  coverageNote: string | null;
  coverage: JurisdictionCoverage[];
  rows: LeadRow[];
}

/** Assessor jurisdiction codes on the parcel layer. */
export const JURISDICTION_NAMES: Readonly<Record<string, string>> = {
  SD: 'City of San Diego',
  CN: 'unincorporated county',
  CB: 'Carlsbad',
  CV: 'Chula Vista',
  OC: 'Oceanside',
  ES: 'Escondido',
  SM: 'San Marcos',
  VS: 'Vista',
  EN: 'Encinitas',
  EC: 'El Cajon',
  ST: 'Santee',
  LM: 'La Mesa',
  PW: 'Poway',
  SO: 'Solana Beach',
  CO: 'Coronado',
  NC: 'National City',
  LG: 'Lemon Grove',
  IB: 'Imperial Beach',
  DM: 'Del Mar',
};

/** A jurisdiction counts as having a permit feed once this many of its parcels carry permits. */
const MIN_PERMITS_FOR_FEED = 500;
const feedCache = new WeakMap<Store, Promise<ReadonlySet<string>>>();

/** Which jurisdictions actually have permit data, read from the data itself, once per store. */
export function permitFeedJurisdictions(store: Store): Promise<ReadonlySet<string>> {
  let cached = feedCache.get(store);
  if (!cached) {
    cached = store
      .query(
        z.object({ jurisdiction: z.string() }),
        `SELECT p.jurisdiction FROM permit m JOIN parcel p ON p.apn = m.apn
         WHERE p.jurisdiction IS NOT NULL GROUP BY 1 HAVING count(*) >= ${MIN_PERMITS_FOR_FEED}`,
      )
      .then((rows) => new Set(rows.map((r) => r.jurisdiction)));
    feedCache.set(store, cached);
  }
  return cached;
}

const listNames = (items: JurisdictionCoverage[]): string => {
  const names = items.map((j) => j.name);
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
};

export function coverageNote(coverage: JurisdictionCoverage[]): string | null {
  const total = coverage.reduce((sum, j) => sum + j.parcels, 0);
  // A handful of stray parcels coded to another city is not a coverage gap worth a banner.
  const material = (j: JurisdictionCoverage): boolean => j.parcels / Math.max(1, total) >= 0.01;
  const without = coverage.filter((j) => !j.permitFeed && material(j));
  if (without.length === 0) return null;
  const withFeed = coverage.filter((j) => j.permitFeed && material(j));
  const share = Math.round((without.reduce((sum, j) => sum + j.parcels, 0) / Math.max(1, total)) * 100);
  if (withFeed.length === 0) {
    return `No permit data is published for ${listNames(without)}, so open-permit filters return nothing here. Roof-age results are complete.`;
  }
  return `The permits shown here come from ${listNames(withFeed)}, which publish permits. Parcels inside the city limits of ${listNames(without)} (${share}% of parcels in this radius) can never show an open permit, because those cities publish no permit feed. A row may still carry one of those city names: that is its mailing address, not the city that issued the permit. Roof-age results are complete.`;
}

const columnCache = new WeakMap<Store, Map<string, Promise<Set<string>>>>();

/** Lets the serving code read snapshots published before a column existed. */
async function hasColumn(store: Store, relation: string, column: string): Promise<boolean> {
  let perStore = columnCache.get(store);
  if (!perStore) {
    perStore = new Map();
    columnCache.set(store, perStore);
  }
  let columns = perStore.get(relation);
  if (!columns) {
    columns = store
      .query(z.object({ column_name: z.string() }), `DESCRIBE ${relation}`)
      .then((rows) => new Set(rows.map((r) => r.column_name)));
    perStore.set(relation, columns);
  }
  return (await columns).has(column);
}

const SIGNAL_SQL: Record<LeadSearchInput['signal'], string> = {
  any: '(aged OR has_open)',
  aged_roof: 'aged',
  open_permit: 'has_open',
  both: '(aged AND has_open)',
};

const STATUS_SQL: Record<LeadSearchInput['permitStatus'], string> = {
  any: 'TRUE',
  open: 'open_roof_permits > 0',
  closed: '(roof_permits > 0 AND open_roof_permits = 0)',
};

/** At equal roof age (or equal score) a roof dated by a permit ranks ahead of a year-built proxy. */
const PERMIT_EVIDENCE_FIRST = "(roof_basis = 'last_roofing_permit') DESC";

const SORT_SQL: Record<LeadSearchInput['sort'], string> = {
  score: `rank_score DESC, ${PERMIT_EVIDENCE_FIRST}, distance_miles`,
  distance: 'distance_miles',
  roof_age: `roof_age_years DESC NULLS LAST, ${PERMIT_EVIDENCE_FIRST}, distance_miles`,
  open_days: 'longest_open_days DESC NULLS LAST, distance_miles',
};

/**
 * Radius search. A bounding box prunes Parquet row groups first (the file is sorted on a lat/lon
 * grid), then the exact great-circle distance is applied. `today` is passed in so roof age and
 * open duration are computed at question time, never stored stale.
 */
function candidatesCte(): string {
  return `
    WITH box AS (
      SELECT *,
        ${EARTH_RADIUS_MILES} * 2 * asin(least(1, sqrt(
          pow(sin(radians(lat - $lat) / 2), 2) +
          cos(radians($lat)) * cos(radians(lat)) * pow(sin(radians(lon - $lon) / 2), 2)))) AS distance_miles
      FROM parcel
      WHERE lat BETWEEN $minLat AND $maxLat AND lon BETWEEN $minLon AND $maxLon
    ),
    near AS (
      SELECT *,
        (year($today::DATE) - roof_year)::INTEGER AS roof_age_years,
        CASE WHEN open_roof_permits > 0
             THEN date_diff('day', longest_open_since, $today::DATE)::INTEGER END AS longest_open_days
      FROM box WHERE distance_miles <= $radius
    ),
    flagged AS (
      SELECT *,
        coalesce(roof_age_years >= $minAge, FALSE) AS aged,
        (open_roof_permits > 0 AND coalesce(longest_open_days, 0) >= $minOpenDays) AS has_open,
        -- Dates whose century had to be guessed never count, so "10+ years" is not an artefact.
        ($minTransferDays < 0 OR (last_transfer_date IS NOT NULL
          AND NOT coalesce(last_transfer_ambiguous, FALSE)
          AND date_diff('day', last_transfer_date, $today::DATE) >= $minTransferDays)) AS transfer_ok
      FROM near
    ),
    scored AS (
      SELECT *,
        (CASE WHEN has_open THEN least(55, 25 + round(coalesce(longest_open_days, 0) / 365.25 * 6)) ELSE 0 END
         + CASE WHEN aged THEN least(35, 15 + round((roof_age_years - $minAge) * 0.8))
                             + (CASE WHEN roof_basis = 'last_roofing_permit' THEN 5 ELSE 0 END) ELSE 0 END
        ) AS rank_score
      FROM flagged
    )`;
}

export async function findRoofingLeads(
  store: Store,
  rawInput: unknown,
  today: string,
): Promise<LeadSearchResult> {
  const input = leadSearchInput.parse(rawInput);
  const dLat = input.radiusMiles / MILES_PER_DEGREE;
  const dLon = input.radiusMiles / (MILES_PER_DEGREE * Math.cos((input.center.lat * Math.PI) / 180));
  const named: Record<string, Param> = {
    lat: input.center.lat,
    lon: input.center.lon,
    minLat: input.center.lat - dLat,
    maxLat: input.center.lat + dLat,
    minLon: input.center.lon - dLon,
    maxLon: input.center.lon + dLon,
    radius: input.radiusMiles,
    today,
    minAge: input.minRoofAgeYears,
    minOpenDays: Math.round(input.minOpenYears * 365.25),
  };
  const ownership: string[] = [];
  // Always bound (a statement must use every named parameter): -1 switches the filter off.
  named['minTransferDays'] =
    input.minYearsSinceTransfer === undefined ? -1 : Math.round(input.minYearsSinceTransfer * 365.25);
  if (input.minYearsSinceTransfer !== undefined) ownership.push('transfer_ok');
  if (input.ownerOccupied === 'yes') ownership.push('owner_occupied IS TRUE');
  if (input.ownerOccupied === 'no') ownership.push('owner_occupied IS NOT TRUE');
  // An ownership filter is a signal in its own right: with one set, `any` no longer also
  // requires an aged roof or an open permit.
  const signal = ownership.length > 0 && input.signal === 'any' ? 'TRUE' : SIGNAL_SQL[input.signal];
  const where = [signal, STATUS_SQL[input.permitStatus], ...ownership].join(' AND ');

  const totals = await store.queryNamed(
    z.object({ total: num, aged: num, open: num }),
    `${candidatesCte()}
     SELECT count(*) AS total, count(*) FILTER (aged) AS aged, count(*) FILTER (has_open) AS open
     FROM scored WHERE ${where}`,
    named,
  );
  const rows = await store.queryNamed(
    leadRow,
    `${candidatesCte()}
     SELECT apn, address, ${(await hasColumn(store, 'parcel', 'unit')) ? 'unit' : 'NULL AS unit'}, city, zip, lat, lon,
            round(distance_miles, 3) AS "distanceMiles",
            roof_year AS "roofYear", roof_age_years AS "roofAgeYears",
            roof_basis AS "roofBasis", roof_confidence AS "roofConfidence",
            open_roof_permits AS "openRoofPermits", longest_open_days AS "longestOpenDays",
            top_open_permit_id AS "topOpenPermitId", top_open_contractor AS "topOpenContractor",
            top_open_license_no AS "topOpenLicenseNo",
            owner_occupied AS "ownerOccupied", last_transfer_date::VARCHAR AS "lastTransferDate",
            CASE WHEN use_code IS NOT NULL THEN 'Assessor use code ' || use_code END AS "useType"
     FROM scored WHERE ${where}
     ORDER BY ${SORT_SQL[input.sort]}, apn
     LIMIT ${input.limit} OFFSET ${input.offset}`,
    named,
  );
  const feeds = await permitFeedJurisdictions(store);
  const inRadius = await store.queryNamed(
    z.object({ code: z.string().nullable(), parcels: num }),
    `${candidatesCte()}
     SELECT jurisdiction AS code, count(*) AS parcels FROM scored GROUP BY 1 ORDER BY parcels DESC`,
    named,
  );
  const coverage: JurisdictionCoverage[] = inRadius
    .filter((j): j is { code: string; parcels: number } => j.code !== null)
    .map((j) => ({
      code: j.code,
      name: JURISDICTION_NAMES[j.code] ?? j.code,
      parcels: j.parcels,
      permitFeed: feeds.has(j.code),
    }));
  const t = totals[0] ?? { total: 0, aged: 0, open: 0 };
  return {
    total: t.total,
    agedRoofCount: t.aged,
    openPermitCount: t.open,
    asOf: today,
    coverageNote: coverageNote(coverage),
    coverage,
    rows,
  };
}

const provenance = z.object({
  source: z.string(),
  sourceRecordId: text,
  sourceUrl: text,
  fetchedAt: text,
});

const permitOut = z.object({
  permitId: z.string(),
  apn: text,
  permitType: text,
  roofingClass: text,
  isRoofing: z.boolean(),
  status: text,
  /** open | pending (applied, not issued) | completed | expired | cancelled | other */
  statusGroup: text,
  isOpen: z.boolean(),
  appliedDate: text,
  issuedDate: text,
  closedDate: text,
  daysOpen: intOrNull,
  description: text,
  contractor: z
    .object({
      name: text,
      licenseNumber: text,
      licenseStatus: text,
      classifications: text,
      phone: text,
      bbbRating: text,
      bbbUrl: text,
      bbbNote: text,
    })
    .nullable(),
  provenance,
});

export const propertyOut = z.object({
  apn: z.string(),
  address: text,
  unit: text.optional(),
  city: text,
  zip: text,
  lat: num,
  lon: num,
  yearBuilt: intOrNull,
  roofYear: intOrNull,
  roofAgeYears: intOrNull,
  roofBasis: z.enum(['last_roofing_permit', 'year_built', 'unknown']),
  roofConfidence: text,
  useType: text,
  ownerOccupied: z.boolean().nullable(),
  ownerName: text,
  ownerMailing: text,
  lastTransferDate: text,
  yearsSinceTransfer: intOrNull,
  permits: z.array(permitOut),
  provenance,
});
export type PropertyOut = z.infer<typeof propertyOut>;

const parcelDetailRow = z.object({
  apn: z.string(),
  address: text,
  unit: text.optional(),
  city: text,
  zip: text,
  lat: num,
  lon: num,
  year_built: intOrNull,
  roof_year: intOrNull,
  roof_age_years: intOrNull,
  roof_basis: z.enum(['last_roofing_permit', 'year_built', 'unknown']),
  roof_confidence: text,
  roof_confidence_reason: text,
  use_code: text,
  owner_occupied: z.boolean().nullable(),
  owner_name: text,
  owner_mail_city: text,
  owner_mail_state: text,
  last_transfer_date: text,
  years_since_transfer: intOrNull,
  source_id: z.string(),
  source_record_id: text,
  source_url: text,
  fetched_at: text,
});

const permitDetailRow = z.object({
  permit_id: z.string(),
  apn: text,
  permit_type: text,
  permit_subtype: text,
  roofing_class: text,
  is_roofing: z.boolean(),
  status: text,
  status_group: text,
  is_open: z.boolean(),
  applied_date: text,
  issued_date: text,
  closed_date: text,
  days_open: intOrNull,
  description: text,
  project_title: text,
  holder_name: text,
  contractor_name: text,
  contractor_license_no: text,
  contractor_license_status: text,
  contractor_classifications: text,
  contractor_phone: text,
  bbb_rating: text,
  bbb_url: text,
  bbb_note: text,
  source_id: z.string(),
  source_record_id: text,
  source_url: text,
  fetched_at: text,
});

export const normalizeApn = (apn: string): string => apn.replace(/\D/g, '');

/** One parcel with every permit on it, contractor and licence, and where each fact came from. */
export async function getOracleProperty(
  store: Store,
  apnInput: string,
  today: string,
): Promise<PropertyOut | null> {
  const apn = normalizeApn(apnInput);
  if (!/^\d{10}$/.test(apn)) return null;
  const parcels = await store.queryNamed(
    parcelDetailRow,
    `SELECT apn, address, ${(await hasColumn(store, 'parcel', 'unit')) ? 'unit' : 'NULL AS unit'}, city, zip, lat, lon, year_built, roof_year,
            (year($today::DATE) - roof_year)::INTEGER AS roof_age_years,
            roof_basis, roof_confidence, roof_confidence_reason, use_code,
            owner_occupied, owner_name, owner_mail_city, owner_mail_state,
            last_transfer_date::VARCHAR AS last_transfer_date,
            date_diff('year', last_transfer_date, $today::DATE)::INTEGER AS years_since_transfer,
            source_id, source_record_id, source_url, fetched_at::VARCHAR AS fetched_at
     FROM parcel WHERE apn = $apn`,
    { apn, today },
  );
  const p = parcels[0];
  if (!p) return null;

  const permits = await store.queryNamed(
    permitDetailRow,
    `SELECT pm.permit_id, pm.apn, pm.permit_type, pm.permit_subtype, pm.roofing_class, pm.is_roofing,
            pm.status, pm.status_group, pm.is_open,
            pm.applied_date::VARCHAR AS applied_date, pm.issued_date::VARCHAR AS issued_date,
            pm.closed_date::VARCHAR AS closed_date,
            CASE WHEN pm.open_since IS NOT NULL
                 THEN date_diff('day', pm.open_since, coalesce(pm.closed_date, $today::DATE))::INTEGER END AS days_open,
            pm.description, pm.project_title, pm.holder_name,
            pm.contractor_name, pm.contractor_license_no, pm.contractor_license_status,
            pm.contractor_classifications, c.phone AS contractor_phone,
            pm.bbb_rating, pm.bbb_url, pm.bbb_note,
            pm.source_id, pm.source_record_id, pm.source_url, pm.fetched_at::VARCHAR AS fetched_at
     FROM permit pm LEFT JOIN contractor c ON c.contractor_id = pm.contractor_id
     WHERE pm.apn = $apn
     ORDER BY pm.is_roofing DESC, pm.is_open DESC, coalesce(pm.applied_date, pm.issued_date) DESC NULLS LAST
     LIMIT 200`,
    { apn, today },
  );

  const mailing = [p.owner_mail_city, p.owner_mail_state].filter((v) => v !== null).join(', ');
  return {
    apn: p.apn,
    address: p.address,
    unit: p.unit ?? null,
    city: p.city,
    zip: p.zip,
    lat: p.lat,
    lon: p.lon,
    yearBuilt: p.year_built,
    roofYear: p.roof_year,
    roofAgeYears: p.roof_age_years,
    roofBasis: p.roof_basis,
    roofConfidence:
      p.roof_confidence === null
        ? null
        : `${p.roof_confidence}${p.roof_confidence_reason ? `: ${p.roof_confidence_reason}` : ''}`,
    useType: p.use_code === null ? null : `Assessor use code ${p.use_code}`,
    ownerOccupied: p.owner_occupied,
    ownerName: p.owner_name,
    ownerMailing: mailing === '' ? null : mailing,
    lastTransferDate: p.last_transfer_date,
    yearsSinceTransfer: p.years_since_transfer,
    permits: permits.map((m) => {
      const name = m.contractor_name ?? m.holder_name;
      const hasContractor = name !== null || m.contractor_license_no !== null;
      return {
        permitId: m.permit_id,
        apn: m.apn,
        permitType: [m.permit_type, m.permit_subtype].filter((v) => v !== null).join(' / ') || null,
        roofingClass: m.roofing_class,
        isRoofing: m.is_roofing,
        status: m.status,
        statusGroup: m.status_group,
        isOpen: m.is_open,
        appliedDate: m.applied_date,
        issuedDate: m.issued_date,
        closedDate: m.closed_date,
        daysOpen: m.days_open,
        description: m.description ?? m.project_title,
        contractor: hasContractor
          ? {
              name,
              licenseNumber: m.contractor_license_no,
              licenseStatus: m.contractor_license_status,
              classifications: m.contractor_classifications,
              phone: m.contractor_phone,
              bbbRating: m.bbb_rating,
              bbbUrl: m.bbb_url,
              bbbNote:
                m.bbb_rating === null ? (m.bbb_note ?? 'BBB rating not available in the source data.') : null,
            }
          : null,
        provenance: {
          source: m.source_id,
          sourceRecordId: m.source_record_id,
          sourceUrl: m.source_url,
          fetchedAt: m.fetched_at,
        },
      };
    }),
    provenance: {
      source: p.source_id,
      sourceRecordId: p.source_record_id,
      sourceUrl: p.source_url,
      fetchedAt: p.fetched_at,
    },
  };
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  sql: string;
}

/** One read-only SELECT over the published relations, capped at 1,000 rows. */
export async function queryAtlas(store: Store, sql: string): Promise<QueryResult> {
  const guarded = guardSelect(sql);
  const out = await store.raw(guarded);
  const truncated = out.rows.length > MAX_QUERY_ROWS;
  const rows = truncated ? out.rows.slice(0, MAX_QUERY_ROWS) : out.rows;
  return { columns: out.columns, rows, rowCount: rows.length, truncated, sql: sql.trim() };
}

const sourceRow = z.object({
  source_id: z.string(),
  name: z.string(),
  url: text,
  limits: text,
  state_updated_at: text.optional(),
  /** ISO 8601 UTC, present from run 7 on. */
  last_fetched_at_utc: text.optional(),
});

const manifestHead = z.object({ rootCid: z.string() }).partial();

async function readJson(dir: string, name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(dir, ...name.split('/')), 'utf8')) as unknown;
}

export interface DatasetInfo {
  county: string;
  asOf: string;
  lastRunId: string | null;
  counts: { table: string; rows: number }[];
  sources: {
    name: string;
    url: string | null;
    rows: number | null;
    fetchedAt: string | null;
    limits: string | null;
  }[];
  manifestCid: string | null;
}

/** Counts, sources, as-of time and the published root CID, read from the run's own artifacts. */
export async function getAtlasDatasetInfo(store: Store): Promise<DatasetInfo> {
  const coverage = (await readJson(store.artifactDir, ARTIFACTS.coverage)) as Coverage;
  const sources = z.array(sourceRow).parse(await readJson(store.artifactDir, ARTIFACTS.sources));
  const history = z
    .object({
      stats: z.array(
        z.object({ source_id: z.string(), fetched: z.coerce.number().nullable(), run_id: z.coerce.number() }),
      ),
    })
    .parse(await readJson(store.artifactDir, ARTIFACTS.runHistory));
  const fetchedBySource = new Map<string, number>();
  for (const s of history.stats) {
    fetchedBySource.set(s.source_id, Math.max(fetchedBySource.get(s.source_id) ?? 0, s.fetched ?? 0));
  }
  const manifestCid = await readJson(store.artifactDir, 'manifest.json').then(
    (json) => manifestHead.parse(json).rootCid ?? null,
    () => null, // not published yet
  );
  return {
    county: coverage.county,
    asOf: coverage.asOf,
    lastRunId: String(coverage.runId),
    counts: coverage.counts,
    sources: sources.map((s) => ({
      name: s.name,
      url: s.url,
      rows: fetchedBySource.get(s.source_id) ?? null,
      fetchedAt: s.last_fetched_at_utc ?? s.state_updated_at ?? null,
      limits: s.limits,
    })),
    manifestCid,
  };
}

const describeRow = z.object({ column_name: z.string(), column_type: z.string() });

const RELATION_NOTES: Record<string, string> = {
  parcel:
    'One row per parcel (APN, 10 digits). roof_year + roof_basis (last_roofing_permit | year_built | unknown) + roof_confidence are the roof-age proxy; compute age as year(current_date) - roof_year. open_roof_permits and longest_open_since describe open roofing permits. last_transfer_date is the last recorded ownership document. out_of_area is a proxy (not owner-occupied); owner_name and owner mailing fields are NULL because no public source has them.',
  permit:
    "One row per permit (City of San Diego and unincorporated county). is_roofing is true only for real roofing work (roofing_class reroof | roof repair | roof structural); solar-on-roof is excluded. is_open + open_since give open duration: date_diff('day', open_since, current_date). contractor_* fields come from the CSLB licence match; bbb_rating is NULL with the reason in bbb_note. Join to parcel on apn.",
  contractor: 'Reconciled contractors keyed on CSLB licence number. is_c39 marks the roofing classification.',
  business: 'City of San Diego active business tax certificates, with coordinates.',
  place:
    'Gazetteer derived from the parcels: name (city or ZIP), kind (city | zip), centre lat/lon, parcel count.',
};

/** Human- and model-readable schema of the queryable relations. */
export async function getAtlasSchema(store: Store): Promise<string> {
  const parts: string[] = [];
  for (const [relation, note] of Object.entries(RELATION_NOTES)) {
    const columns = await store.query(describeRow, `DESCRIBE ${relation}`);
    parts.push(
      `${relation}(${columns.map((c) => `${c.column_name} ${c.column_type}`).join(', ')})\n  -- ${note}`,
    );
  }
  parts.push(
    `Distance in miles between a point and a row: ${EARTH_RADIUS_MILES} * 2 * asin(sqrt(pow(sin(radians(lat - LAT) / 2), 2) + cos(radians(LAT)) * cos(radians(lat)) * pow(sin(radians(lon - LON) / 2), 2))). Pre-filter with lat BETWEEN and lon BETWEEN.`,
  );
  return parts.join('\n\n');
}
