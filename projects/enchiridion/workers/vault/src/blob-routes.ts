// @enchiridion/worker-vault — R2 blob upload/download routes.
//
// Plan §Backend architecture, "Blobs (R2)": "images/video/PDFs are
// content-addressed `blob_<sha256>` objects in an R2 bucket, uploaded/
// downloaded through vault worker routes behind Access (worker streams to
// R2; no public bucket) ... Uploading a blob registers its hash in a
// pending-references table before upload ... Video uses R2 multipart
// upload (chunked through the worker)."
//
// Route contract (wired into the plain worker's `fetch` in `index.ts`, NOT
// forwarded into `VaultDO.fetch()` — see `index.ts`'s routing comment for
// why: the R2 byte-transfer itself doesn't need DO-SQLite transactionality,
// only the pending-reference bookkeeping does, and that's reached here via
// narrow `VaultDO` RPC calls the caller (`index.ts`) makes around these
// pure functions):
//
//   PUT /blobs/:id
//     :id must be `blob_<64-hex-char-sha256>` (`deriveBlobId`'s format,
//     `@enchiridion/graph-core`). Body is the raw blob bytes.
//     - 400 if :id doesn't match that shape.
//     - 200 `{id, size, alreadyExists: true}` if R2 already has this exact
//       content-addressed id (dedup — plan: "dedup for free"; the request
//       body is drained/cancelled, never read, since content-addressing
//       means it can only be identical bytes under a matching id).
//     - 409 `{error, claimed, actual}` if the ACTUAL SHA-256 of the
//       uploaded bytes (computed server-side, never trusted from the
//       client) doesn't match the claimed :id — this is the server-side
//       integrity check the task requires; no R2 object is left behind
//       under either id in this case (multipart uploads are aborted
//       before `complete()`; the pending-reference row is rolled back).
//     - 201 `{id, size}` on a verified, completed upload.
//   GET /blobs/:id
//     - 400 if :id doesn't match the blob_<sha256> shape.
//     - 404 `{error}` if not in R2.
//     - 200, streaming the object's bytes straight through, with
//       `content-length`/`etag`/`content-type` (if R2 has one recorded)
//       response headers. This route IS the only access path — the R2
//       bucket itself has no public URL (plan: "no public bucket").
//
// Two upload strategies, chosen by `Content-Length` against
// `MULTIPART_THRESHOLD_BYTES`:
//   - Below threshold (or Content-Length absent/unparseable): buffer the
//     whole body via `request.arrayBuffer()`, hash it in one shot with
//     `deriveBlobId` (`@enchiridion/graph-core` — reused, not
//     reimplemented, per the task's explicit instruction), then `r2.put()`
//     the buffered bytes. Simple and correct; the memory cost is bounded by
//     the threshold.
//   - At/above threshold: R2 multipart upload, chunked at
//     `MULTIPART_PART_SIZE_BYTES`, hashed INCREMENTALLY via `node:crypto`'s
//     `createHash("sha256")` (available because `wrangler.jsonc` sets
//     `compatibility_flags: ["nodejs_compat"]`) so the full body is never
//     buffered in memory at once. This computes the exact same SHA-256
//     algorithm `deriveBlobId` does (same standard hash, incremental vs.
//     one-shot input makes no difference to the digest) — it does not
//     reimplement blob-id derivation's FORMAT or DECISION (full 64-hex,
//     `blob_` prefix), it only computes the underlying hash a different
//     way for memory reasons; `blob-routes.test.ts` asserts the two paths
//     produce IDENTICAL ids for the same bytes, so this equivalence is
//     verified, not assumed.
//
// R2 API surface used here (`createMultipartUpload`/`uploadPart`/
// `complete`/`abort`) is verified against the actual installed
// `@cloudflare/workers-types` package, not guessed — see `r2-types.ts`'s
// file header for exactly what was checked and where.

import { createHash } from "node:crypto";
import { deriveBlobId } from "@enchiridion/graph-core";
import { confirmBlobUploaded, deletePendingBlobReference, registerPendingBlobReference } from "./blob-store";
import type { R2BucketLike } from "./r2-types";
import type { SqlExecutor } from "./schema";

const BLOB_ID_PATTERN = /^blob_[0-9a-f]{64}$/;

/** Threshold above which `PUT /blobs/:id` switches from buffering the
 *  whole body in memory to R2 multipart upload with incremental hashing.
 *  100 MiB — comfortably under typical Workers-isolate memory ceilings for
 *  the buffered path (see this file's header), and squarely in "this is a
 *  video, not a photo" territory (plan: "Video uses R2 multipart upload"). */
export const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024;

/** R2 multipart requires every part except the last to be >= 5 MiB
 *  (Cloudflare's documented multipart constraint — not independently
 *  re-verifiable in this sandbox, no live R2 bucket available to probe the
 *  floor against; this worker is designed to respect it, not to discover
 *  it empirically). 10 MiB stays comfortably above that floor while
 *  keeping each buffered chunk small. */
const MULTIPART_PART_SIZE_BYTES = 10 * 1024 * 1024;

export function isValidBlobId(id: string): boolean {
  return BLOB_ID_PATTERN.test(id);
}

