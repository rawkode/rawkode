// `WorkspaceDurableObject` (plan §"Effect-TS integration", "DO class boundary": "build the instance's
// Effect Layer once in the DO constructor... every public RPC method is a thin shim").
//
// One `WorkspaceDurableObject` per workspace (plan §"Storage & domain model": "Sharding unit: one
// WorkspaceDurableObject per workspace"). Reached from the backend Worker's `fetch` handler (`index.ts`)
// via `ctx.exports.WorkspaceDurableObject.getByName(workspaceId)`, which sets `ctx.id.name` to that
// `workspaceId` — read back below so every RPC call can be checked against the workspace this DO instance
// actually is, independent of whatever `workspaceId` a request body claims.
//
// Extended past Phase 0's `createNode`/`listNodes`/`getNode`/`subscribeToNodes` slice (per the
// Storage/Views stage's scope) with: page-body Automerge lifecycle + sync (`NotesService`), and
// the graph mutation surface + structured sync feed + epoch (`GraphService`/`SyncFeedService`).
// The DO class itself stays a thin composition root — real logic lives in the per-domain
// `*-service-live.ts`/`*-repository-live.ts` modules (plan's "God-object mitigation" paragraph:
// "one DO class, composed from separate Effect Services in separate modules").
//
// Phase 4 prerequisite additions (dev-auth + revocation-eviction, see the task's own "Two things
// to resolve before building"):
//
// 1. **Auth-context plumbing.** `fetch()` now parses an optional Bearer credential
//    (`dev-auth.ts#extractBearerCredential`, header or `?token=`) once per connection, verifies
//    it (real HMAC, `dev-auth.ts#verifyDevCredential`), and captures the resulting
//    `AuthenticatedUser | undefined` in the `WorkspaceRpcApi` instance created for that connection —
//    NOT in the shared, construction-time `#runtime`, because one `WorkspaceDurableObject` instance
//    serves many concurrent connections/callers over its lifetime, each potentially a different
//    identity, while `#runtime`'s `Layer` graph is built exactly once, at construction, before
//    any connection (or its identity) exists. Every existing RPC method's behavior is completely
//    unchanged when no credential is sent — this is additive, not a breaking auth requirement
//    (Phase 4 scope: "no observers yet" — real per-method authorization is explicitly a later
//    stage's work; this stage only builds and proves the plumbing). `whoami()` is the one real,
//    working demonstration of a method consuming it via `CurrentUser`/`Effect.provideService`.
// 2. **Revocation-eviction mechanism**, resolving the plan's "Caveat on ctx.abort() reuse"
//    finding for real (see `test/revocation-eviction.test.ts`, which proves both halves
//    empirically): tracked, per-connection live WebSockets (`#activeSockets`) plus
//    `evictSessions()`, a plain native-RPC (`ctx.exports`-only, never Cap'n Web-exposed —
//    deliberately not reachable by an external client) method a future `SharingService`'s
//    `removeCollaborator`/`revokeShareLink` calls instead of cloudflare-os's `ctx.abort()`. See
//    `evictSessions`'s own doc comment for why this is strictly gentler than cloudflare-os's
//    whole-DO-restart approach for this app's stateful Automerge sync sessions.

import { DurableObject } from "cloudflare:workers"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as LogLevel from "effect/LogLevel"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { newHttpBatchRpcResponse, newWebSocketRpcSession, RpcTarget } from "capnweb"
import {
  AcceptChatForkInput,
  AcceptChatForkOutput,
  AddCollaboratorInput,
  AddCollaboratorOutput,
  AddFactInput,
  AddFactOutput,
  AppendTranscriptSegmentInput,
  AppendTranscriptSegmentOutput,
  ApplyChatForkEditInput,
  ApplyChatForkEditOutput,
  ApplyPageEditInput,
  ApplyPageEditOutput,
  AppsRepository,
  CreateAppInput,
  CreateAppOutput,
  DeleteAppInput,
  DeleteAppOutput,
  GetAppCodeInput,
  GetAppCodeOutput,
  GetAppInput,
  GetAppOutput,
  ListAppsInput,
  ListAppsOutput,
  MintAppRunCredentialInput,
  MintAppRunCredentialOutput,
  UpdateAppCodeInput,
  UpdateAppCodeOutput,
  ApplySupertagInput,
  ApplySupertagOutput,
  AssignTagInput,
  AssignTagOutput,
  UnassignTagInput,
  UnassignTagOutput,
  type AuthenticatedUser,
  Bookmark,
  ChatForkPreviewInput,
  ChatForkPreviewOutput,
  CloseVoiceAudioSessionInput,
  CloseVoiceAudioSessionOutput,
  CloudTranscriptionClient,
  CommitVoiceAudioInput,
  CommitVoiceAudioOutput,
  ConnectGoogleCalendarInput,
  ConnectGoogleCalendarOutput,
  CreateBookmarkInput,
  CreateBookmarkOutput,
  CreateShareLinkInput,
  CreateShareLinkOutput,
  CurrentUser,
  CreateChatInput,
  CreateChatOutput,
  CreateEdgeInput,
  CreateEdgeOutput,
  CreateNodeInput,
  CreateNodeOutput,
  CreatePageInput,
  CreatePageOutput,
  CreateRelationDefinitionInput,
  CreateRelationDefinitionOutput,
  CreateTagInput,
  CreateTagOutput,
  DefineTagFieldInput,
  DefineTagFieldOutput,
  DisconnectGoogleCalendarInput,
  DisconnectGoogleCalendarOutput,
  EdgesRepository,
  EndMeetingInput,
  EndMeetingOutput,
  EndVoiceSessionInput,
  EndVoiceSessionOutput,
  EntityId,
  Fact,
  FactsRepository,
  ForkChatEditInput,
  ForkChatEditOutput,
  GetChatInput,
  GetChatOutput,
  GetMeetingInput,
  GetMeetingOutput,
  GetNodeInput,
  GetNodeOutput,
  GetPageTextInput,
  GetPageTextOutput,
  GoogleCalendarOAuthCallbackInput,
  GoogleCalendarOAuthCallbackOutput,
  GraphIssuesRepository,
  IsoDateTimeString,
  LinkCalendarEventToNodeInput,
  LinkCalendarEventToNodeOutput,
  ListBacklinksInput,
  ListBacklinksOutput,
  ListBookmarksInput,
  ListBookmarksOutput,
  ListCalendarEventsInput,
  ListCalendarEventsOutput,
  ListChatChangesInput,
  ListChatChangesOutput,
  ListCollaboratorsInput,
  ListCollaboratorsOutput,
  ListMeetingsInput,
  ListMeetingsOutput,
  ListPendingChangesInput,
  ListPendingChangesOutput,
  ListChatsInput,
  ListChatsOutput,
  ListGraphIssuesInput,
  ListGraphIssuesOutput,
  ListNodesInput,
  ListNodesOutput,
  ListShareLinksInput,
  ListShareLinksOutput,
  ListTagClosureInput,
  ListTagClosureOutput,
  ListTagFieldsInput,
  ListTagFieldsOutput,
  ListTagsInput,
  ListTagsOutput,
  Meeting,
  MergeChangesInput,
  MergeChangesOutput,
  ChatThread,
  ModelClient,
  type ModelError,
  ModelTurnResult,
  NodeNotFound,
  OpenVoiceAudioSessionInput,
  OpenVoiceAudioSessionOutput,
  PollVoiceAudioEventsInput,
  PollVoiceAudioEventsOutput,
  PreviewRemoveCollaboratorInput,
  PreviewRemoveCollaboratorOutput,
  PreviewRevokeShareLinkInput,
  PreviewRevokeShareLinkOutput,
  RealtimeVoiceClient,
  RealtimeVoiceSessionConfig,
  RedeemShareLinkInput,
  RedeemShareLinkOutput,
  RemoveCollaboratorInput,
  RemoveCollaboratorOutput,
  requireAuthenticatedUser,
  RevokeShareLinkInput,
  RevokeShareLinkOutput,
  type Role,
  StartMeetingInput,
  StartMeetingOutput,
  StartVoiceSessionInput,
  StartVoiceSessionOutput,
  ToolSpec,
  Node as NodeEntity,
  NodesRepository,
  PageSyncMessageInput,
  PageSyncMessageOutput,
  PagesRepository,
  RelationDefinitionsRepository,
  RevertChangesInput,
  RevertChangesOutput,
  RevertChatForkInput,
  RevertChatForkOutput,
  RotateEpochInput,
  RotateEpochOutput,
  RunViewInput,
  RunViewOutput,
  SearchNodesInput,
  SearchNodesOutput,
  SearchResultEntry,
  SendChatMessageInput,
  SendChatMessageOutput,
  SendVoiceAudioChunkInput,
  SendVoiceAudioChunkOutput,
  StartPageSyncInput,
  StartPageSyncOutput,
  SyncFeedInput,
  SyncFeedOutput,
  SyncGoogleCalendarInput,
  SyncGoogleCalendarOutput,
  SyncNoteReferencesInput,
  SyncNoteReferencesOutput,
  ResolvedTagField,
  TagClosureEntry,
  TagsRepository,
  Unauthorized,
  UnexpectedError,
  ValidationError,
  WhoamiOutput,
  ImportWorkoutInput,
  ImportWorkoutOutput,
  ImportWorkoutsInput,
  ImportWorkoutsOutput,
  ListWorkoutImportsInput,
  ListWorkoutImportsOutput,
  ListWorkoutsInput,
  ListWorkoutsOutput,
  GetWorkoutInput,
  GetWorkoutOutput,
  WorkoutNotFound,
  type WorkoutImportReceipt,
  type WorkoutSummary,
  type DomainError
} from "@athenaeum/domain"
import type { Singleton } from "@athenaeum/typed-storage-effect"
import { extractBearerCredential, verifyDevCredential } from "./dev-auth.js"
import { signAppRunCredential, verifyAppRunCredential } from "./app-run-credential.js"
import { makeSharingCollections, type SharingCollections } from "./sharing-collections.js"
import { makeSharingServiceLive, SharingService } from "./sharing-service-live.js"
import { initializeWorkspaceOwner, makeWorkspaceMetaSingleton, type WorkspaceMeta } from "./workspace-ownership.js"
import { makeNodesRepositoryLive, makeWorkspaceCollections, type WorkspaceCollections } from "./nodes-repository-live.js"
import { makePagesCollections, makePagesRepositoryLive } from "./pages-repository-live.js"
import { makeTagsCollections, makeTagsRepositoryLive } from "./tags-repository-live.js"
import { makeTagClosureCollections } from "./tag-closure.js"
import { makeFactsCollections, makeFactsRepositoryLive } from "./facts-repository-live.js"
import { makeEdgesCollections, makeEdgesRepositoryLive } from "./edges-repository-live.js"
import {
  makeRelationDefinitionsCollections,
  makeRelationDefinitionsRepositoryLive
} from "./relation-definitions-repository-live.js"
import { makeGraphIssuesCollections, makeGraphIssuesRepositoryLive } from "./graph-issues-repository-live.js"
import { makeSyncFeedCollections, makeSyncFeedServiceLive, SyncFeedService } from "./sync-feed-service-live.js"
import { makeNodeTagsCollections } from "./node-tags-live.js"
import { makeTagFieldDefinitionsCollections } from "./tag-field-definitions-live.js"
import { ensureBaseTagsSeeded } from "./seed-base-tags.js"
import { ensureBaseTagFieldsSeeded } from "./seed-base-tag-fields.js"
import { ensureMentionRelationSeeded } from "./mention-seed.js"
import { GraphService, makeGraphServiceLive } from "./graph-service-live.js"
import { NotesService, makeNotesServiceLive } from "./notes-service-live.js"
import { ChatForkService, makeChatForkServiceLive } from "./chat-fork-service-live.js"
import { ViewsService, makeViewsServiceLive } from "./views-service-live.js"
import { AgentEditService, makeAgentEditServiceLive } from "./agent-edit-service-live.js"
import { makeAgentEditCollections } from "./agent-edit-collections.js"
import { makeAppCollections } from "./app-collections.js"
import { makeAppsRepositoryLive } from "./apps-repository-live.js"
import { AppsService, makeAppsServiceLive } from "./apps-service-live.js"
import { AppRuntimeService, AppRuntimeServiceUnconfigured, makeAppRuntimeServiceLive } from "./app-runtime-service-live.js"
import { CalendarService, makeCalendarServiceLive } from "./calendar-service-live.js"
import { makeCalendarCollections } from "./calendar-collections.js"
import {
  CalendarGatekeeperClient,
  CalendarGatekeeperClientUnconfigured,
  makeCalendarGatekeeperClientServiceBindingLive,
  type CalendarGatekeeperClientApi
} from "./calendar-gatekeeper-client.js"
import { HttpFetchLive, makeModelClientAnthropicLive } from "./model-client-anthropic.js"
import { resolveAiGatewayRoute } from "./ai-gateway-route.js"
import { ensureGraphViews, indexNodeText, upsertNode } from "./read-model.js"
import { NodesSubscription } from "./nodes-subscription.js"
import { decodeRpcInput, domainErrorFromCause, runOrThrowRpcError, runRpcProgram } from "./rpc-boundary.js"
import { makeMeetingCollections } from "./meeting-collections.js"
import {
  makeMeetingAudioBucketR2Live,
  makeMeetingsServiceLive,
  MeetingAudioBucket,
  MeetingAudioBucketUnconfigured,
  MeetingsService
} from "./meetings-service-live.js"
import { makeVoiceSessionCollections } from "./voice-session-collections.js"
import { makeVoiceSessionServiceLive, VoiceSessionService } from "./voice-session-service-live.js"
import { makeWorkoutCollections } from "./workout-collections.js"
import { makeWorkoutsServiceLive, WorkoutsService } from "./workouts-service-live.js"
import { makeCloudTranscriptionClientOpenAILive } from "./cloud-transcription-client-openai.js"
import { makeRealtimeVoiceClientOpenAILive } from "./realtime-voice-client-openai.js"
import { WebSocketTransportLive } from "./websocket-transport.js"
import { runVoiceChatTurns } from "./voice-chat-bridge.js"
import {
  bytesFromBase64,
  closeLiveVoiceAudioSession,
  commitVoiceAudioAndRespond,
  openLiveVoiceAudioSession,
  pollVoiceAudioEvents,
  realtimeVoiceErrorToDomainError,
  sendVoiceAudioChunk,
  type LiveVoiceAudioSessionHandle
} from "./voice-audio-session.js"
import type { Env } from "./index.js"

/**
 * Test-only injection point, same established convention as `graph-service-live.ts`'s
 * `createEdgeTestHook`/`notes-service-live.ts`'s `notesServiceSessionCapTestHook`: production
 * always sees `converse: undefined`, which routes every call to the real (but — per this task's
 * hard constraint — currently unconfigured, since no `ANTHROPIC_API_KEY` secret exists in this
 * environment) `ModelClientAnthropic`. A test sets `converse` to a `ModelClientScripted` handle's
 * own `converse` implementation so `sendChatMessage` can be exercised end-to-end over real Cap'n
 * Web RPC against a deterministic, scripted model — the mechanism this stage's own smoke test
 * uses. **Read live, per call** (not captured once at DO-construction time) — deliberately, unlike
 * an earlier draft of this hook that stored a `Layer` and was read only at construction: a workspace's
 * DO is constructed on its first request of *any* kind (e.g. an unrelated `createRelationDefinition`
 * call issued before the test has decided what to script), so a construction-time-only hook could
 * never be set late enough for tests that need to look up real ids (a relationDefinition, a node)
 * before finalizing the script. Reading live, like `notesServiceSessionCapTestHook.maxSessions`,
 * removes that ordering constraint entirely. The one real `ModelClientAnthropic` instance is still
 * built exactly once per DO construction (below), matching every other service's Layer lifecycle —
 * only the per-call dispatch is live.
 */
export const agentEditModelClientTestHook: {
  converse:
    | ((
        thread: ChatThread,
        availableTools: ReadonlyArray<ToolSpec>
      ) => Effect.Effect<ModelTurnResult, ModelError>)
    | undefined
} = { converse: undefined }

/**
 * Same live-per-call test-injection convention as `agentEditModelClientTestHook` above — read
 * live (not captured once at construction) for the identical reason: this workspace's DO may already
 * be constructed (e.g. Base Tag seeding on an unrelated first request) before a test decides what
 * to script. Production always sees `api: undefined`, routing every `CalendarGatekeeperClient`
 * call to the real (but, per this task's hard constraint, currently unconfigured — no
 * `GATEKEEPER_GOOGLE_CALENDAR` binding in this environment) service-binding client. A test sets
 * `api` to a `CalendarGatekeeperClientApi` built from `@athenaeum/gatekeeper-google-calendar`'s
 * own `GoogleCalendarClientScripted` double (see `test/calendar-service.test.ts`'s own
 * `installScriptedCalendarClient` helper) so `syncGoogleCalendar`/`connectGoogleCalendar`/etc.
 * can be exercised end-to-end over real Cap'n Web RPC against deterministic, realistic fixture
 * data — same mechanism, same rationale as `agentEditModelClientTestHook`.
 */
export const calendarGatekeeperClientTestHook: { api: CalendarGatekeeperClientApi | undefined } = { api: undefined }

/**
 * Same live-per-call test-injection convention as `agentEditModelClientTestHook`/
 * `calendarGatekeeperClientTestHook` above, for `CloudTranscriptionClient` (task item 2). Production
 * always sees `transcribe: undefined`, routing every call to the real (but, per this task's hard
 * constraint, currently unconfigured — no `OPENAI_TRANSCRIPTION_API_KEY` secret exists in this
 * environment) `CloudTranscriptionClientOpenAI`. A test sets `transcribe` to a
 * `CloudTranscriptionClientScripted` handle's own implementation to exercise a real Cap'n Web RPC
 * round trip against deterministic transcription output.
 */
