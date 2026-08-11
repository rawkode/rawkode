// @enchiridion/worker-vault — minimal R2 surface.
//
// Declared locally (rather than importing `@cloudflare/workers-types`'
// `R2Bucket` directly into every module that touches R2) so `blob-store.ts`,
// `blob-routes.ts`, and `backup.ts`'s logic can be unit tested against an
// in-memory fake (`test-helpers/in-memory-r2-bucket.ts`) with real bytes and
// real hashing, without a live Workers runtime (`wrangler dev`) that this
// sandbox doesn't have network/account access to drive — the exact same
// reasoning, and the exact same pattern, as `schema.ts`'s `SqlExecutor`
// being a minimal ambient shape of `SqlStorage` for `SqliteStorageAdapter`
// to implement.
//
// VERIFICATION NOTE (mirrors `loro-storage.ts`'s file header convention):
// every field/method below was checked against the ACTUAL installed
// `@cloudflare/workers-types@4.20260702.1` package in this sandbox —
// `node_modules/.bun/@cloudflare+workers-types@4.20260702.1/node_modules/
// @cloudflare/workers-types/index.d.ts`, `interface R2Bucket` (~line 2408),
// `interface R2MultipartUpload` (~line 2449), `interface R2Object`
// (~line 2464), `type R2Objects` (~line 2548) — not guessed at. A real
// `env.BLOBS: R2Bucket` value satisfies every interface below as-is
// (structurally: the real types have strictly MORE fields/methods than
// these narrowed interfaces require), so call sites in `index.ts`/
// `vault-do.ts` pass `env.BLOBS` through an explicit
// `as unknown as R2BucketLike` cast (matching `vault-do.ts`'s own
// `this.ctx.storage.sql as unknown as SqlExecutor` cast for the identical
// reason) rather than relying on an implicit structural match holding
// exactly, for every future workers-types version.
//
// R2 multipart part-size constraint (Cloudflare docs, not this sandbox —
// called out because `blob-routes.ts`'s chunking logic depends on it): all
// parts except the last must be at least 5 MiB; there is no documented
// upper bound relevant at this worker's scale. `blob-routes.ts` chunks at
// 10 MiB, comfortably above that floor.

export interface R2ObjectLike {
  readonly key: string;
  readonly etag: string;
  readonly size: number;
  readonly uploaded: Date;
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  readonly body: ReadableStream;
  readonly httpMetadata?: { contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2HttpMetadataLike {
  contentType?: string;
}

export interface R2PutOptionsLike {
  httpMetadata?: R2HttpMetadataLike;
}

export interface R2UploadedPartLike {
  partNumber: number;
  etag: string;
}

export interface R2MultipartUploadLike {
  readonly key: string;
  readonly uploadId: string;
  uploadPart(
    partNumber: number,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
  ): Promise<R2UploadedPartLike>;
  abort(): Promise<void>;
  complete(uploadedParts: R2UploadedPartLike[]): Promise<R2ObjectLike>;
}

export interface R2ListOptionsLike {
  prefix?: string;
  cursor?: string;
  limit?: number;
}

export interface R2ListResultLike {
  objects: R2ObjectLike[];
  truncated: boolean;
  cursor?: string;
}

/** Structurally compatible with `@cloudflare/workers-types`' `R2Bucket` —
 *  see this file's header. Every method a real `Env.BLOBS` binding needs to
 *  support for blob routes (`blob-routes.ts`), GC (`blob-store.ts`), and
 *  backup/restore (`backup.ts`). */
export interface R2BucketLike {
  head(key: string): Promise<R2ObjectLike | null>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
    options?: R2PutOptionsLike,
  ): Promise<R2ObjectLike>;
  createMultipartUpload(key: string, options?: R2PutOptionsLike): Promise<R2MultipartUploadLike>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: R2ListOptionsLike): Promise<R2ListResultLike>;
}
