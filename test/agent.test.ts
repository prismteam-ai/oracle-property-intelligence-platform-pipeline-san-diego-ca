import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARTIFACTS } from '../src/publish/exportArtifacts.js';
import { askAgent } from '../src/serve/agent.js';
import { findRoofingLeads, getOracleProperty, queryAtlas } from '../src/serve/queries.js';
import { Store } from '../src/serve/store.js';

/**
 * Replay tests for the serving layer and the agent loop. The store is a real DuckDB over real
 * Parquet files (a few rows shaped like the published tables); the model is scripted, so the test
 * checks what OUR code does with a model's tool calls and text, with no network and no key.
 */
const TODAY = '2026-11-25';
const PIN = { lat: 32.7157, lon: -117.1611 };

async function buildFixture(dir: string): Promise<void> {
  const instance = await DuckDBInstance.create(':memory:');
  const db = await instance.connect();
  const out = (name: string): string => `'${path.join(dir, name).replace(/\\/g, '/')}'`;
  await db.run(`COPY (
    SELECT * FROM (VALUES
      ('5330000100', '100 A ST', NULL, 'SAN DIEGO', '92101', 'SD', 32.7160, -117.1610, '111', 1, 1500, 500000,
        1985, FALSE, 1985, 'year_built', 'medium', 'assessor effective year', NULL, TRUE, FALSE, 'owner-occupied flag',
        DATE '2001-05-01', FALSE, NULL, NULL, NULL, 'not in public data', 0, NULL::DATE, NULL, NULL, NULL, NULL, 0, NULL::DATE,
        'sandag_parcels', '5330000100', 'https://example.test/parcel/5330000100', TIMESTAMP '2026-11-25 16:00:00', 6),
      ('5330000200', '200 B ST', '4', 'SAN DIEGO', '92101', 'SD', 32.7170, -117.1620, '220', 12, 9000, 2000000,
        2012, FALSE, 2012, 'last_roofing_permit', 'high', 'completed reroof permit', 'sdcity:R1', FALSE, TRUE, 'not flagged owner-occupied',
        DATE '2020-03-01', FALSE, NULL, NULL, NULL, 'not in public data', 1, DATE '2018-06-01', 'sdcity:P2', 'P2', 'ACME ROOFING INC', '123456', 2, DATE '2012-04-01',
        'sandag_parcels', '5330000200', 'https://example.test/parcel/5330000200', TIMESTAMP '2026-11-25 16:00:00', 6),
      ('4920000300', '300 C AVE', NULL, 'EL CAJON', '92020', 'EC', 32.7948, -116.9625, '111', 1, 1400, 400000,
        1970, FALSE, 1970, 'year_built', 'medium', 'assessor effective year', NULL, TRUE, FALSE, 'owner-occupied flag',
        DATE '1999-01-01', TRUE, NULL, NULL, NULL, 'not in public data', 0, NULL::DATE, NULL, NULL, NULL, NULL, 0, NULL::DATE,
        'sandag_parcels', '4920000300', 'https://example.test/parcel/4920000300', TIMESTAMP '2026-11-25 16:00:00', 6)
    ) AS t(apn, address, unit, city, zip, jurisdiction, lat, lon, use_code, units, living_area_sqft, assessed_total,
      year_built, year_built_ambiguous, roof_year, roof_basis, roof_confidence, roof_confidence_reason,
      roof_evidence_permit_uid, owner_occupied, out_of_area, out_of_area_basis, last_transfer_date,
      last_transfer_ambiguous, owner_name, owner_mail_city, owner_mail_state, owner_fields_note, open_roof_permits,
      longest_open_since, top_open_permit_uid, top_open_permit_id, top_open_contractor, top_open_license_no,
      roof_permits, last_roof_permit_date, source_id, source_record_id, source_url, fetched_at, last_seen_run)
  ) TO ${out(ARTIFACTS.queryTable)} (FORMAT parquet)`);
  // 600 permits on the City parcel so the jurisdiction counts as having a permit feed.
  await db.run(`COPY (
    SELECT 'sdcity:P' || i AS permit_uid, 'P' || i AS permit_id, 'City of San Diego' AS jurisdiction,
      '5330000200' AS apn, TRUE AS apn_matched_property, 'Building Permit' AS permit_type, NULL AS permit_subtype,
      CASE WHEN i = 2 THEN 'RE-ROOF EXISTING BUILDING' ELSE 'MISC WORK' END AS description, NULL AS project_title,
      CASE WHEN i = 2 THEN 'reroof' ELSE 'other' END AS roofing_class, (i = 2) AS is_roofing, NULL AS roofing_rule,
      'Issued' AS status, CASE WHEN i = 2 THEN 'open' ELSE 'completed' END AS status_group, (i = 2) AS is_open,
      DATE '2018-05-01' AS applied_date, DATE '2018-06-01' AS issued_date,
      CASE WHEN i = 2 THEN NULL ELSE DATE '2019-01-01' END AS closed_date, NULL AS closed_date_basis,
      NULL::DATE AS expire_date, CASE WHEN i = 2 THEN DATE '2018-06-01' END AS open_since, 1000.0 AS valuation,
      'ACME ROOFING INC' AS holder_name, '200 B ST' AS address, 'SAN DIEGO' AS city, '92101' AS zip,
      32.7170 AS lat, -117.1620 AS lon, 'parcel' AS geo_basis, 'lic:123456' AS contractor_id,
      'licence' AS contractor_match_method, 'ACME ROOFING INC' AS contractor_name, '123456' AS contractor_license_no,
      'CLEAR' AS contractor_license_status, 'C39' AS contractor_classifications, TRUE AS contractor_is_c39,
      NULL AS bbb_rating, NULL AS bbb_url, NULL::TIMESTAMP AS bbb_checked_at, 'not collected' AS bbb_note,
      'sdcity_permits' AS source_id, 'P' || i AS source_record_id, 'https://example.test/permits.csv' AS source_url,
      TIMESTAMP '2026-11-25 16:00:00' AS fetched_at, NULL::TIMESTAMP AS source_updated_at, 6 AS last_seen_run
    FROM range(1, 601) AS r(i)
  ) TO ${out(ARTIFACTS.permits)} (FORMAT parquet)`);
  await db.run(`COPY (SELECT 'lic:123456' AS contractor_id, '123456' AS license_no, 'ACME ROOFING INC' AS name,
      'CLEAR' AS license_status, 'C39' AS classifications, TRUE AS is_c39, '1 MAIN ST' AS address, 'SAN DIEGO' AS city,
      'CA' AS state, '92101' AS zip, 'San Diego' AS county, '6195550100' AS phone, TRUE AS in_cslb_master,
      TRUE AS in_county_permits, 'licence' AS identity_basis, NULL AS bbb_rating, NULL AS bbb_url,
      NULL::TIMESTAMP AS bbb_checked_at, 'not collected' AS bbb_note, 'cslb' AS source_id, '123456' AS source_record_id,
      'https://example.test/cslb' AS source_url, TIMESTAMP '2026-11-25 16:00:00' AS fetched_at
  ) TO ${out(ARTIFACTS.contractors)} (FORMAT parquet)`);
  await db.run(
    `COPY (SELECT 'B1' AS account_key, 'ACME' AS dba_name, 32.7 AS lat, -117.1 AS lon) TO ${out(ARTIFACTS.businesses)} (FORMAT parquet)`,
  );
  await db.run(`COPY (SELECT * FROM (VALUES ('SAN DIEGO', 'city', 32.7157, -117.1611, 2), ('EL CAJON', 'city', 32.7948, -116.9625, 1))
      AS t(name, kind, lat, lon, parcels)) TO ${out(ARTIFACTS.places)} (FORMAT parquet)`);
  db.closeSync();
  instance.closeSync();
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

/** A model that replays a fixed script: one tool call, then one final text. */
function scriptedModel(toolName: string, input: unknown, finalText: string): MockLanguageModelV4 {
  let step = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      step += 1;
      if (step === 1) {
        return {
          content: [{ type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify(input) }],
          finishReason: { unified: 'tool-calls', raw: 'tool_use' },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: 'text', text: finalText }],
        finishReason: { unified: 'stop', raw: 'end_turn' },
        usage,
        warnings: [],
      };
    },
  });
}

