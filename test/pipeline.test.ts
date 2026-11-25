import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resolvePaths, type Paths, type Window } from '../src/config.js';
import { Db } from '../src/db.js';
import { createLogger } from '../src/log.js';
import { ALL_ADAPTERS, runPipeline, type RunSummary, type SourceStat } from '../src/pipeline.js';
import { createFixtureHttp } from './fixtureHttp.js';

/**
 * Integration tests: the whole pipeline against recorded real San Diego County rows, fully offline.
 * The only substitution is the HTTP client; adapters, validation, merge, reconciliation and views
 * are the production code.
 */

const FIXTURES = path.resolve('test/fixtures');
const NOW = new Date('2026-11-25T12:00:00Z');
const ALL: Window = { from: null, to: null };
const N = z.object({ n: z.coerce.number() });
const TABLES = [
  'property',
  'ownership',
  'permit',
  'permit_status_history',
  'permit_contractor_record',
  'cslb_license',
  'contractor',
  'business',
] as const;

interface Workspace {
  readonly dir: string;
  readonly paths: Paths;
  readonly fixtures: string;
}

async function workspace(): Promise<Workspace> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-test-'));
  const fixtures = path.join(dir, 'fixtures');
  await cp(FIXTURES, fixtures, { recursive: true });
  return { dir, paths: resolvePaths(path.join(dir, 'data')), fixtures };
}

function run(ws: Workspace, window: Window, force: boolean, now: Date = NOW): Promise<RunSummary> {
  return runPipeline({
    paths: ws.paths,
    window,
    adapters: ALL_ADAPTERS,
    http: createFixtureHttp(ws.fixtures),
    log: createLogger(true),
    force,
    now: () => now,
  });
}

