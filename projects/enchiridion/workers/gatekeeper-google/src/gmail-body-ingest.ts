// @enchiridion/worker-gatekeeper-google — Gmail message body + attachment
// ingest ("Gmail message bodies + attachments" follow-up to "P3: Gmail",
// plan §Google gatekeeper: "Message bodies stay out of the CRDT graph —
// bodies in gatekeeper DO SQLite, attachments in R2 (same content-addressed
// scheme), served via server-only GraphQL fields (`thread.messages`,
// `emailSearch`)").
//
// DELIBERATELY A SEPARATE CRON STEP FROM `gmail-ingest.ts`, not a new pass
// inside `processBatch`/`runGmailIngest` — three reasons:
//   1. TEST-SUITE ISOLATION: `gmail-ingest.ts`'s existing ~500 lines of
//      tests (`gmail-ingest.test.ts`) construct a fake `fetchImpl` router
//      that throws on any unrecognized Gmail API pathname (see that test
//      file's `router()` helper). Adding an unconditional
//      `getMessage(format:"full")`/attachment-fetch call inside
//      `processBatch` would make EVERY one of those already-reviewed,
//      already-passing tests start hitting new endpoints their fixtures
//      don't handle — breaking dozens of tests to add one feature is
//      exactly the "reintroduce an already-fixed bug class" risk this
//      task's brief warns against, just applied to test coverage instead
//      of a runtime bug.
//   2. DIFFERENT COST PROFILE: thread materialization (`gmail-ingest.ts`)
//      is cheap (one `threads.get` per thread, `format=metadata`). Full
//      message bodies are heavier (one `messages.get(format:"full")` PER
//      MESSAGE, plus a further `messages.attachments.get` per
//      not-inlined attachment) — coupling them would make thread discovery
//      only as fast as the slowest body fetch, when the two have no actual
//      ordering dependency (a thread can be discovered/materialized in one
//      cron tick and have its bodies fetched over several subsequent
//      ticks).
//   3. NATURALLY INDEPENDENT AND RESUMABLE ALREADY: `gmail-thread-
//      materialization.ts` durably records every message id it has ever
//      seen into `gmail_thread_messages` (`gmail-body-store.ts`'s
//      `recordThreadMessages`) REGARDLESS of whether this module has
//      caught up yet — so this module can run on its own cadence, fall
//      behind, catch up, or even be temporarily disabled, with zero risk of
//      permanently losing track of which messages need bodies. This is why
//      NO SEPARATE CURSOR TABLE is needed (unlike `gmail_backfill_state`'s
//      `page_token`): `gmail-body-store.ts`'s `listMessagesMissingBodies`
//      IS the resumability mechanism — every tick just asks "what's still
//      missing", bounded by `BODY_INGEST_BATCH_SIZE`, and whatever's left
//      over is picked up next tick, indefinitely, with no drift-detection
//      or re-baseline logic needed (a missing row is simply still missing
//      until it's fetched — there is no equivalent of Gmail's `historyId`
//      expiring for this local join query).
//
// PER-MESSAGE POISON-PILL ISOLATION, same pattern as `gmail-ingest.ts`'s
// per-thread try/catch: one message whose body/attachment fetch throws
// (a transient Gmail API error, a `getMessageAttachment` 404 for an
// attachment that no longer exists, an unexpected payload shape) must not
// abort the rest of the batch — recorded via
// `gmail-body-ingest-failures-store.ts` and skipped, exactly like
// `gmail-ingest.ts`'s `recordGmailIngestFailure` calls.
//
// ATTACHMENT UPLOAD is intentionally simple compared to `workers/vault`'s
// `blob-routes.ts`: no pending-references-before-upload GC protection, no
// multipart chunking. Documented reasons:
//   - GC race: vault's pending-references dance exists because an OFFLINE
//     DEVICE might reference a blob it hasn't finished uploading yet while
//     a concurrent GC sweep runs — a genuine multi-writer race. This
//     worker is the ONLY writer to its own `GMAIL_ATTACHMENTS` bucket (no
//     device ever uploads there directly), and there is no GC sweep for
//     this bucket at all in this pass (see wrangler.jsonc's binding
//     comment) — so there is no race to protect against yet. If a future
//     pass adds GC for this bucket, it should adopt the same
//     pending-reference pattern then, not before.
//   - Multipart: Gmail caps a single message's total attachment payload at
//     25 MB (Google's documented limit) — every attachment this module
//     ever uploads fits comfortably in one buffered `R2Bucket.put()` call,
//     unlike vault's blob routes (arbitrary user-uploaded video, which
//     `blob-routes.ts`'s `MULTIPART_THRESHOLD_BYTES` is sized for).
//
// NOT IN THIS PASS: a download route for attachment bytes (this module only
// UPLOADS to `GMAIL_ATTACHMENTS` and records `blob_<sha256>` ids +
// metadata; nothing in this worker or `workers/vault` serves the bytes back
// out yet) — out of scope for the GraphQL-fields task this module was built
// for (`EmailThread.messages`/`emailSearch` expose attachment METADATA
// only, per `@enchiridion/gatekeeper-google-rpc-contract`'s
// `EmailAttachmentDTO`), tracked as clear follow-up work, not a silent gap.

