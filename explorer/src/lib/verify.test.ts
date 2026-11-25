import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { checkGateway, gatewayUrl, summarize, type GatewayCheck } from './verify';

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

describe('summarize', () => {
  const check = (outcome: GatewayCheck['outcome']): GatewayCheck => ({
    gateway: 'g',
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

  it('needs two matching gateways', () => {
    expect(summarize([check('match'), check('http_error')]).verified).toBe(false);
    expect(summarize([check('match'), check('match'), check('cors_blocked')])).toEqual({
      matched: 2,
      attempted: 3,
      verified: true,
    });
  });
});
