import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  GATEWAYS,
  LARGE_OBJECT_GATEWAYS,
  OTHER_GATEWAYS,
  REQUIRED_INDEPENDENT,
  budgetFor,
  checkGateway,
  gatewayUrl,
  kindOf,
  summarize,
  verdict,
  type GatewayCheck,
} from './verify';

const digest = async (bytes: Uint8Array): Promise<string> =>
  Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');

const BODY = new TextEncoder().encode('{"county":"San Diego County, CA"}');
const URL_1 = 'https://gw.test/ipfs/bafyroot/coverage.json';

async function expectedFor(bytes: Uint8Array) {
  return { size: bytes.length, sha256: await digest(bytes) };
}

describe('gatewayUrl', () => {
  it('derives the URL from the root CID and the logical name', () => {
    expect(gatewayUrl('https://4everland.io', 'bafyroot', 'samples/aged roofs.csv')).toBe(
      'https://4everland.io/ipfs/bafyroot/samples/aged%20roofs.csv',
    );
    expect(gatewayUrl('https://ipfs.io', 'bafyroot')).toBe('https://ipfs.io/ipfs/bafyroot/');
  });
});

describe('checkGateway', () => {
  it('reports a match when size and SHA-256 equal the manifest', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(BODY));
    const check = await checkGateway('gw.test', URL_1, await expectedFor(BODY), {
      fetchImpl,
      digest,
    });
    expect(check).toMatchObject({
      outcome: 'match',
      httpStatus: 200,
      bytes: BODY.length,
      sizeMatches: true,
      digestMatches: true,
    });
  });

  it('reports a mismatch when the gateway returns different bytes', async () => {
    const other = new TextEncoder().encode('tampered');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(other));
    const check = await checkGateway('gw.test', URL_1, await expectedFor(BODY), {
      fetchImpl,
      digest,
    });
    expect(check).toMatchObject({ outcome: 'mismatch', sizeMatches: false, digestMatches: false });
    expect(check.detail).toMatch(/do NOT match/);
  });

  it('says "blocked by CORS" when only an opaque no-cors request succeeds', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.mode === 'no-cors') return new Response(null);
      throw new TypeError('Failed to fetch');
    });
    const check = await checkGateway('gw.test', URL_1, await expectedFor(BODY), {
      fetchImpl,
      digest,
    });
    expect(check.outcome).toBe('cors_blocked');
    expect(check.detail).toMatch(/Blocked by CORS/);
    expect(check.bytes).toBeNull();
    expect(check.digestMatches).toBeNull();
  });

  it('says "network failure" when the gateway cannot be reached at all', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'));
    const check = await checkGateway('gw.test', URL_1, await expectedFor(BODY), {
      fetchImpl,
      digest,
    });
    expect(check.outcome).toBe('network_error');
  });

  it('shows the real status of a gateway that refuses scripts (HTTP 429)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('no', { status: 429 }));
    const check = await checkGateway('ipfs.io', URL_1, await expectedFor(BODY), {
      fetchImpl,
      digest,
    });
    expect(check).toMatchObject({ outcome: 'http_error', httpStatus: 429 });
  });

  it('reports "resolved" when there is no digest to compare with', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(BODY));
    const check = await checkGateway(
      'gw.test',
      URL_1,
      { size: null, sha256: null },
      { fetchImpl, digest },
    );
    expect(check).toMatchObject({ outcome: 'resolved', digestMatches: null, bytes: BODY.length });
  });
});

describe('time budget', () => {
  it('gives small objects 12 seconds and only large ones minutes', () => {
    expect(budgetFor(3252)).toEqual({ headerTimeoutMs: 12_000, timeoutMs: 12_000 });
    expect(budgetFor(null).timeoutMs).toBe(12_000);
    expect(budgetFor(10 * 1024 * 1024).headerTimeoutMs).toBe(12_000);
    expect(budgetFor(128 * 1024 * 1024).timeoutMs).toBeGreaterThan(60_000);
  });

  it('reports "no answer" when a gateway hangs past its budget', async () => {
    const hanging = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const check = await checkGateway('4everland.io', URL_1, await expectedFor(BODY), {
      fetchImpl: hanging,
      digest,
      headerTimeoutMs: 30,
      timeoutMs: 30,
    });
    expect(check.outcome).toBe('timeout');
    expect(check.detail).toBe('No answer in 0 s.');
    expect(check.bytes).toBeNull();
  });
});

