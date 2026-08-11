// Fetch handler for the gatekeeper-google worker.
//
// See /Users/rawkode/.claude/plans/cheeky-greeting-lampson.md, plan §Google
// gatekeeper (Calendar P2, Gmail P3) and plan §"GraphQL API" (under §Backend
// architecture): this worker has NO GraphQL schema of its own. Its Gmail
// read surface is the `WorkerEntrypoint`-shaped `GmailReadModel` below,
// called directly by vault's Pothos resolvers over a NAMED-ENTRYPOINT
// Cloudflare Service Binding (real Workers RPC — `workers/vault/
// wrangler.jsonc`'s `GATEKEEPER_GOOGLE` binding, `entrypoint:
// "GmailReadModel"` — NOT `env.GATEKEEPER_GOOGLE.fetch(...)`; see Fix 4
// below for why the earlier `.fetch()`-based design was a BLOCKER); its
// write surface is the `WorkerEntrypoint`-shaped `CalendarWriteModel`/
// `GmailWriteModel` below.
//
// REAL as of this pass:
//
//   GET  /oauth/google/authorize  — Access-gated (see below), mints a CSRF
//                                    state (GoogleAccountDO), redirects to
//                                    Google's consent screen.
//                                    `?reconnect=true` marks the minted
//                                    state as authorizing an explicit
//                                    replace of an existing connection —
//                                    see ./oauth-state.ts and
//                                    ./token-store.ts's file headers (Fix 2:
//                                    `storeInitialTokens` no longer silently
//                                    replaces an existing connection).
//                                    `?scope=calendar|gmail_readonly|
//                                    gmail_send` selects the staged Google
//                                    scope this round trip requests (plan
//                                    §Google OAuth pin: "separate consent"),
//                                    defaulting to `calendar` — see
//                                    ./oauth-client.ts's `OAuthScopeStage`/
//                                    `scopeForStage` and ./oauth-http.ts's
//                                    `handleOAuthAuthorizeRequest`.
//   GET  /oauth/google/callback   — Access-gated (see below), verifies that
//                                    state BEFORE exchanging the returned
//                                    code for tokens, then stores them via
//                                    GoogleAccountDO — refusing to silently
//                                    replace an existing connection unless
//                                    the state's `allowReplace` flag says
//                                    otherwise (Fix 2). The whole
//                                    `handleOAuthCallback` call is wrapped
//                                    in try/catch (Fix 3): a thrown
//                                    `GoogleOAuthError` (Google's token
//                                    endpoint rejecting the exchange) or any
//                                    other error becomes a controlled error
//                                    Response, never an unhandled exception
//                                    crashing this Worker's `fetch()`.
//   scheduled()                    — "P2: Calendar gatekeeper" +
//                                    "P3: Gmail" cron, all on the same
//                                    5-minute firing:
//                                    GoogleAccountDO.runCalendarIngestCycle()
//                                    (incremental sync / full resync +
//                                    materialization — see
//                                    ./calendar-ingest.ts),
//                                    GoogleAccountDO.runGmailIngestCycle()
//                                    (chunked/resumable backfill /
//                                    history.list incremental sync +
//                                    EmailThread materialization — see
//                                    ./gmail-ingest.ts), AND
//                                    GoogleAccountDO.runGmailBodyIngestCycle()
//                                    (message-body/attachment ingest sweep
//                                    — see ./gmail-body-ingest.ts), each
//                                    independently try/caught (see this
//                                    handler's own doc comment below) so
//                                    one provider's/step's failure never
//                                    blocks the others or the
//                                    stuck-approval reconciliation sweep.
//   GmailReadModel                  — WorkerEntrypoint RPC surface
//                                    (getMessagesForThreads/
//                                    searchEmailMessages), gated by
//                                    `hasScope(GMAIL_READONLY_SCOPE)`. FIX
//                                    (adversarial-review BLOCKER — see this
//                                    file's "Fix 4" note below): this used
//                                    to be two plain HTTP routes
//                                    (`/gmail/messages`, `/gmail/search`)
//                                    on this worker's public `fetch()`
//                                    handler with NO caller-identity check
//                                    at all. Both routes are gone; reads
//                                    are RPC-only now. See
//                                    ./gmail-read-model.ts and
//                                    @enchiridion/gatekeeper-google-rpc-
//                                    contract.
//   CalendarWriteModel             — WorkerEntrypoint RPC surface
//                                    (createEvent/rsvp/confirmApproval),
//                                    per the plan's "Read/write split" pin.
//                                    See ./write-model.ts for the real
//                                    propose/confirm/execute logic this
//                                    delegates to via GoogleAccountDO.
//   GmailWriteModel                 — WorkerEntrypoint RPC surface
//                                    (sendEmail/archiveThread/applyLabel/
//                                    removeLabel/markRead/markUnread/
//                                    confirmApproval), real as of THIS pass
//                                    (plan: "Gmail: ... send behind
//                                    approval") plus the Gmail triage RPCs
//                                    (archiveThread/applyLabel/removeLabel/
//                                    markRead/markUnread — real as of the
//                                    triage write-model follow-up task).
//                                    Same propose/confirm/execute machinery
//                                    as CalendarWriteModel — see
//                                    ./write-model.ts's "ADDING sendEmail AS
//                                    A THIRD ACTION KIND" and "ADDING GMAIL
//                                    TRIAGE AS FIVE MORE ACTION KINDS",
//                                    ./gmail-send.ts for the real
//                                    `messages.send` call (gated by
//                                    GMAIL_SEND_SCOPE), and
//                                    ./gmail-triage.ts for the real
//                                    `threads.modify` calls the five triage
//                                    methods resolve to (gated by
//                                    GMAIL_MODIFY_SCOPE). The five triage
//                                    methods are keyed by the VAULT
//                                    `threadPageID` of an `EmailThread`
//                                    page, NOT Gmail's own raw thread id —
//                                    see ./gmail-triage.ts's file header,
//                                    "threadPageID vs. RAW GMAIL THREAD ID".
//
// Cloudflare Access gate on the OAuth routes (Fix 1 — plan §Google
// gatekeeper: "OAuth routes must sit behind Cloudflare Access like every
// other worker ... this was missing in the first P2 pass"): before this
// pass, `/oauth/google/authorize`/`/callback` had ZERO application-layer
// authentication — anyone who could complete Google's Internal-workspace
// consent screen could reach `storeInitialTokens`'s (then-unconditional)
// UPSERT and hijack the single account connection. Both routes now call
// `verifyAccessRequest` (`@enchiridion/access-auth` — see that package for
// why this is a shared package, not a duplicate of
// `workers/vault/src/access-auth.ts`) FIRST, before `loadOAuthConfig` or
// any `GoogleAccountDO` RPC call, mirroring `workers/vault/src/index.ts`'s
// check-first ordering for `/sync`/`/blobs/*`/`/graphql`. This worker has
// its OWN Cloudflare Access Application (own hostname/route, own AUD tag,
// separate from vault's) — see ./GOOGLE_OAUTH_SETUP.md's Cloudflare Access
// section for the manual dashboard steps, including why this Application's
// policy is identity-login-based (a human admin completing Google's
// consent screen through a browser), not vault's device-service-token
// Service Auth policy.
//
// See ./oauth-routes.ts for the OAuth route logic (unit-tested there),
// ./google-account-do.ts for GoogleAccountDO's full RPC surface, and
// ./GOOGLE_OAUTH_SETUP.md for the manual Google Cloud Console + Cloudflare
// Access steps OAuth depends on (fails closed — see ./oauth-config.ts and
// ./GOOGLE_OAUTH_SETUP.md — until those are done).
//
// Fix 4 (adversarial-review BLOCKER, plan §Google gatekeeper): before this
// pass, `/gmail/messages`/`/gmail/search` were real HTTP routes on this
// worker's public `fetch()` handler with ZERO application-layer
// authentication — the routes' own comments incorrectly argued a Cloudflare
// Service Binding's `.fetch()` call was itself an auth boundary (it isn't:
// it dispatches to this worker's OWN `fetch()` handler, the same one any
// other caller reaches). Fixed by converting both operations to
// `GmailReadModel` RPC methods below — Workers RPC entrypoint methods have
// no `fetch()`-routed path at all, unlike an HTTP route gated only by an
// out-of-band assumption about who calls it. See ./gmail-read-model.ts's
// file header for the full writeup and ./gmail-read-model.test.ts for the
// tests proving the old routes are gone.
//
// STILL NOT IMPLEMENTED (out of this pass's scope):
//   - The in-app confirmation UI that would actually call
//     `CalendarWriteModel.confirmApproval()` from a device — a future
//     native-app task per the task brief ("the actual in-app confirmation
//     UI is a future native-app task, this just needs the server-side
//     approval-gate mechanism to be real and correct").
//   - APNs push for time-sensitive approvals (plan: "a pending RSVP can't
//     wait for the app to be foregrounded") — not implemented; out of
//     this pass's scope (no APNs credential/plumbing exists in this
//     worker yet).

