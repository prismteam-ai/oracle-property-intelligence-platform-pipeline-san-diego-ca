import { z } from 'zod';
import { BBB_NOTE_DEFAULT, type Db } from './db.js';
import type { Entities } from './entities.js';
import { mergeStage, type MergeCounts } from './merge.js';

/**
 * Cross-source reconciliation. Runs after every load, entirely in SQL over already-validated tables.
 *
 * Properties and permits reconcile on the 10-digit APN (dashes and spaces stripped at the boundary).
 * Contractors reconcile on the CSLB licence number; a contractor seen only by name is folded into the
 * licensed contractor of the same normalised name when there is one, and otherwise kept as `NAME:...`.
 */

/** Name keys shorter than this are too generic to match on ("ABC", "J M"). */
const MIN_NAME_KEY = 5;

/** One canonical contractor per identity, CSLB master first, county permit file as fallback. */
const CONTRACTOR_STAGE = `
  WITH pc_names AS (
    SELECT contractor_id, company_name, any_value(name_norm) AS name_norm, count(*) AS n
    FROM permit_contractor_record WHERE company_name IS NOT NULL GROUP BY contractor_id, company_name),
  pc_best_name AS (
    SELECT contractor_id, company_name, name_norm FROM pc_names
    QUALIFY row_number() OVER (PARTITION BY contractor_id ORDER BY n DESC, company_name) = 1),
  pc_latest AS (
    SELECT * FROM permit_contractor_record
    QUALIFY row_number() OVER (PARTITION BY contractor_id ORDER BY source_updated_at DESC NULLS LAST, permit_uid DESC) = 1),
  pc AS (
    SELECT l.contractor_id, l.license_no, coalesce(b.company_name, l.person_name) AS name,
           coalesce(b.name_norm, l.name_norm) AS name_norm, l.phone, l.address, l.city, l.state, l.zip,
           l.source_record_id, l.source_url, l.fetched_at
    FROM pc_latest l LEFT JOIN pc_best_name b USING (contractor_id)),
  cs AS (SELECT 'CSLB:' || license_no AS contractor_id, * FROM cslb_license),
  licensed_names AS (
    SELECT name_norm FROM cs WHERE name_norm IS NOT NULL
    UNION SELECT name_norm FROM pc WHERE license_no IS NOT NULL AND name_norm IS NOT NULL)
  SELECT coalesce(cs.contractor_id, pc.contractor_id) AS contractor_id,
         coalesce(cs.license_no, pc.license_no) AS license_no,
         coalesce(cs.business_name, pc.name) AS name,
         coalesce(cs.name_norm, pc.name_norm) AS name_norm,
         cs.primary_status AS license_status,
         cs.classifications,
         cs.is_c39,
         coalesce(cs.address, pc.address) AS address,
         coalesce(cs.city, pc.city) AS city,
         coalesce(cs.state, pc.state) AS state,
         coalesce(cs.zip, pc.zip) AS zip,
         cs.county,
         coalesce(cs.phone, pc.phone) AS phone,
         cs.license_no IS NOT NULL AS in_cslb_master,
         pc.contractor_id IS NOT NULL AS in_county_permits,
         CASE WHEN coalesce(cs.license_no, pc.license_no) IS NOT NULL THEN 'cslb_license_number' ELSE 'normalised_name' END AS identity_basis,
         CASE WHEN cs.license_no IS NOT NULL THEN 'cslb_license_master' ELSE 'sdcounty_permit_contractors' END AS source_id,
         coalesce(cs.source_record_id, pc.source_record_id) AS source_record_id,
         coalesce(cs.source_url, pc.source_url) AS source_url,
         coalesce(cs.fetched_at, pc.fetched_at) AS fetched_at,
         0 AS _rank, 0 AS _seq
  FROM cs FULL OUTER JOIN pc ON cs.contractor_id = pc.contractor_id
  WHERE NOT (coalesce(cs.license_no, pc.license_no) IS NULL
             AND length(pc.name_norm) >= ${MIN_NAME_KEY}
             AND pc.name_norm IN (SELECT name_norm FROM licensed_names))`;