export const cloudTranscriptionClientTestHook: {
  transcribe: Context.Tag.Service<typeof CloudTranscriptionClient>["transcribe"] | undefined
} = { transcribe: undefined }

/**
 * Same live-per-call test-injection convention, for `RealtimeVoiceClient` (task item 2/3).
 * Production always sees `openSession: undefined`, routing every call to the real (but currently
 * unconfigured — no `OPENAI_REALTIME_API_KEY` secret exists in this environment)
 * `RealtimeVoiceClientOpenAI`. A test sets `openSession` to a `RealtimeVoiceClientScripted`
 * handle's own implementation — this is what `WorkspaceDurableObject#debugRunVoiceChatTurns` (see that
 * method's own doc comment) drives to prove voice-sourced text reaches the REAL
 * `AgentEditService.sendChatMessage`, not a hand-built double, over the real instance Layer.
 */
export const voiceRealtimeClientTestHook: {
  openSession: Context.Tag.Service<typeof RealtimeVoiceClient>["openSession"] | undefined
} = { openSession: undefined }

/** Every service this DO instance's Layer provides, once composed. */
type WorkspaceServices =
  | NodesRepository
  | PagesRepository
  | TagsRepository
  | FactsRepository
  | EdgesRepository
  | RelationDefinitionsRepository
  | GraphIssuesRepository
  | AppsRepository
  | SyncFeedService
  | GraphService
  | NotesService
  | ChatForkService
  | ViewsService
  | AgentEditService
  | AppsService
  | AppRuntimeService
  | SharingService
  | CalendarService
  | MeetingsService
  | VoiceSessionService
  | CloudTranscriptionClient
  | RealtimeVoiceClient
  | WorkoutsService

/** Fails closed with a `ValidationError` (not a defect) if `workspaceId` doesn't match the workspace this
 *  DO instance actually is — cheap defense-in-depth now that both the DO's own identity
 *  (`ctx.id.name`) and every RPC payload independently carry a `workspaceId`. */
const requireOwnWorkspace = (
  ownWorkspaceId: EntityId,
  requestedWorkspaceId: EntityId
): Effect.Effect<void, ValidationError> =>
  requestedWorkspaceId === ownWorkspaceId
    ? Effect.void
    : Effect.fail(
        new ValidationError({
          message: `workspaceId ${requestedWorkspaceId} does not match this connection's workspace (${ownWorkspaceId})`
        })
      )

/**
 * Phase 4 task item 7's `use`/`build` capability gate. **Adversarial-review fix (both blocking
 * findings, same root cause):** previously (a) skipped enforcement entirely whenever
 * `currentUser === undefined` — treating "no credential presented" as "skip the check" rather
 * than "no role," so an anonymous caller who merely knew a workspaceId got full build-level access to
 * a governed, shared workspace, and a just-revoked collaborator could regain full access after
 * eviction simply by reconnecting with no Bearer header at all — and (b) was only wired into 4 of
 * this file's ~35 RPC methods ("a representative slice"), leaving every other structural mutation
 * (`createTag`/`createEdge`/`createRelationDefinition`/`assignTag`/`createPage`/`applyPageEdit`/
 * page-sync/chat-fork/agent-chat methods) completely ungated for any caller, credentialed or not.
 *
 * Fixed on both axes:
 *   1. **No credential is now "no role," never "skip."** `currentUser === undefined` on a
 *      GOVERNED workspace fails closed with `Unauthorized` — the same tag `requireAuthenticatedUser`
 *      already uses for "no verified identity at all" (see `errors.ts`'s own doc comment
 *      distinguishing `Unauthorized` from `WorkspaceAccessDenied`). Only an UNGOVERNED workspace
 *      (`SharingService#getOwnerEmail() === null` — a workspace created via `freshWorkspaceId()` in a
 *      test, or any workspace that never went through `UserDurableObject#createWorkspace`/`registerWorkspace`,
 *      i.e. never "opted into" the sharing regime at all) stays fully open to anonymous callers,
 *      preserving every pre-existing Phase 0-3 test/client that never authenticates.
 *   2. **Called from every RPC method below that reads or mutates workspace-governed data** (not a
 *      slice) — read-only methods require `"use"`, every structural/content mutation requires
 *      `"build"`, mirroring the already-established `createNode`/`addFact` (`build`) vs.
 *      `listNodes`/`runView` (`use`) split. `whoami()` is the sole deliberate exception (it
 *      answers "who am I," including for anonymous callers, by design) — every sharing-management
 *      method (`addCollaborator` etc.) already enforces its own real access check via
 *      `requireAuthenticatedUser` + `SharingService#resolveCaller`/`requireCallerRole`, which
 *      fails closed on a missing `CurrentUser` independently of this helper.
 *
 * `test/sharing-service.test.ts`'s "use/build gating" suite and the fresh reproduction in this
 * fix's own verification exercise both axes against workspaces created the real way.
 */
const requireRoleForGovernedWorkspace = (
  currentUser: AuthenticatedUser | undefined,
  minRole: Role
): Effect.Effect<void, DomainError, SharingService> =>
  Effect.gen(function* () {
    const sharing = yield* SharingService
    const ownerEmail = yield* sharing.getOwnerEmail
    if (ownerEmail === null) return // ungoverned workspace: unchanged pre-Phase-4 behavior
    if (currentUser === undefined) {
      return yield* Effect.fail(
        new Unauthorized({
          message: "This workspace is shared; a verified identity (Bearer credential) is required."
        })
      )
    }
    yield* sharing.requireMinimumRole(currentUser.email, minRole)
  })

// --- App Library backend-EXECUTION stage: plain-HTTP App routes ------------------------------
//
// Two new routes, handled directly by `WorkspaceDurableObject#fetch()` (task item 2/3) — deliberately
// NOT Cap'n Web/`WorkspaceRpcApi` methods, since an App's sandboxed code needs a plain HTTP
// `Request`/`Response` round trip (the iframe's own `fetch()`/`<script src>` calls), not an RPC
// stub:
//   - `/api/workspace/:workspaceId/apps/:appId/run(/...)`  — proxies into the App's sandboxed
//     `server` code (`AppRuntimeService`, `app-runtime-service-live.ts`).
//   - `/api/workspace/:workspaceId/apps/:appId/client.js`  — serves the App's current mainline
//     `client` code verbatim, for the iframe to load as a `<script src>`.
//
// Both require EITHER `requireRoleForGovernedWorkspace(currentUser, "use")` — "an app should only
// be runnable by someone with access to its workspace" (task item 2), exactly the same gate
// `getApp`/`getAppCode` already use for reads — OR a valid, correctly-scoped `athenaeum-app-run-v1`
// credential (`app-run-credential.ts`, `mintAppRunCredential` above). The latter is the
// **adversarial-review fix**: `AppLibraryPanel.tsx`'s preview iframe and the App's own sandboxed
// client-side code have no session of their own to present a real Bearer credential on, and must
// never be handed the caller's actual one (see `mintAppRunCredential`'s own doc comment for the
// full "why") — so `fetch()` below accepts this narrowly-scoped alternative specifically for these
// two routes, checked against the SAME `workspaceId`/`appId` the URL itself names (a credential
// minted for a different App or workspace is rejected exactly as if no credential were presented
// at all).

const APP_RUN_PATH = /^\/api\/workspace\/([^/]+)\/apps\/([^/]+)\/run(\/.*)?$/
const APP_CLIENT_JS_PATH = /^\/api\/workspace\/([^/]+)\/apps\/([^/]+)\/client\.js$/

/** Matches `url.pathname` against both App HTTP route shapes above and, if either matches,
 *  extracts the RAW (not yet `EntityId`-validated) `workspaceId`/`appId` path segments — used by
 *  `fetch()` to decide whether a failed session-credential verification should fall back to
 *  trying an App-run credential instead, and to check that credential's own `workspaceId`/`appId`
 *  against the route actually being called. Returns `undefined` for every other path (every
 *  existing Cap'n Web/RPC route), which is what keeps this fallback from ever widening the strict
 *  "invalid Bearer => 401 outright" behavior any OTHER route still has. */
const parseAppRouteIds = (pathname: string): { readonly workspaceId: string; readonly appId: string } | undefined => {
  const clientMatch = APP_CLIENT_JS_PATH.exec(pathname)
  if (clientMatch) return { workspaceId: clientMatch[1] ?? "", appId: clientMatch[2] ?? "" }
  const runMatch = APP_RUN_PATH.exec(pathname)
  if (runMatch) return { workspaceId: runMatch[1] ?? "", appId: runMatch[2] ?? "" }
  return undefined
}

/**
 * Maps a `DomainError` reaching one of the two App HTTP routes above to a real HTTP status code
 * and a small human-readable body — the plain-HTTP analog of `rpc-boundary.ts`'s `throwRpcError`
 * envelope (that convention is Cap'n Web-specific: it throws a JSON-encoded envelope an RPC
 * client decodes via `decodeRpcError`; a plain HTTP route has no such client-side decoder, so it
 * gets an ordinary status code instead). Every tag this file's App routes can actually produce is
 * named explicitly (rather than a blanket default) so a future new failure mode doesn't silently
 * fall through to a misleading status — the same "explicit, not defaulted" discipline
 * `requireRoleForGovernedWorkspace`'s own doc comment argues for.
 */
const domainErrorToHttpResponse = (error: DomainError): Response => {
  switch (error._tag) {
    case "ValidationError":
      return new Response(error.message, { status: 400 })
    case "Unauthorized":
      return new Response(error.message, { status: 401 })
    case "WorkspaceAccessDenied":
      return new Response("You do not have access to this workspace.", { status: 403 })
    case "AppNotFound":
      return new Response(`No such App: ${error.appId}`, { status: 404 })
    case "AppCodeVersionNotFound":
      return new Response(`App ${error.appId} has no ${error.kind} code yet.`, { status: 404 })
    default:
      // Every other `DomainError` tag this codebase defines is either unreachable from these two
      // routes' own programs (e.g. `NodeNotFound`) or a genuine internal failure
      // (`UnexpectedError`, including `AppRuntimeServiceUnconfigured`'s fail-closed message and a
      // sandboxed App's server code throwing) — 500 either way, never silently 200.
      return new Response("Internal error handling this App request.", { status: 500 })
  }
}

/**
 * Real-browser-verification-stage fix (found by actually clicking a seeded counter App's "+1"
 * button in a real browser, not caught by any prior stage's own tests — those drove `/run`/
 * `client.js` with a raw `fetch`/`capnweb` script or `SELF.fetch` in `workerd`, neither of which
 * enforces CORS the way a real browser does): the launch view's sandboxed `<iframe>` deliberately
 * has NO `allow-same-origin` (`AppRunFrame.tsx`'s own header comment — the whole point is that the
 * App's document gets an opaque, unique origin). That means every `fetch()` the App's own client
 * code makes to these two routes is, per the Fetch spec, a genuinely cross-origin request from
 * origin `"null"` — even though the URL is same-origin as the top-level page — and a real browser
 * enforces CORS on it regardless. Without an `Access-Control-Allow-Origin` response header, the
 * browser discards the response before the App's own script ever sees it (`TypeError: Failed to
 * fetch`), exactly the failure this stage's own verification reproduced. `*` is safe here for the
 * identical reason the existing Cap'n Web batch route above already uses it unconditionally: these
 * two routes authenticate via a `?token=` query credential (`app-run-credential.ts`), never
 * cookies, and both explicitly strip any inbound `Authorization`/`Cookie` header before doing
 * anything else — there is no ambient credential a wildcard origin could trick a browser into
 * attaching. Applied to every response these two routes can produce (success AND error), not just
 * the happy path, so an App's own error-handling code can actually observe the real status instead
 * of an opaque "network error."
 */
const APP_ROUTE_CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400"
}