import { WorkerEntrypoint } from "cloudflare:workers";
import type { AccessEnv } from "@enchiridion/access-auth";
import type { CalendarEventSummaryDTO } from "@enchiridion/gadget-gatekeeper-google-rpc-contract";
import type { EmailMessageDTO } from "@enchiridion/gatekeeper-google-rpc-contract";
import { listUpcomingEvents } from "./calendar-read-model";
import { defaultGoogleAccountStub } from "./google-account-stub";
import { gmailNotFoundResponse, getMessagesForThreads, searchEmailMessages } from "./gmail-read-model";
import type { GoogleOAuthEnv } from "./oauth-config";
import { handleOAuthAuthorizeRequest, handleOAuthCallbackRequest } from "./oauth-http";
import type { VaultClientEnv } from "./vault-client";
import type {
  ApplyLabelInput,
  ArchiveThreadInput,
  ConfirmApprovalResult,
  CreateEventInput,
  MarkReadInput,
  MarkUnreadInput,
  PendingApproval,
  RemoveLabelInput,
  RsvpInput,
  SendEmailInput,
} from "./write-model";

export { GoogleAccountDO } from "./google-account-do";

interface Env extends GoogleOAuthEnv, VaultClientEnv, AccessEnv {
  GOOGLE_ACCOUNT_DO: DurableObjectNamespace<import("./google-account-do").GoogleAccountDO>;
}

