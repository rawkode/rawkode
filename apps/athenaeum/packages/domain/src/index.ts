// Phase 0 domain slice (plan §"Effect-TS integration", `domain/` package) plus the Phase 1
// graph/views/sync entity, wire-schema, and repository additions (plan task: "Extend
// packages/domain/src"). Zero Cloudflare/React/Node.js-specific imports, so `backend` and
// `web` import it unchanged. The remaining full entity set (`Workspace`, `Task`, `CalendarEvent`,
// `Bookmark`, `Meeting`, `Workout`) and their errors/repositories are deferred to the phase
// that actually needs them.

export { EntityId, IsoDateTimeString, Node, PendingMarker } from "./node.js"
export {
  LEDGER_COMMAND_VERSION,
  LEDGER_MESSAGE_DERIVATION_VERSION,
  LedgerCommand,
  LedgerReceipt,
  createNodeCommitMessage,
  normalizeCreateNodeTitle
} from "./ledger.js"

export {
  CardinalityViolation,
  ChatBindingNotFound,
  ChatNotFound,
  EdgeNotFound,
  FactNotFound,
  GatekeeperNotConnected,
  GraphIssueDetected,
  GraphIssueNotFound,
  NodeNotFound,
  OAuthExchangeFailed,
  ObserverVerificationFailed,
  PageNotFound,
  PendingNameConflict,
  RelationDefinitionNotFound,
  TagNotFound,
  ToolNotImplemented,
  Unauthorized,
  UnexpectedError,
  ValidationError,
  MeetingNotFound,
  VoiceSessionNotFound,
  WorkoutImportConflict,
  WorkoutNotFound,
  WorkspaceAccessDenied,
  WorkspaceNotFound,
  AppNotFound,
  AppCodeVersionNotFound,
  AppCodeTooLarge,
  TagFieldDefinitionNotFound,
  type DomainError
} from "./errors.js"

// Phase 4 prerequisite (plan §"Agent-native editing & gatekeeper integrations", Sharing/observers
// paragraph): the dev-auth identity/auth-context shape — see auth.ts's own header comment for the
// full design rationale (identity model cited from cloudflare-os's workshop-backend/src/user.ts,
// credential shape deliberately departing from it).
export {
  AuthenticatedUser,
  CurrentUser,
  DevSignInInput,
  DevSignInOutput,
  Email,
  requireAuthenticatedUser,
  WhoamiOutput
} from "./auth.js"

export {
  CreateNodeInput,
  CreateNodeOutput,
  GetNodeInput,
  GetNodeOutput,
  ListNodesInput,
  ListNodesOutput,
  NodesChangedEvent
} from "./rpc.js"

export {
  AddFactInput,
  AddFactOutput,
  ApplySupertagFieldValue,
  ApplySupertagInput,
  ApplySupertagOutput,
  AssignTagInput,
  AssignTagOutput,
  CreateEdgeInput,
  CreateEdgeOutput,
  CreateRelationDefinitionInput,
  CreateRelationDefinitionOutput,
  CreateTagInput,
  CreateTagOutput,
  DefineTagFieldInput,
  DefineTagFieldOutput,
  ListBacklinksInput,
  ListBacklinksOutput,
  ListGraphIssuesInput,
  ListGraphIssuesOutput,
  ListTagClosureInput,
  ListTagClosureOutput,
  ListTagFieldsInput,
  ListTagFieldsOutput,
  ListTagsInput,
  ListTagsOutput,
  ResolvedTagField,
  RunViewInput,
  RunViewOutput,
  SyncNoteReferencesInput,
  SyncNoteReferencesOutput,
  TagClosureEntry,
  UnassignTagInput,
  UnassignTagOutput
} from "./graph-rpc.js"

export {
  BASE_TAG_FIELD_DEFINITIONS,
  BaseTagFieldIds,
  TagFieldDefinition,
  TagFieldValueKind
} from "./tag-field-definition.js"

export { SearchNodesInput, SearchNodesOutput, SearchResultEntry } from "./search-rpc.js"

export {
  ApplyPageEditInput,
  ApplyPageEditOutput,
  CreatePageInput,
  CreatePageOutput,
  GetPageTextInput,
  GetPageTextOutput
} from "./page-rpc.js"

export {
  PageSyncMessageInput,
  PageSyncMessageOutput,
  RotateEpochInput,
  RotateEpochOutput,
  StartPageSyncInput,
  StartPageSyncOutput,
  SyncFeedInput,
  SyncFeedOutput
} from "./sync-rpc.js"

export { decodeRpcError, encodeRpcError, RpcErrorEnvelope } from "./rpc-error.js"

