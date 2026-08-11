// Test-only. NOT shipped to the Worker bundle — mirrors
// `sqlite-storage-adapter.ts`'s role for `SqlExecutor`: a real, in-memory
// implementation of `R2BucketLike` (`../r2-types.ts`) backed by plain JS
// `Map`s, so `blob-store.test.ts`/`blob-routes.test.ts`/`backup.test.ts` can
// exercise real put/get/delete/list/multipart-upload/list-prefix behavior
// under `bun test` without a live Workers runtime (this sandbox has no
// network/account access to drive `wrangler dev` against a real R2 bucket).
//
// Multipart support is a real (if simplified) implementation: parts are
// buffered in an in-progress upload's own Map, concatenated into one
// `Uint8Array` on `complete()` — enough to exercise `blob-routes.ts`'s
// chunking/hashing/abort-on-mismatch logic end-to-end with real bytes and a
// real SHA-256 digest, without needing R2's actual multi-part storage
// semantics (which don't matter for this worker's correctness — it never
// inspects part boundaries after `complete()`).

import type {
  R2BucketLike,
  R2ListOptionsLike,
  R2ListResultLike,
  R2MultipartUploadLike,
  R2ObjectBodyLike,
  R2ObjectLike,
  R2PutOptionsLike,
  R2UploadedPartLike,
} from "../r2-types";

interface StoredObject {
  bytes: Uint8Array;
  etag: string;
  uploaded: Date;
  contentType?: string;
}

function toUint8Array(value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob): Promise<Uint8Array> {
  if (typeof value === "string") {
    return Promise.resolve(new TextEncoder().encode(value));
  }
  if (value instanceof Uint8Array) {
    return Promise.resolve(value);
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return Promise.resolve(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (value instanceof ArrayBuffer) {
    return Promise.resolve(new Uint8Array(value));
  }
  if (value instanceof ReadableStream) {
    return readAllFromStream(value);
  }
  // Blob (not exercised by this worker's own code paths today, but kept for
  // interface completeness — `Blob.arrayBuffer()` is a standard method).
  return (value as Blob).arrayBuffer().then((buf) => new Uint8Array(buf));
}

async function readAllFromStream(stream: ReadableStream): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function fakeEtag(bytes: Uint8Array): string {
  // Not a real R2 ETag (which is content-derived MD5-ish) — this worker
  // never verifies R2's own ETag value against anything, only echoes it, so
  // any stable-per-put string is sufficient for test purposes.
  return `etag-${bytes.byteLength}-${Math.random().toString(36).slice(2, 10)}`;
}

class InMemoryMultipartUpload implements R2MultipartUploadLike {
  readonly key: string;
  readonly uploadId: string;
  private readonly parts = new Map<number, Uint8Array>();
  private readonly bucket: InMemoryR2Bucket;
  private readonly contentType?: string;
  private aborted = false;
  private completed = false;

  constructor(bucket: InMemoryR2Bucket, key: string, contentType: string | undefined, uploadId: string) {
    this.bucket = bucket;
    this.key = key;
    this.contentType = contentType;
    this.uploadId = uploadId;
  }

  async uploadPart(
    partNumber: number,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
  ): Promise<R2UploadedPartLike> {
    if (this.aborted || this.completed) {
      throw new Error("uploadPart called on an aborted/completed multipart upload");
    }
    const bytes = await toUint8Array(value);
    this.parts.set(partNumber, bytes);
    return { partNumber, etag: fakeEtag(bytes) };
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.parts.clear();
  }

  async complete(uploadedParts: R2UploadedPartLike[]): Promise<R2ObjectLike> {
    if (this.aborted || this.completed) {
      throw new Error("complete called on an aborted/already-completed multipart upload");
    }
    this.completed = true;
    const ordered = [...uploadedParts].sort((a, b) => a.partNumber - b.partNumber);
    let total = 0;
    const chunks: Uint8Array[] = [];
    for (const part of ordered) {
      const bytes = this.parts.get(part.partNumber);
      if (!bytes) throw new Error(`complete(): missing buffered bytes for part ${part.partNumber}`);
      chunks.push(bytes);
      total += bytes.byteLength;
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return this.bucket.putRaw(this.key, combined, this.contentType);
  }
}

/** In-memory `R2BucketLike` implementation — see file header. */
export class InMemoryR2Bucket implements R2BucketLike {
  private readonly objects = new Map<string, StoredObject>();

  async head(key: string): Promise<R2ObjectLike | null> {
    const object = this.objects.get(key);
    return object ? this.toObjectLike(key, object) : null;
  }

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    const bytes = object.bytes;
    return {
      ...this.toObjectLike(key, object),
      httpMetadata: { contentType: object.contentType },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
    options?: R2PutOptionsLike,
  ): Promise<R2ObjectLike> {
    const bytes = await toUint8Array(value);
    return this.putRaw(key, bytes, options?.httpMetadata?.contentType);
  }

  /** Test-only escape hatch used by `InMemoryMultipartUpload.complete()` and
   *  directly by tests that want to seed the bucket without going through
   *  `put()`'s type-coercion path. */
  putRaw(key: string, bytes: Uint8Array, contentType?: string): R2ObjectLike {
    const object: StoredObject = { bytes, etag: fakeEtag(bytes), uploaded: new Date(), contentType };
    this.objects.set(key, object);
    return this.toObjectLike(key, object);
  }

  async createMultipartUpload(key: string, options?: R2PutOptionsLike): Promise<R2MultipartUploadLike> {
    const uploadId = `upload-${key}-${Math.random().toString(36).slice(2, 10)}`;
    return new InMemoryMultipartUpload(this, key, options?.httpMetadata?.contentType, uploadId);
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
    }
  }

  async list(options?: R2ListOptionsLike): Promise<R2ListResultLike> {
    const prefix = options?.prefix ?? "";
    const objects: R2ObjectLike[] = [];
    for (const [key, object] of this.objects.entries()) {
      if (key.startsWith(prefix)) {
        objects.push(this.toObjectLike(key, object));
      }
    }
    objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    // No pagination in this fake — every test corpus is small enough that a
    // single unpaginated list satisfies `options?.limit`-free callers
    // (`backup.ts`'s restore path never passes `limit`/`cursor`).
    return { objects, truncated: false };
  }

  private toObjectLike(key: string, object: StoredObject): R2ObjectLike {
    return { key, etag: object.etag, size: object.bytes.byteLength, uploaded: object.uploaded };
  }
}