let store: Store;

beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oracle-serve-'));
  await mkdir(dir, { recursive: true });
  await buildFixture(dir);
  store = await Store.open(dir);
});

afterAll(() => store.close());

describe('serving queries over Parquet', () => {
  it('finds the open roofing permit, with permit number, contractor and unit', async () => {
    const out = await findRoofingLeads(store, { center: PIN, signal: 'open_permit' }, TODAY);
    expect(out.total).toBe(1);
    expect(out.rows[0]).toMatchObject({
      apn: '5330000200',
      unit: '4',
      topOpenPermitId: 'P2',
      topOpenContractor: 'ACME ROOFING INC',
      roofBasis: 'last_roofing_permit',
    });
    expect(out.rows[0]?.longestOpenDays).toBeGreaterThan(3000);
    expect(out.coverageNote).toBeNull();
  });

  it('applies the roof-age threshold as a parameter', async () => {
    expect((await findRoofingLeads(store, { center: PIN, signal: 'aged_roof' }, TODAY)).total).toBe(1);
    const lower = await findRoofingLeads(
      store,
      { center: PIN, signal: 'aged_roof', minRoofAgeYears: 10 },
      TODAY,
    );
    expect(lower.total).toBe(2);
  });

  it('filters on ownership unchanged for N years and skips ambiguous dates', async () => {
    const ten = await findRoofingLeads(store, { center: PIN, minYearsSinceTransfer: 10 }, TODAY);
    expect(ten.rows.map((r) => r.apn)).toEqual(['5330000100']);
    const elCajon = { lat: 32.7948, lon: -116.9625 };
    // The El Cajon parcel's 1999 date is century-ambiguous, so it must not count.
    expect((await findRoofingLeads(store, { center: elCajon, minYearsSinceTransfer: 10 }, TODAY)).total).toBe(
      0,
    );
  });

  it('explains a zero where the area has no permit data', async () => {
    const out = await findRoofingLeads(
      store,
      { center: { lat: 32.7948, lon: -116.9625 }, permitStatus: 'open' },
      TODAY,
    );
    expect(out.total).toBe(0);
    expect(out.coverageNote).toMatch(/No permit data is published for El Cajon/);
  });

  it('returns property detail with permits, status group, contractor and provenance', async () => {
    const p = await getOracleProperty(store, '533-000-02-00', TODAY);
    expect(p?.unit).toBe('4');
    const open = p?.permits.find((m) => m.isOpen);
    expect(open).toMatchObject({ permitId: 'P2', statusGroup: 'open', isRoofing: true });
    expect(open?.contractor).toMatchObject({
      name: 'ACME ROOFING INC',
      licenseNumber: '123456',
      phone: '6195550100',
    });
    expect(open?.contractor?.bbbRating).toBeNull();
    expect(open?.contractor?.bbbNote).toBe('not collected');
    expect(open?.provenance.source).toBe('sdcity_permits');
    expect(await getOracleProperty(store, '0000000000', TODAY)).toBeNull();
  });

  it('caps and guards caller SQL', async () => {
    const out = await queryAtlas(store, 'SELECT permit_id FROM permit');
    expect(out.rowCount).toBe(600);
    await expect(queryAtlas(store, 'DELETE FROM permit')).rejects.toThrow(/Only SELECT/);
    await expect(store.raw("SELECT * FROM read_text('/etc/hosts')")).rejects.toThrow();
  });
});

