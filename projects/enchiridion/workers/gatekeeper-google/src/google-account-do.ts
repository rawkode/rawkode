// GoogleAccountDO — plan §Google gatekeeper: "OAuth server-side; tokens +
// cursors in a GoogleAccountDO."
//
// Deliberately thin (same split `workers/vault/src/vault-do.ts` uses):
// every real decision (schema DDL, token-store SQL, OAuth-state SQL,
// refresh-vs-not logic, the Google HTTP client) lives in a plain,
// DO-runtime-independent module this file imports and wires together — see
// each import's own file for its real logic and tests. That split is what
// makes the logic unit-testable with `bun test` against a real
// `bun:sqlite`-backed `SqlExecutor`, without needing a live Workers
// runtime (`wrangler dev`) that this sandbox doesn't have network/account
// access to drive. This file itself — the `DurableObject` subclass — is
// NOT exercised by `bun test` for that reason; it should be smoke-tested
// with `wrangler dev` (or a deployed worker) before real calendar ingest
// depends on it.
//
// RPC surface (Workers RPC: every `async` method here is callable directly
// on a `DurableObjectStub<GoogleAccountDO>` from another worker/DO):
//
//   getValidAccessToken()                                    — THE clean
//     interface calendar ingest (and the write-model) calls. Returns a
//     currently-valid access token, transparently refreshing first if
//     needed. See token-refresh.ts's file header for its error contract
//     (GoogleAccountNotConnectedError / GoogleOAuthConfigError /
//     GoogleOAuthError — none retried in a loop here).
//   storeInitialTokens(accessToken, refreshToken, expiresIn, allowReplace,
//   grantedScopes?)
//     — called once by the OAuth callback route (oauth-routes.ts) after a
//     successful code exchange. Refuses (returns `{status:
//     "already-connected"}`, doesn't throw) to silently replace an existing
//     connection unless `allowReplace` is `true` — see token-store.ts's
//     file header for the full reasoning and `disconnect()` below for the
//     other way to clear a connection first. `grantedScopes` (plan §Google
//     OAuth pin: staged Gmail consent) is Google's own token-response
//     `scope` string, persisted as-is — see `hasScope()` below and
//     token-store.ts's `hasGrantedScope`.
//   hasScope(scope)                                           — query
//     method a follow-up Gmail-ingest task calls before any Gmail API
//     request, so a declined/never-requested scope fails with a clear
//     message instead of a confusing Google API 403. Delegates to
//     token-store.ts's `hasGrantedScope` — see that function's doc comment
//     for the exact fallback contract.
//   disconnect()                                              — clears the
//     stored OAuth credential (token-store.ts's `deleteStoredTokens`) so a
//     subsequent `storeInitialTokens` call (without `allowReplace`) starts
//     from a clean slate. The explicit alternative to
//     `?reconnect=true`/`allowReplace` when the intent is "revoke this
//     connection", not "replace it in one step".
//   getSyncCursor(resource) / setSyncCursor(resource, value)  — generic
//     cursor storage for calendar ingest (syncToken) and a future P3 Gmail
//     pass (historyId) — see schema.ts.
//   beginOAuthState(reconnect) / consumeOAuthState(state)     — CSRF
//     support for the authorize/callback routes (oauth-state.ts). NOT part
//     of the "clean interface" ingest/write-model calls — purely OAuth-flow
//     plumbing, kept on this DO because it's the natural place to durably
//     stash a short-lived state token before the redirect happens.
//     `reconnect` (default `false`) is threaded through to
//     `createOAuthState`'s `allowReplace` column — see oauth-state.ts's file
//     header for why the "may this replace an existing connection" intent
//     is carried through the state row rather than trusted from the
//     callback request directly. `consumeOAuthState` now returns
//     `{valid, allowReplace}` (oauth-state.ts's `ConsumeOAuthStateResult`)
//     instead of a bare boolean, for the same reason.
//   runCalendarIngestCycle()                                  — real as of
//     "P2: Calendar gatekeeper". Resolves a valid access token, then runs
//     one full `calendar-ingest.ts` cycle (incremental sync, or a full
//     resync on first run/expired syncToken, materializing changed
//     events/attendees into VaultDO). Returns `{skipped: true, reason}`
//     rather than throwing when OAuth was never completed or has been
//     revoked (`GoogleAccountNotConnectedError`/`GoogleOAuthError`) — a
//     cron `scheduled()` handler shouldn't hard-fail on "not set up yet".
//     Called by `index.ts`'s `scheduled()`. REENTRANCY-GUARDED
//     (adversarial-review finding, plan §Google gatekeeper): delegates to
//     a `calendar-ingest-cycle.ts` runner constructed ONCE in this DO's
//     constructor (not per call) so its in-memory `inProgress` flag
//     actually guards across overlapping calls on this instance — see
//     that file's header for the full "why an in-memory flag is enough"
//     argument. A re-entrant call (e.g. a slow first-run full resync still
//     in flight when the next cron tick fires) returns
//     `{skipped: true, reason: "ingest already in progress"}` instead of
//     racing a second `fetchAllPages`/`setSyncCursor` against the first.
//   reconcileStuckApprovals()                                 — sweeps
//     `pending_approvals` rows stuck at `confirmed` past a timeout (DO
//     interrupted between `tryConfirmApproval`'s CAS commit and the
//     terminal `executed`/`failed` transition — see `write-model.ts`'s
//     `confirmApproval` header and `approvals-store.ts`'s
//     `reconcileStuckConfirmedApprovals`) and marks them `failed`
//     (`createEvent`/`rsvp`) or `unknown` (`sendEmail` — see that file's
//     Fix 2 comment for why Gmail send gets a distinct, non-retry-inviting
//     terminal status) so a fresh approval can be proposed. Called by
//     `index.ts`'s
//     `scheduled()`, alongside `runCalendarIngestCycle()`, on the same
//     5-minute cron cadence.
//   proposeCreateEvent(input) / proposeRsvp(input) /
//   proposeSendEmail(input)                                   — write-model
//     RPC: creates a `pending` approval, returns its id + version token.
//     Never touches Google's API — see write-model.ts's file header.
//     `proposeSendEmail` ("P3: Gmail") is real as of this pass too — see
//     write-model.ts's "ADDING sendEmail AS A THIRD ACTION KIND".
//   proposeArchiveThread(input) / proposeApplyLabel(input) /
//   proposeRemoveLabel(input) / proposeMarkRead(input) /
//   proposeMarkUnread(input)                                  — Gmail
//     triage write-model RPC (this task) — same "creates a pending
//     approval, never touches Google's API" contract as the other
//     `proposeX` methods. See write-model.ts's "ADDING GMAIL TRIAGE AS FIVE
//     MORE ACTION KINDS" — each validates the caller's `threadPageID`
//     against `gmail_thread_messages` BEFORE creating any approval row,
//     throwing `TriageThreadNotFoundError` if it doesn't resolve to a known
//     Gmail thread.
//   confirmApproval(approvalId, versionToken)                 — write-model
//     RPC: the ONLY path that reaches Google's mutating Calendar/Gmail API,
//     gated by `approvals-store.ts`'s first-writer-wins CAS. Already
//     action-kind-agnostic (dispatches on the approval's own `actionType`),
//     so this one method serves createEvent/rsvp/sendEmail/archiveThread/
//     applyLabel/removeLabel/markRead/markUnread alike.
//   getApproval(id) / listPendingApprovals()                  — read-only
//     accessors over the approval-gate state.

