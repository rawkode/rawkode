// @enchiridion/worker-gatekeeper-google — Gmail cron ingest orchestration
// ("P3: Gmail", plan §Google gatekeeper).
//
// Mirrors `calendar-ingest.ts`'s role and shape (see that file's header for
// the general pattern this follows). Pure function over an injected
// `SqlExecutor`/`accessToken`/`now`/`fetchImpl` — no DO/Workers-runtime
// dependency, directly unit-testable — `gmail-ingest-cycle.ts` (mirroring
// `calendar-ingest-cycle.ts`) is the reentrancy-guarded, scope-gated
// wrapper `google-account-do.ts`'s `runGmailIngestCycle()` RPC calls.
//
// TWO SYNC MODES, exactly like Calendar's `syncToken`-vs-time-window split,
// but Gmail's shapes differ enough to need its own state machine:
//
//   1. CHUNKED, RESUMABLE BACKFILL (`gmail_backfill_state`, schema.ts point
//      8) — runs whenever backfill hasn't completed yet (including the
//      very first ever cron tick). ONE PAGE of `threads.list` per cron
//      tick, size-bounded by `BACKFILL_BATCH_SIZE` (see that constant's
//      doc comment for why 50), scoped to `BACKFILL_QUERY` (last 12
//      months — see that constant's doc comment). The persisted
//      `page_token` means a slow-to-complete backfill (a large mailbox
//      could take many cron ticks) resumes exactly where the last tick
//      left off, rather than restarting from page 1 every 5 minutes — the
//      SAME resumability shape Calendar's `syncToken` gives incremental
//      sync, applied to Gmail's *first-time* sync instead (Calendar has no
//      analogous "first sync is itself multi-tick" problem, since its
//      windowed full-resync always completes in one `fetchAllPages` call —
//      Gmail's backfill deliberately does NOT do that, specifically to
//      respect the plan's "bounded batches ... to respect Workers CPU
//      limits and Gmail quotas" requirement, which Calendar's own initial
//      sync doesn't have to contend with at personal-mailbox scale).
//   2. `history.list` INCREMENTAL SYNC, once backfill's `completed` flag is
//      set — the `historyId` cursor (`sync_cursors` resource `"gmail"`),
//      with the SAME 404-triggers-fallback shape Calendar's 410 gets (see
//      `runIncrementalSync`'s doc comment for the exact recovery chosen).
//
// CURSOR-AFTER-BATCH + POISON-PILL ISOLATION, applied to BOTH modes' own
// cursor (backfill's `page_token`/`completed`, incremental's `historyId`):
// exactly Calendar's already-adversarially-reviewed fix
// (`calendar-ingest.ts`'s file header), reproduced here from the START
// rather than discovered by a second review. Every batch this file
// processes goes through the SAME two-pass shape:
//   PASS 1 — fetch + normalize each thread, recording every observed
//     "the user sent TO this address" fact into the participant ledger
//     (`gmail-participants-store.ts`'s `recordSentTo`) as it goes;
//   PASS 2 — materialize each successfully-normalized thread, now against
//     the FULLY updated ledger (so a participant who crosses the quality
//     gate partway through pass 1, because of a LATER thread in the SAME
//     batch, still gets counted as qualifying for an EARLIER thread in
//     that same batch — see `gmail-materialization.ts`'s header for the
//     cross-BATCH staleness case this does NOT solve, which is accepted
//     and documented there).
// Each pass wraps its own per-thread work in a try/catch
// (`gmail-ingest-failures-store.ts` records the failure, mirroring
// `ingest-failures-store.ts`) — one bad thread costs exactly that thread,
// never its batch siblings, and the cursor (whichever mode is active)
// only ever advances ONCE, after the WHOLE batch (both passes) has been
// attempted.
//
// BACKFILL pageToken FAILURE RECOVERY (MAJOR fix, adversarial review):
// unlike `historyId` (Google documents a ~7-day retention floor,
// `runIncrementalSync` below handles its 404 explicitly), Google does NOT
// guarantee a `threads.list` `pageToken` stays valid indefinitely across a
// multi-day backfill. `runBackfillBatch`'s call to `listThreadsPage` is
// wrapped in a try/catch that treats a `GmailApiError` with `status ===
// 400` on a RESUMED page (a real stored `pageToken`, never the very first
// page) as "this pageToken is dead" (Google's actual wire shape for an
// invalid/expired page token — see `isInvalidPageTokenError`'s doc
// comment for why this is the one status treated as non-retriable and not,
// say, 401/403/429/5xx). Recovery mirrors `runIncrementalSync`'s 404
// handling EXACTLY: `gmail_backfill_state` resets to `{pageToken:
// undefined, completed: false}` and the SAME cycle immediately retries
// with a fresh page 1 (not deferred to "whenever the next tick fires") —
// chosen over next-tick-only recovery for the same reason as the
// `historyId` case: it makes the self-heal observably complete THIS
// result (`backfillPageTokenReset: true` plus a real, non-zero
// `threadCount`/`materializedCount` from the fresh page 1 batch), rather
// than a cycle that merely "didn't crash" while still doing zero forward
// progress. The self-heal is recorded in `gmail_ingest_failures` under
// `BACKFILL_PAGE_TOKEN_RESET_MARKER` (see that constant's doc comment) so
// it is queryable and distinguishable from both an ordinary per-thread
// materialization failure (a real thread id) and the now-closed "silently
// wedged forever" failure mode (which, before this fix, left
// `gmail_backfill_state.page_token` pointed at the same dead token with
// NOTHING recorded here at all, since the error propagated straight past
// this store to `scheduled()`'s `AggregateError` logging on every single
// subsequent cron tick, forever).

