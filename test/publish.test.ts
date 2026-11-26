import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GATEWAYS, gatewayKind, verifyArtifact } from '../src/publish/gatewayVerify.js';
import { manifestIpns } from '../src/publish/publishRun.js';

const BODY = 'the bytes of a published object';
const expected = {
  cid: 'bafkreitest',
  size: Buffer.byteLength(BODY),
  sha256: createHash('sha256').update(BODY).digest('hex'),
  path: 'bafyroot/coverage.json',
};

/** A fetch that serves the object from the named hosts and answers 429 everywhere else. */
function servedBy(hosts: readonly string[]): typeof fetch {
  // eslint-disable-next-line @typescript-eslint/require-await -- fetch is async by contract
  return async (input) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    return hosts.includes(new URL(url).host)
      ? new Response(BODY)
      : new Response('slow down', { status: 429 });
  };
}

describe('gateway kinds', () => {
  it('classes a third-party gateway hosted by a pinning vendor with the vendor', () => {
    expect(gatewayKind('https://ipfs.raribleuserdata.com')).toBe('pinning-vendor');
    expect(gatewayKind('https://ipfs.filebase.io')).toBe('pinning-vendor');
    expect(gatewayKind('https://gateway.pinata.cloud')).toBe('pinning-vendor');
    expect(gatewayKind('https://latam.orbitor.dev')).toBe('independent');
    expect(gatewayKind('https://ipfs.io')).toBe('unavailable');
  });

  it('lists at least four independent gateways and names an operator for every entry', () => {
    expect(GATEWAYS.filter((g) => g.kind === 'independent').length).toBeGreaterThanOrEqual(4);
    expect(GATEWAYS.every((g) => g.url.startsWith('https://') && g.operator.length > 0)).toBe(true);
    expect(new Set(GATEWAYS.map((g) => g.url)).size).toBe(GATEWAYS.length);
  });
});

describe('verifyArtifact', () => {
  const gateways = [
    'https://latam.orbitor.dev',
    'https://gateway.pinit.io',
    'https://gateway.pinata.cloud',
    'https://ipfs.filebase.io',
    'https://ipfs.raribleuserdata.com',
    'https://ipfs.io',
  ];

  it('does not count pinning-vendor gateways towards the two independent fetches', async () => {
    const report = await verifyArtifact(
      expected,
      gateways,
      2,
      servedBy(['latam.orbitor.dev', 'gateway.pinata.cloud', 'ipfs.filebase.io', 'ipfs.raribleuserdata.com']),
    );
    expect(report).toMatchObject({ passed: 4, independentPassed: 1, vendorPassed: 3, verified: false });
  });

  it('verifies on two independent gateways and records every gateway as it really answered', async () => {
    const report = await verifyArtifact(
      expected,
      gateways,
      2,
      servedBy(['latam.orbitor.dev', 'gateway.pinit.io']),
    );
    expect(report).toMatchObject({ passed: 2, independentPassed: 2, vendorPassed: 0, verified: true });
    expect(report.checks.map((c) => [new URL(c.gateway).host, c.kind, c.status, c.ok])).toEqual([
      ['latam.orbitor.dev', 'independent', 200, true],
      ['gateway.pinit.io', 'independent', 200, true],
      ['gateway.pinata.cloud', 'pinning-vendor', 429, false],
      ['ipfs.filebase.io', 'pinning-vendor', 429, false],
      ['ipfs.raribleuserdata.com', 'pinning-vendor', 429, false],
      ['ipfs.io', 'unavailable', 429, false],
    ]);
  });

  it('rejects bytes that differ from the manifest digest', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- fetch is async by contract
    const wrong: typeof fetch = async () => new Response('other bytes of the very same length');
    const report = await verifyArtifact(expected, ['https://latam.orbitor.dev'], 1, wrong);
    expect(report.verified).toBe(false);
    expect(report.checks[0]?.reason).toBe('bytes do not match the manifest size/digest');
  });
});

describe('manifestIpns', () => {
  const record = {
    name: 'k51example',
    label: 'oracle-query-table-san-diego',
    resolvedCid: 'bafynew',
    sequence: 2,
    updatedAt: '2026-11-26T16:00:00.000Z',
  };

  it('records the name and the root it was moved to', () => {
    const ipns = manifestIpns(record, { ...record, resolvedCid: 'bafyold', sequence: 1 }, 'bafynew');
    expect(ipns).toMatchObject({ name: 'k51example', resolvedCid: 'bafynew', sequence: 2 });
    expect(ipns?.note).toMatch(/^Moved to the root of this run/);
  });

  it('still records the name when the move failed, and says it was not moved', () => {
    const ipns = manifestIpns(null, { ...record, resolvedCid: 'bafyold', sequence: 1 }, 'bafynew');
    expect(ipns).toMatchObject({ name: 'k51example', resolvedCid: 'bafyold', sequence: 1 });
    expect(ipns?.note).toMatch(/^NOT moved to the root of this run/);
  });

  it('is null only when no name has ever been used', () => {
    expect(manifestIpns(null, undefined, 'bafynew')).toBeNull();
    expect(manifestIpns(null, null, 'bafynew')).toBeNull();
  });
});
