/**
 * Adds named real City of San Diego approvals to the test fixture: the rows behind defects found on
 * the live site, copied unmodified from the downloaded CSVs. Needs a pipeline run's raw files.
 *
 *   npx tsx scripts/record-city-extra-fixture.ts data/raw
 *
 * Tests never run this; they read what it wrote under test/fixtures/sdcity_permits/.
 */
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse';
import { z } from 'zod';

/** Approval ids to capture, with why each is in the fixture. */
const WANTED: Readonly<Record<string, string>> = {
  // The same permit listed twice (legacy number and PMT- number); the PMT record is the current one.
  '2163994': 'duplicate pair; restaurant shell wrongly classed as roofing',
  'PMT-2163994': 'duplicate pair',
  // A pair where the legacy record is the one further along (Completed) and the PMT record is stale.
  '2350547': 'duplicate pair, legacy record is terminal',
  'PMT-2350547': 'duplicate pair',
  // A planning review that was first in the long-open roofing list.
  '256673': 'Substantial Conformance Review classed as roof structural',
  // A solar permit that mentions reroofing.
  'PMT-3375246': 'uninstall/reinstall of solar modules after re-roofing',
  // A trade permit carrying its project's roofing text.
  'PMT-3255927': 'Electrical Pmt whose text is a roof repair building permit',
  // Real reroofs that must stay roofing.
  'PMT-3277117': 'no-plan combination permit, re-roof like for like',
  'PMT-3112859': 'repair/replace in kind of roof framing',
};

const CsvRow = z.record(z.string(), z.string());

async function newest(root: string, name: string): Promise<string> {
  const found: { file: string; mtime: number }[] = [];
  for (const entry of await readdir(root, { recursive: true })) {
    if (path.basename(entry) !== name) continue;
    const file = path.join(root, entry);
    found.push({ file, mtime: (await stat(file)).mtimeMs });
  }
  const latest = found.sort((a, b) => b.mtime - a.mtime)[0];
  if (latest === undefined) throw new Error(`${name} not found under ${root}`);
  return latest.file;
}

function toCsvLine(header: readonly string[], row: Readonly<Record<string, string>>): string {
  return header.map((h) => `"${(row[h] ?? '').replace(/"/g, '""')}"`).join(',');
}

const rawRoot = path.resolve(process.argv[2] ?? 'data/raw');
for (const name of ['approvals_active_datasd.csv', 'approvals_closed_datasd.csv']) {
  const fixture = path.resolve('test/fixtures/sdcity_permits', name);
  const existing = await readFile(fixture, 'utf8');
  const header = (existing.split('\n')[0] ?? '').split(',').map((h) => h.replace(/"/g, ''));
  const added: string[] = [];
  const parser = createReadStream(await newest(rawRoot, name), { encoding: 'utf8' }).pipe(
    parse({ columns: true, bom: true, relax_quotes: true }),
  );
  for await (const item of parser) {
    const row = CsvRow.parse(item);
    const id = row['APPROVAL_ID'] ?? '';
    if (id in WANTED && !existing.includes(`"${id}"`)) added.push(toCsvLine(header, row));
  }
  if (added.length > 0) await writeFile(fixture, `${existing.trimEnd()}\n${added.join('\n')}\n`, 'utf8');
  process.stdout.write(`${name}: added ${added.length} row(s)\n`);
}