const withAppRouteCors = (response: Response): Response => {
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(APP_ROUTE_CORS_HEADERS)) headers.set(key, value)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * Closes the "calendar-derived-content-style exclusion" gap for `Meeting.linkedNodeId`/
 * `Bookmark.linkedNodeId` (adversarial-review fix, Phase 6) — the exact same class of gap
 * `listNodes`/`getNode`/`runView`/`searchNodes` above already close for `nodes` rows themselves
 * via `CalendarService#hiddenCalendarDerivedNodeIds`, applied here to the optional companion-node
 * reference a `Meeting`/`Bookmark` can carry. Currently dormant in practice — no RPC in this
 * codebase (`meeting-rpc.ts`, `gatekeeper-rpc.ts`) ever sets `linkedNodeId` on either entity yet —
 * but the read path must not silently hand a non-qualifying observer a hidden calendar-derived
 * node's opaque id the moment a future stage adds a way to set it (`packages/web/src
 * /MeetingsPanel.tsx` already renders `linkedNodeId` today, falling back to printing the raw id in
 * italics when `getNode` can't resolve it — exactly the oracle this closes).
 *
 * `getMeeting`/`listMeetings`/`listBookmarks` below call this with each row's own `linkedNodeId`;
 * the field is dropped from the reconstructed entity entirely when hidden (never set to
 * `undefined`) — the same "omit, don't null" convention `calendar-service-live.ts
 * #upsertRemoteEvent`'s `...(existing?.linkedNodeId !== undefined ? {...} : {})` idiom already
 * uses elsewhere in this codebase for this exact optional field — so a hidden `linkedNodeId`
 * round-trips identically to a `linkedNodeId` that was never set, never distinguishable as its own
 * oracle (mirrors `getNode`'s own "hidden folds into NodeNotFound" discipline just above).
 */
const hideLinkedNodeIdIfHidden = (
  linkedNodeId: EntityId | undefined,
  hidden: ReadonlySet<EntityId>
): EntityId | undefined => (linkedNodeId !== undefined && hidden.has(linkedNodeId) ? undefined : linkedNodeId)

const sanitizeMeetingLinkedNodeId = (meeting: Meeting, hidden: ReadonlySet<EntityId>): Meeting => {
  const visibleLinkedNodeId = hideLinkedNodeIdIfHidden(meeting.linkedNodeId, hidden)
  if (visibleLinkedNodeId === meeting.linkedNodeId) return meeting
  return new Meeting({
    id: meeting.id,
    workspaceId: meeting.workspaceId,
    title: meeting.title,
    startedAt: meeting.startedAt,
    ...(meeting.endedAt !== undefined ? { endedAt: meeting.endedAt } : {})
    // linkedNodeId omitted: it was hidden from this caller (see this helper's own doc comment).
  })
}

const sanitizeBookmarkLinkedNodeId = (bookmark: Bookmark, hidden: ReadonlySet<EntityId>): Bookmark => {
  const visibleLinkedNodeId = hideLinkedNodeIdIfHidden(bookmark.linkedNodeId, hidden)
  if (visibleLinkedNodeId === bookmark.linkedNodeId) return bookmark
  return new Bookmark({
    id: bookmark.id,
    workspaceId: bookmark.workspaceId,
    url: bookmark.url,
    capturedAt: bookmark.capturedAt,
    ...(bookmark.title !== undefined ? { title: bookmark.title } : {})
    // linkedNodeId omitted: it was hidden from this caller (see this helper's own doc comment).
  })
}

/**
 * `listWorkoutImports`' own observer-exclusion gate (Phase 7, same defensive convention
 * `hiddenCalendarDerivedNodeIds`/`sanitizeMeetingLinkedNodeId`/`sanitizeBookmarkLinkedNodeId`
 * above already establish for every other `linkedNodeId`-shaped field). **Row-level filtering**,
 * not field-level omission like the two sanitizers above — deliberately: `Meeting.linkedNodeId`/
 * `Bookmark.linkedNodeId` are *optional* annotations on an otherwise-independent entity (a meeting
 * is still a meaningful row with no linked node at all), so hiding just the field and keeping the
 * row is correct. `WorkoutImportReceipt.rootNodeId` (workout.ts) is NOT optional — a receipt with
 * no node reference isn't a degraded-but-valid receipt, it's meaningless (the whole point of the
 * row is "this HealthKit workout became this node") — so when its `rootNodeId` would be hidden,
 * the entire receipt row is dropped from the result instead, the same "omit the whole thing, never
 * emit a semantically-broken shape" choice `listNodes`'/`runView`'s row-filtering already makes
 * for hidden nodes themselves. Currently a no-op in every real call path (nothing makes a
 * workout-imported node calendar-derived), matching this codebase's own "real, tested, but
 * currently vacuous" precedent for `Meeting.linkedNodeId` before any RPC ever set one.
 */
const filterHiddenWorkoutImportReceipts = (
  receipts: ReadonlyArray<WorkoutImportReceipt>,
  hidden: ReadonlySet<EntityId>
): ReadonlyArray<WorkoutImportReceipt> =>
  hidden.size === 0 ? receipts : receipts.filter((receipt) => !hidden.has(receipt.rootNodeId))

/** `listWorkouts`' own observer-exclusion gate — same row-drop rationale as
 *  `filterHiddenWorkoutImportReceipts` above, applied to `WorkoutSummary.nodeId` (the workout
 *  ROOT node's id — see that field's own doc comment, workout.ts) instead of
 *  `WorkoutImportReceipt.rootNodeId`. Currently a no-op in every real call path, matching that
 *  helper's own "real, tested, but currently vacuous" precedent. */
const filterHiddenWorkoutSummaries = (
  summaries: ReadonlyArray<WorkoutSummary>,
  hidden: ReadonlySet<EntityId>
): ReadonlyArray<WorkoutSummary> =>
  hidden.size === 0 ? summaries : summaries.filter((summary) => !hidden.has(summary.nodeId))

/**
 * The Cap'n Web-facing RPC surface (plan §"Effect-TS integration", "RPC transport"). Every
 * method: `Schema.decodeUnknown` the input (`decodeRpcInput`), run an Effect program against the
 * services provided by the instance's pre-built `ManagedRuntime` (see `rpc-boundary.ts`'s
 * `runRpcProgram` doc comment for why a `ManagedRuntime` and not a raw `Layer.Layer` +
 * `Effect.provide` per call), and either return the schema-encoded success value or throw the
 * `{tag, message, data}` envelope.
 */
class WorkspaceRpcApi extends RpcTarget {
  readonly #runtime: ManagedRuntime.ManagedRuntime<WorkspaceServices, never>
  readonly #collections: WorkspaceCollections
  readonly #workspaceId: EntityId
  readonly #sql: SqlStorage
  /** This connection's verified identity, parsed once at `fetch()`/WS-upgrade time — see this
   *  file's header comment ("Auth-context plumbing") for why it lives here, per `WorkspaceRpcApi`
   *  instance, rather than in the shared `#runtime`. `undefined` for an anonymous connection (no
   *  Bearer credential sent) — every method below except `whoami` is completely indifferent to
   *  this field's value, by design (Phase 4 scope: real per-method authorization is later-stage
   *  work; this stage only builds and proves the plumbing itself). */
  readonly #currentUser: AuthenticatedUser | undefined
  /** Fire-and-forget hook into `WorkspaceDurableObject#scheduleRevocationEviction` (see that method's
   *  own doc comment) — `removeCollaborator`/`revokeShareLink` call this with the profile ids
   *  `SharingService` reported as actually affected, whenever that set is non-empty, per
   *  docs/sharing.md §"Terminating live sessions on revocation": "pure no-op removals don't
   *  restart." `WorkspaceRpcApi` has no access to the DO instance's own `evictSessions`/`ctx` — this
   *  callback is how the DO hands that capability down without exposing it over Cap'n Web. */
  readonly #scheduleEviction: (emails: ReadonlyArray<string>, reason: string) => void
  /** Shared by reference with the owning `WorkspaceDurableObject` instance's own
   *  `#liveVoiceAudioSessions` (see that field's doc comment for why a live voice-audio session
   *  must live on the DO instance, not here — `WorkspaceRpcApi` is reconstructed per HTTP-batch
   *  request, this Map is not). */
  readonly #liveVoiceAudioSessions: Map<string, LiveVoiceAudioSessionHandle>
  /** `Env.DEV_AUTH_HMAC_SECRET`, threaded down from the owning `WorkspaceDurableObject` instance's
   *  own `this.env` (a plain `RpcTarget` has no `env` of its own) — `mintAppRunCredential`'s only
   *  use of it, see that method's own doc comment. Same "thread the one value a method needs,
   *  don't hand the whole `Env` down" discipline this class already applies to `scheduleEviction`
   *  above. */
  readonly #devAuthHmacSecret: string | undefined

  constructor(
    runtime: ManagedRuntime.ManagedRuntime<WorkspaceServices, never>,
    collections: WorkspaceCollections,
    workspaceId: EntityId,
    sql: SqlStorage,
    currentUser: AuthenticatedUser | undefined,
    scheduleEviction: (emails: ReadonlyArray<string>, reason: string) => void,
    liveVoiceAudioSessions: Map<string, LiveVoiceAudioSessionHandle>,
    devAuthHmacSecret: string | undefined
  ) {
    super()
    this.#runtime = runtime
    this.#collections = collections
    this.#workspaceId = workspaceId
    this.#sql = sql
    this.#currentUser = currentUser
    this.#scheduleEviction = scheduleEviction
    this.#liveVoiceAudioSessions = liveVoiceAudioSessions
    this.#devAuthHmacSecret = devAuthHmacSecret
  }

  // --- Phase 4 prerequisite: auth-context plumbing proof ---------------------------------------

  /**
   * The reference implementation of the auth-context pattern every future auth-gated RPC method
   * builds against: provide `CurrentUser` (an `Option`, per its own doc comment in
   * `domain/src/auth.ts`) into a small Effect program via `Effect.provideService`, layered on top
   * of — not baked into — the shared `#runtime`. Never throws `Unauthorized`: unlike a future
   * `SharingService` method gated with `requireAuthenticatedUser`, `whoami` is intentionally
   * answerable by anonymous callers too (`{authenticated: false}`), since "who am I" is a
   * reasonable question for an unauthenticated connection to ask.
   */
  async whoami(): Promise<unknown> {
    const program = CurrentUser.pipe(
      Effect.map((maybeUser) =>
        Option.match(maybeUser, {
          onNone: () => new WhoamiOutput({ authenticated: false }),
          onSome: (user) => new WhoamiOutput({ authenticated: true, email: user.email })
        })
      ),
      Effect.provideService(CurrentUser, Option.fromNullable(this.#currentUser))
    )
    return runRpcProgram(this.#runtime, program, WhoamiOutput)
  }

  // --- Phase 0: nodes -------------------------------------------------------------------------

  async createNode(input: unknown): Promise<unknown> {
    const sql = this.#sql
    const currentUser = this.#currentUser
    const program = decodeRpcInput(CreateNodeInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const repository = yield* NodesRepository
          const syncFeed = yield* SyncFeedService
          const node = new NodeEntity({
            // Web-stage addition (see domain's `CreateNodeInput.id` doc comment): an explicit
            // caller-supplied id (the daily-note deterministic-id flow) wins; every other caller
            // gets the original Phase 0 behavior of a fresh random id.
            id: decoded.id ?? Schema.decodeUnknownSync(EntityId)(crypto.randomUUID()),
            workspaceId: decoded.workspaceId,
            title: decoded.title,
            createdAt: Schema.decodeUnknownSync(IsoDateTimeString)(new Date().toISOString())
          })
          const created = yield* repository.put(node)
          // Views/Search stage additions to this otherwise-untouched Phase 0 method: keep the
          // `read-model.ts` SQL read-model (`upsertNode`) and the `graph_text_search` FTS5 index
          // (`indexNodeText` — title only at creation time, empty body until a page exists) in
          // sync with the canonical KV write above, same pattern as every other mutation in this
          // file/`graph-service-live.ts`/`notes-service-live.ts`.
          yield* upsertNode(sql, created)
          yield* indexNodeText(sql, created.id, created.title, "")
          // Structured-record sync feed (task item 6: "records every mutation to nodes/tags/
          // facts/relationDefinitions/edges as a feed entry") — Phase 0's `createNode` predates
          // the feed, so this is the Storage/Views stage's one addition to an otherwise-untouched
          // Phase 0 method, not a rewrite of its own logic.
          yield* syncFeed.append("node", created.id, "put", created)
          return new CreateNodeOutput({ node: created })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, CreateNodeOutput)
  }

  async listNodes(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ListNodesInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const repository = yield* NodesRepository
          const nodes = yield* repository.list(decoded.workspaceId)
          // Real observer-visibility enforcement, calendar-derived subset only (task: "exclude
          // from what that viewer can see" — a real filter on reads, not just a comment; see
          // `CalendarService#hiddenCalendarDerivedNodeIds`'s own doc comment). Every non-calendar
          // node is completely unaffected — sharing a workspace does not itself gate on this.
          const calendar = yield* CalendarService
          const hidden = yield* calendar.hiddenCalendarDerivedNodeIds(decoded.workspaceId, currentUser?.email)
          const visibleNodes = hidden.size === 0 ? nodes : nodes.filter((node) => !hidden.has(node.id))
          return new ListNodesOutput({ nodes: visibleNodes })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ListNodesOutput)
  }

  async getNode(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(GetNodeInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const repository = yield* NodesRepository
          const node = yield* repository.get(decoded.nodeId)
          // Same enforcement as `listNodes` above, applied to the single-node read: a
          // calendar-derived node this caller cannot currently see is reported exactly as a
          // nonexistent node would be — never distinguished from a plain "no such node", so this
          // gate cannot be used to probe for a hidden node's existence.
          const calendar = yield* CalendarService
          const hidden = yield* calendar.hiddenCalendarDerivedNodeIds(decoded.workspaceId, currentUser?.email)
          if (hidden.has(node.id)) {
            return yield* Effect.fail(new NodeNotFound({ nodeId: decoded.nodeId }))
          }
          return new GetNodeOutput({ node })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, GetNodeOutput)
  }

  async subscribeToNodes(input: unknown): Promise<NodesSubscription> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ListNodesInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) => NodesSubscription.create(this.#collections, decoded.workspaceId))
    )
    return runOrThrowRpcError(this.#runtime, program)
  }

  // --- Page bodies (Automerge) ----------------------------------------------------------------

  async createPage(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(CreatePageInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const notes = yield* NotesService
          const { page, text } = yield* notes.createPage(decoded.nodeId)
          return new CreatePageOutput({ page, text })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, CreatePageOutput)
  }

  async getPageText(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(GetPageTextInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const notes = yield* NotesService
          const { page, text } = yield* notes.getPageText(decoded.nodeId)
          return new GetPageTextOutput({ page, text })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, GetPageTextOutput)
  }

  async applyPageEdit(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ApplyPageEditInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const notes = yield* NotesService
          const { page, text } = yield* notes.applyLocalEdit(
            decoded.nodeId,
            decoded.index,
            decoded.deleteCount,
            decoded.insertText
          )
          return new ApplyPageEditOutput({ page, text })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ApplyPageEditOutput)
  }

  async startPageSync(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(StartPageSyncInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const notes = yield* NotesService
          const message = yield* notes.startSync(decoded.nodeId, decoded.sessionId)
          return new StartPageSyncOutput({ sessionId: decoded.sessionId, message })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, StartPageSyncOutput)
  }

  async pageSyncMessage(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(PageSyncMessageInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const notes = yield* NotesService
          const result = yield* notes.receiveSyncMessage(
            decoded.nodeId,
            decoded.sessionId,
            decoded.ordinal,
            decoded.message
          )
          return new PageSyncMessageOutput({
            sessionId: decoded.sessionId,
            ordinal: decoded.ordinal,
            message: result.message,
            converged: result.converged,
            reset: result.reset
          })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, PageSyncMessageOutput)
  }

  // --- Chat-fork provisional edits (Phase 3 spike, plan risk #4) ------------------------------
  //
  // Deliberately separate from the page-bodies methods above: these never touch
  // `collections.pageDocs`/`collections.pages` until `acceptChatFork` — see
  // chat-fork-service-live.ts's header comment for the full design.

  async forkChatEdit(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ForkChatEditInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const chatFork = yield* ChatForkService
          const { text } = yield* chatFork.fork(decoded.chatId, decoded.nodeId)
          return new ForkChatEditOutput({ text })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ForkChatEditOutput)
  }

  async applyChatForkEdit(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ApplyChatForkEditInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const chatFork = yield* ChatForkService
          const { text } = yield* chatFork.applyForkEdit(
            decoded.chatId,
            decoded.nodeId,
            decoded.index,
            decoded.deleteCount,
            decoded.insertText
          )
          return new ApplyChatForkEditOutput({ text })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ApplyChatForkEditOutput)
  }

  async chatForkPreview(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ChatForkPreviewInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const chatFork = yield* ChatForkService
          const preview = yield* chatFork.previewFork(decoded.chatId, decoded.nodeId)
          return new ChatForkPreviewOutput({ forked: preview.forked, text: preview.text })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ChatForkPreviewOutput)
  }

  async acceptChatFork(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(AcceptChatForkInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const chatFork = yield* ChatForkService
          const { page, text } = yield* chatFork.accept(decoded.chatId, decoded.nodeId)
          return new AcceptChatForkOutput({ page, text })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, AcceptChatForkOutput)
  }

  async revertChatFork(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(RevertChatForkInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const chatFork = yield* ChatForkService
          yield* chatFork.revert(decoded.chatId, decoded.nodeId)
          return new RevertChatForkOutput({ chatId: decoded.chatId, nodeId: decoded.nodeId })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, RevertChatForkOutput)
  }

  // --- Graph mutations ------------------------------------------------------------------------

  async createTag(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(CreateTagInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const graph = yield* GraphService
          const tag = yield* graph.createTag(decoded.workspaceId, decoded.name, decoded.parentIds)
          return new CreateTagOutput({ tag })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, CreateTagOutput)
  }

  async addFact(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(AddFactInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const graph = yield* GraphService
          const fact: Fact = yield* graph.addFact(
            decoded.workspaceId,
            decoded.nodeId,
            decoded.predicateId,
            decoded.value,
            decoded.id
          )
          return new AddFactOutput({ fact })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, AddFactOutput)
  }

  async createRelationDefinition(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(CreateRelationDefinitionInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const graph = yield* GraphService
          const relationDefinition = yield* graph.createRelationDefinition(
            decoded.workspaceId,
            decoded.forwardName,
            decoded.inverseName,
            decoded.sourceTagId,
            decoded.targetTagId,
            decoded.cardinality
          )
          return new CreateRelationDefinitionOutput({ relationDefinition })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, CreateRelationDefinitionOutput)
  }

  async createEdge(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(CreateEdgeInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const graph = yield* GraphService
          const edge = yield* graph.createEdge(
            decoded.workspaceId,
            decoded.relationDefinitionId,
            decoded.sourceNodeId,
            decoded.targetNodeId
          )
          return new CreateEdgeOutput({ edge })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, CreateEdgeOutput)
  }

  async listBacklinks(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ListBacklinksInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const graph = yield* GraphService
          const edges = yield* graph.listBacklinks(decoded.nodeId)
          return new ListBacklinksOutput({ edges })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ListBacklinksOutput)
  }

  /** Rich-text-editor pass, entity-reference-to-edge projection (`docs/rich-text-editor-decisions.md`
   *  §5): reconciles the web editor's client-derived `@`-mention set for `nodeId` into real
   *  "mentions" `Edge` rows via `GraphService.syncNoteReferences` — see that method's own doc
   *  comment for the reconciliation semantics. A mutation (creates/deletes edges), so gated
   *  `"build"` like every other structural mutation in this section, not `"use"` like the
   *  read-only `listBacklinks` just above. */
  async syncNoteReferences(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(SyncNoteReferencesInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const graph = yield* GraphService
          const edges = yield* graph.syncNoteReferences(decoded.workspaceId, decoded.nodeId, decoded.referencedNodeIds)
          return new SyncNoteReferencesOutput({ edges })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, SyncNoteReferencesOutput)
  }

  async listGraphIssues(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ListGraphIssuesInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const graph = yield* GraphService
          const graphIssues = yield* graph.listGraphIssues(decoded.workspaceId)
          return new ListGraphIssuesOutput({ graphIssues })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ListGraphIssuesOutput)
  }

  // Adversarial-review fix: `graph-rpc.ts`'s `ListTagsInput`/`ListTagsOutput` schemas were
  // already defined (and `GraphService.listTags`/`TagsRepository.list` already existed) but no
  // `WorkspaceRpcApi` method ever called them — the native `WorkspaceRPCClient.listTags()` client method
  // (`WorkspaceRPCClient+Graph.swift`) called an RPC method that genuinely did not exist server-side.
  // This is that missing thin shim, same pattern as every other list* method above.
  async listTags(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ListTagsInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const graph = yield* GraphService
          const tags = yield* graph.listTags(decoded.workspaceId)
          return new ListTagsOutput({ tags })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ListTagsOutput)
  }

  async listTagClosure(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ListTagClosureInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const graph = yield* GraphService
          const rows = yield* graph.listTagClosure(decoded.workspaceId)
          return new ListTagClosureOutput({
            entries: rows.map((row) => new TagClosureEntry({ ancestorId: row.ancestorId, descendantId: row.descendantId }))
          })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ListTagClosureOutput)
  }

  async assignTag(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(AssignTagInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const graph = yield* GraphService
          yield* graph.assignTag(decoded.workspaceId, decoded.nodeId, decoded.tagId)
          return new AssignTagOutput({ nodeId: decoded.nodeId, tagId: decoded.tagId })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, AssignTagOutput)
  }

  /** `assignTag`'s symmetric counterpart (supertag-centering pass §2's `unassignTag` addition —
   *  see `GraphService.unassignTag`'s own doc comment). Same authorization tier as `assignTag`
   *  (`"build"`): removing a node's tag membership is a structural graph mutation, not a read. */
  async unassignTag(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(UnassignTagInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const graph = yield* GraphService
          yield* graph.unassignTag(decoded.workspaceId, decoded.nodeId, decoded.tagId)
          return new UnassignTagOutput({ nodeId: decoded.nodeId, tagId: decoded.tagId })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, UnassignTagOutput)
  }

  // --- Supertag-centering pass (docs/supertag-centering-decisions.md §1/§2) -------------------

  async defineTagField(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(DefineTagFieldInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const graph = yield* GraphService
          const fieldDefinition = yield* graph.defineTagField(
            decoded.workspaceId,
            decoded.tagId,
            decoded.name,
            decoded.valueKind,
            decoded.sortOrder
          )
          return new DefineTagFieldOutput({ fieldDefinition })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, DefineTagFieldOutput)
  }

  async listTagFields(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ListTagFieldsInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const graph = yield* GraphService
          const resolved = yield* graph.listTagFields(decoded.workspaceId, decoded.tagId)
          return new ListTagFieldsOutput({
            fields: resolved.map((entry) => new ResolvedTagField({ field: entry.field, inherited: entry.inherited }))
          })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ListTagFieldsOutput)
  }

  async applySupertag(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ApplySupertagInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const graph = yield* GraphService
          const facts = yield* graph.applySupertag(
            decoded.workspaceId,
            decoded.nodeId,
            decoded.tagId,
            (decoded.fieldValues ?? []).map((fv) => ({ fieldId: fv.fieldId, value: fv.value }))
          )
          return new ApplySupertagOutput({ nodeId: decoded.nodeId, tagId: decoded.tagId, facts })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ApplySupertagOutput)
  }

  // --- Views + full-text search (task items 4-5) -----------------------------------------------

  async runView(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(RunViewInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          // Same observer-exclusion gate as `listNodes`/`getNode` above (adversarial-review fix —
          // see `views-service-live.ts`'s header comment for why this was previously missing).
          const calendar = yield* CalendarService
          const hidden = yield* calendar.hiddenCalendarDerivedNodeIds(decoded.workspaceId, currentUser?.email)
          const views = yield* ViewsService
          const rows = yield* views.runView(decoded.workspaceId, decoded.viewName, decoded.viewSpec, hidden)
          return new RunViewOutput({ rows })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, RunViewOutput)
  }

  async searchNodes(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(SearchNodesInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          // Same observer-exclusion gate as `listNodes`/`getNode` above (adversarial-review fix —
          // see `views-service-live.ts`'s header comment for why this was previously missing).
          const calendar = yield* CalendarService
          const hidden = yield* calendar.hiddenCalendarDerivedNodeIds(decoded.workspaceId, currentUser?.email)
          const views = yield* ViewsService
          const rows = yield* views.searchNodes(decoded.workspaceId, decoded.query, decoded.limit ?? 50, hidden)
          return new SearchNodesOutput({
            results: rows.map((row) => new SearchResultEntry({ nodeId: row.nodeId, title: row.title, snippet: row.snippet }))
          })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, SearchNodesOutput)
  }

  // --- Structured-record sync feed + epoch -----------------------------------------------------

  async syncFeed(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(SyncFeedInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const sync = yield* SyncFeedService
          const page = yield* sync.listPage(decoded.knownEpoch, decoded.afterCounter, decoded.limit)
          return new SyncFeedOutput(page)
        })
      )
    )
    return runRpcProgram(this.#runtime, program, SyncFeedOutput)
  }

  async rotateEpoch(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(RotateEpochInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap(() =>
        Effect.gen(function* () {
          const sync = yield* SyncFeedService
          const epoch = yield* sync.rotateEpoch
          return new RotateEpochOutput({ epoch })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, RotateEpochOutput)
  }

  // --- Phase 3: AgentEditService (agent chats, pending records, changes stream) ----------------

  async createChat(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(CreateChatInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const agentEdit = yield* AgentEditService
          const chat = yield* agentEdit.createChat(decoded.workspaceId, decoded.title)
          return new CreateChatOutput({ chat })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, CreateChatOutput)
  }

  async listChats(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ListChatsInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const agentEdit = yield* AgentEditService
          const chats = yield* agentEdit.listChats(decoded.workspaceId)
          return new ListChatsOutput({ chats })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ListChatsOutput)
  }

  async getChat(input: unknown): Promise<unknown> {
    const workspaceId = this.#workspaceId
    const currentUser = this.#currentUser
    const program = decodeRpcInput(GetChatInput, input).pipe(
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const agentEdit = yield* AgentEditService
          const { chat, messages } = yield* agentEdit.getChat(decoded.chatId)
          yield* requireOwnWorkspace(workspaceId, chat.workspaceId)
          return new GetChatOutput({ chat, messages })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, GetChatOutput)
  }

  async sendChatMessage(input: unknown): Promise<unknown> {
    const workspaceId = this.#workspaceId
    const currentUser = this.#currentUser
    const program = decodeRpcInput(SendChatMessageInput, input).pipe(
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const agentEdit = yield* AgentEditService
          const { chat } = yield* agentEdit.getChat(decoded.chatId)
          yield* requireOwnWorkspace(workspaceId, chat.workspaceId)
          const { messages, changesSequences } = yield* agentEdit.sendChatMessage(decoded.chatId, decoded.text)
          return new SendChatMessageOutput({ messages, changesSequences })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, SendChatMessageOutput)
  }

  async mergeChanges(input: unknown): Promise<unknown> {
    const workspaceId = this.#workspaceId
    const currentUser = this.#currentUser
    const program = decodeRpcInput(MergeChangesInput, input).pipe(
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const agentEdit = yield* AgentEditService
          const { chat } = yield* agentEdit.getChat(decoded.chatId)
          yield* requireOwnWorkspace(workspaceId, chat.workspaceId)
          yield* agentEdit.mergeChanges(decoded.chatId, decoded.mergeThrough)
          return new MergeChangesOutput({ chatId: decoded.chatId, mergeThrough: decoded.mergeThrough })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, MergeChangesOutput)
  }

  async revertChanges(input: unknown): Promise<unknown> {
    const workspaceId = this.#workspaceId
    const currentUser = this.#currentUser
    const program = decodeRpcInput(RevertChangesInput, input).pipe(
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const agentEdit = yield* AgentEditService
          const { chat } = yield* agentEdit.getChat(decoded.chatId)
          yield* requireOwnWorkspace(workspaceId, chat.workspaceId)
          yield* agentEdit.revertChanges(decoded.chatId, decoded.revertFrom)
          return new RevertChangesOutput({ chatId: decoded.chatId, revertFrom: decoded.revertFrom })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, RevertChangesOutput)
  }

  async listChatChanges(input: unknown): Promise<unknown> {
    const workspaceId = this.#workspaceId
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ListChatChangesInput, input).pipe(
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const agentEdit = yield* AgentEditService
          const { chat } = yield* agentEdit.getChat(decoded.chatId)
          yield* requireOwnWorkspace(workspaceId, chat.workspaceId)
          const changes = yield* agentEdit.listChatChanges(decoded.chatId)
          return new ListChatChangesOutput({ changes })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ListChatChangesOutput)
  }

  /** Web-stage addition — see `ListPendingChangesOutput`'s doc comment in agent-edit-rpc.ts. */
  async listPendingChanges(input: unknown): Promise<unknown> {
    const workspaceId = this.#workspaceId
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ListPendingChangesInput, input).pipe(
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const agentEdit = yield* AgentEditService
          const { chat } = yield* agentEdit.getChat(decoded.chatId)
          yield* requireOwnWorkspace(workspaceId, chat.workspaceId)
          const { nodes, facts, edges } = yield* agentEdit.listPendingChanges(decoded.chatId)
          return new ListPendingChangesOutput({ nodes, facts, edges })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ListPendingChangesOutput)
  }

  // --- App Library (app-rpc.ts's six mainline/direct methods — see `apps-service-live.ts`'s own
  // header comment for why these never take a `chatId`/never produce a pending row, unlike
  // `AgentEditService`'s `createAppTool`/`updateAppCodeTool`). Role gate: `createApp`/
  // `updateAppCode`/`deleteApp` are mutations that change what sandboxed code this workspace runs
  // → `"build"`; `listApps`/`getApp`/`getAppCode` are reads → `"use"` — exactly the split
  // app-rpc.ts's own header comment recommends, applied here per this codebase's established
  // "EVERY new mutating/reading RPC method on a governed workspace MUST call
  // requireRoleForGovernedWorkspace... no exceptions" discipline.

  async createApp(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(CreateAppInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const apps = yield* AppsService
          const app = yield* apps.createApp(decoded.workspaceId, decoded.title, decoded.icon, decoded.id)
          return new CreateAppOutput({ app })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, CreateAppOutput)
  }

  async updateAppCode(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(UpdateAppCodeInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const apps = yield* AppsService
          const { app, codeVersion } = yield* apps.updateAppCode(
            decoded.workspaceId,
            decoded.appId,
            decoded.kind,
            decoded.code
          )
          return new UpdateAppCodeOutput({ app, codeVersion })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, UpdateAppCodeOutput)
  }

  async listApps(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ListAppsInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const apps = yield* AppsService
          const list = yield* apps.listApps(decoded.workspaceId)
          return new ListAppsOutput({ apps: list })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ListAppsOutput)
  }

  async getApp(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(GetAppInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const apps = yield* AppsService
          const app = yield* apps.getApp(decoded.workspaceId, decoded.appId)
          return new GetAppOutput({ app })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, GetAppOutput)
  }

  async getAppCode(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(GetAppCodeInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const apps = yield* AppsService
          const codeVersion = yield* apps.getAppCode(decoded.workspaceId, decoded.appId, decoded.kind, decoded.version)
          return new GetAppCodeOutput({ codeVersion })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, GetAppCodeOutput)
  }

  /**
   * **Adversarial-review fix.** Mints a fresh, narrowly-scoped `athenaeum-app-run-v1` credential
   * (`app-run-credential.ts`) naming exactly `{workspaceId, appId}` — the mechanism
   * `AppLibraryPanel.tsx`'s preview iframe uses to authenticate its own `client.js` load and the
   * App's sandboxed client code uses to authenticate its own `/run` fetch calls, on a GOVERNED
   * workspace, WITHOUT ever being handed the caller's real session credential (see this method's
   * and `app-run-credential.ts`'s own header comments for the full "why" — handing an
   * agent-authored App the user's actual session token would let it impersonate its creator
   * against every OTHER RPC method on this workspace, not just its own two routes).
   *
   * Gated `"use"` — the same role level `getApp`/`getAppCode`/the `/run` and `/client.js` routes
   * themselves already require — since minting this credential grants no capability beyond what
   * the caller already has: "someone who can already view/run this App" gets a way to LET THIS
   * APP'S OWN CODE do the same, scoped to nothing more. Fails `AppNotFound` if `appId` doesn't
   * exist in this workspace (mirrors `getApp`), and `UnexpectedError` if this deployment has no
   * `DEV_AUTH_HMAC_SECRET` configured (same "real client, cleanly unconfigured" fail-closed
   * pattern `AppRuntimeServiceUnconfigured`/`CalendarGatekeeperClientUnconfigured` already
   * establish elsewhere in this file) — never silently minting an unsigned or weakly-signed token.
   */
  async mintAppRunCredential(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const secret = this.#devAuthHmacSecret
    const program = decodeRpcInput(MintAppRunCredentialInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const apps = yield* AppsService
          // Confirms the App actually exists in this workspace before minting anything for it —
          // mirrors `getApp`'s own `AppNotFound` behavior rather than minting a credential for an
          // id that will just 404 on every subsequent use.
          yield* apps.getApp(decoded.workspaceId, decoded.appId)
          if (secret === undefined || secret.length === 0) {
            return yield* Effect.fail(
              new UnexpectedError({
                message: "This deployment has no DEV_AUTH_HMAC_SECRET configured; cannot mint an App run credential."
              })
            )
          }
          const { credential, expiresAt } = yield* signAppRunCredential(decoded.workspaceId, decoded.appId, secret)
          return new MintAppRunCredentialOutput({
            credential,
            expiresAt: Schema.decodeUnknownSync(IsoDateTimeString)(expiresAt.toISOString())
          })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, MintAppRunCredentialOutput)
  }

  async deleteApp(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(DeleteAppInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const apps = yield* AppsService
          const deleted = yield* apps.deleteApp(decoded.workspaceId, decoded.appId)
          return new DeleteAppOutput({ deleted })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, DeleteAppOutput)
  }

  // --- Phase 4: sharing/collaborators (docs/sharing.md port — see sharing-service-live.ts's own
  // header comment) ------------------------------------------------------------------------------
  //
  // Identity is threaded via `CurrentUser`/`requireAuthenticatedUser`, never an explicit
  // `callerId` argument (`sharing-rpc.ts`'s own header comment), same pattern as `whoami`'s
  // reference implementation — except every method below REQUIRES a real caller
  // (`requireAuthenticatedUser`, not merely `CurrentUser`'s raw `Option`): unlike every
  // pre-existing Phase 0-3 method, sharing has no meaningful anonymous case — there is no
  // permission graph to check an anonymous connection against.

  async addCollaborator(input: unknown): Promise<unknown> {
    const workspaceId = this.#workspaceId
    const program = decodeRpcInput(AddCollaboratorInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(workspaceId, decoded.workspaceId)),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const user = yield* requireAuthenticatedUser
          const sharing = yield* SharingService
          const caller = yield* sharing.resolveCaller(user.email)
          const collaborator = yield* sharing.addCollaborator(caller, decoded.profileId, decoded.role, decoded.note)
          // Observer verification (task: "wire the observer verification mechanism into the REAL
          // Phase 4 SharingService" — trigger on "a new collaborator is added"). Per
          // `CalendarService#verifyObserver`'s own doc comment, a gatekeeper-side outcome NEVER
          // fails `addCollaborator` itself — a denial (or "never connected a Google account", the
          // expected outcome for every reviewer of this stage, since no real Google account exists
          // here) is stored and silently excludes this viewer from calendar-derived content,
          // exactly as the task asks; only a genuine storage error propagates, same as every other
          // write in this method.
          const calendar = yield* CalendarService
          yield* calendar.verifyObserver(decoded.workspaceId, decoded.profileId)
          return new AddCollaboratorOutput({ collaborator })
        })
      ),
      Effect.provideService(CurrentUser, Option.fromNullable(this.#currentUser))
    )
    return runRpcProgram(this.#runtime, program, AddCollaboratorOutput)
  }

  async previewRemoveCollaborator(input: unknown): Promise<unknown> {
    const workspaceId = this.#workspaceId
    const program = decodeRpcInput(PreviewRemoveCollaboratorInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(workspaceId, decoded.workspaceId)),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const user = yield* requireAuthenticatedUser
          const sharing = yield* SharingService
          const caller = yield* sharing.resolveCaller(user.email)
          const affected = yield* sharing.previewRemoveCollaborator(caller, decoded.profileId)
          return new PreviewRemoveCollaboratorOutput({ affected })
        })
      ),
      Effect.provideService(CurrentUser, Option.fromNullable(this.#currentUser))
    )
    return runRpcProgram(this.#runtime, program, PreviewRemoveCollaboratorOutput)
  }

  async removeCollaborator(input: unknown): Promise<unknown> {
    const workspaceId = this.#workspaceId
    const scheduleEviction = this.#scheduleEviction
    const program = decodeRpcInput(RemoveCollaboratorInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(workspaceId, decoded.workspaceId)),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const user = yield* requireAuthenticatedUser
          const sharing = yield* SharingService
          const caller = yield* sharing.resolveCaller(user.email)
          const affected = yield* sharing.removeCollaborator(caller, decoded.profileId, decoded.keepUsers ?? [])
          return new RemoveCollaboratorOutput({ affected })
        })
      ),
      Effect.provideService(CurrentUser, Option.fromNullable(this.#currentUser))
    )
    const result = (await runRpcProgram(this.#runtime, program, RemoveCollaboratorOutput)) as {
      readonly affected: ReadonlyArray<{ readonly profileId: string }>
    }
    // docs/sharing.md §"Terminating live sessions on revocation": "restart... whenever the change
    // actually removed or downgraded someone... pure no-op removals don't restart" — see this
    // class's `#scheduleEviction` doc comment and `WorkspaceDurableObject#scheduleRevocationEviction`
    // for the real flush-then-delay-then-evict mechanics this fires.
    if (result.affected.length > 0) {
      scheduleEviction(result.affected.map((a) => a.profileId), "Your access to this workspace was changed.")
    }
    return result
  }

  async createShareLink(input: unknown): Promise<unknown> {
    const workspaceId = this.#workspaceId
    const program = decodeRpcInput(CreateShareLinkInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(workspaceId, decoded.workspaceId)),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const user = yield* requireAuthenticatedUser
          const sharing = yield* SharingService
          const caller = yield* sharing.resolveCaller(user.email)
          const { key, link } = yield* sharing.createShareLink(caller, decoded.role, decoded.note)
          return new CreateShareLinkOutput({ key, link })
        })
      ),
      Effect.provideService(CurrentUser, Option.fromNullable(this.#currentUser))
    )
    return runRpcProgram(this.#runtime, program, CreateShareLinkOutput)
  }

  async redeemShareLink(input: unknown): Promise<unknown> {
    const workspaceId = this.#workspaceId
    const program = decodeRpcInput(RedeemShareLinkInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(workspaceId, decoded.workspaceId)),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const user = yield* requireAuthenticatedUser
          const sharing = yield* SharingService
          const collaborator = yield* sharing.redeemShareLink(user.email, decoded.key)
          // Observer verification, the share-link-redeemed counterpart of `addCollaborator`'s own
          // — see that method's doc comment for the full contract.
          const calendar = yield* CalendarService
          yield* calendar.verifyObserver(workspaceId, user.email)
          return new RedeemShareLinkOutput({ collaborator })
        })
      ),
      Effect.provideService(CurrentUser, Option.fromNullable(this.#currentUser))
    )
    return runRpcProgram(this.#runtime, program, RedeemShareLinkOutput)
  }

  async previewRevokeShareLink(input: unknown): Promise<unknown> {
    const workspaceId = this.#workspaceId
    const program = decodeRpcInput(PreviewRevokeShareLinkInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(workspaceId, decoded.workspaceId)),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const user = yield* requireAuthenticatedUser
          const sharing = yield* SharingService
          const caller = yield* sharing.resolveCaller(user.email)
          const affected = yield* sharing.previewRevokeShareLink(caller, decoded.linkId)
          return new PreviewRevokeShareLinkOutput({ affected })
        })
      ),
      Effect.provideService(CurrentUser, Option.fromNullable(this.#currentUser))
    )
    return runRpcProgram(this.#runtime, program, PreviewRevokeShareLinkOutput)
  }

  async revokeShareLink(input: unknown): Promise<unknown> {
    const workspaceId = this.#workspaceId
    const scheduleEviction = this.#scheduleEviction
    const program = decodeRpcInput(RevokeShareLinkInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(workspaceId, decoded.workspaceId)),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const user = yield* requireAuthenticatedUser
          const sharing = yield* SharingService
          const caller = yield* sharing.resolveCaller(user.email)
          const affected = yield* sharing.revokeShareLink(caller, decoded.linkId, decoded.keepUsers ?? [])
          return new RevokeShareLinkOutput({ affected })
        })
      ),
      Effect.provideService(CurrentUser, Option.fromNullable(this.#currentUser))
    )
    const result = (await runRpcProgram(this.#runtime, program, RevokeShareLinkOutput)) as {
      readonly affected: ReadonlyArray<{ readonly profileId: string }>
    }
    if (result.affected.length > 0) {
      scheduleEviction(result.affected.map((a) => a.profileId), "Your access to this workspace was changed.")
    }
    return result
  }

  async listCollaborators(input: unknown): Promise<unknown> {
    const workspaceId = this.#workspaceId
    const program = decodeRpcInput(ListCollaboratorsInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(workspaceId, decoded.workspaceId)),
      Effect.flatMap(() =>
        Effect.gen(function* () {
          const user = yield* requireAuthenticatedUser
          const sharing = yield* SharingService
          yield* sharing.resolveCaller(user.email) // real access check — see file header comment
          const collaborators = yield* sharing.listCollaborators
          return new ListCollaboratorsOutput({ collaborators })
        })
      ),
      Effect.provideService(CurrentUser, Option.fromNullable(this.#currentUser))
    )
    return runRpcProgram(this.#runtime, program, ListCollaboratorsOutput)
  }

  async listShareLinks(input: unknown): Promise<unknown> {
    const workspaceId = this.#workspaceId
    const program = decodeRpcInput(ListShareLinksInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(workspaceId, decoded.workspaceId)),
      Effect.flatMap(() =>
        Effect.gen(function* () {
          const user = yield* requireAuthenticatedUser
          const sharing = yield* SharingService
          yield* sharing.resolveCaller(user.email)
          const shareLinks = yield* sharing.listShareLinks
          return new ListShareLinksOutput({ shareLinks })
        })
      ),
      Effect.provideService(CurrentUser, Option.fromNullable(this.#currentUser))
    )
    return runRpcProgram(this.#runtime, program, ListShareLinksOutput)
  }

  // --- Phase 5: Google Calendar + Bookmarks (gatekeeper-rpc.ts's eight methods) ----------------
  //
  // Role gating per gatekeeper-rpc.ts's own header comment's "Recommended role split": every
  // mutation (connect/callback/disconnect/sync/link/createBookmark) requires `"build"`; every
  // read (listCalendarEvents/listBookmarks) requires `"use"` — the same discipline every other
  // method in this class already follows, applied here per this task's hard constraint ("EVERY
  // new mutating/reading RPC method on a governed workspace MUST call the same
  // requireRoleForGovernedWorkspace gate... no exceptions").

  async connectGoogleCalendar(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ConnectGoogleCalendarInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const user = yield* requireAuthenticatedUser
          const calendar = yield* CalendarService
          const { authorizationUrl, state } = yield* calendar.connect(decoded.workspaceId, user.email)
          return new ConnectGoogleCalendarOutput({ authorizationUrl, state })
        })
      ),
      Effect.provideService(CurrentUser, Option.fromNullable(this.#currentUser))
    )
    return runRpcProgram(this.#runtime, program, ConnectGoogleCalendarOutput)
  }

  async googleCalendarOAuthCallback(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(GoogleCalendarOAuthCallbackInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const calendar = yield* CalendarService
          const binding = yield* calendar.completeOAuthCallback(
            decoded.workspaceId,
            decoded.code,
            decoded.state,
            decoded.calendarId,
            decoded.mode
          )
          return new GoogleCalendarOAuthCallbackOutput({ binding })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, GoogleCalendarOAuthCallbackOutput)
  }

  async disconnectGoogleCalendar(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(DisconnectGoogleCalendarInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const calendar = yield* CalendarService
          const disconnected = yield* calendar.disconnect(decoded.workspaceId, decoded.bindingId)
          return new DisconnectGoogleCalendarOutput({ disconnected })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, DisconnectGoogleCalendarOutput)
  }

  async syncGoogleCalendar(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(SyncGoogleCalendarInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const calendar = yield* CalendarService
          const { triggered } = yield* calendar.sync(decoded.workspaceId, decoded.bindingId)
          return new SyncGoogleCalendarOutput({ triggered })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, SyncGoogleCalendarOutput)
  }

  async listCalendarEvents(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ListCalendarEventsInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const calendar = yield* CalendarService
          // Real observer-visibility enforcement (task: "exclude from what that viewer can see"
          // must be a real filter on reads, not just a comment) — see `CalendarService
          // #listEvents`'s own doc comment for exactly what `currentUser?.email` maps to.
          const events = yield* calendar.listEvents(decoded.workspaceId, decoded.from, decoded.to, currentUser?.email)
          return new ListCalendarEventsOutput({ events })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ListCalendarEventsOutput)
  }

  async linkCalendarEventToNode(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(LinkCalendarEventToNodeInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const calendar = yield* CalendarService
          const calendarEvent = yield* calendar.linkEventToNode(decoded.workspaceId, decoded.calendarEventId, decoded.nodeId)
          return new LinkCalendarEventToNodeOutput({ calendarEvent })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, LinkCalendarEventToNodeOutput)
  }

  async createBookmark(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(CreateBookmarkInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const calendar = yield* CalendarService
          const bookmark = yield* calendar.createBookmark(decoded.workspaceId, decoded.url, decoded.title)
          return new CreateBookmarkOutput({ bookmark })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, CreateBookmarkOutput)
  }

  async listBookmarks(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ListBookmarksInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const calendar = yield* CalendarService
          const bookmarks = yield* calendar.listBookmarks(decoded.workspaceId)
          // Same `linkedNodeId` observer-visibility gate as `getMeeting`/`listMeetings` above,
          // applied to `Bookmark.linkedNodeId` — the identical pre-existing (Phase 5) gap the
          // Phase 6 adversarial review flagged as the same systemic pattern.
          const hidden = yield* calendar.hiddenCalendarDerivedNodeIds(decoded.workspaceId, currentUser?.email)
          return new ListBookmarksOutput({
            bookmarks: bookmarks.map((bookmark) => sanitizeBookmarkLinkedNodeId(bookmark, hidden))
          })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ListBookmarksOutput)
  }

  // --- Phase 6: Meetings (meeting-rpc.ts's five methods) + voice sessions (voice-session-rpc.ts's
  // two methods) — same "mutations -> build, reads -> use" role split every prior stage's own
  // header comment states, applied here per this task's hard constraint (no exceptions). --------

  async startMeeting(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(StartMeetingInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const meetings = yield* MeetingsService
          const meeting = yield* meetings.startMeeting(decoded.workspaceId, decoded.title)
          return new StartMeetingOutput({ meeting })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, StartMeetingOutput)
  }

  async endMeeting(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(EndMeetingInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const meetings = yield* MeetingsService
          const meeting = yield* meetings.endMeeting(decoded.workspaceId, decoded.meetingId, decoded.endedAt)
          return new EndMeetingOutput({ meeting })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, EndMeetingOutput)
  }

  async appendTranscriptSegment(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(AppendTranscriptSegmentInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const meetings = yield* MeetingsService
          const segment = yield* meetings.appendTranscriptSegment(decoded.workspaceId, decoded.meetingId, {
            ...(decoded.speakerId !== undefined ? { speakerId: decoded.speakerId } : {}),
            text: decoded.text,
            startOffsetMs: decoded.startOffsetMs,
            endOffsetMs: decoded.endOffsetMs,
            source: decoded.source
          })
          return new AppendTranscriptSegmentOutput({ segment })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, AppendTranscriptSegmentOutput)
  }

  async getMeeting(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(GetMeetingInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const meetings = yield* MeetingsService
          const { meeting, segments, speakers } = yield* meetings.getMeeting(decoded.workspaceId, decoded.meetingId)
          // Real observer-visibility enforcement for `Meeting.linkedNodeId` (adversarial-review
          // fix, Phase 6) — same gate `listNodes`/`getNode` above already apply to the node
          // itself; see `sanitizeMeetingLinkedNodeId`'s own doc comment.
          const calendar = yield* CalendarService
          const hidden = yield* calendar.hiddenCalendarDerivedNodeIds(decoded.workspaceId, currentUser?.email)
          return new GetMeetingOutput({ meeting: sanitizeMeetingLinkedNodeId(meeting, hidden), segments, speakers })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, GetMeetingOutput)
  }

  async listMeetings(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ListMeetingsInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const meetings = yield* MeetingsService
          const meetingRows = yield* meetings.listMeetings(decoded.workspaceId)
          // Same `linkedNodeId` observer-visibility gate as `getMeeting` above.
          const calendar = yield* CalendarService
          const hidden = yield* calendar.hiddenCalendarDerivedNodeIds(decoded.workspaceId, currentUser?.email)
          return new ListMeetingsOutput({
            meetings: meetingRows.map((meeting) => sanitizeMeetingLinkedNodeId(meeting, hidden))
          })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ListMeetingsOutput)
  }

  // --- Phase 7: workouts -----------------------------------------------------------------------

  /** `role` gate: `"build"` (a mutation — creates a `Workout`-tagged node subgraph). See
   *  `workout-rpc.ts`'s `ImportWorkoutInput` doc comment for the full "why one atomic RPC, not N
   *  generic graph calls" rationale, and `workouts-service-live.ts` for the implementation. */
  async importWorkout(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ImportWorkoutInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const workouts = yield* WorkoutsService
          const { receipt, duplicate } = yield* workouts.importWorkout(decoded)
          return new ImportWorkoutOutput({ receipt, duplicate })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ImportWorkoutOutput)
  }

  /** `role` gate: `"use"`. Lists this workspace's workout-import receipts, most-recently-imported
   *  first, with `rootNodeId`-based observer-exclusion applied — see
   *  `filterHiddenWorkoutImportReceipts`'s own doc comment for why this filters whole rows rather
   *  than sanitizing a field, unlike `getMeeting`/`listMeetings`/`listBookmarks` above. */
  async listWorkoutImports(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ListWorkoutImportsInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const workouts = yield* WorkoutsService
          const receipts = yield* workouts.listWorkoutImports(decoded.workspaceId)
          const calendar = yield* CalendarService
          const hidden = yield* calendar.hiddenCalendarDerivedNodeIds(decoded.workspaceId, currentUser?.email)
          return new ListWorkoutImportsOutput({
            receipts: filterHiddenWorkoutImportReceipts(receipts, hidden)
          })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ListWorkoutImportsOutput)
  }

  /** `role` gate: `"build"` — same batched-import mutation as `importWorkout`, N items instead
   *  of one. See `workout-rpc.ts`'s `ImportWorkoutsInput`/`ImportWorkoutsOutput` doc comments for
   *  the "one RPC, per-item independent outcomes, never all-or-nothing" rationale, and
   *  `workouts-service-live.ts#importWorkouts` for the implementation. */
  async importWorkouts(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ImportWorkoutsInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const workouts = yield* WorkoutsService
          const results = yield* workouts.importWorkouts(decoded.workspaceId, decoded.workouts)
          return new ImportWorkoutsOutput({ results })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ImportWorkoutsOutput)
  }

  /** `role` gate: `"use"`. Lightweight per-workout read model — see `workout.ts`'s
   *  `WorkoutSummary` doc comment. Same `nodeId`-based observer-exclusion gate as
   *  `listWorkoutImports` above, applied via `filterHiddenWorkoutSummaries`. */
  async listWorkouts(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ListWorkoutsInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const workouts = yield* WorkoutsService
          const summaries = yield* workouts.listWorkouts(decoded.workspaceId)
          const calendar = yield* CalendarService
          const hidden = yield* calendar.hiddenCalendarDerivedNodeIds(decoded.workspaceId, currentUser?.email)
          return new ListWorkoutsOutput({ workouts: filterHiddenWorkoutSummaries(summaries, hidden) })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ListWorkoutsOutput)
  }

  /** `role` gate: `"use"`. Full aggregate read for one workout root node — see `workout.ts`'s
   *  `WorkoutDetail` doc comment. A hidden `nodeId` is reported exactly as a nonexistent one
   *  would be (`WorkoutNotFound`), same "never distinguish a hidden node from a nonexistent one"
   *  discipline `getNode` already establishes for the generic node read. */
  async getWorkout(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(GetWorkoutInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const workouts = yield* WorkoutsService
          const calendar = yield* CalendarService
          const hidden = yield* calendar.hiddenCalendarDerivedNodeIds(decoded.workspaceId, currentUser?.email)
          if (hidden.has(decoded.nodeId)) {
            return yield* Effect.fail(new WorkoutNotFound({ nodeId: decoded.nodeId }))
          }
          const workout = yield* workouts.getWorkout(decoded.workspaceId, decoded.nodeId)
          return new GetWorkoutOutput({ workout })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, GetWorkoutOutput)
  }

  /** Verifies `chatId` references a real chat IN THIS WORKSPACE before creating the `VoiceSession`
   *  row — same "get the chat, then requireOwnWorkspace against ITS workspaceId" pattern
   *  `sendChatMessage`/`mergeChanges`/`revertChanges`/`listChatChanges`/`listPendingChanges`
   *  above all already use, reused here rather than duplicated into `VoiceSessionService` itself
   *  (see that service's own header comment for why). Fails with the real `ChatNotFound`
   *  (agent-edit-service-live.ts's own `getChatRow`) if `chatId` doesn't exist at all. */
  async startVoiceSession(input: unknown): Promise<unknown> {
    const workspaceId = this.#workspaceId
    const currentUser = this.#currentUser
    const program = decodeRpcInput(StartVoiceSessionInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const agentEdit = yield* AgentEditService
          const { chat } = yield* agentEdit.getChat(decoded.chatId)
          yield* requireOwnWorkspace(workspaceId, chat.workspaceId)
          const voiceSessions = yield* VoiceSessionService
          const voiceSession = yield* voiceSessions.startVoiceSession(decoded.workspaceId, decoded.chatId)
          return new StartVoiceSessionOutput({ voiceSession })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, StartVoiceSessionOutput)
  }

  async endVoiceSession(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(EndVoiceSessionInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const voiceSessions = yield* VoiceSessionService
          const voiceSession = yield* voiceSessions.endVoiceSession(
            decoded.workspaceId,
            decoded.voiceSessionId,
            decoded.endedAt
          )
          return new EndVoiceSessionOutput({ voiceSession })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, EndVoiceSessionOutput)
  }

  // --- Live voice-audio session (voice-audio-rpc.ts's five methods) — see that file's and
  // voice-audio-session.ts's own header comments for the full design. Same "verify chatId is a
  // real chat IN THIS WORKSPACE" pattern `startVoiceSession` above already uses, for the same reason.

  async openVoiceAudioSession(input: unknown): Promise<unknown> {
    const workspaceId = this.#workspaceId
    const currentUser = this.#currentUser
    const liveSessions = this.#liveVoiceAudioSessions
    const program = decodeRpcInput(OpenVoiceAudioSessionInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const agentEdit = yield* AgentEditService
          const { chat } = yield* agentEdit.getChat(decoded.chatId)
          yield* requireOwnWorkspace(workspaceId, chat.workspaceId)
          const handle = yield* openLiveVoiceAudioSession(decoded.chatId, decoded.sessionConfig).pipe(
            Effect.mapError(realtimeVoiceErrorToDomainError)
          )
          const audioSessionId = crypto.randomUUID()
          liveSessions.set(audioSessionId, handle)
          return new OpenVoiceAudioSessionOutput({ audioSessionId })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, OpenVoiceAudioSessionOutput)
  }

  /** Looks up `audioSessionId` in `#liveVoiceAudioSessions`, failing with `ValidationError` (not
   *  a new bespoke `DomainError` tag — see this class's own five-method group header comment) if
   *  it's unknown or already closed. Shared by `sendVoiceAudioChunk`/`commitVoiceAudioAndRespond`/
   *  `pollVoiceAudioEvents` below; `closeVoiceAudioSession` deliberately does NOT use this (its
   *  own doc comment: closing an unknown session is a no-op, not an error). */
  #requireLiveVoiceAudioSession(audioSessionId: string): Effect.Effect<LiveVoiceAudioSessionHandle, DomainError> {
    const handle = this.#liveVoiceAudioSessions.get(audioSessionId)
    if (handle === undefined) {
      return Effect.fail(new ValidationError({ message: `unknown or already-closed voice audio session: ${audioSessionId}` }))
    }
    return Effect.succeed(handle)
  }

  async sendVoiceAudioChunk(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const requireLiveSession = this.#requireLiveVoiceAudioSession.bind(this)
    const program = decodeRpcInput(SendVoiceAudioChunkInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        requireLiveSession(decoded.audioSessionId).pipe(
          Effect.flatMap((handle) =>
            sendVoiceAudioChunk(handle, bytesFromBase64(decoded.pcm16Base64)).pipe(
              Effect.mapError(realtimeVoiceErrorToDomainError)
            )
          )
        )
      ),
      Effect.as(new SendVoiceAudioChunkOutput({ accepted: true }))
    )
    return runRpcProgram(this.#runtime, program, SendVoiceAudioChunkOutput)
  }

  async commitVoiceAudioAndRespond(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const requireLiveSession = this.#requireLiveVoiceAudioSession.bind(this)
    const program = decodeRpcInput(CommitVoiceAudioInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        requireLiveSession(decoded.audioSessionId).pipe(
          Effect.flatMap((handle) => commitVoiceAudioAndRespond(handle).pipe(Effect.mapError(realtimeVoiceErrorToDomainError)))
        )
      ),
      Effect.as(new CommitVoiceAudioOutput({ accepted: true }))
    )
    return runRpcProgram(this.#runtime, program, CommitVoiceAudioOutput)
  }

  async pollVoiceAudioEvents(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const requireLiveSession = this.#requireLiveVoiceAudioSession.bind(this)
    const program = decodeRpcInput(PollVoiceAudioEventsInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        requireLiveSession(decoded.audioSessionId).pipe(
          Effect.flatMap((handle) => pollVoiceAudioEvents(handle))
        )
      ),
      Effect.map((events) => new PollVoiceAudioEventsOutput({ events }))
    )
    return runRpcProgram(this.#runtime, program, PollVoiceAudioEventsOutput)
  }

  async closeVoiceAudioSession(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const liveSessions = this.#liveVoiceAudioSessions
    const program = decodeRpcInput(CloseVoiceAudioSessionInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.sync(() => liveSessions.get(decoded.audioSessionId)).pipe(
          Effect.flatMap((handle) => {
            if (handle === undefined) return Effect.void
            liveSessions.delete(decoded.audioSessionId)
            return closeLiveVoiceAudioSession(handle)
          })
        )
      ),
      Effect.as(new CloseVoiceAudioSessionOutput({ closed: true }))
    )
    return runRpcProgram(this.#runtime, program, CloseVoiceAudioSessionOutput)
  }
}

