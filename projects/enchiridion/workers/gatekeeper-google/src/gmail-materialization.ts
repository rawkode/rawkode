// @enchiridion/worker-gatekeeper-google — Gmail thread normalization and
// provider-baseline change detection.
//
// Mirrors `calendar-materialization.ts`'s shape and role exactly (see that
// file's header for the general pattern this follows): this module turns
// Gmail's real API shape (`gmail-api.ts`) into exactly what
// `gmail-materialized-doc.ts` needs to build/update an `EmailThread` page,
// plus the per-field baseline-hash change-detection this worker's
// materialization orchestration (`gmail-ingest.ts`) diffs against.
//
// PER-FIELD BASELINE HASHING, REUSED FROM THE START (not bundle-granular):
// the task brief asks this module to "think through whether per-field
// hashing is even needed here or if EmailThread materialization is
// naturally more append-only/idempotent" — it IS more append-only than
// Calendar's event fields (a thread's `subject` essentially never changes
// after its first message; `messageCount`/`lastMessageAt`/`snippet` only
// ever grow/advance, never regress), but `labels` is a genuine
// counter-example: Gmail labels (read/unread via `UNREAD`, starred,
// archived, custom labels) change CONSTANTLY and completely independently
// of new messages arriving — a user can toggle a thread's labels dozens of
// times with zero new messages. If this module used ONE combined hash for
// the whole page (the bundle-granular shape Calendar's P2 pass shipped
// with and later had to fix per adversarial review — see
// `calendar-materialization.ts`'s header), every label toggle would force
// a rewrite ATTEMPT of every other owned field too (subject, snippet,
// participants), reopening the exact same "an unrelated field change
// clobbers a user's edit to a different field" risk the calendar fix
// closed. So: this module reuses the ALREADY-FIXED per-field pattern
// (`eventFieldBaselineHashes`'s shape, `diffChangedFields` verbatim — that
// function is already generic over the field-key union, no
// Calendar-specific behavior in it, so it's imported and reused directly
// rather than re-implemented) from the start, never shipping the
// bundle-granular version Calendar had to retrofit away from.
//
// PARTICIPANT QUALITY GATE — see `gmail-participants-store.ts` for the
// ledger this reads/writes, and `gmail-ingest.ts` for how the two-pass
// batch design keeps ledger updates visible to every thread in the SAME
// batch (not just later batches). The heuristic itself, decided here:
//
//   An address qualifies for a synced Person page once the user's OWN
//   account has EVER sent a message TO it (`gmail_participant_stats.
//   sent_to_count > 0`) — detected for free, with NO extra Gmail API
//   calls, via the `SENT` system label Gmail already attaches to every
//   message in the mailbox's Sent folder: a message whose `labelIds`
//   includes `"SENT"` was authored by the account owner, so its `To`/`Cc`
//   recipients are addresses the user has demonstrably written to.
//
//   This is the plan's FIRST suggested option ("check if the user has
//   ever sent a message TO this address, by querying/tracking Sent-folder
//   participation") — but implemented via the `SENT` label already present
//   on data this worker fetches anyway for thread materialization, rather
//   than the plan's literal "querying ... per-address" phrasing (e.g. a
//   separate `messages.list?q=from:me to:<address>` call per candidate
//   address). That per-address-query approach was rejected: it would cost
//   one extra Gmail API call per NEW participant address encountered
//   during backfill, which is exactly the "Gmail-API-call-budget" the
//   plan explicitly asks this task to weigh precision against — a mailbox
//   with hundreds of distinct correspondents would mean hundreds of extra
//   calls on top of the thread-fetch budget. The `SENT`-label approach
//   gets the SAME precision (a real "the user sent TO this address" fact,
//   not the plan's cheaper "appears as both a from and a to participant
//   across at least 2 threads" fallback heuristic, which can't
//   distinguish "the user personally replied" from "this address happens
//   to appear on both sides of two unrelated threads", e.g. two different
//   automated systems that both file support tickets under one shared
//   noreply-style address) at ZERO extra API cost, since `SENT` is just
//   another entry in the `labelIds` array `getThread`'s `format=metadata`
//   response already includes for every message.
//
//   One-directional is deliberate, not a corner cut: reciprocity (the
//   address must ALSO have sent something back) was considered and
//   rejected as an additional requirement — "the user sent TO this
//   address" already excludes every newsletter/no-reply sender (the user
//   never emails those back, so they'd never cross this gate), which is
//   the plan's stated concern ("not every newsletter sender"). Requiring
//   a reply in addition would ALSO exclude a legitimate one-way
//   correspondent (e.g. a support address the user has written to but
//   which hasn't replied yet) that a reasonable reading of "correspondents
//   you've actually exchanged mail with" should still include.
//
//   The gate is a ONE-WAY RATCHET: `gmail_participant_stats` is cumulative
//   for an address's whole lifetime (schema.ts's file header point 9), so
//   once an address qualifies it never loses its Person page even if the
//   user later never emails it again — matches the rest of this worker's
//   "never auto-demote/never auto-retract a Person page" posture
//   (`materialized-doc.ts`'s privacy-gate section makes the identical
//   choice for calendar-attendee origin pages).

