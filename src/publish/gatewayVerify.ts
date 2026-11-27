import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Public gateways this project does not operate. Each fetch is anonymous: no key, no login.
 *
 *  - `independent`: run by a party this project has no account with, on its own infrastructure.
 *  - `pinning-vendor`: answered by the infrastructure of a service that pins this data. That is
 *    the vendor's own public gateway, and also any third party's gateway that the vendor hosts
 *    (`ipfs.raribleuserdata.com` is a DNS alias of `s3.filebase.com` and answers with
 *    `Server: Filebase`), because such a gateway says nothing about retrieval without the vendor.
 *  - `unavailable`: listed so its real status is recorded; a script cannot count on it. ipfs.io
 *    and dweb.link have answered plain HTTP clients with HTTP 429 since September 2026 (content
 *    only through an in-browser service worker); w3s.link answered 429 as well on 26 Nov 2026,
 *    4everland.io timed out and storry.tv returned HTTP 500.
 *
 * Every `independent` entry returned this project's objects with the manifest digest to a plain
 * script on 26 Nov 2026, including the 30 MB query table. Only `independent` passes count towards
 * the "two independent gateways" requirement; the others are reported next to them.
 */
export type GatewayKind = 'independent' | 'pinning-vendor' | 'unavailable';

export interface GatewayInfo {
  readonly url: string;
  readonly kind: GatewayKind;
  readonly operator: string;
}

export const GATEWAYS: readonly GatewayInfo[] = [
  { url: 'https://latam.orbitor.dev', kind: 'independent', operator: 'Orbitor' },
  { url: 'https://gateway.pinit.io', kind: 'independent', operator: 'Pinit' },
  { url: 'https://ipfs.aleph.cloud', kind: 'independent', operator: 'Aleph Cloud' },
  { url: 'https://ipfs.thegraph.com', kind: 'independent', operator: 'The Graph' },
  { url: 'https://ipfs.unique.network', kind: 'independent', operator: 'Unique Network' },
  { url: 'https://ipfs.euc.li', kind: 'independent', operator: 'euc.li (operator not stated)' },
  { url: 'https://ipfs.hypha.coop', kind: 'independent', operator: 'Hypha Worker Co-operative' },
  { url: 'https://gateway.pinata.cloud', kind: 'pinning-vendor', operator: 'Pinata (pins this data)' },
  { url: 'https://ipfs.filebase.io', kind: 'pinning-vendor', operator: 'Filebase (pins this data)' },
  {
    url: 'https://ipfs.raribleuserdata.com',
    kind: 'pinning-vendor',
    operator: 'Rarible, hosted by Filebase (DNS alias of s3.filebase.com)',
  },
  { url: 'https://4everland.io', kind: 'unavailable', operator: '4EVERLAND' },
  { url: 'https://storry.tv', kind: 'unavailable', operator: 'Storry' },
  { url: 'https://ipfs.io', kind: 'unavailable', operator: 'IPFS project' },
  { url: 'https://dweb.link', kind: 'unavailable', operator: 'IPFS project' },
  { url: 'https://w3s.link', kind: 'unavailable', operator: 'Storacha' },
];

export const DEFAULT_GATEWAYS: readonly string[] = GATEWAYS.map((g) => g.url);

/** A gateway that is not in the list is somebody's own choice and is counted as independent. */
export function gatewayKind(url: string): GatewayKind {
  return GATEWAYS.find((g) => g.url === url)?.kind ?? 'independent';
}

export interface Expected {
  cid: string;
  size: number;
  sha256: string;
  /** Path under a directory root, e.g. `<rootCid>/query-table.parquet`. Defaults to the CID. */
  path?: string;
}

export interface GatewayCheck {
  gateway: string;
  kind: GatewayKind;
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
  const base = { gateway, kind: gatewayKind(gateway), url };
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

const UNAVAILABLE_TIMEOUT_MS = 20_000;

export interface VerifyReport {
  cid: string;
  /** Gateways of any kind that returned bytes matching the manifest. */
  passed: number;
  /** Of those, the independent ones. This is the number the verdict rests on. */
  independentPassed: number;
  vendorPassed: number;
  required: number;
  verified: boolean;
  checks: GatewayCheck[];
}

/**
 * An artifact counts as publicly retrievable when at least `required` independent gateways return
 * matching bytes. A pinning vendor's gateway returning them is recorded but does not count.
 */
export async function verifyArtifact(
  expected: Expected,
  gateways: readonly string[] = DEFAULT_GATEWAYS,
  required = 2,
  fetchImpl: typeof fetch = fetch,
  timeoutMs?: number,
): Promise<VerifyReport> {
  // A gateway already known not to serve scripts gets a short budget: its status is still recorded,
  // but it cannot hold every object up for minutes.
  const budget = (g: string): number | undefined =>
    timeoutMs ?? (gatewayKind(g) === 'unavailable' ? UNAVAILABLE_TIMEOUT_MS : undefined);
  const checks = await Promise.all(gateways.map((g) => checkGateway(g, expected, budget(g), fetchImpl)));
  const matching = checks.filter((c) => c.ok);
  const independentPassed = matching.filter((c) => c.kind === 'independent').length;
  return {
    cid: expected.cid,
    passed: matching.length,
    independentPassed,
    vendorPassed: matching.filter((c) => c.kind === 'pinning-vendor').length,
    required,
    verified: independentPassed >= required,
    checks,
  };
}

/** The run index as this module needs it. Everything else in the file is carried through untouched. */
const verifiedIndexSchema = z
  .object({
    runs: z.array(
      z
        .object({
          rootCid: z.string(),
          verifiedGateways: z.number().optional(),
          verifiedIndependentGateways: z.number().optional(),
        })
        .loose(),
    ),
  })
  .loose();

/**
 * Writes a verification result into the run index: for the run with this root, the fewest
 * gateways (of any kind, and independent) that returned matching bytes for one of its objects.
 * Every other field of the index, the IPNS record included, comes back exactly as it went in.
 */
export function recordVerification(
  indexJson: unknown,
  rootCid: string,
  results: readonly VerifyReport[],
): z.infer<typeof verifiedIndexSchema> {
  const index = verifiedIndexSchema.parse(indexJson);
  const fewest = (pick: (r: VerifyReport) => number): number =>
    results.length === 0 ? 0 : Math.min(...results.map(pick));
  for (const run of index.runs) {
    if (run.rootCid !== rootCid) continue;
    run.verifiedGateways = fewest((r) => r.passed);
    run.verifiedIndependentGateways = fewest((r) => r.independentPassed);
  }
  return index;
}
