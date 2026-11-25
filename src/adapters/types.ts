import type { z } from 'zod';
import type { Window } from '../config.js';
import type { Entities, EntityKey, RowOf } from '../entities.js';
import type { HttpClient } from '../http.js';
import type { Logger } from '../log.js';

export interface SourceInfo {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly licence: string;
  readonly limits: string;
  /** `cursor` sources filter server-side by a change date; `snapshot` sources publish whole files. */
  readonly changeDetection: 'cursor' | 'snapshot';
}

export interface RawFile {
  readonly path: string;
  readonly url: string;
  /** ISO timestamp of when these bytes were fetched from the source. */
  readonly fetchedAt: string;
  readonly bytes: number;
}

export interface FetchContext {
  /** UTC date of the run; raw files go under `<rawDir>/<source id>/<runDate>/`. */
  readonly runDate: string;
  readonly rawDir: string;
  readonly window: Window;
  readonly http: HttpClient;
  readonly log: Logger;
  /** State token saved by this source's last successful load (ETag or layer edit stamp). */
  readonly previousStateToken: string | null;
  /** Re-read snapshot sources even when their state token has not changed. */
  readonly force: boolean;
}

export interface FetchResult {
  readonly files: readonly RawFile[];
  /** Bytes downloaded by this run (0 for files reused from an interrupted run on the same date). */
  readonly bytes: number;
  /** Set when the source reported no change since the last load; nothing is staged. */
  readonly skipped: string | null;
  readonly stateToken: string | null;
  readonly notes: readonly string[];
}

export interface ParseContext {
  readonly entities: Entities;
  /** Run date, the reference point for "not in the future" and two-digit-year rules. */
  readonly today: string;
  readonly log: Logger;
}

export type StagedRecord =
  | {
      readonly ok: true;
      readonly entity: EntityKey;
      readonly row: Readonly<Record<string, unknown>>;
      readonly sourceRecordId: string;
      readonly sourceUrl: string;
      readonly fetchedAt: string;
      /** When two records share a key, the higher rank wins (ties: the later record). */
      readonly rank: number;
    }
  | {
      readonly ok: false;
      readonly entity: EntityKey;
      readonly sourceRecordId: string | null;
      readonly reason: string;
      readonly raw: unknown;
    };

/**
 * One external source sits behind one adapter: fetch a window of raw bytes, then turn them into
 * validated canonical rows. Swapping a provider means writing another adapter; nothing else changes.
 */
export interface SourceAdapter {
  readonly info: SourceInfo;
  readonly entities: readonly EntityKey[];
  fetch(ctx: FetchContext): Promise<FetchResult>;
  rows(files: readonly RawFile[], ctx: ParseContext): AsyncGenerator<StagedRecord>;
}

export interface Provenance {
  readonly sourceRecordId: string;
  readonly sourceUrl: string;
  readonly fetchedAt: string;
  readonly rank?: number;
}

function reasonOf(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'invalid';
  const field = issue.path.join('.');
  const detail = /^[a-z0-9_]+$/.test(issue.message) ? issue.message : issue.code;
  return field === '' ? detail : `${field}:${detail}`;
}

/** The step boundary: a candidate row either passes its entity's Zod schema or becomes a reject. */
export function validate<K extends EntityKey>(
  entities: Entities,
  entity: K,
  candidate: { [P in keyof RowOf<K>]: unknown },
  provenance: Provenance,
  raw: unknown,
): StagedRecord {
  const parsed = entities[entity].schema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, entity, sourceRecordId: provenance.sourceRecordId, reason: reasonOf(parsed.error), raw };
  }
  return {
    ok: true,
    entity,
    row: parsed.data,
    sourceRecordId: provenance.sourceRecordId,
    sourceUrl: provenance.sourceUrl,
    fetchedAt: provenance.fetchedAt,
    rank: provenance.rank ?? 0,
  };
}

export function reject(entity: EntityKey, sourceRecordId: string | null, reason: string, raw: unknown): StagedRecord {
  return { ok: false, entity, sourceRecordId, reason, raw };
}
