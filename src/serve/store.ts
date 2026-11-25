import path from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { z } from 'zod';
import { ARTIFACTS } from '../publish/exportArtifacts.js';

export type Param = string | number | boolean | null;

const sqlPath = (p: string): string => `'${p.replace(/\\/g, '/').replace(/'/g, "''")}'`;

/** Relations the serving layer exposes. Names are the public query contract for agents. */
export const RELATIONS = {
  parcel: ARTIFACTS.queryTable,
  permit: ARTIFACTS.permits,
  contractor: ARTIFACTS.contractors,
  business: ARTIFACTS.businesses,
  place: ARTIFACTS.places,
} as const;

/**
 * Read-only query store: an in-memory DuckDB whose only contents are views over the published
 * Parquet files. There is no database server and nothing to keep running; the same files are
 * what IPFS holds, so any holder of the CIDs can stand up an identical store.
 */
export class Store {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
    readonly artifactDir: string,
  ) {}

  static async open(artifactDir: string): Promise<Store> {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    // Reads are confined to the artifact folder; everything else on disk and the network is off.
    await connection.run(`SET allowed_directories = [${sqlPath(path.resolve(artifactDir))}]`);
    for (const [relation, file] of Object.entries(RELATIONS)) {
      const full = path.join(artifactDir, ...file.split('/'));
      await connection.run(`CREATE VIEW ${relation} AS SELECT * FROM read_parquet(${sqlPath(full)})`);
    }
    // After the views exist, lock the engine down: no file access beyond what is already bound,
    // no extension loading, no further configuration changes. Agent SQL runs under these limits.
    await connection.run(`SET enable_external_access = false`);
    await connection.run(`SET lock_configuration = true`);
    return new Store(instance, connection, artifactDir);
  }

  async query<T>(schema: z.ZodType<T>, sql: string, params: readonly Param[] = []): Promise<T[]> {
    const reader = await this.connection.runAndReadAll(sql, [...params]);
    return reader.getRowObjectsJson().map((row) => schema.parse(row));
  }

  async queryNamed<T>(
    schema: z.ZodType<T>,
    sql: string,
    params: Readonly<Record<string, Param>>,
  ): Promise<T[]> {
    const reader = await this.connection.runAndReadAll(sql, { ...params });
    return reader.getRowObjectsJson().map((row) => schema.parse(row));
  }

  async raw(sql: string): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
    const reader = await this.connection.runAndReadAll(sql);
    return {
      columns: reader.columnNames(),
      rows: reader.getRowObjectsJson(),
    };
  }

  close(): void {
    this.connection.closeSync();
    this.instance.closeSync();
  }
}
