import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { CID } from 'multiformats/cid';
import { z } from 'zod';

export interface PinResult {
  provider: string;
  cid: string | null;
  ok: boolean;
  detail: string;
}

/**
 * A pinning service behind one interface: give it a CAR whose root we already know, get back the
 * CID the service says it now holds. The caller compares the two. Swapping or adding a vendor is
 * a new implementation of this interface and nothing else.
 */
export interface Pinner {
  readonly provider: string;
  pinCar(carPath: string, expectedRoot: string, label: string): Promise<PinResult>;
}

export interface FilebaseConfig {
  accessKey: string;
  secretKey: string;
  bucket: string;
}

/** Filebase: S3-compatible API; a PUT with `import: car` metadata imports the DAG as-is. */
export class FilebasePinner implements Pinner {
  readonly provider = 'filebase';
  private readonly s3: S3Client;

  constructor(private readonly config: FilebaseConfig) {
    this.s3 = new S3Client({
      endpoint: 'https://s3.filebase.com',
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    });
  }

  private async ensureBucket(): Promise<void> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.config.bucket }));
    }
  }

  /**
   * Stores the CAR file itself as an ordinary IPFS object (no import), so the archive of a run
   * can be fetched by CID from any gateway and imported into any node. Returns its CIDv1.
   */
  async publishFile(filePath: string, key: string): Promise<string | null> {
    try {
      await this.ensureBucket();
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: createReadStream(filePath),
          ContentLength: (await stat(filePath)).size,
          ContentType: 'application/vnd.ipld.car',
        }),
      );
      const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
      const cid = head.Metadata?.['cid'];
      return cid ? CID.parse(cid).toV1().toString() : null;
    } catch {
      return null;
    }
  }

  async pinCar(carPath: string, expectedRoot: string, label: string): Promise<PinResult> {
    try {
      await this.ensureBucket();
      const size = (await stat(carPath)).size;
      const key = `${label}.car`;
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: createReadStream(carPath),
          ContentLength: size,
          ContentType: 'application/vnd.ipld.car',
          Metadata: { import: 'car' },
        }),
      );
      const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
      const cid = head.Metadata?.['cid'] ?? null;
      const ok = cid === expectedRoot;
      return {
        provider: this.provider,
        cid,
        ok,
        detail: ok
          ? `imported CAR as ${key} in bucket ${this.config.bucket}`
          : `service reported ${cid ?? 'no CID'}, expected ${expectedRoot}`,
      };
    } catch (e) {
      return {
        provider: this.provider,
        cid: null,
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

const pinataResponse = z.object({ data: z.object({ cid: z.string() }) });

/** Plain file upload to Pinata. With reference chunking on our side, its CID equals ours. */
export class PinataFilePinner {
  readonly provider = 'pinata';

  constructor(private readonly jwt: string) {}

  async pinFile(filePath: string, name: string): Promise<string | null> {
    const form = new FormData();
    form.append('network', 'public');
    form.append('name', name);
    form.append('file', new Blob([await readFile(filePath)]), name.split('/').at(-1) ?? name);
    const response = await fetch('https://uploads.pinata.cloud/v3/files', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.jwt}` },
      body: form,
      signal: AbortSignal.timeout(900_000),
    });
    if (!response.ok) return null;
    return pinataResponse.parse(await response.json()).data.cid;
  }
}

/** Pinata (v3 upload API). Second, independent pinning vendor. */
export class PinataPinner implements Pinner {
  readonly provider = 'pinata';

  constructor(private readonly jwt: string) {}

  async pinCar(carPath: string, expectedRoot: string, label: string): Promise<PinResult> {
    try {
      const form = new FormData();
      form.append('network', 'public');
      form.append('name', `${label}.car`);
      form.append('car', 'true');
      form.append(
        'file',
        new Blob([await readFile(carPath)], { type: 'application/vnd.ipld.car' }),
        `${label}.car`,
      );
      const response = await fetch('https://uploads.pinata.cloud/v3/files', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.jwt}` },
        body: form,
        signal: AbortSignal.timeout(600_000),
      });
      if (!response.ok) {
        return {
          provider: this.provider,
          cid: null,
          ok: false,
          detail: `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`,
        };
      }
      const cid = pinataResponse.parse(await response.json()).data.cid;
      const ok = cid === expectedRoot;
      return {
        provider: this.provider,
        cid,
        ok,
        detail: ok ? 'imported CAR' : `service reported ${cid}, expected ${expectedRoot}`,
      };
    } catch (e) {
      return {
        provider: this.provider,
        cid: null,
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

export interface IpnsRecord {
  /** IPNS name (the public key, k51...). A pointer; the CID is the snapshot. */
  name: string;
  label: string;
  resolvedCid: string;
  sequence: number;
  updatedAt: string;
}

const nameResponse = z.object({
  label: z.string(),
  network_key: z.string(),
  cid: z.string(),
  sequence: z.number(),
});

/**
 * Moves an IPNS name to a new root CID through Filebase's names API (creates it on first use).
 * The name only says "latest"; every manifest still records the CID it resolved to for that run.
 */
export class FilebaseNames {
  private readonly headers: Record<string, string>;

  constructor(
    accessKey: string,
    secretKey: string,
    private readonly label: string,
  ) {
    const token = Buffer.from(`${accessKey}:${secretKey}`).toString('base64');
    this.headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  }

  async point(cid: string, now: () => Date): Promise<IpnsRecord | null> {
    const api = 'https://api.filebase.io/v1/names';
    try {
      let response = await fetch(`${api}/${this.label}`, {
        method: 'PUT',
        headers: this.headers,
        body: JSON.stringify({ cid }),
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status === 404) {
        response = await fetch(api, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({ label: this.label, cid }),
          signal: AbortSignal.timeout(60_000),
        });
      }
      if (!response.ok) return null;
      const record = nameResponse.parse(await response.json());
      if (record.cid !== cid) return null;
      return {
        name: record.network_key,
        label: record.label,
        resolvedCid: record.cid,
        sequence: record.sequence,
        updatedAt: now().toISOString(),
      };
    } catch {
      return null;
    }
  }
}
