// @enchiridion/worker-gatekeeper-google — the write-model shared by
// Calendar AND Gmail: propose -> confirm -> execute, gated by
// `approvals-store.ts`'s first-writer-wins CAS.
//
// Plan §Google gatekeeper: "Writes (send email, create/RSVP event): the
// write-model — narrow typed RPC methods only ..., each gated by an
// approval record confirmed in-app with a version token (conflict on
// stale — the existing assistant-proposal pattern), immutable action
// log... Approval decisions are first-writer-wins with a visible notice to
// the losing device." This file is the DO-runtime-independent orchestration
// (same "plain functions over an injected SqlExecutor/now/fetchImpl"
// pattern every other real-logic module in this worker uses) —
// `google-account-do.ts` exposes thin RPC wrappers, and `index.ts`'s
// `CalendarWriteModel`/`GmailWriteModel` (both `WorkerEntrypoint`s, per the
// plan's "Read/write split" pin: "WorkerEntrypoint-shaped RPC for
// gatekeeper-google") call those RPC methods.
//
// PROPOSE never touches Google's API — it only creates a `pending_approvals`
// row (`approvals-store.ts`'s `proposeApproval`). The REAL mutation
// (`calendar-write-model.ts`'s `createCalendarEvent`/`rsvpToCalendarEvent`,
// or `gmail-send.ts`'s `sendGmailMessage`) only runs inside
// `confirmApproval`, and only after the CAS has already committed the
// `pending -> confirmed` transition — this is what "the server-side
// approval-gate mechanism" the task brief asks for actually means: nothing
// calls Google's mutating endpoints except this one path, reached only
// through an explicit, version-tokened confirmation.
//
// ADDING "sendEmail" AS A THIRD ACTION KIND (original task): confirmed the
// original two-kind (`createEvent`/`rsvp`) design was already built right —
// `tryConfirmApproval`/`markExecuted`/`markFailed` in `approvals-store.ts`
// needed ZERO changes (they're already action-kind-agnostic; see that
// file's header). The only new code this file needed was (a)
// `proposeSendEmail`, a one-line sibling of `proposeCreateEvent`/
// `proposeRsvp`, and (b) one more branch in `confirmApproval`'s "which real
// Google API do I call" dispatch — PLUS the `GMAIL_SEND_SCOPE` gate
// (Gmail's send scope is a separate staged consent from Calendar's, unlike
// `createEvent`/`rsvp` which both already work off whatever scope
// `calendar.events` granted, so this is genuinely new, not something the
// existing two kinds needed).
//
// TWO FOLLOW-UP ADVERSARIAL-REVIEW FIXES (plan §Google gatekeeper): Fix 1
// (RFC 2822 header injection) added `validateSendEmailInput` at the top of
// `proposeSendEmail` below. Fix 2 (stuck-approval reconciliation unsafe for
// `sendEmail`) is the one place `reconcileStuckConfirmedApprovals` DID stop
// being fully action-kind-agnostic — see `approvals-store.ts`'s header
// comment above `ApprovalStatus` for the full argument; `proposeSendEmail`
// below is where this file's half of that fix lives (minting and
// persisting the `Message-ID` a future verification step would search for).
//
// ADDING GMAIL TRIAGE AS FIVE MORE ACTION KINDS (this task —
// `archiveThread`/`applyLabel`/`removeLabel`/`markRead`/`markUnread`):
// confirmed AGAIN that `approvals-store.ts`'s CAS core (`proposeApproval`/
// `tryConfirmApproval`/`markExecuted`/`markFailed`) needed ZERO changes —
// same finding as `sendEmail`'s addition, see that file's header. The only
// new code this file needed was (a) five `proposeX` siblings of
// `proposeSendEmail` below, each validating (at PROPOSE time, before any
// approval row exists) that the caller's `threadPageID` resolves to a real
// Gmail thread — see `resolveThreadIdOrThrow` below — and (b) five more
// branches in `executeApprovedAction`'s dispatch, PLUS the
// `GMAIL_MODIFY_SCOPE` gate (a separate staged consent from
// `GMAIL_SEND_SCOPE`/`GMAIL_READONLY_SCOPE`/`CALENDAR_EVENTS_SCOPE` — see
// `oauth-client.ts`'s `GMAIL_MODIFY_SCOPE` doc comment).
//
// UNLIKE `sendEmail`, these five did NOT need a `reconcileStuckConfirmedApprovals`
// exception (Fix 2's `isSendEmail` branch) — see `approvals-store.ts`'s
// header comment above `ApprovalStatus` for why: all five triage actions
// are REVERSIBLE (a mis-reconciled "failed" just means proposing a fresh
// archive/label/mark-read/mark-unread — the SAME acceptable
// re-triable-duplicate risk `createEvent`/`rsvp` already carry), unlike an
// irreversible sent email. The existing `else` branch already lands them on
// `"failed"`, with no code change needed — confirmed by this task's own
// `write-model.test.ts` coverage, not just asserted here.
//
// threadPageID, NOT GMAIL'S RAW THREAD ID (design decision, this task): see
// `gmail-triage.ts`'s file header, "threadPageID vs. RAW GMAIL THREAD ID",
// for the full argument (mirrors
// `@enchiridion/gatekeeper-google-rpc-contract`'s `EmailMessageDTO
// .threadPageID` "no provider IDs leak into the graph" invariant for the
// write direction). `resolveThreadIdOrThrow` below is where a caller-
// supplied `threadPageID` gets validated against `gmail_thread_messages`
// (`gmail-body-store.ts`'s `resolveThreadIdForPageID`) and turned into the
// real Gmail thread id BEFORE an approval row is created — an unknown/
// unresolvable `threadPageID` throws `TriageThreadNotFoundError` right
// here, never silently creating a pending approval that could never
// actually execute. The resolved `threadId` is stored on the approval's
// payload alongside `threadPageID` (mirrors `proposeSendEmail` minting
// `messageId` at propose time rather than re-deriving it at confirm time),
// so `executeApprovedAction` never needs a second DB lookup and the
// approval row is fully self-contained (audit-log fidelity too — the raw
// Gmail thread id this approval acted on is visible in `action_log`, not
// just the vault-facing `threadPageID`).
//
// REAL GOOGLE EVENT-ID VERIFICATION FOR `proposeRsvp` (plan §"Live Backend
// Connectivity (P8)"): applies the EXACT SAME threadPageID-resolution
// pattern above to Calendar RSVP, closing the gap P5 originally flagged and
// P7 flagged again ("proposeRsvp has no analogous check"). See
// `resolveEventIdOrThrow`/`RsvpEventNotFoundError` below and
// `calendar-event-id-store.ts`'s file header for the full writeup —
// `calendar-write-model.ts`'s `RsvpInput` now carries `eventPageID` (what a
// caller actually has) instead of trusting a raw `eventId` directly.

