import { describe, expect, it } from 'vitest';
import { extractAssumptions, findUnsupportedApns } from '../src/serve/agent.js';
import { coverageNote, leadSearchInput } from '../src/serve/queries.js';
import { MAX_QUERY_ROWS, QueryRejectedError, guardSelect } from '../src/serve/sqlGuard.js';

describe('guardSelect: the gate for agent-written SQL', () => {
  it('wraps a single SELECT with a row cap the caller cannot remove', () => {
    const sql = guardSelect('SELECT apn FROM parcel LIMIT 999999;');
    expect(sql).toBe(
      `SELECT * FROM (\nSELECT apn FROM parcel LIMIT 999999\n) AS q LIMIT ${MAX_QUERY_ROWS + 1}`,
    );
    expect(guardSelect('WITH a AS (SELECT 1 AS x) SELECT x FROM a')).toContain('WITH a AS');
  });

  it.each([
    ['DROP VIEW parcel', /Only SELECT/],
    ['SELECT 1; SELECT 2', /one statement/],
    ["SELECT * FROM read_csv('C:/Windows/win.ini')", /Function not allowed: read_csv/],
    ["SELECT * FROM parquet_metadata('x')", /Function not allowed/],
    ["COPY parcel TO 'out.csv'", /Only SELECT/],
    ['SELECT 1 UNION ALL (INSERT INTO t VALUES (1))', /insert/i],
    ["SELECT getenv('HOME')", /Function not allowed: getenv/],
    ['select apn from parcel) q union all select apn from parcel --', /Unbalanced/],
    ['SELECT (1', /Unbalanced/],
    ['', /Empty/],
  ])('rejects %s', (sql, reason) => {
    expect(() => guardSelect(sql)).toThrow(QueryRejectedError);
    expect(() => guardSelect(sql)).toThrow(reason);
  });

  it('keeps the row cap even when the statement ends in a line comment', () => {
    const sql = guardSelect('SELECT apn FROM parcel -- everything');
    expect(sql.trimEnd().endsWith(`LIMIT ${MAX_QUERY_ROWS + 1}`)).toBe(true);
    expect(sql.split('\n').at(-1)).toMatch(/^\) AS q LIMIT/);
  });

  it('does not trip on keywords inside string literals or on column names', () => {
    expect(() =>
      guardSelect("SELECT apn FROM permit WHERE description LIKE '%drop set call%'"),
    ).not.toThrow();
    expect(() => guardSelect('SELECT use_code, count(*) FROM parcel GROUP BY use_code')).not.toThrow();
  });
});

describe('coverageNote: a zero must never be silent', () => {
  const sd = { code: 'SD', name: 'City of San Diego', parcels: 900, permitFeed: true };
  const ec = { code: 'EC', name: 'El Cajon', parcels: 100, permitFeed: false };

  it('is null when every jurisdiction in the radius has a permit feed', () => {
    expect(coverageNote([sd])).toBeNull();
  });
  it('ignores a stray parcel or two coded to another city', () => {
    expect(
      coverageNote([
        { ...sd, parcels: 16000 },
        { ...ec, parcels: 3 },
      ]),
    ).toBeNull();
  });
  it('names the place when nothing in the radius has permit data', () => {
    expect(coverageNote([ec])).toMatch(/No permit data is published for El Cajon/);
  });
  it('gives the share of parcels without permit data when coverage is partial', () => {
    expect(coverageNote([sd, ec])).toMatch(/El Cajon \(10% of parcels in this radius\)/);
  });
});

describe('lead search input gate', () => {
  it('applies defaults and refuses a pin outside the county or an oversized radius', () => {
    const ok = leadSearchInput.parse({ center: { lat: 32.7157, lon: -117.1611 } });
    expect(ok).toMatchObject({ radiusMiles: 1, minRoofAgeYears: 15, signal: 'any', limit: 200 });
    expect(() => leadSearchInput.parse({ center: { lat: 40.7, lon: -74 } })).toThrow();
    expect(() => leadSearchInput.parse({ center: { lat: 32.7, lon: -117.1 }, radiusMiles: 100 })).toThrow();
  });
});

describe('agent answer checks', () => {
  it('flags parcel numbers no tool returned, and ignores permit numbers', () => {
    const seen = new Set(['5330000100']);
    expect(findUnsupportedApns('APN 533-000-01-00 and APN 9999999999', seen)).toEqual(['9999999999']);
    expect(findUnsupportedApns('permit PDS1992-C-9204551999 on APN 5330000100', seen)).toEqual([]);
  });
  it('reads assumptions written inline or as a list', () => {
    expect(
      extractAssumptions('x\nAssumptions: radius 5 miles; roof age 15 years.\nMissing data: BBB'),
    ).toEqual(['radius 5 miles', 'roof age 15 years']);
    expect(
      extractAssumptions(
        'x\nAssumptions:\n- radius 5 miles.\n- sorted by longest open\n\nMissing data: none',
      ),
    ).toEqual(['radius 5 miles', 'sorted by longest open']);
  });
});