export interface BlobUploadResult {
  status: 200 | 400 | 409 | 201;
  body: Record<string, unknown>;
}

/** The full upload flow — see this file's header for the route contract.
 *  Registers the pending-reference row BEFORE any R2 write (plan
 *  requirement), and rolls it back on a hash mismatch (nothing durable is
 *  left claiming an id no valid bytes were ever written under). */
export async function handleBlobUpload(
  request: Request,
  blobID: string,
  sql: SqlExecutor,
  r2: R2BucketLike,
  now: number,
): Promise<BlobUploadResult> {
  if (!isValidBlobId(blobID)) {
    return {
      status: 400,
      body: { error: "invalid blob id", detail: "expected blob_<64-hex-char-sha256>" },
    };
  }

  // Dedup for free (plan): content-addressing means an existing object
  // under this exact id can only be these same bytes already. Still
  // register/confirm the reference — an offline device replaying an
  // upload of a blob the vault already has must get the same grace-window
  // protection a first-time upload would (plan's GC-race concern doesn't
  // care whether this is upload #1 or #4 of the same content).
  const existing = await r2.head(blobID);
  if (existing) {
    await request.body?.cancel();
    registerPendingBlobReference(sql, blobID, now);
    confirmBlobUploaded(sql, blobID, now);
    return { status: 200, body: { id: blobID, size: existing.size, alreadyExists: true } };
  }

  registerPendingBlobReference(sql, blobID, now);

  const contentType = request.headers.get("content-type") ?? undefined;
  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
  const useMultipart =
    contentLength !== undefined && Number.isFinite(contentLength) && contentLength >= MULTIPART_THRESHOLD_BYTES;

  const outcome = useMultipart
    ? await uploadViaMultipart(request, blobID, r2, contentType)
    : await uploadBuffered(request, blobID, r2, contentType);

  if (!outcome.matched) {
    deletePendingBlobReference(sql, blobID);
    return {
      status: 409,
      body: { error: "blob id mismatch", claimed: blobID, actual: outcome.actualID },
    };
  }

  confirmBlobUploaded(sql, blobID, now);
  return { status: 201, body: { id: blobID, size: outcome.size } };
}

export interface BlobDownloadResult {
  status: 200 | 400 | 404;
  body?: ReadableStream;
  errorBody?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export async function handleBlobDownload(blobID: string, r2: R2BucketLike): Promise<BlobDownloadResult> {
  if (!isValidBlobId(blobID)) {
    return { status: 400, errorBody: { error: "invalid blob id" } };
  }
  const object = await r2.get(blobID);
  if (!object) {
    return { status: 404, errorBody: { error: "not found" } };
  }
  const headers: Record<string, string> = {
    "content-length": String(object.size),
    etag: object.etag,
  };
  if (object.httpMetadata?.contentType) {
    headers["content-type"] = object.httpMetadata.contentType;
  }
  return { status: 200, body: object.body, headers };
}

// --- upload strategies ---------------------------------------------------

interface UploadOutcome {
  matched: boolean;
  actualID: string;
  size: number;
}

async function uploadBuffered(
  request: Request,
  claimedID: string,
  r2: R2BucketLike,
  contentType: string | undefined,
): Promise<UploadOutcome> {
  const buffer = await request.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const actualID = await deriveBlobId(bytes);
  if (actualID !== claimedID) {
    return { matched: false, actualID, size: bytes.byteLength };
  }
  await r2.put(claimedID, bytes, contentType ? { httpMetadata: { contentType } } : undefined);
  return { matched: true, actualID, size: bytes.byteLength };
}

async function uploadViaMultipart(
  request: Request,
  claimedID: string,
  r2: R2BucketLike,
  contentType: string | undefined,
): Promise<UploadOutcome> {
  if (!request.body) {
    return { matched: false, actualID: await deriveBlobId(new Uint8Array()), size: 0 };
  }

  const upload = await r2.createMultipartUpload(
    claimedID,
    contentType ? { httpMetadata: { contentType } } : undefined,
  );
  const hash = createHash("sha256");
  const uploadedParts: { partNumber: number; etag: string }[] = [];
  const reader = request.body.getReader();

  let partNumber = 1;
  let buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let totalSize = 0;

  const flushPart = async (): Promise<void> => {
    if (bufferedBytes === 0) return;
    const chunk = concatUint8Arrays(buffered, bufferedBytes);
    hash.update(chunk);
    const part = await upload.uploadPart(partNumber, chunk);
    uploadedParts.push(part);
    partNumber += 1;
    buffered = [];
    bufferedBytes = 0;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      buffered.push(chunk);
      bufferedBytes += chunk.byteLength;
      totalSize += chunk.byteLength;
      if (bufferedBytes >= MULTIPART_PART_SIZE_BYTES) {
        await flushPart();
      }
    }
    await flushPart(); // final part — allowed to be under the 5 MiB floor.

    const actualID = `blob_${hash.digest("hex")}`;
    if (actualID !== claimedID) {
      await upload.abort();
      return { matched: false, actualID, size: totalSize };
    }

    await upload.complete(uploadedParts);
    return { matched: true, actualID, size: totalSize };
  } catch (error) {
    await upload.abort().catch(() => {});
    throw error;
  }
}

function concatUint8Arrays(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
