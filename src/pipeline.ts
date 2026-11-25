import { rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { cityBusinesses } from './adapters/cityBusinesses.js';
import { cityPermits } from './adapters/cityPermits.js';
import { countyPermitContractors, countyPermitStatus, countyPermits } from './adapters/countySocrata.js';
import { cslbLicenses } from './adapters/cslbLicenses.js';
import { sandagParcels } from './adapters/sandagParcels.js';
import type { SourceAdapter } from './adapters/types.js';
import { isoDate, type Paths, type Window } from './config.js';
import { Db, migrate } from './db.js';
import { makeEntities, type Entities, type EntityKey } from './entities.js';
import type { HttpClient } from './http.js';
import { errorMessage, type Logger } from './log.js';
import { NdjsonWriter, mergeStage, readNdjson, stageRelation } from './merge.js';
import { duplicateKeyReport, reconcile } from './reconcile.js';

/** Load order matters only for readability; reconciliation runs after all sources. */
export const ALL_ADAPTERS: readonly SourceAdapter[] = [
  sandagParcels,
  countyPermitStatus,
  countyPermits,
  countyPermitContractors,
  cityPermits,
  cityBusinesses,
  cslbLicenses,
];

export const RECONCILED_SOURCE_ID = 'reconciled';

export interface RunOptions {
  readonly paths: Paths;
  readonly window: Window;
  readonly adapters: readonly SourceAdapter[];
  readonly http: HttpClient;
  readonly log: Logger;
  /** Re-read snapshot sources even if their change token is unchanged. */
  readonly force: boolean;
  /** Injected clock, so tests are deterministic. */
  readonly now: () => Date;
  readonly keepStage?: boolean;
}

export interface SourceStat {
  readonly sourceId: string;
  readonly entity: string;
  readonly fetched: number;
  readonly rejected: number;
  readonly duplicates: number;
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly bytes: number;
  readonly seconds: number;
  readonly notes: string;
}

export interface RunSummary {
  readonly runId: number;
  readonly status: 'ok' | 'partial' | 'failed';
  readonly stats: readonly SourceStat[];
}

const MaxRun = z.object({ run_id: z.coerce.number() });
const StateRow = z.object({ state_token: z.string().nullable() });

async function recordStat(db: Db, runId: number, s: SourceStat): Promise<void> {
  await db.exec(`INSERT INTO run_source_stats VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    runId,
    s.sourceId,
    s.entity,
    s.fetched,
    s.rejected,
    s.duplicates,
    s.inserted,
    s.updated,
    s.unchanged,
    s.bytes,
    s.seconds,
    s.notes,
  ]);
}

async function registerSource(db: Db, adapter: SourceAdapter): Promise<void> {
  const i = adapter.info;
  await db.exec('DELETE FROM source WHERE source_id = ?', [i.id]);
  await db.exec('INSERT INTO source VALUES (?, ?, ?, ?, ?, ?)', [
    i.id,
    i.name,
    i.url,
    i.licence,
    i.limits,
    i.changeDetection,
  ]);
}

async function runAdapter(
  db: Db,
  runId: number,
  adapter: SourceAdapter,
  entities: Entities,
  options: RunOptions,
  today: string,
): Promise<SourceStat[]> {
  const { log, paths } = options;
  const started = Date.now();
  const sourceId = adapter.info.id;
  const previous = await db.query(StateRow, 'SELECT state_token FROM source_state WHERE source_id = ?', [
    sourceId,
  ]);

  const fetched = await adapter.fetch({
    runDate: today,
    rawDir: paths.rawDir,
    window: options.window,
    http: options.http,
    log,
    previousStateToken: previous[0]?.state_token ?? null,
    force: options.force,
  });
  const fetchSeconds = (Date.now() - started) / 1000;
  if (fetched.skipped !== null) {
    log.info('source skipped', { source: sourceId, reason: fetched.skipped });
    return adapter.entities.map((entity) => ({
      sourceId,
      entity: entities[entity].name,
      fetched: 0,
      rejected: 0,
      duplicates: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      bytes: 0,
      seconds: fetchSeconds,
      notes: `skipped: ${fetched.skipped ?? ''}`,
    }));
  }

  // Step boundary: every record is validated here and lands in exactly one of two files.
  const stageDir = path.join(paths.stageDir, String(runId));
  const writers = new Map<EntityKey, NdjsonWriter>();
  for (const entity of adapter.entities) {
    writers.set(
      entity,
      await NdjsonWriter.create(path.join(stageDir, `${sourceId}.${entities[entity].name}.ndjson`)),
    );
  }
  const rejectWriter = await NdjsonWriter.create(path.join(stageDir, `${sourceId}.rejects.ndjson`));
  const rejectedBy = new Map<EntityKey, number>();
  let seq = 0;
  for await (const record of adapter.rows(fetched.files, { entities, today, log })) {
    if (record.ok) {
      const writer = writers.get(record.entity);
      if (writer === undefined) throw new Error(`${sourceId} produced undeclared entity ${record.entity}`);
      await writer.write({
        ...record.row,
        source_id: sourceId,
        source_record_id: record.sourceRecordId,
        source_url: record.sourceUrl,
        fetched_at: record.fetchedAt,
        _rank: record.rank,
        _seq: seq++,
      });
    } else {
      rejectedBy.set(record.entity, (rejectedBy.get(record.entity) ?? 0) + 1);
      await rejectWriter.write({
        entity: entities[record.entity].name,
        source_record_id: record.sourceRecordId,
        reason: record.reason,
        raw_record: JSON.stringify(record.raw).slice(0, 4000),
      });
    }
  }
  await rejectWriter.close();
  for (const writer of writers.values()) await writer.close();
  const parseSeconds = (Date.now() - started) / 1000 - fetchSeconds;

  if (rejectWriter.count > 0) {
    await db.exec(
      `INSERT INTO rejects
       SELECT ${runId}, '${sourceId}', entity, source_record_id, reason, raw_record, now()::TIMESTAMP
       FROM (${readNdjson(rejectWriter.filePath, { entity: 'VARCHAR', source_record_id: 'VARCHAR', reason: 'VARCHAR', raw_record: 'VARCHAR' })})`,
    );
  }

  const stats: SourceStat[] = [];
  for (const [index, entity] of adapter.entities.entries()) {
    const spec = entities[entity];
    const writer = writers.get(entity);
    if (writer === undefined) continue;
    const rejected = rejectedBy.get(entity) ?? 0;
    const counts =
      writer.count === 0
        ? { staged: 0, duplicates: 0, inserted: 0, updated: 0, unchanged: 0 }
        : await mergeStage(db, runId, spec, stageRelation(spec, writer.filePath));
    const seconds = (Date.now() - started) / 1000;
    const notes = [
      ...fetched.notes,
      `fetch ${fetchSeconds.toFixed(1)}s, validate ${parseSeconds.toFixed(1)}s`,
      ...(fetched.bytes > 0 && fetchSeconds > 0
        ? [`${(fetched.bytes / fetchSeconds / 1e6).toFixed(2)} MB/s`]
        : []),
    ].join('; ');
    stats.push({
      sourceId,
      entity: spec.name,
      fetched: counts.staged + rejected,
      rejected,
      duplicates: counts.duplicates,
      inserted: counts.inserted,
      updated: counts.updated,
      unchanged: counts.unchanged,
      // Bytes and seconds describe the source as a whole, so they sit on its first entity only.
      bytes: index === 0 ? fetched.bytes : 0,
      seconds: index === 0 ? seconds : 0,
      notes,
    });
    log.info('merged', { source: sourceId, entity: spec.name, ...counts, rejected });
  }

  if (fetched.stateToken !== null) {
    await db.exec('DELETE FROM source_state WHERE source_id = ?', [sourceId]);
    await db.exec('INSERT INTO source_state VALUES (?, ?, ?, now()::TIMESTAMP)', [
      sourceId,
      fetched.stateToken,
      runId,
    ]);
  }
  if (options.keepStage !== true) await rm(stageDir, { recursive: true, force: true });
  return stats;
}

/**
 * One pipeline run: fetch a window from every source, validate at the boundary, upsert, reconcile,
 * and write the run history. A failing source is recorded and the rest still load ("partial").
 */
export async function runPipeline(options: RunOptions): Promise<RunSummary> {
  const { log } = options;
  const startedAt = options.now();
  const today = isoDate(startedAt);
  const entities = makeEntities(today);
  const db = await Db.open(options.paths.dbPath);
  try {
    await migrate(db);
    const runId = (await db.one(MaxRun, 'SELECT coalesce(max(run_id), 0) + 1 AS run_id FROM pipeline_run'))
      .run_id;
    await db.exec(
      `INSERT INTO pipeline_run VALUES (?, ?::TIMESTAMP, NULL, ?::DATE, ?::DATE, 'running', ?, ?, NULL)`,
      [
        runId,
        startedAt.toISOString(),
        options.window.from,
        options.window.to,
        options.adapters.map((a) => a.info.id).join(','),
        options.force,
      ],
    );
    log.info('run started', { runId, windowFrom: options.window.from, windowTo: options.window.to });

    const stats: SourceStat[] = [];
    const failures: string[] = [];
    for (const adapter of options.adapters) {
      await registerSource(db, adapter);
      try {
        const adapterStats = await runAdapter(db, runId, adapter, entities, options, today);
        for (const s of adapterStats) {
          await recordStat(db, runId, s);
          stats.push(s);
        }
      } catch (e) {
        // Recorded in run history, logged, and reflected in a non-zero exit code; never swallowed.
        const message = errorMessage(e);
        failures.push(`${adapter.info.id}: ${message}`);
        log.error('source failed', { source: adapter.info.id, error: message });
        const failed: SourceStat = {
          sourceId: adapter.info.id,
          entity: adapter.entities.join('+'),
          fetched: 0,
          rejected: 0,
          duplicates: 0,
          inserted: 0,
          updated: 0,
          unchanged: 0,
          bytes: 0,
          seconds: 0,
          notes: `FAILED: ${message.slice(0, 500)}`,
        };
        await recordStat(db, runId, failed);
        stats.push(failed);
      }
    }

    await db.exec('DELETE FROM source WHERE source_id = ?', [RECONCILED_SOURCE_ID]);
    await db.exec('INSERT INTO source VALUES (?, ?, ?, ?, ?, ?)', [
      RECONCILED_SOURCE_ID,
      'Reconciliation step (contractor identities built from CSLB master and county permit contractors)',
      'local',
      'derived',
      'Derived from the sources above; each contractor row names the source record it came from.',
      'derived',
    ]);
    const reconcileStarted = Date.now();
    const c = await reconcile(db, runId, entities);
    const reconciled: SourceStat = {
      sourceId: RECONCILED_SOURCE_ID,
      entity: 'contractor',
      fetched: c.staged,
      rejected: 0,
      duplicates: c.duplicates,
      inserted: c.inserted,
      updated: c.updated,
      unchanged: c.unchanged,
      bytes: 0,
      seconds: (Date.now() - reconcileStarted) / 1000,
      notes: 'built in SQL from cslb_license and permit_contractor_record',
    };
    await recordStat(db, runId, reconciled);
    stats.push(reconciled);

    const duplicates = await duplicateKeyReport(db, entities);
    failures.push(...duplicates);
    const status =
      failures.length === 0
        ? 'ok'
        : stats.some((s) => s.inserted + s.updated + s.unchanged > 0)
          ? 'partial'
          : 'failed';
    await db.exec(
      `UPDATE pipeline_run SET finished_at = ?::TIMESTAMP, status = ?, notes = ? WHERE run_id = ?`,
      [
        options.now().toISOString(),
        status,
        failures.length === 0 ? null : failures.join(' | ').slice(0, 2000),
        runId,
      ],
    );
    log.info('run finished', { runId, status });
    return { runId, status, stats };
  } finally {
    db.close();
  }
}