/** The write-model's `WorkerEntrypoint`-shaped RPC surface (plan §"Read/
 *  write split": "WorkerEntrypoint-shaped RPC for gatekeeper-google"),
 *  mirroring `platform/leaderboard`'s `write-model/main.ts`
 *  `LeaderboardWriteModel` pattern (a `WorkerEntrypoint<Env>` subclass
 *  exposing typed async methods, no D1/drizzle here since this worker
 *  isn't D1-backed). Every method is a thin delegate to
 *  `GoogleAccountDO`'s own RPC methods (`google-account-do.ts`) — this
 *  class holds no storage of its own; GoogleAccountDO's SQLite is the only
 *  durable state (`pending_approvals`/`action_log`, schema.ts). Bind to
 *  this from another worker via a Service Binding with
 *  `entrypoint: "CalendarWriteModel"`; this worker's own `fetch()`
 *  default export doesn't route to it (no HTTP route calls these methods
 *  — "no generic API passthrough", per the plan). */
export class CalendarWriteModel extends WorkerEntrypoint<Env> {
  async createEvent(input: CreateEventInput): Promise<PendingApproval> {
    return defaultGoogleAccountStub(this.env).proposeCreateEvent(input);
  }

  async rsvp(input: RsvpInput): Promise<PendingApproval> {
    return defaultGoogleAccountStub(this.env).proposeRsvp(input);
  }

  async confirmApproval(approvalId: string, versionToken: string): Promise<ConfirmApprovalResult> {
    return defaultGoogleAccountStub(this.env).confirmApproval(approvalId, versionToken);
  }

  async getApproval(approvalId: string): Promise<PendingApproval | undefined> {
    return defaultGoogleAccountStub(this.env).getApproval(approvalId);
  }

  async listPendingApprovals(): Promise<PendingApproval[]> {
    return defaultGoogleAccountStub(this.env).listPendingApprovals();
  }
}

