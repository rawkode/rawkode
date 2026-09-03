import * as Schema from "effect/Schema"
import { Bookmark, BookmarkUrl } from "./bookmark.js"
import { CalendarEvent } from "./calendar-event.js"
import { CalendarOAuthClientAttemptHandle as CalendarOAuthClientAttemptHandleSchema } from "./calendar-oauth.js"
import { GatekeeperBinding, GatekeeperBindingSummary } from "./gatekeeper-binding.js"
import { MutationAttribution, MutationCommitMessage, MutationRequestId } from "./ledger.js"
import { EntityId, IsoDateTimeString } from "./node.js"

/** Kept here as a re-export for established RPC-schema callers. */
export { CalendarOAuthClientAttemptHandle } from "./calendar-oauth.js"

/** Safe lifecycle projection; it intentionally carries neither account data nor receipt material. */
export const CalendarOAuthCompletionStatus = Schema.Literal("pending", "connected", "failed", "expired")
export type CalendarOAuthCompletionStatus = typeof CalendarOAuthCompletionStatus.Type

// Phase 5 domain-extension task, item 5: "RPC schemas: connectGoogleCalendar (OAuth kickoff),
// googleCalendarOAuthCallback, disconnectGoogleCalendar, syncGoogleCalendar (manual trigger),
// listCalendarEvents, createBookmark, listBookmarks, linkCalendarEventToNode." Same one-
// `Schema.Class`-input/output-pair-per-method convention as rpc.ts/graph-rpc.ts/sharing-rpc.ts.
// Schema-only, same explicit scope note as sharing-rpc.ts's own header comment: no
// `GatekeeperService`/calendar-merge implementation lives here, and none of these methods is
// wired onto `WorkspaceDurableObject` yet — this is the contract the next stage (real cross-Worker
// service-binding wiring, per docs/gatekeeper-google-calendar-decisions.md's own "what the next
// stage builds against" list) is built against.
//
// **Every method below is workspace-scoped** (`workspaceId: EntityId`), and — per this task's hard
// constraint — **every one of these RPC methods, once a real `WorkspaceDurableObject` implementation
// exists, MUST call `requireRoleForGovernedWorkspace` exactly like every other governed-workspace RPC
// method already does** (`workspace-durable-object.ts`'s established Phase 4 discipline: "EVERY new
// mutating/reading RPC method on a governed workspace MUST call the same requireRoleForGovernedWorkspace
// gate... no exceptions, that gap was just fixed at real security cost, do not reintroduce it").
// That gating is NOT implemented in this stage, for the identical reason sharing-rpc.ts's own
// schemas predate `SharingService`: `requireRoleForGovernedWorkspace` lives in `backend` (a Cloudflare-
// dependent package `@athenaeum/domain` never imports, per this file's own zero-CF-deps
// discipline) and is only meaningful wired onto a real DO method body, which does not exist yet
// for any of these eight methods. Recommended role split, so the next stage has an unambiguous
// answer ready rather than re-deriving one: `connectGoogleCalendar`/`googleCalendarOAuthCallback`/
// `disconnectGoogleCalendar`/`linkCalendarEventToNode`/`createBookmark` are mutations → `"build"`
// (mirrors `workspace-durable-object.ts`'s existing convention: every structural/connection-mutating
// method gates on `"build"`, e.g. `createRelationDefinition`/`addCollaborator`); `syncGoogleCalendar`
// is a mutation too (it triggers real provider I/O and writes) → `"build"`; `listCalendarEvents`/
// `listBookmarks` are reads → `"use"` (mirrors `listNodes`/`listCollaborators`'s existing `"use"`
// gating) — the same use/build split every other paired mutate-vs-list method in this codebase
// already follows.
//
// **OAuth flow shape**: `connectGoogleCalendar` only kicks off the redirect (it cannot know which
// calendar to bind yet — Google's own `calendarList` requires an access token, which does not
// exist before the user authorizes); `googleCalendarOAuthCallback` completes the code exchange
// AND finalizes the `GatekeeperBinding` in the same call, taking the target `calendarId`/`mode`
// as caller-supplied input (a client-side calendar picker, run against a short-lived token or a
// separate not-yet-built `listGoogleCalendars` method, is how a real UI would source those values
// before calling this — out of scope for this schema-only stage, same as sharing-rpc.ts leaving
// "how does a client discover a redeemable share key" to its own UI layer). `state` round-trips
// verbatim from `connectGoogleCalendar`'s output to `googleCalendarOAuthCallback`'s input — the
// caller (backend) is responsible for minting and verifying it as a CSRF nonce, per
// `gatekeeper-google-calendar`'s own `buildAuthorizationUrl` doc comment ("No state/CSRF-nonce
// minting or verification... generating and verifying it is the OAuth-flow orchestrator's job").