import {
  getThread,
  getUserProfile,
  listHistoryPage,
  listThreadsPage,
  GmailApiError,
  GmailHistoryIdExpiredError,
  type FetchLike,
  type GmailHistoryListResponse,
  type GmailThreadsListResponse,
  type GmailThread,
} from "./gmail-api";
import { normalizeEmail } from "./gmail-address";
import { normalizeThread, type NormalizedThread } from "./gmail-materialization";
import { materializeEmailThread } from "./gmail-thread-materialization";
import { getGmailBackfillState, setGmailBackfillState } from "./gmail-backfill-store";
import { recordSentTo } from "./gmail-participants-store";
import { recordGmailIngestFailure, BACKFILL_PAGE_TOKEN_RESET_MARKER } from "./gmail-ingest-failures-store";
import { getSyncCursor, setSyncCursor } from "./token-store";
import type { SqlExecutor } from "./schema";
import type { VaultClientEnv } from "./vault-client";

const GMAIL_SYNC_RESOURCE = "gmail";
const SELF_EMAIL_RESOURCE = "gmail_self_email";

/** Threads fetched (via `threads.get`) and attempted per cron tick during
 *  backfill. Documented choice, not a Google-mandated value (mirrors
 *  `calendar-ingest.ts`'s `FULL_SYNC_WINDOW_*` framing): 50 threads/tick
 *  means each tick makes ~51 Gmail API calls (one `threads.list` + up to
 *  50 `threads.get`), comfortably inside both a Workers cron invocation's
 *  CPU budget and Gmail's per-user rate limits (250 quota units/user/sec;
 *  `threads.get` costs 10 units, so 50 calls costs ~500 units — spread
 *  across the several real-world seconds a tick actually takes to run
 *  sequentially, not a single-instant burst), while still completing a
 *  multi-thousand-thread mailbox's backfill in a bounded number of ticks
 *  (5-minute cadence * enough ticks) rather than either timing out a
 *  single tick or waiting a huge number of ticks. */
export const BACKFILL_BATCH_SIZE = 50;

/** Backfill window — Gmail search-syntax `newer_than:365d`, i.e. the last
 *  12 months. Documented choice (plan explicitly leaves this to this
 *  task's judgment: "scoped to a configurable window (e.g. last 12 months
 *  or label-filtered)"): 12 months balances "enough history for the
 *  assistant/graph to be useful for recent context" against "don't spend
 *  potentially hundreds of backfill ticks walking a decade of mail before
 *  incremental sync ever kicks in" — mirrors Calendar's own documented,
 *  non-Google-mandated window choice (30 days back / 180 days forward)
 *  for the identical reasoning. Threads OLDER than this window are simply
 *  never backfilled by this pass — a real limitation (not every
 *  historical thread becomes an EmailThread page), acceptable for a
 *  personal-assistant-grounding use case per the plan's own framing, and
 *  revisitable (a wider window, or a second explicit "deep backfill"
 *  mode) without any data-model change if ever needed. */
