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

  it('keeps a permit whose coordinate lies outside the county (coordinate nulled, reason recorded) and rejects one with an impossible date', async () => {
    const bad = await workspace();
    try {
      const file = path.join(bad.fixtures, 'sdcounty_permits/permits.json');
      const permits = z
        .array(z.record(z.string(), z.unknown()))
        .parse(JSON.parse(await readFile(file, 'utf8')));
      // A real permit whose parcel is in the fixture, given a Los Angeles coordinate.
      const parcelText = await readFile(path.join(bad.fixtures, 'sandag_parcels/parcels.json'), 'utf8');
      const a = permits.find((p) => {
        const apn = typeof p['parcel_number'] === 'string' ? p['parcel_number'].replace(/-/g, '') : '';
        return /^\d{10}$/.test(apn) && parcelText.includes(`"apn": "${apn}"`);
      });
      const b = permits.find((p) => p !== a);
      if (a === undefined || b === undefined) throw new Error('fixture too small');
      a['geo_reference'] = { type: 'Point', coordinates: [-118.2437, 34.0522] };
      b['issued_date'] = '2099-01-01T00:00:00.000';
      await writeFile(file, JSON.stringify(permits));
      const summary = await run(bad, ALL, false);
      expect(stat(summary, 'sdcounty_permits', 'permit').rejected).toBe(1);
      await withDb(bad, async (db) => {
        const Reason = z.object({ reason: z.string() });
        const reasons = (
          await db.query(Reason, `SELECT reason FROM rejects WHERE source_id = 'sdcounty_permits'`)
        ).map((r) => r.reason);
        expect(reasons).toEqual(['issued_date:date_in_future']);

        const Kept = z.object({
          lat: z.number().nullable(),
          lon: z.number().nullable(),
          coord_note: z.string().nullable(),
          apn: z.string().nullable(),
          geo_lat: z.number().nullable(),
          geo_basis: z.string().nullable(),
        });
        const kept = await db.one(
          Kept,
          `SELECT lat, lon, coord_note, apn, geo_lat, geo_basis FROM permit_enriched WHERE source_record_id = ?`,
          [String(a['record_id'])],
        );
        expect(kept.lat).toBeNull();
        expect(kept.lon).toBeNull();
        expect(kept.coord_note).toBe(
          'source coordinate outside San Diego County (34.0522, -118.2437); discarded',
        );
        // The permit still lands on the map, through its parcel.
        expect(kept.apn).not.toBeNull();
        expect(kept.geo_lat).not.toBeNull();
        expect(kept.geo_basis).toBe('parcel centroid via APN');

        const { n: rejected } = await db.one(
          N,
          `SELECT count(*) AS n FROM permit WHERE source_record_id = ?`,
          [String(b['record_id'])],
        );
        expect(rejected).toBe(0);
        const { n: noted } = await db.one(N, 'SELECT count(*) AS n FROM permit WHERE coord_note IS NOT NULL');
        expect(noted).toBe(1);
        const { n: outside } = await db.one(
          N,
          'SELECT count(*) AS n FROM permit WHERE lat NOT BETWEEN 32.5 AND 33.55 OR lon NOT BETWEEN -117.65 AND -116.05',
        );
        expect(outside).toBe(0);
      });
    } finally {
      await rm(bad.dir, { recursive: true, force: true });
    }
  });

  it('loads Carlsbad permits through the same boundary: roofing classes, open permits, snapshot date, parcel link', async () => {
    await withDb(ws, async (db) => {
      const Class = z.object({ roofing_class: z.string(), is_roofing: z.boolean(), n: z.coerce.number() });
      const classes = await db.query(
        Class,
        `SELECT roofing_class, is_roofing, count(*) AS n FROM permit
         WHERE source_id = 'carlsbad_permits' GROUP BY ALL ORDER BY roofing_class`,
      );
      const count = (c: string): number => classes.find((x) => x.roofing_class === c)?.n ?? 0;
      expect(classes.reduce((t, c) => t + c.n, 0)).toBe(93);
      expect(count('reroof')).toBeGreaterThan(20);
      expect(count('roof repair')).toBeGreaterThan(5); // partial reroofs under solar arrays
      expect(count('solar-on-roof')).toBeGreaterThan(5);
      expect(classes.filter((c) => c.roofing_class === 'solar-on-roof').every((c) => !c.is_roofing)).toBe(
        true,
      );

      const Open = z.object({
        permit_uid: z.string(),
        jurisdiction: z.string(),
        status: z.string(),
        status_as_of: z.string().nullable(),
        days_open: z.coerce.number(),
        geo_lat: z.number().nullable(),
        source_url: z.string(),
      });
      const open = await db.query(
        Open,
        `SELECT permit_uid, jurisdiction, status, status_as_of, days_open, geo_lat, source_url
         FROM permit_enriched WHERE source_id = 'carlsbad_permits' AND is_roofing AND is_open`,
      );
      expect(open.length).toBeGreaterThan(10);
      for (const p of open) {
        expect(p.jurisdiction).toBe('City of Carlsbad');
        expect(p.status).toBe('Issued - Active');
        expect(p.status_as_of).toBe('2024-01-14'); // the snapshot's last edit, not today
        expect(p.geo_lat).not.toBeNull();
        expect(p.source_url).toContain('PermitNum');
      }

      // Carlsbad publishes no APN; permits are tied to a parcel only on an exact, unique situs address.
      const Link = z.object({
        linked: z.coerce.number(),
        wrong_city: z.coerce.number(),
        far: z.coerce.number(),
      });
      const link = await db.one(
        Link,
        `SELECT count(*) AS linked,
                count(*) FILTER (WHERE pr.situs_juris <> 'CB') AS wrong_city,
                count(*) FILTER (WHERE haversine_miles(p.lat, p.lon, pr.lat, pr.lon) > 0.1) AS far
         FROM permit_enriched p JOIN property pr ON pr.apn = p.apn
         WHERE p.source_id = 'carlsbad_permits' AND p.apn_basis = 'parcel matched on situs address'`,
      );
      expect(link.linked).toBeGreaterThan(10);
      expect(link.wrong_city).toBe(0);
      expect(link.far).toBe(0); // the matched parcel sits where the permit's own coordinate is

      const { n: roofFromCarlsbad } = await db.one(
        N,
        `SELECT count(*) AS n FROM roof_signal WHERE evidence_permit_uid LIKE 'carlsbad:%'`,
      );
      expect(roofFromCarlsbad).toBeGreaterThan(0);
    });
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

  it('keeps status_group, is_open, open_since and days_open consistent for every permit', async () => {
    await withDb(ws, async (db) => {
      const count = async (where: string): Promise<number> =>
        (await db.one(N, `SELECT count(*) AS n FROM permit_enriched WHERE ${where}`)).n;
      // is_open means exactly one thing: issued and not finalled.
      expect(await count("is_open <> (status_group = 'open')")).toBe(0);
      // A pending application (the fixture has real "Opened", "Created" and "Open" rows) is not open
      // and has no open duration; it has a pending duration instead.
      expect(await count("status_group = 'pending'")).toBeGreaterThan(0);
      expect(
        await count(
          "status_group IN ('pending', 'other') AND (open_since IS NOT NULL OR days_open IS NOT NULL)",
        ),
      ).toBe(0);
      expect(await count("status_group <> 'pending' AND days_pending IS NOT NULL")).toBe(0);
      expect(
        await count("status_group = 'pending' AND applied_date IS NOT NULL AND days_pending IS NULL"),
      ).toBe(0);
      // Every open permit has a start and a non-negative duration.
      expect(await count('is_open AND open_since IS NOT NULL AND days_open IS NULL')).toBe(0);
      expect(await count('days_open < 0 AND is_open')).toBe(0);
      // A frozen snapshot measures "open for" up to its snapshot date, not up to today.
      expect(
        await count("source_id = 'carlsbad_permits' AND is_open AND open_as_of <> DATE '2024-01-14'"),
      ).toBe(0);
      expect(await count("source_id = 'carlsbad_permits' AND is_open AND days_open > 745")).toBe(0);
      expect(await count("source_id <> 'carlsbad_permits' AND open_as_of <> current_date")).toBe(0);
      const Group = z.object({ status_group: z.string() });
      const groups = (await db.query(Group, 'SELECT DISTINCT status_group FROM permit')).map(
        (g) => g.status_group,
      );
      for (const g of groups)
        expect(['open', 'pending', 'completed', 'expired', 'cancelled', 'other']).toContain(g);
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

describe('raw files are reused only to resume, never to stand in for a new fetch', () => {
  it('a second run on the same day and window sees a change made at the source in between', async () => {
    const ws = await workspace();
    try {
      const first = await run(ws, ALL, false);
      expect(stat(first, 'sdcounty_permits', 'permit').inserted).toBeGreaterThan(0);

      const file = path.join(ws.fixtures, 'sdcounty_permits/permits.json');
      const permits = z
        .array(z.record(z.string(), z.unknown()))
        .parse(JSON.parse(await readFile(file, 'utf8')));
      const target = permits.find((p) => p['record_status'] === 'Issued');
      if (target === undefined) throw new Error('fixture has no Issued permit');
      target['record_status'] = 'Completed';
      await writeFile(file, JSON.stringify(permits));

      // Same clock, so the same run date and the same raw folder as the first run.
      const second = await run(ws, ALL, false);
      const p = stat(second, 'sdcounty_permits', 'permit');
      expect({ inserted: p.inserted, updated: p.updated }).toEqual({ inserted: 0, updated: 1 });
      expect(p.notes).not.toContain('reused');
    } finally {
      await rm(ws.dir, { recursive: true, force: true });
    }
  });
});
