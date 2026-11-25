import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import type { Db } from '../db.js';
import { packDirectory, sha256File } from './car.js';
import { COUNTY_SLUG, exportArtifacts } from './exportArtifacts.js';
import { DEFAULT_GATEWAYS, verifyArtifact, type VerifyReport } from './gatewayVerify.js';
import type { FilebaseNames, IpnsRecord, PinResult, Pinner } from './pin.js';

export const MANIFEST_SCHEMA = 'oracle-artifact-manifest/1';

export interface ManifestObject {
  name: string;
  cid: string;
  size: number;
  codec: 'file' | 'directory';
  sha256: string | null;
}

export interface Manifest {
  schema: typeof MANIFEST_SCHEMA;
  county: string;
  countySlug: string;
  runId: number;
  createdAt: string;
  /** Root of the run's directory DAG. This CID is the snapshot; URLs are only locators. */
  rootCid: string;
  /** Root of the previous published run, so the history is a verifiable chain. */
  previousRootCid: string | null;
  objects: ManifestObject[];
  car: { name: string; size: number; sha256: string; rootCid: string };
  /** IPNS pointer as it stood for this run: the name and the CID it resolved to. */
  ipns: IpnsRecord | null;
  origins: string[];
  pins: PinResult[];
  gatewayPattern: string;
}

const ipnsSchema = z.object({
  name: z.string(),
  label: z.string(),
  resolvedCid: z.string(),
  sequence: z.number(),
  updatedAt: z.string(),
});

const indexSchema = z.object({
  countySlug: z.string(),
  /** Current IPNS pointer. A pointer only: each run below keeps its own immutable root CID. */
  ipns: ipnsSchema.nullish(),
  runs: z.array(
    z.object({
      runId: z.number(),
      createdAt: z.string(),
      rootCid: z.string(),
      manifestCid: z.string().nullable(),
      previousRootCid: z.string().nullable(),
      objects: z.number(),
      bytes: z.number(),
      verifiedGateways: z.number(),
      /** The run's CAR as its own IPFS object: fetch by CID, check the digest, import anywhere. */
      car: z
        .object({ name: z.string(), cid: z.string().nullable(), size: z.number(), sha256: z.string() })
        .optional(),
    }),
  ),
});
export type PublicationIndex = z.infer<typeof indexSchema>;

export interface FilePinner {
  readonly provider: string;
  /** Uploads one plain file and returns the CID the service assigned. */
  pinFile(filePath: string, name: string): Promise<string | null>;
}

export interface PublishOptions {
  db: Db;
  /** Working folder for exported artifacts (git-ignored). */
  publishRoot: string;
  /** Folder inside the repo where manifests and the run index are kept. */
  repoPublications: string;
  carPinners: Pinner[];
  filePinners: FilePinner[];
  /** Optional: also publish the CAR file itself as a plain IPFS object and record its CID. */
  carStore?: { publishFile(filePath: string, key: string): Promise<string | null> };
  /** Optional IPNS name to move to each new root. */
  names?: FilebaseNames;
  gateways?: readonly string[];
  /** Wait between verification rounds; fresh content takes time to reach public gateways. */
  verifyAttempts?: number;
  verifyWaitMs?: number;
  /** Mirror bucket for the serving function; the run lands under `<prefixRoot>/<run folder>`. */
  mirror?: { bucket: string; prefixRoot: string; s3?: S3Client };
  now: () => Date;
  log: (message: string) => void;
}

export interface PublishResult {
  manifest: Manifest;
  manifestCid: string | null;
  verification: VerifyReport[];
  dir: string;
}

