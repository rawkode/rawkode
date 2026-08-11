// @enchiridion/worker-gatekeeper-google — SQLite read/write for
// `pending_approvals` + `action_log` (schema.ts, points 5/6). Plain
// functions over a `SqlExecutor`, no DO/Workers-runtime dependency — same
// testable pattern as `token-store.ts`/`oauth-state.ts`.
//
// FIRST-WRITER-WINS CAS: `tryConfirmApproval` follows the exact same
// "SELECT then unconditionally act, no `await` in between" atomicity
// idiom `oauth-state.ts`'s `consumeOAuthState` already establishes and
// documents — a Durable Object processes one synchronous span of a single
// RPC call without interleaving another call's code (JS run-to-completion;
// DOs only yield at real `await` points), so a plain read-then-write with
// no intervening `await` is race-free even though this module holds no
// explicit lock. The `UPDATE ... WHERE status = 'pending' AND
// version_token = ?` guard is defense-in-depth/documentation, not the
// actual race-closing mechanism — see this file's `tryConfirmApproval` for
// the full reasoning. The real Google Calendar API mutation (a genuine
// network `await`) only happens AFTER this transition commits
// (`write-model.ts`), specifically so a second, racing `confirmApproval`
// call sees the already-flipped `status` in ITS OWN synchronous read and
// correctly reports `conflict` — no window where two callers could both
// believe they "won".
//
// ── MIGRATED TO EFFECT, PARTIALLY AND DELIBERATELY (plan §Effect-TS
// Application-Code Migration, P9, Step 4 — reuses `effect-runtime.ts`'s
// conventions from Steps 2/3) ──
//
// Only the RECONCILIATION STATE MACHINE — `tryConfirmApproval`,
// `markExecuted`, `markFailed`, `reconcileStuckConfirmedApprovals` — is
// modeled as Effect programs below. `proposeApproval`/`getApproval`/
// `listPendingApprovals`/`appendActionLog`/`decodeRow` stay plain
// functions, UNCHANGED: they're straightforward CRUD-shaped
// reads/inserts with no CAS/guard/race shape at all, and the plan's own
// non-goals are explicit that such code "get[s] no benefit from Effect
// and should stay plain" — migrating them would be churn for its own
// sake, not earned by this file's bug history.
//
// WHY THIS FILE'S RACE WAS ALREADY CLOSED, AND WHAT EFFECT ACTUALLY ADDS:
// unlike `token-refresh.ts` (Step 2, a genuine unenforced race) and
// `calendar-ingest-cycle.ts` (Step 3, a genuine unenforced race), this
// file's P7/P8 guard (`markExecuted`/`markFailed`'s `AND status =
// 'confirmed'`, mirrored by `reconcileStuckConfirmedApprovals`'s own
// guarded UPDATE) was ALREADY a correct, closed fix before this
// migration — it works via one synchronous SQL `UPDATE ... WHERE ...`
// statement per transition (SQLite guarantees a single statement is
// atomic against the row's CURRENT state) plus this file's header's
// "no `await` means no interleaving" argument. There was no dangling
// race here for Effect to close. What this migration DOES add:
//   1. A concrete, load-bearing SAFETY RAIL against a very real risk for
//      whoever touches this file next: an Effect-adjacent module is one
//      accidental `Effect.tryPromise`/`Effect.sleep` away from silently
//      becoming asynchronous, which would REOPEN this exact race by
//      inserting the very `await` point the whole guard argument depends
//      on not existing. See `effect-runtime.ts`'s `runEffectSync` header
//      for how the synchronous boundary makes that failure mode loud and
//      immediate (a thrown `AsyncFiberException`) instead of a silent,
//      shipped regression.
//   2. A genuinely new kind of test (`approvals-store.test.ts`'s
//      "Effect migration" describe block) that simulates the real
//      `write-model.ts confirmApproval` shape — a slow in-flight
//      confirmation racing the cron sweep — using Effect's `Fiber`s and
//      `TestClock` to interleave them DETERMINISTICALLY by virtual time,
//      rather than the pre-existing tests' manual call-ordering (which
//      proves the guard's SQL logic but not that it survives real
//      interleaved scheduling).
import { Effect } from "effect";
import { runEffectSync } from "./effect-runtime";
import type { SqlExecutor } from "./schema";