/** The Gmail READ surface (plan §"Cross-worker field resolution"): a
 *  `WorkerEntrypoint`-shaped RPC surface, exactly like `CalendarWriteModel`/
 *  `GmailWriteModel` above, EXCEPT this one is bound cross-worker from
 *  `workers/vault` (its own `wrangler.jsonc`'s `GATEKEEPER_GOOGLE` service
 *  binding, `entrypoint: "GmailReadModel"`) rather than being called only
 *  from a future native-app task, the way the write models are. Real as of
 *  the adversarial-review BLOCKER fix (Fix 4, this file's header) — it
 *  REPLACES the old `/gmail/messages`/`/gmail/search` HTTP routes, which
 *  had no caller-identity check at all. Thin delegate to
 *  `./gmail-read-model.ts`'s pure functions (same split every other real
 *  logic module in this worker uses), which themselves delegate to
 *  `GoogleAccountDO`'s `getMessagesForThreads`/`searchEmailMessages` RPC
 *  methods after checking `hasScope(GMAIL_READONLY_SCOPE)`. This worker's
 *  own `fetch()` default export doesn't route to it either — see
 *  `./gmail-read-model.ts`'s `gmailNotFoundResponse`, used below, which
 *  404s every `/gmail/*` path unconditionally. */
export class GmailReadModel extends WorkerEntrypoint<Env> {
  async getMessagesForThreads(threadPageIDs: string[]): Promise<Record<string, EmailMessageDTO[]>> {
    return getMessagesForThreads(defaultGoogleAccountStub(this.env), threadPageIDs);
  }

  async searchEmailMessages(query: string, limit?: number): Promise<EmailMessageDTO[]> {
    return searchEmailMessages(defaultGoogleAccountStub(this.env), query, limit);
  }
}

/** "P3: Gmail" sibling of `CalendarWriteModel` above — same
 *  `WorkerEntrypoint`-shaped RPC surface (plan §"Read/write split"), same
 *  thin-delegate-to-`GoogleAccountDO` style, holding no storage of its own.
 *  `sendEmail()` only ever creates a `pending` approval
 *  (`write-model.ts`'s `proposeSendEmail` — see that file's "ADDING
 *  sendEmail AS A THIRD ACTION KIND" for why this needed almost no new
 *  approval-gate machinery); the real Gmail `messages.send` call happens
 *  solely inside `confirmApproval`, gated by the same first-writer-wins CAS
 *  AND the `GMAIL_SEND_SCOPE` check (`write-model.ts`'s
 *  `executeApprovedAction`). `confirmApproval`/`getApproval`/
 *  `listPendingApprovals` are exposed here too (not just on
 *  `CalendarWriteModel`) because they're already action-kind-agnostic and
 *  both write models share the one `GoogleAccountDO` instance's approval
 *  store — a caller confirming a Gmail approval has no reason to bind to
 *  `CalendarWriteModel` instead. Bind to this from another worker via a
 *  Service Binding with `entrypoint: "GmailWriteModel"`; this worker's own
 *  `fetch()` default export doesn't route to it either (see this file's
 *  header, "no generic API passthrough"). */
export class GmailWriteModel extends WorkerEntrypoint<Env> {
  async sendEmail(input: SendEmailInput): Promise<PendingApproval> {
    return defaultGoogleAccountStub(this.env).proposeSendEmail(input);
  }

  /** Gmail triage RPCs (this task) — five thin delegates to
   *  `GoogleAccountDO`'s own `proposeArchiveThread`/`proposeApplyLabel`/
   *  `proposeRemoveLabel`/`proposeMarkRead`/`proposeMarkUnread` RPC methods,
   *  mirroring `sendEmail` above's exact shape. Each only ever creates a
   *  `pending` approval (`write-model.ts`'s `proposeX` functions) — the
   *  real Gmail `threads.modify` call happens solely inside
   *  `confirmApproval`, gated by the same first-writer-wins CAS AND the
   *  `GMAIL_MODIFY_SCOPE` check. Keyed by `threadPageID` (the VAULT PageID
   *  of an `EmailThread` page), not Gmail's own raw thread id — see
   *  `./gmail-triage.ts`'s file header, "threadPageID vs. RAW GMAIL THREAD
   *  ID", for why. */
  async archiveThread(input: ArchiveThreadInput): Promise<PendingApproval> {
    return defaultGoogleAccountStub(this.env).proposeArchiveThread(input);
  }

  async applyLabel(input: ApplyLabelInput): Promise<PendingApproval> {
    return defaultGoogleAccountStub(this.env).proposeApplyLabel(input);
  }