import { deriveEmailThreadPageId } from "@enchiridion/graph-core";
import type { GmailMessage, GmailThread } from "./gmail-api";
import { normalizeEmail, parseAddressList } from "./gmail-address";
import { sha256Hex } from "./hash";

export interface NormalizedParticipant {
  /** Already normalized (trim + lowercase) — see `normalizeEmail`. */
  email: string;
  displayName?: string;
}

/** One Gmail thread, normalized into exactly what
 *  `gmail-materialized-doc.ts` and the participant quality gate need.
 *  `fromParticipants`/`toParticipants`/`ccParticipants` are the RAW
 *  (pre-quality-gate) deduped participant sets across every message in the
 *  thread — the ACCOUNT OWNER is excluded already (see `normalizeThread`),
 *  but no other filtering has happened yet; `gmail-ingest.ts` applies the
 *  quality gate afterward, per-role, when building the page's actual
 *  edges. `sentToAddresses` is the ledger-update ingredient (every address
 *  this thread's `SENT`-labeled messages addressed) — NOT written to the
 *  page itself, purely an intermediate for `gmail-participants-store.ts`'s
 *  `recordSentTo`. */
export interface NormalizedThread {
  pageID: string;
  threadID: string;
  subject: string;
  /** Union of every message's `labelIds` in the thread, sorted. Raw Gmail
   *  label ids (e.g. `"INBOX"`, `"IMPORTANT"`, or an opaque user-label id
   *  like `"Label_1"`) — see `supertags/email/src/index.ts`'s `labels`
   *  field doc comment: resolving a custom label id to its human-readable
   *  display name would need an extra `users.labels.get` call this module
   *  deliberately doesn't make (same API-call-budget reasoning as the
   *  participant gate above); a follow-up task can add that resolution
   *  later without changing this module's shape. */
  labels: string[];
  snippet: string;
  /** ISO-8601 instant of the thread's most recent message
   *  (`internalDate`). */
  lastMessageAt: string;
  messageCount: number;
  fromParticipants: NormalizedParticipant[];
  toParticipants: NormalizedParticipant[];
  ccParticipants: NormalizedParticipant[];
  sentToAddresses: string[];
  /** Every message id in the thread (Gmail's own `messages[].id`), in the
   *  thread's own message order — NOT used by page materialization itself
   *  (`gmail-materialized-doc.ts` never writes message ids to the page, per
   *  this module's "message bodies stay out of the CRDT graph" posture).
   *  Consumed by `gmail-thread-materialization.ts`, which records these
   *  into `gmail_thread_messages` (`gmail-body-store.ts`'s
   *  `recordThreadMessages`) so the separate body-ingest sweep
   *  (`gmail-body-ingest.ts`) knows which message ids exist and can fetch
   *  their full content independently of thread-page materialization
   *  timing. */
  messageIds: string[];
}

function headerValue(message: GmailMessage, name: string): string | undefined {
  const headers = message.payload?.headers ?? [];
  const lowerName = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lowerName)?.value;
}

function upsertParticipant(map: Map<string, NormalizedParticipant>, email: string, displayName: string | undefined): void {
  if (!map.has(email)) {
    map.set(email, { email, displayName });
  } else if (displayName && !map.get(email)?.displayName) {
    // A later message in the thread supplied a display name an earlier one
    // didn't — fill it in rather than leaving the participant nameless.
    map.set(email, { email, displayName });
  }
}

/** Builds `NormalizedThread` from one raw Gmail thread (`threads.get`'s
 *  `format=metadata` response), or `undefined` when the thread can't be
 *  materialized at all (missing id, or zero messages — a malformed
 *  response must not crash ingest, same posture as
 *  `calendar-materialization.ts`'s `normalizeOccurrence`).
 *  `selfEmail` (already normalized, or `undefined` if not yet discovered —
 *  see `gmail-ingest.ts`'s header on why self-email discovery happens
 *  before any thread is processed) is excluded from every participant
 *  role: the account owner is never a "correspondent" edge target on their
 *  own threads. */
