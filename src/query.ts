import { parseArgs } from 'node:util';
import { z } from 'zod';
import { resolvePaths } from './config.js';
import { Db } from './db.js';
import { errorMessage } from './log.js';

/** Ad-hoc SQL against the loaded database: `npm run query -- "SELECT ..."`. Prints JSON lines. */
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { 'data-dir': { type: 'string', default: 'data' }, db: { type: 'string' } },
    allowPositionals: true,
  });
  const sql = positionals.join(' ').trim();
  if (sql === '') throw new Error('usage: npm run query -- "SELECT ..."');
  const db = await Db.open(resolvePaths(values['data-dir'], values.db).dbPath);
  try {
    const rows = await db.query(z.record(z.string(), z.unknown()), sql);
    for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
  } finally {
    db.close();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${errorMessage(e)}\n`);
  process.exitCode = 2;
});
