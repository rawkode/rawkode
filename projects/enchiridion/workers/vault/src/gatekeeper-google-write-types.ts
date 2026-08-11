// @enchiridion/worker-vault — hand-mirrored INPUT/RESULT types for the
// write RPCs `./gatekeeper-google-write-routes.ts` forwards to
// `workers/gatekeeper-google`'s `CalendarWriteModel`/`GmailWriteModel`
// `WorkerEntrypoint`s (plan §"Live Backend Connectivity (P8)", "vault ->
// gatekeeper-google HTTP proxy route(s) for the write RPCs").
//
// WHY HAND-MIRRORED HERE RATHER THAN IMPORTED FROM
// `@enchiridion/gatekeeper-google-rpc-contract`: that package's own file
// header documents its scope rule verbatim — "only the RPC methods
// [the caller] actually calls ... has no cross-worker caller today and
// stays un-shared until one exists" (the same rule `vault-rpc-contract`
// states for VaultDO's own larger RPC surface). Until THIS pass, that was
// exactly gatekeeper-google's write-model's situation too: `write-model.ts`
// bearing out `CalendarWriteModel`/`GmailWriteModel`'s real
// `CreateEventInput`/`RsvpInput`/`ArchiveThreadInput`/etc. types (Gmail
// triage task, task #83) deliberately did NOT add them to the shared
// contract package, because nothing outside gatekeeper-google called those
// RPC methods yet — see that task's own `index.ts`/`write-model.ts` header
// comments. This pass is the first REAL cross-worker caller of those
// methods, which is precisely the contract package's own stated trigger
// for promoting a type into shared scope — promoting them is reasonable
// FUTURE hardening (once done, `workers/gatekeeper-google/src/index.ts`'s
// `CalendarWriteModel`/`GmailWriteModel` method signatures would import
// from the contract package too, matching `GmailReadModel`'s existing
// "the callee's real code IS the contract" direction-of-source-of-truth
// convention for the READ direction) — but is deliberately NOT done in
// this pass, to keep the blast radius on gatekeeper-google's own already-
// adversarially-reviewed `index.ts`/write-model files at zero. These types
// are therefore duplicated by hand, matching every field of gatekeeper-
// google's real types as of this pass (`calendar-write-model.ts`'s
// `CreateEventInput`/`RsvpInput`, `gmail-triage.ts`'s `ArchiveThreadInput`/
// `ApplyLabelInput`/`RemoveLabelInput`/`MarkReadInput`/`MarkUnreadInput`,
// `gmail-send.ts`'s `SendEmailInput`, `approvals-store.ts`'s
// `PendingApproval`) — a real duplication-drift risk, flagged here
// explicitly rather than silently accepted, and the first thing to fix if
// this RPC surface ever grows past what fits comfortably hand-mirrored.
//
// Vault does not validate or interpret these shapes at all — it forwards
// the caller's already-authenticated JSON body straight through to the
// named-entrypoint Service Binding RPC call (`./gatekeeper-google-write-
// routes.ts`) and passes back whatever gatekeeper-google's own `proposeX`
// validation (including THIS pass's `resolveEventIdOrThrow` for RSVP)
// decides. These types exist only so `JSON.parse`d request bodies get a
// real shape at the vault call site, not `any`.

/** Mirrors `calendar-api.ts`'s `GoogleCalendarEventDateTime` exactly — see
 *  that file for why `{date}` (all-day) and `{dateTime, timeZone}` (timed)
 *  are mutually exclusive per Google's real Events resource shape. */
export interface CalendarEventDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

/** Mirrors `calendar-write-model.ts`'s `CreateEventInput` exactly. */
export interface CreateEventInput {
  calendarId?: string;
  summary: string;
  description?: string;
  location?: string;
  start: CalendarEventDateTime;
  end: CalendarEventDateTime;
  attendeeEmails?: string[];
}

/** Mirrors `calendar-write-model.ts`'s `RsvpInput` exactly — `eventPageID`
 *  is the VAULT PageID of a materialized Event page (NOT Google's raw
 *  event id); `eventId`/`calendarId` are resolved server-side by
 *  `write-model.ts`'s `proposeRsvp` (this task's real event-ID
 *  verification) and are never trusted from the caller even if supplied. */
export interface RsvpInput {
  eventPageID: string;
  eventId?: string;
  calendarId?: string;
  responseStatus: "accepted" | "declined" | "tentative";
}

/** Mirrors `gmail-triage.ts`'s `ArchiveThreadInput` exactly — `threadPageID`
 *  is the VAULT PageID of a materialized `EmailThread` page (NOT Gmail's
 *  raw thread id). */
export interface ArchiveThreadInput {
  threadPageID: string;
  threadId?: string;
}

/** Mirrors `gmail-triage.ts`'s `ApplyLabelInput` exactly. */
export interface ApplyLabelInput {
  threadPageID: string;
  label: string;
  threadId?: string;
}

/** Mirrors `gmail-triage.ts`'s `RemoveLabelInput` exactly. */
export interface RemoveLabelInput {
  threadPageID: string;
  label: string;
  threadId?: string;
}

/** Mirrors `gmail-triage.ts`'s `MarkReadInput` exactly. */
export interface MarkReadInput {
  threadPageID: string;
  threadId?: string;
}

/** Mirrors `gmail-triage.ts`'s `MarkUnreadInput` exactly. */
export interface MarkUnreadInput {
  threadPageID: string;
  threadId?: string;
}

/** Mirrors `gmail-send.ts`'s `SendEmailInput` exactly — `messageId` is
 *  minted server-side by `write-model.ts`'s `proposeSendEmail`, never
 *  supplied by a caller. */
export interface SendEmailInput {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  messageId?: string;
}

/** Mirrors `approvals-store.ts`'s `PendingApproval` exactly — the response
 *  shape every one of `./gatekeeper-google-write-routes.ts`'s routes
 *  passes back verbatim (JSON round-tripped over Workers RPC, then
 *  JSON-serialized again in vault's own HTTP response). `actionType`/
 *  `status` are widened to `string` here (rather than importing
 *  gatekeeper-google's internal `ApprovalActionType`/`ApprovalStatus`
 *  unions) — vault only ever forwards this value, it never branches on it. */
export interface PendingApproval {
  id: string;
  actionType: string;
  payload: unknown;
  versionToken: string;
  status: string;
  result: unknown;
  createdAt: number;
  updatedAt: number;
  providerMessageId?: string;
}
