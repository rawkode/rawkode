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
import { VersionVector, type LoroDoc } from "loro-crdt/bundler"
import { newHttpBatchRpcResponse, newWebSocketRpcSession, RpcTarget } from "capnweb"
import {
  AcceptChatForkInput,
  AcceptChatForkOutput,
  MigrateLegacyPageInput,
  MigrateLegacyPageOutput,
  CommitLoroPageContentInput,
  CommitLoroPageContentOutput,
  PrepareMeetingInDailyNoteInput,
  PrepareMeetingInDailyNoteOutput,
  LoroContentConflict,
  LoroRequestIdentityConflict,
  LoroSemanticCommitRequired,
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
  BaseTagIds,
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
  CreateNodeWithIntentInput,
  CreateNodeOutput,
  DecideAgentChangeProposalInput,
  DecideAgentChangeProposalOutput,
  CreateLoroPageInput,
  CreateLoroPageOutput,
  CreatePageInput,
  CreatePageOutput,
  ProposePageEditInput,
  ProposePageEditOutput,
  PreviewPageProposalInput,
  PreviewPageProposalOutput,
  AcceptPageProposalInput,
  AcceptPageProposalOutput,
  RevertPageProposalInput,
  RevertPageProposalOutput,
  CreateRelationDefinitionInput,
  CreateRelationDefinitionOutput,
  CreateTagInput,
  CreateTagOutput,
  GetTagInput,
  GetTagOutput,
  TagRead,
  UpdateTagInput,
  UpdateTagOutput,
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
  CalendarEvent,
  CalendarEventAttendee,
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
  GetPageDocumentDescriptorInput,
  GetPageDocumentDescriptorOutput,
  GetLegacyPageProjectionInput,
  GetLegacyPageProjectionOutput,
  type PageDocumentDescriptor,
  GetPageTextInput,
  GetPageTextOutput,
  GetTodayBriefInput,
  GetTodayBriefOutput,
  ListStandupPublicationsInput,
  ListStandupPublicationsOutput,
  StandupPublication,
  canonicalStandupPublicationText,
  GoogleCalendarOAuthCallbackInput,
  GoogleCalendarOAuthCallbackOutput,
  GraphIssuesRepository,
  IsoDateTimeString,
  LocalDate,
  LinkCalendarEventToNodeInput,
  LinkCalendarEventToNodeOutput,
  LinkCalendarEventToNodeLedgerReceipt,
  ListBacklinksInput,
  ListBacklinksOutput,
  ListBookmarksInput,
  ListBookmarksOutput,
  ListCalendarEventsInput,
  ListCalendarEventsOutput,
  ListGatekeeperBindingsInput,
  ListGatekeeperBindingsOutput,
  ListChatChangesInput,
  ListChatChangesOutput,
  ListCollaboratorsInput,
  ListCollaboratorsOutput,
  ListMeetingsInput,
  ListMeetingsOutput,
  ListPendingChangesInput,
  ListPendingChangesOutput,
  ListRecentLedgerActivityInput,
  ListRecentLedgerActivityOutput,
  LedgerActivityActorDetail,
  LedgerActivityEntry,
  LedgerActivityTarget,
  LedgerActivityType,
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
  LoroPageSyncMessageInput,
  LoroPageSyncMessageOutput,
  Meeting,
  MergeChangesInput,
  MergeChangesOutput,
  ChatThread,
  ModelClient,
  type ModelError,
  ModelTurnResult,
  AgentJobMutationAttribution,
  HumanUiMutationAttribution,
  MutationAttribution,
  MutationCommitMessage,
  NodeAlreadyExists,
  NodeNotFound,
  SystemMutationAttribution,
  PageFormatMismatch,
  PageNotFound,
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
  requireAuthenticatedUser,
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
  StartLoroPageSyncInput,
  StartLoroPageSyncOutput,
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
  normalizeCreateTagName,
  normalizeTagName,
  tagRevision,
  normalizeTagFieldName,
  sha256HexSync,
  canonicalJsonBytes,
  AgentChangeProposal,
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
import {
  decodePageDocumentFormatRow,
  makePagesCollections,
  makePagesRepositoryLive,
  toUnexpectedError,
  type PageDocumentFormatRow,
  type PagesCollections
} from "./pages-repository-live.js"
import { makeTagsCollections, makeTagsRepositoryLive } from "./tags-repository-live.js"
import { makeTagClosureCollections } from "./tag-closure.js"
import { makeFactsCollections, makeFactsRepositoryLive } from "./facts-repository-live.js"
import { makeEdgesCollections, makeEdgesRepositoryLive } from "./edges-repository-live.js"
import {
  makeRelationDefinitionsCollections,
  makeRelationDefinitionsRepositoryLive
} from "./relation-definitions-repository-live.js"
import { makeGraphIssuesCollections, makeGraphIssuesRepositoryLive } from "./graph-issues-repository-live.js"
import { makeSyncFeedCollections, makeSyncFeedServiceLive, SyncFeedService, type SyncFeedCollections } from "./sync-feed-service-live.js"
import { makeNodeTagsCollections } from "./node-tags-live.js"
import { makeTagFieldDefinitionsCollections } from "./tag-field-definitions-live.js"
import { ensureBaseTagsSeeded } from "./seed-base-tags.js"
import { ensureBaseTagFieldsSeeded } from "./seed-base-tag-fields.js"
import { ensureMentionRelationSeeded } from "./mention-seed.js"
import { GraphService, makeGraphServiceLive, type SyncNoteReferencesResult } from "./graph-service-live.js"
import { NotesService, makeNotesServiceLive } from "./notes-service-live.js"
import { LoroPageService, makeLoroPageServiceLive } from "./loro-page-service-live.js"
import { ChatForkService, makeChatForkServiceLive } from "./chat-fork-service-live.js"
import { makePageProposalCollections } from "./page-proposal-collections.js"
import { PageProposalService, makePageProposalServiceLive } from "./page-proposal-service-live.js"
import { ViewsService, makeViewsServiceLive } from "./views-service-live.js"
import { AgentEditService, makeAgentEditServiceLive } from "./agent-edit-service-live.js"
import { AgentLoroEditService, makeAgentLoroEditServiceLive } from "./agent-loro-edit-service-live.js"
import { WorkspaceLoroMutationGateway } from "./workspace-loro-mutation-gateway.js"
import { makeAgentEditCollections } from "./agent-edit-collections.js"
import { makeAgentChangeProposalCollections } from "./agent-change-proposal-collections.js"
import { makeAppCollections } from "./app-collections.js"
import { makeAppsRepositoryLive } from "./apps-repository-live.js"
import { AppsService, makeAppsServiceLive } from "./apps-service-live.js"
import { AppRuntimeService, AppRuntimeServiceUnconfigured, makeAppRuntimeServiceLive } from "./app-runtime-service-live.js"
import { CalendarService, makeCalendarServiceLive, resolveTodayBriefWindow } from "./calendar-service-live.js"
import {
  makeCalendarCollections,
  reviveCalendarEvent,
  type CalendarCollections
} from "./calendar-collections.js"
import {
  CalendarProjectionGateway,
  CALENDAR_RELATIONSHIP_CONCIERGE_VERSION,
  CALENDAR_RELATIONSHIP_CONCIERGE_WORKFLOW
} from "./calendar-projection-gateway.js"
import { calendarAttendeeDigest } from "./calendar-identity-digest.js"
import { calendarCivilDate, calendarConciergeBundle } from "./calendar-concierge-workforce.js"
import {
  CalendarConciergeExecutor,
  type CalendarConciergeExecutorIntegration
} from "./calendar-concierge-executor.js"
import {
  CALENDAR_CONCIERGE_CAPABILITY_VERSION,
  type CalendarConciergeExecutionBinding,
  type CalendarConciergeGrantResolver,
  type CalendarConciergeGrantV1,
  type CalendarConciergeJobPort,
  type CalendarConciergeTerminalResult,
  type CalendarConciergeExecutionAdapter
} from "./calendar-concierge-job-capability.js"
import {
  DurableCalendarConciergeGrantStore,
  type IssuedCalendarConciergeGrant
} from "./calendar-concierge-grant-store.js"
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
import {
  agentChangeDecisionLedgerFingerprint,
  addFactLedgerFingerprint,
  assignTagLedgerFingerprint,
  applySupertagLedgerFingerprint,
  createEdgeLedgerFingerprint,
  createTagLedgerFingerprint,
  updateTagLedgerFingerprint,
  ensureLoroPageLedgerFingerprint,
  commitLoroPageContentLedgerFingerprint,
  prepareMeetingInDailyNoteLedgerFingerprint,
  migrateLegacyPageLedgerFingerprint,
  createRelationDefinitionLedgerFingerprint,
  createBookmarkLedgerFingerprint,
  linkCalendarEventToNodeLedgerFingerprint,
  appendTranscriptSegmentLedgerFingerprint,
  startMeetingLedgerFingerprint,
  defineTagFieldLedgerFingerprint,
  syncNoteReferencesLedgerFingerprint,
  unassignTagLedgerFingerprint,
  type AddFactLedgerCommandInput,
  type ApplySupertagLedgerCommandInput,
  type AssignTagLedgerCommandInput,
  type CreateEdgeLedgerCommandInput,
  type CreateTagLedgerCommandInput,
  type UpdateTagLedgerCommandInput,
  type EnsureLoroPageLedgerCommandInput,
  type CommitLoroPageContentLedgerCommandInput,
  type CreateRelationDefinitionLedgerCommandInput,
  type CreateBookmarkLedgerCommandInput,
  type LinkCalendarEventToNodeLedgerCommandInput,
  type AppendTranscriptSegmentLedgerCommandInput,
  type StartMeetingLedgerCommandInput,
  type DefineTagFieldLedgerCommandInput,
  type SyncNoteReferencesLedgerCommandInput,
  type UnassignTagLedgerCommandInput,
  type CreateNodeWithIntentLedgerCommandInput,
  type LedgerCustodyInput,
  LedgerConflict,
  LedgerService,
  ledgerFingerprint,
  createNodeWithIntentLedgerFingerprint,
  calendarProjectionLedgerFingerprint
} from "./ledger-service.js"
import { loroVersionVectorIdentity } from "./loro-page-service-live.js"
import { DurableWorkforceRuntimeStore } from "./workforce-runtime-store.js"
import { WorkforceScheduler } from "./workforce-scheduler.js"
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
import {
  DurableStandupPublicationAuthorityStore,
  type StandupPublicationAuthorityRead,
  type StandupPublicationAuthorityRequestV1,
  type StandupPublicationCompanionLinkV1,
  type StandupPublicationCompanionPageV1,
  type StandupPublicationEventV1,
  type StandupPublicationGrantConsumptionV1,
  type StandupPublicationOutboxIntentV1,
  type StandupPublicationRecordV1,
  type PreparedStandupCompanionPage
} from "./standup-publication-collections.js"
import {
  StandupPublicationService,
  type CommittedPublication
} from "./standup-publication-service-live.js"
import {
  STANDUP_PRIVATE_REQUEST_VERSION,
  resolvePrivatePublicationIntent,
  type OpaqueStandupRunGrantToken,
  type ResolvedStandupRunGrantV1
} from "./standup-publication-private-contract.js"
import {
  AdmitWorkforceRunInput,
  DurableWorkforceRunReceiptStore,
  WorkforceRunAdmissionError,
  WorkforceRunConflictError,
  WORKFORCE_RUN_RECEIPT_VERSION,
  decodeWorkforceRunAdmission,
  grantForWorkforceAdmission,
  publicWorkforceReceipt,
  type WorkforceRunReceiptV1,
  type WorkforceRunReceiptOutputV1
} from "./workforce-run-authority.js"
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
/** Test-only seam for the crash window after the ledger transaction commits and before cache publication. */
export const pageProposalAcceptanceTestHook: { afterTransactionBeforePublish: (() => void) | undefined } = {
  afterTransactionBeforePublish: undefined
}

/** Test-only seam for page persistence preparation. Production leaves it unset; tests can throw
 * after a prepared page write has touched durable rows/index/feed but before the surrounding
 * `transactionSync` callback returns, proving cache and protocol-session publication stay deferred
 * until the transaction has committed. */
export const pagePersistenceTestHook: {
  afterPrepareBeforeCommit: (() => void) | undefined
  /** Runs after durable commit but before the candidate enters the in-memory cache. */
  afterTransactionBeforePublish: (() => void) | undefined
} = {
  afterPrepareBeforeCommit: undefined,
  afterTransactionBeforePublish: undefined
}

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

/** Test-only seam for exercising the narrow window after an employee stages a terminal result and
 * before the trusted workforce authority admits it. Production leaves it unset; a race test may
 * reclaim the exact runtime row here and prove that the old claim cannot publish. */
export const calendarConciergeAdmissionTestHook: {
  beforeAdmission?: (input: Readonly<{
    readonly workspaceId: string
    readonly runId: string
    readonly claimFence: number
    readonly leaseExpiresAt: string
    /** Reclaims a due/expired runtime row inside this DO; raw replacement tokens never escape. */
    readonly reclaimClaim: (now: Date, leaseMs: number) => Readonly<{
      readonly id: string
      readonly state: string
      readonly attempts: number
      readonly leaseExpiresAt: string | null
    }> | null
  }>) => Promise<void>
} = {}

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
  | LoroPageService
  | ChatForkService
  | AgentLoroEditService
  | PageProposalService
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

type StandupCompanionProjectionStatus =
  | "verified-original"
  | "modified"
  | "missing"
  | "unavailable"

/**
 * Companion integrity is evaluated against the current linked Loro page, never against the
 * immutable publication row or its stored companion copy. A missing page is a normal projection
 * state; malformed authority data is rejected by the durable reader before this function runs.
 */
const currentStandupCompanionStatus = (
  nodes: Context.Tag.Service<typeof NodesRepository>,
  loro: Context.Tag.Service<typeof LoroPageService>,
  row: StandupPublicationAuthorityRead,
  childNodeId: EntityId,
): Effect.Effect<StandupCompanionProjectionStatus> =>
  nodes.get(childNodeId).pipe(
    Effect.flatMap((node) =>
      node.workspaceId === row.publication.workspaceId
        ? loro.getText(childNodeId)
        : Effect.fail(new UnexpectedError({ message: "standup companion node belongs to another workspace" }))
    ),
    Effect.map((text): StandupCompanionProjectionStatus => {
      try {
        return canonicalStandupPublicationText(text).sha256 ===
          row.publication.originalTextDigest
          ? "verified-original"
          : "modified"
      } catch {
        return "unavailable"
      }
    }),
    Effect.catchAll((error) =>
      Effect.succeed(
        (error._tag === "NodeNotFound" || error._tag === "PageNotFound"
          ? "missing"
          : "unavailable") as StandupCompanionProjectionStatus,
      ),
    ),
  )

const projectStandupPublication = (
  nodes: Context.Tag.Service<typeof NodesRepository>,
  loro: Context.Tag.Service<typeof LoroPageService>,
  row: StandupPublicationAuthorityRead,
  workforceReceipt: WorkforceRunReceiptV1 | undefined,
): Effect.Effect<StandupPublication, UnexpectedError> =>
  Effect.gen(function* () {
    const resultKind = yield* Effect.try({
      try: () => {
        if (workforceReceipt === undefined) return undefined
        const publication = row.publication
        if (
          workforceReceipt.publicationId !== publication.publicationId ||
          workforceReceipt.workspaceId !== publication.workspaceId ||
          workforceReceipt.dailyNoteId !== publication.dailyNoteId ||
          workforceReceipt.civilDate !== publication.civilDate ||
          workforceReceipt.childNodeId !== publication.childNodeId ||
          workforceReceipt.committedAt !== publication.publishedAt ||
          workforceReceipt.resultSummary !== publication.originalText
        ) throw new Error("receipt does not bind to its publication")
        return workforceReceipt.resultKind
      },
      catch: () => new UnexpectedError({ message: "corrupt standup publication workforce receipt" }),
    })
    const childNodeId = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(EntityId)(row.publication.childNodeId),
      catch: (error) =>
        new UnexpectedError({
          message: `corrupt standup publication child node id: ${error instanceof Error ? error.message : String(error)}`,
        }),
    })
    const companionStatus = yield* currentStandupCompanionStatus(
      nodes,
      loro,
      row,
      childNodeId,
    )
    return yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(StandupPublication)({
          id: row.publication.publicationId,
          civilDate: row.publication.civilDate,
          microEmployeeLabel: row.publication.microEmployeeLabel,
          jobLabel: row.publication.jobLabel,
          workflowLabel: row.publication.workflowLabel,
          scheduleLabel: row.publication.scheduleLabel,
          microEmployee: row.publication.microEmployee,
          job: row.publication.job,
          workflow: row.publication.workflow,
          schedule: row.publication.schedule,
          councilRefs: row.publication.councilRefs,
          originalText: row.publication.originalText,
          publishedAt: row.publication.publishedAt,
          childNodeId,
          companionStatus,
          ...(resultKind === undefined ? {} : { resultKind }),
        }),
      catch: (error) =>
        new UnexpectedError({
          message: `corrupt standup publication projection: ${error instanceof Error ? error.message : String(error)}`,
        }),
    })
  })

/** Daily-note ids are deterministic from the civil date. Keep the same reserved UUID family as
 * the web client, but derive it from the validated server input so a caller cannot direct a
 * meeting preparation into an unrelated Loro page. */
const dailyNoteIdForLocalDate = (localDate: LocalDate): EntityId => {
  const suffix = localDate.replaceAll("-", "").padStart(12, "0")
  return Schema.decodeUnknownSync(EntityId)(`00000000-0000-4000-8000-${suffix}`)
}

const requireDailyNoteForLocalDate = (
  dailyNoteId: EntityId,
  localDate: LocalDate
): Effect.Effect<void, ValidationError> => {
  const expected = dailyNoteIdForLocalDate(localDate)
  return dailyNoteId === expected
    ? Effect.void
    : Effect.fail(new ValidationError({
      message: `dailyNoteId ${dailyNoteId} does not resolve to the requested localDate ${localDate}`
    }))
}

// `applySupertag` runs an existing GraphService effect inside a synchronous transaction. Preserve
// every closed domain failure emitted by that effect (for example NodeNotFound/TagNotFound) rather
// than reducing the graph's typed RPC contract to UnexpectedError at the ledger boundary.
const DOMAIN_ERROR_TAGS = new Set([
  "NodeNotFound", "NodeAlreadyExists", "ValidationError", "UnexpectedError", "PageNotFound", "PageFormatMismatch",
  "TagNotFound", "FactNotFound", "EdgeNotFound", "RelationDefinitionNotFound", "GraphIssueNotFound",
  "CardinalityViolation", "GraphIssueDetected", "ChatNotFound", "ChatBindingNotFound",
  "PendingNameConflict", "ToolNotImplemented", "Unauthorized", "WorkspaceAccessDenied",
  "WorkspaceNotFound", "GatekeeperNotConnected", "OAuthExchangeFailed", "ObserverVerificationFailed",
  "MeetingNotFound", "VoiceSessionNotFound", "WorkoutNotFound", "WorkoutImportConflict", "AppNotFound",
  "AppCodeVersionNotFound", "AppCodeTooLarge", "TagFieldDefinitionNotFound"
])