export { NodesRepository } from "./nodes-repository.js"
export { PagesRepository } from "./pages-repository.js"
export { TagsRepository } from "./tags-repository.js"
export { FactsRepository } from "./facts-repository.js"
export { EdgesRepository } from "./edges-repository.js"
export { RelationDefinitionsRepository } from "./relation-definitions-repository.js"
export { GraphIssuesRepository } from "./graph-issues-repository.js"

export { JsonValue } from "./json-value.js"
export { Page } from "./page.js"
export { BASE_TAGS, BaseTagIds, Tag } from "./tag.js"
export { Fact } from "./fact.js"
export { RelationCardinality, RelationDefinition } from "./relation-definition.js"
export { Edge } from "./edge.js"
export { GraphIssue, GraphIssueKind } from "./graph-issue.js"

// Rich-text-editor stage (docs/rich-text-editor-decisions.md §5): the one fixed "mentions" /
// "mentioned by" relation `@`-mention entity references reconcile into, via
// `SyncNoteReferencesInput`/`SyncNoteReferencesOutput` above — see mention.ts's own header comment
// for why this is a parallel constant, not folded into BASE_TAGS/WORKOUT_RELATION_DEFINITIONS.
export { MENTION_RELATION_DEFINITION, MentionRelationId, MentionSentinelTagId } from "./mention.js"
export {
  FieldRef,
  GraphViewName,
  ViewPredicate,
  type ViewPredicateEncoded,
  ViewSpec
} from "./view-spec.js"
export { AutomergeSyncSession, SyncFeedEntry, WorkspaceEpoch } from "./sync.js"

// Phase 3 spike (plan §"Agent-native editing & gatekeeper integrations"): the pluggable
// model-client interface (see model-client.ts's own header comment for the full design
// rationale) and the Automerge-fork-as-chat-branch wire schemas (see chat-fork-rpc.ts).
export {
  ChatContentBlock,
  ChatMessage,
  ChatTextBlock,
  ChatThread,
  ChatToolResultBlock,
  ChatToolUseBlock,
  ModelClient,
  type ModelError,
  ModelRequestFailed,
  ModelResponseInvalid,
  ModelTurnFinalText,
  ModelTurnResult,
  ModelTurnToolCalls,
  ModelUnavailable,
  ToolCallRequest,
  ToolSpec
} from "./model-client.js"

export {
  AcceptChatForkInput,
  AcceptChatForkOutput,
  ApplyChatForkEditInput,
  ApplyChatForkEditOutput,
  ChatForkPreviewInput,
  ChatForkPreviewOutput,
  ForkChatEditInput,
  ForkChatEditOutput,
  RevertChatForkInput,
  RevertChatForkOutput
} from "./chat-fork-rpc.js"

// Phase 3 storage-schema task (plan §"Agent-native editing & gatekeeper integrations", items
// 1-7): the persisted chat/message entities, the `changes` stream envelope, the chat-local
// binding-map types + name validator, and the agent tool schema pairs. See each file's own
// header comment — especially chat.ts's — for the `ChatThread`/`ChatMessage` naming-collision
// note against the model-client.ts exports just above.
export { Chat, ChatMessageRecord } from "./chat.js"

export {
  AddedEdgeSummary,
  AddedFactSummary,
  ChangesMessage,
  CreatedAppSummary,
  CreatedNodeSummary,
  NoteEditSummary,
  UpdatedAppCodeSummary
} from "./changes-message.js"

export {
  AppBindingTarget,
  ChatBinding,
  ChatBindingName,
  ChatBindingTarget,
  GatekeeperBindingTarget,
  isValidChatBindingName,
  NodeBindingTarget
} from "./chat-binding.js"

export {
  AddEdgeToolInput,
  AddEdgeToolOutput,
  AddFactToolInput,
  AddFactToolOutput,
  ApplySupertagToolFieldValue,
  ApplySupertagToolInput,
  ApplySupertagToolOutput,
  CreateAppToolInput,
  CreateAppToolOutput,
  CreateNodeToolInput,
  CreateNodeToolOutput,
  DefineSupertagToolInput,
  DefineSupertagToolOutput,
  EditNoteToolInput,
  EditNoteToolOutput,
  LinkCalendarEventToolInput,
  LinkCalendarEventToolOutput,
  ReadNoteToolInput,
  ReadNoteToolOutput,
  UpdateAppCodeToolInput,
  UpdateAppCodeToolOutput
} from "./agent-tools.js"

