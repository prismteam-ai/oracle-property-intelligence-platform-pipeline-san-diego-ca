import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { z } from 'zod';
import { PROVENANCE_COLUMNS, makeEntities, type DuckType, type EntitySpec } from './entities.js';

export type SqlParam = string | number | boolean | null;

/** Thin typed wrapper over one DuckDB connection. Query results are checked with Zod, never cast. */
export class Db {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
  ) {}

  static async open(dbPath: string): Promise<Db> {
    if (dbPath !== ':memory:') await mkdir(path.dirname(dbPath), { recursive: true });
    const instance = await DuckDBInstance.create(dbPath);
    const connection = await instance.connect();
    // Every TIMESTAMP in this database is UTC. Without this, now() would be cast in the machine's zone.
    await connection.run("SET TimeZone = 'UTC'");
    return new Db(instance, connection);
  }

  async exec(sql: string, params: readonly SqlParam[] = []): Promise<void> {
    await this.connection.run(sql, [...params]);
  }

  async query<T>(schema: z.ZodType<T>, sql: string, params: readonly SqlParam[] = []): Promise<T[]> {
    const reader = await this.connection.runAndReadAll(sql, [...params]);
    return reader.getRowObjectsJson().map((row) => schema.parse(row));
  }

  async one<T>(schema: z.ZodType<T>, sql: string, params: readonly SqlParam[] = []): Promise<T> {
    const rows = await this.query(schema, sql, params);
    const first = rows[0];
    if (first === undefined) throw new Error(`query returned no rows: ${sql.slice(0, 80)}`);
    return first;
  }

  /** Runs `fn` inside one transaction; any error rolls the whole step back. */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.exec('BEGIN TRANSACTION');
    try {
      const result = await fn();
      await this.exec('COMMIT');
      return result;
    } catch (e) {
      await this.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    this.connection.closeSync();
    this.instance.closeSync();
  }
}

export function columnList(columns: Readonly<Record<string, DuckType>>): string {
  return Object.entries(columns)
    .map(([name, type]) => `${name} ${type}`)
    .join(', ');
}

function dataTable(spec: EntitySpec, extra = ''): string {
  return `CREATE TABLE IF NOT EXISTS ${spec.table} (${columnList(spec.columns)}, ${columnList(PROVENANCE_COLUMNS)}${extra})`;
}

