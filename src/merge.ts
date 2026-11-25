import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { z } from 'zod';
import type { Db } from './db.js';
import type { DuckType, EntitySpec } from './entities.js';

/** Buffered NDJSON writer. Rows are written in bulk and loaded with DuckDB `read_json`, never row by row. */
export class NdjsonWriter {
  private buffer: string[] = [];
  private buffered = 0;
  count = 0;

  private constructor(
    readonly filePath: string,
    private readonly stream: WriteStream,
  ) {}

  static async create(filePath: string): Promise<NdjsonWriter> {
    await mkdir(path.dirname(filePath), { recursive: true });
    return new NdjsonWriter(filePath, createWriteStream(filePath, { encoding: 'utf8' }));
  }

  async write(record: Readonly<Record<string, unknown>>): Promise<void> {
    const line = JSON.stringify(record);
    this.buffer.push(line);
    this.buffered += line.length;
    this.count++;
    if (this.buffered >= 4_000_000) await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const chunk = `${this.buffer.join('\n')}\n`;
    this.buffer = [];
    this.buffered = 0;
    if (!this.stream.write(chunk)) await once(this.stream, 'drain');
  }

  async close(): Promise<void> {
    await this.flush();
    this.stream.end();
    await once(this.stream, 'finish');
  }
}

/** Columns every stage relation carries besides the entity's own. */
export const STAGE_EXTRA: Readonly<Record<string, DuckType>> = {
  source_id: 'VARCHAR',
  source_record_id: 'VARCHAR',
  source_url: 'VARCHAR',
  fetched_at: 'TIMESTAMP',
  _rank: 'DOUBLE',
  _seq: 'BIGINT',
};

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function readNdjson(filePath: string, columns: Readonly<Record<string, DuckType>>): string {
  const spec = Object.entries(columns)
    .map(([name, type]) => `${name}: '${type}'`)
    .join(', ');
  return `SELECT * FROM read_json(${sqlString(filePath.replace(/\\/g, '/'))}, format = 'newline_delimited', columns = {${spec}})`;
}

export function stageRelation(spec: EntitySpec, filePath: string): string {
  return readNdjson(filePath, { ...spec.columns, ...STAGE_EXTRA });
}

export interface MergeCounts {
  readonly staged: number;
  readonly duplicates: number;
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
}

const Count = z.object({ n: z.coerce.number() });
const Delta = z.object({ inserted: z.coerce.number(), updated: z.coerce.number(), unchanged: z.coerce.number() });

/**
 * Idempotent upsert of a stage relation into its table, keyed on the entity's natural key.
 *
 *  1. Collapse records that share a key (highest `_rank`, then latest `_seq`, wins) and count them.
 *  2. Hash the data columns. Same key + same hash = unchanged; same key + different hash = updated;
 *     new key = inserted.
 *  3. Apply all three in one transaction, stamping `last_seen_run` on every row seen.
 *
 * Running the same input twice therefore inserts nothing and reports everything as unchanged.
 */
export async function mergeStage(db: Db, runId: number, spec: EntitySpec, stageSql: string): Promise<MergeCounts> {
  const columns = Object.keys(spec.columns);
  const dataColumns = columns.filter((c) => !spec.key.includes(c));
  const keyOrder = spec.key.join(', ');
  const on = spec.key.map((k) => `t.${k} = s.${k}`).join(' AND ');
  const hash = `md5(concat_ws('|', ${columns.map((c) => `coalesce(CAST(${c} AS VARCHAR), chr(1))`).join(', ')}))`;

  await db.exec(`CREATE OR REPLACE TEMP TABLE _stage_raw AS ${stageSql}`);
  const staged = (await db.one(Count, 'SELECT count(*) AS n FROM _stage_raw')).n;
  await db.exec(
    `CREATE OR REPLACE TEMP TABLE _stage AS
     SELECT ${columns.join(', ')}, source_id, source_record_id, source_url, fetched_at, ${hash} AS row_hash
     FROM (SELECT *, row_number() OVER (PARTITION BY ${keyOrder} ORDER BY _rank DESC, _seq DESC) AS _rn FROM _stage_raw)
     WHERE _rn = 1`,
  );
  const distinct = (await db.one(Count, 'SELECT count(*) AS n FROM _stage')).n;
  const delta = await db.one(
    Delta,
    `SELECT count(*) FILTER (WHERE t.row_hash IS NULL) AS inserted,
            count(*) FILTER (WHERE t.row_hash IS NOT NULL AND t.row_hash <> s.row_hash) AS updated,
            count(*) FILTER (WHERE t.row_hash = s.row_hash) AS unchanged
     FROM _stage s LEFT JOIN ${spec.table} t ON ${on}`,
  );

  await db.transaction(async () => {
    if (delta.updated > 0) {
      const assignments = [...dataColumns, 'source_id', 'source_record_id', 'source_url', 'fetched_at', 'row_hash']
        .map((c) => `${c} = s.${c}`)
        .join(', ');
      await db.exec(
        `UPDATE ${spec.table} AS t SET ${assignments}, last_seen_run = ${runId}
         FROM _stage s WHERE ${on} AND t.row_hash <> s.row_hash`,
      );
    }
    if (delta.unchanged > 0) {
      await db.exec(
        `UPDATE ${spec.table} AS t SET last_seen_run = ${runId}
         FROM _stage s WHERE ${on} AND t.row_hash = s.row_hash AND t.last_seen_run <> ${runId}`,
      );
    }
    if (delta.inserted > 0) {
      await db.exec(
        `INSERT INTO ${spec.table} (${columns.join(', ')}, source_id, source_record_id, source_url, fetched_at, first_seen_run, last_seen_run, row_hash)
         SELECT ${columns.map((c) => `s.${c}`).join(', ')}, s.source_id, s.source_record_id, s.source_url, s.fetched_at, ${runId}, ${runId}, s.row_hash
         FROM _stage s WHERE NOT EXISTS (SELECT 1 FROM ${spec.table} t WHERE ${on})`,
      );
    }
  });
  await db.exec('DROP TABLE IF EXISTS _stage_raw');
  await db.exec('DROP TABLE IF EXISTS _stage');
  return { staged, duplicates: staged - distinct, inserted: delta.inserted, updated: delta.updated, unchanged: delta.unchanged };
}