  async removeLabel(input: RemoveLabelInput): Promise<PendingApproval> {
    return defaultGoogleAccountStub(this.env).proposeRemoveLabel(input);
  }

  async markRead(input: MarkReadInput): Promise<PendingApproval> {
    return defaultGoogleAccountStub(this.env).proposeMarkRead(input);
  }

  async markUnread(input: MarkUnreadInput): Promise<PendingApproval> {
    return defaultGoogleAccountStub(this.env).proposeMarkUnread(input);
  }

  async confirmApproval(approvalId: string, versionToken: string): Promise<ConfirmApprovalResult> {
    return defaultGoogleAccountStub(this.env).confirmApproval(approvalId, versionToken);
  }

  async getApproval(approvalId: string): Promise<PendingApproval | undefined> {
    return defaultGoogleAccountStub(this.env).getApproval(approvalId);
  }

  async listPendingApprovals(): Promise<PendingApproval[]> {
    return defaultGoogleAccountStub(this.env).listPendingApprovals();
  }
}

/** NEW IN THIS PASS (plan §Gadgets, P4 "gatekeeper.google.calendar.read"
 *  capability) — see `calendar-read-model.ts`'s file header and
 *  `@enchiridion/gadget-gatekeeper-google-rpc-contract`'s file header for
 *  the full "minimal, additive, one-new-method" writeup. Mirrors
 *  `GmailReadModel` above exactly: a `WorkerEntrypoint` holding no storage
 *  of its own, thin-delegating to a pure function. Bind to this from
 *  `workers/gadget-host` via a Service Binding with
 *  `entrypoint: "CalendarReadModel"`; this worker's own `fetch()` default
 *  export doesn't route to it (no HTTP route surface, same as every other
 *  RPC-only surface in this file). */
export class CalendarReadModel extends WorkerEntrypoint<Env> {
  async listUpcomingEvents(maxResults?: number, windowDays?: number): Promise<CalendarEventSummaryDTO[]> {
    return listUpcomingEvents(defaultGoogleAccountStub(this.env), maxResults, windowDays);
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Both OAuth routes' logic (Cloudflare Access verification — Fix 1,
    // config loading, `?reconnect=true` — Fix 2, and callback try/catch —
    // Fix 3) lives in ./oauth-http.ts, a plain module with no
    // `cloudflare:workers` dependency so it's directly unit-testable
    // (`oauth-http.test.ts`) — see that file's header and this file's
    // header comment above for the full rationale. This handler is
    // deliberately just a two-line delegate per route.

    if (url.pathname === "/oauth/google/authorize") {
      return handleOAuthAuthorizeRequest(request, env, defaultGoogleAccountStub(env));
    }

    if (url.pathname === "/oauth/google/callback") {
      return handleOAuthCallbackRequest(request, env, defaultGoogleAccountStub(env));
    }

    // Calendar has NO HTTP route surface by design (plan §Google
    // gatekeeper / §"Read/write split"): ingest is cron-driven
    // (`scheduled()` below -> `GoogleAccountDO.runCalendarIngestCycle()`),
    // reads are RPC-only (`GoogleAccountDO`'s own methods, called by
    // vault's resolvers over the cross-script DO binding once a P3+ vault
    // resolver needs them), and writes are `CalendarWriteModel`'s
    // `WorkerEntrypoint` RPC methods (this file, above) — never a generic
    // HTTP passthrough a caller could widen into an unapproved mutation.
    if (url.pathname.startsWith("/calendar/")) {
      return new Response(
        "not found — Calendar has no HTTP route surface; use the CalendarWriteModel WorkerEntrypoint RPC " +
          "(createEvent/rsvp/confirmApproval) or GoogleAccountDO's own RPC methods instead.\n" +
          "Plan: /Users/rawkode/.claude/plans/cheeky-greeting-lampson.md",
        { status: 404 },
      );
    }

    // Gmail ingest itself is still cron-driven (`scheduled()` below ->
    // GoogleAccountDO.runGmailIngestCycle()/.runGmailBodyIngestCycle()).
    // Gmail has NO HTTP ROUTE SURFACE AT ALL (Fix 4, this file's header —
    // adversarial-review BLOCKER): `/gmail/messages`/`/gmail/search` used
    // to be real HTTP routes here with no caller-identity check; reads are
    // `GmailReadModel` RPC-only now (this file, above), reached exclusively
    // via `workers/vault/wrangler.jsonc`'s named-entrypoint
    // `GATEKEEPER_GOOGLE` service binding — see ./gmail-read-model.ts's
    // file header for the full writeup. `sendEmail()` has no HTTP route
    // surface either, by the same "no generic API passthrough" design as
    // Calendar above — it's `GmailWriteModel`'s WorkerEntrypoint RPC method
    // (this file, above) only. `gmailNotFoundResponse` (./gmail-read-model.ts)
    // is the one place this 404 behavior is defined, so it can be unit
    // tested without needing a live Workers runtime (see that file's
    // header for why `bun test` can't import this module directly).
    const gmailResponse = gmailNotFoundResponse(url.pathname);
    if (gmailResponse) return gmailResponse;

    return new Response(
      "not found — implemented routes: GET /oauth/google/authorize, GET /oauth/google/callback.\n" +
        "Plan: /Users/rawkode/.claude/plans/cheeky-greeting-lampson.md",
      { status: 404 },
    );
  },

