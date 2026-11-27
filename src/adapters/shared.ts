import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse';
import { z } from 'zod';
import type { Window } from '../config.js';
import { mapLimit, type HeadInfo } from '../http.js';
import type { FetchContext, FetchResult, RawFile } from './types.js';

export async function fileIfExists(filePath: string, url: string): Promise<RawFile | null> {
  try {
    const s = await stat(filePath);
    return { path: filePath, url, fetchedAt: s.mtime.toISOString(), bytes: s.size };
  } catch {
    return null;
  }
}

async function writeAtomic(filePath: string, body: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(`${filePath}.part`, body, 'utf8');
  await rename(`${filePath}.part`, filePath);
}

export function sourceDir(ctx: FetchContext, sourceId: string): string {
  return path.join(ctx.rawDir, sourceId, ctx.runDate);
}

export function windowLabel(window: Window): string {
  return `${window.from ?? 'begin'}_${window.to ?? 'end'}`;
}

/**
 * Whole-file sources (CSV downloads). The HTTP ETag is the change token: an unchanged token means
 * the publisher has not refreshed the file, so the run skips it. A file already on disk for this
 * run date is reused, which makes an interrupted run resumable.
 */
export async function fetchSnapshotFiles(
  ctx: FetchContext,
  sourceId: string,
  files: readonly { readonly name: string; readonly url: string }[],
): Promise<FetchResult> {
  // Some servers refuse HEAD; that only costs us the "not modified" shortcut.
  const heads = await mapLimit(files, 2, async (f): Promise<HeadInfo> => {
    try {
      return await ctx.http.head(f.url);
    } catch {
      return { etag: null, lastModified: null, contentLength: null };
    }
  });
  const stateToken = heads
    .map((h, i) => `${files[i]?.name ?? ''}=${h.etag ?? h.lastModified ?? 'none'}`)
    .join(';');
  const hasToken = heads.every((h) => h.etag !== null || h.lastModified !== null);
  if (!ctx.force && hasToken && ctx.previousStateToken === stateToken) {
    return {
      files: [],
      bytes: 0,
      skipped: 'not modified since last load (same ETag)',
      stateToken,
      notes: [],
    };
  }
  const dir = sourceDir(ctx, sourceId);
  let bytes = 0;
  const notes: string[] = [];
  const raw = await mapLimit(files, 2, async (f, i) => {
    // A file is reused only if it is the same published version: its folder is named after its ETag.
    // (A server that sends no ETag gets one download per run date.)
    const version = heads[i]?.etag ?? heads[i]?.lastModified ?? null;
    const versionDir =
      version === null ? dir : path.join(dir, createHash('sha1').update(version).digest('hex').slice(0, 12));
    const dest = path.join(versionDir, f.name);
    const existing = await fileIfExists(dest, f.url);
    if (existing !== null) {
      notes.push(`reused ${f.name} (same published version, already on disk)`);
      return existing;
    }
    const started = Date.now();
    const size = await ctx.http.download(f.url, dest);
    bytes += size;
    ctx.log.info('downloaded', {
      source: sourceId,
      file: f.name,
      bytes: size,
      seconds: (Date.now() - started) / 1000,
    });
    return { path: dest, url: f.url, fetchedAt: new Date().toISOString(), bytes: size };
  });
  return { files: raw, bytes, skipped: null, stateToken, notes };
}

const SocrataPage = z.array(z.record(z.string(), z.unknown()));
const COMPLETE_MARKER = '_complete';

/**
 * Socrata (SODA) sources. The window becomes a server-side filter on the dataset's change column,
 * pages are ordered by the stable `:id`, and each page is saved as its own file so a rerun resumes
 * at the first missing page.
 */
export async function fetchSocrata(
  ctx: FetchContext,
  opts: {
    readonly sourceId: string;
    readonly resourceUrl: string;
    readonly changeColumn: string;
    readonly pageSize: number;
  },
): Promise<FetchResult> {
  // Pages are reused only to resume a fetch that did not finish. A finished fetch leaves a marker,
  // and the next run for the same window starts a new attempt folder, so it always sees current data.
  const windowDir = path.join(sourceDir(ctx, opts.sourceId), windowLabel(ctx.window));
  let attempt = 1;
  while ((await fileIfExists(path.join(windowDir, `attempt-${attempt}`, COMPLETE_MARKER), '')) !== null) {
    attempt++;
  }
  const dir = path.join(windowDir, `attempt-${attempt}`);
  const clauses: string[] = [];
  if (ctx.window.from !== null) clauses.push(`${opts.changeColumn} >= '${ctx.window.from}T00:00:00'`);
  if (ctx.window.to !== null) clauses.push(`${opts.changeColumn} < '${ctx.window.to}T00:00:00'`);
  const files: RawFile[] = [];
  let bytes = 0;
  let reused = 0;
  for (let page = 0; ; page++) {
    const params = new URLSearchParams({
      $order: ':id',
      $limit: String(opts.pageSize),
      $offset: String(page * opts.pageSize),
    });
    if (clauses.length > 0) params.set('$where', clauses.join(' AND '));
    const url = `${opts.resourceUrl}?${params.toString()}`;
    const dest = path.join(dir, `page_${String(page).padStart(5, '0')}.json`);
    let file = await fileIfExists(dest, url);
    let body: string;
    if (file === null) {
      body = await ctx.http.getText(url);
      await writeAtomic(dest, body);
      file = { path: dest, url, fetchedAt: new Date().toISOString(), bytes: Buffer.byteLength(body) };
      bytes += file.bytes;
    } else {
      body = await readFile(dest, 'utf8');
      reused++;
    }
    const rows = SocrataPage.parse(JSON.parse(body)).length;
    if (rows > 0) files.push(file);
    ctx.log.info('socrata page', { source: opts.sourceId, page, rows });
    if (rows < opts.pageSize) break;
  }
  await writeAtomic(path.join(dir, COMPLETE_MARKER), new Date().toISOString());
  return {
    files,
    bytes,
    skipped: null,
    stateToken: null,
    notes: reused > 0 ? [`resumed an interrupted fetch: reused ${reused} page file(s)`] : [],
  };
}

export async function* readSocrataPages(
  files: readonly RawFile[],
): AsyncGenerator<{ readonly record: Record<string, unknown>; readonly file: RawFile }> {
  for (const file of files) {
    const page = SocrataPage.parse(JSON.parse(await readFile(file.path, 'utf8')));
    for (const record of page) yield { record, file };
  }
}

export interface CsvRecord {
  readonly record: Readonly<Record<string, string>>;
  readonly file: RawFile;
  readonly line: number;
}

/**
 * Streams a CSV file record by record (quoted newlines included), so a 400 MB file never sits in
 * memory. Structurally broken records are reported through `onMalformed` instead of stopping the run.
 */
export async function* readCsv(
  file: RawFile,
  encoding: BufferEncoding,
  onMalformed: (line: number, message: string) => void,
): AsyncGenerator<CsvRecord> {
  const parser = createReadStream(file.path, { encoding }).pipe(
    parse({
      columns: true,
      bom: true,
      skip_empty_lines: true,
      relax_quotes: true,
      skip_records_with_error: true,
      info: true,
    }),
  );
  parser.on('skip', (err: { message: string; lines?: number }) => {
    onMalformed(err.lines ?? 0, err.message);
  });
  const Row = z.object({ record: z.record(z.string(), z.string()), info: z.object({ lines: z.number() }) });
  for await (const item of parser) {
    const { record, info } = Row.parse(item);
    yield { record, file, line: info.lines };
  }
}

export function str(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}
