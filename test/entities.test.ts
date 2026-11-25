import { describe, expect, it } from 'vitest';
import { ENTITY_KEYS, makeEntities } from '../src/entities.js';

describe('entity contracts', () => {
  const entities = makeEntities('2026-11-25');

  it.each(ENTITY_KEYS)('%s: the Zod schema and the DuckDB column list name the same fields', (key) => {
    const spec = entities[key];
    expect(Object.keys(spec.schema.shape).sort()).toEqual(Object.keys(spec.columns).sort());
    for (const k of spec.key) expect(Object.keys(spec.columns)).toContain(k);
  });

  it('applies range checks at the boundary', () => {
    const base = {
      permit_uid: 'x:1',
      source_permit_id: '1',
      jurisdiction: 'City of San Diego',
      apn: null,
      apn_raw: null,
      permit_type: null,
      permit_subtype: null,
      description: null,
      project_title: null,
      roofing_class: 'other',
      is_roofing: false,
      roofing_rule: null,
      status: null,
      status_group: 'other',
      is_open: false,
      applied_date: null,
      issued_date: null,
      closed_date: null,
      expire_date: null,
      valuation: null,
      holder_name: null,
      holder_name_norm: null,
      address: null,
      city: null,
      zip: null,
      lat: 32.7,
      lon: -117.1,
      source_updated_at: null,
    };
    const ok = (row: Record<string, unknown>): boolean => entities.permit.schema.safeParse(row).success;
    expect(ok(base)).toBe(true);
    expect(ok({ ...base, lat: 34.05, lon: -118.24 })).toBe(false); // Los Angeles
    expect(ok({ ...base, issued_date: '2031-01-01' })).toBe(false); // issued in the future
    expect(ok({ ...base, expire_date: '2031-01-01' })).toBe(true); // an expiry may be in the future
    expect(ok({ ...base, applied_date: '1899-12-31' })).toBe(false);
    expect(ok({ ...base, apn: '498-320' })).toBe(false);
    expect(ok({ ...base, valuation: -5 })).toBe(false);
    expect(ok({ ...base, surprise: 1 })).toBe(false); // unknown columns are a schema change
  });
});