import { GMAIL_MODIFY_SCOPE, GMAIL_SEND_SCOPE } from "./oauth-client";
import { hasGrantedScope } from "./token-store";
import { getValidAccessToken, type TokenRefreshDeps } from "./token-refresh";
import {
  getApproval as readApproval,
  listPendingApprovals as readPendingApprovals,
  markExecuted,
  markFailed,
  proposeApproval,
  reconcileStuckConfirmedApprovals,
  tryConfirmApproval,
  type PendingApproval,
} from "./approvals-store";
import { resolveEventIdForPageID } from "./calendar-event-id-store";
import { createCalendarEvent, rsvpToCalendarEvent, type CreateEventInput, type RsvpInput } from "./calendar-write-model";
import { resolveThreadIdForPageID } from "./gmail-body-store";
import { generateGmailMessageId, sendGmailMessage, validateSendEmailInput, type SendEmailInput, type SentGmailMessage } from "./gmail-send";
import {
  applyGmailLabel,
  archiveGmailThread,
  markGmailThreadRead,
  markGmailThreadUnread,
  removeGmailLabel,
  type ApplyLabelInput,
  type ArchiveThreadInput,
  type MarkReadInput,
  type MarkUnreadInput,
  type RemoveLabelInput,
} from "./gmail-triage";
import type { SqlExecutor } from "./schema";

export type { CreateEventInput, RsvpInput } from "./calendar-write-model";
export type { SendEmailInput, SentGmailMessage } from "./gmail-send";
export type { ApplyLabelInput, ArchiveThreadInput, MarkReadInput, MarkUnreadInput, RemoveLabelInput } from "./gmail-triage";
export type { PendingApproval } from "./approvals-store";