// "sendEmail" added alongside the original two Calendar action kinds
// (plan §Google gatekeeper's third write-model RPC, "Gmail: ... send behind
// approval") — this widening was ORIGINALLY the only change this file
// needed: `proposeApproval`, `tryConfirmApproval`, `markExecuted`/
// `markFailed` remain fully action-kind-agnostic (they read/write
// `action_type` as an opaque string, never branching on its value), and
// `schema.ts`'s `pending_approvals`/`action_log` tables store
// `action_type TEXT NOT NULL` with no CHECK constraint restricting it to a
// fixed set. `reconcileStuckConfirmedApprovals` is the ONE exception, added
// by a later adversarial-review fix (Fix 2, below) — everything else about
// this file's kind-agnostic design still holds.
//
// FIX 2 (adversarial review, plan §Google gatekeeper "Google gatekeeper"
// section): reusing the generic wall-clock-only stuck-approval sweep
// verbatim for `sendEmail` is unsafe. The sweep infers "failed" purely from
// elapsed time with NO check against the provider — an acceptable
// approximation for Calendar (a false failure just orphans a re-triable
// duplicate event) but not for Gmail send (a false failure invites a retry
// that could send a REAL duplicate message to an external recipient,
// which cannot be undone).
//
// The FULL fix would be: before flipping a stuck `sendEmail` approval to
// `failed`, search Gmail (`messages.list?q=rfc822msgid:<Message-ID>`) to
// check whether the message was actually sent despite the DO interruption,
// and mark `executed` instead of `failed` if it was. That requires an
// access token + a live Gmail API round-trip from inside what is otherwise
// a pure-SQL module — `provider_message_id` (this table's new column, see
// schema.ts) and `gmail-send.ts`'s `generateGmailMessageId` lay the
// groundwork for it (the Message-ID to search for exists and is persisted
// at PROPOSE time, before send even runs), but the actual search-and-verify
// round-trip is NOT wired up in this pass — tracked as a follow-up (search
// for "TODO(gmail-verify-reconciliation)" in this file and
// `write-model.ts`).
//
// What ships instead (the safer fallback the task brief explicitly
// sanctions when full verification is too large to land well-tested in one
// pass): a stuck `sendEmail` approval is reconciled to a DISTINCT terminal
// status, `"unknown"` — never silently reused as `"failed"`. This is enough
// on its own to close the dangerous part of the bug: nothing in this
// codebase treats `"unknown"` as "safe to retry" (unlike `"failed"`, which
// invites exactly that), so an automated/blind retry can never fire against
// an approval whose actual outcome was never confirmed. A human still has
// to look — the `"unknown"` row's `result.error` names the Message-ID to
// grep the Sent folder for.
//
// "archiveThread" | "applyLabel" | "removeLabel" | "markRead" |
// "markUnread" ADDED (Gmail triage write-model task): confirmed this
// file's "zero core changes" claim holds for a FIFTH-through-NINTH action
// kind too — `proposeApproval`/`tryConfirmApproval`/`markExecuted`/
// `markFailed` needed no changes at all (still fully action-kind-agnostic).
// `reconcileStuckConfirmedApprovals`'s `isSendEmail` branch below ALSO
// needed no change: its `else` case already lands any non-`sendEmail` kind
// on `"failed"`, which is exactly right for these five — unlike `sendEmail`
// (an irreversible external side effect a false "failed" could invite an
// unsafe blind retry against), archive/label/mark-read/mark-unread are all
// REVERSIBLE (a mis-reconciled "failed" just means proposing a fresh
// archive/label/mark-read/mark-unread action, the same re-triable-duplicate
// risk `createEvent`/`rsvp` already accept) — so they get the SAME
// wall-clock-only `"failed"` treatment as `createEvent`/`rsvp`, not a
// distinct `"unknown"` status. `write-model.ts`'s file header documents
// this same finding from the write-model side.
export type ApprovalActionType =
  | "createEvent"
  | "rsvp"
  | "sendEmail"
  | "archiveThread"
  | "applyLabel"
  | "removeLabel"
  | "markRead"
  | "markUnread";
