import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { errorMessage } from '../log.js';
import { DEFAULT_GATEWAYS, GATEWAYS, verifyArtifact, type VerifyReport } from './gatewayVerify.js';

const manifestSchema = z.object({
  runId: z.number(),
  rootCid: z.string(),
  objects: z.array(
    z.object({
      name: z.string(),
      cid: z.string(),
      size: z.number(),
      codec: z.enum(['file', 'directory']),
      sha256: z.string().nullable(),
    }),
  ),
});

const indexSchema = z.object({
  countySlug: z.string(),
  runs: z.array(
    z
      .object({
        rootCid: z.string(),
        verifiedGateways: z.number(),
        verifiedIndependentGateways: z.number().optional(),
      })
      .loose(),
  ),
});

/**
 * `npm run verify:ipfs -- --manifest publications/san-diego/run-0003/manifest.json`
 * Fetches every object named in a manifest from public gateways we do not operate and compares
 * size and SHA-256 with the manifest. Needs no credentials: anyone holding the manifest can run it.
 * An object passes when two independent gateways return matching bytes; pinning-vendor gateways are
 * fetched and reported too, but do not count. `--dry-run` checks without writing any file.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      manifest: { type: 'string' },
      'max-bytes': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (!values.manifest) throw new Error('usage: npm run verify:ipfs -- --manifest <path to manifest.json>');
  const manifest = manifestSchema.parse(JSON.parse(await readFile(values.manifest, 'utf8')));
  const maxBytes = values['max-bytes'] === undefined ? Number.POSITIVE_INFINITY : Number(values['max-bytes']);

  const results: VerifyReport[] = [];
  for (const object of manifest.objects) {
    if (object.codec !== 'file' || object.sha256 === null || object.size > maxBytes) continue;
    const report = await verifyArtifact(
      {
        cid: object.cid,
        size: object.size,
        sha256: object.sha256,
        path: `${manifest.rootCid}/${object.name}`,
      },
      DEFAULT_GATEWAYS,
    );
    results.push(report);
    const hosts = (kind: string): string =>
      report.checks
        .filter((c) => c.ok && c.kind === kind)
        .map((c) => new URL(c.gateway).host)
        .join(', ');
    process.stdout.write(
      `${report.verified ? 'ok  ' : 'FAIL'} ${object.name} (${object.size} bytes): ` +
        `${report.independentPassed} independent [${hosts('independent')}], ` +
        `${report.vendorPassed} pinning-vendor [${hosts('pinning-vendor')}]\n`,
    );
  }

  const dir = path.dirname(values.manifest);
  const checkedAt = new Date().toISOString();
  const fewest = (pick: (r: VerifyReport) => number): number =>
    results.length === 0 ? 0 : Math.min(...results.map(pick));
  if (!values['dry-run']) {
    await writeFile(
      path.join(dir, 'verification.json'),
      `${JSON.stringify({ checkedAt, rootCid: manifest.rootCid, gateways: GATEWAYS, results }, null, 2)}\n`,
    );

    const indexFile = path.join(path.dirname(dir), 'index.json');
    try {
      const index = indexSchema.parse(JSON.parse(await readFile(indexFile, 'utf8')));
      for (const run of index.runs) {
        if (run.rootCid !== manifest.rootCid) continue;
        run.verifiedGateways = fewest((r) => r.passed);
        run.verifiedIndependentGateways = fewest((r) => r.independentPassed);
      }
      await writeFile(indexFile, `${JSON.stringify(index, null, 2)}\n`);
    } catch {
      // No run index next to this manifest: verification still stands on its own.
    }
  }

  const verified = results.filter((r) => r.verified).length;
  process.stdout.write(
    `${verified}/${results.length} objects verified on 2+ independent public gateways at ${checkedAt} ` +
      `(fewest per object: ${fewest((r) => r.independentPassed)} independent, ${fewest((r) => r.vendorPassed)} pinning-vendor)` +
      `${values['dry-run'] ? '; dry run, nothing written' : ''}\n`,
  );
  if (verified !== results.length) process.exitCode = 1;
}

main().catch((e: unknown) => {
  process.stderr.write(`${errorMessage(e)}\n`);
  process.exitCode = 2;
});