import { DurableObject } from "cloudflare:workers";
import type { GoogleOAuthEnv } from "./oauth-config";
import { loadOAuthConfig } from "./oauth-config";
import { createOAuthState, consumeOAuthState as consumeState, type ConsumeOAuthStateResult } from "./oauth-state";
import type { SqlExecutor } from "./schema";
import { initializeSchema } from "./schema";
import { getValidAccessToken as resolveValidAccessToken } from "./token-refresh";
import {
  deleteStoredTokens,
  getSyncCursor as readSyncCursor,
  hasGrantedScope,
  setSyncCursor as writeSyncCursor,
  storeInitialTokens as persistInitialTokens,
  type StoreInitialTokensResult,
} from "./token-store";
import type { EmailMessageDTO } from "@enchiridion/gatekeeper-google-rpc-contract";
import { createCalendarIngestCycleRunner, type CalendarIngestCycleResult } from "./calendar-ingest-cycle";
import { createGmailIngestCycleRunner, type GmailIngestCycleResult } from "./gmail-ingest-cycle";
import { createGmailBodyIngestCycleRunner, type GmailBodyIngestCycleResult } from "./gmail-body-ingest-cycle";
import { listAttachmentsByMessageIDs } from "./gmail-attachment-store";
import { listMessageBodiesByPageIDs, searchMessageBodies } from "./gmail-body-store";
import { toEmailMessageDTO } from "./gmail-message-dto";
import type { R2BucketLike } from "./r2-types";
import type { VaultClientEnv } from "./vault-client";
import {
  confirmApproval as confirmApprovalRpc,
  getApproval as getApprovalRpc,
  listPendingApprovals as listPendingApprovalsRpc,
  proposeApplyLabel as proposeApplyLabelRpc,
  proposeArchiveThread as proposeArchiveThreadRpc,
  proposeCreateEvent as proposeCreateEventRpc,
  proposeMarkRead as proposeMarkReadRpc,
  proposeMarkUnread as proposeMarkUnreadRpc,
  proposeRemoveLabel as proposeRemoveLabelRpc,
  proposeRsvp as proposeRsvpRpc,
  proposeSendEmail as proposeSendEmailRpc,
  reconcileStuckApprovals as reconcileStuckApprovalsRpc,
  type ApplyLabelInput,
  type ArchiveThreadInput,
  type ConfirmApprovalResult,
  type CreateEventInput,
  type MarkReadInput,
  type MarkUnreadInput,
  type PendingApproval,
  type ReconcileStuckApprovalsResult,
  type RemoveLabelInput,
  type RsvpInput,
  type SendEmailInput,
} from "./write-model";