/** Thrown by the five `proposeX` triage functions below when a caller-
 *  supplied `threadPageID` doesn't resolve to any known Gmail thread —
 *  a real, dedicated error type (not a generic `Error`), mirroring
 *  `gmail-send.ts`'s `SendEmailValidationError` "a real error class per
 *  distinct failure kind" convention. Thrown BEFORE any approval row is
 *  created — see this file's header, "threadPageID, NOT GMAIL'S RAW THREAD
 *  ID". */
export class TriageThreadNotFoundError extends Error {
  constructor(threadPageID: string) {
    super(
      `Unknown or unresolvable threadPageID "${threadPageID}" — no materialized Gmail thread found for it (it must first appear via searchEmailThreads/emailSearch).`,
    );
    this.name = "TriageThreadNotFoundError";
  }
}

/** Resolves `threadPageID` -> Gmail's raw thread id via
 *  `gmail-body-store.ts`'s `resolveThreadIdForPageID`, throwing
 *  `TriageThreadNotFoundError` (never silently proceeding with a missing
 *  id) if it doesn't resolve. Shared by all five `proposeX` triage
 *  functions below — see this file's header. */
function resolveThreadIdOrThrow(sql: SqlExecutor, threadPageID: string): string {
  const threadId = resolveThreadIdForPageID(sql, threadPageID);
  if (!threadId) {
    throw new TriageThreadNotFoundError(threadPageID);
  }
  return threadId;
}

/** REAL GOOGLE EVENT-ID VERIFICATION FOR `proposeRsvp` (plan §"Live Backend
 *  Connectivity (P8)" — closes the gap P5 originally flagged and P7 flagged
 *  again): `proposeRsvp` used to trust a caller-supplied `eventId` (Google's
 *  raw event id) VERBATIM, with no check that it corresponded to any real,
 *  actually-materialized Event page — a caller (or a compromised/buggy
 *  device) could propose an RSVP against ANY string and it would sit as a
 *  syntactically valid `pending` approval until confirm time actually hit
 *  Google's API. Fixed by applying the exact same pattern this file's
 *  Gmail triage functions already established (`resolveThreadIdOrThrow`
 *  above, "ADDING GMAIL TRIAGE AS FIVE MORE ACTION KINDS" in this file's
 *  header): `RsvpInput.eventPageID` (the VAULT PageID of a materialized
 *  Event page a caller actually has — NOT Google's raw event id, see
 *  `calendar-write-model.ts`'s `RsvpInput` doc comment) is resolved against
 *  `calendar-event-id-store.ts`'s `resolveEventIdForPageID` HERE, at
 *  PROPOSE time, before any approval row exists — an unknown/unresolvable
 *  `eventPageID` throws `RsvpEventNotFoundError` right here, never silently
 *  creating a pending approval that could never actually execute. The
 *  resolved `eventId`/`calendarId` are stored on the approval's payload
 *  alongside `eventPageID` (mirrors `resolveThreadIdOrThrow`'s callers
 *  storing the resolved `threadId`), so `executeApprovedAction` never needs
 *  a second DB lookup and the approval row is fully self-contained. */
export class RsvpEventNotFoundError extends Error {
  constructor(eventPageID: string) {
    super(
      `Unknown or unresolvable eventPageID "${eventPageID}" — no materialized Calendar event found for it (it must first appear via Calendar ingest).`,
    );
    this.name = "RsvpEventNotFoundError";
  }
}

/** Resolves `eventPageID` -> Google Calendar's real `(eventId, calendarId)`
 *  via `calendar-event-id-store.ts`'s `resolveEventIdForPageID`, throwing
 *  `RsvpEventNotFoundError` (never silently proceeding with a missing id)
 *  if it doesn't resolve. See this file's header, "REAL GOOGLE EVENT-ID
 *  VERIFICATION FOR proposeRsvp". */
function resolveEventIdOrThrow(sql: SqlExecutor, eventPageID: string): { eventId: string; calendarId: string } {
  const resolved = resolveEventIdForPageID(sql, eventPageID);
  if (!resolved) {
    throw new RsvpEventNotFoundError(eventPageID);
  }
  return resolved;
}

export function proposeCreateEvent(sql: SqlExecutor, input: CreateEventInput, now: number): PendingApproval {
  return proposeApproval(sql, { actionType: "createEvent", payload: input }, now);
}

