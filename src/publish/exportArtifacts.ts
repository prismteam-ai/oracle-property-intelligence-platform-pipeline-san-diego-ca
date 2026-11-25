import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { COUNTY_BBOX } from '../config.js';
import type { Db } from '../db.js';

export const COUNTY_SLUG = 'san-diego';

/** Logical names of the published objects. The serving layer and the manifest both use these. */
export const ARTIFACTS = {
  queryTable: 'query-table.parquet',
  permits: 'permits.parquet',
  contractors: 'contractors.parquet',
  businesses: 'businesses.parquet',
  places: 'places.parquet',
  runHistory: 'run-history.json',
  sources: 'sources.json',
  coverage: 'coverage.json',
  sampleOpenPermits: 'samples/long-open-roofing-permits.csv',
  sampleAgedRoofs: 'samples/aged-roofs-sample.csv',
} as const;

export interface ExportedArtifact {
  name: string;
  path: string;
}

export interface ExportResult {
  runId: number;
  dir: string;
  artifacts: ExportedArtifact[];
  coverage: Coverage;
}

const countRow = z.object({ n: z.coerce.number() });

const gateRow = z.object({
  total: z.coerce.number(),
  distinct_apn: z.coerce.number(),
  null_apn: z.coerce.number(),
  outside_bbox: z.coerce.number(),
  property_rows: z.coerce.number(),
});

export interface Coverage {
  county: string;
  countySlug: string;
  fips: string;
  runId: number;
  asOf: string;
  bbox: typeof COUNTY_BBOX;
  counts: { table: string; rows: number }[];
  roofing: {
    roofingPermits: number;
    openRoofingPermits: number;
    openFiveYearsPlus: number;
    openRoofingPermitsWithoutParcel: number;
    parcelsWithRoofYear: number;
    parcelsRoofFromPermit: number;
  };
  rejects: { source: string; entity: string; reason: string; rows: number }[];
  limitations: string[];
}

/** Forward slashes and doubled quotes, so a Windows path is a valid SQL string literal. */
const sqlPath = (p: string): string => `'${p.replace(/\\/g, '/').replace(/'/g, "''")}'`;

const PARQUET = `(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 40000)`;

/**
 * One flat row per parcel: the facts the CRM and the agent filter on. Sorted on a coarse lat/lon
 * grid so a radius query touches a few row groups, not the whole file.
 */
const QUERY_TABLE_SQL = `
  WITH open_roof AS (
    SELECT apn,
           count(*)::INTEGER AS open_roof_permits,
           min(open_since) AS longest_open_since,
           arg_min(permit_uid, open_since) AS top_open_permit_uid,
           arg_min(source_permit_id, open_since) AS top_open_permit_id,
           arg_min(contractor_name, open_since) AS top_open_contractor,
           arg_min(contractor_license_no, open_since) AS top_open_license_no
    FROM permit_enriched
    WHERE is_roofing AND is_open AND apn IS NOT NULL
    GROUP BY apn
  ),
  roof_all AS (
    SELECT apn,
           count(*)::INTEGER AS roof_permits,
           max(coalesce(effective_closed_date, issued_date, applied_date)) AS last_roof_permit_date
    FROM permit_enriched
    WHERE is_roofing AND apn IS NOT NULL
    GROUP BY apn
  )
  SELECT
    p.apn,
    p.situs_address AS address,
    p.situs_unit AS unit,
    p.situs_city AS city,
    p.situs_zip AS zip,
    p.situs_juris AS jurisdiction,
    p.lat, p.lon,
    p.use_code,
    p.units,
    p.living_area_sqft,
    p.assessed_total,
    p.year_effective AS year_built,
    p.year_ambiguous AS year_built_ambiguous,
    r.roof_year::INTEGER AS roof_year,
    CASE r.basis
      WHEN 'last completed roofing permit' THEN 'last_roofing_permit'
      WHEN 'year built/effective year' THEN 'year_built'
      ELSE 'unknown' END AS roof_basis,
    r.confidence AS roof_confidence,
    r.confidence_reason AS roof_confidence_reason,
    r.evidence_permit_uid AS roof_evidence_permit_uid,
    o.owner_occupied,
    o.out_of_area,
    o.out_of_area_basis,
    o.last_transfer_date,
    o.last_transfer_ambiguous,
    o.owner_name,
    o.mail_city AS owner_mail_city,
    o.mail_state AS owner_mail_state,
    o.owner_fields_note,
    coalesce(k.open_roof_permits, 0) AS open_roof_permits,
    k.longest_open_since,
    k.top_open_permit_uid,
    k.top_open_permit_id,
    k.top_open_contractor,
    k.top_open_license_no,
    coalesce(a.roof_permits, 0) AS roof_permits,
    a.last_roof_permit_date,
    p.source_id,
    p.source_record_id,
    p.source_url,
    p.fetched_at,
    p.last_seen_run
  FROM property p
  LEFT JOIN roof_signal r USING (apn)
  LEFT JOIN ownership o USING (apn)
  LEFT JOIN open_roof k USING (apn)
  LEFT JOIN roof_all a USING (apn)
  ORDER BY floor(p.lat * 40), floor(p.lon * 40), p.apn`;