export type ApprovalStatus = "pending" | "confirmed" | "executed" | "failed" | "unknown";

export interface PendingApproval {
  id: string;
  actionType: ApprovalActionType;
  /** Decoded JSON payload — the action's input (shape depends on
   *  `actionType`; see `write-model.ts`). */
  payload: unknown;
  versionToken: string;
  status: ApprovalStatus;
  /** Decoded JSON outcome — populated once `status` is `executed`
   *  (the created/updated event), `failed` (an error message), or
   *  `unknown` (see this file's Fix 2 comment above). */
  result: unknown;
  createdAt: number;
  updatedAt: number;
  /** RFC 2822 `Message-ID` this approval's outgoing Gmail message carries
   *  (or will carry) — populated only for `sendEmail` approvals, at
   *  propose time. See this file's Fix 2 comment and schema.ts's
   *  `provider_message_id` column comment. */
  providerMessageId?: string;
}

interface ApprovalRow {
  id: string;
  action_type: string;
  payload: string;
  version_token: string;
  status: string;
  result: string | null;
  created_at: number;
  updated_at: number;
  provider_message_id: string | null;
  [key: string]: unknown;
}

function decodeRow(row: ApprovalRow): PendingApproval {
  return {
    id: row.id,
    actionType: row.action_type as ApprovalActionType,
    payload: JSON.parse(row.payload),
    versionToken: row.version_token,
    status: row.status as ApprovalStatus,
    result: row.result ? JSON.parse(row.result) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    providerMessageId: row.provider_message_id ?? undefined,
  };
}

function appendActionLog(
  sql: SqlExecutor,
  entry: { approvalId: string | undefined; actionType: ApprovalActionType; payload: unknown; outcome: string; createdAt: number },
): void {
  sql.exec(
    `INSERT INTO action_log (id, approval_id, action_type, payload, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    `action_${crypto.randomUUID()}`,
    entry.approvalId ?? null,
    entry.actionType,
    JSON.stringify(entry.payload),
    entry.outcome,
    entry.createdAt,
  );
}

/** Creates a new `pending` approval row + its `proposed` action-log entry.
 *  Returns the version token the caller must present to `confirmApproval`
 *  — see `write-model.ts`'s `proposeCreateEvent`/`proposeRsvp`.
 *  `providerMessageId` (Fix 2) is optional and, in practice, only ever
 *  passed by `write-model.ts`'s `proposeSendEmail` — see this file's Fix 2
 *  comment above `ApprovalStatus`. */
export function proposeApproval(
  sql: SqlExecutor,
  input: { actionType: ApprovalActionType; payload: unknown; providerMessageId?: string },
  now: number,
): PendingApproval {
  const approval: PendingApproval = {
    id: `approval_${crypto.randomUUID()}`,
    actionType: input.actionType,
    payload: input.payload,
    versionToken: crypto.randomUUID(),
    status: "pending",
    result: undefined,
    createdAt: now,
    updatedAt: now,
    providerMessageId: input.providerMessageId,
  };
  sql.exec(
    `INSERT INTO pending_approvals (id, action_type, payload, version_token, status, result, created_at, updated_at, provider_message_id)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    approval.id,
    approval.actionType,
    JSON.stringify(approval.payload),
    approval.versionToken,
    approval.status,
    approval.createdAt,
    approval.updatedAt,
    approval.providerMessageId ?? null,
  );
  appendActionLog(sql, { approvalId: approval.id, actionType: approval.actionType, payload: approval.payload, outcome: "proposed", createdAt: now });
  return approval;
}

export function getApproval(sql: SqlExecutor, id: string): PendingApproval | undefined {
  const row = sql
    .exec<ApprovalRow>(
      "SELECT id, action_type, payload, version_token, status, result, created_at, updated_at, provider_message_id FROM pending_approvals WHERE id = ?",
      id,
    )
    .toArray()[0];
  return row ? decodeRow(row) : undefined;
}

