// @enchiridion/worker-gatekeeper-google — the real Gmail triage MUTATION
// calls (archive/apply-label/remove-label/mark-read/mark-unread), all five
// of which resolve to exactly one Gmail primitive: `threads.modify`
// (`gmail-api.ts`'s `modifyThreadLabels`). Pure functions, injectable
// `fetchImpl`, thin delegate to `gmail-api.ts`, no DO/Workers-runtime
// dependency — same "real provider API call" shape as
// `calendar-write-model.ts`/`gmail-send.ts` (see either file's header),
// mirroring `calendar-write-model.ts`'s exact split from `calendar-api.ts`
// and `gmail-send.ts`'s exact split from `gmail-api.ts`. Only ever invoked
// from `write-model.ts`'s `confirmApproval` (via its `executeApprovedAction`
// dispatch), never from ingest.
//
// WHY FIVE FUNCTIONS OVER ONE LABEL PRIMITIVE: Gmail itself has no
// dedicated "archive"/"mark read"/"mark unread" API — per Google's own
// Gmail API documentation, all five of archive/apply-label/remove-label/
// mark-read/mark-unread are label mutations under the hood:
//   - archive      = removeLabelIds: ["INBOX"]   (a thread not in INBOX is,
//                     by Gmail's own definition, archived)
//   - mark read    = removeLabelIds: ["UNREAD"]
//   - mark unread  = addLabelIds:    ["UNREAD"]
//   - apply label  = addLabelIds:    [label]
//   - remove label = removeLabelIds: [label]
// Five separate exported functions (rather than one generic
// `modifyLabels(threadId, {add, remove})` re-exported here) exist for the
// same reason `calendar-write-model.ts` has separate
// `createCalendarEvent`/`rsvpToCalendarEvent` functions rather than one
// generic "patch the event" call: each is its OWN write-model action kind
// with its own `propose*` function in `write-model.ts` and its own
// approval payload shape — the label semantics are baked in HERE, not left
// for a caller to get wrong by passing the wrong label id.
//
// `label` (for `applyGmailLabel`/`removeGmailLabel`) is treated as an
// OPAQUE Gmail label id string (e.g. `"IMPORTANT"`, `"STARRED"`, or a user
// label's own id like `"Label_1"`) — no name-to-id resolution happens
// anywhere in this worker (it has no `users.labels.list` wrapper; adding
// one is out of scope for this task). A caller (a Swift-side triage tool,
// per this task's design) is responsible for supplying a real label id, the
// same way `gmail-send.ts`'s `SendEmailInput` expects plain, already-valid
// email address strings rather than doing its own directory lookup.
//
// threadPageID vs. RAW GMAIL THREAD ID (design decision, this task):
// `write-model.ts`'s `proposeArchiveThread`/`proposeApplyLabel`/
// `proposeRemoveLabel`/`proposeMarkRead`/`proposeMarkUnread` are keyed by
// the VAULT `threadPageID` of an `EmailThread` page — NOT Gmail's own raw
// thread id — mirroring `@enchiridion/gatekeeper-google-rpc-contract`'s
// `EmailMessageDTO.threadPageID` "no provider IDs leak into the graph"
// invariant (see that package's file header) for the write direction too.
// Each Input type below therefore carries `threadPageID` (what a caller
// actually has) AND an optional `threadId` (Gmail's raw id) — `threadId` is
// resolved and populated by `write-model.ts`'s `proposeX` functions (via
// `gmail-body-store.ts`'s `resolveThreadIdForPageID`) at PROPOSAL time, not
// by the original caller, and persisted into the approval's stored payload
// — the EXACT same "mint/resolve once at propose time, thread it through
// unchanged to confirm time" shape `gmail-send.ts`'s `SendEmailInput.
// messageId` already established (see that file's header, "MESSAGE-ID /
// IDEMPOTENCY"). `threadId` is optional on the TYPE (not required) for the
// same reason `SendEmailInput.messageId` is optional: so this file's own
// direct unit tests can call these functions without needing to fabricate
// a full propose-time payload — `requireThreadId` below is the
// defense-in-depth check that a real approval's payload was actually
// resolved before any Gmail API call is attempted.

import { modifyThreadLabels, type GmailThread } from "./gmail-api";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function requireThreadId(input: { threadPageID: string; threadId?: string }): string {
  if (!input.threadId) {
    throw new Error(
      `missing resolved Gmail threadId for threadPageID "${input.threadPageID}" — this approval's payload should have been resolved at propose time (write-model.ts's proposeX functions via resolveThreadIdForPageID); this is a caller bug, not a Gmail API failure`,
    );
  }
  return input.threadId;
}

export interface ArchiveThreadInput {
  threadPageID: string;
  threadId?: string;
}

/** `POST .../threads/{id}/modify` with `removeLabelIds: ["INBOX"]` — the
 *  real archive mutation. Mirrors `createCalendarEvent`/`sendGmailMessage`'s
 *  exact shape: injectable `fetchImpl`, throws `GmailApiError` (from
 *  `gmail-api.ts`, via `modifyThreadLabels`) on a non-2xx response, only
 *  ever called from `write-model.ts`'s `confirmApproval` after the
 *  approval-gate CAS has already transitioned `pending -> confirmed` AND
 *  the `GMAIL_MODIFY_SCOPE` gate has already passed. */
export async function archiveGmailThread(accessToken: string, input: ArchiveThreadInput, fetchImpl: FetchLike = fetch): Promise<GmailThread> {
  return modifyThreadLabels({ accessToken, threadId: requireThreadId(input), removeLabelIds: ["INBOX"], fetchImpl });
}

export interface ApplyLabelInput {
  threadPageID: string;
  label: string;
  threadId?: string;
}

/** `POST .../threads/{id}/modify` with `addLabelIds: [label]`. */
export async function applyGmailLabel(accessToken: string, input: ApplyLabelInput, fetchImpl: FetchLike = fetch): Promise<GmailThread> {
  return modifyThreadLabels({ accessToken, threadId: requireThreadId(input), addLabelIds: [input.label], fetchImpl });
}

export interface RemoveLabelInput {
  threadPageID: string;
  label: string;
  threadId?: string;
}

/** `POST .../threads/{id}/modify` with `removeLabelIds: [label]`. */
export async function removeGmailLabel(accessToken: string, input: RemoveLabelInput, fetchImpl: FetchLike = fetch): Promise<GmailThread> {
  return modifyThreadLabels({ accessToken, threadId: requireThreadId(input), removeLabelIds: [input.label], fetchImpl });
}

export interface MarkReadInput {
  threadPageID: string;
  threadId?: string;
}

/** `POST .../threads/{id}/modify` with `removeLabelIds: ["UNREAD"]`. */
export async function markGmailThreadRead(accessToken: string, input: MarkReadInput, fetchImpl: FetchLike = fetch): Promise<GmailThread> {
  return modifyThreadLabels({ accessToken, threadId: requireThreadId(input), removeLabelIds: ["UNREAD"], fetchImpl });
}

export interface MarkUnreadInput {
  threadPageID: string;
  threadId?: string;
}

/** `POST .../threads/{id}/modify` with `addLabelIds: ["UNREAD"]`. */
export async function markGmailThreadUnread(accessToken: string, input: MarkUnreadInput, fetchImpl: FetchLike = fetch): Promise<GmailThread> {
  return modifyThreadLabels({ accessToken, threadId: requireThreadId(input), addLabelIds: ["UNREAD"], fetchImpl });
}