export class WorkspaceDurableObject extends DurableObject<Env> {
  readonly #runtime: ManagedRuntime.ManagedRuntime<WorkspaceServices, never>
  readonly #collections: WorkspaceCollections
  readonly #workspaceId: EntityId
  readonly #sql: SqlStorage
  /**
   * Every currently-live WebSocket connection to this workspace, mapped to the identity that opened
   * it (`undefined` for an anonymous connection) — populated/removed in `fetch()`, never touched
   * anywhere else. This is the real state backing `evictSessions()` below; it deliberately tracks
   * raw transports, not Cap'n Web `RpcTarget`/session objects, since closing the transport is all
   * eviction needs (Cap'n Web's own session-abort path runs from that, the same way an abrupt
   * client-initiated disconnect already does — see `nodes-subscription.ts`'s doc comment and
   * `test/live-subscription.test.ts`'s "abrupt disconnect... still releases the server-side
   * resource" suite, which this reuses the identical mechanism of, just triggered from the server
   * side instead of the client side).
   */
  readonly #activeSockets = new Map<WebSocket, AuthenticatedUser | undefined>()
  /** Live voice-audio sessions opened via `openVoiceAudioSession` (`voice-audio-rpc.ts`/
   *  `voice-audio-session.ts`), keyed by the server-issued `audioSessionId`. Lives on the DO
   *  INSTANCE, not on any single `WorkspaceRpcApi` (see `voice-audio-session.ts`'s own header comment
   *  for why: `WorkspaceRpcApi` is reconstructed fresh per HTTP-batch request, but a session must
   *  survive across the separate "open" / "send chunk" / "poll" / "close" requests native's
   *  HTTP-batch-only Cap'n Web client makes). Ephemeral, deliberately not a `typed-storage-effect`
   *  collection: a live `RealtimeVoiceSession`/WebSocket handle can't be persisted, and a DO
   *  eviction losing an in-progress live voice session (same as it would lose an in-progress
   *  Automerge sync session's in-memory state) is an accepted, documented limitation, not silently
   *  glossed over — see `docs/meetings-voice-decisions.md` §4. */
  readonly #liveVoiceAudioSessions = new Map<string, LiveVoiceAudioSessionHandle>()
  /** This workspace's owner (plan §Phased delivery, Phase 4: "implicitly, as workspace owner... in the
   *  new WorkspaceDurableObject itself") — see `workspace-ownership.ts`'s own header comment for why this
   *  is its own tiny module/collection rather than folded into an existing one. */
  readonly #workspaceMeta: Singleton<WorkspaceMeta>
  /** Phase 4 sharing storage (`sharing-collections.ts`) — see that file's own header comment.
   *  Kept as its own field (rather than folded into `#collections`) so `#scheduleRevocationEviction`'s
   *  eventual test helper and `SharingService`'s `Layer` construction both close over it directly,
   *  mirroring `#workspaceMeta`'s own placement. */
  readonly #sharingCollections: SharingCollections
  /** Underlying DO storage — `#scheduleRevocationEviction` calls `ctx.storage.sync()` directly
   *  (docs/sharing.md's own "flush... first" precaution), the one place this DO needs the raw
   *  `DurableObjectStorage` handle rather than a typed-storage-effect collection/singleton. */
  readonly #storage: DurableObjectStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Populated whenever the backend Worker addresses this DO via `getByName(workspaceId)` (see
    // `index.ts`) — only ever uses `getByName`, never `idFromString`/`newUniqueId`, so
    // `ctx.id.name` is always set here.
    this.#workspaceId = Schema.decodeUnknownSync(EntityId)(ctx.id.name)
    this.#sql = ctx.storage.sql
    this.#storage = ctx.storage
    this.#workspaceMeta = makeWorkspaceMetaSingleton(ctx.storage)
    this.#sharingCollections = makeSharingCollections(ctx.storage)