/** See this file's header, "REAL GOOGLE EVENT-ID VERIFICATION FOR
 *  proposeRsvp" — resolves+validates `input.eventPageID` FIRST, mirroring
 *  the five Gmail triage `proposeX` functions' `resolveThreadIdOrThrow`
 *  early-rejection posture exactly: an unresolvable `eventPageID` throws
 *  `RsvpEventNotFoundError` before any approval row exists. Any caller-
 *  supplied `eventId`/`calendarId` on `input` is discarded — the spread
 *  below is deliberately followed by the resolved values, which always
 *  win, so a client can never claim a different Google event id than the
 *  one this worker's own ingest actually materialized for that page. */
export function proposeRsvp(sql: SqlExecutor, input: RsvpInput, now: number): PendingApproval {
  const resolved = resolveEventIdOrThrow(sql, input.eventPageID);
  return proposeApproval(
    sql,
    { actionType: "rsvp", payload: { ...input, eventId: resolved.eventId, calendarId: resolved.calendarId } },
    now,
  );
}

/** See this file's header, "ADDING sendEmail AS A THIRD ACTION KIND". Never
 *  touches Gmail's API — same "propose only creates a pending row" contract
 *  as `proposeCreateEvent`/`proposeRsvp`.
 *
 *  Two adversarial-review fixes landed here (see `gmail-send.ts`'s header
 *  for the full argument on each):
 *  - Fix 1 (header injection): `validateSendEmailInput` runs FIRST, before
 *    any approval row is created — a caller-supplied `to`/`cc`/`bcc`/
 *    `subject` containing a raw CR/LF (an RFC 2822 header-injection
 *    attempt) or an implausible address is rejected right here, as early
 *    as this action can be rejected at all. `buildRawEmailMessage`
 *    (`gmail-send.ts`) validates again at send time as defense-in-depth,
 *    but a bad proposal never even reaches that point.
 *  - Fix 2 (stuck-approval idempotency): `generateGmailMessageId` mints
 *    this send's RFC 2822 `Message-ID` NOW, at propose time — not inside
 *    `sendGmailMessage` at send time — so it's persisted
 *    (`providerMessageId`, `approvals-store.ts`'s `provider_message_id`
 *    column) even if the approval never gets confirmed, or gets stuck
 *    `confirmed` and reconciled. It's threaded into the stored payload
 *    (`SendEmailInput.messageId`) so `executeApprovedAction` below sends
 *    the exact message this approval already committed to identifying,
 *    without needing to re-derive or re-fetch it. */
export function proposeSendEmail(sql: SqlExecutor, input: SendEmailInput, now: number): PendingApproval {
  validateSendEmailInput(input);
  const messageId = generateGmailMessageId();
  return proposeApproval(
    sql,
    { actionType: "sendEmail", payload: { ...input, messageId }, providerMessageId: messageId },
    now,
  );
}

// ---------------------------------------------------------------------------
// Gmail triage — five siblings of `proposeSendEmail` above, one per action
// kind (this task). See this file's header, "ADDING GMAIL TRIAGE AS FIVE
// MORE ACTION KINDS" and "threadPageID, NOT GMAIL'S RAW THREAD ID". Each:
//   1. Resolves+validates `input.threadPageID` via `resolveThreadIdOrThrow`
//      FIRST — mirrors `proposeSendEmail`'s `validateSendEmailInput`
//      early-rejection posture: an unresolvable `threadPageID` throws
//      `TriageThreadNotFoundError` before any approval row exists.
//   2. Stores the RESOLVED `threadId` on the approval's payload alongside
//      the caller's original `threadPageID` — mirrors `proposeSendEmail`
//      minting `messageId` at propose time. `executeApprovedAction` below
//      reads this straight off the payload, no second DB lookup needed.
// Never touches Gmail's API — same "propose only creates a pending row"
// contract as every other `proposeX` function in this file.
// ---------------------------------------------------------------------------

export function proposeArchiveThread(sql: SqlExecutor, input: ArchiveThreadInput, now: number): PendingApproval {
  const threadId = resolveThreadIdOrThrow(sql, input.threadPageID);
  return proposeApproval(sql, { actionType: "archiveThread", payload: { ...input, threadId } }, now);
}

export function proposeApplyLabel(sql: SqlExecutor, input: ApplyLabelInput, now: number): PendingApproval {
  const threadId = resolveThreadIdOrThrow(sql, input.threadPageID);
  return proposeApproval(sql, { actionType: "applyLabel", payload: { ...input, threadId } }, now);
}

