const intFmt = new Intl.NumberFormat('en-US');

export const fmtInt = (n: number | null | undefined): string =>
  n === null || n === undefined || Number.isNaN(n) ? '—' : intFmt.format(n);

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** Pipeline timestamps arrive as "2026-11-25 16:22:28.144" (UTC, no zone) or as ISO strings. */
export function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const iso = /[zZ]$|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function fmtTimestamp(value: string | null | undefined): string {
  const date = parseTimestamp(value);
  if (!date) return value ?? '—';
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

export function fmtDuration(start: string | null, end: string | null): string {
  const a = parseTimestamp(start);
  const b = parseTimestamp(end);
  if (!a || !b) return '—';
  const seconds = Math.max(0, Math.round((b.getTime() - a.getTime()) / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export function fmtOpenDuration(days: number | null): string {
  if (days === null) return '—';
  const years = days / 365.25;
  return years >= 1 ? `${years.toFixed(1)} yrs (${fmtInt(days)} days)` : `${fmtInt(days)} days`;
}

export function shortCid(cid: string, head = 10, tail = 6): string {
  return cid.length <= head + tail + 1 ? cid : `${cid.slice(0, head)}…${cid.slice(-tail)}`;
}

export function roofBasisLabel(basis: string): string {
  if (basis === 'last_roofing_permit') return 'Last completed roofing permit';
  if (basis === 'year_built') return 'Assessor year built (no roofing permit on record)';
  return 'Unknown';
}

export function fmtCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Copies text without a native dialog; falls back to a hidden textarea when the API is absent. */
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = value;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