// `AgentEditService`'s real RPC surface (plan task item 7) — see agent-edit-rpc.ts's own header
// comment.
export {
  CreateChatInput,
  CreateChatOutput,
  GetChatInput,
  GetChatOutput,
  ListChatChangesInput,
  ListChatChangesOutput,
  ListChatsInput,
  ListChatsOutput,
  ListPendingChangesInput,
  ListPendingChangesOutput,
  MergeChangesInput,
  MergeChangesOutput,
  RevertChangesInput,
  RevertChangesOutput,
  SendChatMessageInput,
  SendChatMessageOutput
} from "./agent-edit-rpc.js"

// Phase 4 task (plan §"Agent-native editing & gatekeeper integrations", "Sharing/observers on
// workspaces" paragraph): the sharing/multi-workspace schema surface — see sharing.ts's own header
// comment for the full docs/sharing.md port rationale, and sharing-rpc.ts's for the RPC method
// list. Schema-only (no `SharingService` yet — see both files' header comments for scope).
export {
  AffectedCollaborator,
  Collaborator,
  CollaboratorInfo,
  PermissionEdge,
  Role,
  ShareKeyHash,
  ShareKeyRecord,
  ShareLink,
  ShareLinkEdge,
  UserEdge,
  WorkspaceCatalogEntry
} from "./sharing.js"

export {
  AddCollaboratorInput,
  AddCollaboratorOutput,
  CreateShareLinkInput,
  CreateShareLinkOutput,
  CreateWorkspaceInput,
  CreateWorkspaceOutput,
  ListCollaboratorsInput,
  ListCollaboratorsOutput,
  ListShareLinksInput,
  ListShareLinksOutput,
  ListWorkspacesInput,
  ListWorkspacesOutput,
  PreviewRemoveCollaboratorInput,
  PreviewRemoveCollaboratorOutput,
  PreviewRevokeShareLinkInput,
  PreviewRevokeShareLinkOutput,
  RedeemShareLinkInput,
  RedeemShareLinkOutput,
  RemoveCollaboratorInput,
  RemoveCollaboratorOutput,
  RevokeShareLinkInput,
  RevokeShareLinkOutput
} from "./sharing-rpc.js"

// Phase 5 domain-extension task (plan's calendar/bookmarks/gatekeeper-binding design, following
// on from the Decisions pre-work stage's `gatekeeper-google-calendar` package): the provider-
// sourced `CalendarEvent`/`Bookmark` entities, the per-workspace `GatekeeperBinding` connection
// record, the cross-cutting observer/verifier wire schemas, and the eight-method gatekeeper RPC
// surface. See each file's own header comment for the full design rationale — schema-only, same
// scope note as sharing.ts/sharing-rpc.ts before their service stage landed.
export { CalendarEvent, CalendarEventAttendee, CalendarEventStatus, CalendarEventTime } from "./calendar-event.js"

export { Bookmark, BookmarkUrl } from "./bookmark.js"

export {
  GatekeeperBinding,
  GatekeeperBindingConfig,
  GatekeeperKind,
  GoogleCalendarBindingConfig
} from "./gatekeeper-binding.js"

export {
  GatekeeperUserVerifier,
  ObserverVerificationDenied,
  ObserverVerificationGranted,
  ObserverVerificationResult,
  ObserverVerificationStrategy
} from "./gatekeeper.js"

export {
  ConnectGoogleCalendarInput,
  ConnectGoogleCalendarOutput,
  CreateBookmarkInput,
  CreateBookmarkOutput,
  DisconnectGoogleCalendarInput,
  DisconnectGoogleCalendarOutput,
  GoogleCalendarOAuthCallbackInput,
  GoogleCalendarOAuthCallbackOutput,
  LinkCalendarEventToNodeInput,
  LinkCalendarEventToNodeOutput,
  ListBookmarksInput,
  ListBookmarksOutput,
  ListCalendarEventsInput,
  ListCalendarEventsOutput,
  SyncGoogleCalendarInput,
  SyncGoogleCalendarOutput
} from "./gatekeeper-rpc.js"

// Phase 6 spike (plan §"Meetings & voice") — see cloud-transcription.ts's own header comment for
// the full design rationale and its relationship to model-client.ts's established pattern.
export {
  CloudTranscriptionClient,
  TranscribeAudioInput,
  TranscribeAudioOutput,
  TranscriptionRequestFailed,
  TranscriptionResponseInvalid,
  TranscriptSegment,
  TranscriptionUnavailable,
  type TranscriptionError
} from "./cloud-transcription.js"