export async function normalizeThread(thread: GmailThread, selfEmail: string | undefined): Promise<NormalizedThread | undefined> {
  if (!thread.id) return undefined;
  const messages = thread.messages ?? [];
  if (messages.length === 0) return undefined;

  const pageID = await deriveEmailThreadPageId(thread.id);

  const labelSet = new Set<string>();
  let snippet = thread.snippet ?? "";
  let subject = "";
  let lastMessageAtMs = 0;
  const fromMap = new Map<string, NormalizedParticipant>();
  const toMap = new Map<string, NormalizedParticipant>();
  const ccMap = new Map<string, NormalizedParticipant>();
  const sentToSet = new Set<string>();

  for (const message of messages) {
    for (const labelId of message.labelIds ?? []) labelSet.add(labelId);

    if (!subject) {
      const subjectHeader = headerValue(message, "Subject");
      if (subjectHeader && subjectHeader.trim().length > 0) subject = subjectHeader.trim();
    }

    if (message.snippet) snippet = message.snippet;

    const internalDateMs = message.internalDate ? Number(message.internalDate) : Number.NaN;
    if (Number.isFinite(internalDateMs) && internalDateMs > lastMessageAtMs) {
      lastMessageAtMs = internalDateMs;
    }

    const isSent = (message.labelIds ?? []).includes("SENT");
    const fromAddrs = parseAddressList(headerValue(message, "From"));
    const toAddrs = parseAddressList(headerValue(message, "To"));
    const ccAddrs = parseAddressList(headerValue(message, "Cc"));

    for (const addr of fromAddrs) {
      const email = normalizeEmail(addr.email);
      if (email === selfEmail) continue;
      upsertParticipant(fromMap, email, addr.displayName);
    }
    for (const addr of toAddrs) {
      const email = normalizeEmail(addr.email);
      if (isSent && email !== selfEmail) sentToSet.add(email);
      if (email === selfEmail) continue;
      upsertParticipant(toMap, email, addr.displayName);
    }
    for (const addr of ccAddrs) {
      const email = normalizeEmail(addr.email);
      if (isSent && email !== selfEmail) sentToSet.add(email);
      if (email === selfEmail) continue;
      upsertParticipant(ccMap, email, addr.displayName);
    }
  }

  return {
    pageID,
    threadID: thread.id,
    subject: subject.length > 0 ? subject : "(no subject)",
    labels: [...labelSet].sort(),
    snippet,
    lastMessageAt: new Date(lastMessageAtMs > 0 ? lastMessageAtMs : 0).toISOString(),
    messageCount: messages.length,
    fromParticipants: [...fromMap.values()],
    toParticipants: [...toMap.values()],
    ccParticipants: [...ccMap.values()],
    sentToAddresses: [...sentToSet],
    messageIds: messages.map((m) => m.id).filter((id): id is string => Boolean(id)),
  };
}

/** The provider-owned fields this worker will write to a materialized
 *  EmailThread page — mirrors `calendar-materialization.ts`'s
 *  `EVENT_OWNED_FIELDS`/`eventFieldBaselineHashes` shape exactly (see this
 *  file's header, "PER-FIELD BASELINE HASHING"). `from`/`to`/`cc` hash the
 *  FINAL, quality-gated, deduped+sorted Person PAGE ID sets — i.e. exactly
 *  what `gmail-materialized-doc.ts` will actually write as edges — not the
 *  raw participant email lists, so a participant crossing the quality gate
 *  (and thus gaining/losing a page-id in the desired edge set) correctly
 *  registers as a changed field, while a non-qualifying participant simply
 *  never entering the set at all doesn't spuriously mark the field
 *  "changed" every cycle. */
export const EMAIL_THREAD_OWNED_FIELDS = ["subject", "labels", "snippet", "lastMessageAt", "messageCount", "from", "to", "cc"] as const;

export type EmailThreadOwnedField = (typeof EMAIL_THREAD_OWNED_FIELDS)[number];

export interface MaterializedThreadFields {
  subject: string;
  labels: readonly string[];
  snippet: string;
  lastMessageAt: string;
  messageCount: number;
  /** Already quality-gated, deduped Person page ids — see this constant's
   *  doc comment above. */
  fromPageIDs: readonly string[];
  toPageIDs: readonly string[];
  ccPageIDs: readonly string[];
}

export async function emailThreadFieldBaselineHashes(
  fields: MaterializedThreadFields,
): Promise<Record<EmailThreadOwnedField, string>> {
  const entries = await Promise.all(
    EMAIL_THREAD_OWNED_FIELDS.map(async (field) => {
      const canonical = JSON.stringify(
        field === "subject"
          ? fields.subject
          : field === "labels"
            ? [...fields.labels].sort()
            : field === "snippet"
              ? fields.snippet
              : field === "lastMessageAt"
                ? fields.lastMessageAt
                : field === "messageCount"
                  ? fields.messageCount
                  : field === "from"
                    ? [...new Set(fields.fromPageIDs)].sort()
                    : field === "to"
                      ? [...new Set(fields.toPageIDs)].sort()
                      : [...new Set(fields.ccPageIDs)].sort(),
      );
      return [field, await sha256Hex(canonical)] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<EmailThreadOwnedField, string>;
}