const PERMITS_SQL = `
  SELECT permit_uid, source_permit_id AS permit_id, jurisdiction, apn, apn_matched_property,
         permit_type, permit_subtype, description, project_title,
         roofing_class, is_roofing, roofing_rule,
         status, status_group, is_open,
         applied_date, issued_date, effective_closed_date AS closed_date, closed_date_basis,
         expire_date, open_since, valuation,
         holder_name, address, city, zip,
         geo_lat AS lat, geo_lon AS lon, geo_basis,
         contractor_id, contractor_match_method, contractor_name, contractor_license_no,
         contractor_license_status, contractor_classifications, contractor_is_c39,
         bbb_rating, bbb_url, bbb_checked_at, bbb_note,
         source_id, source_record_id, source_url, fetched_at, source_updated_at, last_seen_run
  FROM permit_enriched
  ORDER BY apn NULLS LAST, permit_uid`;

const CONTRACTORS_SQL = `
  SELECT contractor_id, license_no, name, license_status, classifications, is_c39, address, city, state,
         zip, county, phone, in_cslb_master, in_county_permits, identity_basis,
         bbb_rating, bbb_url, bbb_checked_at, bbb_note,
         source_id, source_record_id, source_url, fetched_at
  FROM contractor ORDER BY contractor_id`;

const BUSINESSES_SQL = `
  SELECT account_key, dba_name, owner_name, ownership_type, status, naics_code, naics_description,
         business_start_date, cert_expiration_date, address, city, state, zip, lat, lon,
         source_id, source_record_id, source_url, fetched_at
  FROM business ORDER BY account_key`;

/** Gazetteer derived from the parcels themselves, so place lookup needs no outside geocoder. */
const PLACES_SQL = `
  SELECT name, kind, lat, lon, parcels FROM (
    SELECT situs_city AS name, 'city' AS kind, median(lat) AS lat, median(lon) AS lon, count(*)::INTEGER AS parcels
    FROM property WHERE situs_city IS NOT NULL GROUP BY 1
    UNION ALL
    SELECT situs_zip AS name, 'zip' AS kind, median(lat), median(lon), count(*)::INTEGER
    FROM property WHERE situs_zip IS NOT NULL GROUP BY 1
  ) WHERE parcels >= 25 ORDER BY kind, parcels DESC`;

const LONG_OPEN_SAMPLE_SQL = `
  SELECT source_permit_id AS permit_id, jurisdiction, apn, address, city, roofing_class, status, open_since,
         days_open, contractor_name, contractor_license_no, contractor_license_status, bbb_rating, bbb_note,
         source_url
  FROM permit_enriched WHERE is_roofing AND is_open ORDER BY days_open DESC LIMIT 500`;