export function listPendingApprovals(sql: SqlExecutor): PendingApproval[] {
  return sql
    .exec<ApprovalRow>(
      "SELECT id, action_type, payload, version_token, status, result, created_at, updated_at, provider_message_id FROM pending_approvals WHERE status = 'pending' ORDER BY created_at ASC",
    )
    .toArray()
    .map(decodeRow);
}

export type ConfirmOutcome =
  | { status: "confirmed"; approval: PendingApproval }
  | { status: "conflict"; reason: string };

/** Effect-program form of `tryConfirmApproval` — see this file's header
 *  ("MIGRATED TO EFFECT, PARTIALLY AND DELIBERATELY") for why this stays
 *  built ENTIRELY from synchronous steps (`Effect.sync`/plain function
 *  calls, never `Effect.tryPromise`/`Effect.sleep`/anything that
 *  suspends) — `tryConfirmApproval` below round-trips this through
 *  `runEffectSync`, which only works, and is only SAFE to keep using
 *  here, because this Effect never actually does async work. Logic is
 *  byte-identical to the pre-migration implementation. */
function tryConfirmApprovalEffect(
  sql: SqlExecutor,
  approvalId: string,
  versionToken: string,
  now: number,
): Effect.Effect<ConfirmOutcome> {
  return Effect.sync((): ConfirmOutcome => {
    const existing = getApproval(sql, approvalId);
    if (!existing) {
      return { status: "conflict", reason: "unknown approval id" };
    }
    if (existing.status !== "pending") {
      appendActionLog(sql, { approvalId, actionType: existing.actionType, payload: existing.payload, outcome: "conflict:already-" + existing.status, createdAt: now });
      return { status: "conflict", reason: `approval is already "${existing.status}"` };
    }
    if (existing.versionToken !== versionToken) {
      appendActionLog(sql, { approvalId, actionType: existing.actionType, payload: existing.payload, outcome: "conflict:stale-version-token", createdAt: now });
      return { status: "conflict", reason: "version token does not match — this approval was already confirmed by another caller" };
    }

    sql.exec(
      `UPDATE pending_approvals SET status = 'confirmed', updated_at = ? WHERE id = ? AND version_token = ? AND status = 'pending'`,
      now,
      approvalId,
      versionToken,
    );
    const confirmed: PendingApproval = { ...existing, status: "confirmed", updatedAt: now };
    appendActionLog(sql, { approvalId, actionType: existing.actionType, payload: existing.payload, outcome: "confirmed", createdAt: now });
    return { status: "confirmed", approval: confirmed };
  });
}

/** First-writer-wins compare-and-swap: `pending -> confirmed`, gated on
 *  `versionToken` matching AND the row still being `pending`. See this
 *  file's header for the atomicity argument. Logs `confirmed` (on
 *  success) or `conflict` (on failure) to `action_log` either way — the
 *  audit trail should show every confirmation ATTEMPT, not just
 *  successful ones, so a losing racer's attempt is visible later.
 *
 *  STAYS SYNCHRONOUS (returns `ConfirmOutcome` directly, not a `Promise`)
 *  — `runEffectSync` (not `runEffectAsPromise`) is the boundary here on
 *  purpose; see this file's header and `effect-runtime.ts`'s
 *  `runEffectSync` doc comment. */
export function tryConfirmApproval(sql: SqlExecutor, approvalId: string, versionToken: string, now: number): ConfirmOutcome {
  return runEffectSync(tryConfirmApprovalEffect(sql, approvalId, versionToken, now));
}

