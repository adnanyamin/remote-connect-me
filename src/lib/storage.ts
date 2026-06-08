import { promises as fs } from 'fs';
import path from 'path';

/**
 * Pluggable blob storage for recording chunks.
 *
 * Two drivers, chosen by STORAGE_DRIVER:
 *   - "local" (default): writes under RECORDINGS_DIR (default ".recordings/").
 *     Good for dev + single-box self-hosting.
 *   - "s3": writes to an S3 bucket with SSE-KMS, using the optional
 *     @aws-sdk/client-s3 dependency. Enable with STORAGE_DRIVER=s3 + the AWS
 *     env vars below.
 *
 * Chunks are already encrypted by the caller (lib/recordingCrypto) before they
 * reach storage, so even the "local" driver is encrypted-at-rest. For S3 we
 * ALSO request SSE-KMS as defense in depth.
 *
 * Keys are opaque strings like "recordings/<orgId>/<recordingId>"; each chunk
 * is stored at "<key>/<seq>.bin" with seq zero-padded so lexical order ==
 * chronological order.
 *
 *   STORAGE_DRIVER=local|s3
 *   RECORDINGS_DIR=/var/lib/remotely/recordings   (local)
 *   S3_BUCKET, S3_REGION, S3_KMS_KEY_ID, AWS_*    (s3)
 */

export interface ChunkStore {
  putChunk(key: string, seq: number, data: Buffer): Promise<void>;
  /**
   * Yield each stored chunk (still encrypted) in seq order. The caller
   * decrypts per-chunk — chunks are NOT concatenated here because each one
   * carries its own GCM iv+tag and must be opened independently.
   */
  readChunks(key: string): AsyncIterable<Buffer>;
  /** Number of chunks currently stored under a key. */
  count(key: string): Promise<number>;
  /** Delete every chunk under a key (used by retention cleanup). */
  remove(key: string): Promise<void>;
}

function seqName(seq: number): string {
  return `${String(seq).padStart(9, '0')}.bin`;
}

// ---------------------------------------------------------------------------
// Local filesystem driver
// ---------------------------------------------------------------------------

class LocalStore implements ChunkStore {
  private base: string;
  constructor(base: string) { this.base = base; }

  private dir(key: string) {
    // Prevent path traversal: keys are server-generated, but be defensive.
    const safe = key.replace(/\.\./g, '').replace(/^\/+/, '');
    return path.join(this.base, safe);
  }

  async putChunk(key: string, seq: number, data: Buffer): Promise<void> {
    const dir = this.dir(key);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, seqName(seq)), data);
  }

  async *readChunks(key: string): AsyncIterable<Buffer> {
    const dir = this.dir(key);
    let names: string[];
    try { names = await fs.readdir(dir); }
    catch { return; }
    names = names.filter((n) => n.endsWith('.bin')).sort();
    for (const n of names) yield await fs.readFile(path.join(dir, n));
  }

  async count(key: string): Promise<number> {
    try {
      const names = await fs.readdir(this.dir(key));
      return names.filter((n) => n.endsWith('.bin')).length;
    } catch { return 0; }
  }

  async remove(key: string): Promise<void> {
    await fs.rm(this.dir(key), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// S3 driver (optional dependency)
// ---------------------------------------------------------------------------

class S3Store implements ChunkStore {
  private client: any;
  private bucket: string;
  private kmsKeyId?: string;
  private S3: any;

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const s3 = require('@aws-sdk/client-s3');
    this.S3 = s3;
    this.bucket = process.env.S3_BUCKET as string;
    if (!this.bucket) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
    this.kmsKeyId = process.env.S3_KMS_KEY_ID;
    this.client = new s3.S3Client({ region: process.env.S3_REGION });
  }

  private objKey(key: string, seq: number) {
    return `${key}/${seqName(seq)}`;
  }

  async putChunk(key: string, seq: number, data: Buffer): Promise<void> {
    const params: any = {
      Bucket: this.bucket,
      Key: this.objKey(key, seq),
      Body: data,
    };
    if (this.kmsKeyId) {
      params.ServerSideEncryption = 'aws:kms';
      params.SSEKMSKeyId = this.kmsKeyId;
    }
    await this.client.send(new this.S3.PutObjectCommand(params));
  }

  async *readChunks(key: string): AsyncIterable<Buffer> {
    const listed = await this.client.send(new this.S3.ListObjectsV2Command({
      Bucket: this.bucket, Prefix: `${key}/`,
    }));
    const keys = (listed.Contents || [])
      .map((o: any) => o.Key as string)
      .filter((k: string) => k.endsWith('.bin'))
      .sort();
    for (const k of keys) {
      const obj = await this.client.send(new this.S3.GetObjectCommand({ Bucket: this.bucket, Key: k }));
      yield Buffer.from(await streamToBuffer(obj.Body));
    }
  }

  async count(key: string): Promise<number> {
    const listed = await this.client.send(new this.S3.ListObjectsV2Command({
      Bucket: this.bucket, Prefix: `${key}/`,
    }));
    return (listed.Contents || []).filter((o: any) => (o.Key as string).endsWith('.bin')).length;
  }

  async remove(key: string): Promise<void> {
    const listed = await this.client.send(new this.S3.ListObjectsV2Command({
      Bucket: this.bucket, Prefix: `${key}/`,
    }));
    const objs = (listed.Contents || []).map((o: any) => ({ Key: o.Key }));
    if (objs.length === 0) return;
    await this.client.send(new this.S3.DeleteObjectsCommand({
      Bucket: this.bucket, Delete: { Objects: objs },
    }));
  }
}

async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------

let singleton: ChunkStore | null = null;

export function getChunkStore(): ChunkStore {
  if (singleton) return singleton;
  const driver = (process.env.STORAGE_DRIVER || 'local').toLowerCase();
  if (driver === 's3') {
    singleton = new S3Store();
  } else {
    const base = process.env.RECORDINGS_DIR || path.join(process.cwd(), '.recordings');
    singleton = new LocalStore(base);
  }
  return singleton;
}
