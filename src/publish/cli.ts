import { parseArgs } from 'node:util';
import { resolvePaths } from '../config.js';
import { Db } from '../db.js';
import { errorMessage } from '../log.js';
import { FilebaseNames, FilebasePinner, PinataFilePinner, type Pinner } from './pin.js';
import { publishRun, type FilePinner } from './publishRun.js';

/**
 * `npm run publish:ipfs` publishes the latest pipeline run. Credentials come from the
 * environment only (FILEBASE_ACCESS_KEY, FILEBASE_SECRET_KEY, FILEBASE_BUCKET, PINATA_JWT);
 * without them the run is still exported, packed and written to a manifest, just not pinned.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string', default: 'data' },
      'mirror-bucket': { type: 'string' },
      'verify-attempts': { type: 'string', default: '0' },
      'verify-wait-seconds': { type: 'string', default: '60' },
    },
  });
  const env = process.env;
  const carPinners: Pinner[] = [];
  const filePinners: FilePinner[] = [];
  if (env['FILEBASE_ACCESS_KEY'] && env['FILEBASE_SECRET_KEY'] && env['FILEBASE_BUCKET']) {
    carPinners.push(
      new FilebasePinner({
        accessKey: env['FILEBASE_ACCESS_KEY'],
        secretKey: env['FILEBASE_SECRET_KEY'],
        bucket: env['FILEBASE_BUCKET'],
      }),
    );
  }
  if (env['PINATA_JWT']) filePinners.push(new PinataFilePinner(env['PINATA_JWT']));

  const paths = resolvePaths(values['data-dir']);
  const db = await Db.open(paths.dbPath);
  try {
    const log = (message: string): void =>
      void process.stdout.write(`${new Date().toISOString()} ${message}\n`);
    const mirrorBucket = values['mirror-bucket'];
    const result = await publishRun({
      db,
      publishRoot: `${values['data-dir']}/artifacts/publish`,
      repoPublications: 'publications',
      carPinners,
      filePinners,
      ...(env['FILEBASE_ACCESS_KEY'] && env['FILEBASE_SECRET_KEY']
        ? {
            names: new FilebaseNames(
              env['FILEBASE_ACCESS_KEY'],
              env['FILEBASE_SECRET_KEY'],
              env['FILEBASE_IPNS_LABEL'] ?? 'oracle-query-table-san-diego',
            ),
          }
        : {}),
      verifyAttempts: Number(values['verify-attempts']),
      verifyWaitMs: Number(values['verify-wait-seconds']) * 1000,
      ...(mirrorBucket ? { mirror: { bucket: mirrorBucket, prefixRoot: 'san-diego' } } : {}),
      now: () => new Date(),
      log,
    });
    log(`root CID ${result.manifest.rootCid}; manifest CID ${result.manifestCid ?? 'not pinned'}`);
    const verified = result.verification.filter((v) => v.verified).length;
    log(`publicly verified on 2+ independent gateways: ${verified}/${result.verification.length} objects`);
    if (result.manifest.pins.some((p) => !p.ok)) process.exitCode = 1;
  } finally {
    db.close();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${errorMessage(e)}\n`);
  process.exitCode = 2;
});