import { deriveBlobId } from "@enchiridion/graph-core";
import { getMessage, getMessageAttachment, type FetchLike, type GmailFullMessage } from "./gmail-api";
import { decodeBase64Url, parseGmailMessage } from "./gmail-mime";
import { recordAttachment } from "./gmail-attachment-store";
import { recordGmailBodyIngestFailure } from "./gmail-body-ingest-failures-store";
import { hasMessageBody, listMessagesMissingBodies, setMessageBody } from "./gmail-body-store";
import type { R2BucketLike } from "./r2-types";
import type { SqlExecutor } from "./schema";

/** Threads' worth of missing-message rows considered per cron tick — bounds
 *  both the SQL scan (`listMessagesMissingBodies`'s `LIMIT`) and the number
 *  of Gmail API calls one tick can make. Documented choice, smaller than
 *  `gmail-ingest.ts`'s `BACKFILL_BATCH_SIZE` (50): a `format=full` message
 *  fetch is heavier than a `format=metadata` thread fetch, and a message
 *  with N not-inlined attachments costs 1 + N Gmail API calls, not 1 — 25
 *  keeps a worst-case tick (25 messages, each with several large
 *  attachments needing separate `attachments.get` calls) comfortably inside
 *  a Workers cron invocation's CPU budget. */
export const BODY_INGEST_BATCH_SIZE = 25;

export interface GmailBodyIngestDeps {
  sql: SqlExecutor;
  r2: R2BucketLike;
  accessToken: string;
  now: Date;
  fetchImpl?: FetchLike;
}

export interface GmailBodyIngestResult {
  /** Messages this cycle attempted to fetch (from
   *  `listMessagesMissingBodies`) — includes ones that failed. */
  consideredCount: number;
  bodiesFetchedCount: number;
  attachmentsUploadedCount: number;
  failedCount: number;
}

/** Resolves one attachment part's real bytes — either already-inlined
 *  (`part.data`) or fetched via `getMessageAttachment` (`part.
 *  attachmentId`) — see `GmailMessagePartBody`'s doc comment
 *  (`gmail-api.ts`) for why exactly one of the two is ever present. Returns
 *  `undefined` for a part with neither (malformed/unexpected shape — never
 *  thrown, matching this module's per-message try/catch already covering
 *  real failures; a part this can't resolve is just skipped). */
async function resolveAttachmentBytes(
  deps: GmailBodyIngestDeps,
  messageID: string,
  part: { data?: string; attachmentId?: string },
): Promise<Uint8Array | undefined> {
  if (part.data) return decodeBase64Url(part.data);
  if (part.attachmentId) {
    const fetched = await getMessageAttachment({
      accessToken: deps.accessToken,
      messageId: messageID,
      attachmentId: part.attachmentId,
      fetchImpl: deps.fetchImpl,
    });
    return decodeBase64Url(fetched.data);
  }
  return undefined;
}