interface Env extends GoogleOAuthEnv, VaultClientEnv {
  /** Gatekeeper-google's OWN R2 bucket for Gmail attachment bytes — see
   *  wrangler.jsonc's `GMAIL_ATTACHMENTS` binding comment for the
   *  bucket-ownership decision. Typed as the minimal `R2BucketLike`
   *  (`r2-types.ts`) rather than `@cloudflare/workers-types`' `R2Bucket`
   *  directly — same narrowing-cast convention `VaultClientEnv`'s `VAULT`
   *  binding and `vault-do.ts`'s `sql` getter both use. */
  GMAIL_ATTACHMENTS: R2BucketLike;
}

export type { CalendarIngestCycleResult } from "./calendar-ingest-cycle";
export type { GmailIngestCycleResult } from "./gmail-ingest-cycle";
export type { GmailBodyIngestCycleResult } from "./gmail-body-ingest-cycle";

export class GoogleAccountDO extends DurableObject<Env> {
  /** One reentrancy-guarded runner per DO instance — see this file's
   *  header on `runCalendarIngestCycle`. Constructed once here (NOT
   *  re-created per RPC call), so `calendar-ingest-cycle.ts`'s in-memory
   *  `inProgress` flag persists across calls for this DO's lifetime. */
  private readonly runIngestCycle: () => Promise<CalendarIngestCycleResult>;

  /** Same reentrancy-guard contract as `runIngestCycle` above, applied to
   *  Gmail ("P3: Gmail") via `gmail-ingest-cycle.ts`'s
   *  `createGmailIngestCycleRunner` — a SEPARATE guard instance/flag from
   *  Calendar's, since the two providers' cursors are independent and an
   *  in-flight Calendar cycle must not block a concurrently-firing Gmail
   *  cycle (or vice versa) from even starting; only two overlapping calls
   *  to the SAME provider's cycle need to be mutually exclusive. */
  private readonly runGmailIngestCycleFn: () => Promise<GmailIngestCycleResult>;