export {
  RealtimeVoiceClient,
  RealtimeVoiceConnectionFailed,
  RealtimeVoiceEvent,
  RealtimeVoiceProtocolError,
  RealtimeVoiceSessionConfig,
  RealtimeVoiceUnavailable,
  VoiceAssistantAudioDelta,
  VoiceAssistantTextDelta,
  VoiceToolCallRequested,
  VoiceTurnCompleted,
  VoiceUserTranscriptCompleted,
  VoiceUserTranscriptDelta,
  type RealtimeVoiceError,
  type RealtimeVoiceSession
} from "./realtime-voice.js"

// Phase 6 domain-extension task (plan §"Meetings & voice"): the persisted `Meeting`/`Speaker`/
// `TranscriptSegmentRecord`/`VoiceSession` entities and their RPC schemas. See meeting.ts's own
// header comment for why the persisted transcript-segment entity is named
// `TranscriptSegmentRecord`, not `TranscriptSegment` (already taken by cloud-transcription.ts's
// export just above). Schema-only — no `MeetingsService`/`VoiceService` implementation yet, same
// scope note as every prior Phase 5 domain-extension export group in this file.
export { Meeting, Speaker, TranscriptSegmentRecord, TranscriptSegmentSource } from "./meeting.js"

export {
  AppendTranscriptSegmentInput,
  AppendTranscriptSegmentOutput,
  EndMeetingInput,
  EndMeetingOutput,
  GetMeetingInput,
  GetMeetingOutput,
  ListMeetingsInput,
  ListMeetingsOutput,
  StartMeetingInput,
  StartMeetingOutput
} from "./meeting-rpc.js"

// Phase 7 (plan §"Phased delivery": "HealthKit import as typed graph pages") — see
// workout.ts's own header comment for the full "why a parallel constant, not BASE_TAGS"
// rationale, and docs/workouts-decisions.md for the complete design writeup.
export {
  WORKOUT_RELATION_DEFINITIONS,
  WORKOUT_TAGS,
  WorkoutActivityKind,
  WorkoutCardioSplit,
  WorkoutDetail,
  WorkoutDetailPayload,
  WorkoutFactPredicate,
  WorkoutImportReceipt,
  WorkoutRelationIds,
  WorkoutSource,
  WorkoutStrengthExercise,
  WorkoutStrengthSet,
  WorkoutSummary,
  WorkoutTagIds
} from "./workout.js"

export {
  CardioSplitImportInput,
  GetWorkoutInput,
  GetWorkoutOutput,
  ImportWorkoutInput,
  ImportWorkoutOutput,
  ImportWorkoutsInput,
  ImportWorkoutsOutput,
  ListWorkoutImportsInput,
  ListWorkoutImportsOutput,
  ListWorkoutsInput,
  ListWorkoutsOutput,
  StrengthExerciseImportInput,
  StrengthSetImportInput,
  WorkoutImportBatchItemResult,
  WorkoutImportFailed,
  WorkoutImportItem,
  WorkoutImportPayload,
  WorkoutImportSucceeded
} from "./workout-rpc.js"

export { VoiceSession, VoiceSessionStatus } from "./voice-session.js"

export {
  EndVoiceSessionInput,
  EndVoiceSessionOutput,
  StartVoiceSessionInput,
  StartVoiceSessionOutput
} from "./voice-session-rpc.js"

export {
  CloseVoiceAudioSessionInput,
  CloseVoiceAudioSessionOutput,
  CommitVoiceAudioInput,
  CommitVoiceAudioOutput,
  OpenVoiceAudioSessionInput,
  OpenVoiceAudioSessionOutput,
  PollVoiceAudioEventsInput,
  PollVoiceAudioEventsOutput,
  SendVoiceAudioChunkInput,
  SendVoiceAudioChunkOutput
} from "./voice-audio-rpc.js"

// App Library domain-extension task (full agent-authored apps with real sandboxed execution via
// Cloudflare Worker Loaders — see app.ts's own header comment for the full design rationale,
// terminology note, and why this is deliberately NOT called "gadget" anywhere). Schema-only — no
// `AppService`/`WorkspaceDurableObject` implementation, no Worker Loader wiring, and no web UI
// exist yet, same scope note every prior domain-extension stage's own header comment carries.
export { App, AppCodeKind, AppCodeVersion, AppIcon, MAX_APP_CODE_BYTES } from "./app.js"

export {
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
  UpdateAppCodeOutput
} from "./app-rpc.js"

// AppsService backend-implementation stage addition: the `App` entity's own `Context.Tag`, same
// "domain interface, backend `*Live` implementation" split as `NodesRepository` (see
// `app-repository.ts`'s own header comment for why `AppCodeVersion` deliberately has no analogous
// tag).
export { AppsRepository } from "./app-repository.js"
