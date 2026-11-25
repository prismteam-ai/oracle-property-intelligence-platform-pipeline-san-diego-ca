import { parseArgs } from 'node:util';
import { resolvePaths, type Window } from './config.js';
import { createHttpClient } from './http.js';
import { createLogger, errorMessage } from './log.js';
import { ALL_ADAPTERS, runPipeline, type SourceStat } from './pipeline.js';

const HELP = `Usage: npm run pipeline -- [options]

  --window <from>..<to>   Change window, dates as YYYY-MM-DD; either side may be empty.
                          Examples: --window ..2026-11-01   --window 2026-10-25..   (default: everything)
  --sources <ids>         Comma-separated source ids (default: all). Ids:
                          ${ALL_ADAPTERS.map((a) => a.info.id).join(', ')}
  --force                 Re-read snapshot sources even when their ETag / edit stamp is unchanged.
  --data-dir <dir>        Where raw files and the database live (default: data).
  --db <file>             DuckDB file (default: <data-dir>/oracle.duckdb).
  --keep-stage            Keep the validated NDJSON stage files for inspection.
  --help
`;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseWindow(value: string | undefined): Window {
  if (value === undefined) return { from: null, to: null };
  const parts = value.split('..');
  if (parts.length !== 2) throw new Error(`--window must look like <from>..<to>, got "${value}"`);
  const [from, to] = parts.map((p) => (p === '' ? null : p));
  for (const bound of [from, to]) {
    if (bound !== null && bound !== undefined && !DATE.test(bound)) throw new Error(`bad date in --window: "${bound}"`);
  }
  if (from != null && to != null && from >= to) throw new Error('--window: <from> must be before <to>');
  return { from: from ?? null, to: to ?? null };
}

function table(stats: readonly SourceStat[]): string {
  const header = ['source', 'entity', 'fetched', 'rejected', 'dupes', 'inserted', 'updated', 'unchanged', 'MB', 'sec'];
  const rows = stats.map((s) => [
    s.sourceId, s.entity, s.fetched, s.rejected, s.duplicates, s.inserted, s.updated, s.unchanged,
    (s.bytes / 1e6).toFixed(1), s.seconds.toFixed(1),
  ].map(String));
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const line = (cells: readonly string[]): string => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      window: { type: 'string' },
      sources: { type: 'string' },
      force: { type: 'boolean', default: false },
      'data-dir': { type: 'string', default: 'data' },
      db: { type: 'string' },
      'keep-stage': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const wanted = values.sources?.split(',').map((s) => s.trim());
  const adapters = wanted === undefined ? ALL_ADAPTERS : ALL_ADAPTERS.filter((a) => wanted.includes(a.info.id));
  const unknown = (wanted ?? []).filter((id) => !ALL_ADAPTERS.some((a) => a.info.id === id));
  if (unknown.length > 0) throw new Error(`unknown source id(s): ${unknown.join(', ')}`);

  const summary = await runPipeline({
    paths: resolvePaths(values['data-dir'], values.db),
    window: parseWindow(values.window),
    adapters,
    http: createHttpClient(),
    log: createLogger(),
    force: values.force,
    now: () => new Date(),
    keepStage: values['keep-stage'],
  });
  process.stdout.write(`\nrun ${summary.runId}: ${summary.status}\n${table(summary.stats)}\n`);
  for (const s of summary.stats.filter((x) => x.notes !== '')) process.stdout.write(`  ${s.sourceId}/${s.entity}: ${s.notes}\n`);
  return summary.status === 'ok' ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`${errorMessage(e)}\n`);
    process.exitCode = 2;
  },
);