const isDomainError = (error: unknown): error is DomainError =>
  typeof error === "object" && error !== null &&
  typeof (error as { readonly _tag?: unknown })._tag === "string" &&
  DOMAIN_ERROR_TAGS.has((error as { readonly _tag: string })._tag)

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
  readonly #ledger: LedgerService
  readonly #storage: DurableObjectStorage
  readonly #standupPublicationStore: DurableStandupPublicationAuthorityStore
  readonly #workforceRunStore: DurableWorkforceRunReceiptStore

  constructor(
    runtime: ManagedRuntime.ManagedRuntime<WorkspaceServices, never>,
    collections: WorkspaceCollections,
    workspaceId: EntityId,
    sql: SqlStorage,
    currentUser: AuthenticatedUser | undefined,
    scheduleEviction: (emails: ReadonlyArray<string>, reason: string) => void,
    liveVoiceAudioSessions: Map<string, LiveVoiceAudioSessionHandle>,
    devAuthHmacSecret: string | undefined,
    storage: DurableObjectStorage,
    standupPublicationStore: DurableStandupPublicationAuthorityStore,
    workforceRunStore: DurableWorkforceRunReceiptStore
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
    this.#storage = storage
    this.#standupPublicationStore = standupPublicationStore
    this.#workforceRunStore = workforceRunStore
    this.#ledger = new LedgerService(sql)
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
    const storage = this.#storage
    const ledger = this.#ledger
    // This identity is deliberately per outer RPC invocation. The existing public input has no
    // caller retry key, so only an explicit node id can identify a separate client retry.
    const requestId = crypto.randomUUID()
    const program = decodeRpcInput(CreateNodeInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const repository = yield* NodesRepository
          const syncFeed = yield* SyncFeedService
          const sharing = yield* SharingService
          const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-open-v1" : "governed-role-v1"
          const principal = currentUser?.email ?? "anonymous"
          const requestIdentity = decoded.id === undefined ? `rpc:${requestId}` : `node:${decoded.id}`
          const command = {
            requestIdentity,
            requestId,
            workspaceId: decoded.workspaceId,
            principal,
            policy,
            title: decoded.title,
            payload: { id: decoded.id, title: decoded.title }
          }
          const fingerprint = ledgerFingerprint(command)
          return yield* Effect.try({
            try: () => storage.transactionSync(() => {
              const replay = ledger.existing(requestIdentity, fingerprint)
              if (replay !== undefined) return Schema.decodeUnknownSync(CreateNodeOutput)(replay.output)
              const node = new NodeEntity({
                id: decoded.id ?? Schema.decodeUnknownSync(EntityId)(crypto.randomUUID()),
                workspaceId: decoded.workspaceId,
                title: decoded.title,
                createdAt: Schema.decodeUnknownSync(IsoDateTimeString)(new Date().toISOString())
              })
              ledger.append({ ...command, fingerprint, createdAt: node.createdAt })
              const write = Effect.gen(function* () {
                const created = yield* repository.put(node)
                yield* upsertNode(sql, created)
                yield* indexNodeText(sql, created.id, created.title, "")
                yield* syncFeed.append("node", created.id, "put", created)
                return new CreateNodeOutput({ node: created })
              })
              const exit = Effect.runSyncExit(write)
              if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
              const output = exit.value
              ledger.appendOutboxIntent(requestIdentity, output.node.id)
              ledger.receipt(requestIdentity, fingerprint, Schema.encodeSync(CreateNodeOutput)(output))
              return output
            }),
            catch: (error): DomainError =>
              error instanceof LedgerConflict || error instanceof ValidationError
                ? new ValidationError({ message: error.message })
                : error instanceof Unauthorized || error instanceof UnexpectedError
                  ? error
                  : new UnexpectedError({ message: `ledgered createNode failed: ${error instanceof Error ? error.message : String(error)}` })
          })
        })
      )
    )

    return runRpcProgram(this.#runtime, program, CreateNodeOutput)
  }

  /** The strict node-creation boundary. Unlike the legacy createNode compatibility method,
   * this route requires an authenticated caller, an immutable rationale, and a stable retry key. */
  async createNodeWithIntent(input: unknown): Promise<unknown> {
    const sql = this.#sql
    const currentUser = this.#currentUser
    const storage = this.#storage
    const ledger = this.#ledger
    const program = decodeRpcInput(CreateNodeWithIntentInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => {
        if (currentUser === undefined) return Effect.fail(new Unauthorized({ message: "An authenticated user is required to create a workspace node." }))
        const title = decoded.title.trim().replace(/\s+/g, " ")
        const commitMessage = decoded.commitMessage.trim()
        const requestId = decoded.requestId.trim()
        if (title.length === 0) return Effect.fail(new ValidationError({ message: "A non-blank node title is required." }))
        if (commitMessage.length === 0) return Effect.fail(new ValidationError({ message: "A commit message is required to create a workspace node." }))
        if (requestId.length === 0) return Effect.fail(new ValidationError({ message: "A non-blank request id is required." }))
        const attribution: MutationAttribution = decoded.attribution.kind === "agentJob"
          ? new AgentJobMutationAttribution({
              version: decoded.attribution.version,
              kind: decoded.attribution.kind,
              jobId: decoded.attribution.jobId.trim(),
              runId: decoded.attribution.runId.trim()
            })
          : decoded.attribution.kind === "system"
            ? new SystemMutationAttribution({
                version: decoded.attribution.version,
                kind: decoded.attribution.kind,
                source: decoded.attribution.source.trim()
              })
            : new HumanUiMutationAttribution({
                version: decoded.attribution.version,
                kind: decoded.attribution.kind,
                surface: decoded.attribution.surface
              })
        if ((attribution.kind === "agentJob" && (attribution.jobId.length === 0 || attribution.runId.length === 0)) ||
            (attribution.kind === "system" && attribution.source.length === 0)) {
          return Effect.fail(new ValidationError({ message: "Attribution identifiers must contain non-whitespace text." }))
        }
        return Effect.gen(function* () {
          const repository = yield* NodesRepository
          const syncFeed = yield* SyncFeedService
          const sharing = yield* SharingService
          const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-authenticated-v1" : "governed-role-v1"
          const nodeId = decoded.id ?? Schema.decodeUnknownSync(EntityId)(crypto.randomUUID())
          const requestIdentity = `create-node-with-intent:${requestId}`
          const command: CreateNodeWithIntentLedgerCommandInput = {
            requestIdentity, requestId, workspaceId: decoded.workspaceId,
            principal: currentUser.email, policy, nodeId, requestedNodeId: decoded.id, title, commitMessage,
            attribution, fingerprint: "", createdAt: new Date().toISOString()
          }
          const fingerprint = createNodeWithIntentLedgerFingerprint(command)
          const ledgerCommand = { ...command, fingerprint }
          let created: NodeEntity | undefined
          return yield* Effect.try({
            try: () => storage.transactionSync(() => ledger.executeV2({
              requestIdentity, fingerprint, type: "createNodeWithIntent",
              mutate: () => {
                if (decoded.id !== undefined) {
                  const existing = Effect.runSyncExit(repository.get(nodeId))
                  if (Exit.isSuccess(existing)) throw new NodeAlreadyExists({ nodeId })
                  const error = domainErrorFromCause(existing.cause)
                  if (!(error instanceof NodeNotFound)) throw error
                }
                const node = new NodeEntity({ id: nodeId, workspaceId: decoded.workspaceId, title,
                  createdAt: Schema.decodeUnknownSync(IsoDateTimeString)(new Date().toISOString()) })
                const write = Effect.runSyncExit(repository.put(node))
                if (Exit.isFailure(write)) throw domainErrorFromCause(write.cause)
                const persisted = write.value
                const projections = Effect.runSyncExit(Effect.gen(function* () {
                  yield* upsertNode(sql, persisted)
                  yield* indexNodeText(sql, persisted.id, persisted.title, "")
                  yield* syncFeed.append("node", persisted.id, "put", persisted)
                }))
                if (Exit.isFailure(projections)) throw domainErrorFromCause(projections.cause)
                created = persisted
                return new CreateNodeOutput({ node: persisted })
              },
              encodeOutput: (output) => Schema.encodeSync(CreateNodeOutput)(output),
              decodeOutput: (output) => Schema.decodeUnknownSync(CreateNodeOutput)(output),
              appendCommand: () => ledger.appendCreateNodeWithIntent(ledgerCommand),
              appendSideEffects: () => {
                if (created === undefined) throw new Error("createNodeWithIntent completed without a node")
                const payload = { nodeId: created.id }
                ledger.appendEvent(requestIdentity, "create-node-with-intent", payload)
                ledger.appendOutbox(requestIdentity, "create-node-with-intent", payload)
              }
            })),
            catch: (error): DomainError => error instanceof LedgerConflict || error instanceof ValidationError
              ? new ValidationError({ message: error.message })
              : isDomainError(error) ? error : new UnexpectedError({ message: `ledgered createNodeWithIntent failed: ${error instanceof Error ? error.message : String(error)}` })
          })
        })
      })
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

  // --- Legacy page bodies (Automerge compatibility) -------------------------------------------

  // --- Versioned page-document routing (Loro migration) -------------------------------------

  async getPageDocumentDescriptor(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(GetPageDocumentDescriptorInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const loro = yield* LoroPageService
          return new GetPageDocumentDescriptorOutput({ descriptor: yield* loro.getDescriptor(decoded.nodeId) })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, GetPageDocumentDescriptorOutput)
  }

  /**
   * Read-only compatibility boundary for clients that intentionally do not link Automerge.
   * The authoritative server flattens the legacy document, returns the exact legacy witness,
   * and fails closed once the page has a Loro authority. Editing belongs to the migration route,
   * never to this projection.
   */
  async getLegacyPageProjection(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const storage = this.#storage
    const program = decodeRpcInput(GetLegacyPageProjectionInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const loro = yield* LoroPageService
          // Keep the witness and its flattened text inside one synchronous DO storage
          // transaction. Composing `getDescriptor` with NotesService's cached page read could
          // otherwise pair text from a later Automerge revision with an earlier witness.
          const projection = yield* Effect.try({
            try: () => storage.transactionSync(() => {
              const exit = Effect.runSyncExit(loro.getLegacyProjection(decoded.nodeId))
              if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
              return exit.value
            }),
            catch: (error): DomainError =>
              error instanceof PageNotFound || error instanceof PageFormatMismatch || error instanceof ValidationError || error instanceof UnexpectedError
                ? error
                : new UnexpectedError({ message: `legacy page projection transaction failed: ${String(error)}` })
          })
          return new GetLegacyPageProjectionOutput({
            ...projection,
            readOnly: true,
            migrationRequired: true
          })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, GetLegacyPageProjectionOutput)
  }

  /** Historical tombstone. It intentionally decodes nothing and cannot write caller-supplied
   * snapshots; clients must use `migrateLegacyPage`, which derives the target server-side. */
  async activateLoroPage(_input: unknown): Promise<unknown> {
    return runRpcProgram(
      this.#runtime,
      Effect.fail(new ValidationError({ message: "activateLoroPage is disabled; use migrateLegacyPage" })),
      Schema.Unknown
    )
  }

  async migrateLegacyPage(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const storage = this.#storage
    const ledger = this.#ledger
    const program = decodeRpcInput(MigrateLegacyPageInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => Effect.gen(function* () {
        if (currentUser === undefined) return yield* Effect.fail(new Unauthorized({ message: "An authenticated user is required to migrate a legacy page." }))
        if (decoded.intent.attribution.kind !== "humanUi") {
          return yield* Effect.fail(new ValidationError({ message: "Public page migrations require human UI attribution." }))
        }
        const sharing = yield* SharingService
        const loro = yield* LoroPageService
        const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-authenticated-v1" : "governed-role-v1"
        const requestIdentity = `migrate-legacy-page:${decoded.intent.requestId}`
        const base = { requestIdentity, requestId: decoded.intent.requestId, workspaceId: decoded.workspaceId, principal: currentUser.email, policy, nodeId: decoded.nodeId, sourceStorageVersion: decoded.expectedStorageVersion, sourceAutomerge: decoded.expectedAutomerge, schemaVersion: 1, commitMessage: decoded.intent.commitMessage, attribution: decoded.intent.attribution }
        const fingerprint = migrateLegacyPageLedgerFingerprint(base)
        const gateway = new WorkspaceLoroMutationGateway(ledger, loro, storage)
        const output = yield* Effect.try({
          try: () => storage.transactionSync(() => gateway.migrateLegacyWithinTransaction({
            requestIdentity,
            fingerprint,
            command: base,
            custody: {
              requestIdentity, fingerprint, type: "migrateLegacyPage", workspaceId: decoded.workspaceId,
              actorKind: "user", actorLabel: "You", targetKind: "node", targetId: decoded.nodeId
            },
            afterPrepareBeforeCommit: pagePersistenceTestHook.afterPrepareBeforeCommit
          })),
          catch: (error): DomainError => error instanceof LedgerConflict || error instanceof ValidationError ? new ValidationError({ message: error.message }) : error instanceof PageFormatMismatch || error instanceof UnexpectedError ? error : new UnexpectedError({ message: String(error) })
        })
        pagePersistenceTestHook.afterTransactionBeforePublish?.()
        output.finalize()
        return output.output
      }))
    )
    return runRpcProgram(this.#runtime, program, MigrateLegacyPageOutput)
  }

  /** Semantic, ledgered Loro ingress. Raw sync remains a separate transport path; this route
   * accepts a bounded update, persists only digest witnesses in the ledger, and never returns
   * CRDT bytes. */
  async commitLoroPageContent(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const storage = this.#storage
    const ledger = this.#ledger
    const program = decodeRpcInput(CommitLoroPageContentInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => {
        if (currentUser === undefined) return Effect.fail(new Unauthorized({ message: "An authenticated user is required to commit Loro content." }))
        // The public RPC is a human UI ingress. Employee/system custody is admitted only through
        // the same-worker workforce path, so callers cannot forge an employee actor on this wire.
        if (decoded.intent.attribution.kind !== "humanUi") {
          return Effect.fail(new ValidationError({ message: "Public Loro content commits require human UI attribution." }))
        }
        let baseVersionVectorSha256: string
        try { baseVersionVectorSha256 = loroVersionVectorIdentity(VersionVector.decode(decoded.expectedVersionVector)) } catch (error) {
          return Effect.fail(new ValidationError({ message: `invalid expected Loro version vector: ${String(error)}` }))
        }
        const updateSha256 = sha256HexSync(decoded.update)
        return Effect.gen(function* () {
          const sharing = yield* SharingService
          const loro = yield* LoroPageService
          const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-authenticated-v1" : "governed-role-v1"
          const requestIdentity = `commit-loro-page-content:${decoded.intent.requestId}`
          const base = {
            requestIdentity, requestId: decoded.intent.requestId, workspaceId: decoded.workspaceId, principal: currentUser.email, policy,
            nodeId: decoded.nodeId, expectedStorageVersion: decoded.expectedStorageVersion, expectedSnapshotSha256: decoded.expectedSnapshotSha256,
            baseVersionVectorSha256, updateSha256, updateLength: decoded.update.length,
            commitMessage: decoded.intent.commitMessage, attribution: decoded.intent.attribution
          }
          const fingerprint = commitLoroPageContentLedgerFingerprint(base)
          const gateway = new WorkspaceLoroMutationGateway(ledger, loro, storage)
          const committed = yield* Effect.try({
            try: () => storage.transactionSync(() => gateway.commitContentWithinTransaction({
              requestIdentity,
              fingerprint,
              command: base,
              custody: {
                requestIdentity, fingerprint, type: "commitLoroPageContent", workspaceId: decoded.workspaceId,
                actorKind: "user", actorLabel: "You", targetKind: "node", targetId: decoded.nodeId
              },
              expectedVersionVector: decoded.expectedVersionVector,
              update: decoded.update,
              afterPrepareBeforeCommit: pagePersistenceTestHook.afterPrepareBeforeCommit
            })),
            catch: (error): DomainError => error instanceof LoroContentConflict
              ? error
              : error instanceof LedgerConflict
                ? new LoroRequestIdentityConflict({ nodeId: decoded.nodeId, requestId: decoded.intent.requestId })
              : error instanceof ValidationError
                ? new ValidationError({ message: error.message })
              : isDomainError(error) ? error : new UnexpectedError({ message: `ledgered Loro content commit failed: ${error instanceof Error ? error.message : String(error)}` })
          })
          // The gateway returns a cache finalizer; run it only after the outer transaction has
          // committed so rollback cannot publish a candidate that never reached durable storage.
          pagePersistenceTestHook.afterTransactionBeforePublish?.()
          committed.finalize()
          return committed.output
        })
      })
    )
    return runRpcProgram(this.#runtime, program, CommitLoroPageContentOutput)
  }

  /** Server-derived, idempotent meeting-preparation insertion. The occurrence key is opaque and
   * all durable content changes remain inside this ledger transaction; no raw CRDT bytes are
   * accepted or returned by the RPC. */
  async prepareMeetingInDailyNote(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const storage = this.#storage
    const ledger = this.#ledger
    const program = decodeRpcInput(PrepareMeetingInDailyNoteInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap((decoded) => requireDailyNoteForLocalDate(decoded.dailyNoteId, decoded.localDate)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => Effect.gen(function* () {
        if (currentUser === undefined) return yield* Effect.fail(new Unauthorized({ message: "An authenticated user is required to prepare a meeting." }))
        if (decoded.intent.attribution.kind !== "humanUi") {
          return yield* Effect.fail(new ValidationError({ message: "Public meeting preparation requires human UI attribution." }))
        }
        const sharing = yield* SharingService
        const calendar = yield* CalendarService
        const loro = yield* LoroPageService
        const resolvedWindow = resolveTodayBriefWindow(decoded.localDate, decoded.timeZone)
        const meeting = yield* calendar.findTodayBriefEvent(decoded.workspaceId, decoded.localDate, decoded.timeZone, decoded.occurrenceKey, currentUser.email)
        if (meeting === undefined) return yield* Effect.fail(new ValidationError({ message: "The meeting is no longer present in the retained calendar projection." }))
        const attendeeNames = meeting.people.flatMap((person) => person.displayName === undefined ? [] : [person.displayName])
        const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-authenticated-v1" : "governed-role-v1"
        // The event/date/page/time-zone tuple is the durable operation identity. A retried UI
        // request may mint a new transport request id (or arrive from the other client), but it
        // must still replay the same preparation rather than append another block.
        const requestIdentity = `prepare-meeting-in-daily-note:${decoded.workspaceId}:${decoded.dailyNoteId}:${decoded.localDate}:${resolvedWindow.timeZone}:${decoded.occurrenceKey}`
        const base = { requestIdentity, requestId: decoded.intent.requestId, workspaceId: decoded.workspaceId, principal: currentUser.email, policy, nodeId: decoded.dailyNoteId, localDate: decoded.localDate, timeZone: resolvedWindow.timeZone, occurrenceKey: decoded.occurrenceKey, commitMessage: decoded.intent.commitMessage, attribution: decoded.intent.attribution }
        const fingerprint = prepareMeetingInDailyNoteLedgerFingerprint(base)
        const gateway = new WorkspaceLoroMutationGateway(ledger, loro, storage)
        const output = yield* Effect.try({
          try: () => storage.transactionSync(() => gateway.prepareMeetingWithinTransaction({
            requestIdentity,
            fingerprint,
            command: base,
            custody: {
              requestIdentity, fingerprint, type: "prepareMeetingInDailyNote", workspaceId: decoded.workspaceId,
              actorKind: "user", actorLabel: "You", targetKind: "node", targetId: decoded.dailyNoteId
            },
            attendeeNames,
            afterPrepareBeforeCommit: pagePersistenceTestHook.afterPrepareBeforeCommit
          })),
          catch: (error): DomainError => error instanceof LedgerConflict ? new LoroRequestIdentityConflict({ nodeId: decoded.dailyNoteId, requestId: decoded.intent.requestId }) : error instanceof ValidationError || isDomainError(error) ? error : new UnexpectedError({ message: `ledgered meeting preparation failed: ${error instanceof Error ? error.message : String(error)}` })
        })
        pagePersistenceTestHook.afterTransactionBeforePublish?.()
        output.finalize()
        return output.output
      }))
    )
    return runRpcProgram(this.#runtime, program, PrepareMeetingInDailyNoteOutput)
  }

  async startLoroPageSync(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(StartLoroPageSyncInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const loro = yield* LoroPageService
          const result = yield* loro.startSync(decoded.nodeId, decoded.sessionId)
          return new StartLoroPageSyncOutput({
            sessionId: decoded.sessionId,
            message: result.message,
            serverVersion: result.serverVersion
          })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, StartLoroPageSyncOutput)
  }

  async loroPageSyncMessage(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const storage = this.#storage
    const program = decodeRpcInput(LoroPageSyncMessageInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      // Raw sync is retained solely for empty convergence/reset frames. Content-bearing
      // updates must cross the authenticated, attributed semantic ledger boundary.
      Effect.tap((decoded) =>
        decoded.update.byteLength > 0
          ? Effect.fail(new LoroSemanticCommitRequired({ nodeId: decoded.nodeId }))
          : Effect.void
      ),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const loro = yield* LoroPageService
          const prepared = yield* Effect.try({
            try: () =>
              storage.transactionSync(() => {
                const exit = Effect.runSyncExit(
                  loro.receiveSyncMessage(
                    decoded.nodeId,
                    decoded.sessionId,
                    decoded.ordinal,
                    decoded.update,
                    decoded.clientVersion
                  )
                )
                if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
                pagePersistenceTestHook.afterPrepareBeforeCommit?.()
                return exit.value
              }),
            catch: (error): DomainError =>
              error instanceof PageNotFound || error instanceof PageFormatMismatch || error instanceof ValidationError || error instanceof UnexpectedError
                ? error
                : new UnexpectedError({ message: `Loro page sync transaction failed: ${String(error)}` })
          })
          // The prepared result bundles Loro cache publication and session advancement. Publish
          // only after the transaction has committed, and do it once as one synchronous step.
          prepared.commit()
          const result = prepared.result
          return new LoroPageSyncMessageOutput({
            sessionId: decoded.sessionId,
            ordinal: decoded.ordinal,
            update: result.update,
            serverVersion: result.serverVersion,
            converged: result.converged,
            reset: result.reset
          })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, LoroPageSyncMessageOutput)
  }

  /** Native product-page creation. This is deliberately separate from `createPage`, which remains
   * the legacy Automerge compatibility RPC for native clients and explicit migrations. */
  async createLoroPage(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const storage = this.#storage
    const ledger = this.#ledger
    const program = decodeRpcInput(CreateLoroPageInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => {
        // Unlike the older direct page route, provenance is mandatory even for an ungoverned
        // workspace. The role helper deliberately preserves ungoverned compatibility elsewhere;
        // this ledgered command does not treat anonymous as an authority principal.
        if (currentUser === undefined) {
          return Effect.fail(new Unauthorized({ message: "An authenticated user is required to ensure a Loro page." }))
        }
        if (decoded.creationIntent.attribution.kind !== "humanUi") {
          return Effect.fail(new ValidationError({ message: "Public Loro page creation requires human UI attribution." }))
        }
        // `CreationIntent.requestId` was canonicalized exactly once by its public wire schema.
        // Keep that decoded value intact through identity, fingerprint, persisted payload, and
        // replay lookup; a second normalization point would make retries ambiguous.
        const requestId = decoded.creationIntent.requestId
        const commitMessage = decoded.creationIntent.commitMessage.trim()
        if (commitMessage.length === 0) {
          return Effect.fail(new ValidationError({ message: "A non-blank commit message is required to ensure a Loro page." }))
        }
        return Effect.gen(function* () {
          const sharing = yield* SharingService
          const loro = yield* LoroPageService
          const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-authenticated-v1" : "governed-role-v1"
          const requestIdentity = `ensure-loro-page:${requestId}`
          const base = {
            requestIdentity, requestId, workspaceId: decoded.workspaceId,
            principal: currentUser.email, policy, nodeId: decoded.nodeId,
            commitMessage, attribution: decoded.creationIntent.attribution
          }
          const fingerprint = ensureLoroPageLedgerFingerprint(base)
          const gateway = new WorkspaceLoroMutationGateway(ledger, loro, storage)
          const committed = yield* Effect.try({
            try: () => storage.transactionSync(() => gateway.ensurePageWithinTransaction({
              requestIdentity,
              fingerprint,
              command: base,
              custody: {
                requestIdentity, fingerprint, type: "ensureLoroPage", workspaceId: decoded.workspaceId,
                actorKind: "user", actorLabel: "You", targetKind: "node", targetId: decoded.nodeId
              },
              afterPrepareBeforeCommit: pagePersistenceTestHook.afterPrepareBeforeCommit
            })),
            catch: (error): DomainError => error instanceof LedgerConflict || error instanceof ValidationError
              ? new ValidationError({ message: error.message })
              : isDomainError(error) ? error : new UnexpectedError({ message: `ledgered ensureLoroPage failed: ${error instanceof Error ? error.message : String(error)}` })
          })
          pagePersistenceTestHook.afterTransactionBeforePublish?.()
          committed.finalize()
          return committed.output
        })
      })
    )
    return runRpcProgram(this.#runtime, program, CreateLoroPageOutput)
  }

  async createPage(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const storage = this.#storage
    const program = decodeRpcInput(CreatePageInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const notes = yield* NotesService
          const prepared = yield* Effect.try({
            try: () => storage.transactionSync(() => {
              const exit = Effect.runSyncExit(notes.prepareCreatePage(decoded.nodeId))
              if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
              pagePersistenceTestHook.afterPrepareBeforeCommit?.()
              return exit.value
            }),
            catch: (error): DomainError =>
              error instanceof NodeNotFound || error instanceof PageNotFound || error instanceof PageFormatMismatch || error instanceof ValidationError || error instanceof UnexpectedError
                ? error
                : new UnexpectedError({ message: `page creation transaction failed: ${String(error)}` })
          })
          prepared.commit()
          return new CreatePageOutput({ page: prepared.page, text: prepared.text })
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
    const storage = this.#storage
    const program = decodeRpcInput(ApplyPageEditInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const notes = yield* NotesService
          const prepared = yield* Effect.try({
            try: () => storage.transactionSync(() => {
              const exit = Effect.runSyncExit(notes.prepareApplyLocalEdit(
                decoded.nodeId,
                decoded.index,
                decoded.deleteCount,
                decoded.insertText
              ))
              if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
              pagePersistenceTestHook.afterPrepareBeforeCommit?.()
              return exit.value
            }),
            catch: (error): DomainError =>
              error instanceof PageNotFound || error instanceof PageFormatMismatch || error instanceof ValidationError || error instanceof UnexpectedError
                ? error
                : new UnexpectedError({ message: `page edit transaction failed: ${String(error)}` })
          })
          prepared.commit()
          return new ApplyPageEditOutput({ page: prepared.page, text: prepared.text })
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
    const storage = this.#storage
    const program = decodeRpcInput(PageSyncMessageInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const notes = yield* NotesService
          const prepared = yield* Effect.try({
            try: () => storage.transactionSync(() => {
              const exit = Effect.runSyncExit(notes.prepareReceiveSyncMessage(
                decoded.nodeId,
                decoded.sessionId,
                decoded.ordinal,
                decoded.message
              ))
              if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
              pagePersistenceTestHook.afterPrepareBeforeCommit?.()
              return exit.value
            }),
            catch: (error): DomainError =>
              error instanceof PageNotFound || error instanceof PageFormatMismatch || error instanceof ValidationError || error instanceof UnexpectedError
                ? error
                : new UnexpectedError({ message: `page sync transaction failed: ${String(error)}` })
          })
          prepared.commit()
          const result = prepared.result
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

  // --- Durable page proposals ---------------------------------------------------------------
  // The raw page APIs above remain intentionally direct. These reviewable proposals are the
  // separate, ledger-routed mutation path; acceptance alone can publish a proposed page edit.
  async proposePageEdit(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ProposePageEditInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => PageProposalService.pipe(
        Effect.flatMap((service) => service.propose(decoded)),
        Effect.map((proposal) => new ProposePageEditOutput({ proposal }))
      ))
    )
    return runRpcProgram(this.#runtime, program, ProposePageEditOutput)
  }

  async previewPageProposal(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(PreviewPageProposalInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) => PageProposalService.pipe(
        Effect.flatMap((service) => service.preview(decoded.proposalId)),
        Effect.map(({ proposal, text }) => new PreviewPageProposalOutput({ proposal, text }))
      ))
    )
    return runRpcProgram(this.#runtime, program, PreviewPageProposalOutput)
  }

  async acceptPageProposal(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const ledger = this.#ledger
    const storage = this.#storage
    const program = decodeRpcInput(AcceptPageProposalInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => Effect.gen(function* () {
        const service = yield* PageProposalService
        const sharing = yield* SharingService
        const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-open-v1" : "governed-role-v1"
        const result = yield* Effect.try({
          try: () => storage.transactionSync(() => {
            const exit = Effect.runSyncExit(service.accept(decoded.proposalId))
            if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
            const accepted = exit.value
            ledger.appendAcceptedPageProposal({
              proposalId: accepted.proposal.proposalId, nodeId: accepted.proposal.nodeId, workspaceId: decoded.workspaceId,
              principal: currentUser?.email ?? "anonymous", policy, rationale: accepted.proposal.rationale,
              provenance: accepted.proposal.provenance, input: { proposalId: decoded.proposalId },
              result: { headsHash: accepted.commit.committedHeadsHash, proposalHeadsHash: accepted.proposal.proposalHeadsHash },
              createdAt: accepted.commit.committedAt
            })
            return accepted
          }),
          catch: (error): DomainError => error instanceof ValidationError || error instanceof UnexpectedError ? error : new UnexpectedError({ message: String(error) })
        })
        pageProposalAcceptanceTestHook.afterTransactionBeforePublish?.()
        result.publish()
        return new AcceptPageProposalOutput(result)
      }))
    )
    return runRpcProgram(this.#runtime, program, AcceptPageProposalOutput)
  }

  async revertPageProposal(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(RevertPageProposalInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => PageProposalService.pipe(
        Effect.flatMap((service) => service.revert(decoded.proposalId)),
        Effect.map((proposal) => new RevertPageProposalOutput({ proposal }))
      ))
    )
    return runRpcProgram(this.#runtime, program, RevertPageProposalOutput)
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
    const ledger = this.#ledger
    const storage = this.#storage
    const program = decodeRpcInput(AcceptChatForkInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const chatFork = yield* ChatForkService
          const proposal = yield* chatFork.proposalForAcceptance(decoded.chatId, decoded.nodeId)
          const sharing = yield* SharingService
          const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-open-v1" : "governed-role-v1"
          const accepted = yield* Effect.try({
            try: () => storage.transactionSync(() => {
              const exit = Effect.runSyncExit(chatFork.accept(proposal.proposalId))
              if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
              const result = exit.value
              ledger.appendAcceptedChatFork({
                proposalId: proposal.proposalId, nodeId: decoded.nodeId, workspaceId: decoded.workspaceId, principal: currentUser?.email ?? "anonymous", policy,
                rationale: proposal.rationale, provenance: proposal.provenance, input: { chatId: decoded.chatId, nodeId: decoded.nodeId },
                result: { headsHash: result.page.headsHash, proposalHeadsHash: proposal.proposalHeadsHash }, createdAt: proposal.updatedAt
              })
              return result
            }),
            catch: (error): DomainError => error instanceof ValidationError || error instanceof UnexpectedError ? error : new UnexpectedError({ message: String(error) })
          })
          accepted.publish()
          return new AcceptChatForkOutput({ page: accepted.page, text: accepted.text })
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
    const storage = this.#storage
    const ledger = this.#ledger
    const program = decodeRpcInput(CreateTagInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => {
        if (currentUser === undefined) {
          return Effect.fail(new Unauthorized({ message: "An authenticated user is required to create a Supertag definition." }))
        }
        const name = normalizeCreateTagName(decoded.name)
        if (name.length === 0) {
          return Effect.fail(new ValidationError({ message: "A non-blank Supertag name is required." }))
        }
        const commitMessage = decoded.commitMessage.trim()
        if (commitMessage.length === 0) {
          return Effect.fail(new ValidationError({ message: "A commit message is required to create a Supertag definition." }))
        }
        return Effect.gen(function* () {
          const graph = yield* GraphService
          const sharing = yield* SharingService
          const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-authenticated-v1" : "governed-role-v1"
          const requestIdentity = `create-tag:${decoded.requestId}`
          const command: CreateTagLedgerCommandInput = {
            requestIdentity,
            requestId: decoded.requestId,
            workspaceId: decoded.workspaceId,
            principal: currentUser.email,
            policy,
            name,
            parentIds: decoded.parentIds,
            commitMessage,
            attribution: decoded.attribution,
            fingerprint: "",
            createdAt: new Date().toISOString()
          }
          const fingerprint = createTagLedgerFingerprint(command)
          const ledgerCommand = { ...command, fingerprint }
          let tagId: string | undefined
          return yield* Effect.try({
            try: () => storage.transactionSync(() => ledger.executeV2({
              requestIdentity,
              fingerprint,
              type: "createTag",
              mutate: () => {
                const exit = Effect.runSyncExit(graph.createTag(decoded.workspaceId, name, decoded.parentIds))
                if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
                tagId = exit.value.id
                return new CreateTagOutput({ tag: exit.value })
              },
              encodeOutput: (output) => Schema.encodeSync(CreateTagOutput)(output),
              decodeOutput: (output) => Schema.decodeUnknownSync(CreateTagOutput)(output),
              appendCommand: () => ledger.appendCreateTag(ledgerCommand),
              appendSideEffects: () => {
                if (tagId === undefined) throw new Error("createTag completed without a tag identity")
                const payload = { tagId, name, parentIds: decoded.parentIds }
                ledger.appendEvent(requestIdentity, "create-tag", payload)
                ledger.appendOutbox(requestIdentity, "create-tag", payload)
              }
            })),
            catch: (error): DomainError => error instanceof LedgerConflict || error instanceof ValidationError
              ? new ValidationError({ message: error.message })
              : isDomainError(error) ? error : new UnexpectedError({ message: `ledgered createTag failed: ${error instanceof Error ? error.message : String(error)}` })
          })
        })
      })
    )
    return runRpcProgram(this.#runtime, program, CreateTagOutput)
  }

  /** The only externally reachable Supertag update route. It derives authority, creates the
   * ledger-bound capability, and performs the projection inside one WorkspaceDO transaction. */
  async updateTag(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const storage = this.#storage
    const ledger = this.#ledger
    const program = decodeRpcInput(UpdateTagInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => {
        if (currentUser === undefined) return Effect.fail(new Unauthorized({ message: "An authenticated user is required to update a Supertag definition." }))
        const name = normalizeTagName(decoded.name)
        const commitMessage = decoded.commitMessage.trim()
        if (name.length === 0 || commitMessage.length === 0) return Effect.fail(new ValidationError({ message: "A name and commit message are required to update a Supertag definition." }))
        return Effect.gen(function* () {
          const graph = yield* GraphService
          const sharing = yield* SharingService
          const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-authenticated-v1" : "governed-role-v1"
          const requestIdentity = `update-tag:${decoded.requestId}`
          const command: UpdateTagLedgerCommandInput = {
            requestIdentity, requestId: decoded.requestId, workspaceId: decoded.workspaceId, principal: currentUser.email, policy,
            tagId: decoded.tagId, expectedRevision: decoded.expectedRevision, name, parentIds: decoded.parentIds,
            commitMessage, attribution: decoded.attribution, fingerprint: "", createdAt: new Date().toISOString()
          }
          const fingerprint = updateTagLedgerFingerprint(command)
          const ledgerCommand = { ...command, fingerprint }
          const scope = { type: "updateTag", workspaceId: decoded.workspaceId, targetKind: "tag", targetId: decoded.tagId, fingerprint } as const
          return yield* Effect.try({
            try: () => storage.transactionSync(() => ledger.executeV2({
              requestIdentity, fingerprint, type: "updateTag",
              mutationScope: { workspaceId: decoded.workspaceId, targetKind: "tag", targetId: decoded.tagId },
              mutate: (capability) => {
                const exit = Effect.runSyncExit(graph.updateTag(capability, scope, decoded.workspaceId, decoded.tagId, decoded.expectedRevision, name, decoded.parentIds))
                if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
                return new UpdateTagOutput({ tag: new TagRead({ tag: exit.value, revision: tagRevision(exit.value) }) })
              },
              encodeOutput: (output) => Schema.encodeSync(UpdateTagOutput)(output),
              decodeOutput: (output) => Schema.decodeUnknownSync(UpdateTagOutput)(output),
              appendCommand: () => ledger.appendUpdateTag(ledgerCommand),
              appendCustody: () => ledger.appendCustody({
                requestIdentity, fingerprint, type: "updateTag", workspaceId: decoded.workspaceId,
                actorKind: "user", actorLabel: "You", targetKind: "tag", targetId: decoded.tagId
              }),
              validateReplayCustody: () => ledger.validateCustody({
                requestIdentity, fingerprint, type: "updateTag", workspaceId: decoded.workspaceId,
                actorKind: "user", actorLabel: "You", targetKind: "tag", targetId: decoded.tagId
              }),
              appendSideEffects: () => {
                const payload = { tagId: decoded.tagId, revision: tagRevision({ id: decoded.tagId, name, parentIds: decoded.parentIds }) }
                ledger.appendEvent(requestIdentity, "update-tag", payload)
                ledger.appendOutbox(requestIdentity, "update-tag", payload)
              }
            })),
            catch: (error): DomainError => error instanceof LedgerConflict || error instanceof ValidationError
              ? new ValidationError({ message: error.message })
              : isDomainError(error) ? error : new UnexpectedError({ message: `ledgered updateTag failed: ${error instanceof Error ? error.message : String(error)}` })
          })
        })
      })
    )
    return runRpcProgram(this.#runtime, program, UpdateTagOutput)
  }

  async getTag(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(GetTagInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) => Effect.gen(function* () {
        const graph = yield* GraphService
        const tag = (yield* graph.listTags(decoded.workspaceId)).find((candidate) => candidate.id === decoded.tagId)
        if (tag === undefined) return yield* Effect.fail(new ValidationError({ message: "Supertag not found." }))
        return new GetTagOutput({ tag: new TagRead({ tag, revision: tagRevision(tag) }) })
      }))
    )
    return runRpcProgram(this.#runtime, program, GetTagOutput)
  }

  async addFact(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const storage = this.#storage
    const ledger = this.#ledger
    const program = decodeRpcInput(AddFactInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => {
        if (currentUser === undefined) return Effect.fail(new Unauthorized({ message: "An authenticated user is required to update a workspace fact." }))
        const commitMessage = decoded.commitMessage.trim()
        if (commitMessage.length === 0) return Effect.fail(new ValidationError({ message: "A commit message is required to update a workspace fact." }))
        return Effect.gen(function* () {
          const graph = yield* GraphService
          const sharing = yield* SharingService
          const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-authenticated-v1" : "governed-role-v1"
          const requestIdentity = `add-fact:${decoded.requestId}`
          const command: AddFactLedgerCommandInput = {
            requestIdentity, requestId: decoded.requestId, workspaceId: decoded.workspaceId, principal: currentUser.email, policy,
            nodeId: decoded.nodeId, predicateId: decoded.predicateId, value: decoded.value, ...(decoded.id === undefined ? {} : { factId: decoded.id }),
            commitMessage, attribution: decoded.attribution, fingerprint: "", createdAt: new Date().toISOString()
          }
          const fingerprint = addFactLedgerFingerprint(command)
          const ledgerCommand = { ...command, fingerprint }
          let committedFactId: string | undefined
          return yield* Effect.try({
            try: () => storage.transactionSync(() => ledger.executeV2({
              requestIdentity, fingerprint, type: "addFact",
              mutate: () => {
                const exit = Effect.runSyncExit(graph.addFact(decoded.workspaceId, decoded.nodeId, decoded.predicateId, decoded.value, decoded.id))
                if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
                committedFactId = exit.value.id
                return new AddFactOutput({ fact: exit.value })
              },
              encodeOutput: (output) => Schema.encodeSync(AddFactOutput)(output),
              decodeOutput: (output) => Schema.decodeUnknownSync(AddFactOutput)(output),
              appendCommand: () => ledger.appendAddFact(ledgerCommand),
              appendSideEffects: () => {
                const payload = { factId: committedFactId }
                ledger.appendEvent(requestIdentity, "add-fact", payload)
                ledger.appendOutbox(requestIdentity, "add-fact", payload)
              }
            })),
            catch: (error): DomainError => error instanceof LedgerConflict || error instanceof ValidationError
              ? new ValidationError({ message: error.message })
              : isDomainError(error) ? error : new UnexpectedError({ message: `ledgered addFact failed: ${error instanceof Error ? error.message : String(error)}` })
          })
        })
      })
    )
    return runRpcProgram(this.#runtime, program, AddFactOutput)
  }

  async createRelationDefinition(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const storage = this.#storage
    const ledger = this.#ledger
    const program = decodeRpcInput(CreateRelationDefinitionInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => {
        if (currentUser === undefined) {
          return Effect.fail(new Unauthorized({ message: "An authenticated user is required to create a relation definition." }))
        }
        const commitMessage = decoded.commitMessage.trim()
        if (commitMessage.length === 0) {
          return Effect.fail(new ValidationError({ message: "A commit message is required to create a relation definition." }))
        }
        return Effect.gen(function* () {
          const graph = yield* GraphService
          const sharing = yield* SharingService
          const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-authenticated-v1" : "governed-role-v1"
          const requestIdentity = `create-relation-definition:${decoded.requestId}`
          const command: CreateRelationDefinitionLedgerCommandInput = {
            requestIdentity,
            requestId: decoded.requestId,
            workspaceId: decoded.workspaceId,
            principal: currentUser.email,
            policy,
            forwardName: decoded.forwardName,
            inverseName: decoded.inverseName,
            sourceTagId: decoded.sourceTagId,
            targetTagId: decoded.targetTagId,
            cardinality: decoded.cardinality,
            commitMessage,
            attribution: decoded.attribution,
            fingerprint: "",
            createdAt: new Date().toISOString()
          }
          const fingerprint = createRelationDefinitionLedgerFingerprint(command)
          let relationDefinitionId: string | undefined
          return yield* Effect.try({
            try: () => storage.transactionSync(() => ledger.executeV2({
              requestIdentity,
              fingerprint,
              type: "createRelationDefinition",
              mutate: () => {
                const exit = Effect.runSyncExit(graph.createRelationDefinition(
                  decoded.workspaceId,
                  decoded.forwardName,
                  decoded.inverseName,
                  decoded.sourceTagId,
                  decoded.targetTagId,
                  decoded.cardinality
                ))
                if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
                relationDefinitionId = exit.value.id
                return new CreateRelationDefinitionOutput({ relationDefinition: exit.value })
              },
              encodeOutput: (output) => Schema.encodeSync(CreateRelationDefinitionOutput)(output),
              decodeOutput: (output) => Schema.decodeUnknownSync(CreateRelationDefinitionOutput)(output),
              appendCommand: () => {
                if (relationDefinitionId === undefined) throw new Error("createRelationDefinition completed without an identity")
                ledger.appendCreateRelationDefinition({ ...command, fingerprint }, relationDefinitionId)
              },
              appendSideEffects: () => {
                if (relationDefinitionId === undefined) throw new Error("createRelationDefinition completed without an identity")
                const payload = {
                  relationDefinitionId,
                  forwardName: decoded.forwardName,
                  inverseName: decoded.inverseName,
                  sourceTagId: decoded.sourceTagId,
                  targetTagId: decoded.targetTagId,
                  cardinality: decoded.cardinality
                }
                ledger.appendEvent(requestIdentity, "create-relation-definition", payload)
                ledger.appendOutbox(requestIdentity, "create-relation-definition", payload)
              }
            })),
            catch: (error): DomainError => error instanceof LedgerConflict || error instanceof ValidationError
              ? new ValidationError({ message: error.message })
              : isDomainError(error) ? error : new UnexpectedError({ message: `ledgered createRelationDefinition failed: ${error instanceof Error ? error.message : String(error)}` })
          })
        })
      })
    )
    return runRpcProgram(this.#runtime, program, CreateRelationDefinitionOutput)
  }

  async createEdge(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const storage = this.#storage
    const ledger = this.#ledger
    const program = decodeRpcInput(CreateEdgeInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => {
        if (currentUser === undefined) {
          return Effect.fail(new Unauthorized({ message: "An authenticated user is required to create a workspace relationship." }))
        }
        const commitMessage = decoded.commitMessage.trim()
        if (commitMessage.length === 0) {
          return Effect.fail(new ValidationError({ message: "A commit message is required to create a workspace relationship." }))
        }
        return Effect.gen(function* () {
          const graph = yield* GraphService
          const sharing = yield* SharingService
          const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-authenticated-v1" : "governed-role-v1"
          const requestIdentity = `create-edge:${decoded.requestId}`
          const command: CreateEdgeLedgerCommandInput = {
            requestIdentity,
            requestId: decoded.requestId,
            workspaceId: decoded.workspaceId,
            principal: currentUser.email,
            policy,
            relationDefinitionId: decoded.relationDefinitionId,
            sourceNodeId: decoded.sourceNodeId,
            targetNodeId: decoded.targetNodeId,
            commitMessage,
            attribution: decoded.attribution,
            fingerprint: "",
            createdAt: new Date().toISOString()
          }
          const fingerprint = createEdgeLedgerFingerprint(command)
          const ledgerCommand = { ...command, fingerprint }
          let edgeId: string | undefined
          return yield* Effect.try({
            try: () => storage.transactionSync(() => ledger.executeV2({
              requestIdentity,
              fingerprint,
              type: "createEdge",
              mutate: () => {
                const exit = Effect.runSyncExit(graph.createEdge(
                  decoded.workspaceId,
                  decoded.relationDefinitionId,
                  decoded.sourceNodeId,
                  decoded.targetNodeId
                ))
                if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
                edgeId = exit.value.id
                return new CreateEdgeOutput({ edge: exit.value })
              },
              encodeOutput: (output) => Schema.encodeSync(CreateEdgeOutput)(output),
              decodeOutput: (output) => Schema.decodeUnknownSync(CreateEdgeOutput)(output),
              appendCommand: () => ledger.appendCreateEdge(ledgerCommand),
              appendSideEffects: () => {
                if (edgeId === undefined) throw new Error("createEdge completed without an edge identity")
                const payload = {
                  edgeId,
                  relationDefinitionId: decoded.relationDefinitionId,
                  sourceNodeId: decoded.sourceNodeId,
                  targetNodeId: decoded.targetNodeId
                }
                ledger.appendEvent(requestIdentity, "create-edge", payload)
                ledger.appendOutbox(requestIdentity, "create-edge", payload)
              }
            })),
            catch: (error): DomainError => error instanceof LedgerConflict || error instanceof ValidationError
              ? new ValidationError({ message: error.message })
              : isDomainError(error) ? error : new UnexpectedError({ message: `ledgered createEdge failed: ${error instanceof Error ? error.message : String(error)}` })
          })
        })
      })
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
    const storage = this.#storage
    const ledger = this.#ledger
    const program = decodeRpcInput(SyncNoteReferencesInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => {
        if (currentUser === undefined) {
          return Effect.fail(new Unauthorized({ message: "An authenticated user is required to reconcile note mentions." }))
        }
        const referencedNodeIds = [...new Set(decoded.referencedNodeIds)].sort()
        const commitMessage = decoded.commitMessage.trim()
        if (commitMessage.length === 0) {
          return Effect.fail(new ValidationError({ message: "A commit message is required to reconcile note mentions." }))
        }
        return Effect.gen(function* () {
          const graph = yield* GraphService
          const sharing = yield* SharingService
          const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-authenticated-v1" : "governed-role-v1"
          const requestIdentity = `sync-note-references:${decoded.requestId}`
          const command: SyncNoteReferencesLedgerCommandInput = {
            requestIdentity,
            requestId: decoded.requestId,
            workspaceId: decoded.workspaceId,
            principal: currentUser.email,
            policy,
            nodeId: decoded.nodeId,
            referencedNodeIds,
            created: [],
            removed: [],
            commitMessage,
            attribution: decoded.attribution,
            fingerprint: "",
            createdAt: new Date().toISOString()
          }
          const fingerprint = syncNoteReferencesLedgerFingerprint(command)
          let mutation: SyncNoteReferencesResult | undefined
          return yield* Effect.try({
            try: () => storage.transactionSync(() => ledger.executeV2({
              requestIdentity,
              fingerprint,
              type: "syncNoteReferences",
              mutate: () => {
                const exit = Effect.runSyncExit(graph.syncNoteReferences(decoded.workspaceId, decoded.nodeId, referencedNodeIds))
                if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
                mutation = exit.value
                return new SyncNoteReferencesOutput({ edges: exit.value.edges })
              },
              encodeOutput: (output) => Schema.encodeSync(SyncNoteReferencesOutput)(output),
              decodeOutput: (output) => Schema.decodeUnknownSync(SyncNoteReferencesOutput)(output),
              appendCommand: () => {
                if (mutation === undefined) throw new Error("syncNoteReferences completed without a mutation journal")
                ledger.appendSyncNoteReferences({
                  ...command,
                  fingerprint,
                  created: mutation.created,
                  removed: mutation.removed
                })
              },
              appendSideEffects: () => {
                if (mutation === undefined) throw new Error("syncNoteReferences completed without a mutation journal")
                if (mutation.created.length === 0 && mutation.removed.length === 0) return
                const payload = {
                  nodeId: decoded.nodeId,
                  referencedNodeIds,
                  created: mutation.created,
                  removed: mutation.removed
                }
                ledger.appendEvent(requestIdentity, "sync-note-references", payload)
                ledger.appendOutbox(requestIdentity, "sync-note-references", payload)
              }
            })),
            catch: (error): DomainError => error instanceof LedgerConflict || error instanceof ValidationError
              ? new ValidationError({ message: error.message })
              : isDomainError(error) ? error : new UnexpectedError({ message: `ledgered syncNoteReferences failed: ${error instanceof Error ? error.message : String(error)}` })
          })
        })
      })
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
    const storage = this.#storage
    const ledger = this.#ledger
    const program = decodeRpcInput(AssignTagInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => {
        if (currentUser === undefined) return Effect.fail(new Unauthorized({ message: "An authenticated user is required to assign a Supertag." }))
        const commitMessage = decoded.commitMessage.trim()
        if (commitMessage.length === 0) return Effect.fail(new ValidationError({ message: "A commit message is required to assign a Supertag." }))
        return Effect.gen(function* () {
          const graph = yield* GraphService
          const sharing = yield* SharingService
          const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-authenticated-v1" : "governed-role-v1"
          const requestIdentity = `assign-tag:${decoded.requestId}`
          const command: AssignTagLedgerCommandInput = {
            requestIdentity, requestId: decoded.requestId, workspaceId: decoded.workspaceId, principal: currentUser.email, policy,
            nodeId: decoded.nodeId, tagId: decoded.tagId, commitMessage, attribution: decoded.attribution,
            fingerprint: "", createdAt: new Date().toISOString()
          }
          const fingerprint = assignTagLedgerFingerprint(command)
          const ledgerCommand = { ...command, fingerprint }
          let changed: boolean | undefined
          return yield* Effect.try({
            try: () => storage.transactionSync(() => ledger.executeV2({
              requestIdentity, fingerprint, type: "assignTag",
              mutate: () => {
                const exit = Effect.runSyncExit(graph.assignTag(decoded.workspaceId, decoded.nodeId, decoded.tagId))
                if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
                changed = exit.value
                return new AssignTagOutput({ nodeId: decoded.nodeId, tagId: decoded.tagId, changed: exit.value })
              },
              encodeOutput: (output) => Schema.encodeSync(AssignTagOutput)(output),
              decodeOutput: (output) => Schema.decodeUnknownSync(AssignTagOutput)(output),
              appendCommand: () => ledger.appendAssignTag(ledgerCommand),
              appendSideEffects: () => {
                if (changed !== true) return
                const payload = { nodeId: decoded.nodeId, tagId: decoded.tagId, changed: true }
                ledger.appendEvent(requestIdentity, "assign-tag", payload)
                ledger.appendOutbox(requestIdentity, "assign-tag", payload)
              }
            })),
            catch: (error): DomainError => error instanceof LedgerConflict || error instanceof ValidationError
              ? new ValidationError({ message: error.message })
              : isDomainError(error) ? error : new UnexpectedError({ message: `ledgered assignTag failed: ${error instanceof Error ? error.message : String(error)}` })
          })
        })
      })
    )
    return runRpcProgram(this.#runtime, program, AssignTagOutput)
  }

  /** `assignTag`'s symmetric counterpart (supertag-centering pass §2's `unassignTag` addition —
   *  see `GraphService.unassignTag`'s own doc comment). Same authorization tier as `assignTag`
   *  (`"build"`): removing a node's tag membership is a structural graph mutation, not a read. */
  async unassignTag(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const storage = this.#storage
    const ledger = this.#ledger
    const program = decodeRpcInput(UnassignTagInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => {
        if (currentUser === undefined) return Effect.fail(new Unauthorized({ message: "An authenticated user is required to remove a Supertag." }))
        const commitMessage = decoded.commitMessage.trim()
        if (commitMessage.length === 0) return Effect.fail(new ValidationError({ message: "A commit message is required to remove a Supertag." }))
        return Effect.gen(function* () {
          const graph = yield* GraphService
          const sharing = yield* SharingService
          const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-authenticated-v1" : "governed-role-v1"
          const requestIdentity = `unassign-tag:${decoded.requestId}`
          const command: UnassignTagLedgerCommandInput = {
            requestIdentity, requestId: decoded.requestId, workspaceId: decoded.workspaceId, principal: currentUser.email, policy,
            nodeId: decoded.nodeId, tagId: decoded.tagId, commitMessage, attribution: decoded.attribution,
            fingerprint: "", createdAt: new Date().toISOString()
          }
          const fingerprint = unassignTagLedgerFingerprint(command)
          const ledgerCommand = { ...command, fingerprint }
          let changed: boolean | undefined
          return yield* Effect.try({
            try: () => storage.transactionSync(() => ledger.executeV2({
              requestIdentity, fingerprint, type: "unassignTag",
              mutate: () => {
                const exit = Effect.runSyncExit(graph.unassignTag(decoded.workspaceId, decoded.nodeId, decoded.tagId))
                if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
                changed = exit.value
                return new UnassignTagOutput({ nodeId: decoded.nodeId, tagId: decoded.tagId, changed: exit.value })
              },
              encodeOutput: (output) => Schema.encodeSync(UnassignTagOutput)(output),
              decodeOutput: (output) => Schema.decodeUnknownSync(UnassignTagOutput)(output),
              appendCommand: () => ledger.appendUnassignTag(ledgerCommand),
              appendSideEffects: () => {
                if (changed !== true) return
                const payload = { nodeId: decoded.nodeId, tagId: decoded.tagId, changed: true }
                ledger.appendEvent(requestIdentity, "unassign-tag", payload)
                ledger.appendOutbox(requestIdentity, "unassign-tag", payload)
              }
            })),
            catch: (error): DomainError => error instanceof LedgerConflict || error instanceof ValidationError
              ? new ValidationError({ message: error.message })
              : isDomainError(error) ? error : new UnexpectedError({ message: `ledgered unassignTag failed: ${error instanceof Error ? error.message : String(error)}` })
          })
        })
      })
    )
    return runRpcProgram(this.#runtime, program, UnassignTagOutput)
  }

  // --- Supertag-centering pass (docs/supertag-centering-decisions.md §1/§2) -------------------

  async defineTagField(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const storage = this.#storage
    const ledger = this.#ledger
    const program = decodeRpcInput(DefineTagFieldInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => {
        if (currentUser === undefined) {
          return Effect.fail(new Unauthorized({ message: "An authenticated user is required to define a Supertag field." }))
        }
        const name = normalizeTagFieldName(decoded.name)
        if (name.length === 0) {
          return Effect.fail(new ValidationError({ message: "A non-blank field name is required." }))
        }
        const commitMessage = decoded.commitMessage.trim()
        if (commitMessage.length === 0) {
          return Effect.fail(new ValidationError({ message: "A commit message is required to define a Supertag field." }))
        }
        return Effect.gen(function* () {
          const graph = yield* GraphService
          const sharing = yield* SharingService
          const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-authenticated-v1" : "governed-role-v1"
          const requestIdentity = `define-tag-field:${decoded.requestId}`
          const command: DefineTagFieldLedgerCommandInput = {
            requestIdentity,
            requestId: decoded.requestId,
            workspaceId: decoded.workspaceId,
            principal: currentUser.email,
            policy,
            tagId: decoded.tagId,
            name,
            valueKind: decoded.valueKind,
            sortOrder: decoded.sortOrder,
            commitMessage,
            attribution: decoded.attribution,
            fingerprint: "",
            createdAt: new Date().toISOString()
          }
          const fingerprint = defineTagFieldLedgerFingerprint(command)
          const ledgerCommand = { ...command, fingerprint }
          let fieldDefinitionId: string | undefined
          return yield* Effect.try({
            try: () => storage.transactionSync(() => ledger.executeV2({
              requestIdentity,
              fingerprint,
              type: "defineTagField",
              mutate: () => {
                const exit = Effect.runSyncExit(graph.defineTagField(
                  decoded.workspaceId,
                  decoded.tagId,
                  name,
                  decoded.valueKind,
                  decoded.sortOrder
                ))
                if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
                fieldDefinitionId = exit.value.id
                return new DefineTagFieldOutput({ fieldDefinition: exit.value })
              },
              encodeOutput: (output) => Schema.encodeSync(DefineTagFieldOutput)(output),
              decodeOutput: (output) => Schema.decodeUnknownSync(DefineTagFieldOutput)(output),
              appendCommand: () => ledger.appendDefineTagField(ledgerCommand),
              appendSideEffects: () => {
                if (fieldDefinitionId === undefined) throw new Error("defineTagField completed without a field identity")
                const payload = {
                  fieldDefinitionId,
                  tagId: decoded.tagId,
                  name,
                  valueKind: decoded.valueKind,
                  sortOrder: decoded.sortOrder
                }
                ledger.appendEvent(requestIdentity, "define-tag-field", payload)
                ledger.appendOutbox(requestIdentity, "define-tag-field", payload)
              }
            })),
            catch: (error): DomainError => error instanceof LedgerConflict || error instanceof ValidationError
              ? new ValidationError({ message: error.message })
              : isDomainError(error) ? error : new UnexpectedError({ message: `ledgered defineTagField failed: ${error instanceof Error ? error.message : String(error)}` })
          })
        })
      })
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
    const storage = this.#storage
    const ledger = this.#ledger
    const program = decodeRpcInput(ApplySupertagInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => {
        const fieldValues = decoded.fieldValues ?? []
        const fieldIds = new Set<string>()
        for (const fieldValue of fieldValues) {
          if (fieldIds.has(fieldValue.fieldId)) {
            return Effect.fail(new ValidationError({ message: `duplicate Supertag field ${fieldValue.fieldId}` }))
          }
          fieldIds.add(fieldValue.fieldId)
        }
        const commitMessage = decoded.commitMessage.trim()
        if (commitMessage.length === 0) {
          return Effect.fail(new ValidationError({ message: "commitMessage must contain non-whitespace text" }))
        }
        return Effect.gen(function* () {
          const graph = yield* GraphService
          const sharing = yield* SharingService
          const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-open-v1" : "governed-role-v1"
          const principal = currentUser?.email ?? "anonymous"
          const requestIdentity = `apply-supertag:${decoded.requestId}`
          const fingerprint = applySupertagLedgerFingerprint({
            requestId: decoded.requestId,
            workspaceId: decoded.workspaceId,
            principal,
            policy,
            nodeId: decoded.nodeId,
            tagId: decoded.tagId,
            fieldValues,
            commitMessage,
            attribution: decoded.attribution
          })
          const command: ApplySupertagLedgerCommandInput = {
            requestIdentity,
            requestId: decoded.requestId,
            fingerprint,
            workspaceId: decoded.workspaceId,
            principal,
            policy,
            nodeId: decoded.nodeId,
            tagId: decoded.tagId,
            fieldValues,
            commitMessage,
            attribution: decoded.attribution,
            createdAt: new Date().toISOString()
          }
          let factIds: ReadonlyArray<string> = []
          return yield* Effect.try({
            try: () => storage.transactionSync(() => ledger.executeV2({
              requestIdentity,
              fingerprint,
              type: "applySupertag",
              mutate: () => {
                const exit = Effect.runSyncExit(graph.applySupertag(
                  decoded.workspaceId,
                  decoded.nodeId,
                  decoded.tagId,
                  fieldValues.map((fv) => ({ fieldId: fv.fieldId, value: fv.value }))
                ))
                if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
                factIds = exit.value.map((fact) => fact.id)
                return new ApplySupertagOutput({ nodeId: decoded.nodeId, tagId: decoded.tagId, facts: exit.value })
              },
              encodeOutput: (output) => Schema.encodeSync(ApplySupertagOutput)(output),
              decodeOutput: (output) => Schema.decodeUnknownSync(ApplySupertagOutput)(output),
              appendCommand: () => ledger.appendApplySupertag(command),
              appendSideEffects: () => {
                const payload = { nodeId: decoded.nodeId, tagId: decoded.tagId, factIds }
                ledger.appendEvent(requestIdentity, "apply-supertag", payload)
                ledger.appendOutbox(requestIdentity, "apply-supertag", payload)
              }
            })),
            catch: (error): DomainError =>
              error instanceof LedgerConflict || error instanceof ValidationError
                ? new ValidationError({ message: error.message })
                : isDomainError(error)
                  ? error
                  : new UnexpectedError({ message: `ledgered applySupertag failed: ${error instanceof Error ? error.message : String(error)}` })
          })
        })
      })
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
          const sharing = yield* SharingService
          const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-open-v1" : "governed-role-v1"
          const context = currentUser === undefined ? undefined : { principal: currentUser.email, policy }
          const { messages, changesSequences } = yield* agentEdit.sendChatMessage(decoded.chatId, decoded.text, context)
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

  /** Public P5.2 decision boundary. The authenticated user is derived from the connection; the
   * caller supplies only the immutable proposal id, decision, rationale, and evidence provenance.
   * Proposal validation, target promotion/rejection, ledger command, event, outbox, and receipt
   * all share one Durable Object transaction. */
  async decideAgentChangeProposal(input: unknown): Promise<unknown> {
    const workspaceId = this.#workspaceId
    const currentUser = this.#currentUser
    const storage = this.#storage
    const ledger = this.#ledger
    const program = decodeRpcInput(DecideAgentChangeProposalInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => {
        if (currentUser === undefined) {
          return Effect.fail(
            new Unauthorized({
              message: "An authenticated user is required to decide an agent change proposal."
            })
          )
        }
        return Effect.gen(function* () {
          const agentEdit = yield* AgentEditService
          const sharing = yield* SharingService
          const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-authenticated-v1" : "governed-role-v1"
          const requestIdentity = `agent-change-decision:${decoded.requestId}`
          const command = {
            requestIdentity,
            requestId: decoded.requestId,
            workspaceId: decoded.workspaceId,
            proposalId: decoded.proposalId,
            decision: decoded.decision,
            principal: currentUser.email,
            provenance: decoded.provenance,
            policy,
            message: decoded.message,
            payload: { proposalId: decoded.proposalId, decision: decoded.decision }
          }
          const fingerprint = agentChangeDecisionLedgerFingerprint(command)
          return yield* Effect.try({
            try: () => storage.transactionSync(() => {
              const replay = ledger.existing(requestIdentity, fingerprint)
              if (replay !== undefined) return Schema.decodeUnknownSync(DecideAgentChangeProposalOutput)(replay.output)
              const exit = Effect.runSyncExit(agentEdit.decideAgentChangeProposal({
                proposalId: decoded.proposalId,
                decision: decoded.decision
              }))
              if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
              const output = new DecideAgentChangeProposalOutput({
                proposalId: decoded.proposalId,
                state: exit.value
              })
              ledger.appendAgentChangeDecision({
                ...command,
                fingerprint,
                createdAt: new Date().toISOString()
              }, Schema.encodeSync(DecideAgentChangeProposalOutput)(output))
              return output
            }),
            catch: (error): DomainError =>
              error instanceof LedgerConflict || error instanceof ValidationError
                ? new ValidationError({ message: error.message })
                : error instanceof Unauthorized || error instanceof UnexpectedError
                  ? error
                  : new UnexpectedError({ message: `ledgered agent change decision failed: ${error instanceof Error ? error.message : String(error)}` })
          })
        })
      })
    )
    return runRpcProgram(this.#runtime, program, DecideAgentChangeProposalOutput)
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

  /** Read-only, privacy-safe audit history for the Today surface. This is intentionally a
   * build-role view: it exposes commit messages that may describe agent work, while the response
   * redacts raw principals and all internal ledger identifiers. It reports recorded command
   * history only; direct mutation paths remain outside this transitional feed until migrated. */
  async listRecentLedgerActivity(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ListRecentLedgerActivityInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.map((decoded) => {
        const actorFor = (principal: string): "you" | "workspace-member" | "anonymous" => {
          if (principal === "anonymous") return "anonymous"
          if (principal === currentUser?.email) return "you"
          return "workspace-member"
        }
        // `IsoDateTimeString` accepts valid offset forms as well as canonical UTC strings. Normalize
        // at the RPC boundary so SQLite's lexical timestamp comparison always compares instants,
        // not representations with different offsets.
        const ledgerWindow = {
          from: decoded.from === undefined ? undefined : new Date(decoded.from).toISOString(),
          to: decoded.to === undefined ? undefined : new Date(decoded.to).toISOString()
        }
        const entries = this.#ledger.listRecentActivity(decoded.limit ?? 8, ledgerWindow).flatMap((row) => {
          const type = Schema.decodeUnknownOption(LedgerActivityType)(row.type)
          if (type._tag === "None") return []
          const actor = actorFor(row.principal)
          // The custody row has already been constrained by LedgerService. Preserve the legacy
          // actor enum while presenting only a safe, viewer-relative label.
          const actorDetail = row.actorKind === undefined || row.actorLabel === undefined
            ? undefined
            : row.actorKind === "user"
              ? new LedgerActivityActorDetail({ kind: "user", label: actor === "you" ? "You" : "Workspace member" })
              : row.actorKind === "employee"
                ? new LedgerActivityActorDetail({ kind: "employee", label: row.actorLabel })
                : new LedgerActivityActorDetail({ kind: "system", label: row.actorLabel })
          const target = row.targetKind === "node" && row.targetId !== undefined
            ? new LedgerActivityTarget({ kind: "node", id: Schema.decodeUnknownSync(EntityId)(row.targetId) })
            : undefined
          return [new LedgerActivityEntry({
            occurredAt: Schema.decodeUnknownSync(IsoDateTimeString)(row.createdAt),
            type: type.value,
            actor,
            message: row.message,
            ...(actorDetail === undefined ? {} : { actorDetail }),
            ...(target === undefined ? {} : { target })
          })]
        })
        return new ListRecentLedgerActivityOutput({ entries })
      })
    )
    return runRpcProgram(this.#runtime, program, ListRecentLedgerActivityOutput)
  }

  /** Read-only employee publication projection for one resolved daily note. The private
   * authority records never cross this boundary; companion integrity is derived from the current
   * linked Loro page and therefore remains meaningful after an edit or deletion. */
  async listStandupPublications(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const store = this.#standupPublicationStore
    const workforceRunStore = this.#workforceRunStore
    const program = decodeRpcInput(ListStandupPublicationsInput, input).pipe(
      Effect.tap((decoded) =>
        requireOwnWorkspace(this.#workspaceId, decoded.workspaceId),
      ),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const nodes = yield* NodesRepository
          const loro = yield* LoroPageService
          const rows = yield* Effect.try({
            try: () =>
              store.listPublicationsByDailyNote(
                decoded.workspaceId,
                decoded.dailyNoteId,
              ),
            catch: (error) =>
              new UnexpectedError({
                message: `standup publication storage failure: ${error instanceof Error ? error.message : String(error)}`,
              }),
          })
          const publications: StandupPublication[] = []
          for (const row of rows) {
            // The receipt table is joined solely through the immutable public publication id.
            // `getByPublicationId` rebinds its denormalized SQL row before projection; the
            // projection below then proves the complete public counterpart identity.
            const receipt = yield* Effect.try({
              try: () => workforceRunStore.getByPublicationId(row.publication.publicationId),
              catch: () => new UnexpectedError({ message: "standup publication workforce receipt failure" }),
            })
            publications.push(yield* projectStandupPublication(nodes, loro, row, receipt))
          }
          return new ListStandupPublicationsOutput({ publications })
        }),
      ),
    )
    return runRpcProgram(this.#runtime, program, ListStandupPublicationsOutput)
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
          if (currentUser === undefined) {
            return yield* Effect.fail(new Unauthorized({ message: "An authenticated user is required to sync a calendar." }))
          }
          const calendar = yield* CalendarService
          const { triggered } = yield* calendar.sync(
            decoded.workspaceId,
            decoded.bindingId,
            new HumanUiMutationAttribution({
              version: "athenaeum.mutation-attribution.v1",
              kind: "humanUi",
              surface: "web-calendar"
            }),
            currentUser.email
          )
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

  async listGatekeeperBindings(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(ListGatekeeperBindingsInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      // Binding existence and mode are external-connection management metadata. Keep this behind
      // the stronger management role even though the projection is deliberately redacted.
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const calendar = yield* CalendarService
          const bindings = yield* calendar.listBindings(decoded.workspaceId)
          return new ListGatekeeperBindingsOutput({ bindings })
        })
      )
    )
    return runRpcProgram(this.#runtime, program, ListGatekeeperBindingsOutput)
  }

  async getTodayBrief(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const program = decodeRpcInput(GetTodayBriefInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      // Keep the authorization boundary centralized at the RPC edge. CalendarService then applies
      // the calendar-derived visibility policy and deliberately makes a denial look like no local
      // retained data, rather than disclosing any binding or observer state.
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "use")),
      Effect.flatMap((decoded) =>
        Effect.gen(function* () {
          const calendar = yield* CalendarService
          return yield* calendar.getTodayBrief(decoded, currentUser?.email)
        })
      )
    )
    return runRpcProgram(this.#runtime, program, GetTodayBriefOutput)
  }

  async linkCalendarEventToNode(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const storage = this.#storage
    const ledger = this.#ledger
    const program = decodeRpcInput(LinkCalendarEventToNodeInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => {
        if (currentUser === undefined) {
          return Effect.fail(new Unauthorized({ message: "An authenticated user is required to link a calendar event." }))
        }
        const requestId = decoded.requestId.trim()
        const commitMessage = decoded.commitMessage.trim()
        if (requestId.length === 0) {
          return Effect.fail(new ValidationError({ message: "A non-blank request id is required to link a calendar event." }))
        }
        if (commitMessage.length === 0) {
          return Effect.fail(new ValidationError({ message: "A commit message is required to link a calendar event." }))
        }
        return Effect.gen(function* () {
          const calendar = yield* CalendarService
          const sharing = yield* SharingService
          // Visibility is checked before deriving a request identity and again after replay. A
          // receipt never becomes a capability to disclose a now-hidden retained event.
          const initialVisible = yield* calendar.listEvents(decoded.workspaceId, undefined, undefined, currentUser.email)
          if (!initialVisible.some((event) => event.id === decoded.calendarEventId)) {
            return yield* Effect.fail(new ValidationError({ message: `No visible calendar event ${decoded.calendarEventId}.` }))
          }
          const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-authenticated-v1" : "governed-role-v1"
          const requestIdentity = `link-calendar-event-to-node:${requestId}`
          const command: LinkCalendarEventToNodeLedgerCommandInput = {
            requestIdentity,
            requestId,
            workspaceId: decoded.workspaceId,
            principal: currentUser.email,
            policy,
            calendarEventId: decoded.calendarEventId,
            nodeId: decoded.nodeId,
            commitMessage,
            attribution: decoded.attribution,
            fingerprint: "",
            createdAt: new Date().toISOString()
          }
          const fingerprint = linkCalendarEventToNodeLedgerFingerprint(command)
          const receipt = yield* Effect.try({
            try: () => storage.transactionSync(() => ledger.executeV2({
              requestIdentity,
              fingerprint,
              type: "linkCalendarEventToNode",
              mutate: () => {
                const exit = Effect.runSyncExit(calendar.linkEventToNode(decoded.workspaceId, decoded.calendarEventId, decoded.nodeId))
                if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
                return new LinkCalendarEventToNodeLedgerReceipt({ calendarEventId: exit.value.id, nodeId: decoded.nodeId })
              },
              encodeOutput: (output) => Schema.encodeSync(LinkCalendarEventToNodeLedgerReceipt)(output),
              decodeOutput: (output) => Schema.decodeUnknownSync(LinkCalendarEventToNodeLedgerReceipt)(output),
              appendCommand: () => ledger.appendLinkCalendarEventToNode({ ...command, fingerprint }),
              appendSideEffects: () => {
                const payload = { calendarEventId: decoded.calendarEventId, nodeId: decoded.nodeId }
                ledger.appendEvent(requestIdentity, "link-calendar-event-to-node", payload)
                ledger.appendOutbox(requestIdentity, "link-calendar-event-to-node", payload)
              }
            })),
            catch: (error): DomainError => error instanceof LedgerConflict || error instanceof ValidationError
              ? new ValidationError({ message: error.message })
              : isDomainError(error) ? error : new UnexpectedError({ message: `ledgered linkCalendarEventToNode failed: ${error instanceof Error ? error.message : String(error)}` })
          })
          const visible = yield* calendar.listEvents(decoded.workspaceId, undefined, undefined, currentUser.email)
          const calendarEvent = visible.find((event) => event.id === receipt.calendarEventId)
          if (calendarEvent === undefined || calendarEvent.linkedNodeId !== receipt.nodeId) {
            return yield* Effect.fail(new ValidationError({ message: `Linked calendar event ${receipt.calendarEventId} is no longer visible or no longer linked to the requested node.` }))
          }
          return new LinkCalendarEventToNodeOutput({ calendarEvent })
        })
      })
    )
    return runRpcProgram(this.#runtime, program, LinkCalendarEventToNodeOutput)
  }

  async createBookmark(input: unknown): Promise<unknown> {
    const currentUser = this.#currentUser
    const storage = this.#storage
    const ledger = this.#ledger
    const program = decodeRpcInput(CreateBookmarkInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => {
        if (currentUser === undefined) {
          return Effect.fail(new Unauthorized({ message: "An authenticated user is required to create a bookmark." }))
        }
        const commitMessage = decoded.commitMessage.trim()
        if (commitMessage.length === 0) {
          return Effect.fail(new ValidationError({ message: "A commit message is required to create a bookmark." }))
        }
        return Effect.gen(function* () {
          const calendar = yield* CalendarService
          const sharing = yield* SharingService
          const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-authenticated-v1" : "governed-role-v1"
          const requestIdentity = `create-bookmark:${decoded.requestId}`
          const command: CreateBookmarkLedgerCommandInput = {
            requestIdentity,
            requestId: decoded.requestId,
            workspaceId: decoded.workspaceId,
            principal: currentUser.email,
            policy,
            url: decoded.url,
            ...(decoded.title !== undefined ? { title: decoded.title } : {}),
            commitMessage,
            attribution: decoded.attribution,
            fingerprint: "",
            createdAt: new Date().toISOString()
          }
          const fingerprint = createBookmarkLedgerFingerprint(command)
          let bookmark: Bookmark | undefined
          return yield* Effect.try({
            try: () => storage.transactionSync(() => ledger.executeV2({
              requestIdentity,
              fingerprint,
              type: "createBookmark",
              mutate: () => {
                const exit = Effect.runSyncExit(calendar.createBookmark(decoded.workspaceId, decoded.url, decoded.title))
                if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
                bookmark = exit.value
                return new CreateBookmarkOutput({ bookmark: exit.value })
              },
              encodeOutput: (output) => Schema.encodeSync(CreateBookmarkOutput)(output),
              decodeOutput: (output) => Schema.decodeUnknownSync(CreateBookmarkOutput)(output),
              appendCommand: () => {
                if (bookmark === undefined) throw new Error("createBookmark completed without a bookmark identity")
                ledger.appendCreateBookmark({ ...command, fingerprint }, bookmark)
              },
              appendSideEffects: () => {
                if (bookmark === undefined) throw new Error("createBookmark completed without a bookmark identity")
                const payload = { bookmarkId: bookmark.id }
                ledger.appendEvent(requestIdentity, "create-bookmark", payload)
                ledger.appendOutbox(requestIdentity, "create-bookmark", payload)
              }
            })),
            catch: (error): DomainError => error instanceof LedgerConflict || error instanceof ValidationError
              ? new ValidationError({ message: error.message })
              : isDomainError(error) ? error : new UnexpectedError({ message: `ledgered createBookmark failed: ${error instanceof Error ? error.message : String(error)}` })
          })
        })
      })
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
    const storage = this.#storage
    const ledger = this.#ledger
    const program = decodeRpcInput(StartMeetingInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => {
        if (currentUser === undefined) {
          return Effect.fail(new Unauthorized({ message: "An authenticated user is required to start a meeting." }))
        }
        const commitMessage = decoded.commitMessage.trim()
        if (commitMessage.length === 0) {
          return Effect.fail(new ValidationError({ message: "A commit message is required to start a meeting." }))
        }
        return Effect.gen(function* () {
          const meetings = yield* MeetingsService
          const sharing = yield* SharingService
          const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-authenticated-v1" : "governed-role-v1"
          const requestIdentity = `start-meeting:${decoded.requestId}`
          const command: StartMeetingLedgerCommandInput = {
            requestIdentity,
            requestId: decoded.requestId,
            workspaceId: decoded.workspaceId,
            principal: currentUser.email,
            policy,
            title: decoded.title,
            commitMessage,
            attribution: decoded.attribution,
            fingerprint: "",
            createdAt: new Date().toISOString()
          }
          const fingerprint = startMeetingLedgerFingerprint(command)
          let meeting: { readonly id: string; readonly title: string; readonly startedAt: string } | undefined
          return yield* Effect.try({
            try: () => storage.transactionSync(() => ledger.executeV2({
              requestIdentity,
              fingerprint,
              type: "startMeeting",
              mutate: () => {
                const exit = Effect.runSyncExit(meetings.startMeeting(decoded.workspaceId, decoded.title))
                if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
                meeting = exit.value
                return new StartMeetingOutput({ meeting: exit.value })
              },
              encodeOutput: (output) => Schema.encodeSync(StartMeetingOutput)(output),
              decodeOutput: (output) => Schema.decodeUnknownSync(StartMeetingOutput)(output),
              appendCommand: () => {
                if (meeting === undefined) throw new Error("startMeeting completed without a meeting identity")
                ledger.appendStartMeeting({ ...command, fingerprint }, meeting)
              },
              appendSideEffects: () => {
                if (meeting === undefined) throw new Error("startMeeting completed without a meeting identity")
                const payload = { meetingId: meeting.id }
                ledger.appendEvent(requestIdentity, "start-meeting", payload)
                ledger.appendOutbox(requestIdentity, "start-meeting", payload)
              }
            })),
            catch: (error): DomainError => error instanceof LedgerConflict || error instanceof ValidationError
              ? new ValidationError({ message: error.message })
              : isDomainError(error) ? error : new UnexpectedError({ message: `ledgered startMeeting failed: ${error instanceof Error ? error.message : String(error)}` })
          })
        })
      })
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
    const storage = this.#storage
    const ledger = this.#ledger
    const program = decodeRpcInput(AppendTranscriptSegmentInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)),
      Effect.tap(() => requireRoleForGovernedWorkspace(currentUser, "build")),
      Effect.flatMap((decoded) => {
        if (currentUser === undefined) {
          return Effect.fail(new Unauthorized({ message: "An authenticated user is required to append a transcript segment." }))
        }
        const commitMessage = decoded.commitMessage.trim()
        if (commitMessage.length === 0) {
          return Effect.fail(new ValidationError({ message: "A commit message is required to append a transcript segment." }))
        }
        return Effect.gen(function* () {
          const meetings = yield* MeetingsService
          const sharing = yield* SharingService
          const policy = (yield* sharing.getOwnerEmail) === null ? "ungoverned-authenticated-v1" : "governed-role-v1"
          const requestIdentity = `append-transcript-segment:${decoded.requestId}`
          const command: AppendTranscriptSegmentLedgerCommandInput = {
            requestIdentity,
            requestId: decoded.requestId,
            workspaceId: decoded.workspaceId,
            principal: currentUser.email,
            policy,
            meetingId: decoded.meetingId,
            ...(decoded.speakerId !== undefined ? { speakerId: decoded.speakerId } : {}),
            text: decoded.text,
            startOffsetMs: decoded.startOffsetMs,
            endOffsetMs: decoded.endOffsetMs,
            source: decoded.source,
            commitMessage,
            attribution: decoded.attribution,
            fingerprint: "",
            createdAt: new Date().toISOString()
          }
          const fingerprint = appendTranscriptSegmentLedgerFingerprint(command)
          let segment: import("@athenaeum/domain").TranscriptSegmentRecord | undefined
          return yield* Effect.try({
            try: () => storage.transactionSync(() => ledger.executeV2({
              requestIdentity,
              fingerprint,
              type: "appendTranscriptSegment",
              mutate: () => {
                const exit = Effect.runSyncExit(meetings.appendTranscriptSegment(decoded.workspaceId, decoded.meetingId, {
                  ...(decoded.speakerId !== undefined ? { speakerId: decoded.speakerId } : {}),
                  text: decoded.text,
                  startOffsetMs: decoded.startOffsetMs,
                  endOffsetMs: decoded.endOffsetMs,
                  source: decoded.source
                }))
                if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
                segment = exit.value
                return new AppendTranscriptSegmentOutput({ segment: exit.value })
              },
              encodeOutput: (output) => Schema.encodeSync(AppendTranscriptSegmentOutput)(output),
              decodeOutput: (output) => Schema.decodeUnknownSync(AppendTranscriptSegmentOutput)(output),
              appendCommand: () => {
                if (segment === undefined) throw new Error("appendTranscriptSegment completed without a segment identity")
                ledger.appendTranscriptSegment({ ...command, fingerprint }, segment)
              },
              appendSideEffects: () => {
                if (segment === undefined) throw new Error("appendTranscriptSegment completed without a segment identity")
                const payload = { meetingId: decoded.meetingId, segmentId: segment.id }
                ledger.appendEvent(requestIdentity, "append-transcript-segment", payload)
                ledger.appendOutbox(requestIdentity, "append-transcript-segment", payload)
              }
            })),
            catch: (error): DomainError => error instanceof LedgerConflict || error instanceof ValidationError
              ? new ValidationError({ message: error.message })
              : isDomainError(error) ? error : new UnexpectedError({ message: `ledgered appendTranscriptSegment failed: ${error instanceof Error ? error.message : String(error)}` })
          })
        })
      })
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
  readonly #calendarCollections: CalendarCollections
  readonly #syncFeedCollections: SyncFeedCollections
  readonly #pageCollections: PagesCollections
  readonly #workspaceId: EntityId
  readonly #sql: SqlStorage
  /** Shared workspace ledger used by trusted native authorities as well as public RPC shims. */
  readonly #ledger: LedgerService
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
  /** Durable private workforce publication authority. The current tranche exposes only its
   *  read projection and is also the transaction owner for the trusted workforce ingress below. */
  readonly #standupPublicationStore: DurableStandupPublicationAuthorityStore
  /** Terminal run receipts are keyed by the canonical run/occurrence identity and staged in the
   *  same SQLite transaction as the node, Loro page, and standup publication authority records. */
  readonly #workforceRunStore: DurableWorkforceRunReceiptStore
  /** Generic durable job clock. Its executor is deliberately attached by the calendar/workforce
   * package; until then this object only persists/re-arms schedules and never claims a job. */
  readonly #workforceRuntimeStore: DurableWorkforceRuntimeStore
  readonly #workforceScheduler: WorkforceScheduler
  readonly #calendarConciergeGrants: DurableCalendarConciergeGrantStore

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Populated whenever the backend Worker addresses this DO via `getByName(workspaceId)` (see
    // `index.ts`) — only ever uses `getByName`, never `idFromString`/`newUniqueId`, so
    // `ctx.id.name` is always set here.
    this.#workspaceId = Schema.decodeUnknownSync(EntityId)(ctx.id.name)
    this.#sql = ctx.storage.sql
    this.#ledger = new LedgerService(this.#sql)
    this.#storage = ctx.storage
    this.#workspaceMeta = makeWorkspaceMetaSingleton(ctx.storage)
    this.#sharingCollections = makeSharingCollections(ctx.storage)
    this.#standupPublicationStore = new DurableStandupPublicationAuthorityStore(
      ctx.storage,
      this.#sql,
    )
    this.#workforceRunStore = new DurableWorkforceRunReceiptStore(this.#sql)
    this.#workforceRuntimeStore = new DurableWorkforceRuntimeStore(this.#sql)
    this.#workforceScheduler = new WorkforceScheduler(this.#storage, this.#workforceRuntimeStore)
    this.#calendarConciergeGrants = new DurableCalendarConciergeGrantStore(this.#sql)

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
    const pageProposalCollections = makePageProposalCollections(ctx.storage)
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
    this.#syncFeedCollections = syncFeedCollections
    this.#pageCollections = pagesCollections

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
    const loroPageServiceLive = makeLoroPageServiceLive(
      pagesCollections,
      pageProposalCollections,
      this.#sql
    ).pipe(Layer.provide(repositoriesLayer))
    const pageProposalServiceLive = makePageProposalServiceLive(pageProposalCollections).pipe(Layer.provide(notesServiceLive))
    // Phase 3 spike (plan risk #4): the Automerge-fork-as-chat-branch mechanism. Depends on
    // `NotesService` itself (not the raw `pagesCollections`) — see chat-fork-service-live.ts's
    // header comment for why every mainline read/write must go through NotesService's own doc
    // cache rather than around it.
    const chatForkServiceLive = makeChatForkServiceLive(this.#workspaceId).pipe(Layer.provide(pageProposalServiceLive))
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
    const agentChangeProposalCollections = makeAgentChangeProposalCollections(ctx.storage, this.#sql)
    const agentLoroEditServiceLive = makeAgentLoroEditServiceLive(
      this.#workspaceId,
      this.#storage,
      new LedgerService(this.#sql)
    ).pipe(Layer.provide(loroPageServiceLive))
    const agentEditServiceLive = makeAgentEditServiceLive(
      this.#workspaceId,
      agentEditCollections,
      nodesCollections,
      factsCollections,
      edgesCollections,
      appCollections,
      agentChangeProposalCollections,
      this.#sql
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          repositoriesLayer,
          graphServiceLive,
          notesServiceLive,
          chatForkServiceLive,
          modelClientLayer,
          agentLoroEditServiceLive
        )
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
    this.#calendarCollections = calendarCollections
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
      redirectUri: env.CALENDAR_OAUTH_REDIRECT_URI ?? "",
      // The CalendarService performs provider I/O only. This DO-owned gateway is the one
      // transaction that applies its second-brain projection, ledger custody, outbox signal,
      // and durable workforce enqueue.
      projectionGateway: new CalendarProjectionGateway(
        this.#storage,
        this.#ledger,
        this.#workforceRuntimeStore,
        () => this.#workforceScheduler.rearm()
      ),
      attendeeDigestSecret: env.CALENDAR_ATTENDEE_DIGEST_SECRET ?? env.CALENDAR_OAUTH_STATE_SECRET,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(repositoriesLayer, graphServiceLive, calendarGatekeeperClientLive, sharingServiceLive)
      )
    )
    const calendarDigestSecret = env.CALENDAR_ATTENDEE_DIGEST_SECRET ?? env.CALENDAR_OAUTH_STATE_SECRET ?? ""
    const calendarConciergeIntegration: CalendarConciergeExecutorIntegration = {
      prepare: async ({ run, observation, revision }) => {
        const rawEvent = await Effect.runPromise(calendarCollections.calendarEvents.get(observation.calendarEventId))
        if (rawEvent === undefined) throw new Error("calendar event for concierge observation is missing")
        const event = await Effect.runPromise(reviveCalendarEvent(rawEvent))
        const attendees = event.attendees.map((attendee) => ({
          email: attendee.email.trim().toLowerCase(),
          ...(attendee.displayName === undefined ? {} : { displayName: attendee.displayName })
        }))
        const digests = await Promise.all(attendees.map((attendee) => calendarAttendeeDigest(calendarDigestSecret, this.#workspaceId, attendee.email)))
        const attendeeIndex = digests.indexOf(observation.emailDigest)
        const attendee = attendeeIndex < 0 ? undefined : attendees[attendeeIndex]
        if (attendee === undefined) throw new Error("calendar attendee digest is not present in the private event")

        /** A queued observation is only live while its event revision remains the provider's latest
         * non-cancelled revision. Cancellation can arrive after enqueue and before an alarm claims
         * the run, or while a claimed employee is between tools; every capability admission calls
         * this synchronous fence again so stale work fails closed without publishing a standup. */
        const observationStillCurrent = (): boolean => {
          try {
            const currentRaw = Effect.runSync(calendarCollections.calendarEvents.get(observation.calendarEventId))
            if (currentRaw === undefined) return false
            const currentEvent = Effect.runSync(reviveCalendarEvent(currentRaw))
            if (currentEvent.status === "cancelled") return false
            const revisions = Effect.runSync(
              calendarCollections.calendarSourceRevisions.byBindingAndProviderEvent
                .get(`${revision.bindingId}:${revision.providerEventId}`)
            )
            const latest = revisions
              .filter((candidate) => candidate.workspaceId === this.#workspaceId)
              .sort((left, right) => {
                const leftAt = Date.parse(left.sourceUpdatedAt ?? left.appliedAt)
                const rightAt = Date.parse(right.sourceUpdatedAt ?? right.appliedAt)
                return leftAt === rightAt
                  ? left.sourceRevisionDigest.localeCompare(right.sourceRevisionDigest)
                  : leftAt - rightAt
              })
              .at(-1)
            return latest?.sourceRevisionDigest === revision.sourceRevisionDigest && latest.status !== "cancelled"
          } catch {
            return false
          }
        }

        const microEmployee = { kind: "microEmployee" as const, id: "calendar-concierge", version: "v1" }
        const job = { kind: "job" as const, id: "calendar-attendee-enrichment", version: "v1" }
        const workflow = { kind: "workflow" as const, id: CALENDAR_RELATIONSHIP_CONCIERGE_WORKFLOW, version: CALENDAR_RELATIONSHIP_CONCIERGE_VERSION }
        const grant: CalendarConciergeGrantV1 = {
          version: CALENDAR_CONCIERGE_CAPABILITY_VERSION,
          grantId: `calendar-concierge-grant:${run.id}:${run.attempts}:${crypto.randomUUID()}`,
          grantRecordVersion: "1",
          workspaceId: this.#workspaceId,
          microEmployee,
          job,
          workflow,
          runId: run.id,
          claimToken: run.claimToken!,
          claimFence: run.attempts,
          observationId: observation.id,
          sourceRevisionDigest: revision.sourceRevisionDigest,
          policyGeneration: "calendar-concierge-policy.v1",
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          allowedTools: [
            "readObservedAttendee",
            "resolveUniquePersonByEmailDigest",
            "createCalendarPerson",
            "recordCalendarRelationshipObservation",
            "publishRunTerminal"
          ]
        }
        const issued: IssuedCalendarConciergeGrant = this.#calendarConciergeGrants.issue(grant)
        const binding: CalendarConciergeExecutionBinding = {
          workspaceId: grant.workspaceId,
          microEmployee: grant.microEmployee,
          job: grant.job,
          workflow: grant.workflow,
          runId: grant.runId,
          claimToken: grant.claimToken,
          claimFence: grant.claimFence,
          observationId: grant.observationId,
          sourceRevisionDigest: grant.sourceRevisionDigest,
          policyGeneration: grant.policyGeneration
        }
        const employeeAttribution = new AgentJobMutationAttribution({
          version: "athenaeum.mutation-attribution.v1",
          kind: "agentJob",
          jobId: grant.job.id,
          runId: grant.runId
        })
        type NodeCustodyRequest = Readonly<{
          readonly requestIdentity: string
          readonly fingerprint: string
          readonly type: "createNodeWithIntent" | "addFact" | "assignTag"
          readonly targetId: string
        }>
        type CalendarCustodyRequest = Readonly<{
          readonly requestIdentity: string
          readonly fingerprint: string
          readonly type: "calendarProjection"
          readonly targetId: string
        }>
        const custodyFor = (input: NodeCustodyRequest | CalendarCustodyRequest): LedgerCustodyInput => {
          const base = {
            requestIdentity: input.requestIdentity,
            fingerprint: input.fingerprint,
            workspaceId: this.#workspaceId,
            actorKind: "employee" as const,
            actorLabel: "Calendar relationship concierge",
            employeeId: grant.microEmployee.id,
            jobId: grant.job.id,
            runId: grant.runId,
            grantId: grant.grantId,
            targetId: input.targetId
          }
          return input.type === "calendarProjection"
            ? { ...base, type: input.type, targetKind: "calendarEvent" as const }
            : { ...base, type: input.type, targetKind: "node" as const }
        }
        const deterministicEntityId = (seed: string): EntityId => {
          const digest = sha256HexSync(canonicalJsonBytes({ version: "calendar-concierge-id.v1", seed }))
          return Schema.decodeUnknownSync(EntityId)(`${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`)
        }
        const personId = deterministicEntityId(`person:${this.#workspaceId}:${observation.emailDigest}`)
        const factId = deterministicEntityId(`email-fact:${personId}`)
        const workspaceId = this.#workspaceId
        const sql = this.#sql
        let stagedTerminal: Readonly<{ result: CalendarConciergeTerminalResult; reportText: string; commitMessage: string }> | undefined

        const port: CalendarConciergeJobPort = {
          readObservedAttendee: (input) => {
            if (input.custody.observationId !== observation.id || input.sourceRevisionDigest !== revision.sourceRevisionDigest) return undefined
            if (!observationStillCurrent()) return undefined
            const current = Effect.runSync(calendarCollections.calendarAttendeeObservations.get(observation.id))
            return current === undefined || current.sourceRevisionDigest !== revision.sourceRevisionDigest
              ? undefined
              : { observationId: current.id, emailDigest: current.emailDigest, sourceRevisionDigest: current.sourceRevisionDigest }
          },
          resolveUniquePersonByEmailDigest: (input) => {
            if (input.emailDigest !== observation.emailDigest) return undefined
            if (!observationStillCurrent()) throw new Error("calendar observation was cancelled or superseded")
            const result = this.#runtime.runSync(Effect.gen(function* () {
              const facts = yield* FactsRepository
              const graph = yield* GraphService
              const matches = (yield* facts.list(workspaceId)).filter((fact) =>
                fact.predicateId === "email" && typeof fact.value === "string" && fact.value.trim().toLowerCase() === attendee.email
              )
              const verified: string[] = []
              for (const fact of matches) {
                if (yield* graph.hasTag(workspaceId, fact.nodeId, BaseTagIds.Person)) verified.push(fact.nodeId)
              }
              return [...new Set(verified)]
            }))
            return result.length === 1 ? { personId: result[0]! } : undefined
          },
          createCalendarPerson: (input) => {
            if (input.emailDigest !== observation.emailDigest) throw new Error("calendar attendee digest does not match the claimed observation")
            if (!observationStillCurrent()) throw new Error("calendar observation was cancelled or superseded")
            const repository = this.#runtime.runSync(Effect.gen(function* () { return yield* NodesRepository }))
            const graph = this.#runtime.runSync(Effect.gen(function* () { return yield* GraphService }))
            const syncFeed = this.#runtime.runSync(Effect.gen(function* () { return yield* SyncFeedService }))
            const nodeRequestIdentity = `calendar-concierge:person-node:${observation.id}`
            const nodeCommand: CreateNodeWithIntentLedgerCommandInput = {
              requestIdentity: nodeRequestIdentity,
              requestId: nodeRequestIdentity,
              fingerprint: "",
              workspaceId,
              principal: `workforce:employee:${grant.microEmployee.id}`,
              policy: "calendar-concierge-v1",
              nodeId: personId,
              requestedNodeId: personId,
              // A missing provider display name must not turn a private address into a
              // workspace-visible node title. The email remains in the private Fact used for
              // future resolution; user-facing summaries and titles stay neutral.
              title: (attendee.displayName?.trim() || "Calendar attendee").slice(0, 500),
              commitMessage: input.commitMessage,
              attribution: employeeAttribution,
              createdAt: new Date().toISOString()
            }
            const nodeFingerprint = createNodeWithIntentLedgerFingerprint(nodeCommand)
            const nodeLedgerCommand = { ...nodeCommand, fingerprint: nodeFingerprint }
            const tagRequestIdentity = `calendar-concierge:person-tag:${observation.id}`
            const tagCommand: AssignTagLedgerCommandInput = {
              requestIdentity: tagRequestIdentity,
              requestId: tagRequestIdentity,
              fingerprint: "",
              workspaceId,
              principal: `workforce:employee:${grant.microEmployee.id}`,
              policy: "calendar-concierge-v1",
              nodeId: personId,
              tagId: BaseTagIds.Person,
              commitMessage: input.commitMessage,
              attribution: employeeAttribution,
              createdAt: new Date().toISOString()
            }
            const tagFingerprint = assignTagLedgerFingerprint(tagCommand)
            const tagLedgerCommand = { ...tagCommand, fingerprint: tagFingerprint }
            const factRequestIdentity = `calendar-concierge:person-email:${observation.id}`
            const factCommand: AddFactLedgerCommandInput = {
              requestIdentity: factRequestIdentity,
              requestId: factRequestIdentity,
              fingerprint: "",
              workspaceId,
              principal: `workforce:employee:${grant.microEmployee.id}`,
              policy: "calendar-concierge-v1",
              nodeId: personId,
              predicateId: "email",
              value: attendee.email,
              factId,
              commitMessage: input.commitMessage,
              attribution: employeeAttribution,
              createdAt: new Date().toISOString()
            }
            const factFingerprint = addFactLedgerFingerprint(factCommand)
            const factLedgerCommand = { ...factCommand, fingerprint: factFingerprint }
            let nodeOutput: CreateNodeOutput | undefined
            this.#storage.transactionSync(() => {
              nodeOutput = this.#ledger.executeV2({
                requestIdentity: nodeRequestIdentity,
                fingerprint: nodeFingerprint,
                type: "createNodeWithIntent",
                mutate: () => {
                  const existing = Effect.runSyncExit(repository.get(personId))
                  if (Exit.isSuccess(existing)) throw new NodeAlreadyExists({ nodeId: personId })
                  const node = new NodeEntity({ id: personId, workspaceId, title: nodeCommand.title, createdAt: IsoDateTimeString.make(nodeCommand.createdAt) })
                  const persisted = Effect.runSyncExit(repository.put(node))
                  if (Exit.isFailure(persisted)) throw domainErrorFromCause(persisted.cause)
                  const projections = Effect.runSyncExit(Effect.gen(function* () {
                    yield* upsertNode(sql, persisted.value)
                    yield* indexNodeText(sql, persisted.value.id, persisted.value.title, "")
                    yield* syncFeed.append("node", persisted.value.id, "put", persisted.value)
                  }))
                  if (Exit.isFailure(projections)) throw domainErrorFromCause(projections.cause)
                  Effect.runSync(calendarCollections.calendarDerivedNodes.put({ nodeId: personId, workspaceId }))
                  return new CreateNodeOutput({ node: persisted.value })
                },
                encodeOutput: (output) => Schema.encodeSync(CreateNodeOutput)(output),
                decodeOutput: (output) => Schema.decodeUnknownSync(CreateNodeOutput)(output),
                appendCommand: () => this.#ledger.appendCreateNodeWithIntent(nodeLedgerCommand),
                appendCustody: () => this.#ledger.appendCustody(custodyFor({ requestIdentity: nodeRequestIdentity, fingerprint: nodeFingerprint, type: "createNodeWithIntent", targetId: personId })),
                validateReplayCustody: () => this.#ledger.validateCustody(custodyFor({ requestIdentity: nodeRequestIdentity, fingerprint: nodeFingerprint, type: "createNodeWithIntent", targetId: personId })),
                appendSideEffects: () => {
                  const payload = { nodeId: personId, observationId: observation.id }
                  this.#ledger.appendEvent(nodeRequestIdentity, "calendar-concierge-person-created", payload)
                  this.#ledger.appendOutbox(nodeRequestIdentity, "calendar-concierge-person-created", payload)
                }
              })
              this.#ledger.executeV2({
                requestIdentity: tagRequestIdentity,
                fingerprint: tagFingerprint,
                type: "assignTag",
                mutate: () => new AssignTagOutput({ nodeId: personId, tagId: BaseTagIds.Person, changed: this.#runtime.runSync(graph.assignTag(workspaceId, personId, BaseTagIds.Person)) }),
                encodeOutput: (output) => Schema.encodeSync(AssignTagOutput)(output),
                decodeOutput: (output) => Schema.decodeUnknownSync(AssignTagOutput)(output),
                appendCommand: () => this.#ledger.appendAssignTag(tagLedgerCommand),
                appendCustody: () => this.#ledger.appendCustody(custodyFor({ requestIdentity: tagRequestIdentity, fingerprint: tagFingerprint, type: "assignTag", targetId: personId })),
                validateReplayCustody: () => this.#ledger.validateCustody(custodyFor({ requestIdentity: tagRequestIdentity, fingerprint: tagFingerprint, type: "assignTag", targetId: personId })),
                appendSideEffects: () => {
                  const payload = { nodeId: personId, tagId: BaseTagIds.Person }
                  this.#ledger.appendEvent(tagRequestIdentity, "calendar-concierge-person-tagged", payload)
                  this.#ledger.appendOutbox(tagRequestIdentity, "calendar-concierge-person-tagged", payload)
                }
              })
              this.#ledger.executeV2({
                requestIdentity: factRequestIdentity,
                fingerprint: factFingerprint,
                type: "addFact",
                mutate: () => new AddFactOutput({ fact: this.#runtime.runSync(graph.addFact(workspaceId, personId, "email", attendee.email, factId)) }),
                encodeOutput: (output) => Schema.encodeSync(AddFactOutput)(output),
                decodeOutput: (output) => Schema.decodeUnknownSync(AddFactOutput)(output),
                appendCommand: () => this.#ledger.appendAddFact(factLedgerCommand),
                appendCustody: () => this.#ledger.appendCustody(custodyFor({ requestIdentity: factRequestIdentity, fingerprint: factFingerprint, type: "addFact", targetId: personId })),
                validateReplayCustody: () => this.#ledger.validateCustody(custodyFor({ requestIdentity: factRequestIdentity, fingerprint: factFingerprint, type: "addFact", targetId: personId })),
                appendSideEffects: () => {
                  const payload = { nodeId: personId, factId }
                  this.#ledger.appendEvent(factRequestIdentity, "calendar-concierge-person-email", payload)
                  this.#ledger.appendOutbox(factRequestIdentity, "calendar-concierge-person-email", payload)
                }
              })
            })
            if (nodeOutput === undefined) throw new Error("calendar concierge did not create a Person")
            return { personId }
          },
          recordCalendarRelationshipObservation: (input) => {
            const requestIdentity = `calendar-concierge:relationship:${observation.id}:${input.personId}`
            const command = {
              requestIdentity,
              requestId: requestIdentity,
              fingerprint: "",
              workspaceId: this.#workspaceId,
              principal: `workforce:employee:${grant.microEmployee.id}`,
              policy: "calendar-concierge-v1",
              calendarEventId: observation.calendarEventId,
              sourceRevisionDigest: revision.sourceRevisionDigest,
              attendeeObservationDigests: [observation.emailDigest],
              commitMessage: input.commitMessage,
              attribution: employeeAttribution,
              createdAt: new Date().toISOString()
            }
            const fingerprint = calendarProjectionLedgerFingerprint(command)
            this.#storage.transactionSync(() => this.#ledger.executeV2({
              requestIdentity,
              fingerprint,
              type: "calendarProjection",
              mutate: () => {
                const current = Effect.runSync(calendarCollections.calendarAttendeeObservations.get(observation.id))
                if (current === undefined || current.sourceRevisionDigest !== revision.sourceRevisionDigest || !observationStillCurrent()) throw new Error("calendar observation is stale")
                const personNodeId = Schema.decodeUnknownSync(EntityId)(input.personId)
                Effect.runSync(calendarCollections.calendarAttendeeObservations.put({ ...current, personNodeId }))
                const currentEventRaw = Effect.runSync(calendarCollections.calendarEvents.get(observation.calendarEventId))
                if (currentEventRaw === undefined) throw new Error("calendar event is missing")
                const currentEvent = Effect.runSync(reviveCalendarEvent(currentEventRaw))
                const updatedEvent = new CalendarEvent({
                  ...currentEvent,
                  attendees: currentEvent.attendees.map((candidate) =>
                    candidate.email.trim().toLowerCase() === attendee.email
                      ? new CalendarEventAttendee({ ...candidate, personNodeId })
                      : candidate
                  )
                })
                Effect.runSync(calendarCollections.calendarEvents.put(updatedEvent))
                const syncFeed = this.#runtime.runSync(Effect.gen(function* () { return yield* SyncFeedService }))
                Effect.runSync(syncFeed.append("calendarEvent", updatedEvent.id, "put", updatedEvent))
                return { personId: input.personId }
              },
              encodeOutput: (output) => output,
              decodeOutput: (output) => output as { readonly personId: string },
              appendCommand: () => this.#ledger.appendCalendarProjection({ ...command, fingerprint }),
              appendCustody: () => this.#ledger.appendCustody(custodyFor({ requestIdentity, fingerprint, type: "calendarProjection", targetId: observation.calendarEventId })),
              validateReplayCustody: () => this.#ledger.validateCustody(custodyFor({ requestIdentity, fingerprint, type: "calendarProjection", targetId: observation.calendarEventId })),
              appendSideEffects: () => {
                const payload = { observationId: observation.id, personId: input.personId }
                this.#ledger.appendEvent(requestIdentity, "calendar-concierge-relationship-recorded", payload)
                this.#ledger.appendOutbox(requestIdentity, "calendar-concierge-relationship-recorded", payload)
              }
            }))
          },
          publishRunTerminal: (input) => {
            stagedTerminal = { result: input.result, reportText: input.reportText, commitMessage: input.commitMessage }
            return { publicationId: `calendar-concierge-publication:${run.id}` }
          }
        }
        const resolver: CalendarConciergeGrantResolver = {
          resolve: (token) => this.#calendarConciergeGrants.resolve(token),
          recheckFresh: (candidate, expected) => {
            if (this.#calendarConciergeGrants.isConsumed(candidate.grantId)) return { status: "denied" }
            const current = this.#workforceRuntimeStore.get(expected.runId)
            return observationStillCurrent() && current !== undefined && current.state === "claimed" && current.claimToken === expected.claimToken && current.attempts === expected.claimFence && current.workflowId === CALENDAR_RELATIONSHIP_CONCIERGE_WORKFLOW && current.leaseExpiresAt !== null && Date.parse(current.leaseExpiresAt) > Date.now()
              ? { status: "admitted" }
              : { status: "denied" }
          }
        }
        const execution: CalendarConciergeExecutionAdapter = {
          assertLiveClaim: (expected) => {
            const current = this.#workforceRuntimeStore.get(expected.runId)
            return observationStillCurrent() && current !== undefined && current.state === "claimed" && current.claimToken === expected.claimToken && current.attempts === expected.claimFence && current.leaseExpiresAt !== null && Date.parse(current.leaseExpiresAt) > Date.now()
              ? { status: "admitted" }
              : { status: "denied" }
          }
        }
        const finalize = async (input: Readonly<{ result: CalendarConciergeTerminalResult; reportText: string; commitMessage: string; publicationId: string }>): Promise<void> => {
          if (stagedTerminal === undefined || stagedTerminal.result !== input.result || stagedTerminal.reportText !== input.reportText || stagedTerminal.commitMessage !== input.commitMessage) throw new Error("calendar concierge terminal publication was not staged by the capability")
          if (!observationStillCurrent()) throw new Error("calendar observation was cancelled or superseded before finalization")
          await calendarConciergeAdmissionTestHook.beforeAdmission?.({
            workspaceId: this.#workspaceId,
            runId: run.id,
            claimFence: run.attempts,
            leaseExpiresAt: run.leaseExpiresAt!,
            reclaimClaim: (now, leaseMs) => {
              const replacementToken = crypto.randomUUID()
              const replacement = this.#storage.transactionSync(() => this.#workforceRuntimeStore.claimDue(
                now,
                `test:calendar-concierge:${crypto.randomUUID()}`,
                replacementToken,
                leaseMs,
                [CALENDAR_RELATIONSHIP_CONCIERGE_WORKFLOW]
              ))
              return replacement === undefined
                ? null
                : Object.freeze({
                    id: replacement.id,
                    state: replacement.state,
                    attempts: replacement.attempts,
                    leaseExpiresAt: replacement.leaseExpiresAt
                  })
            }
          })
          const civilDate = calendarCivilDate(event)
          const bundle = calendarConciergeBundle({ runId: run.id, occurrenceId: run.occurrenceId, civilDate, result: { kind: input.result, summary: input.reportText } })
          const receipt = await this.admitWorkforceRun({
            workspaceId: this.#workspaceId,
            bundle,
            reportText: input.reportText,
            claim: { runId: run.id, claimToken: run.claimToken!, claimFence: run.attempts }
          })
          if (receipt.resultKind !== input.result || receipt.runId !== run.id) throw new Error("calendar concierge admission receipt does not match the claimed run")
          if (!this.#calendarConciergeGrants.consume(grant.grantId, issued.token)) throw new Error("calendar concierge grant was already consumed")
        }
        return {
          grant: issued.grant,
          token: issued.token,
          binding,
          resolver,
          execution,
          port,
          attendeeEmail: attendee.email,
          ...(attendee.displayName === undefined ? {} : { attendeeDisplayName: attendee.displayName }),
          finalize
        }
      }
    }
    const calendarConciergeExecutor = new CalendarConciergeExecutor(this.#workspaceId, this.#workforceRuntimeStore, calendarCollections, calendarConciergeIntegration)
    this.#workforceScheduler.setExecutor(
      (run) => calendarConciergeExecutor.execute(run),
      ["calendar-relationship-concierge"]
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
      loroPageServiceLive,
      chatForkServiceLive,
      agentLoroEditServiceLive,
      pageProposalServiceLive,
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

  /** One DO alarm multiplexes durable workforce wakeups. Claim CAS makes this safe against a
   * concurrent manual drain; a future executor is registered only by its owning package. */
  async alarm(): Promise<void> {
    await this.#workforceScheduler.drain(`alarm:${this.#workspaceId}`)
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
          this.env.DEV_AUTH_HMAC_SECRET,
          this.#storage,
          this.#standupPublicationStore,
          this.#workforceRunStore
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
          this.env.DEV_AUTH_HMAC_SECRET,
          this.#storage,
          this.#standupPublicationStore,
          this.#workforceRunStore
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

  /**
   * P5.1's only capture entrypoint. This is a `ctx.exports`-only trusted internal seam, never a
   * Cap'n Web `WorkspaceRpcApi` method: it lets the eventual authorised command owner invoke one
   * complete synchronous DO transaction, while tests exercise the actual transaction/rollback
   * boundary without granting connected clients a reservation capability.
   */
  async debugCaptureAgentChangeProposal(input: unknown): Promise<unknown> {
    const decoded = Schema.decodeUnknownSync(Schema.Struct({
      chatId: EntityId,
      operation: Schema.Literal("merge", "revert"),
      rangeBoundary: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
      requestId: Schema.String.pipe(Schema.minLength(1)),
      actor: Schema.String.pipe(Schema.minLength(1)),
      provenance: Schema.String.pipe(Schema.minLength(1))
    }))(input)
    const program = AgentEditService.pipe(
      Effect.flatMap((agentEdit) => Effect.try({
        try: () => this.#storage.transactionSync(() => {
          const exit = Effect.runSyncExit(agentEdit.captureProposalAndReserve(decoded))
          if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
          return exit.value
        }),
        catch: (error): DomainError => error instanceof ValidationError || error instanceof UnexpectedError
          ? error : new UnexpectedError({ message: `agent change capture transaction failed: ${error instanceof Error ? error.message : String(error)}` })
      }))
    )
    const captured = await runOrThrowRpcError(this.#runtime, program)
    return Schema.encodeSync(AgentChangeProposal)(captured)
  }

  /** Read-only `ctx.exports` inspection paired with `debugCaptureAgentChangeProposal`; no public
   * client route or mutation-routing-manifest entry is added in P5.1. */
  async debugGetAgentChangeProposal(requestId: string): Promise<unknown | null> {
    const captured = await runOrThrowRpcError(
      this.#runtime,
      AgentEditService.pipe(Effect.flatMap((agentEdit) => agentEdit.capturedProposalForRequest(requestId)))
    )
    return captured === undefined ? null : Schema.encodeSync(AgentChangeProposal)(captured)
  }

  /** Test-only trusted caller for the real crash-reconciliation path. It deliberately remains
   * outside `WorkspaceRpcApi`, where an arbitrary connected client could not trigger it. */
  async debugReconcileAgentChanges(chatId: string): Promise<{ readonly reAdopted: number; readonly reaped: number }> {
    const decodedChatId = Schema.decodeUnknownSync(EntityId)(chatId)
    return runOrThrowRpcError(
      this.#runtime,
      AgentEditService.pipe(Effect.flatMap((agentEdit) => agentEdit.reconcilePendingChanges(decodedChatId)))
    )
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

  /** Test-only inspection of the transitional local ledger. It is deliberately native-RPC-only:
   * receipts are an operational audit artifact, not part of the existing public client contract. */
  async debugGetLedgerReceipt(requestIdentity: string): Promise<unknown | null> {
    const row = this.#sql.exec<{ fingerprint: string; output: string }>(
      "SELECT fingerprint, output FROM ledger_receipts WHERE requestIdentity = ?", requestIdentity
    ).toArray()[0]
    return row === undefined ? null : { fingerprint: row.fingerprint, output: JSON.parse(row.output) }
  }

  async debugGetLedgerCommand(requestIdentity: string): Promise<unknown | null> {
    const row = this.#sql.exec<{
      version: string; requestId: string; fingerprint: string; type: string; workspaceId: string;
      principal: string; capability: string; policy: string; messageDerivationVersion: string;
      message: string; payload: string; createdAt: string
    }>(
      `SELECT version, requestId, fingerprint, type, workspaceId, principal, capability, policy,
              messageDerivationVersion, message, payload, createdAt
       FROM ledger_commands WHERE requestIdentity = ?`,
      requestIdentity
    ).toArray()[0]
    return row === undefined ? null : { ...row, payload: JSON.parse(row.payload) }
  }

  async debugGetLedgerEvent(requestIdentity: string): Promise<unknown | null> {
    const row = this.#sql.exec<{ kind: string; payload: string }>(
      "SELECT kind, payload FROM ledger_events WHERE requestIdentity = ?",
      requestIdentity
    ).toArray()[0]
    return row === undefined ? null : { kind: row.kind, payload: JSON.parse(row.payload) }
  }

  async debugGetLedgerOutboxIntent(requestIdentity: string): Promise<unknown | null> {
    const row = this.#sql.exec<{ kind: string; payload: string }>(
      "SELECT kind, payload FROM ledger_outbox_intents WHERE requestIdentity = ?",
      requestIdentity
    ).toArray()[0]
    return row === undefined ? null : { kind: row.kind, payload: JSON.parse(row.payload) }
  }

  /** Test-only inspection of the immutable actor/target custody row. This stays on the native
   * `ctx.exports` surface so public clients can consume only the privacy-safe activity projection,
   * never chat, job, grant, or tool correlation identifiers. */
  async debugGetLedgerCustody(requestIdentity: string): Promise<unknown | null> {
    const row = this.#sql.exec<{
      requestIdentity: string; fingerprint: string; type: string; workspaceId: string
      actorKind: string; actorLabel: string; employeeId: string | null; jobId: string | null
      runId: string | null; grantId: string | null; chatId: string | null; toolCallId: string | null
      targetKind: string; targetId: string
    }>(`SELECT requestIdentity, fingerprint, type, workspaceId, actorKind, actorLabel,
      employeeId, jobId, runId, grantId, chatId, toolCallId, targetKind, targetId
      FROM ledger_custody WHERE requestIdentity = ?`, requestIdentity).toArray()[0]
    if (row === undefined) return null
    return {
      ...row,
      employeeId: row.employeeId ?? undefined,
      jobId: row.jobId ?? undefined,
      runId: row.runId ?? undefined,
      grantId: row.grantId ?? undefined,
      chatId: row.chatId ?? undefined,
      toolCallId: row.toolCallId ?? undefined
    }
  }

  /** Test-only aggregate witness for routes which intentionally have no ledger request identity. */
  async debugGetLedgerArtifactCounts(): Promise<{
    readonly commands: number
    readonly receipts: number
    readonly events: number
    readonly outboxIntents: number
  }> {
    const count = (table: string): number => this.#sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).one().count
    return {
      commands: count("ledger_commands"),
      receipts: count("ledger_receipts"),
      events: count("ledger_events"),
      outboxIntents: count("ledger_outbox_intents")
    }
  }

  /** Test-only compact command index used by replay regressions; payloads stay private. */
  async debugListLedgerCommandIdentities(): Promise<ReadonlyArray<Readonly<{
    readonly requestIdentity: string
    readonly fingerprint: string
    readonly type: string
  }>>> {
    return this.#sql.exec<{
      requestIdentity: string
      fingerprint: string
      type: string
    }>("SELECT requestIdentity, fingerprint, type FROM ledger_commands ORDER BY requestIdentity").toArray().map((row) => Object.freeze({ ...row }))
  }

  /**
   * Test-only transaction harness for the durable standup authority adapter. It accepts a bundle
   * already produced by the dormant private publication service's in-memory contract and stages
   * the same seven records through the real Workspace DO SQL transaction. This deliberately does
   * not resolve a bearer, create a grant, publish a worker report, or enter `WorkspaceRpcApi`; it
   * only gives the Miniflare suite a trusted internal seam for proving durable commit/rollback and
   * reconstruction without activating the workforce writer in production.
   */
  async debugStageStandupPublication(
    input: unknown,
  ): Promise<
    | Readonly<{ status: "staged" }>
    | Readonly<{ status: "rejected"; message: string }>
  > {
    try {
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new ValidationError({
          message: "standup publication fixture must be an object",
        })
      }
      const fixture = input as {
        readonly grantConsumption: StandupPublicationGrantConsumptionV1
        readonly publication: StandupPublicationRecordV1
        readonly companionPage: StandupPublicationCompanionPageV1
        readonly companion: StandupPublicationCompanionLinkV1
        readonly request: StandupPublicationAuthorityRequestV1
        readonly event: StandupPublicationEventV1
        readonly outbox: StandupPublicationOutboxIntentV1
        readonly failAt?: string
      }
      const fail = (stage: string): void => {
        if (fixture.failAt === stage)
          throw new Error(`standup publication fixture failure at ${stage}`)
      }
      this.#standupPublicationStore.transactionSync((transaction) => {
        transaction.stageGrantConsumption(fixture.grantConsumption)
        fail("grant-consumption")
        transaction.stagePublication(fixture.publication)
        fail("publication")
        transaction.stageCompanionPage(fixture.companionPage)
        fail("companion-page")
        transaction.stageCompanion(fixture.companion)
        fail("companion")
        transaction.stageAuthorityRequest(fixture.request)
        fail("receipt")
        transaction.stageEvent(fixture.event)
        fail("event")
        transaction.stageOutboxIntent(fixture.outbox)
        fail("outbox")
      })
      return { status: "staged" }
    } catch (cause) {
      return {
        status: "rejected",
        message:
          cause instanceof Error
            ? cause.message
            : "standup publication fixture rejected",
      }
    }
  }

  /**
   * Trusted workforce-run admission. This method is intentionally a native Durable Object
   * export only: it is not part of `WorkspaceRpcApi`, the Worker HTTP surface, or browser DTOs.
   * A future scheduler/agent host may call this same-Worker boundary, but every accepted run
   * must first pass the immutable bundle checks and then commit its node, real Loro companion,
   * standup authority records, and terminal receipt in one SQLite transaction. The only action
   * after commit is publishing the prepared Loro document to the service cache; replay never
   * restores historical report bytes and never recreates a deleted child page.
   */
  async admitWorkforceRun(input: unknown): Promise<WorkforceRunReceiptOutputV1> {
    const ownWorkspaceId = this.#workspaceId
    const standupPublicationStore = this.#standupPublicationStore
    const workforceRunStore = this.#workforceRunStore
    const workforceRuntimeStore = this.#workforceRuntimeStore
    const sql = this.#sql
    const ledger = this.#ledger
    const storage = this.#storage
    const program = decodeRpcInput(AdmitWorkforceRunInput, input).pipe(
      Effect.tap((decoded) => requireOwnWorkspace(ownWorkspaceId, decoded.workspaceId)),
      Effect.flatMap((decoded) => Effect.try({
        try: () => ({ admission: decodeWorkforceRunAdmission(decoded), claim: decoded.claim }),
        catch: (error): DomainError => error instanceof WorkforceRunAdmissionError
          ? new ValidationError({ message: error.message })
          : new UnexpectedError({ message: `workforce run admission failed: ${error instanceof Error ? error.message : String(error)}` })
      })),
      Effect.flatMap(({ admission, claim }) => Effect.gen(function* () {
        const repository = yield* NodesRepository
        const syncFeed = yield* SyncFeedService
        const loro = yield* LoroPageService
        const loroGateway = new WorkspaceLoroMutationGateway(ledger, loro, storage)
        const workspaceId = Schema.decodeUnknownSync(EntityId)(admission.workspaceId)
        const now = new Date().toISOString()
        const request = Object.freeze({ version: STANDUP_PRIVATE_REQUEST_VERSION, originalText: admission.reportText })
        const commitMessage = Schema.decodeUnknownSync(MutationCommitMessage)(admission.commitMessage)
        const attribution = new AgentJobMutationAttribution({
          version: "athenaeum.mutation-attribution.v1",
          kind: "agentJob",
          jobId: admission.terminal.run.job.id,
          runId: admission.terminal.run.runId
        })
        let postCommitCandidate: LoroDoc | undefined
        let pageFinalize: (() => void) | undefined
        const result = yield* Effect.try({
          try: () => standupPublicationStore.transactionSync((transaction) => {
            if (claim !== undefined) {
              if (claim.runId !== admission.terminal.run.runId) {
                throw new WorkforceRunConflictError("workforce claim is bound to a different run")
              }
              const claimNow = new Date()
              const claimed = workforceRuntimeStore.finishClaim(
                claim.runId,
                claim.claimToken,
                claim.claimFence,
                admission.terminal.result.kind,
                claimNow,
                admission.reportText
              )
              if (!claimed) {
                throw new WorkforceRunConflictError("workforce run claim is stale or expired")
              }
            }
            const identityReceipt = workforceRunStore.get(admission.requestIdentity)
            const slotReceipt = workforceRunStore.getBySlot(
              admission.workspaceId,
              admission.terminal.run.runId,
              admission.terminal.occurrence.occurrenceId
            )
            if (identityReceipt !== undefined && slotReceipt !== undefined && identityReceipt.requestIdentity !== slotReceipt.requestIdentity) {
              throw new WorkforceRunConflictError("run slot has multiple receipt identities")
            }
            const existing = identityReceipt ?? slotReceipt
            if (existing !== undefined && (
              existing.workspaceId !== admission.workspaceId ||
              existing.requestIdentity !== admission.requestIdentity ||
              existing.admissionFingerprint !== admission.admissionFingerprint ||
              existing.definitionBundleDigest !== admission.bundleDigest ||
              existing.definitionBundle !== admission.bundleCanonical ||
              existing.terminalEventDigest !== admission.terminalEventDigest ||
              existing.terminalFactDigest !== admission.terminalFactDigest ||
              existing.reportDigest !== admission.reportDigest ||
              existing.reportByteLength !== admission.reportByteLength ||
              existing.resultSummary !== admission.terminal.result.summary ||
              existing.commitMessage !== admission.commitMessage
            )) throw new WorkforceRunConflictError()

            const grant = existing?.grant ?? grantForWorkforceAdmission(
              admission,
              now,
              `workforce-run-grant:${admission.requestIdentity}`
            )
            const intent = resolvePrivatePublicationIntent(grant, request)
            const childNodeId = Schema.decodeUnknownSync(EntityId)(intent.childNodeId)
            if (
              intent.requestIdentity !== admission.requestIdentity ||
              intent.grant.workspaceId !== ownWorkspaceId ||
              intent.grant.dailyNoteId !== admission.dailyNoteId
            ) throw new WorkforceRunConflictError("derived publication identity does not match the admitted run")
            const committedAuthority = transaction.committedRequestFor(intent.slotDigest)
            if (existing === undefined && committedAuthority !== undefined) {
              throw new WorkforceRunConflictError("standup authority already owns this run slot")
            }
            if (existing !== undefined && committedAuthority === undefined) {
              throw new WorkforceRunConflictError("workforce receipt exists but standup authority receipt is missing")
            }

            let currentText: string | undefined
            const descriptorKey = (descriptor: PageDocumentDescriptor): string => {
              if (descriptor.activeFormat !== "loro-v1" || descriptor.loro === undefined) throw new Error("workforce companion is not a Loro page")
              return JSON.stringify({
                activeFormat: descriptor.activeFormat,
                nodeId: descriptor.nodeId,
                storageVersion: descriptor.storageVersion,
                loro: {
                  schemaVersion: descriptor.loro.schemaVersion,
                  snapshotSha256: descriptor.loro.snapshotSha256
                }
              })
            }
            const preparedFromActivation = (activation: {
              readonly descriptor: PageDocumentDescriptor
              readonly candidate: LoroDoc
              readonly text: string
            }): PreparedStandupCompanionPage => {
              const text = canonicalStandupPublicationText(activation.text)
              if (existing === undefined && text.sha256 !== intent.originalTextDigest) {
                throw new WorkforceRunConflictError("new companion content is not bound to the terminal report")
              }
              postCommitCandidate = activation.candidate
              currentText = activation.text
              return Object.freeze({
                format: "loro-v1",
                childNodeId: intent.childNodeId,
                originalTextDigest: intent.originalTextDigest,
                preparedDescriptor: descriptorKey(activation.descriptor),
                contentUtf8: activation.text,
                contentDigest: text.sha256,
                contentByteLength: text.byteLength
              })
            }
            const companion = {
              prepare: (companionInput: Readonly<{
                readonly childNodeId: string
                readonly originalText: string
                readonly originalTextDigest: string
              }>): PreparedStandupCompanionPage => {
                if (existing !== undefined) throw new WorkforceRunConflictError("workforce receipt exists but standup authority replay is missing")
                if (
                  companionInput.childNodeId !== intent.childNodeId ||
                  companionInput.originalText !== intent.originalText ||
                  companionInput.originalTextDigest !== intent.originalTextDigest
                ) throw new WorkforceRunConflictError("companion input is not the admitted terminal report")

                const existingNode = Effect.runSyncExit(repository.get(childNodeId))
                if (Exit.isSuccess(existingNode)) throw new WorkforceRunConflictError("deterministic workforce child node already exists")
                const missingNode = domainErrorFromCause(existingNode.cause)
                if (!(missingNode instanceof NodeNotFound)) throw missingNode

                const nodeRequestIdentity = `workforce-node:${admission.requestIdentity}`
                const nodeCommandBase: CreateNodeWithIntentLedgerCommandInput = {
                  requestIdentity: nodeRequestIdentity,
                  requestId: nodeRequestIdentity,
                  fingerprint: "",
                  workspaceId: admission.workspaceId,
                  principal: intent.grant.subject,
                  policy: "workforce-authority-v1",
                  nodeId: childNodeId,
                  requestedNodeId: childNodeId,
                  title: `${intent.grant.microEmployeeLabel} — ${intent.grant.jobLabel} — ${intent.grant.civilDate}`.slice(0, 500),
                  commitMessage,
                  attribution,
                  createdAt: now
                }
                const nodeCommand = Object.freeze({
                  ...nodeCommandBase,
                  fingerprint: createNodeWithIntentLedgerFingerprint(nodeCommandBase)
                })
                const nodeOutput = ledger.executeV2<CreateNodeOutput>({
                  requestIdentity: nodeCommand.requestIdentity,
                  fingerprint: nodeCommand.fingerprint,
                  type: "createNodeWithIntent",
                  mutate: () => {
                    const current = Effect.runSyncExit(repository.get(childNodeId))
                    if (Exit.isSuccess(current)) throw new NodeAlreadyExists({ nodeId: childNodeId })
                    const error = domainErrorFromCause(current.cause)
                    if (!(error instanceof NodeNotFound)) throw error
                    const node = new NodeEntity({
                      id: childNodeId,
                      workspaceId,
                      title: nodeCommand.title,
                      createdAt: Schema.decodeUnknownSync(IsoDateTimeString)(now)
                    })
                    const persisted = Effect.runSyncExit(repository.put(node))
                    if (Exit.isFailure(persisted)) throw domainErrorFromCause(persisted.cause)
                    const projections = Effect.runSyncExit(Effect.gen(function* () {
                      yield* upsertNode(sql, persisted.value)
                      yield* indexNodeText(sql, persisted.value.id, persisted.value.title, "")
                      yield* syncFeed.append("node", persisted.value.id, "put", persisted.value)
                    }))
                    if (Exit.isFailure(projections)) throw domainErrorFromCause(projections.cause)
                    return new CreateNodeOutput({ node: persisted.value })
                  },
                  encodeOutput: (output: CreateNodeOutput) => Schema.encodeSync(CreateNodeOutput)(output),
                  decodeOutput: (output: unknown) => Schema.decodeUnknownSync(CreateNodeOutput)(output),
                  appendCommand: () => ledger.appendCreateNodeWithIntent(nodeCommand),
                  appendSideEffects: () => {
                    const payload = { nodeId: childNodeId, runId: intent.grant.runId }
                    ledger.appendEvent(nodeRequestIdentity, "workforce-node-created", payload)
                    ledger.appendOutbox(nodeRequestIdentity, "workforce-node-created", payload)
                  }
                })
                if (nodeOutput.node.id !== childNodeId || nodeOutput.node.workspaceId !== admission.workspaceId) {
                  throw new WorkforceRunConflictError("workforce node ledger receipt is not bound to the admitted workspace")
                }

                const pageRequestIdentity = `workforce-loro:${admission.requestIdentity}`
                const pageCommandBase: EnsureLoroPageLedgerCommandInput = {
                  requestIdentity: pageRequestIdentity,
                  requestId: pageRequestIdentity,
                  fingerprint: "",
                  workspaceId: admission.workspaceId,
                  principal: intent.grant.subject,
                  policy: "workforce-authority-v1",
                  nodeId: childNodeId,
                  outcome: "created",
                  storageVersion: 1,
                  schemaVersion: 1,
                  commitMessage,
                  attribution,
                  createdAt: now
                }
                const pageCommandFingerprint = ensureLoroPageLedgerFingerprint(pageCommandBase)
                let freshActivation: { readonly descriptor: PageDocumentDescriptor; readonly candidate: LoroDoc } | undefined
                const pageResult = loroGateway.ensurePageWithinTransaction({
                  requestIdentity: pageRequestIdentity,
                  fingerprint: pageCommandFingerprint,
                  command: pageCommandBase,
                  eventKind: "workforce-loro-created",
                  custody: {
                    requestIdentity: pageRequestIdentity, fingerprint: pageCommandFingerprint,
                    type: "ensureLoroPage", workspaceId: admission.workspaceId,
                    actorKind: "employee",
                    actorLabel: `${intent.grant.microEmployeeLabel} · ${intent.grant.jobLabel}`.slice(0, 200),
                    employeeId: intent.grant.microEmployee.id, jobId: intent.grant.job.id,
                    runId: intent.grant.runId, grantId: intent.grant.grantId,
                    targetKind: "node", targetId: childNodeId
                  },
                  initialText: intent.originalText
                })
                pageFinalize = pageResult.finalize
                const pageRecord = pageResult.output.descriptor
                if (pageRecord.activeFormat !== "loro-v1" || pageRecord.loro === undefined) {
                  throw new WorkforceRunConflictError("workforce companion did not produce a native Loro descriptor")
                }
                const current = Effect.runSyncExit(loro.prepareCurrent(childNodeId))
                if (Exit.isFailure(current)) throw domainErrorFromCause(current.cause)
                if (
                  current.value.descriptor.activeFormat !== "loro-v1" ||
                  current.value.descriptor.loro === undefined ||
                  current.value.descriptor.storageVersion !== pageRecord.storageVersion ||
                  current.value.descriptor.loro.snapshotSha256 !== pageRecord.loro.snapshotSha256
                ) throw new WorkforceRunConflictError("Loro activation receipt does not match the durable page")
                freshActivation = current.value
                return preparedFromActivation({
                  descriptor: freshActivation.descriptor,
                  candidate: freshActivation.candidate,
                  text: currentText ?? intent.originalText
                })
              },
              restore: (restoreInput: Readonly<{
                readonly publication: StandupPublicationRecordV1
                readonly link: StandupPublicationCompanionLinkV1
                readonly page: StandupPublicationCompanionPageV1
              }>): PreparedStandupCompanionPage | undefined => {
                const current = Effect.runSyncExit(loro.prepareCurrent(childNodeId))
                if (Exit.isFailure(current)) {
                  const error = domainErrorFromCause(current.cause)
                  if (error instanceof NodeNotFound || error instanceof PageNotFound || error instanceof PageFormatMismatch) return undefined
                  throw error
                }
                if (
                  restoreInput.publication.workspaceId !== admission.workspaceId ||
                  restoreInput.link.childNodeId !== intent.childNodeId ||
                  restoreInput.page.childNodeId !== intent.childNodeId ||
                  current.value.descriptor.nodeId !== intent.childNodeId ||
                  current.value.descriptor.activeFormat !== "loro-v1"
                ) throw new WorkforceRunConflictError("current Loro companion is not bound to the committed publication")
                return preparedFromActivation(current.value)
              },
              publishAfterCommit: () => {
                if (pageFinalize !== undefined) pageFinalize()
                else loro.publishCommittedDocument(childNodeId, postCommitCandidate)
              }
            }
            const resolver = {
              resolve: (_token: OpaqueStandupRunGrantToken): ResolvedStandupRunGrantV1 => grant,
              recheckFresh: (candidate: ResolvedStandupRunGrantV1, context: Readonly<{ readonly now: string; readonly slotDigest: string; readonly grantAlreadyConsumed: boolean }>) =>
                candidate.grantId === grant.grantId && context.slotDigest === intent.slotDigest
                  ? { status: "admitted" as const }
                  : { status: "denied" as const }
            }
            const publicationService = new StandupPublicationService({
              resolver,
              store: standupPublicationStore,
              companion,
              clock: { now: () => now }
            })
            const committed: CommittedPublication = publicationService.publishWithinTransaction(
              {} as OpaqueStandupRunGrantToken,
              request,
              transaction
            )

            if (existing !== undefined) {
              if (
                committed.receipt.output.publicationId !== existing.publicationId ||
                committed.receipt.output.childNodeId !== existing.childNodeId ||
                committed.receipt.committedAt !== existing.committedAt
              ) throw new WorkforceRunConflictError("standup replay receipt does not match the workforce receipt")
              return { receipt: existing, prepared: committed.prepared, replayed: true as const }
            }

            const receipt: WorkforceRunReceiptV1 = Object.freeze({
              version: WORKFORCE_RUN_RECEIPT_VERSION,
              requestIdentity: admission.requestIdentity,
              admissionFingerprint: admission.admissionFingerprint,
              workspaceId: admission.workspaceId,
              runId: admission.terminal.run.runId,
              occurrenceId: admission.terminal.occurrence.occurrenceId,
              civilDate: admission.terminal.occurrence.civilDate,
              terminalEventId: admission.terminal.eventId,
              terminalEventDigest: admission.terminalEventDigest,
              terminalFactId: admission.terminalFact.factId,
              terminalFactDigest: admission.terminalFactDigest,
              resultKind: admission.terminal.result.kind,
              resultSummary: admission.terminal.result.summary,
              reportDigest: admission.reportDigest,
              reportByteLength: admission.reportByteLength,
              definitionBundleDigest: admission.bundleDigest,
              definitionBundle: admission.bundleCanonical,
              grant,
              commitMessage: admission.commitMessage,
              publicationId: committed.receipt.output.publicationId,
              dailyNoteId: committed.receipt.output.dailyNoteId,
              childNodeId: committed.receipt.output.childNodeId,
              custodyFingerprint: committed.receipt.custodyFingerprint,
              committedAt: committed.receipt.committedAt
            })
            workforceRunStore.stage(receipt)
            return { receipt, prepared: committed.prepared, replayed: false as const }
          }),
          catch: (error): DomainError =>
            error instanceof WorkforceRunAdmissionError || error instanceof WorkforceRunConflictError
              ? new ValidationError({ message: error.message })
              : isDomainError(error)
                ? error
                : new UnexpectedError({ message: `workforce run transaction failed: ${error instanceof Error ? error.message : String(error)}` })
        })
        if (result.prepared !== undefined) {
          const nodeId = Schema.decodeUnknownSync(EntityId)(result.receipt.childNodeId)
          yield* Effect.try({
            try: () => {
              if (pageFinalize !== undefined) pageFinalize()
              else loro.publishCommittedDocument(nodeId, postCommitCandidate)
            },
            catch: (error): DomainError => error instanceof UnexpectedError
              ? error
              : new UnexpectedError({ message: `workforce Loro cache publication failed: ${error instanceof Error ? error.message : String(error)}` })
          })
        }
        return publicWorkforceReceipt(result.receipt, result.replayed)
      }))
    )
    return runOrThrowRpcError(this.#runtime, program)
  }

  /** Test-only graph deletion seam. It intentionally leaves page rows behind so replay and the
   * public projection must prove that an orphaned Loro snapshot is not treated as a live child. */
  async debugDeleteWorkforceChild(nodeId: string): Promise<void> {
    const decodedNodeId = Schema.decodeUnknownSync(EntityId)(nodeId)
    await Effect.runPromise(this.#collections.nodes.delete(decodedNodeId))
  }

  /** Test-only hostile-storage seam for the receipt/public-projection boundary. It is deliberately
   * native-RPC-only and accepts just the two mismatches the durable reader must reject: a stored
   * terminal kind that disagrees with the immutable definition bundle, or a SQL workspace column
   * that disagrees with an otherwise valid receipt payload. */
  async debugCorruptWorkforceRunReceipt(
    publicationId: string,
    corruption: "resultKind" | "workspaceRow",
  ): Promise<void> {
    const decodedPublicationId = Schema.decodeUnknownSync(EntityId)(publicationId)
    const row = this.#sql.exec<{ value: string }>(
      "SELECT value FROM workforce_runs WHERE publicationId = ?",
      decodedPublicationId,
    ).toArray()[0]
    if (row === undefined) throw new Error("workforce receipt not found")
    if (corruption === "resultKind") {
      const receipt = JSON.parse(row.value) as { resultKind?: unknown }
      receipt.resultKind = receipt.resultKind === "completed" ? "failed" : "completed"
      this.#sql.exec(
        "UPDATE workforce_runs SET value = ? WHERE publicationId = ?",
        JSON.stringify(receipt),
        decodedPublicationId,
      )
      return
    }
    this.#sql.exec(
      "UPDATE workforce_runs SET workspaceId = ? WHERE publicationId = ?",
      "00000000-0000-4000-8000-000000000099",
      decodedPublicationId,
    )
  }

  /** Test-only aggregate witness for the workforce transaction. Collection rows and the SQL
   * ledger/authority rows are counted together so a failed admission can prove that no partial
   * node, Loro, index, feed, publication, receipt, or outbox state survived. */
  async debugGetWorkforceStorageCounts(): Promise<Readonly<Record<string, number>>> {
    const [nodes, formats, loroPages, feed] = await Promise.all([
      Effect.runPromise(this.#collections.nodes.list()),
      Effect.runPromise(this.#pageCollections.pageDocumentFormats.list()),
      Effect.runPromise(this.#pageCollections.loroPageDocs.list()),
      Effect.runPromise(this.#syncFeedCollections.syncFeedEntries.list())
    ])
    const count = (table: string): number => this.#sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).one().count
    return Object.freeze({
      nodes: nodes.length,
      pageDocumentFormats: formats.length,
      loroPages: loroPages.length,
      syncFeedEntries: feed.length,
      graphTextSearch: count("graph_text_search"),
      readModelNodes: count("rm_nodes"),
      workforceRuns: count("workforce_runs"),
      standupRequests: count("standup_publication_requests"),
      standupPublications: count("standup_publications"),
      standupCompanions: count("standup_publication_companions"),
      standupCompanionPages: count("standup_publication_companion_pages"),
      standupGrantConsumptions: count("standup_publication_grants"),
      standupEvents: count("standup_publication_events"),
      standupOutbox: count("standup_publication_outbox"),
      ledgerCommands: count("ledger_commands"),
      ledgerReceipts: count("ledger_receipts"),
      ledgerEvents: count("ledger_events"),
      ledgerOutboxIntents: count("ledger_outbox_intents")
    })
  }

  /** Test-only aggregate witness for the calendar projection transaction. The provider binding
   * itself is intentionally not counted: it is established before a sync and is not part of the
   * per-event projection transaction. */
  async debugGetCalendarStorageCounts(): Promise<Readonly<Record<string, number>>> {
    const [events, derivedNodes, revisions, observations] = await Promise.all([
      Effect.runPromise(this.#calendarCollections.calendarEvents.list()),
      Effect.runPromise(this.#calendarCollections.calendarDerivedNodes.list()),
      Effect.runPromise(this.#calendarCollections.calendarSourceRevisions.list()),
      Effect.runPromise(this.#calendarCollections.calendarAttendeeObservations.list())
    ])
    return Object.freeze({
      calendarEvents: events.length,
      calendarDerivedNodes: derivedNodes.length,
      calendarSourceRevisions: revisions.length,
      calendarAttendeeObservations: observations.length
    })
  }

  /** Test-only visibility into the generic durable job clock. Claim credentials are deliberately
   * omitted; this witness is limited to lifecycle state needed to prove enqueue, alarm wakeup,
   * retry, and terminalization without exposing the capability token itself. */
  async debugGetWorkforceRuntimeRuns(): Promise<ReadonlyArray<Readonly<{
    readonly id: string
    readonly workflowId: string
    readonly state: string
    readonly attempts: number
    readonly nextAttemptAt: string
    readonly leaseExpiresAt: string | null
    readonly sourceEventId: string | null
    readonly lastError: string | null
  }>>> {
    return this.#sql.exec<{
      id: string
      workflowId: string
      state: string
      attempts: number
      nextAttemptAt: string
      leaseExpiresAt: string | null
      sourceEventId: string | null
      lastError: string | null
    }>(`SELECT id, workflowId, state, attempts, nextAttemptAt, leaseExpiresAt, sourceEventId, lastError
        FROM workforce_runtime_runs ORDER BY createdAt, id`).toArray().map((row) => Object.freeze({ ...row }))
  }

  /** Test-only lifecycle seam for proving that a claimed run is recoverable after its lease. It
   * deliberately returns no claim token; production capability custody remains private to the DO. */
  async debugClaimWorkforceRun(input: Readonly<{ readonly now: string; readonly leaseMs: number }>): Promise<Readonly<{
    readonly id: string
    readonly state: string
    readonly attempts: number
    readonly leaseExpiresAt: string | null
  }> | null> {
    const now = new Date(input.now)
    if (!Number.isFinite(now.valueOf()) || !Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
      throw new ValidationError({ message: "debug workforce claim requires a valid instant and positive lease" })
    }
    const token = crypto.randomUUID()
    const run = this.#storage.transactionSync(() => this.#workforceRuntimeStore.claimDue(
      now,
      `debug:${crypto.randomUUID()}`,
      token,
      input.leaseMs
    ))
    return run === undefined
      ? null
      : Object.freeze({ id: run.id, state: run.state, attempts: run.attempts, leaseExpiresAt: run.leaseExpiresAt })
  }

  /** Test-only insertion of a future calendar run, used to exercise claim/lease recovery without
   * allowing the test alarm manager to execute the real concierge before the claim is observed. */
  async debugEnqueueWorkforceRun(input: Readonly<{ readonly occurrenceId: string; readonly dueAt: string }>): Promise<Readonly<{ id: string; state: string; nextAttemptAt: string }>> {
    const dueAt = new Date(input.dueAt)
    if (input.occurrenceId.trim().length === 0 || !Number.isFinite(dueAt.valueOf())) {
      throw new ValidationError({ message: "debug workforce enqueue requires a nonblank occurrence and valid due instant" })
    }
    const run = this.#storage.transactionSync(() => this.#workforceRuntimeStore.enqueue({
      workflowId: CALENDAR_RELATIONSHIP_CONCIERGE_WORKFLOW,
      scheduleVersion: CALENDAR_RELATIONSHIP_CONCIERGE_VERSION,
      occurrenceId: input.occurrenceId,
      sourceEventId: `debug:${input.occurrenceId}`,
      dueAt
    }))
    await this.#workforceScheduler.rearm()
    return Object.freeze({ id: run.id, state: run.state, nextAttemptAt: run.nextAttemptAt })
  }

  async debugGetWorkforceNextDueAt(): Promise<string | null> {
    return this.#workforceRuntimeStore.nextDueAt()?.toISOString() ?? null
  }

  /** Test-only corruption seam for proving durable Loro reload validation. It remains native-RPC
   * only and updates the snapshot row plus its descriptor atomically, so the test isolates page
   * contract validation rather than a torn-write failure. */
  async debugReplaceLoroPageSnapshot(nodeId: string, snapshot: Uint8Array): Promise<void> {
    const decodedNodeId = Schema.decodeUnknownSync(EntityId)(nodeId)
    const pageCollections = this.#pageCollections
    const storage = this.#storage
    const program = Effect.gen(function* () {
      const format = yield* pageCollections.pageDocumentFormats.get(decodedNodeId).pipe(
        Effect.mapError(toUnexpectedError),
        Effect.flatMap(decodePageDocumentFormatRow)
      )
      const current = yield* pageCollections.loroPageDocs.get(decodedNodeId).pipe(Effect.mapError(toUnexpectedError))
      if (format?.activeFormat !== "loro-v1" || format.loro === undefined || current === undefined) {
        return yield* Effect.fail(new ValidationError({ message: `page ${decodedNodeId} is not an active Loro page` }))
      }
      const loroDescriptor = format.loro
      const snapshotSha256 = sha256HexSync(snapshot)
      yield* Effect.try({
        try: () =>
          storage.transactionSync(() => {
            const exit = Effect.runSyncExit(
              Effect.all([
                pageCollections.loroPageDocs.put({
                  ...current,
                  snapshot,
                  snapshotSha256
                }).pipe(Effect.mapError(toUnexpectedError)),
                pageCollections.pageDocumentFormats.put({
                  ...format,
                  storageVersion: format.storageVersion + 1,
                  loro: { ...loroDescriptor, snapshotSha256 }
                }).pipe(Effect.mapError(toUnexpectedError))
              ])
            )
            if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
          }),
        catch: (error): DomainError =>
          error instanceof ValidationError || error instanceof UnexpectedError
            ? error
            : new UnexpectedError({ message: `Loro page test snapshot replacement failed: ${String(error)}` })
      })
    })
    await runOrThrowRpcError(this.#runtime, program)
  }

  /** Test-only corruption seam for proving that migrated pages validate their retained
   * Automerge witness before trusting the Loro route. This deliberately bypasses schema decoding
   * on write: the production collection is structural, so the service's read-side decoder is the
   * boundary under test. It remains `ctx.exports`-only and is never added to WorkspaceRpcApi. */
  async debugReplacePageDocumentFormat(nodeId: string, format: unknown): Promise<void> {
    const decodedNodeId = Schema.decodeUnknownSync(EntityId)(nodeId)
    if (format === null || typeof format !== "object" || Array.isArray(format)) {
      throw new ValidationError({ message: "page document format test row must be an object" })
    }
    const row = { ...(format as Record<string, unknown>), nodeId: decodedNodeId } as PageDocumentFormatRow
    const pageCollections = this.#pageCollections
    const storage = this.#storage
    const program = Effect.try({
      try: () =>
        storage.transactionSync(() => {
          const exit = Effect.runSyncExit(
            pageCollections.pageDocumentFormats.put(row).pipe(Effect.mapError(toUnexpectedError))
          )
          if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
        }),
      catch: (error): DomainError =>
        error instanceof ValidationError || error instanceof UnexpectedError
          ? error
          : new UnexpectedError({ message: `page document format test replacement failed: ${String(error)}` })
    })
    await runOrThrowRpcError(this.#runtime, program)
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
