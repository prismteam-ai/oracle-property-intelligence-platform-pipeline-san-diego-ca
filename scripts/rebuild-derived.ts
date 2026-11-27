/**
 * Rebuilds the derived tables and views (permit links, aliases, status summary, year cross-check)
 * from the loaded data, without fetching anything and without recording a pipeline run. Use it after
 * changing a reconciliation rule; the next pipeline run would produce the same tables.
 *
 *   npx tsx scripts/rebuild-derived.ts [--data-dir data]
 */
import { parseArgs } from 'node:util';
import { resolvePaths } from '../src/config.js';
import { Db, migrate } from '../src/db.js';
import { DERIVED } from '../src/reconcile.js';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string', default: 'data' } } });
const db = await Db.open(resolvePaths(values['data-dir']).dbPath);
try {
  await migrate(db);
  for (const sql of DERIVED) await db.exec(sql);
  process.stdout.write(`rebuilt ${DERIVED.length} derived tables\n`);
} finally {
  db.close();
}