export const BACKFILL_QUERY = "newer_than:365d";

export interface GmailIngestDeps {
  sql: SqlExecutor;
  env: VaultClientEnv;
  accessToken: string;
  now: Date;
  fetchImpl?: FetchLike;
}

export interface GmailIngestResult {
  mode: "backfill" | "incremental";
  /** Threads ATTEMPTED this cycle (fetched via `threads.get` in backfill
   *  mode, or discovered via `history.list`'s `messagesAdded` records in
   *  incremental mode) — includes threads that failed (see `failedCount`). */
  threadCount: number;
  materializedCount: number;
  skippedCount: number;
  failedCount: number;
  /** `true` exactly on the ONE cycle whose backfill batch was the last
   *  page (no `nextPageToken`) — the cycle that flips
   *  `gmail_backfill_state.completed` to `true` and seeds the initial
   *  `historyId` baseline. `false` on every other cycle, including every
   *  incremental-mode cycle. */
  backfillCompleted: boolean;
  /** `true` when this cycle hit a `404` (expired `historyId`) on
   *  `history.list` and re-baselined via a fresh backfill batch — see
   *  `runIncrementalSync`'s doc comment. */
  historyIdExpired: boolean;
  /** `true` when this cycle hit an invalid/expired `threads.list`
   *  `pageToken` mid-backfill and re-baselined by discarding it and
   *  retrying page 1 within the SAME cycle — see this file's header,
   *  "BACKFILL pageToken FAILURE RECOVERY", and `isInvalidPageTokenError`.
   *  `false` on every other cycle, including a normal `historyIdExpired`
   *  re-baseline (that's a different cursor, this flag is specific to the
   *  backfill pageToken). */
  backfillPageTokenReset: boolean;
}

/** Resolves (and caches, in `sync_cursors` resource `"gmail_self_email"`)
 *  the account owner's own email address — needed so
 *  `gmail-materialization.ts`'s `normalizeThread` can exclude "yourself"
 *  from every thread's participant edges (see that module's header).
 *  Fetched via `users.getProfile` at most ONCE ever per account (the
 *  cached value is trusted indefinitely — a Google account's primary
 *  address does not change for this worker's single-account lifetime;
 *  revisiting that assumption is out of this pass's scope). */
async function resolveSelfEmail(deps: GmailIngestDeps): Promise<string> {
  const cached = getSyncCursor(deps.sql, SELF_EMAIL_RESOURCE);
  if (cached) return cached;
  const profile = await getUserProfile({ accessToken: deps.accessToken, fetchImpl: deps.fetchImpl });
  const normalized = normalizeEmail(profile.emailAddress);
  setSyncCursor(deps.sql, SELF_EMAIL_RESOURCE, normalized, deps.now.getTime());
  return normalized;
}

interface BatchOutcome {
  threadCount: number;
  materializedCount: number;
  skippedCount: number;
  failedCount: number;
}

/** The shared two-pass batch logic (see this file's header) — takes
 *  already-fetched raw `GmailThread` resources (backfill's `threads.get`
 *  results, or incremental sync's re-fetched affected threads) and runs
 *  them through normalize+ledger-update (pass 1) then materialize (pass
 *  2). Deliberately does NOT touch either mode's own cursor — callers
 *  persist their cursor ONCE, after this returns, per the
 *  cursor-after-batch rule. */