const AGED_ROOF_SAMPLE_SQL = `
  SELECT apn, situs_address AS address, situs_city AS city, roof_year, roof_age_years, basis, confidence,
         lat, lon, source_url
  FROM roof_signal WHERE basis = 'last completed roofing permit' AND roof_age_years >= 15
  ORDER BY roof_age_years DESC LIMIT 500`;

export const LIMITATIONS: readonly string[] = [
  'Owner name and mailing address are not in any public San Diego source; out-of-area owner is a proxy (parcel not flagged owner-occupied) and over-counts.',
  'BBB ratings are not collected: there is no bulk source and BBB terms limit copying. Each contractor row carries the reason.',
  'Roof age is a proxy: the last completed roofing permit where one exists (high confidence), otherwise the assessor effective year (medium, or low where a two-digit year is ambiguous).',
  'Roofing class comes from text rules over permit descriptions; roof-mounted solar is classed separately and excluded.',
];

/** States which jurisdictions have permit data in this run, from the rows themselves. */
export function permitCoverageLimitation(sources: { jurisdiction: string; permits: number }[]): string {
  const listed = sources.map((s) => `${s.jurisdiction} (${s.permits.toLocaleString('en-US')})`).join('; ');
  return `Permit data in this run covers: ${listed}. Cities not listed publish no bulk permit feed that the pipeline could use (see SOURCES.md), so open-permit results there are empty.`;
}

async function tableCount(db: Db, table: string): Promise<number> {
  return (await db.one(countRow, `SELECT count(*) AS n FROM ${table}`)).n;
}

/**
 * Writes every publishable object for one run into its own folder. Nothing is published unless
 * the query table passes the gate: one row per parcel, no missing ids, every point in the county.
 */