    // AI Gateway routing (docs/ai-gateway-decisions.md): resolved once per DO construction, same
    // "read directly off env" pattern every other optional binding in this constructor uses.
    // `undefined` (both CF_AI_GATEWAY_ACCOUNT_ID/CF_AI_GATEWAY_NAME absent, this environment's
    // default) means every real inference client below stays in DIRECT mode, calling its
    // provider's own API host exactly as before this existed. Shared across all three clients —
    // one configured gateway, one account, per this task's deliberately-narrowed scope (NOT
    // cloudflare-os's per-user-account multi-tenant `AiGatewayConfig`).
    const aiGatewayRoute = resolveAiGatewayRoute(env)

    // Views/Search stage: create the `rm_*` read-model tables + public `graph_*` views (task
    // item 1) once per construction. Idempotent (`CREATE ... IF NOT EXISTS` throughout — see
    // `read-model.ts`'s own doc comment), plain synchronous DDL — not run inside
    // `blockConcurrencyWhile` the way Base Tag seeding below is, since it has no Effect-level
    // async gap for a concurrent request to interleave with.
    ensureGraphViews(this.#sql)

    const nodesCollections = makeWorkspaceCollections(ctx.storage)
    const pagesCollections = makePagesCollections(ctx.storage)
    const tagsCollections = makeTagsCollections(ctx.storage)
    const tagClosureCollections = makeTagClosureCollections(ctx.storage)
    const factsCollections = makeFactsCollections(ctx.storage)
    const edgesCollections = makeEdgesCollections(ctx.storage)
    const relationDefinitionsCollections = makeRelationDefinitionsCollections(ctx.storage)
    const graphIssuesCollections = makeGraphIssuesCollections(ctx.storage)
    const nodeTagsCollections = makeNodeTagsCollections(ctx.storage)
    const tagFieldDefinitionsCollections = makeTagFieldDefinitionsCollections(ctx.storage)
    const syncFeedCollections = makeSyncFeedCollections(ctx.storage)
    this.#collections = nodesCollections

    // App Library backend-implementation stage: same "own small collections module" shape as
    // every other `make*Collections(ctx.storage)` call above/below — see `app-collections.ts`'s
    // own header comment for why `apps`/`appCodeVersions` are two collections, not one.
    const appCollections = makeAppCollections(ctx.storage)

    // Built once, per the plan's "DO class boundary" pattern — composed here, not per-request.
    // Repository layers have no dependencies of their own; `GraphServiceLive`/`NotesServiceLive`
    // are `Layer.effect`s that *require* several of those repositories (plus `SyncFeedService`),
    // so `Layer.provide` wires the repository layer into them before they're merged into the
    // final, fully self-contained instance Layer.
    const repositoriesLayer = Layer.mergeAll(
      makeNodesRepositoryLive(nodesCollections),
      makePagesRepositoryLive(pagesCollections),
      makeTagsRepositoryLive(tagsCollections),
      makeFactsRepositoryLive(factsCollections),
      makeEdgesRepositoryLive(edgesCollections),
      makeRelationDefinitionsRepositoryLive(relationDefinitionsCollections),
      makeGraphIssuesRepositoryLive(graphIssuesCollections),
      makeAppsRepositoryLive(appCollections),
      makeSyncFeedServiceLive(syncFeedCollections)
    )
    const graphServiceLive = makeGraphServiceLive(
      tagsCollections,
      tagClosureCollections,
      edgesCollections,
      nodeTagsCollections,
      tagFieldDefinitionsCollections,
      this.#sql
    ).pipe(Layer.provide(repositoriesLayer))
    const notesServiceLive = makeNotesServiceLive(pagesCollections, this.#sql).pipe(Layer.provide(repositoriesLayer))
    // Phase 3 spike (plan risk #4): the Automerge-fork-as-chat-branch mechanism. Depends on
    // `NotesService` itself (not the raw `pagesCollections`) — see chat-fork-service-live.ts's
    // header comment for why every mainline read/write must go through NotesService's own doc
    // cache rather than around it.
    const chatForkServiceLive = makeChatForkServiceLive().pipe(Layer.provide(notesServiceLive))
    const viewsServiceLive = makeViewsServiceLive(this.#sql)
    const loggerLive = Logger.minimumLogLevel(LogLevel.Info)

    // Phase 3: `AgentEditService` (plan §"Agent-native editing & gatekeeper integrations").
    // `ModelClient` is production-real (`ModelClientAnthropic`, wired against `env.ANTHROPIC_API_KEY`
    // — `undefined` in every environment that hasn't configured one, including this one, per this
    // task's hard constraint: real client, cleanly `ModelUnavailable` before any network I/O, never
    // a fabricated key), wrapped so every call checks `agentEditModelClientTestHook.converse` live
    // first (see that hook's own doc comment for why this indirection, rather than a construction-
    // time `Layer` swap, is needed) — the mechanism this stage's tests use to drive
    // `sendChatMessage` against a deterministic `ModelClientScripted` double over real Cap'n Web RPC.
    const realModelClientLayer = makeModelClientAnthropicLive({
      apiKey: env.ANTHROPIC_API_KEY,
      gateway: aiGatewayRoute
    }).pipe(
      Layer.provide(HttpFetchLive)
    )
    const modelClientLayer: Layer.Layer<ModelClient> = Layer.effect(
      ModelClient,
      Effect.gen(function* () {
        const real = yield* ModelClient.pipe(Effect.provide(realModelClientLayer))
        return {
          converse: (thread, availableTools) =>
            agentEditModelClientTestHook.converse !== undefined
              ? agentEditModelClientTestHook.converse(thread, availableTools)
              : real.converse(thread, availableTools)
        }
      })
    )
    const agentEditCollections = makeAgentEditCollections(ctx.storage)
    const agentEditServiceLive = makeAgentEditServiceLive(
      this.#workspaceId,
      agentEditCollections,
      nodesCollections,
      factsCollections,
      edgesCollections,
      appCollections,
      this.#sql
    ).pipe(
      Layer.provide(
        Layer.mergeAll(repositoriesLayer, graphServiceLive, notesServiceLive, chatForkServiceLive, modelClientLayer)
      )
    )

    // App Library backend-implementation stage: `AppsService` (mainline/direct CRUD — see
    // `apps-service-live.ts`'s own header comment for why this is a separate service from
    // `AgentEditService`'s agent-facing `createAppTool`/`updateAppCodeTool` pair). Depends only on
    // `AppsRepository` (already part of `repositoriesLayer`).
    const appsServiceLive = makeAppsServiceLive(appCollections).pipe(Layer.provide(repositoriesLayer))

    // App Library backend-EXECUTION stage: `AppRuntimeService` (`app-runtime-service-live.ts`) —
    // the real sandboxed-execution mechanism, Worker Loaders (`env.LOADER`), the SAME mechanism
    // cloudflare-os's own gadgets run on. Real (genuine dynamically-loaded Worker isolates, not
    // mocked) whenever `wrangler.jsonc`'s `worker_loaders` binding is present — which, unlike
    // `GATEKEEPER_GOOGLE_CALENDAR`, needs no external OAuth client to be usable, the same
    // "unconditionally bound and real, including in this environment's own tests" category
    // `MEETING_AUDIO` is in. Depends on `appsServiceLive` (to resolve an App's current mainline
    // `server` code) rather than `AppsRepository` directly — see that file's own header comment.
    const appRuntimeServiceLive: Layer.Layer<AppRuntimeService> =
      env.LOADER !== undefined
        ? makeAppRuntimeServiceLive(env.LOADER).pipe(Layer.provide(appsServiceLive))
        : AppRuntimeServiceUnconfigured

    // Phase 4: `SharingService` (docs/sharing.md port). Depends on nothing else in
    // `instanceLayer` (its own `#workspaceMeta` singleton read/`#sharingCollections` are closed over
    // directly, not `yield*`ed as `Context.Tag`s), so `Layer.succeed` needs no `Layer.provide`.
    const sharingServiceLive = makeSharingServiceLive(this.#sharingCollections, this.#workspaceMeta, this.#workspaceId)

    // Phase 5: `CalendarService` (gatekeeper-rpc.ts's eight methods). `CalendarGatekeeperClient`
    // is real (a plain JSON-over-fetch client against the `GATEKEEPER_GOOGLE_CALENDAR` service
    // binding — see `calendar-gatekeeper-client.ts`'s own header comment for why this hop isn't
    // Cap'n Web) when that binding is configured, and a clean per-call-failing stub
    // (`CalendarGatekeeperClientUnconfigured`) otherwise — per this task's hard constraint, no
    // real Google OAuth client exists in THIS environment, and the gatekeeper Worker itself is
    // not deployed here, so this binding is genuinely absent; every other RPC method on this DO
    // keeps working unaffected (mirrors `ModelClientAnthropic`'s own "unconfigured, fails per-call"
    // precedent, not a DO-construction-time crash).
    const calendarCollections = makeCalendarCollections(ctx.storage)
    // Adversarial-review fix: the real HTTP client is only wired in when BOTH the service binding
    // AND the shared caller-credential secret are configured — an empty/missing
    // `GATEKEEPER_GOOGLE_CALENDAR_CALLER_HMAC_SECRET` now falls back to `CalendarGatekeeperClientUnconfigured`
    // exactly like a missing binding does, rather than silently sending unsigned (and therefore,
    // post-fix, always-401'd) requests. See `gatekeeper-service-credential.ts`'s and `worker.ts`'s
    // (in `@athenaeum/gatekeeper-google-calendar`) own header comments for the full "why".
    const gatekeeperCallerHmacSecret = env.GATEKEEPER_GOOGLE_CALENDAR_CALLER_HMAC_SECRET
    const realCalendarGatekeeperClientLayer =
      env.GATEKEEPER_GOOGLE_CALENDAR && gatekeeperCallerHmacSecret !== undefined && gatekeeperCallerHmacSecret.length > 0
        ? makeCalendarGatekeeperClientServiceBindingLive(env.GATEKEEPER_GOOGLE_CALENDAR, gatekeeperCallerHmacSecret)
        : CalendarGatekeeperClientUnconfigured
    // See `calendarGatekeeperClientTestHook`'s own doc comment for why this indirection exists —
    // identical shape to `modelClientLayer` below.
    const calendarGatekeeperClientLive: Layer.Layer<CalendarGatekeeperClient> = Layer.effect(
      CalendarGatekeeperClient,
      Effect.gen(function* () {
        const real = yield* CalendarGatekeeperClient.pipe(Effect.provide(realCalendarGatekeeperClientLayer))
        return {
          buildAuthorizationUrl: (state, redirectUri) =>
            (calendarGatekeeperClientTestHook.api ?? real).buildAuthorizationUrl(state, redirectUri),
          exchangeAndConnect: (email, code, redirectUri) =>
            (calendarGatekeeperClientTestHook.api ?? real).exchangeAndConnect(email, code, redirectUri),
          listCalendars: (email) => (calendarGatekeeperClientTestHook.api ?? real).listCalendars(email),
          eventsPage: (email, calendarId, query) =>
            (calendarGatekeeperClientTestHook.api ?? real).eventsPage(email, calendarId, query),
          mintObserverVerifier: (observerEmail) =>
            (calendarGatekeeperClientTestHook.api ?? real).mintObserverVerifier(observerEmail),
          addObserver: (boundByEmail, bindingId, observerId, verifierToken, mode, calendarId) =>
            (calendarGatekeeperClientTestHook.api ?? real).addObserver(
              boundByEmail,
              bindingId,
              observerId,
              verifierToken,
              mode,
              calendarId
            ),
          notifyCalendarTouched: (boundByEmail, bindingId, calendarId) =>
            (calendarGatekeeperClientTestHook.api ?? real).notifyCalendarTouched(boundByEmail, bindingId, calendarId)
        }
      })
    )
    const calendarServiceLive = makeCalendarServiceLive(calendarCollections, {
      stateSecret: env.CALENDAR_OAUTH_STATE_SECRET ?? "",
      redirectUri: env.CALENDAR_OAUTH_REDIRECT_URI ?? ""
    }).pipe(
      Layer.provide(
        Layer.mergeAll(repositoriesLayer, graphServiceLive, calendarGatekeeperClientLive, sharingServiceLive)
      )
    )

    // Phase 6 (`MeetingsService`/`VoiceSessionService`, task items 1/3): same "own small
    // collections module, own Layer, provided into `instanceLayer`" shape as `CalendarService`
    // above. `MeetingAudioBucket` is real (`env.MEETING_AUDIO` — see `wrangler.jsonc`'s own
    // comment for why this, unlike `GATEKEEPER_GOOGLE_CALENDAR`, is unconditionally bound and
    // real in every environment including this one) with the same "fail-closed if somehow unset"
    // fallback discipline every other optional binding in this file uses.
    const meetingCollections = makeMeetingCollections(ctx.storage)
    const meetingAudioBucketLive =
      env.MEETING_AUDIO !== undefined ? makeMeetingAudioBucketR2Live(env.MEETING_AUDIO) : MeetingAudioBucketUnconfigured
    const meetingsServiceLive = makeMeetingsServiceLive(meetingCollections).pipe(
      Layer.provide(Layer.mergeAll(repositoriesLayer, meetingAudioBucketLive))
    )
    const voiceSessionCollections = makeVoiceSessionCollections(ctx.storage)
    const voiceSessionServiceLive = makeVoiceSessionServiceLive(voiceSessionCollections).pipe(
      Layer.provide(repositoriesLayer)
    )

    // Phase 7 (`WorkoutsService`, plan §"Phased delivery": "HealthKit import as typed graph
    // pages... no new mechanism") — same "own small collections module, own Layer, provided into
    // `instanceLayer`" shape as `MeetingsService`/`CalendarService` above. Depends on
    // `repositoriesLayer` (for `NodesRepository`/`SyncFeedService`) AND `graphServiceLive` (for
    // `addFact`/`assignTag`/`createEdge` — see `workouts-service-live.ts`'s header comment for why
    // this service composes those rather than duplicating their mutation logic), plus the raw
    // `tagsCollections`/`tagClosureCollections`/`relationDefinitionsCollections` handles (for
    // `ensureWorkoutTagsSeeded`'s low-level seeding — same dual "yielded services for ordinary
    // mutations, raw collections for closure-recompute-shaped seeding" split `graphServiceLive`
    // itself uses).
    const workoutCollections = makeWorkoutCollections(ctx.storage)
    const workoutsServiceLive = makeWorkoutsServiceLive(
      workoutCollections,
      tagsCollections,
      tagClosureCollections,
      relationDefinitionsCollections,
      factsCollections,
      edgesCollections,
      nodeTagsCollections,
      this.#sql,
      // Adversarial-review fix — see `workouts-service-live.ts`'s `writeSubgraphAndReceipt` doc
      // comment: used only for its `transactionSync` escape hatch, the same `ctx.storage` instance
      // `makeWorkoutCollections(ctx.storage)` above already builds its collections over.
      ctx.storage
    ).pipe(Layer.provide(Layer.mergeAll(repositoriesLayer, graphServiceLive)))

    // Phase 6 (`CloudTranscriptionClient`/`RealtimeVoiceClient`, task item 2): real-but-currently-
    // unconfigured Layers (no `OPENAI_TRANSCRIPTION_API_KEY`/`OPENAI_REALTIME_API_KEY` secret
    // exists in this environment — see `wrangler.jsonc`'s own comment), wrapped in the exact same
    // live-per-call test-hook indirection as `modelClientLayer`/`calendarGatekeeperClientLive`
    // above, for the identical reason: a test needs to swap in a scripted double AFTER this DO
    // instance may already be constructed.
    const realCloudTranscriptionClientLayer = makeCloudTranscriptionClientOpenAILive({
      apiKey: env.OPENAI_TRANSCRIPTION_API_KEY,
      gateway: aiGatewayRoute
    }).pipe(Layer.provide(HttpFetchLive))
    const cloudTranscriptionClientLive: Layer.Layer<CloudTranscriptionClient> = Layer.effect(
      CloudTranscriptionClient,
      Effect.gen(function* () {
        const real = yield* CloudTranscriptionClient.pipe(Effect.provide(realCloudTranscriptionClientLayer))
        return {
          transcribe: (transcribeInput) =>
            (cloudTranscriptionClientTestHook.transcribe ?? real.transcribe)(transcribeInput)
        }
      })
    )
    const realRealtimeVoiceClientLayer = makeRealtimeVoiceClientOpenAILive({
      apiKey: env.OPENAI_REALTIME_API_KEY,
      gateway: aiGatewayRoute
    }).pipe(Layer.provide(WebSocketTransportLive))
    const realtimeVoiceClientLive: Layer.Layer<RealtimeVoiceClient> = Layer.effect(
      RealtimeVoiceClient,
      Effect.gen(function* () {
        const real = yield* RealtimeVoiceClient.pipe(Effect.provide(realRealtimeVoiceClientLayer))
        return {
          openSession: (sessionConfig) =>
            (voiceRealtimeClientTestHook.openSession ?? real.openSession)(sessionConfig)
        }
      })
    )

    const instanceLayer = Layer.mergeAll(
      repositoriesLayer,
      graphServiceLive,
      notesServiceLive,
      chatForkServiceLive,
      viewsServiceLive,
      agentEditServiceLive,
      appsServiceLive,
      appRuntimeServiceLive,
      sharingServiceLive,
      calendarServiceLive,
      meetingsServiceLive,
      voiceSessionServiceLive,
      cloudTranscriptionClientLive,
      realtimeVoiceClientLive,
      workoutsServiceLive,
      loggerLive
    )

    // `ManagedRuntime.make` builds this Layer graph's Effects (including `GraphServiceLive`'s/
    // `NotesServiceLive`'s `Layer.effect` construction — real setup code, not just a value, since
    // it `yield*`s several `Context.Tag` dependencies and closes over genuinely stateful
    // `Map`s/caches) **exactly once**, right here, and caches the resolved `Context` for reuse.
    // This matters correctness-wise, not just for performance: every RPC method below runs its
    // program via `this.#runtime.runPromiseExit(...)` (see `rpc-boundary.ts`'s `runRpcProgram`
    // doc comment) rather than a fresh `Effect.provide(layer)` per call — the latter would rebuild
    // `GraphServiceLive`/`NotesServiceLive` from scratch on every single RPC call, silently
    // discarding their in-memory state (the Automerge doc cache, sync-session map) between calls,
    // which is exactly the bug a first pass at this file shipped and a `pageSyncMessage` round
    // trip test caught immediately (a session started by one call was gone by the next).
    this.#runtime = ManagedRuntime.make(instanceLayer)

    // Base Tag seeding (task item 2): run exactly once before this DO instance serves its first
    // request, and make every other request queued behind it — `blockConcurrencyWhile` is the
    // correct Cloudflare DO primitive for that (see `seed-base-tags.ts`'s own doc comment for why
    // this was chosen over the alternative "check on every RPC entrypoint" design). Still
    // idempotent on its own terms: a DO can be constructed more than once over its storage's
    // lifetime (eviction, then a later request re-instantiates it), and `ensureBaseTagsSeeded`
    // checks existing rows before writing regardless of how many times it runs.
    //
    // Rich-text-editor pass: `ensureMentionRelationSeeded` (`mention-seed.ts`) joins this same
    // block for the identical reason — `syncNoteReferences` needs the fixed "mentions"
    // `RelationDefinition` to exist before the very first `@`-mention can be reconciled, and (like
    // Base Tags) this is core, always-on functionality for every workspace, not an optional
    // lazily-seeded feature the way `ensureWorkoutTagsSeeded` is.
    ctx.blockConcurrencyWhile(() =>
      Effect.runPromise(
        Effect.all(
          [
            ensureBaseTagsSeeded(tagsCollections, tagClosureCollections, this.#sql),
            ensureMentionRelationSeeded(relationDefinitionsCollections, this.#sql),
            // Supertag-centering pass (docs/supertag-centering-decisions.md §1): joins the same
            // block for the same reason `ensureBaseTagsSeeded` does — Base Tag field defaults are
            // core, always-on functionality, not an optional lazily-seeded feature.
            ensureBaseTagFieldsSeeded(tagFieldDefinitionsCollections)
          ],
          { discard: true }
        )
      )
    )
  }

  /**
   * The Cap'n Web session entrypoint for this workspace. Reimplements `newWorkersRpcResponse`'s own
   * dispatch (POST → `newHttpBatchRpcResponse`, `Upgrade: websocket` → a WebSocket-pair session)
   * rather than calling that convenience wrapper directly, for one reason: the WebSocket branch
   * needs the raw server-side socket to track in `#activeSockets` (`newWorkersRpcResponse`'s own
   * equivalent, `newWorkersWebSocketRpcResponse`, builds and discards that pair internally with
   * no way to observe it — see this file's header comment and `evictSessions`' doc comment for
   * why that tracking is the real mechanism this stage needs). The POST/HTTP-batch branch is
   * otherwise identical to `newWorkersRpcResponse`'s (including the CORS header), since a batch
   * call is stateless — there is no live connection for `evictSessions` to ever need to close.
   *
   * Also parses an optional Bearer credential (`dev-auth.ts#extractBearerCredential`) once, before
   * branching — see this file's header comment ("Auth-context plumbing"). A request with no
   * credential proceeds exactly as before this stage (`currentUser: undefined`, full anonymous
   * access to every existing RPC method, unchanged); a request with a credential that fails
   * session-credential verification is rejected outright (401) rather than silently downgraded to
   * anonymous — the safer default once *any* credential is present, and unreachable by every
   * existing test/client that never sends one. **Adversarial-review fix, one narrow exception**:
   * on the two App HTTP routes only (`parseAppRouteIds`), a Bearer that fails session-credential
   * verification gets ONE more chance — verified instead as an App-run credential
   * (`app-run-credential.ts`) scoped to the exact App/workspace the URL names — before falling back
   * to the same 401. Every other route is completely unaffected by this fallback.
   */
  /**
   * Dispatches the two plain-HTTP App routes (this file's own header comment on
   * `APP_RUN_PATH`/`APP_CLIENT_JS_PATH` above) — called from `fetch()` before the existing
   * WebSocket/HTTP-batch Cap'n Web dispatch, since neither of these URL shapes is ever a Cap'n Web
   * session request. Returns `undefined` (not a `Response`) when `request` matches neither route,
   * telling `fetch()` to fall through to its pre-existing dispatch unchanged.
   */
  async #handleAppRoute(
    url: URL,
    request: Request,
    currentUser: AuthenticatedUser | undefined,
    appRunAuthorized: boolean
  ): Promise<Response | undefined> {
    const clientMatch = APP_CLIENT_JS_PATH.exec(url.pathname)
    if (clientMatch) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return withAppRouteCors(new Response("This endpoint only accepts GET.", { status: 405 }))
      }
      return withAppRouteCors(
        await this.#serveAppClientCode(clientMatch[1] ?? "", clientMatch[2] ?? "", currentUser, appRunAuthorized)
      )
    }

    const runMatch = APP_RUN_PATH.exec(url.pathname)
    if (runMatch) {
      return withAppRouteCors(
        await this.#runAppRequest(
          runMatch[1] ?? "",
          runMatch[2] ?? "",
          runMatch[3] ?? "",
          request,
          currentUser,
          appRunAuthorized
        )
      )
    }

    return undefined
  }

  /** `GET /api/workspace/:workspaceId/apps/:appId/client.js` — see this file's header comment on
   *  `APP_CLIENT_JS_PATH` above. Serves the App's current mainline `client` code verbatim as
   *  `text/javascript`, for the iframe to load as a `<script src>`. Never executes this code
   *  itself (unlike `#runAppRequest`'s `server` code) — it is handed to the CALLER's browser,
   *  which is responsible for running it inside its own sandboxed iframe (per this task's hard
   *  constraint: "An app's client code renders in an iframe that must be genuinely sandboxed" —
   *  the iframe's own `sandbox` attribute is a `web` package concern, not this backend route's;
   *  this route only needs to serve the bytes under the same role gate every other App read
   *  uses). */
  async #serveAppClientCode(
    rawWorkspaceId: string,
    rawAppId: string,
    currentUser: AuthenticatedUser | undefined,
    appRunAuthorized: boolean
  ): Promise<Response> {
    const ownWorkspaceId = this.#workspaceId
    const program = Effect.gen(function* () {
      const requestedWorkspaceId = yield* decodeRpcInput(EntityId, rawWorkspaceId)
      const appId = yield* decodeRpcInput(EntityId, rawAppId)
      yield* requireOwnWorkspace(ownWorkspaceId, requestedWorkspaceId)
      // A caller carrying a valid, correctly-scoped App-run credential (`fetch()`'s own doc
      // comment) already proved "use" role at MINT time — this route only needs the ordinary
      // per-caller check when that alternative wasn't presented/didn't apply.
      if (!appRunAuthorized) {
        yield* requireRoleForGovernedWorkspace(currentUser, "use")
      }
      const apps = yield* AppsService
      const codeVersion = yield* apps.getAppCode(ownWorkspaceId, appId, "client")
      return codeVersion.code
    })

    const exit = await this.#runtime.runPromiseExit(program)
    if (Exit.isSuccess(exit)) {
      return new Response(exit.value, { status: 200, headers: { "Content-Type": "text/javascript; charset=utf-8" } })
    }
    return domainErrorToHttpResponse(domainErrorFromCause(exit.cause))
  }