async function processBatch(deps: GmailIngestDeps, rawThreads: readonly GmailThread[], selfEmail: string): Promise<BatchOutcome> {
  let skippedCount = 0;
  let failedCount = 0;
  const normalizedThreads: NormalizedThread[] = [];

  // PASS 1 — normalize + update the participant ledger.
  for (const raw of rawThreads) {
    try {
      const normalized = await normalizeThread(raw, selfEmail);
      if (!normalized) {
        skippedCount += 1;
        continue;
      }
      for (const address of normalized.sentToAddresses) {
        recordSentTo(deps.sql, address, deps.now.getTime());
      }
      normalizedThreads.push(normalized);
    } catch (error) {
      failedCount += 1;
      recordGmailIngestFailure(
        deps.sql,
        { threadId: raw.id ?? null, errorMessage: error instanceof Error ? error.message : String(error) },
        deps.now.getTime(),
      );
    }
  }

  // PASS 2 — materialize against the now-fully-updated ledger.
  let materializedCount = 0;
  for (const thread of normalizedThreads) {
    try {
      const result = await materializeEmailThread(deps.sql, deps.env, thread, deps.now);
      if (result.applied) materializedCount += 1;
      else skippedCount += 1;
    } catch (error) {
      failedCount += 1;
      recordGmailIngestFailure(
        deps.sql,
        { threadId: thread.threadID, errorMessage: error instanceof Error ? error.message : String(error) },
        deps.now.getTime(),
      );
    }
  }

  return { threadCount: rawThreads.length, materializedCount, skippedCount, failedCount };
}

/** Is `error` Google's wire shape for "the supplied `threads.list`/
 *  `messages.list` `pageToken` is malformed/expired"? `listThreadsPage`
 *  (`gmail-api.ts`) only ever throws `GmailApiError` for a non-2xx
 *  response, and Google returns a plain `400 Bad Request` for an invalid
 *  page token (there is no dedicated error class for it the way `404`
 *  gets one for `history.list`'s expired `historyId` — Gmail's
 *  `threads.list` simply has no long-lived-cursor concept `historyId` has,
 *  so there's no analogous documented status to special-case beyond the
 *  generic "bad request" Google actually returns). Deliberately narrower
 *  than "any 4xx": `401`/`403` are auth/permission failures and `429` is
 *  rate limiting — none of those are fixed by discarding the page token,
 *  and resetting backfill state for them would silently paper over a
 *  different bug (wasting a full fresh page-1 fetch) while masking the
 *  real cause; `5xx` is a transient server error where the SAME token is
 *  very likely still valid next tick. Only `400` is treated as
 *  "resetting genuinely helps". */
function isInvalidPageTokenError(error: unknown): boolean {
  return error instanceof GmailApiError && error.status === 400;
}

/** Runs one backfill BATCH (one `threads.list` page, up to
 *  `BACKFILL_BATCH_SIZE` threads). Advances `gmail_backfill_state` exactly
 *  once, after the whole batch (both passes) has been attempted — see this
 *  file's header, "CURSOR-AFTER-BATCH". On the batch that exhausts
 *  `threads.list` (no `nextPageToken`), also seeds the initial `historyId`
 *  baseline (`users.getProfile`) so the NEXT cycle can switch to
 *  incremental sync.
 *
 *  See this file's header, "BACKFILL pageToken FAILURE RECOVERY", for the
 *  try/catch around `listThreadsPage` below: a RESUMED page (a real
 *  `storedPageToken`) that fails with `isInvalidPageTokenError` resets
 *  `gmail_backfill_state` and retries page 1 within this SAME call, rather
 *  than throwing out to `scheduled()` and leaving the dead token in place
 *  forever. */