const CONTROL_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS source (
     source_id VARCHAR, name VARCHAR, url VARCHAR, licence VARCHAR, limits VARCHAR, change_detection VARCHAR)`,
  `CREATE TABLE IF NOT EXISTS source_state (
     source_id VARCHAR, state_token VARCHAR, updated_run INTEGER, updated_at TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS pipeline_run (
     run_id INTEGER, started_at TIMESTAMP, finished_at TIMESTAMP, window_from DATE, window_to DATE,
     status VARCHAR, sources VARCHAR, forced BOOLEAN, notes VARCHAR)`,
  `CREATE TABLE IF NOT EXISTS run_source_stats (
     run_id INTEGER, source_id VARCHAR, entity VARCHAR, fetched INTEGER, rejected INTEGER, duplicates INTEGER,
     inserted INTEGER, updated INTEGER, unchanged INTEGER, bytes BIGINT, seconds DOUBLE, notes VARCHAR)`,
  `CREATE TABLE IF NOT EXISTS rejects (
     run_id INTEGER, source_id VARCHAR, entity VARCHAR, source_record_id VARCHAR, reason VARCHAR,
     raw_record VARCHAR, rejected_at TIMESTAMP)`,
  // Derived link tables are rebuilt by reconcile.ts on every run; created empty here so views resolve.
  `CREATE TABLE IF NOT EXISTS permit_status_summary (
     permit_uid VARCHAR, completed_date DATE, first_issued_date DATE, last_status_date DATE, status_events INTEGER)`,
  `CREATE TABLE IF NOT EXISTS contractor_name_index (name_norm VARCHAR, contractor_id VARCHAR, candidates INTEGER)`,
  `CREATE TABLE IF NOT EXISTS permit_contractor (
     permit_uid VARCHAR, contractor_id VARCHAR, match_method VARCHAR, trade VARCHAR, link_source VARCHAR,
     candidates INTEGER, is_primary BOOLEAN)`,
  `CREATE TABLE IF NOT EXISTS business_contractor (
     account_key VARCHAR, contractor_id VARCHAR, match_method VARCHAR, candidates INTEGER)`,
  `CREATE TABLE IF NOT EXISTS permit_apn_link (permit_uid VARCHAR, apn VARCHAR, match_method VARCHAR)`,
  `CREATE TABLE IF NOT EXISTS permit_alias (
     alias_uid VARCHAR, canonical_uid VARCHAR, alias_source_permit_id VARCHAR,
     canonical_source_permit_id VARCHAR, rule VARCHAR)`,
  // Fetch times as text, UTC, ISO 8601 with Z, so no reader has to guess a zone.
  `ALTER TABLE source ADD COLUMN IF NOT EXISTS last_fetched_at_utc VARCHAR`,
  `ALTER TABLE source ADD COLUMN IF NOT EXISTS last_checked_at_utc VARCHAR`,
  `ALTER TABLE source ADD COLUMN IF NOT EXISTS last_run_id INTEGER`,
  `ALTER TABLE source_state ADD COLUMN IF NOT EXISTS last_fetched_at_utc VARCHAR`,
  `ALTER TABLE source_state ADD COLUMN IF NOT EXISTS last_checked_at_utc VARCHAR`,
  `CREATE TABLE IF NOT EXISTS property_year_check (
     apn VARCHAR, earliest_permit_date DATE, permit_near_year BOOLEAN)`,
];

const VIEWS: readonly string[] = [
  `CREATE OR REPLACE MACRO haversine_miles(lat1, lon1, lat2, lon2) AS
     3958.7613 * 2 * asin(sqrt(
       pow(sin(radians(lat2 - lat1) / 2), 2) +
       cos(radians(lat1)) * cos(radians(lat2)) * pow(sin(radians(lon2 - lon1) / 2), 2)))`,

  // One row per permit with open duration, best location, primary contractor and BBB columns.
  `CREATE OR REPLACE VIEW permit_enriched AS
   SELECT p.* REPLACE (coalesce(p.apn, al.apn) AS apn),
          CASE WHEN p.apn IS NOT NULL THEN 'source APN'
               WHEN al.apn IS NOT NULL THEN 'parcel matched on situs address' END AS apn_basis,
          -- The other id of the same permit, when the source lists it twice (see permit_alias).
          canon.alias_source_permit_id AS alias_permit_id,
          coalesce(p.closed_date, s.completed_date) AS effective_closed_date,
          CASE WHEN p.closed_date IS NOT NULL THEN 'source close date'
               WHEN s.completed_date IS NOT NULL THEN 'status history: last completed/finaled event' END AS closed_date_basis,
          -- open_since and days_open describe an issued permit; a pending application has neither.
          CASE WHEN p.status_group IN ('pending', 'other') THEN NULL
               ELSE coalesce(p.issued_date, s.first_issued_date, p.applied_date) END AS open_since,
          CASE WHEN p.status_group = 'open'
                 THEN date_diff('day', coalesce(p.issued_date, s.first_issued_date, p.applied_date),
                                coalesce(p.status_as_of, current_date))
               WHEN p.status_group IN ('completed', 'expired', 'cancelled')
                 THEN date_diff('day', coalesce(p.issued_date, s.first_issued_date, p.applied_date),
                                coalesce(p.closed_date, s.completed_date, s.last_status_date)) END AS days_open,
          CASE WHEN p.status_group = 'pending'
                 THEN date_diff('day', p.applied_date, coalesce(p.status_as_of, current_date)) END AS days_pending,
          coalesce(p.status_as_of, current_date) AS open_as_of,
          coalesce(p.lat, pr.lat) AS geo_lat,
          coalesce(p.lon, pr.lon) AS geo_lon,
          CASE WHEN p.lat IS NOT NULL THEN 'permit coordinate' WHEN pr.lat IS NOT NULL THEN 'parcel centroid via APN' END AS geo_basis,
          pr.apn IS NOT NULL AS apn_matched_property,
          pc.contractor_id,
          pc.match_method AS contractor_match_method,
          coalesce(c.name, p.holder_name) AS contractor_name,
          c.license_no AS contractor_license_no,
          c.license_status AS contractor_license_status,
          c.classifications AS contractor_classifications,
          c.is_c39 AS contractor_is_c39,
          c.bbb_rating, c.bbb_url, c.bbb_checked_at, c.bbb_note
   FROM permit p
   LEFT JOIN permit_status_summary s ON s.permit_uid = p.permit_uid
   LEFT JOIN permit_apn_link al ON al.permit_uid = p.permit_uid
   LEFT JOIN permit_alias canon ON canon.canonical_uid = p.permit_uid
   LEFT JOIN property pr ON pr.apn = coalesce(p.apn, al.apn)
   LEFT JOIN permit_contractor pc ON pc.permit_uid = p.permit_uid AND pc.is_primary
   LEFT JOIN contractor c ON c.contractor_id = pc.contractor_id
   -- One row per real permit: the duplicate record of a pair is left out here (it stays in the permit table).
   WHERE p.permit_uid NOT IN (SELECT alias_uid FROM permit_alias)`,

  // Roof age with its basis and confidence. The age threshold is the caller's parameter:
  //   SELECT * FROM roof_signal WHERE roof_age_years >= ?
  `CREATE OR REPLACE VIEW roof_signal AS
   WITH reroof AS (
     SELECT apn, max(completed_on) AS roof_date, arg_max(permit_uid, completed_on) AS permit_uid
     FROM (SELECT apn, permit_uid, coalesce(effective_closed_date, issued_date, applied_date) AS completed_on
           FROM permit_enriched
           WHERE roofing_class = 'reroof' AND status_group = 'completed' AND apn IS NOT NULL)
     WHERE completed_on IS NOT NULL
     GROUP BY apn)
   SELECT pr.apn,
          coalesce(year(r.roof_date), pr.year_effective) AS roof_year,
          year(current_date) - coalesce(year(r.roof_date), pr.year_effective) AS roof_age_years,
          CASE WHEN r.apn IS NOT NULL THEN 'last completed roofing permit'
               WHEN pr.year_effective IS NOT NULL THEN 'year built/effective year' END AS basis,
          CASE WHEN r.apn IS NOT NULL THEN 'high'
               WHEN pr.year_effective IS NULL THEN NULL
               WHEN NOT pr.year_ambiguous THEN 'medium'
               WHEN coalesce(yc.permit_near_year, false) THEN 'medium'
               ELSE 'low' END AS confidence,
          CASE WHEN r.apn IS NOT NULL THEN 'dated reroof permit with a completed status'
               WHEN pr.year_effective IS NULL THEN 'no reroof permit and no assessor effective year'
               WHEN NOT pr.year_ambiguous THEN 'assessor effective year (two-digit, century certain); a proxy, not a roof record'
               WHEN coalesce(yc.permit_near_year, false) THEN 'two-digit year read as 20xx, corroborated by a permit on the parcel within 3 years before it'
               ELSE 'two-digit year read as 20xx without corroboration; it could be 19xx' END AS confidence_reason,
          r.permit_uid AS evidence_permit_uid,
          r.roof_date AS evidence_permit_date,
          pr.year_effective_raw, pr.year_effective, pr.year_ambiguous, pr.year_rule,
          pr.situs_address, pr.situs_city, pr.situs_zip, pr.lat, pr.lon,
          pr.source_id, pr.source_url, pr.fetched_at
   FROM property pr
   LEFT JOIN reroof r ON r.apn = pr.apn
   LEFT JOIN property_year_check yc ON yc.apn = pr.apn`,

  `CREATE OR REPLACE MACRO roofs_older_than(min_age_years) AS TABLE
     SELECT * FROM roof_signal WHERE roof_age_years >= min_age_years`,

  `CREATE OR REPLACE MACRO properties_within(center_lat, center_lon, radius_miles) AS TABLE
     SELECT p.*, haversine_miles(center_lat, center_lon, p.lat, p.lon) AS distance_miles
     FROM property p
     WHERE p.lat BETWEEN center_lat - radius_miles / 69.0 AND center_lat + radius_miles / 69.0
       AND p.lon BETWEEN center_lon - radius_miles / (69.0 * cos(radians(center_lat)))
                     AND center_lon + radius_miles / (69.0 * cos(radians(center_lat)))
       AND haversine_miles(center_lat, center_lon, p.lat, p.lon) <= radius_miles`,

  `CREATE OR REPLACE VIEW run_history AS
   SELECT r.run_id, r.started_at, r.finished_at, r.window_from, r.window_to, r.status,
          s.source_id, s.entity, s.fetched, s.rejected, s.duplicates, s.inserted, s.updated, s.unchanged,
          s.bytes, s.seconds, s.notes
   FROM pipeline_run r LEFT JOIN run_source_stats s USING (run_id)
   ORDER BY r.run_id, s.source_id, s.entity`,
];

/**
 * Why `bbb_rating` is empty. BBB has no bulk file, and its Terms of Use allow copying BBB content only
 * for personal, non-commercial use, so no rating is collected. The reason travels with every row.
 */
export const BBB_NOTE_DEFAULT =
  'not collected: BBB publishes no bulk file and its Terms of Use limit copying BBB content to personal, non-commercial use (see SOURCES.md)';

/** Creates every table, view and macro. Safe to call on an existing database. */
export async function migrate(db: Db): Promise<void> {
  const e = makeEntities('2000-01-01');
  for (const sql of CONTROL_TABLES) await db.exec(sql);
  for (const spec of [
    e.property,
    e.ownership,
    e.permit,
    e.permitStatus,
    e.permitContractorRecord,
    e.cslbLicense,
    e.business,
  ]) {
    await db.exec(dataTable(spec));
    // Databases created before a column existed get it added in place.
    const late: EntitySpec = spec;
    for (const column of late.lateColumns ?? []) {
      await db.exec(
        `ALTER TABLE ${spec.table} ADD COLUMN IF NOT EXISTS ${column} ${late.columns[column] ?? 'VARCHAR'}`,
      );
    }
  }
  // BBB columns live outside the merged column set, so a contractor refresh never overwrites them.
  await db.exec(
    dataTable(
      e.contractor,
      `, bbb_rating VARCHAR, bbb_url VARCHAR, bbb_checked_at TIMESTAMP, bbb_note VARCHAR`,
    ),
  );
  for (const sql of VIEWS) await db.exec(sql);
}