// --- Google Calendar: connect / disconnect / sync ---------------------------------------------

/** Kicks off the OAuth authorization-code flow for a workspace's Google Calendar connection. Returns
 *  the URL the client redirects the user to, plus the `state` value the client must round-trip
 *  back through `googleCalendarOAuthCallback` unchanged (see this file's header comment). */
export class ConnectGoogleCalendarInput extends Schema.Class<ConnectGoogleCalendarInput>(
  "ConnectGoogleCalendarInput"
)({
  workspaceId: EntityId
}) {}

export class ConnectGoogleCalendarOutput extends Schema.Class<ConnectGoogleCalendarOutput>(
  "ConnectGoogleCalendarOutput"
)({
  authorizationUrl: Schema.String,
  state: Schema.String
}) {}

/**
 * Safe replacement for new clients. The authority foundation declares this contract before it is
 * mounted on the Workspace RPC; callers must not adopt the legacy raw state/authorization-URL pair.
 */
export class BeginGoogleCalendarConnectionInput extends Schema.Class<BeginGoogleCalendarConnectionInput>(
  "BeginGoogleCalendarConnectionInput"
)({
  workspaceId: EntityId,
  requestId: MutationRequestId,
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution,
  /** Optional for compatibility; the first opaque flow defaults to Google's primary calendar. */
  calendarId: Schema.optional(Schema.Literal("primary")),
  /** Optional for compatibility; selected-calendar binding is the conservative default. */
  mode: Schema.optional(Schema.Literal("selected"))
}) {}

export class BeginGoogleCalendarConnectionOutput extends Schema.Class<BeginGoogleCalendarConnectionOutput>(
  "BeginGoogleCalendarConnectionOutput"
)({
  attemptHandle: CalendarOAuthClientAttemptHandleSchema
}) {}

/** The one-time fixed-server launch URL is distinct from the stable completion handle. */
export class IssueGoogleCalendarLaunchInput extends Schema.Class<IssueGoogleCalendarLaunchInput>(
  "IssueGoogleCalendarLaunchInput"
)({
  workspaceId: EntityId,
  attemptHandle: CalendarOAuthClientAttemptHandleSchema
}) {}