/** Terminal transition after the real Google Calendar mutation succeeds —
 *  called only right after `tryConfirmApproval` returned `"confirmed"`
 *  within the SAME RPC call (see `write-model.ts`). In the common case this
 *  approval's `confirmed -> executed` step has no concurrent competitor (a
 *  second `confirmApproval` call for the same id already got rejected by
 *  the CAS above, at the `pending -> confirmed` step) — BUT the in-flight
 *  `await` between that CAS and this call (the real Google/Gmail API
 *  round-trip) is exactly the window `reconcileStuckConfirmedApprovals`
 *  sweeps: if this call is slow enough that the cron sweep already
 *  reconciled the row to `"failed"`/`"unknown"` out from under it, this
 *  UPDATE must NOT clobber that terminal status (adversarial-review
 *  finding — see this file's Fix 2 comment block and
 *  `reconcileStuckConfirmedApprovals`'s own `AND status = 'confirmed'`
 *  guard, which this mirrors). Guarding on `status = 'confirmed'` is
 *  correct here: `confirmed` is this function's only valid pre-state
 *  (`tryConfirmApproval` always runs first in the same call), so the guard
 *  never rejects a legitimate write and only ever blocks the
 *  already-reconciled race.
 *
 *  STAYS SYNCHRONOUS — see `tryConfirmApproval`'s doc comment and this
 *  file's header for why. */
export function markExecuted(sql: SqlExecutor, approvalId: string, result: unknown, now: number): void {
  runEffectSync(
    Effect.sync(() => {
      sql.exec(
        `UPDATE pending_approvals SET status = 'executed', result = ?, updated_at = ? WHERE id = ? AND status = 'confirmed'`,
        JSON.stringify(result),
        now,
        approvalId,
      );
      const approval = getApproval(sql, approvalId);
      appendActionLog(sql, { approvalId, actionType: approval?.actionType ?? "createEvent", payload: approval?.payload, outcome: "executed", createdAt: now });
    }),
  );
}

/** Terminal transition when the real Google Calendar mutation fails after
 *  confirmation — deliberately does NOT revert to `pending` (see
 *  schema.ts's file header point 5): a failed approval stays failed;
 *  retrying means proposing a fresh approval, not reopening a window where
 *  a second caller could race the retry.
 *
 *  Same `AND status = 'confirmed'` guard as `markExecuted` above, and for
 *  the identical reason: this call's only valid pre-state is `confirmed`
 *  (it runs right after `tryConfirmApproval` in the same RPC call), so the
 *  guard is a no-op in the normal path and only ever blocks a slow caller
 *  from overwriting a status `reconcileStuckConfirmedApprovals` already
 *  reconciled to a terminal state while this call was still in flight.
 *
 *  STAYS SYNCHRONOUS — see `tryConfirmApproval`'s doc comment and this
 *  file's header for why. */
export function markFailed(sql: SqlExecutor, approvalId: string, errorMessage: string, now: number): void {
  runEffectSync(
    Effect.sync(() => {
      sql.exec(
        `UPDATE pending_approvals SET status = 'failed', result = ?, updated_at = ? WHERE id = ? AND status = 'confirmed'`,
        JSON.stringify({ error: errorMessage }),
        now,
        approvalId,
      );
      const approval = getApproval(sql, approvalId);
      appendActionLog(sql, { approvalId, actionType: approval?.actionType ?? "createEvent", payload: approval?.payload, outcome: "failed", createdAt: now });
    }),
  );
}