async function withDb<T>(ws: Workspace, fn: (db: Db) => Promise<T>): Promise<T> {
  const db = await Db.open(ws.paths.dbPath);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

async function tableCounts(ws: Workspace): Promise<Record<string, number>> {
  return withDb(ws, async (db) => {
    const out: Record<string, number> = {};
    for (const t of TABLES) out[t] = (await db.one(N, `SELECT count(*) AS n FROM ${t}`)).n;
    return out;
  });
}

function stat(summary: RunSummary, sourceId: string, entity: string): SourceStat {
  const found = summary.stats.find((s) => s.sourceId === sourceId && s.entity === entity);
  if (found === undefined) throw new Error(`no stats for ${sourceId}/${entity}`);
  return found;
}

function sum(
  summary: RunSummary,
  field: 'inserted' | 'updated' | 'unchanged' | 'rejected' | 'fetched',
): number {
  return summary.stats.reduce((total, s) => total + s[field], 0);
}

describe('full load, then idempotent re-run', () => {
  let ws: Workspace;
  let first: RunSummary;
  let countsAfterFirst: Record<string, number>;

  beforeAll(async () => {
    ws = await workspace();
    first = await run(ws, ALL, false);
    countsAfterFirst = await tableCounts(ws);
  });
  afterAll(async () => {
    await rm(ws.dir, { recursive: true, force: true });
  });

  it('loads every table from the recorded real rows', () => {
    expect(first.status).toBe('ok');
    for (const t of TABLES) expect(countsAfterFirst[t], t).toBeGreaterThan(0);
    expect(sum(first, 'updated')).toBe(0);
    expect(sum(first, 'unchanged')).toBe(0);
  });

  it('stamps provenance on every data row', async () => {
    await withDb(ws, async (db) => {
      for (const t of TABLES) {
        const { n } = await db.one(
          N,
          `SELECT count(*) AS n FROM ${t}
           WHERE source_id IS NULL OR source_record_id IS NULL OR source_url IS NULL OR fetched_at IS NULL
              OR first_seen_run IS NULL OR last_seen_run IS NULL OR row_hash IS NULL`,
        );
        expect(n, t).toBe(0);
      }
      const { n } = await db.one(
        N,
        `SELECT count(*) AS n FROM permit p WHERE p.source_id NOT IN (SELECT source_id FROM source)`,
      );
      expect(n).toBe(0);
    });
  });

  it('rejects bad rows at the boundary with a reason, instead of loading them', async () => {
    await withDb(ws, async (db) => {
      const Reason = z.object({ source_id: z.string(), reason: z.string(), n: z.coerce.number() });
      const reasons = await db.query(
        Reason,
        'SELECT source_id, reason, count(*) AS n FROM rejects GROUP BY ALL',
      );
      // Two real parcel features with no APN are in the fixture.
      expect(reasons).toContainEqual({ source_id: 'sandag_parcels', reason: 'apn:missing', n: 2 });
      expect(stat(first, 'sandag_parcels', 'property').rejected).toBe(2);
      const { n } = await db.one(
        N,
        `SELECT count(*) AS n FROM rejects WHERE reason IS NULL OR raw_record IS NULL OR run_id IS NULL`,
      );
      expect(n).toBe(0);
      const { n: bad } = await db.one(
        N,
        'SELECT count(*) AS n FROM property WHERE apn IS NULL OR lat IS NULL OR lon IS NULL',
      );
      expect(bad).toBe(0);
    });
  });

  it('rejects a permit whose coordinate lies outside the county, and one with an impossible date', async () => {
    const bad = await workspace();
    try {
      const file = path.join(bad.fixtures, 'sdcounty_permits/permits.json');
      const permits = z
        .array(z.record(z.string(), z.unknown()))
        .parse(JSON.parse(await readFile(file, 'utf8')));
      const [a, b] = permits;
      if (a === undefined || b === undefined) throw new Error('fixture too small');
      a['geo_reference'] = { type: 'Point', coordinates: [-118.2437, 34.0522] }; // Los Angeles
      b['issued_date'] = '2099-01-01T00:00:00.000';
      await writeFile(file, JSON.stringify(permits));
      const summary = await run(bad, ALL, false);
      expect(stat(summary, 'sdcounty_permits', 'permit').rejected).toBe(2);
      await withDb(bad, async (db) => {
        const Reason = z.object({ reason: z.string() });
        const reasons = (
          await db.query(
            Reason,
            `SELECT reason FROM rejects WHERE source_id = 'sdcounty_permits' ORDER BY reason`,
          )
        ).map((r) => r.reason);
        expect(reasons).toEqual(['issued_date:date_in_future', 'lat:lat_outside_county']);
        const { n } = await db.one(N, `SELECT count(*) AS n FROM permit WHERE source_record_id IN (?, ?)`, [
          String(a['record_id']),
          String(b['record_id']),
        ]);
        expect(n).toBe(0);
      });
    } finally {
      await rm(bad.dir, { recursive: true, force: true });
    }
  });

  it('skips snapshot sources whose ETag has not changed', async () => {
    const second = await run(ws, ALL, false);
    expect(second.status).toBe('ok');
    expect(stat(second, 'sdcity_permits', 'permit').notes).toContain('skipped');
    expect(stat(second, 'sandag_parcels', 'property').notes).toContain('skipped');
    expect(sum(second, 'inserted')).toBe(0);
    expect(sum(second, 'updated')).toBe(0);
    expect(await tableCounts(ws)).toEqual(countsAfterFirst);
  });

  it('re-running the same input inserts nothing, updates nothing and counts every row as unchanged', async () => {
    const again = await run(ws, ALL, true);
    expect(again.status).toBe('ok');
    expect(sum(again, 'inserted')).toBe(0);
    expect(sum(again, 'updated')).toBe(0);
    for (const s of first.stats) {
      expect(stat(again, s.sourceId, s.entity).unchanged, `${s.sourceId}/${s.entity}`).toBe(s.inserted);
    }
    expect(await tableCounts(ws)).toEqual(countsAfterFirst);
    await withDb(ws, async (db) => {
      for (const [table, key] of [
        ['property', 'apn'],
        ['ownership', 'apn'],
        ['permit', 'permit_uid'],
        ['contractor', 'contractor_id'],
        ['business', 'account_key'],
        ['cslb_license', 'license_no'],
      ] as const) {
        const { n } = await db.one(
          N,
          `SELECT count(*) AS n FROM (SELECT ${key} FROM ${table} GROUP BY ${key} HAVING count(*) > 1)`,
        );
        expect(n, table).toBe(0);
      }
      const Run = z.object({ run_id: z.coerce.number(), status: z.string() });
      const runs = await db.query(Run, 'SELECT run_id, status FROM pipeline_run ORDER BY run_id');
      expect(runs.map((r) => r.status)).toEqual(['ok', 'ok', 'ok']);
      const { n: unseen } = await db.one(
        N,
        `SELECT count(*) AS n FROM property WHERE first_seen_run <> 1 OR last_seen_run <> 3`,
      );
      expect(unseen).toBe(0);
    });
  });

  it('answers a radius query with haversine in SQL', async () => {
    await withDb(ws, async (db) => {
      const Center = z.object({ lat: z.number(), lon: z.number() });
      const center = await db.one(
        Center,
        `SELECT lat, lon FROM property WHERE situs_zip = '91977' ORDER BY apn LIMIT 1`,
      );
      const Hit = z.object({ apn: z.string(), distance_miles: z.number() });
      const near = await db.query(
        Hit,
        'SELECT apn, distance_miles FROM properties_within(?, ?, 1.0) ORDER BY distance_miles',
        [center.lat, center.lon],
      );
      const wide = await db.one(N, 'SELECT count(*) AS n FROM properties_within(?, ?, 25.0)', [
        center.lat,
        center.lon,
      ]);
      expect(near.length).toBeGreaterThan(1);
      expect(near[0]?.distance_miles).toBeCloseTo(0, 6);
      expect(Math.max(...near.map((h) => h.distance_miles))).toBeLessThanOrEqual(1.0);
      expect(wide.n).toBeGreaterThanOrEqual(near.length);
      // Downtown San Diego to La Jolla Cove is about 11 to 12 miles.
      const { n: miles } = await db.one(
        N,
        'SELECT haversine_miles(32.7157, -117.1611, 32.8503, -117.2713) AS n',
      );
      expect(miles).toBeGreaterThan(11);
      expect(miles).toBeLessThan(12);
    });
  });

  it('answers the roof-age question with the threshold as a parameter', async () => {
    await withDb(ws, async (db) => {
      const count = async (threshold: number): Promise<number> =>
        (await db.one(N, 'SELECT count(*) AS n FROM roof_signal WHERE roof_age_years >= ?', [threshold])).n;
      const [any, fifteen, forty] = [await count(0), await count(15), await count(40)];
      expect(fifteen).toBeGreaterThan(0);
      expect(any).toBeGreaterThan(fifteen);
      expect(fifteen).toBeGreaterThan(forty);
      expect((await db.one(N, 'SELECT count(*) AS n FROM roofs_older_than(15)')).n).toBe(fifteen);

      const Basis = z.object({
        basis: z.string().nullable(),
        confidence: z.string().nullable(),
        n: z.coerce.number(),
      });
      const bases = await db.query(
        Basis,
        'SELECT basis, confidence, count(*) AS n FROM roof_signal GROUP BY ALL',
      );
      expect(bases.some((b) => b.basis === 'last completed roofing permit' && b.confidence === 'high')).toBe(
        true,
      );
      expect(bases.some((b) => b.basis === 'year built/effective year' && b.confidence === 'medium')).toBe(
        true,
      );
      expect(bases.some((b) => b.basis === 'year built/effective year' && b.confidence === 'low')).toBe(true);

      // A parcel with a completed reroof takes the permit year, not the (older) effective year.
      const Evidence = z.object({
        roof_year: z.coerce.number(),
        permit_year: z.coerce.number(),
        roofing_class: z.string(),
        status_group: z.string(),
      });
      const evidence = await db.query(
        Evidence,
        `SELECT r.roof_year, year(r.evidence_permit_date) AS permit_year, p.roofing_class, p.status_group
         FROM roof_signal r JOIN permit p ON p.permit_uid = r.evidence_permit_uid
         WHERE r.basis = 'last completed roofing permit'`,
      );
      expect(evidence.length).toBeGreaterThan(0);
      for (const e of evidence) {
        expect(e.roof_year).toBe(e.permit_year);
        expect(e.roofing_class).toBe('reroof');
        expect(e.status_group).toBe('completed');
      }
    });
  });

  it('finds roofing permits that have stayed open for years, with the contractor', async () => {
    await withDb(ws, async (db) => {
      const Row = z.object({
        permit_uid: z.string(),
        days_open: z.coerce.number(),
        status: z.string(),
        roofing_class: z.string(),
        contractor_name: z.string().nullable(),
        contractor_license_no: z.string().nullable(),
        contractor_match_method: z.string().nullable(),
        bbb_rating: z.string().nullable(),
        bbb_note: z.string().nullable(),
        source_url: z.string(),
      });
      const rows = await db.query(
        Row,
        `SELECT permit_uid, days_open, status, roofing_class, contractor_name, contractor_license_no,
                contractor_match_method, bbb_rating, bbb_note, source_url
         FROM permit_enriched
         WHERE is_roofing AND is_open AND days_open >= ?
         ORDER BY days_open DESC`,
        [2 * 365],
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((r) => r.contractor_name !== null && r.contractor_license_no !== null)).toBe(true);
      for (const r of rows) {
        expect(r.days_open).toBeGreaterThanOrEqual(730);
        expect(['reroof', 'roof repair', 'roof structural']).toContain(r.roofing_class);
        expect(r.bbb_rating).toBeNull(); // not collected in slice 1 ...
        if (r.contractor_license_no !== null) expect(r.bbb_note).toContain('not collected'); // ... and the row says why
      }
      const { n: solar } = await db.one(
        N,
        `SELECT count(*) AS n FROM permit WHERE roofing_class = 'solar-on-roof' AND is_roofing`,
      );
      expect(solar).toBe(0);
    });
  });

  it('reconciles permits to parcels on APN and contractors on licence number', async () => {
    await withDb(ws, async (db) => {
      const { n: matched } = await db.one(
        N,
        `SELECT count(*) AS n FROM permit_enriched WHERE jurisdiction LIKE 'County%' AND apn_matched_property`,
      );
      expect(matched).toBeGreaterThan(50);
      const { n: licensed } = await db.one(
        N,
        `SELECT count(*) AS n FROM permit_contractor WHERE match_method = 'license_number'`,
      );
      expect(licensed).toBeGreaterThan(0);
      const { n: both } = await db.one(
        N,
        `SELECT count(*) AS n FROM contractor WHERE in_cslb_master AND in_county_permits`,
      );
      expect(both).toBeGreaterThan(0);
      const { n: c39 } = await db.one(N, `SELECT count(*) AS n FROM contractor WHERE is_c39`);
      expect(c39).toBeGreaterThan(0);
      const { n: orphanLinks } = await db.one(
        N,
        `SELECT count(*) AS n FROM permit_contractor pc WHERE NOT EXISTS (SELECT 1 FROM contractor c WHERE c.contractor_id = pc.contractor_id)`,
      );
      expect(orphanLinks).toBe(0);
      const { n: primaries } = await db.one(
        N,
        `SELECT count(*) AS n FROM (SELECT permit_uid FROM permit_contractor WHERE is_primary GROUP BY 1 HAVING count(*) > 1)`,
      );
      expect(primaries).toBe(0);
    });
  });
});

describe('incremental windows', () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await workspace();
  });
  afterAll(async () => {
    await rm(ws.dir, { recursive: true, force: true });
  });

  it('a later, overlapping window reports inserted and unchanged; a changed source row reports updated', async () => {
    const CUT = '2026-06-01';
    const OVERLAP = '2026-01-01';
    const first = await run(ws, { from: null, to: CUT }, false, new Date('2026-06-01T06:00:00Z'));
    const p1 = stat(first, 'sdcounty_permits', 'permit');
    expect(p1.inserted).toBeGreaterThan(0);

    const second = await run(ws, { from: OVERLAP, to: null }, false, new Date('2026-11-25T06:00:00Z'));
    const p2 = stat(second, 'sdcounty_permits', 'permit');
    expect(p2.inserted).toBeGreaterThan(0); // rows changed after the first window closed
    expect(p2.unchanged).toBeGreaterThan(0); // rows in the overlap, already loaded
    expect(p2.updated).toBe(0);
    const expected = await withDb(
      ws,
      async (db) =>
        (await db.one(N, `SELECT count(*) AS n FROM permit WHERE source_id = 'sdcounty_permits'`)).n,
    );
    expect(expected).toBe(p1.inserted + p2.inserted);

    await withDb(ws, async (db) => {
      const Run = z.object({
        run_id: z.coerce.number(),
        window_from: z.string().nullable(),
        window_to: z.string().nullable(),
      });
      expect(
        await db.query(Run, 'SELECT run_id, window_from, window_to FROM pipeline_run ORDER BY run_id'),
      ).toEqual([
        { run_id: 1, window_from: null, window_to: CUT },
        { run_id: 2, window_from: OVERLAP, window_to: null },
      ]);
      const { n: seenInBoth } = await db.one(
        N,
        `SELECT count(*) AS n FROM permit WHERE first_seen_run = 1 AND last_seen_run = 2`,
      );
      expect(seenInBoth).toBe(p2.unchanged);
    });

    // Simulated source change: one real permit's status moves on and its change stamp advances.
    const file = path.join(ws.fixtures, 'sdcounty_permits/permits.json');
    const permits = z
      .array(z.record(z.string(), z.unknown()))
      .parse(JSON.parse(await readFile(file, 'utf8')));
    const target = permits.find((p) => p['record_status'] === 'Issued');
    if (target === undefined) throw new Error('fixture has no Issued permit');
    target['record_status'] = 'Completed';
    target['last_updated'] = '2026-11-26T09:00:00.000';
    await writeFile(file, JSON.stringify(permits));

    const third = await run(ws, { from: '2026-11-26', to: null }, false, new Date('2026-11-27T06:00:00Z'));
    const p3 = stat(third, 'sdcounty_permits', 'permit');
    expect({
      fetched: p3.fetched,
      inserted: p3.inserted,
      updated: p3.updated,
      unchanged: p3.unchanged,
    }).toEqual({
      fetched: 1,
      inserted: 0,
      updated: 1,
      unchanged: 0,
    });
    await withDb(ws, async (db) => {
      const Row = z.object({
        status: z.string(),
        is_open: z.boolean(),
        first_seen_run: z.number(),
        last_seen_run: z.number(),
      });
      const row = await db.one(
        Row,
        'SELECT status, is_open, first_seen_run, last_seen_run FROM permit WHERE source_permit_id = ?',
        [String(target['record_id'])],
      );
      expect(row.status).toBe('Completed');
      expect(row.is_open).toBe(false);
      expect(row.last_seen_run).toBe(3);
      expect(row.first_seen_run).toBeLessThan(3);
      const { n } = await db.one(N, `SELECT count(*) AS n FROM permit WHERE source_id = 'sdcounty_permits'`);
      expect(n).toBe(expected);
    });
  });
});
