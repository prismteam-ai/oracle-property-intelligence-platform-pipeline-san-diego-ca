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