/** STUCK-"confirmed"-APPROVAL RECONCILIATION (adversarial-review finding,
 *  plan §Google gatekeeper): `write-model.ts`'s `confirmApproval` commits
 *  the `pending -> confirmed` CAS transition synchronously, then `await`s
 *  token refresh and the real Google API call before reaching
 *  `markExecuted`/`markFailed`. If the DO is interrupted in between
 *  (isolate eviction, a mid-request deploy, a CPU-limit kill), the row is
 *  permanently stuck at `confirmed` — `tryConfirmApproval` only
 *  transitions `pending` rows, so a stuck `confirmed` row can NEVER be
 *  retried through the normal confirm path, and nothing else ever revisits
 *  it.
 *
 *  This sweep finds every `confirmed` row whose `updated_at` (the CAS
 *  commit timestamp — see schema.ts's file header point 5) is more than
 *  `timeoutMs` in the past and transitions it to a terminal state, with a
 *  reason that makes the cause legible to whoever's debugging it.
 *
 *  ACTION-KIND-SPECIFIC BRANCH (Fix 2, see this file's header comment above
 *  `ApprovalStatus` for the full argument): `createEvent`/`rsvp`/
 *  `archiveThread`/`applyLabel`/`removeLabel`/`markRead`/`markUnread` rows
 *  go to `"failed"` exactly as before this fix — a false failure there just
 *  orphans a re-triable duplicate event or triage action (all seven are
 *  reversible), so wall-clock-only inference is an acceptable approximation
 *  and nothing about that path changed. `sendEmail` rows go to `"unknown"`
 *  instead — wall-clock elapsed time
 *  alone cannot distinguish "the send never happened" from "the send
 *  happened but the DO died before recording it", and for an irreversible
 *  external side effect, `"failed"` would be a dangerously confident label
 *  to apply on a guess (it invites an automated/blind retry that could
 *  double-send a real email). `"unknown"` carries the Message-ID
 *  (`provider_message_id`) to check the Sent folder against — see
 *  `gmail-send.ts`'s "MESSAGE-ID / IDEMPOTENCY" header comment.
 *  TODO(gmail-verify-reconciliation): search Gmail
 *  (`messages.list?q=rfc822msgid:<id>`) here before choosing `"unknown"`
 *  over `"failed"`/`"executed"` — not implemented in this pass, see this
 *  file's Fix 2 header comment for why.
 *
 *  Called by `GoogleAccountDO.reconcileStuckApprovals()` (via
 *  `write-model.ts`'s `reconcileStuckApprovals` wrapper), from `index.ts`'s
 *  `scheduled()` handler on the same 5-minute cron cadence as calendar
 *  ingest — see that file for the chosen timeout and rationale. Returns
 *  the ids it reconciled (mostly for tests/observability; callers don't
 *  need to act on them — a reconciled id may have landed at `"failed"` OR
 *  `"unknown"`, see `getApproval` if the distinction matters to a caller).
 *
 *  STAYS SYNCHRONOUS — see `tryConfirmApproval`'s doc comment and this
 *  file's header for why. */
export function reconcileStuckConfirmedApprovals(sql: SqlExecutor, timeoutMs: number, now: number): string[] {
  return runEffectSync(
    Effect.sync(() => {
      const staleBefore = now - timeoutMs;
      const stuck = sql
        .exec<ApprovalRow>(
          `SELECT id, action_type, payload, version_token, status, result, created_at, updated_at, provider_message_id
           FROM pending_approvals WHERE status = 'confirmed' AND updated_at <= ? ORDER BY updated_at ASC`,
          staleBefore,
        )
        .toArray()
        .map(decodeRow);

      const reconciledIds: string[] = [];
      for (const approval of stuck) {
        const isSendEmail = approval.actionType === "sendEmail";
        const status: ApprovalStatus = isSendEmail ? "unknown" : "failed";
        const errorMessage = isSendEmail
          ? `confirmation timed out — Gmail send outcome could not be confirmed automatically; verify the Sent folder before retrying (Message-ID: ${approval.providerMessageId ?? "unknown"})`
          : "confirmation timed out — DO likely interrupted mid-execution";

        // Guarded by `status = 'confirmed'` so this never clobbers a row
        // that reached a terminal state through the normal path between
        // this SELECT and this UPDATE (no `await` between them — same
        // run-to-completion argument this file's header makes for
        // `tryConfirmApproval`'s CAS).
        sql.exec(
          `UPDATE pending_approvals SET status = ?, result = ?, updated_at = ? WHERE id = ? AND status = 'confirmed'`,
          status,
          JSON.stringify({ error: errorMessage }),
          now,
          approval.id,
        );
        appendActionLog(sql, {
          approvalId: approval.id,
          actionType: approval.actionType,
          payload: approval.payload,
          outcome: isSendEmail ? "unknown:confirmation-timeout" : "failed:confirmation-timeout",
          createdAt: now,
        });
        reconciledIds.push(approval.id);
      }
      return reconciledIds;
    }),
  );
}