export async function exportArtifacts(db: Db, publishRoot: string, asOf: string): Promise<ExportResult> {
  const runId = (
    await db.one(
      z.object({ run_id: z.coerce.number() }),
      `SELECT max(run_id) AS run_id FROM pipeline_run WHERE status = 'ok' AND finished_at IS NOT NULL`,
    )
  ).run_id;
  const dir = path.join(publishRoot, COUNTY_SLUG, `run-${String(runId).padStart(4, '0')}`);
  await mkdir(path.join(dir, 'samples'), { recursive: true });
  const at = (name: string): string => path.join(dir, ...name.split('/'));

  await db.exec(`COPY (${QUERY_TABLE_SQL}) TO ${sqlPath(at(ARTIFACTS.queryTable))} ${PARQUET}`);

  const gate = await db.one(
    gateRow,
    `SELECT count(*) AS total, count(DISTINCT apn) AS distinct_apn, count(*) FILTER (apn IS NULL) AS null_apn,
            count(*) FILTER (lat NOT BETWEEN ${COUNTY_BBOX.minLat} AND ${COUNTY_BBOX.maxLat}
                             OR lon NOT BETWEEN ${COUNTY_BBOX.minLon} AND ${COUNTY_BBOX.maxLon}) AS outside_bbox,
            (SELECT count(*) FROM property) AS property_rows
     FROM read_parquet(${sqlPath(at(ARTIFACTS.queryTable))})`,
  );
  if (
    gate.total === 0 ||
    gate.total !== gate.distinct_apn ||
    gate.null_apn !== 0 ||
    gate.outside_bbox !== 0 ||
    gate.total !== gate.property_rows
  ) {
    throw new Error(`query table failed the publish gate: ${JSON.stringify(gate)}`);
  }

  await db.exec(`COPY (${PERMITS_SQL}) TO ${sqlPath(at(ARTIFACTS.permits))} ${PARQUET}`);
  await db.exec(`COPY (${CONTRACTORS_SQL}) TO ${sqlPath(at(ARTIFACTS.contractors))} ${PARQUET}`);
  await db.exec(`COPY (${BUSINESSES_SQL}) TO ${sqlPath(at(ARTIFACTS.businesses))} ${PARQUET}`);
  await db.exec(`COPY (${PLACES_SQL}) TO ${sqlPath(at(ARTIFACTS.places))} ${PARQUET}`);
  await db.exec(
    `COPY (${LONG_OPEN_SAMPLE_SQL}) TO ${sqlPath(at(ARTIFACTS.sampleOpenPermits))} (FORMAT csv, HEADER)`,
  );
  await db.exec(
    `COPY (${AGED_ROOF_SAMPLE_SQL}) TO ${sqlPath(at(ARTIFACTS.sampleAgedRoofs))} (FORMAT csv, HEADER)`,
  );

  const anyRow = z.record(z.string(), z.unknown());
  const runHistory = await db.query(anyRow, `SELECT * FROM run_history ORDER BY run_id, source_id, entity`);
  const runs = await db.query(anyRow, `SELECT * FROM pipeline_run ORDER BY run_id`);
  const sources = await db.query(
    anyRow,
    `SELECT s.*, st.state_token, st.updated_at AS state_updated_at
     FROM source s LEFT JOIN source_state st USING (source_id) ORDER BY s.source_id`,
  );

  const tables = [
    'property',
    'ownership',
    'permit',
    'permit_status_history',
    'permit_contractor_record',
    'cslb_license',
    'contractor',
    'business',
    'rejects',
  ];
  const counts: Coverage['counts'] = [];
  for (const table of tables) counts.push({ table, rows: await tableCount(db, table) });

  const roofing = await db.one(
    z.object({
      roofing_permits: z.coerce.number(),
      open_roofing: z.coerce.number(),
      open_5y: z.coerce.number(),
      open_no_parcel: z.coerce.number(),
    }),
    `SELECT count(*) FILTER (is_roofing) AS roofing_permits,
            count(*) FILTER (is_roofing AND is_open) AS open_roofing,
            count(*) FILTER (is_roofing AND is_open AND days_open >= 1826) AS open_5y,
            count(*) FILTER (is_roofing AND is_open AND NOT coalesce(apn_matched_property, false)) AS open_no_parcel
     FROM permit_enriched`,
  );
  const roofYears = await db.one(
    z.object({ with_year: z.coerce.number(), from_permit: z.coerce.number() }),
    `SELECT count(*) FILTER (roof_year IS NOT NULL) AS with_year,
            count(*) FILTER (basis = 'last completed roofing permit') AS from_permit FROM roof_signal`,
  );
  const rejects = await db.query(
    z.object({ source: z.string(), entity: z.string(), reason: z.string(), rows: z.coerce.number() }),
    `SELECT source_id AS source, entity, reason, count(*) AS rows FROM rejects
     GROUP BY ALL ORDER BY rows DESC LIMIT 40`,
  );

  const permitSources = await db.query(
    z.object({ jurisdiction: z.string(), permits: z.coerce.number() }),
    `SELECT jurisdiction, count(*) AS permits FROM permit GROUP BY 1 ORDER BY permits DESC`,
  );

  const coverage: Coverage = {
    county: 'San Diego County, CA',
    countySlug: COUNTY_SLUG,
    fips: '06073',
    runId,
    asOf,
    bbox: COUNTY_BBOX,
    counts,
    roofing: {
      roofingPermits: roofing.roofing_permits,
      openRoofingPermits: roofing.open_roofing,
      openFiveYearsPlus: roofing.open_5y,
      openRoofingPermitsWithoutParcel: roofing.open_no_parcel,
      parcelsWithRoofYear: roofYears.with_year,
      parcelsRoofFromPermit: roofYears.from_permit,
    },
    rejects,
    limitations: [permitCoverageLimitation(permitSources), ...LIMITATIONS],
  };

  await writeFile(at(ARTIFACTS.runHistory), JSON.stringify({ runs, stats: runHistory }, null, 2));
  await writeFile(at(ARTIFACTS.sources), JSON.stringify(sources, null, 2));
  await writeFile(at(ARTIFACTS.coverage), JSON.stringify(coverage, null, 2));

  return {
    runId,
    dir,
    artifacts: Object.values(ARTIFACTS).map((name) => ({ name, path: at(name) })),
    coverage,
  };
}