export const FixedGoogleCalendarLaunchUrl = Schema.String.pipe(
  Schema.pattern(/^https:\/\/[a-z0-9.-]+\/oauth\/google-calendar\/launch\/ocl_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  Schema.brand("FixedGoogleCalendarLaunchUrl")
)
export type FixedGoogleCalendarLaunchUrl = typeof FixedGoogleCalendarLaunchUrl.Type

export class IssueGoogleCalendarLaunchOutput extends Schema.Class<IssueGoogleCalendarLaunchOutput>(
  "IssueGoogleCalendarLaunchOutput"
)({
  /** Opaque one-time capability URL; never a provider authorization URL. */
  fixedLaunchUrl: FixedGoogleCalendarLaunchUrl
}) {}

export class GetGoogleCalendarConnectionCompletionInput extends Schema.Class<GetGoogleCalendarConnectionCompletionInput>(
  "GetGoogleCalendarConnectionCompletionInput"
)({
  workspaceId: EntityId,
  attemptHandle: CalendarOAuthClientAttemptHandleSchema
}) {}

/** Completion is discriminated so a pending/failed/expired read cannot carry a binding. */
export class PendingGoogleCalendarConnectionCompletion extends Schema.Class<PendingGoogleCalendarConnectionCompletion>(
  "PendingGoogleCalendarConnectionCompletion"
)({ status: Schema.Literal("pending"), binding: Schema.optional(Schema.Never) }) {}

export class ConnectedGoogleCalendarConnectionCompletion extends Schema.Class<ConnectedGoogleCalendarConnectionCompletion>(
  "ConnectedGoogleCalendarConnectionCompletion"
)({ status: Schema.Literal("connected"), binding: GatekeeperBindingSummary }) {}

export class FailedGoogleCalendarConnectionCompletion extends Schema.Class<FailedGoogleCalendarConnectionCompletion>(
  "FailedGoogleCalendarConnectionCompletion"
)({ status: Schema.Literal("failed"), binding: Schema.optional(Schema.Never) }) {}

export class ExpiredGoogleCalendarConnectionCompletion extends Schema.Class<ExpiredGoogleCalendarConnectionCompletion>(
  "ExpiredGoogleCalendarConnectionCompletion"
)({ status: Schema.Literal("expired"), binding: Schema.optional(Schema.Never) }) {}

export const GetGoogleCalendarConnectionCompletionOutput = Schema.Union(
  PendingGoogleCalendarConnectionCompletion,
  ConnectedGoogleCalendarConnectionCompletion,
  FailedGoogleCalendarConnectionCompletion,
  ExpiredGoogleCalendarConnectionCompletion
)
export type GetGoogleCalendarConnectionCompletionOutput = typeof GetGoogleCalendarConnectionCompletionOutput.Type

/** Completes the OAuth exchange (`code` + `state`, Google's redirect-back parameters) and
 *  finalizes the `GatekeeperBinding` for `calendarId`/`mode` in the same call — see this file's
 *  header comment for why binding finalization happens here rather than a separate method.
 *  Fails with `OAuthExchangeFailed` (errors.ts) if the code exchange itself fails. */
export class GoogleCalendarOAuthCallbackInput extends Schema.Class<GoogleCalendarOAuthCallbackInput>(
  "GoogleCalendarOAuthCallbackInput"
)({
  workspaceId: EntityId,
  code: Schema.String,
  state: Schema.String,
  calendarId: Schema.String.pipe(Schema.minLength(1)),
  mode: Schema.Literal("selected", "allVisible")
}) {}

export class GoogleCalendarOAuthCallbackOutput extends Schema.Class<GoogleCalendarOAuthCallbackOutput>(
  "GoogleCalendarOAuthCallbackOutput"
)({
  binding: GatekeeperBinding
}) {}

/** Removes the workspace's Google Calendar `GatekeeperBinding`. Per `docs/observers.md` §6's teardown
 *  discipline (ported to Athenaeum's own future `SharingService` observer-tracking, not built this
 *  stage), disconnecting a binding is also where every registered observer for it should be torn
 *  down server-side — this schema only fixes the caller-facing input/output, not that behavior.
 *  Fails with `GatekeeperNotConnected` (errors.ts) if no binding of this kind exists for the
 *  workspace. */
export class DisconnectGoogleCalendarInput extends Schema.Class<DisconnectGoogleCalendarInput>(
  "DisconnectGoogleCalendarInput"
)({
  workspaceId: EntityId,
  bindingId: EntityId
}) {}

export class DisconnectGoogleCalendarOutput extends Schema.Class<DisconnectGoogleCalendarOutput>(
  "DisconnectGoogleCalendarOutput"
)({
  disconnected: Schema.Boolean
}) {}

/** Manually triggers an incremental sync pass for one binding, rather than waiting for the next
 *  scheduled alarm (mirrors new-notes' own "a manual sync request only advances the alarm and is
 *  rate bounded" design, `docs/architecture.md` §"Google Calendar provider projection" — rate
 *  limiting/alarm-advancement policy is a future `CalendarService` implementation concern, not
 *  fixed by this schema). Deliberately returns only an acknowledgement, not the synced events
 *  themselves — per the same cited section, sync is a paged, checkpointed, potentially
 *  multi-request background process, not something one RPC round trip completes; a client polls
 *  `listCalendarEvents` (or a future live subscription) to observe the result. Fails with
 *  `GatekeeperNotConnected` if no binding exists for the workspace. */
export class SyncGoogleCalendarInput extends Schema.Class<SyncGoogleCalendarInput>(
  "SyncGoogleCalendarInput"
)({
  workspaceId: EntityId,
  bindingId: EntityId
}) {}

export class SyncGoogleCalendarOutput extends Schema.Class<SyncGoogleCalendarOutput>(
  "SyncGoogleCalendarOutput"
)({
  triggered: Schema.Boolean
}) {}

/** Lists sanitized, server-authoritative external bindings for this workspace. The response is
 * suitable for management surfaces and intentionally excludes account/credential identity. */
export class ListGatekeeperBindingsInput extends Schema.Class<ListGatekeeperBindingsInput>(
  "ListGatekeeperBindingsInput"
)({
  workspaceId: EntityId
}) {}

export class ListGatekeeperBindingsOutput extends Schema.Class<ListGatekeeperBindingsOutput>(
  "ListGatekeeperBindingsOutput"
)({
  bindings: Schema.Array(GatekeeperBindingSummary)
}) {}

// --- Google Calendar: reads --------------------------------------------------------------------

/** Lists this workspace's synced `CalendarEvent` rows, optionally bounded to `[from, to)`. Reads the
 *  already-synced local projection (calendar-event.ts) — never calls Google directly; a client
 *  wanting fresher data calls `syncGoogleCalendar` first. */
export class ListCalendarEventsInput extends Schema.Class<ListCalendarEventsInput>(
  "ListCalendarEventsInput"
)({
  workspaceId: EntityId,
  from: Schema.optional(IsoDateTimeString),
  to: Schema.optional(IsoDateTimeString)
}) {}

export class ListCalendarEventsOutput extends Schema.Class<ListCalendarEventsOutput>(
  "ListCalendarEventsOutput"
)({
  events: Schema.Array(CalendarEvent)
}) {}

/** Links a synced `CalendarEvent` to a user-owned node (calendar-event.ts's `linkedNodeId`,
 *  the companion-node design this file's header comment on `CalendarEvent` describes) — the RPC
 *  front end to the same mechanism `agent-tools.ts`'s `LinkCalendarEventToolInput`/`Output`
 *  eventually calls into once `linkCalendarEvent`'s `ToolNotImplemented` stub (agent-tools.ts's
 *  own doc comment) is replaced with a real implementation. Never creates or deletes the node
 *  itself — `nodeId` must already exist (`NodeNotFound`, errors.ts, if not). */
export class LinkCalendarEventToNodeInput extends Schema.Class<LinkCalendarEventToNodeInput>(
  "LinkCalendarEventToNodeInput"
)({
  workspaceId: EntityId,
  calendarEventId: EntityId,
  nodeId: EntityId,
  requestId: MutationRequestId,
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

export class LinkCalendarEventToNodeOutput extends Schema.Class<LinkCalendarEventToNodeOutput>(
  "LinkCalendarEventToNodeOutput"
)({
  calendarEvent: CalendarEvent
}) {}

// --- Bookmarks -----------------------------------------------------------------------------------

/** Captures a new bookmark (bookmark.ts). The request metadata is part of the durable ledger
 *  command: callers can safely retry an uncertain response without creating a second capture, and
 *  every edit carries explicit provenance and a commit message. `id`/`capturedAt` remain
 *  server-assigned. */
export class CreateBookmarkInput extends Schema.Class<CreateBookmarkInput>("CreateBookmarkInput")({
  workspaceId: EntityId,
  url: BookmarkUrl,
  title: Schema.optional(Schema.String),
  requestId: MutationRequestId,
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

export class CreateBookmarkOutput extends Schema.Class<CreateBookmarkOutput>(
  "CreateBookmarkOutput"
)({
  bookmark: Bookmark
}) {}

export class ListBookmarksInput extends Schema.Class<ListBookmarksInput>("ListBookmarksInput")({
  workspaceId: EntityId
}) {}

export class ListBookmarksOutput extends Schema.Class<ListBookmarksOutput>("ListBookmarksOutput")({
  bookmarks: Schema.Array(Bookmark)
}) {}
