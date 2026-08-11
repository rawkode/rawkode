// @enchiridion/worker-gatekeeper-google — minimal R2 surface for Gmail
// attachment storage. Mirrors `workers/vault/src/r2-types.ts`'s pattern
// exactly (a narrowed, locally-declared ambient shape rather than importing
// `@cloudflare/workers-types`' `R2Bucket` directly, so `gmail-body-ingest.ts`
// is unit-testable against an in-memory fake with no live Workers runtime)
// — deliberately DUPLICATED, not imported from `workers/vault`, for the same
// "two independently deployed workers, no shared runtime package" reasoning
// `schema.ts`'s file header documents for `SqlExecutor`.
//
// NARROWER than vault's `R2BucketLike`: only `head`/`put`/`get` — Gmail
// attachments arrive already-decoded and fully buffered in memory (Gmail
// itself caps a single message's total attachment payload at 25 MB, per
// Google's documented limits — comfortably within a Workers isolate's
// buffering budget), so there is no multipart-upload code path to support
// here, unlike vault's blob routes (which must handle arbitrary
// user-uploaded video). `get` is included for potential future download
// routes (out of this pass's scope — see `gmail-body-ingest.ts`'s header)
// but not required by anything in this pass; kept for interface fidelity
// with a real `R2Bucket` costing nothing to declare.

export interface R2ObjectLike {
  readonly key: string;
  readonly etag: string;
  readonly size: number;
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  readonly body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2HttpMetadataLike {
  contentType?: string;
}

export interface R2PutOptionsLike {
  httpMetadata?: R2HttpMetadataLike;
}

/** Structurally compatible with `@cloudflare/workers-types`' `R2Bucket` —
 *  a real `Env.GMAIL_ATTACHMENTS` binding satisfies this as-is (the real
 *  type has strictly more methods than this narrowed one requires), so call
 *  sites cast `as unknown as R2BucketLike`, matching vault's own
 *  `r2-types.ts` convention for the identical reason. */
export interface R2BucketLike {
  head(key: string): Promise<R2ObjectLike | null>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string | Blob,
    options?: R2PutOptionsLike,
  ): Promise<R2ObjectLike>;
}