async function runBackfillBatch(
  deps: GmailIngestDeps,
  selfEmail: string,
  storedPageToken: string | undefined,
  historyIdExpired: boolean,
): Promise<GmailIngestResult> {
  let listResponse: GmailThreadsListResponse;
  try {
    listResponse = await listThreadsPage({
      accessToken: deps.accessToken,
      q: BACKFILL_QUERY,
      pageToken: storedPageToken,
      maxResults: BACKFILL_BATCH_SIZE,
      fetchImpl: deps.fetchImpl,
    });
  } catch (error) {
    // Only a RESUMED page can be "stale" in the sense this recovers from —
    // see `isInvalidPageTokenError`'s doc comment. A page-1 fetch
    // (`storedPageToken === undefined`) failing the identical way is a
    // different bug (bad query syntax, revoked auth, ...) that resetting
    // state cannot fix and would otherwise recurse into an identical call
    // forever; that case propagates normally instead, same as before this
    // fix.
    if (storedPageToken !== undefined && isInvalidPageTokenError(error)) {
      const nowMs = deps.now.getTime();
      recordGmailIngestFailure(
        deps.sql,
        {
          threadId: BACKFILL_PAGE_TOKEN_RESET_MARKER,
          errorMessage: `stale/invalid threads.list pageToken discarded — backfill restarted from the beginning of the window (${BACKFILL_QUERY}): ${error instanceof Error ? error.message : String(error)}`,
        },
        nowMs,
      );
      setGmailBackfillState(deps.sql, { pageToken: undefined, completed: false, updatedAt: nowMs });
      // Retry WITHIN THE SAME CYCLE — mirrors `runIncrementalSync`'s 404
      // handling below (see that function's doc comment for the identical
      // reasoning): this cycle's result should show real forward progress
      // (a genuine page-1 batch outcome), not just "didn't crash".
      const recovered = await runBackfillBatch(deps, selfEmail, undefined, historyIdExpired);
      return { ...recovered, backfillPageTokenReset: true };
    }
    throw error;
  }
  const stubs = listResponse.threads ?? [];

  const rawThreads: GmailThread[] = [];
  const fetchFailures: { threadId: string; errorMessage: string }[] = [];
  for (const stub of stubs) {
    try {
      const thread = await getThread({ accessToken: deps.accessToken, threadId: stub.id, fetchImpl: deps.fetchImpl });
      rawThreads.push(thread);
    } catch (error) {
      fetchFailures.push({ threadId: stub.id, errorMessage: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const failure of fetchFailures) {
    recordGmailIngestFailure(deps.sql, { threadId: failure.threadId, errorMessage: failure.errorMessage }, deps.now.getTime());
  }

  const outcome = await processBatch(deps, rawThreads, selfEmail);
  const nowMs = deps.now.getTime();

  const backfillCompleted = !listResponse.nextPageToken;
  if (backfillCompleted) {
    setGmailBackfillState(deps.sql, { pageToken: undefined, completed: true, updatedAt: nowMs });
    // Seed the incremental-sync baseline the instant backfill finishes —
    // see this file's header on the small, accepted race window this
    // leaves (mail arriving in the gap between the last backfill page and
    // this call is picked up on this worker's NEXT `historyId` poll like
    // any other post-baseline change, so nothing is permanently lost,
    // only possibly delayed by one cycle).
    const profile = await getUserProfile({ accessToken: deps.accessToken, fetchImpl: deps.fetchImpl });
    if (profile.historyId) {
      setSyncCursor(deps.sql, GMAIL_SYNC_RESOURCE, profile.historyId, nowMs);
    }
  } else {
    setGmailBackfillState(deps.sql, { pageToken: listResponse.nextPageToken, completed: false, updatedAt: nowMs });
  }

  return {
    mode: "backfill",
    threadCount: outcome.threadCount + fetchFailures.length,
    materializedCount: outcome.materializedCount,
    skippedCount: outcome.skippedCount,
    failedCount: outcome.failedCount + fetchFailures.length,
    backfillCompleted,
    historyIdExpired,
    backfillPageTokenReset: false,
  };
}

async function fetchAllHistoryPages(deps: GmailIngestDeps, startHistoryId: string): Promise<GmailHistoryListResponse[]> {
  const pages: GmailHistoryListResponse[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const page = await listHistoryPage({
      accessToken: deps.accessToken,
      startHistoryId,
      pageToken,
      fetchImpl: deps.fetchImpl,
    });
    pages.push(page);
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  return pages;
}

/** Runs one incremental-sync cycle via `history.list`. On a `404`
 *  (`GmailHistoryIdExpiredError` — the stored `historyId` is older than
 *  Gmail's ~7-day retention), RE-BASELINES BY RESTARTING BACKFILL FROM
 *  SCRATCH — `gmail_backfill_state` is reset to
 *  `{pageToken: undefined, completed: false}` and this SAME cycle
 *  immediately runs one backfill batch (mirroring
 *  `calendar-ingest.ts`'s 410 handling: the retry happens within the same
 *  cycle, not deferred to "whenever the next tick happens to fire").
 *
 *  CHOSEN OVER "backfill from the current point forward": a fresh
 *  full backfill re-walks the same `BACKFILL_QUERY` window
 *  (`newer_than:365d`) end to end, which correctly SELF-HEALS any thread
 *  whose changes were missed during the expired-cursor gap (a
 *  label toggle, a new message) — re-materializing an unchanged thread is
 *  a guaranteed no-op (the per-field baseline hash matches, see
 *  `gmail-materialization.ts`), so the cost of "just redo the whole
 *  window" is bounded and safe, whereas "resume from now forward" would
 *  permanently skip whatever changed inside the gap with no mechanism to
 *  ever revisit it. This reuses the EXACT SAME chunked/resumable machinery
 *  already built for first-time backfill — no third sync mode. */
async function runIncrementalSync(deps: GmailIngestDeps, selfEmail: string): Promise<GmailIngestResult> {
  const cursor = getSyncCursor(deps.sql, GMAIL_SYNC_RESOURCE);
  if (!cursor) {
    // Defensive: `completed` was true but no cursor was ever recorded —
    // treat identically to an expired cursor (re-baseline via backfill).
    setGmailBackfillState(deps.sql, { pageToken: undefined, completed: false, updatedAt: deps.now.getTime() });
    return runBackfillBatch(deps, selfEmail, undefined, true);
  }

  let pages: GmailHistoryListResponse[];
  try {
    pages = await fetchAllHistoryPages(deps, cursor);
  } catch (error) {
    if (!(error instanceof GmailHistoryIdExpiredError)) throw error;
    setGmailBackfillState(deps.sql, { pageToken: undefined, completed: false, updatedAt: deps.now.getTime() });
    return runBackfillBatch(deps, selfEmail, undefined, true);
  }

  const threadIds = new Set<string>();
  for (const page of pages) {
    for (const record of page.history ?? []) {
      for (const added of record.messagesAdded ?? []) {
        threadIds.add(added.message.threadId);
      }
    }
  }

  const rawThreads: GmailThread[] = [];
  const fetchFailures: { threadId: string; errorMessage: string }[] = [];
  for (const threadId of threadIds) {
    try {
      const thread = await getThread({ accessToken: deps.accessToken, threadId, fetchImpl: deps.fetchImpl });
      rawThreads.push(thread);
    } catch (error) {
      fetchFailures.push({ threadId, errorMessage: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const failure of fetchFailures) {
    recordGmailIngestFailure(deps.sql, { threadId: failure.threadId, errorMessage: failure.errorMessage }, deps.now.getTime());
  }

  const outcome = await processBatch(deps, rawThreads, selfEmail);

  // CURSOR-AFTER-BATCH — only advance once the WHOLE fetched batch (every
  // discovered thread, across every history.list page) has been
  // attempted.
  const finalPage = pages[pages.length - 1];
  if (finalPage?.historyId) {
    setSyncCursor(deps.sql, GMAIL_SYNC_RESOURCE, finalPage.historyId, deps.now.getTime());
  }

  return {
    mode: "incremental",
    threadCount: outcome.threadCount + fetchFailures.length,
    materializedCount: outcome.materializedCount,
    skippedCount: outcome.skippedCount,
    failedCount: outcome.failedCount + fetchFailures.length,
    backfillCompleted: false,
    historyIdExpired: false,
    backfillPageTokenReset: false,
  };
}

/** Runs one full Gmail ingest cycle — backfill or incremental, whichever
 *  `gmail_backfill_state` says applies. See this file's header for the
 *  full mode-switch/cursor/poison-pill design. */
export async function runGmailIngest(deps: GmailIngestDeps): Promise<GmailIngestResult> {
  const selfEmail = await resolveSelfEmail(deps);
  const backfillState = getGmailBackfillState(deps.sql);

  if (!backfillState || !backfillState.completed) {
    return runBackfillBatch(deps, selfEmail, backfillState?.pageToken, false);
  }

  return runIncrementalSync(deps, selfEmail);
}
