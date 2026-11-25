import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { ARTIFACTS } from '../publish/exportArtifacts.js';

/** Objects the serving function needs on local disk. Samples are published but not served. */
export const SERVED_FILES: readonly string[] = [
  ARTIFACTS.queryTable,
  ARTIFACTS.permits,
  ARTIFACTS.contractors,
  ARTIFACTS.businesses,
  ARTIFACTS.places,
  ARTIFACTS.runHistory,
  ARTIFACTS.sources,
  ARTIFACTS.coverage,
];

const manifestSchema = z.object({
  rootCid: z.string(),
  objects: z.array(z.object({ name: z.string(), size: z.number(), sha256: z.string() })),
});

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function download(s3: S3Client, bucket: string, key: string, target: string): Promise<boolean> {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!(out.Body instanceof Readable)) return false;
    await mkdir(path.dirname(target), { recursive: true });
    await pipeline(out.Body, createWriteStream(target));
    return true;
  } catch (e) {
    if (e instanceof Error && (e.name === 'NoSuchKey' || e.name === 'NotFound')) return false;
    throw e;
  }
}

export interface HydrateResult {
  dir: string;
  files: number;
  bytes: number;
  verified: number;
  rootCid: string | null;
  ms: number;
}

/**
 * Copies one published run from the mirror bucket to local disk (cold start only), then checks
 * every file against the run's manifest. The bucket is a cache of content-addressed data, not
 * the source of truth: bytes that do not match the manifest digest are refused, so the function
 * can only ever serve the snapshot the manifest names.
 */
export async function hydrate(
  bucket: string,
  prefix: string,
  dir: string,
  s3: S3Client = new S3Client({}),
): Promise<HydrateResult> {
  const started = Date.now();
  const base = prefix.replace(/\/+$/, '');
  const haveManifest = await download(s3, bucket, `${base}/manifest.json`, path.join(dir, 'manifest.json'));

  let bytes = 0;
  await Promise.all(
    SERVED_FILES.map(async (name) => {
      const target = path.join(dir, ...name.split('/'));
      const ok = await download(s3, bucket, `${base}/${name}`, target);
      if (!ok) throw new Error(`artifact missing from mirror: ${base}/${name}`);
      bytes += (await stat(target)).size;
    }),
  );

  let verified = 0;
  let rootCid: string | null = null;
  if (haveManifest) {
    const { readFile } = await import('node:fs/promises');
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')),
    );
    rootCid = manifest.rootCid;
    const expected = new Map(manifest.objects.map((o) => [o.name, o]));
    for (const name of SERVED_FILES) {
      const want = expected.get(name);
      if (!want) throw new Error(`served file is not in the manifest: ${name}`);
      const digest = await sha256File(path.join(dir, ...name.split('/')));
      if (digest !== want.sha256) {
        throw new Error(`mirror bytes do not match the manifest digest for ${name}; refusing to serve`);
      }
      verified += 1;
    }
  }
  return { dir, files: SERVED_FILES.length, bytes, verified, rootCid, ms: Date.now() - started };
}
