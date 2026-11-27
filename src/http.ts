import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { USER_AGENT } from './config.js';

export interface HeadInfo {
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly contentLength: number | null;
}

/**
 * The only door to the network. Adapters depend on this interface, so tests replace it with a
 * client that serves recorded fixtures and never touches the internet.
 */
export interface HttpClient {
  getText(url: string): Promise<string>;
  head(url: string): Promise<HeadInfo>;
  /** Streams the body to `destPath` (written as `.part`, then renamed). Returns bytes written. */
  download(url: string, destPath: string): Promise<number>;
}

export interface HttpOptions {
  readonly requestTimeoutMs?: number;
  readonly downloadTimeoutMs?: number;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
}

const RETRIABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries transient failures with exponential backoff and full jitter. 4xx (except 408/425/429) never retry. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const retriable = !(e instanceof HttpError) || RETRIABLE.has(e.status);
      if (!retriable || attempt === maxAttempts) break;
      await sleep(Math.random() * baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

export function createHttpClient(options: HttpOptions = {}): HttpClient {
  const requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? 30 * 60_000;
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const headers = { 'User-Agent': USER_AGENT };

  const request = async (url: string, method: 'GET' | 'HEAD', timeoutMs: number): Promise<Response> => {
    const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      await res.body?.cancel();
      throw new HttpError(res.status, url);
    }
    return res;
  };

  return {
    getText: (url) =>
      withRetry(async () => (await request(url, 'GET', requestTimeoutMs)).text(), maxAttempts, baseDelayMs),

    head: (url) =>
      withRetry(
        async () => {
          const res = await request(url, 'HEAD', requestTimeoutMs);
          const length = res.headers.get('content-length');
          return {
            etag: res.headers.get('etag'),
            lastModified: res.headers.get('last-modified'),
            contentLength: length === null ? null : Number(length),
          };
        },
        maxAttempts,
        baseDelayMs,
      ),

    download: (url, destPath) =>
      withRetry(
        async () => {
          await mkdir(path.dirname(destPath), { recursive: true });
          const part = `${destPath}.part`;
          const res = await request(url, 'GET', downloadTimeoutMs);
          if (res.body === null) throw new Error(`empty body for ${url}`);
          try {
            await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
          } catch (e) {
            await rm(part, { force: true });
            throw e;
          }
          await rename(part, destPath);
          return (await stat(destPath)).size;
        },
        maxAttempts,
        baseDelayMs,
      ),
  };
}

/** Runs `fn` over `items` with at most `limit` in flight. Keeps us polite to the source servers. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const item = items[i];
      if (i >= items.length || item === undefined) return;
      results[i] = await fn(item, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