  /** Same reentrancy-guard contract as `runGmailIngestCycleFn` above,
   *  applied to the separate message-body/attachment ingest sweep
   *  (`gmail-body-ingest.ts`) — a THIRD independent guard/flag, since a
   *  slow-to-complete body-ingest tick must not block (or be blocked by)
   *  either provider's own thread/event discovery cycle. */
  private readonly runGmailBodyIngestCycleFn: () => Promise<GmailBodyIngestCycleResult>;

  /** Same cast pattern `vault-do.ts`'s `sql` getter uses, for the same
   *  reason: `DurableObjectStorage.sql` (`@cloudflare/workers-types`) is
   *  structurally identical to this worker's own `SqlExecutor`
   *  (schema.ts), so this is a type-level narrowing cast, not a
   *  behavioral adapter — the narrower interface is what lets
   *  token-store.ts/oauth-state.ts/token-refresh.ts/approvals-store.ts be
   *  unit-tested against `test-helpers/sqlite-storage-adapter.ts` instead.
   *
   *  DELIBERATELY a `readonly` FIELD, read from `this.ctx.storage.sql`
   *  exactly ONCE here in the constructor — NOT a getter re-evaluating
   *  `this.ctx.storage.sql` on every access (which this file used before
   *  the plan §Effect-TS Application-Code Migration P9 pass). This
   *  matters now in a way it didn't before: `token-refresh.ts`'s
   *  Risk #15 single-flight fix keys its per-session semaphore lock on
   *  this object's IDENTITY (`WeakMap<SqlExecutor, Effect.Semaphore>`),
   *  so every call into `token-refresh.ts` from this DO instance must
   *  observe the literal same `SqlExecutor` object every time — this
   *  field guarantees that by construction, regardless of whether the
   *  underlying Cloudflare Workers runtime's own `ctx.storage.sql`
   *  getter happens to return a referentially-stable object across
   *  repeated accesses (adversarial-review finding: that was an
   *  unverified assumption about the HOST runtime when this was a getter
   *  recomputed per access; caching it once removes the dependency on
   *  that assumption entirely, for this DO's whole lifetime). */
  private readonly sql: SqlExecutor;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = this.ctx.storage.sql as unknown as SqlExecutor;
    initializeSchema(this.sql);
    this.runIngestCycle = createCalendarIngestCycleRunner({
      sql: this.sql,
      env: this.env,
      loadConfig: () => loadOAuthConfig(this.env),
    });
    this.runGmailIngestCycleFn = createGmailIngestCycleRunner({
      sql: this.sql,
      env: this.env,
      loadConfig: () => loadOAuthConfig(this.env),
    });
    this.runGmailBodyIngestCycleFn = createGmailBodyIngestCycleRunner({
      sql: this.sql,
      r2: this.env.GMAIL_ATTACHMENTS,
      loadConfig: () => loadOAuthConfig(this.env),
    });
  }

  /** See this file's header — the interface calendar ingest/the
   *  write-model call. */
  async getValidAccessToken(): Promise<string> {
    const config = loadOAuthConfig(this.env);
    return resolveValidAccessToken({ sql: this.sql, config, now: Date.now() });
  }

  async storeInitialTokens(
    accessToken: string,
    refreshToken: string,
    expiresIn: number,
    allowReplace = false,
    grantedScopes?: string,
  ): Promise<StoreInitialTokensResult> {
    return persistInitialTokens(this.sql, { accessToken, refreshToken, expiresIn, grantedScopes }, Date.now(), {
      allowReplace,
    });
  }

  /** Query method for a follow-up task's Gmail-ingest logic to call BEFORE
   *  attempting any Gmail API request (plan §Google gatekeeper, Gmail
   *  section) — see `token-store.ts`'s `hasGrantedScope` for the full
   *  fallback contract (no connection at all, a legacy connection with no
   *  recorded scopes, or a normal recorded-scope check). Pass a real Google
   *  scope URL (e.g. `oauth-client.ts`'s `GMAIL_READONLY_SCOPE`), not a
   *  `?scope=` stage key. A caller that gets `false` back should surface a
   *  clear "reconnect with Gmail access" message — via
   *  `/oauth/google/authorize?scope=gmail_readonly&reconnect=true` — rather
   *  than attempting the Gmail API call and handling its 403. */
  async hasScope(scope: string): Promise<boolean> {
    return hasGrantedScope(this.sql, scope);
  }

  /** See this file's header. Clears the stored credential unconditionally —
   *  a no-op, not an error, if nothing was connected (token-store.ts's
   *  `deleteStoredTokens`). */
  async disconnect(): Promise<void> {
    deleteStoredTokens(this.sql);
  }

  async getSyncCursor(resource: string): Promise<string | undefined> {
    return readSyncCursor(this.sql, resource);
  }

  async setSyncCursor(resource: string, value: string): Promise<void> {
    writeSyncCursor(this.sql, resource, value, Date.now());
  }

  async beginOAuthState(reconnect = false): Promise<string> {
    const state = crypto.randomUUID();
    createOAuthState(this.sql, state, Date.now(), reconnect);
    return state;
  }

  async consumeOAuthState(state: string): Promise<ConsumeOAuthStateResult> {
    return consumeState(this.sql, state, Date.now());
  }

  /** See this file's header. `this.env` already carries the worker-wide
   *  `VAULT` cross-script DO binding (wrangler.jsonc) — no separate
   *  plumbing needed to hand `calendar-ingest.ts` a `VaultClientEnv`.
   *  Thin delegate to the reentrancy-guarded runner built in the
   *  constructor — all the real logic (config loading, token resolution,
   *  the guard itself) lives in `calendar-ingest-cycle.ts`. */
  async runCalendarIngestCycle(): Promise<CalendarIngestCycleResult> {
    return this.runIngestCycle();
  }

  /** "P3: Gmail" counterpart to `runCalendarIngestCycle` — see this file's
   *  header and `gmail-ingest-cycle.ts`'s file header for the reentrancy
   *  guard + scope-gate contract. Called by `index.ts`'s `scheduled()`
   *  alongside (not instead of) `runCalendarIngestCycle()`. */
  async runGmailIngestCycle(): Promise<GmailIngestCycleResult> {
    return this.runGmailIngestCycleFn();
  }

  /** Body/attachment ingest sweep (see `gmail-body-ingest.ts`'s file header
   *  for why this is a separate cron step from `runGmailIngestCycle`).
   *  Called by `index.ts`'s `scheduled()` alongside the other three cycle
   *  calls, independently try/caught. */
  async runGmailBodyIngestCycle(): Promise<GmailBodyIngestCycleResult> {
    return this.runGmailBodyIngestCycleFn();
  }

  /** Backs `GmailReadModel.getMessagesForThreads` (`index.ts`, via
   *  `gmail-read-model.ts`'s scope-gated wrapper) — the real Workers-RPC
   *  method `workers/vault`'s `EmailThread.messages` resolver calls over
   *  the named-entrypoint `GATEKEEPER_GOOGLE` service binding, one batched
   *  call per GraphQL operation (plan Risk #11). A `pageID` with no stored
   *  messages is simply absent from the returned record — matches this
   *  codebase's "absence means empty, not error" accessor convention. */
  async getMessagesForThreads(pageIDs: string[]): Promise<Record<string, EmailMessageDTO[]>> {
    const byPage = listMessageBodiesByPageIDs(this.sql, pageIDs);
    const allMessageIDs = [...byPage.values()].flatMap((messages) => messages.map((m) => m.messageID));
    const attachmentsByMessage = listAttachmentsByMessageIDs(this.sql, allMessageIDs);

    const result: Record<string, EmailMessageDTO[]> = {};
    for (const [pageID, messages] of byPage) {
      result[pageID] = messages.map((message) => toEmailMessageDTO(message, attachmentsByMessage.get(message.messageID) ?? []));
    }
    return result;
  }

  /** Backs `GmailReadModel.searchEmailMessages` (`index.ts`, via
   *  `gmail-read-model.ts`'s scope-gated wrapper) — the real Workers-RPC
   *  method `Query.emailSearch`'s resolver calls. See
   *  `gmail-body-store.ts`'s `searchMessageBodies` for the `LIKE`-based
   *  search strategy this delegates to. */
  async searchEmailMessages(query: string, limit: number): Promise<EmailMessageDTO[]> {
    const bodies = searchMessageBodies(this.sql, query, limit);
    const attachmentsByMessage = listAttachmentsByMessageIDs(this.sql, bodies.map((b) => b.messageID));
    return bodies.map((body) => toEmailMessageDTO(body, attachmentsByMessage.get(body.messageID) ?? []));
  }

  /** See this file's header. Delegates to `write-model.ts`'s
   *  `reconcileStuckApprovals` (itself a thin wrapper over
   *  `approvals-store.ts`'s `reconcileStuckConfirmedApprovals` with the
   *  chosen timeout baked in). */
  async reconcileStuckApprovals(): Promise<ReconcileStuckApprovalsResult> {
    return reconcileStuckApprovalsRpc(this.sql, Date.now());
  }

  async proposeCreateEvent(input: CreateEventInput): Promise<PendingApproval> {
    return proposeCreateEventRpc(this.sql, input, Date.now());
  }

  async proposeRsvp(input: RsvpInput): Promise<PendingApproval> {
    return proposeRsvpRpc(this.sql, input, Date.now());
  }

  /** "P3: Gmail" write-model counterpart to `proposeCreateEvent`/
   *  `proposeRsvp` above — see `write-model.ts`'s file header, "ADDING
   *  sendEmail AS A THIRD ACTION KIND". `confirmApproval`/`getApproval`/
   *  `listPendingApprovals` below already work for this action kind
   *  unmodified (they're action-kind-agnostic — see `approvals-store.ts`),
   *  so no sibling RPC method was needed for those. */
  async proposeSendEmail(input: SendEmailInput): Promise<PendingApproval> {
    return proposeSendEmailRpc(this.sql, input, Date.now());
  }

  /** Gmail triage write-model RPC (this task) — five thin one-line
   *  delegates to `write-model.ts`'s `proposeArchiveThread`/
   *  `proposeApplyLabel`/`proposeRemoveLabel`/`proposeMarkRead`/
   *  `proposeMarkUnread`, mirroring `proposeSendEmail`'s exact shape above.
   *  `confirmApproval`/`getApproval`/`listPendingApprovals` below already
   *  work for these action kinds unmodified — same reasoning as
   *  `proposeSendEmail`'s own doc comment. */
  async proposeArchiveThread(input: ArchiveThreadInput): Promise<PendingApproval> {
    return proposeArchiveThreadRpc(this.sql, input, Date.now());
  }

  async proposeApplyLabel(input: ApplyLabelInput): Promise<PendingApproval> {
    return proposeApplyLabelRpc(this.sql, input, Date.now());
  }

  async proposeRemoveLabel(input: RemoveLabelInput): Promise<PendingApproval> {
    return proposeRemoveLabelRpc(this.sql, input, Date.now());
  }

  async proposeMarkRead(input: MarkReadInput): Promise<PendingApproval> {
    return proposeMarkReadRpc(this.sql, input, Date.now());
  }

  async proposeMarkUnread(input: MarkUnreadInput): Promise<PendingApproval> {
    return proposeMarkUnreadRpc(this.sql, input, Date.now());
  }

  async confirmApproval(approvalId: string, versionToken: string): Promise<ConfirmApprovalResult> {
    const config = loadOAuthConfig(this.env);
    return confirmApprovalRpc({ sql: this.sql, config, now: Date.now() }, approvalId, versionToken);
  }

  async getApproval(approvalId: string): Promise<PendingApproval | undefined> {
    return getApprovalRpc(this.sql, approvalId);
  }

  async listPendingApprovals(): Promise<PendingApproval[]> {
    return listPendingApprovalsRpc(this.sql);
  }
}