  /** "Cron-triggered polling (Calendar syncToken, Gmail historyId), 5-min
   *  cadence" (plan §Google gatekeeper) — BOTH halves are real as of this
   *  pass ("P3: Gmail" adds the second `runGmailIngestCycle()` call
   *  alongside the existing Calendar one). Delegates entirely to
   *  `GoogleAccountDO`'s own RPC methods (see their doc comments and
   *  ./calendar-ingest.ts/./gmail-ingest.ts) — this handler itself has no
   *  ingest logic, matching every other thin-fetch-handler-delegates-to-DO
   *  pattern in this codebase. A `{skipped: true}` result from either
   *  (OAuth not connected/revoked, Gmail scope not granted, OR a
   *  re-entrant call while a prior cycle for THAT SAME provider is still
   *  in flight — see ./calendar-ingest-cycle.ts/./gmail-ingest-cycle.ts)
   *  is a normal, non-error outcome — not thrown.
   *
   *  ALSO runs `runGmailBodyIngestCycle()` (message-body/attachment ingest,
   *  see ./gmail-body-ingest.ts) and `reconcileStuckApprovals()` on the
   *  SAME cron firing — the stuck-"confirmed"-approval sweep (see
   *  ./approvals-store.ts's `reconcileStuckConfirmedApprovals` and
   *  ./write-model.ts's `reconcileStuckApprovals`/
   *  `APPROVAL_CONFIRMATION_TIMEOUT_MS`) needs *some* periodic trigger
   *  independent of any particular approval, since a stuck row is only
   *  reachable this way — nothing else ever revisits it.
   *
   *  ALL FOUR calls (Calendar ingest, Gmail thread ingest, Gmail body
   *  ingest, the reconcile sweep) are SEQUENCED (not `Promise.all`-parallel
   *  — keeps one firing's total Google API load serialized rather than
   *  multiplied up) and EACH INDEPENDENTLY try/caught, per this task's
   *  brief ("each independently try/caught so a Gmail failure doesn't
   *  block calendar's cycle or the reconciliation sweep"): a thrown
   *  failure from any one of the four (e.g. `GoogleOAuthConfigError` — see
   *  oauth-config.ts's fail-closed contract, which every `run*Cycle` method
   *  deliberately lets propagate rather than swallowing) does not prevent
   *  the other three from still being attempted on this same firing. Every
   *  caught error is collected and re-thrown together (as an
   *  `AggregateError` when more than one occurred, or the bare error when
   *  exactly one did) once all four have been attempted, so the platform's
   *  own cron-failure observability (retry/alerting) still sees a failure
   *  occurred, and which one(s). */
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const stub = defaultGoogleAccountStub(env);
    const errors: unknown[] = [];

    try {
      await stub.runCalendarIngestCycle();
    } catch (error) {
      errors.push(error);
    }

    try {
      await stub.runGmailIngestCycle();
    } catch (error) {
      errors.push(error);
    }

    try {
      await stub.runGmailBodyIngestCycle();
    } catch (error) {
      errors.push(error);
    }

    try {
      await stub.reconcileStuckApprovals();
    } catch (error) {
      errors.push(error);
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "gatekeeper-google scheduled(): multiple failures in one cron firing");
  },
};