  /** `ALL /api/workspace/:workspaceId/apps/:appId/run(/...)` — see this file's header comment on
   *  `APP_RUN_PATH` above. Rewrites the forwarded request's path to strip the
   *  `.../apps/:appId/run` prefix (so the sandboxed App's own routing sees a clean path — a
   *  request to `.../run/widgets/7?x=1` reaches the App as `/widgets/7?x=1`; a bare `.../run`
   *  reaches it as `/`) and strips the caller's own `Authorization`/`Cookie` headers before the
   *  request ever reaches sandboxed code — an App has no legitimate use for the CALLER's own
   *  workspace credential (it has no network egress and no binding back into this workspace to
   *  present it to — see `app-runtime-service-live.ts`'s header comment), so it is never even
   *  handed the chance to read it, not merely trusted not to misuse it. */
  async #runAppRequest(
    rawWorkspaceId: string,
    rawAppId: string,
    restPath: string,
    request: Request,
    currentUser: AuthenticatedUser | undefined,
    appRunAuthorized: boolean
  ): Promise<Response> {
    const ownWorkspaceId = this.#workspaceId

    const forwardedUrl = new URL(request.url)
    forwardedUrl.pathname = restPath === "" ? "/" : restPath
    // Adversarial-review fix's own credential (`?token=` — an App-run credential OR, still
    // supported, a real session credential) is this route's OWN auth concern, never the
    // sandboxed App's business — stripped before forwarding for the identical reason the
    // `Authorization`/`Cookie` headers below are: the App has no legitimate use for it, so it
    // never even gets the chance to read it back out of its own request's query string.
    forwardedUrl.searchParams.delete("token")
    const forwardedHeaders = new Headers(request.headers)
    forwardedHeaders.delete("Authorization")
    forwardedHeaders.delete("Cookie")
    const hasBody = request.method !== "GET" && request.method !== "HEAD"
    const forwardedRequest = new Request(forwardedUrl.toString(), {
      method: request.method,
      headers: forwardedHeaders,
      ...(hasBody ? { body: request.body, duplex: "half" } : {})
    } as RequestInit)

    const program = Effect.gen(function* () {
      const requestedWorkspaceId = yield* decodeRpcInput(EntityId, rawWorkspaceId)
      const appId = yield* decodeRpcInput(EntityId, rawAppId)
      yield* requireOwnWorkspace(ownWorkspaceId, requestedWorkspaceId)
      if (!appRunAuthorized) {
        yield* requireRoleForGovernedWorkspace(currentUser, "use")
      }
      const appRuntime = yield* AppRuntimeService
      return yield* appRuntime.runRequest(ownWorkspaceId, appId, forwardedRequest)
    })

    const exit = await this.#runtime.runPromiseExit(program)
    if (Exit.isSuccess(exit)) return exit.value
    return domainErrorToHttpResponse(domainErrorFromCause(exit.cause))
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const bearer = extractBearerCredential(request, url)
    // Only non-`undefined` for the two App HTTP routes (`parseAppRouteIds`'s own doc comment) —
    // every other path (every Cap'n Web/RPC route) gets `undefined` here and so never takes the
    // App-run-credential fallback branch below, keeping its existing strict behavior untouched.
    const appRouteIds = parseAppRouteIds(url.pathname)

    // CORS-fix companion (see `withAppRouteCors`'s own doc comment): a real browser preflights
    // any App-route request that isn't a CORS "simple request" (e.g. a POST with a JSON body) with
    // an unauthenticated `OPTIONS` — answered here, before ANY credential parsing/verification,
    // exactly per the Fetch/CORS spec (a preflight never carries the eventual request's real
    // credential and must never be gated behind one). This can never widen access to the actual
    // App run/read below: the real GET/POST that follows still goes through the exact same
    // `requireRoleForGovernedWorkspace`/App-run-credential check every other request does.
    if (appRouteIds !== undefined && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: APP_ROUTE_CORS_HEADERS })
    }

    let currentUser: AuthenticatedUser | undefined
    let appRunAuthorized = false
    if (bearer !== undefined) {
      const secret = this.env.DEV_AUTH_HMAC_SECRET
      if (secret === undefined || secret.length === 0) {
        return new Response("Dev auth credential presented, but this deployment has no DEV_AUTH_HMAC_SECRET configured.", {
          status: 500
        })
      }
      const exit = await Effect.runPromiseExit(verifyDevCredential(bearer, secret))
      if (Exit.isSuccess(exit)) {
        currentUser = exit.value
      } else if (appRouteIds !== undefined) {
        // **Adversarial-review fix.** Not a real session credential — on one of the two App HTTP
        // routes (and ONLY there), this may instead be a narrowly-scoped `athenaeum-app-run-v1`
        // credential (`app-run-credential.ts`, minted by `mintAppRunCredential` above) that
        // `AppLibraryPanel.tsx`'s preview iframe/the App's own sandboxed client code presents
        // instead of the user's real session token. Accepted ONLY if it verifies AND names the
        // exact `workspaceId`/`appId` this URL is for — a credential minted for a different App or
        // workspace is rejected exactly as if none were presented, never silently authorizing the
        // wrong resource.
        const appCredExit = await Effect.runPromiseExit(verifyAppRunCredential(bearer, secret))
        if (
          Exit.isSuccess(appCredExit) &&
          appCredExit.value.workspaceId === appRouteIds.workspaceId &&
          appCredExit.value.appId === appRouteIds.appId
        ) {
          appRunAuthorized = true
        } else {
          return new Response("Invalid or expired credential.", { status: 401 })
        }
      } else {
        return new Response("Invalid or expired credential.", { status: 401 })
      }
    }

    // App Library backend-EXECUTION stage: the two plain-HTTP App routes (this file's header
    // comment on `APP_RUN_PATH`/`APP_CLIENT_JS_PATH`) are checked before the Cap'n Web
    // WebSocket/HTTP-batch dispatch below — neither route's URL shape is ever a Cap'n Web session
    // request, so this can never intercept existing traffic; `#handleAppRoute` returns
    // `undefined` for anything that isn't one of these two routes.
    const appRouteResponse = await this.#handleAppRoute(url, request, currentUser, appRunAuthorized)
    if (appRouteResponse !== undefined) return appRouteResponse

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair()
      const server = pair[0]
      const client = pair[1]
      server.accept()

      this.#activeSockets.set(server, currentUser)
      const untrack = (): void => {
        this.#activeSockets.delete(server)
      }
      server.addEventListener("close", untrack)
      server.addEventListener("error", untrack)

      newWebSocketRpcSession(
        server,
        new WorkspaceRpcApi(
          this.#runtime,
          this.#collections,
          this.#workspaceId,
          this.#sql,
          currentUser,
          (emails, reason) => this.#scheduleRevocationEviction(emails, reason),
          this.#liveVoiceAudioSessions,
          this.env.DEV_AUTH_HMAC_SECRET
        )
      )
      return new Response(null, { status: 101, webSocket: client })
    }

    if (request.method === "POST") {
      const response = await newHttpBatchRpcResponse(
        request,
        new WorkspaceRpcApi(
          this.#runtime,
          this.#collections,
          this.#workspaceId,
          this.#sql,
          currentUser,
          (emails, reason) => this.#scheduleRevocationEviction(emails, reason),
          this.#liveVoiceAudioSessions,
          this.env.DEV_AUTH_HMAC_SECRET
        )
      )
      response.headers.set("Access-Control-Allow-Origin", "*")
      return response
    }

    return new Response("This endpoint only accepts POST or WebSocket requests.", { status: 400 })
  }

  /**
   * The real revocation-eviction scheduling mechanics (task item 6), following docs/sharing.md
   * §"Terminating live sessions on revocation"'s own "two precautions" almost verbatim, adapted
   * to this DO's gentler `evictSessions` (Decisions-stage-approved alternative to cloudflare-os's
   * `ctx.abort()` — see `evictSessions`'s own doc comment) instead of a whole-DO restart:
   *
   *   1. **Flush first.** `ctx.storage.sync()` — cited directly from docs/sharing.md: "the severed
   *      edge is flushed with `ctx.storage.sync()` first (because `ctx.abort()` does not respect
   *      the output gate, a restart could otherwise come back with the change lost)." Even though
   *      `evictSessions` doesn't restart the DO at all (so this specific failure mode is less of a
   *      risk here), the same discipline is kept: eviction should never race ahead of the write
   *      that justified it.
   *   2. **~100ms delay.** "the abort is delayed ~100ms so the triggering RPC's response reaches
   *      the caller... before their own connection drops" — applies identically here: the caller
   *      of `removeCollaborator`/`revokeShareLink` is very often ALSO a live connection to this
   *      same workspace (the owner, managing sharing from an open session), so evicting immediately
   *      could sever the response before the RPC promise resolves on their end.
   *
   * Called fire-and-forget (never awaited) from `removeCollaborator`/`revokeShareLink` — see
   * `WorkspaceRpcApi#removeCollaborator`'s own call site — exactly mirroring docs/sharing.md's own
   * `scheduleRevocationRestart` being asynchronous background work relative to the RPC call that
   * triggers it. Loops `evictSessions` once per affected email rather than the coarse "evict
   * everyone" form, since only the specifically affected collaborators (never bystanders) should
   * be disconnected — see `evictSessions`'s own doc comment for why a targeted close is safe for
   * everyone else's live `NotesService` session state.
   */
  #scheduleRevocationEviction(emails: ReadonlyArray<string>, reason: string): void {
    void (async () => {
      try {
        await this.#storage.sync()
      } catch {
        // Best-effort flush — proceed with eviction regardless; see this method's own doc
        // comment for why `ctx.storage.sync()` is a precaution here, not a hard prerequisite.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      for (const email of emails) {
        await this.evictSessions({ email, reason })
      }
    })()
  }

  /**
   * Test-only inspection hook for the "raw share key is not reconstructible from stored state"
   * security property (docs/sharing.md's "Share key security" paragraph — see `sharing-service-
   * live.ts`'s own header comment on `SHARE_KEY_HMAC_KEY`). Dumps the RAW `shareKeys` collection
   * exactly as stored — `{hash, linkId, alias}` per row, no revival into a full `ShareKeyRecord`
   * needed for this purpose — so a test can assert a raw key (which it, uniquely, still holds
   * from `createShareLink`'s return value) never appears anywhere in what the server actually
   * persisted. `ctx.exports`-only, same access rule as `evictSessions`/`getOwner`/`initializeOwner`
   * above: never exposed on `WorkspaceRpcApi`/Cap'n Web, since dumping raw storage rows is exactly the
   * kind of capability an arbitrary connected client must never have.
   */
  async debugListShareKeyRows(): Promise<ReadonlyArray<{ readonly hash: string; readonly linkId: string; readonly alias: boolean }>> {
    const rows = await Effect.runPromise(this.#sharingCollections.shareKeys.list())
    return rows.map((row) => ({ hash: row.hash, linkId: row.linkId, alias: row.alias }))
  }

  // --- Phase 6 debug/test hooks (`ctx.exports`-only, never Cap'n Web-exposed — same access rule
  // as `debugListShareKeyRows`/`evictSessions` above) -------------------------------------------

  /**
   * Real, tested proof of `MeetingsService`'s R2-backed storage-tier split (task item 1) — see
   * `meetings-service-live.ts`'s own header comment for exactly why this capability is real and
   * exercised for real (a genuine, locally-simulated `R2Bucket` binding, not mocked) but has no
   * public RPC entrypoint yet in this stage.
   */
  async debugStoreMeetingAudioChunk(
    meetingId: string,
    chunkIndex: number,
    audio: Uint8Array,
    mimeType: string
  ): Promise<{ readonly r2Key: string }> {
    const decodedMeetingId = Schema.decodeUnknownSync(EntityId)(meetingId)
    const program = MeetingsService.pipe(
      Effect.flatMap((meetings) => meetings.storeAudioChunk(this.#workspaceId, decodedMeetingId, chunkIndex, audio, mimeType))
    )
    return runOrThrowRpcError(this.#runtime, program)
  }

  /** Read-side counterpart to `debugStoreMeetingAudioChunk` — same access rule. */
  async debugGetMeetingAudioChunk(meetingId: string, chunkIndex: number): Promise<Uint8Array | undefined> {
    const decodedMeetingId = Schema.decodeUnknownSync(EntityId)(meetingId)
    const program = MeetingsService.pipe(
      Effect.flatMap((meetings) => meetings.getAudioChunk(this.#workspaceId, decodedMeetingId, chunkIndex))
    )
    return runOrThrowRpcError(this.#runtime, program)
  }

  /**
   * `ctx.exports`-only, same access rule as `debugStoreMeetingAudioChunk` above — sets
   * `Meeting.linkedNodeId` (`MeetingsService#linkMeetingToNode`, real, tested, but no public RPC
   * entrypoint yet — see that method's own doc comment). Exists so a test can genuinely exercise
   * `getMeeting`/`listMeetings`'s `linkedNodeId` observer-visibility filter (`sanitizeMeetingLinkedNodeId`
   * above, the adversarial-review fix) end-to-end, rather than asserting it only against the
   * always-empty case the RPC surface produces today.
   */
  async debugLinkMeetingToNode(meetingId: string, nodeId: string): Promise<void> {
    const decodedMeetingId = Schema.decodeUnknownSync(EntityId)(meetingId)
    const decodedNodeId = Schema.decodeUnknownSync(EntityId)(nodeId)
    const program = MeetingsService.pipe(
      Effect.flatMap((meetings) => meetings.linkMeetingToNode(this.#workspaceId, decodedMeetingId, decodedNodeId)),
      // `ctx.exports` native RPC structured-clones the return value — a `Schema.Class` instance
      // (`Meeting`) is not structured-cloneable, and no caller of this debug-only hook needs the
      // updated row back (it re-reads via the real `getMeeting`/`listMeetings` RPC instead), so
      // this discards it rather than encoding it, matching `debugStoreMeetingAudioChunk`'s own
      // "return only plain, structured-clone-safe data" discipline.
      Effect.asVoid
    )
    return runOrThrowRpcError(this.#runtime, program)
  }

  /** `ctx.exports`-only, same access rule — sets `Bookmark.linkedNodeId`
   *  (`CalendarService#linkBookmarkToNode`), for the identical test-only purpose as
   *  `debugLinkMeetingToNode` above, applied to `listBookmarks`'s `linkedNodeId` filter. Discards
   *  the returned `Bookmark` for the same structured-clone reason. */
  async debugLinkBookmarkToNode(bookmarkId: string, nodeId: string): Promise<void> {
    const decodedBookmarkId = Schema.decodeUnknownSync(EntityId)(bookmarkId)
    const decodedNodeId = Schema.decodeUnknownSync(EntityId)(nodeId)
    const program = CalendarService.pipe(
      Effect.flatMap((calendar) => calendar.linkBookmarkToNode(this.#workspaceId, decodedBookmarkId, decodedNodeId)),
      Effect.asVoid
    )
    return runOrThrowRpcError(this.#runtime, program)
  }

  /**
   * Real, tested proof of task item 3's voice-to-agent wiring, against the REAL `AgentEditService`
   * this DO instance's own `#runtime` composes (not `voice-chat-bridge.test.ts`'s hand-built
   * double — see that file's own header comment for why THIS is the gap this method closes):
   * drives `voice-chat-bridge.ts#runVoiceChatTurns` for real, over the real Cap'n-Web-reachable
   * `AgentEditService.sendChatMessage`, with only `RealtimeVoiceClient` swapped for a scripted
   * double via `voiceRealtimeClientTestHook` (the same live-per-call indirection
   * `agentEditModelClientTestHook`/`calendarGatekeeperClientTestHook` already establish for this
   * exact purpose). A test drives this, then asserts on the REAL, already-Cap'n-Web-exposed
   * `listPendingChanges`/`listChatChanges`/`mergeChanges` RPC methods — proving "the same
   * pending-record/changes-stream behavior Phase 3 already proved, just entering via a different
   * front door" (task item 3's own wording) with no shortcut into internals for the assertion
   * itself, only for triggering the voice-sourced turns. `sessionConfig` decodes the real
   * `RealtimeVoiceSessionConfig` schema — `ctx.exports` native RPC round-trips plain data
   * structurally, not through Cap'n Web/`Schema.decodeUnknown`'s own validation, so this method
   * re-validates it explicitly, same discipline `initializeOwner`/`evictSessions` apply to their
   * own plain-data arguments elsewhere in this class. Maps `RealtimeVoiceError` into the
   * `DomainError` channel `runOrThrowRpcError` expects (the two are deliberately separate closed
   * unions — see `realtime-voice.ts`'s own header comment — so this is where they visibly join).
   */
  async debugRunVoiceChatTurns(
    chatId: string,
    sessionConfig: unknown
  ): Promise<{ readonly turnCount: number; readonly changesSequences: ReadonlyArray<number> }> {
    const decodedChatId = Schema.decodeUnknownSync(EntityId)(chatId)
    const decodedConfig = Schema.decodeUnknownSync(RealtimeVoiceSessionConfig)(sessionConfig)
    const program = runVoiceChatTurns(decodedChatId, decodedConfig).pipe(
      Effect.mapError(
        (error): DomainError =>
          error._tag === "RealtimeVoiceUnavailable" ||
          error._tag === "RealtimeVoiceConnectionFailed" ||
          error._tag === "RealtimeVoiceProtocolError"
            ? new UnexpectedError({ message: `${error._tag}: ${error.message}` })
            : error
      ),
      Effect.map((results) => ({
        turnCount: results.length,
        changesSequences: results.flatMap((result) => result.changesSequences)
      }))
    )
    return runOrThrowRpcError(this.#runtime, program)
  }

  /**
   * The real revocation-eviction mechanism (resolves the plan's "Caveat on ctx.abort() reuse"
   * finding — see `test/revocation-eviction.test.ts` for the empirical proof this doc comment
   * summarizes). Forcibly closes every currently-live WebSocket whose tracked identity matches
   * `opts.email` (or, if `opts.email` is omitted, every live socket — the coarse "evict
   * everyone" case, e.g. a full workspace deletion), with `opts.reason` as the WebSocket close reason
   * (code `4001`, an application-defined "access revoked, reconnect and re-authenticate" code a
   * future client can special-case).
   *
   * **Deliberately does NOT call `ctx.abort()`.** cloudflare-os's own `scheduleRevocationRestart`
   * (`workshop-backend/src/overseer.ts`) forces every client to reconnect by aborting the whole
   * gadget's Overseer DO — correct for its Yjs sessions, which "resync cheaply and statelessly
   * from the update log on reconnect" (the plan's own caveat, verified against
   * `notes-service-live.ts`: Automerge's sync-session state — `sessions`, the per-`(nodeId,
   * sessionId)` `Automerge.SyncState` + expected-ordinal map — is a plain in-memory `Map`, a
   * closure captured once inside `makeNotesServiceLive`, never persisted to `ctx.storage`. A
   * `ctx.abort()` destroys the whole DO instance, and thus that `Map`, for *every* connection to
   * this workspace, not just the revoked one — the next `pageSyncMessage` for *any* in-flight session,
   * revoked party or bystander, finds `session === undefined` and is forced into the expensive
   * `reset: true` full-resync path.
   *
   * `evictSessions` instead closes only the matching raw sockets. This DO instance — and thus
   * `NotesService`'s `docCache`/`sessions` state — is never touched, so: (1) every *other* live
   * session (a different collaborator, or the owner's own other tabs) is completely unaffected,
   * no forced resync, ever; and (2) even the evicted connection itself, if it reconnects with a
   * credential that is *still* valid (the downgrade case — access lowered, not fully removed),
   * resumes its *same* session id at its *same* expected ordinal and gets the cheap
   * `converged`/incremental path, not `reset: true` — because the server-side session state it
   * left behind was never destroyed, only the transport that carried it was.
   *
   * Called only via `ctx.exports` (native Workers RPC, e.g. `exports.WorkspaceDurableObject
   * .getByName(workspaceId).evictSessions(...)`), never exposed on `WorkspaceRpcApi`/Cap'n Web — an
   * arbitrary connected client must never be able to evict another connection itself; only
   * trusted, same-Worker callers (this stage's own tests; a future `SharingService`'s
   * `removeCollaborator`/`revokeShareLink`, exactly where cloudflare-os calls
   * `scheduleRevocationRestart` today) may call this.
   */
  async evictSessions(opts: { readonly email?: string; readonly reason: string }): Promise<{ evictedCount: number }> {
    let evictedCount = 0
    for (const [socket, user] of this.#activeSockets) {
      if (opts.email !== undefined && user?.email !== opts.email) continue
      try {
        socket.close(4001, opts.reason)
      } catch {
        // Already closing/closed — still counts as evicted; nothing further to do.
      }
      this.#activeSockets.delete(socket)
      evictedCount++
    }
    return { evictedCount }
  }

  /**
   * Registers this workspace's owner, once (plan §Phased delivery, Phase 4: "creating a workspace
   * registers it... implicitly, as workspace owner... in the new WorkspaceDurableObject itself" — task
   * item 3). Real logic lives in `workspace-ownership.ts#initializeWorkspaceOwner` (idempotent-for-the-
   * same-owner, refuses a different one — see that function's own doc comment).
   *
   * Called only via `ctx.exports` (`UserDurableObject#registerWorkspace`), never exposed on
   * `WorkspaceRpcApi`/Cap'n Web — same access rule as `evictSessions` above, for the same reason: an
   * arbitrary connected client must never be able to claim ownership of a workspace it merely
   * connected to. The caller (`UserDurableObject`) has already authenticated the human behind
   * this call before ever reaching here — it only ever names *itself* (`this.#ownEmail`) as
   * `ownerEmail`, never a caller-supplied value — so no additional Bearer-credential check is
   * needed at this trusted, same-Worker boundary (mirrors `requireOwnWorkspace`'s "defense-in-depth,
   * not the primary check" framing, one level up).
   */
  async initializeOwner(ownerEmail: string, title: string): Promise<{ readonly ownerEmail: string; readonly title: string }> {
    const meta = await Effect.runPromise(initializeWorkspaceOwner(this.#workspaceMeta, this.#workspaceId, ownerEmail, title))
    // `meta.ownerEmail` is `string | null` at the storage-shape level (see `WorkspaceMeta`'s own
    // comment) but `initializeWorkspaceOwner` only ever returns having set/confirmed it — narrow the
    // return type here rather than exposing the nullable storage shape across the RPC boundary.
    return { ownerEmail: meta.ownerEmail as string, title: meta.title }
  }

  /** Read-only counterpart to `initializeOwner`, same shape/rationale as `UserDurableObject
   *  #whoami` alongside `#ensureProfile` — `null` if this workspace has never been initialized with
   *  an owner. Also `ctx.exports`-only; see `initializeOwner`'s doc comment. */
  async getOwner(): Promise<{ readonly ownerEmail: string; readonly title: string } | null> {
    const meta = await Effect.runPromise(this.#workspaceMeta.get())
    return meta.ownerEmail === null ? null : { ownerEmail: meta.ownerEmail, title: meta.title }
  }
}