export function proposeRemoveLabel(sql: SqlExecutor, input: RemoveLabelInput, now: number): PendingApproval {
  const threadId = resolveThreadIdOrThrow(sql, input.threadPageID);
  return proposeApproval(sql, { actionType: "removeLabel", payload: { ...input, threadId } }, now);
}

export function proposeMarkRead(sql: SqlExecutor, input: MarkReadInput, now: number): PendingApproval {
  const threadId = resolveThreadIdOrThrow(sql, input.threadPageID);
  return proposeApproval(sql, { actionType: "markRead", payload: { ...input, threadId } }, now);
}

export function proposeMarkUnread(sql: SqlExecutor, input: MarkUnreadInput, now: number): PendingApproval {
  const threadId = resolveThreadIdOrThrow(sql, input.threadPageID);
  return proposeApproval(sql, { actionType: "markUnread", payload: { ...input, threadId } }, now);
}

export function getApproval(sql: SqlExecutor, id: string): PendingApproval | undefined {
  return readApproval(sql, id);
}

export function listPendingApprovals(sql: SqlExecutor): PendingApproval[] {
  return readPendingApprovals(sql);
}

export type ConfirmApprovalResult =
  | { status: "executed"; result: unknown }
  | { status: "failed"; reason: string }
  | { status: "conflict"; reason: string };

export type ConfirmApprovalDeps = TokenRefreshDeps;

/** The one function that actually reaches Google's mutating Calendar API —
 *  see this file's header. Sequencing matters: the CAS transition
 *  (`tryConfirmApproval`) happens FIRST and fully synchronously (no
 *  `await` before it returns), so a racing second call already sees
 *  `status !== "pending"` in its own read and gets `conflict` — only then
 *  does this function `await` anything (token refresh, the Calendar API
 *  call itself). See `approvals-store.ts`'s file header for the full
 *  atomicity argument. */
export async function confirmApproval(deps: ConfirmApprovalDeps, approvalId: string, versionToken: string): Promise<ConfirmApprovalResult> {
  const outcome = tryConfirmApproval(deps.sql, approvalId, versionToken, deps.now);
  if (outcome.status === "conflict") {
    return outcome;
  }

  const approval = outcome.approval;

  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(deps);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    markFailed(deps.sql, approvalId, reason, deps.now);
    return { status: "failed", reason };
  }

  try {
    const result = await executeApprovedAction(deps, approval, accessToken);
    markExecuted(deps.sql, approvalId, result, deps.now);
    return { status: "executed", result };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    markFailed(deps.sql, approvalId, reason, deps.now);
    return { status: "failed", reason };
  }
}

/** The "which real Google API do I call" dispatch — the one piece of
 *  kind-specific logic this file's header describes. `accessToken` is
 *  already resolved by `confirmApproval` above before this runs (one token
 *  resolution shared by whichever branch fires, not re-derived per kind).
 *  Thrown errors (including the `GMAIL_SEND_SCOPE` gate below) are caught by
 *  `confirmApproval`'s own try/catch and turned into `markFailed`, same as a
 *  thrown `GmailApiError`/`CalendarApiError` — a missing scope is just
 *  another reason the action couldn't execute, not a special path. */