describe('agent loop, replayed with a scripted model', () => {
  const search = { lat: PIN.lat, lon: PIN.lon, radiusMiles: 1, signal: 'open_permit' };

  it('returns evidence, rows and map points for a grounded answer', async () => {
    const model = scriptedModel(
      'findRoofingLeads',
      search,
      '1 property has an open roofing permit.\n- 200 B ST, APN 5330000200: permit P2, contractor ACME ROOFING INC.\nAssumptions: radius 1 mile; open means issued and not finalled.\nMissing data: BBB rating.',
    );
    const out = await askAgent(
      { store, model, modelName: 'scripted', today: TODAY },
      { question: 'open roofing permits near here?', center: PIN },
    );
    expect(out.evidence).toEqual([expect.objectContaining({ tool: 'findRoofingLeads', rowCount: 1 })]);
    expect(out.rows).toHaveLength(1);
    expect(out.points).toEqual([{ apn: '5330000200', lat: 32.717, lon: -117.162, label: '200 B ST' }]);
    expect(out.assumptions).toEqual(['radius 1 mile', 'open means issued and not finalled']);
    expect(out.answer).not.toMatch(/Check failed/);
  });

  it('flags a parcel number the tools never returned', async () => {
    const model = scriptedModel(
      'findRoofingLeads',
      search,
      'Two properties: APN 5330000200 and APN 9999999999.',
    );
    const out = await askAgent(
      { store, model, modelName: 'scripted', today: TODAY },
      { question: 'open roofing permits near here?', center: PIN },
    );
    expect(out.answer).toMatch(/Check failed: 1 parcel number/);
    expect(out.answer).toContain('9999999999');
  });

  it('survives a rejected SQL tool call and records the rejection as evidence', async () => {
    const model = scriptedModel(
      'queryData',
      { sql: 'DROP VIEW parcel', purpose: 'mischief' },
      'I could not run that query.',
    );
    const out = await askAgent(
      { store, model, modelName: 'scripted', today: TODAY },
      { question: 'drop the parcel table please' },
    );
    expect(out.evidence[0]).toMatchObject({ tool: 'queryData', rowCount: 0 });
    expect(out.evidence[0]?.note).toMatch(/rejected/);
    expect((await findRoofingLeads(store, { center: PIN }, TODAY)).total).toBeGreaterThan(0);
  });

  it('gives no figures when the model answered without retrieving anything', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'There are 4,000 open permits.' }],
        finishReason: { unified: 'stop', raw: 'end_turn' },
        usage,
        warnings: [],
      }),
    });
    const out = await askAgent(
      { store, model, modelName: 'scripted', today: TODAY },
      { question: 'how many open permits?' },
    );
    expect(out.answer).toMatch(/could not retrieve data/);
    expect(out.answer).not.toMatch(/4,000/);
  });
});
