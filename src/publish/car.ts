import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import * as UnixFS from '@ipld/unixfs';
import { withMaxChunkSize } from '@ipld/unixfs/file/chunker/fixed';
import { withWidth } from '@ipld/unixfs/file/layout/balanced';
import { CAREncoderStream, createDirectoryEncoderStream, createFileEncoderStream } from 'ipfs-car';
import * as raw from 'multiformats/codecs/raw';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';

const DAG_PB = 0x70;

/**
 * Kubo's defaults for CIDv1 (`ipfs add --cid-version=1`): 256 KiB chunks, raw leaves, balanced
 * layout 174 links wide. Using the reference settings means a plain upload of the same file to
 * any Kubo-compatible pinning service yields the same CID as the one in our CAR.
 */
export const ENCODER_SETTINGS = UnixFS.configure({
  fileChunkEncoder: raw,
  smallFileEncoder: raw,
  chunker: withMaxChunkSize(262144),
  fileLayout: withWidth(174),
});

export interface ArtifactFile {
  /** Logical name inside the published directory, e.g. `query-table.parquet`. */
  name: string;
  /** Local path of the bytes to publish. */
  path: string;
}

export interface PackedFile {
  name: string;
  cid: string;
  size: number;
  sha256: string;
  codec: 'file';
}

export interface PackedDirectory {
  rootCid: string;
  files: PackedFile[];
  car: { path: string; size: number; sha256: string };
}

interface BlobLike {
  stream: () => ReadableStream<Uint8Array>;
}

function fileBlob(path: string): BlobLike {
  return { stream: () => Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array> };
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** CID a file gets on its own. Same encoder settings as the directory, so the CIDs agree. */
async function fileCid(path: string): Promise<string> {
  // Held in an object so the type checker sees the assignment made inside the stream callback.
  const seen: { last: string | null } = { last: null };
  await createFileEncoderStream(fileBlob(path), ENCODER_SETTINGS).pipeTo(
    new WritableStream({
      write(block) {
        seen.last = block.cid.toString();
      },
    }),
  );
  if (seen.last === null) throw new Error(`No blocks produced for ${path}`);
  return seen.last;
}

/**
 * Packs the run's artifacts into one UnixFS directory and writes its CAR.
 * The CAR built here is the source of truth: any IPFS node or pinning service that imports it
 * gets exactly these CIDs, so identity never depends on a vendor computing a hash for us.
 */
export async function packDirectory(files: ArtifactFile[], carPath: string): Promise<PackedDirectory> {
  if (files.length === 0) throw new Error('Nothing to publish');
  const names = new Set(files.map((f) => f.name));
  if (names.size !== files.length) throw new Error('Duplicate artifact names');

  const packed: PackedFile[] = [];
  for (const file of files) {
    const info = await stat(file.path);
    packed.push({
      name: file.name,
      cid: await fileCid(file.path),
      size: info.size,
      sha256: await sha256File(file.path),
      codec: 'file',
    });
  }

  const entries = files.map((f) => ({ name: f.name, stream: fileBlob(f.path).stream }));
  // Same codec and hash as the real root, so the header keeps its byte length when rewritten.
  const placeholder = CID.createV1(DAG_PB, await sha256.digest(new Uint8Array()));
  const encoder = new CAREncoderStream([placeholder]);
  await createDirectoryEncoderStream(entries, ENCODER_SETTINGS)
    .pipeThrough(encoder)
    .pipeTo(Writable.toWeb(createWriteStream(carPath)) as WritableStream<Uint8Array>);

  const rootText = encoder.finalBlock?.cid.toString();
  if (!rootText) throw new Error('CAR encoder produced no root block');
  const root = CID.parse(rootText);
  await writeCarRoot(carPath, root);

  const carInfo = await stat(carPath);
  return {
    rootCid: root.toString(),
    files: packed,
    car: { path: carPath, size: carInfo.size, sha256: await sha256File(carPath) },
  };
}

/**
 * A streamed CAR is written before its root is known, so the header holds a placeholder of the
 * same byte length. Overwrite it in place with the real root (the documented ipfs-car pattern).
 */
async function writeCarRoot(carPath: string, root: CID): Promise<void> {
  const { CarWriter } = await import('@ipld/car/writer');
  const handle = await open(carPath, 'r+');
  try {
    await CarWriter.updateRootsInFile(handle, [root]);
  } finally {
    await handle.close();
  }
}