async function executeApprovedAction(deps: ConfirmApprovalDeps, approval: PendingApproval, accessToken: string): Promise<unknown> {
  if (approval.actionType === "createEvent") {
    return createCalendarEvent(accessToken, approval.payload as CreateEventInput, deps.fetchImpl);
  }
  if (approval.actionType === "rsvp") {
    return rsvpToCalendarEvent(accessToken, approval.payload as RsvpInput, deps.fetchImpl);
  }
  // "sendEmail" — gated by GMAIL_SEND_SCOPE (a separate staged consent from
  // Calendar's, per the plan's "calendar.events -> gmail.readonly ->
  // gmail.send, separate consent" — see this file's header). Checked HERE,
  // inside the try/catch, rather than before `tryConfirmApproval` runs: the
  // approval-gate CAS is unconditional (an ungranted scope doesn't change
  // whether an approval gets to exist), but ACTUALLY SENDING requires it —
  // a clean, legible `markFailed` reason ("reconnect with gmail.send"), not
  // a confusing Gmail API 403 reached by attempting the call anyway. Same
  // `hasGrantedScope` gate `gmail-ingest-cycle.ts` already uses for
  // `GMAIL_READONLY_SCOPE` before any Gmail read call.
  if (
    approval.actionType === "archiveThread" ||
    approval.actionType === "applyLabel" ||
    approval.actionType === "removeLabel" ||
    approval.actionType === "markRead" ||
    approval.actionType === "markUnread"
  ) {
    // Gmail triage — gated by GMAIL_MODIFY_SCOPE (a separate staged
    // consent from GMAIL_SEND_SCOPE/GMAIL_READONLY_SCOPE/
    // CALENDAR_EVENTS_SCOPE — see oauth-client.ts's `GMAIL_MODIFY_SCOPE`
    // doc comment), checked HERE for the same reason `GMAIL_SEND_SCOPE` is
    // checked inline above: the approval-gate CAS is unconditional, but
    // ACTUALLY MODIFYING labels requires the scope — a clean, legible
    // `markFailed` reason ("reconnect with gmail.modify"), not a confusing
    // Gmail API 403 reached by attempting the call anyway.
    if (!hasGrantedScope(deps.sql, GMAIL_MODIFY_SCOPE)) {
      throw new Error(
        "Gmail modify scope not granted — reconnect via /oauth/google/authorize?scope=gmail_modify&reconnect=true",
      );
    }
    if (approval.actionType === "archiveThread") {
      return archiveGmailThread(accessToken, approval.payload as ArchiveThreadInput, deps.fetchImpl);
    }
    if (approval.actionType === "applyLabel") {
      return applyGmailLabel(accessToken, approval.payload as ApplyLabelInput, deps.fetchImpl);
    }
    if (approval.actionType === "removeLabel") {
      return removeGmailLabel(accessToken, approval.payload as RemoveLabelInput, deps.fetchImpl);
    }
    if (approval.actionType === "markRead") {
      return markGmailThreadRead(accessToken, approval.payload as MarkReadInput, deps.fetchImpl);
    }
    return markGmailThreadUnread(accessToken, approval.payload as MarkUnreadInput, deps.fetchImpl);
  }
  if (!hasGrantedScope(deps.sql, GMAIL_SEND_SCOPE)) {
    throw new Error(
      "Gmail send scope not granted — reconnect via /oauth/google/authorize?scope=gmail_send&reconnect=true",
    );
  }
  return sendGmailMessage(accessToken, approval.payload as SendEmailInput, deps.fetchImpl);
}

/** How long a row may sit at `confirmed` before the reconciliation sweep
 *  (`reconcileStuckApprovals` below) gives up on it and marks it `failed`
 *  — see this file's header ("Sequencing matters") and
 *  `approvals-store.ts`'s `reconcileStuckConfirmedApprovals` doc comment
 *  for the full "why `confirmed` can get stuck" argument.
 *
 *  5 minutes, chosen to match the SAME cadence `index.ts`'s `scheduled()`
 *  handler runs this sweep on (plan §Google gatekeeper: "Cron-triggered
 *  polling ..., 5-min cadence") — long enough that a normal
 *  `confirmApproval` call (token refresh + one Calendar API round-trip)
 *  never gets swept while still legitimately in flight (that whole path
 *  is normally sub-second, not minutes), short enough that a genuinely
 *  interrupted approval doesn't sit unusable for more than one extra cron
 *  tick beyond the one that would have caught it. */
export const APPROVAL_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;

export interface ReconcileStuckApprovalsResult {
  /** Approval ids transitioned `confirmed -> failed` by this sweep. */
  reconciledApprovalIds: string[];
}

/** Thin wrapper over `approvals-store.ts`'s `reconcileStuckConfirmedApprovals`
 *  with `APPROVAL_CONFIRMATION_TIMEOUT_MS` baked in — the one place that
 *  timeout is chosen, so `GoogleAccountDO.reconcileStuckApprovals()`
 *  doesn't need to know the number. Called on the same 5-minute cron
 *  cadence as calendar ingest (`index.ts`'s `scheduled()`), not on any
 *  approval-specific trigger — a stuck row only becomes stuck through DO
 *  interruption, which nothing else observes in real time. */
export function reconcileStuckApprovals(sql: SqlExecutor, now: number): ReconcileStuckApprovalsResult {
  const reconciledApprovalIds = reconcileStuckConfirmedApprovals(sql, APPROVAL_CONFIRMATION_TIMEOUT_MS, now);
  return { reconciledApprovalIds };
}