const DERIVED: readonly string[] = [
  `CREATE OR REPLACE TABLE permit_status_summary AS
   SELECT permit_uid,
          max(status_date) FILTER (WHERE mapped_status = 'Permit Finaled' OR upper(status) IN ('COMPLETED', 'DONE')) AS completed_date,
          min(status_date) FILTER (WHERE mapped_status = 'Permit Issued') AS first_issued_date,
          max(status_date) AS last_status_date,
          CAST(count(*) AS INTEGER) AS status_events
   FROM permit_status_history GROUP BY permit_uid`,

  // Best licensed contractor per name key. `candidates` > 1 means the name alone is ambiguous.
  `CREATE OR REPLACE TABLE contractor_name_index AS
   SELECT name_norm, contractor_id, CAST(count(*) OVER (PARTITION BY name_norm) AS INTEGER) AS candidates
   FROM contractor
   WHERE license_no IS NOT NULL AND name_norm IS NOT NULL AND length(name_norm) >= ${MIN_NAME_KEY}
   QUALIFY row_number() OVER (
     PARTITION BY name_norm
     ORDER BY in_county_permits DESC, (county = 'San Diego') DESC NULLS LAST, (license_status = 'CLEAR') DESC NULLS LAST,
              CAST(license_no AS BIGINT) DESC) = 1`,

  `CREATE OR REPLACE TABLE permit_contractor AS
   WITH county AS (
     SELECT r.permit_uid,
            CASE WHEN r.license_no IS NOT NULL THEN r.contractor_id ELSE coalesce(i.contractor_id, r.contractor_id) END AS contractor_id,
            CASE WHEN r.license_no IS NOT NULL THEN 'license_number'
                 WHEN i.contractor_id IS NULL THEN 'name_only_no_license'
                 WHEN i.candidates = 1 THEN 'name_norm_exact'
                 ELSE 'name_norm_exact_ambiguous' END AS match_method,
            r.trade, 'sdcounty_permit_contractors' AS link_source, i.candidates
     FROM permit_contractor_record r
     LEFT JOIN contractor_name_index i ON r.license_no IS NULL AND i.name_norm = r.name_norm),
   holder AS (
     SELECT p.permit_uid, i.contractor_id,
            CASE WHEN i.candidates = 1 THEN 'name_norm_exact' ELSE 'name_norm_exact_ambiguous' END AS match_method,
            CAST(NULL AS VARCHAR) AS trade, p.source_id AS link_source, i.candidates
     FROM permit p JOIN contractor_name_index i ON i.name_norm = p.holder_name_norm
     WHERE p.permit_uid NOT IN (SELECT permit_uid FROM permit_contractor_record)),
   links AS (
     SELECT * FROM (SELECT * FROM county UNION ALL SELECT * FROM holder)
     QUALIFY row_number() OVER (PARTITION BY permit_uid, contractor_id ORDER BY (match_method = 'license_number') DESC, match_method) = 1)
   SELECT l.*,
          row_number() OVER (
            PARTITION BY l.permit_uid
            ORDER BY (c.name_norm IS NOT NULL AND c.name_norm = p.holder_name_norm) DESC,
                     (l.match_method = 'license_number') DESC, l.contractor_id) = 1 AS is_primary
   FROM links l
   LEFT JOIN permit p ON p.permit_uid = l.permit_uid
   LEFT JOIN contractor c ON c.contractor_id = l.contractor_id`,

  `CREATE OR REPLACE TABLE business_contractor AS
   SELECT account_key, contractor_id, match_method, candidates FROM (
     SELECT b.account_key, i.contractor_id, 'business_name_norm_exact' AS match_method, i.candidates, 1 AS pref
     FROM business b JOIN contractor_name_index i ON i.name_norm = b.name_norm
     UNION ALL
     SELECT b.account_key, i.contractor_id, 'owner_name_norm_exact', i.candidates, 2
     FROM business b JOIN contractor_name_index i ON i.name_norm = b.owner_name_norm)
   QUALIFY row_number() OVER (PARTITION BY account_key, contractor_id ORDER BY pref) = 1`,

  // Cross-check for ambiguous two-digit years: is there a permit on the parcel just before the assumed year?
  `CREATE OR REPLACE TABLE property_year_check AS
   SELECT pr.apn,
          min(coalesce(p.applied_date, p.issued_date)) AS earliest_permit_date,
          coalesce(bool_or(year(coalesce(p.applied_date, p.issued_date)) BETWEEN pr.year_effective - 3 AND pr.year_effective), false) AS permit_near_year
   FROM property pr JOIN permit p ON p.apn = pr.apn
   WHERE pr.year_ambiguous AND pr.year_effective IS NOT NULL
   GROUP BY pr.apn`,
];

export async function reconcile(db: Db, runId: number, entities: Entities): Promise<MergeCounts> {
  const contractorCounts = await mergeStage(db, runId, entities.contractor, CONTRACTOR_STAGE);
  // A contractor without a rating always says why. Rows that gain a rating later keep their own note.
  await db.exec(
    'UPDATE contractor SET bbb_note = ? WHERE bbb_rating IS NULL AND bbb_note IS DISTINCT FROM ?',
    [BBB_NOTE_DEFAULT, BBB_NOTE_DEFAULT],
  );
  for (const sql of DERIVED) await db.exec(sql);
  return contractorCounts;
}

/** Natural keys are enforced by the loader, not by constraints; this proves it after every run. */
export async function duplicateKeyReport(db: Db, entities: Entities): Promise<string[]> {
  const Row = z.object({ n: z.coerce.number() });
  const problems: string[] = [];
  for (const spec of Object.values(entities)) {
    const { n } = await db.one(
      Row,
      `SELECT count(*) AS n FROM (SELECT 1 FROM ${spec.table} GROUP BY ${spec.key.join(', ')} HAVING count(*) > 1)`,
    );
    if (n > 0) problems.push(`${spec.table}: ${n} duplicated key(s)`);
  }
  return problems;
}
