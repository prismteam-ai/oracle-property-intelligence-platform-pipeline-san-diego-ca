import { createHash } from 'node:crypto';

/**
 * Public gateways this project does not operate. Each fetch is anonymous: no key, no login.
 * `independent` gateways belong to parties we have no account with; `pinning-vendor` gateways are
 * the public gateways of the services that pin the data. ipfs.io and dweb.link stopped answering
 * plain HTTP clients in September 2026 (HTTP 429; they now serve content only through an
 * in-browser service worker), so they are listed to report their real status, and a script cannot
 * count on them.
 */
export const GATEWAYS = [
  { url: 'https://latam.orbitor.dev', kind: 'independent' },
  { url: 'https://ipfs.raribleuserdata.com', kind: 'independent' },
  { url: 'https://ipfs.hypha.coop', kind: 'independent' },
  { url: 'https://gateway.pinata.cloud', kind: 'pinning-vendor' },
  { url: 'https://ipfs.filebase.io', kind: 'pinning-vendor' },
  { url: 'https://4everland.io', kind: 'independent' },
  { url: 'https://storry.tv', kind: 'independent' },
  { url: 'https://ipfs.io', kind: 'independent' },
  { url: 'https://dweb.link', kind: 'independent' },
] as const;

export const DEFAULT_GATEWAYS: readonly string[] = GATEWAYS.map((g) => g.url);

export interface Expected {
  cid: string;
  size: number;
  sha256: string;
  /** Path under a directory root, e.g. `<rootCid>/query-table.parquet`. Defaults to the CID. */
  path?: string;
}

export interface GatewayCheck {
  gateway: string;
  url: string;
  status: number | null;
  ok: boolean;
  size: number | null;
  sha256: string | null;
  ms: number;
  reason: string | null;
}

export async function checkGateway(
  gateway: string,
  expected: Expected,
  timeoutMs = 180_000,
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayCheck> {
  const url = `${gateway}/ipfs/${expected.path ?? expected.cid}`;
  const started = Date.now();
  const base = { gateway, url };
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: '*/*' },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return {
        ...base,
        status: response.status,
        ok: false,
        size: null,
        sha256: null,
        ms: Date.now() - started,
        reason: `HTTP ${response.status}`,
      };
    }
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      size += chunk.byteLength;
    }
    const sha256 = hash.digest('hex');
    const ok = size === expected.size && sha256 === expected.sha256;
    return {
      ...base,
      status: response.status,
      ok,
      size,
      sha256,
      ms: Date.now() - started,
      reason: ok ? null : 'bytes do not match the manifest size/digest',
    };
  } catch (error) {
    return {
      ...base,
      status: null,
      ok: false,
      size: null,
      sha256: null,
      ms: Date.now() - started,
      reason: error instanceof Error ? error.message : 'fetch failed',
    };
  }
}

export interface VerifyReport {
  cid: string;
  passed: number;
  required: number;
  verified: boolean;
  checks: GatewayCheck[];
}

/** An artifact counts as publicly retrievable when at least `required` gateways return matching bytes. */
export async function verifyArtifact(
  expected: Expected,
  gateways: readonly string[] = DEFAULT_GATEWAYS,
  required = 2,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyReport> {
  const checks = await Promise.all(gateways.map((g) => checkGateway(g, expected, undefined, fetchImpl)));
  const passed = checks.filter((c) => c.ok).length;
  return { cid: expected.cid, passed, required, verified: passed >= required, checks };
}
