import { COUNTY_BBOX } from './config.js';

/** Pure normalisation helpers shared by all adapters. No I/O, so every rule here is unit-tested. */

export function blankToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Assessor parcel numbers arrive as `4982603900`, `498-260-39-00` or `498 260 39 00`.
 * The canonical key is the 10 digits. Anything that is not exactly 10 digits is not an APN.
 */
export function normalizeApn(raw: string | null | undefined): string | null {
  const value = blankToNull(raw);
  if (value === null) return null;
  const digits = value.replace(/[\s-]/g, '');
  return /^\d{10}$/.test(digits) ? digits : null;
}

const NAME_SUFFIXES = new Set([
  'INC',
  'INCORPORATED',
  'LLC',
  'LLP',
  'LP',
  'LTD',
  'CORP',
  'CORPORATION',
  'CO',
  'COMPANY',
]);

/**
 * Name key used to reconcile contractors, permit holders and businesses across sources:
 * upper-case, `&` becomes AND, punctuation dropped, legal-form suffixes removed, spaces collapsed.
 * "Cal Roof, Inc." and "CAL ROOF INC" both become "CAL ROOF".
 */
export function normalizeName(raw: string | null | undefined): string | null {
  const value = blankToNull(raw);
  if (value === null) return null;
  const tokens = value
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/\bL\.?\s?L\.?\s?C\b\.?/g, 'LLC')
    .replace(/['.]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t !== '');
  while (tokens.length > 1 && NAME_SUFFIXES.has(tokens[tokens.length - 1] ?? '')) tokens.pop();
  const key = tokens.join(' ');
  return key === '' ? null : key;
}

const isLegalFormOnly = (part: string): boolean =>
  NAME_SUFFIXES.has(part.toUpperCase().replace(/[.\s]/g, ''));

export interface PermitHolder {
  /** Name to show. */
  readonly name: string | null;
  /** Key used to match the holder to a licensed contractor. */
  readonly nameNorm: string | null;
}

/**
 * City of San Diego `APPROVAL_PERMIT_HOLDER` is two fields joined by a comma: the firm, then a
 * second entry that is usually the same firm again ("Elor Energy, Elor Energy") and otherwise a
 * contact person or a variant spelling ("Johnson Controls, Jim Sevick"). Of 1,097,315 holders in
 * run 7, 596,473 had the comma; where the two parts differed and only one of them was a licensed
 * contractor's name, it was the first part about 24 times in 25 (149,312 rows against 6,271).
 *
 *  - parts that are the same name (after the usual name normalisation): one copy is kept;
 *  - exactly two different parts: the text is kept as published, the match key is the first part;
 *  - anything else (three or more different parts) is left as it was: no guess.
 *
 * A comma before a legal form ("Sunrun, Inc., Daniel Altman") does not start a new part, and
 * parts with no letter or digit ("WEST COAST APPLIANCE, ,,,,") are dropped.
 */
export function cityPermitHolder(raw: string | null | undefined): PermitHolder {
  const value = blankToNull(raw);
  if (value === null) return { name: null, nameNorm: null };
  const parts: string[] = [];
  for (const piece of value.split(',')) {
    const part = piece.trim();
    if (!/[A-Za-z0-9]/.test(part)) continue;
    const last = parts.length - 1;
    if (last >= 0 && isLegalFormOnly(part)) parts[last] = `${parts[last] ?? ''}, ${part}`;
    else parts.push(part);
  }
  const whole: PermitHolder = { name: value, nameNorm: normalizeName(value) };
  const first = parts[0];
  if (first === undefined) return whole;
  const keys = parts.map((part) => normalizeName(part));
  if (keys.every((key) => key === keys[0])) return { name: first, nameNorm: keys[0] ?? null };
  const half = parts.length / 2;
  if (Number.isInteger(half) && keys.slice(0, half).join('|') === keys.slice(half).join('|')) {
    const once = parts.slice(0, half).join(', ');
    return { name: once, nameNorm: normalizeName(once) };
  }
  if (parts.length === 2) return { name: value, nameNorm: keys[0] ?? whole.nameNorm };
  return whole;
}

/** CSLB licence numbers are 1 to 8 digits. Leading zeros are not significant. */
export function normalizeLicense(raw: string | null | undefined): string | null {
  const value = blankToNull(raw);
  if (value === null) return null;
  const digits = value.replace(/^[A-Za-z#\s]+/, '').trim();
  if (!/^\d{1,8}$/.test(digits)) return null;
  const stripped = digits.replace(/^0+/, '');
  return stripped === '' ? null : stripped;
}

export type YearRule =
  'blank' | 'unparseable' | 'yy_gt_current_19xx' | 'yy_00_assumed_2000' | 'yy_le_current_assumed_20xx';

export interface ResolvedYear {
  readonly year: number | null;
  readonly ambiguous: boolean;
  readonly rule: YearRule;
}

/**
 * The assessor publishes two-digit years. Stated rule:
 *  - a year cannot be in the future, so yy greater than the current yy must be 19yy (not ambiguous);
 *  - yy at or below the current yy is taken as 20yy and flagged ambiguous (it could be 19yy);
 *  - "00" is taken as 2000 and flagged ambiguous (the source also appears to use it as a default).
 * The raw value is always kept beside the resolved one.
 */
export function resolveTwoDigitYear(raw: string | null | undefined, currentYear: number): ResolvedYear {
  const value = blankToNull(raw);
  if (value === null) return { year: null, ambiguous: false, rule: 'blank' };
  if (!/^\d{2}$/.test(value)) return { year: null, ambiguous: false, rule: 'unparseable' };
  const yy = Number(value);
  if (yy > currentYear % 100) return { year: 1900 + yy, ambiguous: false, rule: 'yy_gt_current_19xx' };
  if (yy === 0) return { year: 2000, ambiguous: true, rule: 'yy_00_assumed_2000' };
  return { year: 2000 + yy, ambiguous: true, rule: 'yy_le_current_assumed_20xx' };
}

export type DateRule =
  'blank' | 'unparseable' | 'yy_gt_current_19xx' | 'yy_le_current_assumed_20xx' | 'future_as_20xx_so_19xx';

export interface ResolvedDate {
  readonly date: string | null;
  readonly ambiguous: boolean;
  readonly rule: DateRule;
}

function validYmd(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Recorder document dates arrive as MMDDYY. Same century rule as years, plus: a 20yy date that would
 * fall after `today` cannot be right, so it is read as 19yy.
 */
export function resolveMmddyy(raw: string | null | undefined, today: string): ResolvedDate {
  const value = blankToNull(raw);
  if (value === null) return { date: null, ambiguous: false, rule: 'blank' };
  if (!/^\d{6}$/.test(value) || value === '000000')
    return { date: null, ambiguous: false, rule: 'unparseable' };
  const month = Number(value.slice(0, 2));
  const day = Number(value.slice(2, 4));
  const yy = Number(value.slice(4, 6));
  const currentYear = Number(today.slice(0, 4));
  if (yy > currentYear % 100) {
    const date = validYmd(1900 + yy, month, day);
    return date === null
      ? { date: null, ambiguous: false, rule: 'unparseable' }
      : { date, ambiguous: false, rule: 'yy_gt_current_19xx' };
  }
  const recent = validYmd(2000 + yy, month, day);
  if (recent !== null && recent <= today)
    return { date: recent, ambiguous: true, rule: 'yy_le_current_assumed_20xx' };
  const old = validYmd(1900 + yy, month, day);
  return old === null
    ? { date: null, ambiguous: false, rule: 'unparseable' }
    : { date: old, ambiguous: false, rule: 'future_as_20xx_so_19xx' };
}

/** Accepts `2001-08-21`, `2025-11-20T00:00:00.000`, `2026-07-01 12:00:00`. Returns YYYY-MM-DD or null. */
export function isoDatePart(raw: string | null | undefined): string | null {
  const value = blankToNull(raw);
  if (value === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(value);
  if (m === null) return null;
  return validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** Accepts US `MM/DD/YYYY` (CSLB). Returns YYYY-MM-DD or null. */
export function usDate(raw: string | null | undefined): string | null {
  const value = blankToNull(raw);
  if (value === null) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (m === null) return null;
  return validYmd(Number(m[3]), Number(m[1]), Number(m[2]));
}

export function toNumber(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const value = raw.trim().replace(/[$,]/g, '');
  if (value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Treats 0/0 and blanks as "no coordinate" (a common placeholder), leaving real values for range checks. */
export function coordinate(raw: string | number | null | undefined): number | null {
  const n = toNumber(raw);
  return n === null || n === 0 ? null : n;
}

export function zip5(raw: string | null | undefined): string | null {
  const value = blankToNull(raw);
  if (value === null) return null;
  const m = /^(\d{5})(?:-?\d{4})?$/.exec(value);
  return m?.[1] ?? null;
}

export function truncate(value: string | null, max: number): string | null {
  return value !== null && value.length > max ? value.slice(0, max) : value;
}

export interface LocatedPoint {
  readonly lat: number | null;
  readonly lon: number | null;
  /** Set when the source supplied a coordinate that was discarded, saying why and what it was. */
  readonly note: string | null;
}

/**
 * A permit's own coordinate is optional: the parcel centroid can stand in for it. So a coordinate that
 * falls outside San Diego County (a bad geocode; real examples resolve to Texas and New Jersey) is
 * dropped and the permit is kept, with the discarded value recorded. A half-present pair is treated
 * the same way.
 */
export function countyCoordinate(
  rawLat: string | number | null | undefined,
  rawLon: string | number | null | undefined,
): LocatedPoint {
  const lat = coordinate(rawLat);
  const lon = coordinate(rawLon);
  if (lat === null && lon === null) return { lat: null, lon: null, note: null };
  if (lat === null || lon === null) {
    return {
      lat: null,
      lon: null,
      note: `source coordinate incomplete (${String(lat)}, ${String(lon)}); discarded`,
    };
  }
  const inside =
    lat >= COUNTY_BBOX.minLat &&
    lat <= COUNTY_BBOX.maxLat &&
    lon >= COUNTY_BBOX.minLon &&
    lon <= COUNTY_BBOX.maxLon;
  if (inside) return { lat, lon, note: null };
  return {
    lat: null,
    lon: null,
    note: `source coordinate outside San Diego County (${lat}, ${lon}); discarded`,
  };
}

export type TransferConfidence = 'certain' | 'resolved' | 'ambiguous';

export interface ResolvedTransfer {
  readonly date: string | null;
  /** Null when there is no usable date. */
  readonly confidence: TransferConfidence | null;
  readonly rule: string;
}

/** Document-type codes the recorder extract uses on modern documents. */
const TYPED_DOCUMENT = new Set(['1', '2', '3', '6']);

/**
 * Century of a parcel's last recorded document (MMDDYY). Three outcomes, each with its rule named:
 *
 *  certain    The digits allow one century: yy above the current yy is 19yy, and a 20yy date that would
 *             fall in the future is 19yy.
 *  resolved   yy at or below the current yy, read as 20yy because of independent evidence:
 *             - `owner_occupied_exemption_20xx`: the parcel carries the owner-occupied flag (a
 *               homeowner's exemption claimed by a living resident), so the owner cannot have taken
 *               title a century ago.
 *             - `typed_document_on_taxable_parcel_20xx`: a taxable parcel whose document has a modern
 *               type code. In the loaded data, last documents dated 1927 to 1939 number 58 in thirteen
 *               years (1 to 21 a year) against 11,000 to 85,000 a year for yy 00 to 26, and three in
 *               four of the pre-1960 ones carry no type code at all.
 *  ambiguous  Neither applies: a tax-exempt parcel (public agencies, churches and utilities do hold land
 *             for a century) or a document with no type code. The date is still read as 20yy, flagged.
 */
export function resolveTransferDate(
  raw: string | null | undefined,
  today: string,
  evidence: { readonly ownerOccupied: boolean; readonly taxable: boolean; readonly docType: string | null },
): ResolvedTransfer {
  const base = resolveMmddyy(raw, today);
  if (base.date === null) return { date: null, confidence: null, rule: base.rule };
  if (!base.ambiguous) return { date: base.date, confidence: 'certain', rule: base.rule };
  if (evidence.ownerOccupied) {
    return { date: base.date, confidence: 'resolved', rule: 'owner_occupied_exemption_20xx' };
  }
  if (evidence.taxable && evidence.docType !== null && TYPED_DOCUMENT.has(evidence.docType)) {
    return { date: base.date, confidence: 'resolved', rule: 'typed_document_on_taxable_parcel_20xx' };
  }
  return { date: base.date, confidence: 'ambiguous', rule: 'yy_le_current_no_corroboration' };
}