async function readIndex(file: string): Promise<PublicationIndex> {
  try {
    return indexSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return { countySlug: COUNTY_SLUG, runs: [] };
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Publishes one pipeline run as an immutable, content-addressed snapshot:
 * export -> gate -> CAR (CIDs computed here, not by a vendor) -> pin at each service and compare
 * the CID it reports -> manifest -> fetch back from independent public gateways and compare
 * size and SHA-256 -> record in the run index. A later run never touches an earlier CID.
 */
export async function publishRun(options: PublishOptions): Promise<PublishResult> {
  const { db, log } = options;
  const createdAt = options.now().toISOString();

  const exported = await exportArtifacts(db, options.publishRoot, createdAt);
  log(`exported run ${exported.runId}: ${exported.artifacts.length} objects`);

  const carName = `run-${String(exported.runId).padStart(4, '0')}.car`;
  const carPath = path.join(path.dirname(exported.dir), carName);
  const packed = await packDirectory(exported.artifacts, carPath);
  log(`packed CAR ${carName}: root ${packed.rootCid}, ${packed.car.size} bytes`);

  const indexFile = path.join(options.repoPublications, COUNTY_SLUG, 'index.json');
  const index = await readIndex(indexFile);
  const previous = index.runs.filter((r) => r.rootCid !== packed.rootCid).at(-1) ?? null;

  const pins: PinResult[] = [];
  const label = `${COUNTY_SLUG}/run-${String(exported.runId).padStart(4, '0')}-${packed.rootCid.slice(-8)}`;
  for (const pinner of options.carPinners) {
    const result = await pinner.pinCar(carPath, packed.rootCid, label);
    pins.push(result);
    log(`pin ${result.provider} (directory CAR): ${result.ok ? 'ok' : 'FAILED'} ${result.detail}`);
  }
  for (const pinner of options.filePinners) {
    let matched = 0;
    const mismatches: string[] = [];
    for (const file of packed.files) {
      const source = exported.artifacts.find((a) => a.name === file.name);
      if (!source) continue;
      const cid = await pinner.pinFile(source.path, file.name);
      if (cid === file.cid) matched += 1;
      else mismatches.push(`${file.name}: ${cid ?? 'upload failed'}`);
    }
    const ok = mismatches.length === 0;
    pins.push({
      provider: pinner.provider,
      cid: null,
      ok,
      detail: ok
        ? `pinned ${matched} files individually; every CID equals the manifest`
        : `${matched} of ${packed.files.length} files match; ${mismatches.join('; ')}`,
    });
    log(`pin ${pinner.provider} (files): ${ok ? 'ok' : 'FAILED'} ${matched}/${packed.files.length}`);
  }

  // Move the IPNS name only when the directory is pinned somewhere; otherwise it would point at
  // content nobody serves.
  const ipns =
    options.names && pins.some((p) => p.ok && p.cid === packed.rootCid)
      ? await options.names.point(packed.rootCid, options.now)
      : null;
  if (options.names) log(`ipns ${ipns ? `${ipns.name} -> ${ipns.resolvedCid}` : 'not updated'}`);

  const totalBytes = packed.files.reduce((sum, f) => sum + f.size, 0);
  const manifest: Manifest = {
    schema: MANIFEST_SCHEMA,
    county: exported.coverage.county,
    countySlug: COUNTY_SLUG,
    runId: exported.runId,
    createdAt,
    rootCid: packed.rootCid,
    previousRootCid: previous?.rootCid ?? null,
    objects: [
      { name: '', cid: packed.rootCid, size: totalBytes, codec: 'directory', sha256: null },
      ...packed.files.map((f) => ({ ...f, codec: 'file' as const })),
    ],
    car: { name: carName, size: packed.car.size, sha256: packed.car.sha256, rootCid: packed.rootCid },
    ipns,
    origins: [],
    pins,
    gatewayPattern: 'https://<gateway>/ipfs/<cid>  (directory members: /ipfs/<rootCid>/<name>)',
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = path.join(exported.dir, 'manifest.json');
  await writeFile(manifestPath, manifestText);

  let manifestCid: string | null = null;
  for (const pinner of options.filePinners) {
    manifestCid = (await pinner.pinFile(manifestPath, `manifest-run-${exported.runId}.json`)) ?? manifestCid;
  }

  // Fetch back from gateways we do not operate. The two largest objects and two small ones are
  // checked by full digest; every object is checked on the final attempt.
  const gateways = options.gateways ?? DEFAULT_GATEWAYS;
  const attempts = options.verifyAttempts ?? 0;
  let verification: VerifyReport[] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    verification = [];
    for (const file of packed.files) {
      verification.push(
        await verifyArtifact(
          { cid: file.cid, size: file.size, sha256: file.sha256, path: `${packed.rootCid}/${file.name}` },
          gateways,
        ),
      );
    }
    const done = verification.filter((v) => v.verified).length;
    log(`gateway verification attempt ${attempt}: ${done}/${verification.length} objects on 2+ gateways`);
    if (done === verification.length) break;
    if (attempt < attempts) await sleep(options.verifyWaitMs ?? 60_000);
  }

  const repoRunDir = path.join(options.repoPublications, COUNTY_SLUG, path.basename(exported.dir));
  await mkdir(repoRunDir, { recursive: true });
  await writeFile(path.join(repoRunDir, 'manifest.json'), manifestText);
  // A record is written only when verification actually ran; `npm run verify:ipfs` writes it otherwise.
  if (verification.length > 0) {
    await writeFile(
      path.join(repoRunDir, 'verification.json'),
      `${JSON.stringify({ checkedAt: options.now().toISOString(), gateways, results: verification }, null, 2)}\n`,
    );
  }
  for (const small of ['coverage.json', 'run-history.json', 'sources.json']) {
    await writeFile(path.join(repoRunDir, small), await readFile(path.join(exported.dir, small)));
  }

  const carCid = options.carStore
    ? await options.carStore.publishFile(carPath, `cars/${COUNTY_SLUG}-${carName}`)
    : null;
  if (options.carStore) log(`CAR object ${carCid ?? 'not published'}`);

  const entry = {
    runId: exported.runId,
    createdAt,
    rootCid: packed.rootCid,
    manifestCid,
    previousRootCid: previous?.rootCid ?? null,
    objects: packed.files.length,
    bytes: totalBytes,
    verifiedGateways: verification.length === 0 ? 0 : Math.min(...verification.map((v) => v.passed)),
    car: { name: carName, cid: carCid, size: packed.car.size, sha256: packed.car.sha256 },
  };
  index.runs = [...index.runs.filter((r) => r.rootCid !== packed.rootCid), entry];
  if (ipns) index.ipns = ipns;
  await mkdir(path.dirname(indexFile), { recursive: true });
  await writeFile(indexFile, `${JSON.stringify(index, null, 2)}\n`);
  await writeFile(path.join(exported.dir, 'publications-index.json'), `${JSON.stringify(index, null, 2)}\n`);

  if (options.mirror) {
    const s3 = options.mirror.s3 ?? new S3Client({});
    const prefix = `${options.mirror.prefixRoot}/${path.basename(exported.dir)}`;
    const upload = async (file: string, key: string): Promise<void> => {
      await s3.send(
        new PutObjectCommand({
          Bucket: options.mirror?.bucket,
          Key: key,
          Body: createReadStream(file),
          ContentLength: (await stat(file)).size,
        }),
      );
    };
    const walk = async (dir: string, rel = ''): Promise<void> => {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        const next = rel === '' ? item.name : `${rel}/${item.name}`;
        if (item.isDirectory()) await walk(path.join(dir, item.name), next);
        else await upload(path.join(dir, item.name), `${prefix}/${next}`);
      }
    };
    await walk(exported.dir);
    log(`mirrored run to s3://${options.mirror.bucket}/${prefix}`);
  }

  return { manifest, manifestCid, verification, dir: exported.dir };
}

export { sha256File };
