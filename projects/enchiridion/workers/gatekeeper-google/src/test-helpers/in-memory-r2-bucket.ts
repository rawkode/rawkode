// Test-only. NOT shipped to the Worker bundle — only `*.test.ts` files
// import this. An in-memory `R2BucketLike` (../r2-types.ts) fake, real
// bytes and real content-addressing, no live R2 bucket — mirrors
// `workers/vault/src/test-helpers/in-memory-r2-bucket.ts`'s role for this
// worker's narrower `R2BucketLike` surface (head/get/put only — see that
// file's own header for why no multipart support is needed here).

import type { R2BucketLike, R2ObjectBodyLike, R2ObjectLike, R2PutOptionsLike } from "../r2-types";

interface StoredObject {
  bytes: Uint8Array;
  etag: string;
  contentType?: string;
}

export class InMemoryR2Bucket implements R2BucketLike {
  private readonly objects = new Map<string, StoredObject>();
  /** Every `put()` call's key, in order — lets a test assert dedup (a
   *  second upload of identical content, deriving the same blob id, must
   *  never call `put()` a second time). */
  readonly putCalls: string[] = [];

  async head(key: string): Promise<R2ObjectLike | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return { key, etag: object.etag, size: object.bytes.byteLength };
  }

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    const bytes = object.bytes;
    return {
      key,
      etag: object.etag,
      size: bytes.byteLength,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      },
    };
  }

  async put(key: string, value: ArrayBuffer | ArrayBufferView | string | Blob, options?: R2PutOptionsLike): Promise<R2ObjectLike> {
    this.putCalls.push(key);
    const bytes = toBytes(value);
    this.objects.set(key, { bytes, etag: `etag-${key}`, contentType: options?.httpMetadata?.contentType });
    return { key, etag: `etag-${key}`, size: bytes.byteLength };
  }

  /** Test-only inspection helper — real bytes stored under `key`, or
   *  `undefined` if nothing was ever `put()` there. */
  getStoredBytes(key: string): Uint8Array | undefined {
    return this.objects.get(key)?.bytes;
  }

  getStoredContentType(key: string): string | undefined {
    return this.objects.get(key)?.contentType;
  }
}

function toBytes(value: ArrayBuffer | ArrayBufferView | string | Blob): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new Error("InMemoryR2Bucket.put: Blob values are not supported by this test fake");
}