describe('summarize and verdict', () => {
  const check = (gateway: string, outcome: GatewayCheck['outcome']): GatewayCheck => ({
    gateway,
    url: 'u',
    outcome,
    httpStatus: null,
    bytes: null,
    sha256: null,
    sizeMatches: null,
    digestMatches: null,
    ms: 1,
    detail: '',
  });

  it('lists the gateways by kind, independent first', () => {
    expect(GATEWAYS.map((g) => `${g.id}:${g.kind}`)).toEqual([
      'latam.orbitor.dev:independent',
      'gateway.pinit.io:independent',
      'ipfs.aleph.cloud:independent',
      'ipfs.thegraph.com:independent',
      'ipfs.hypha.coop:independent',
      'gateway.pinata.cloud:vendor',
      'ipfs.filebase.io:vendor',
      'ipfs.raribleuserdata.com:vendor',
    ]);
    // The five that do not serve this content to scripts are listed, never fetched.
    expect(OTHER_GATEWAYS.map((g) => g.id)).toEqual([
      '4everland.io',
      'storry.tv',
      'ipfs.io',
      'dweb.link',
      'w3s.link',
    ]);
    expect(
      GATEWAYS.map((g) => g.id).filter((id) => OTHER_GATEWAYS.some((o) => o.id === id)),
    ).toEqual([]);
  });

  it('classes the Filebase-hosted Rarible gateway as a pinning vendor', () => {
    expect(kindOf('ipfs.raribleuserdata.com')).toBe('vendor');
    expect(kindOf('gateway.pinata.cloud')).toBe('vendor');
    expect(kindOf('ipfs.filebase.io')).toBe('vendor');
    expect(kindOf('gateway.pinit.io')).toBe('independent');
  });

  it('sends large objects to three independent gateways and the two vendors’ own', () => {
    expect(LARGE_OBJECT_GATEWAYS.map((g) => `${g.id}:${g.kind}`)).toEqual([
      'latam.orbitor.dev:independent',
      'gateway.pinit.io:independent',
      'ipfs.aleph.cloud:independent',
      'gateway.pinata.cloud:vendor',
      'ipfs.filebase.io:vendor',
    ]);
  });

  it('shows vendor matches as evidence but does not count them towards the bar', () => {
    const checks = [
      check('latam.orbitor.dev', 'match'),
      check('gateway.pinit.io', 'cors_blocked'),
      check('ipfs.aleph.cloud', 'http_error'),
      check('gateway.pinata.cloud', 'match'),
      check('ipfs.filebase.io', 'match'),
      check('ipfs.thegraph.com', 'network_error'),
      check('ipfs.hypha.coop', 'network_error'),
    ];
    expect(summarize(checks)).toEqual({
      matched: 3,
      independent: 1,
      vendor: 2,
      browser: 0,
      attempted: 7,
      verified: false,
    });
    expect(verdict(checks)).toBe(
      'Not verified: bytes match the manifest on only 3 of 7 gateways tried (1 independent, 2 pinning-vendor); 2 independent gateways are required.',
    );
  });

  it('is verified once two independent gateways match, and says which kind matched', () => {
    expect(REQUIRED_INDEPENDENT).toBe(2);
    const checks = [
      check('latam.orbitor.dev', 'match'),
      check('gateway.pinit.io', 'match'),
      check('ipfs.aleph.cloud', 'http_error'),
      check('gateway.pinata.cloud', 'match'),
      check('ipfs.filebase.io', 'match'),
      check('ipfs.thegraph.com', 'network_error'),
      check('ipfs.hypha.coop', 'network_error'),
    ];
    expect(summarize(checks)).toEqual({
      matched: 4,
      independent: 2,
      vendor: 2,
      browser: 0,
      attempted: 7,
      verified: true,
    });
    expect(verdict(checks)).toBe(
      'Verified: bytes match the manifest on 4 public gateways (2 independent, 2 pinning-vendor).',
    );
  });

  it('does not verify on vendor gateways alone, however many match', () => {
    const checks = [
      check('gateway.pinata.cloud', 'match'),
      check('ipfs.filebase.io', 'match'),
      check('ipfs.raribleuserdata.com', 'match'),
    ];
    expect(summarize(checks)).toEqual({
      matched: 3,
      independent: 0,
      vendor: 3,
      browser: 0,
      attempted: 3,
      verified: false,
    });
    expect(verdict(checks)).toBe(
      'Not verified: bytes match the manifest on only 3 of 3 gateways tried (0 independent, 3 pinning-vendor); 2 independent gateways are required.',
    );
  });

  it('reads 8 public gateways when all five independent and all three vendor gateways match', () => {
    const checks = GATEWAYS.map((g) => check(g.id, 'match'));
    expect(verdict(checks)).toBe(
      'Verified: bytes match the manifest on 8 public gateways (5 independent, 3 pinning-vendor).',
    );
  });

  it('needs two matching independent gateways and never counts a failure', () => {
    const checks = [check('latam.orbitor.dev', 'match'), check('ipfs.hypha.coop', 'http_error')];
    expect(summarize(checks).verified).toBe(false);
    expect(verdict(checks)).toBe(
      'Not verified: bytes match the manifest on only 1 of 2 gateways tried (1 independent, 0 pinning-vendor); 2 independent gateways are required.',
    );
  });

  it('counts "resolved" only when no digest is expected, and still needs two independent', () => {
    const mixed = [check('latam.orbitor.dev', 'resolved'), check('ipfs.filebase.io', 'resolved')];
    expect(summarize(mixed).verified).toBe(false);
    expect(summarize(mixed, false).verified).toBe(false);
    expect(verdict(mixed, false)).toBe(
      'Resolves on only 2 of 2 gateways tried (1 independent, 1 pinning-vendor); 2 independent gateways are required.',
    );

    const checks = [...mixed, check('gateway.pinit.io', 'resolved')];
    expect(summarize(checks).verified).toBe(false);
    expect(summarize(checks, false).verified).toBe(true);
    expect(verdict(checks, false)).toBe(
      'Resolves on 3 public gateways (2 independent, 1 pinning-vendor); no recorded digest to compare with.',
    );
  });
});