/** Uploads one attachment's bytes to `deps.r2`, content-addressed
 *  (`deriveBlobId`) — deduped via a `head()` check first (identical
 *  content re-uploaded, e.g. the same PDF attached to two different
 *  threads, costs one R2 read instead of a redundant write; matches
 *  vault's `blob-routes.ts`'s "dedup for free" framing, applied to this
 *  bucket). Records the reference row regardless of whether the R2 object
 *  already existed — `gmail-attachment-store.ts`'s `recordAttachment` has
 *  no uniqueness constraint to violate either way. */
async function uploadAttachment(
  deps: GmailBodyIngestDeps,
  messageID: string,
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
): Promise<string> {
  const blobID = await deriveBlobId(bytes);
  const existing = await deps.r2.head(blobID);
  if (!existing) {
    await deps.r2.put(blobID, bytes, mimeType ? { httpMetadata: { contentType: mimeType } } : undefined);
  }
  recordAttachment(deps.sql, { messageID, blobID, filename, mimeType, size: bytes.byteLength }, deps.now.getTime());
  return blobID;
}

/** Fetches, parses, and stores ONE message's full content — the unit of
 *  work `runGmailBodyIngest`'s per-message try/catch wraps. */
async function ingestOneMessage(
  deps: GmailBodyIngestDeps,
  target: { pageID: string; threadID: string; messageID: string },
): Promise<{ attachmentsUploaded: number }> {
  const raw = (await getMessage({
    accessToken: deps.accessToken,
    messageId: target.messageID,
    format: "full",
    fetchImpl: deps.fetchImpl,
  })) as unknown as GmailFullMessage;

  const parsed = parseGmailMessage(raw.payload);

  let attachmentsUploaded = 0;
  for (const attachment of parsed.attachments) {
    const bytes = await resolveAttachmentBytes(deps, target.messageID, attachment);
    if (!bytes) continue;
    await uploadAttachment(deps, target.messageID, bytes, attachment.filename, attachment.mimeType);
    attachmentsUploaded += 1;
  }

  const receivedAt = raw.internalDate ? Number(raw.internalDate) : deps.now.getTime();
  setMessageBody(deps.sql, {
    messageID: target.messageID,
    pageID: target.pageID,
    threadID: target.threadID,
    headers: parsed.headers,
    bodyText: parsed.bodyText,
    bodyHtml: parsed.bodyHtml,
    receivedAt: Number.isFinite(receivedAt) ? receivedAt : deps.now.getTime(),
  });

  return { attachmentsUploaded };
}

/** Runs one body-ingest cron tick — see this file's header for why this is
 *  a self-contained, cursor-free, naturally-resumable sweep. Skips a
 *  message that already has a stored body (defensive: `
 *  listMessagesMissingBodies` already filters these out via its `LEFT
 *  JOIN`, but re-checking here costs nothing and protects against two
 *  overlapping calls racing on the SAME missing-message set — mirrors
 *  `gmail-ingest-cycle.ts`'s reentrancy guard, which this module's own
 *  cycle wrapper, `gmail-body-ingest-cycle.ts`, also provides at the
 *  cycle-level). */
export async function runGmailBodyIngest(deps: GmailBodyIngestDeps): Promise<GmailBodyIngestResult> {
  const targets = listMessagesMissingBodies(deps.sql, BODY_INGEST_BATCH_SIZE);

  let bodiesFetchedCount = 0;
  let attachmentsUploadedCount = 0;
  let failedCount = 0;

  for (const target of targets) {
    if (hasMessageBody(deps.sql, target.messageID)) continue;
    try {
      const { attachmentsUploaded } = await ingestOneMessage(deps, target);
      bodiesFetchedCount += 1;
      attachmentsUploadedCount += attachmentsUploaded;
    } catch (error) {
      failedCount += 1;
      recordGmailBodyIngestFailure(
        deps.sql,
        {
          messageID: target.messageID,
          threadID: target.threadID,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        deps.now.getTime(),
      );
    }
  }

  return {
    consideredCount: targets.length,
    bodiesFetchedCount,
    attachmentsUploadedCount,
    failedCount,
  };
}
