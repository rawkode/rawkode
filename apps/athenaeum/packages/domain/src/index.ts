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
  CREATE_NODE_WITH_INTENT_MESSAGE_DERIVATION_VERSION,
  ACCEPT_CHAT_FORK_MESSAGE_DERIVATION_VERSION,
  AGENT_CHANGE_DECISION_MESSAGE_DERIVATION_VERSION,
  APPLY_SUPERTAG_MESSAGE_DERIVATION_VERSION,
  ADD_FACT_MESSAGE_DERIVATION_VERSION,
  CREATE_EDGE_MESSAGE_DERIVATION_VERSION,
  CREATE_TAG_MESSAGE_DERIVATION_VERSION,
  DEFINE_TAG_FIELD_MESSAGE_DERIVATION_VERSION,
  ASSIGN_TAG_MESSAGE_DERIVATION_VERSION,
  UNASSIGN_TAG_MESSAGE_DERIVATION_VERSION,
  SYNC_NOTE_REFERENCES_MESSAGE_DERIVATION_VERSION,
  CREATE_RELATION_DEFINITION_MESSAGE_DERIVATION_VERSION,
  CREATE_BOOKMARK_MESSAGE_DERIVATION_VERSION,
  APPEND_TRANSCRIPT_SEGMENT_MESSAGE_DERIVATION_VERSION,
  START_MEETING_MESSAGE_DERIVATION_VERSION,
  ENSURE_LORO_PAGE_MESSAGE_DERIVATION_VERSION,
  COMMIT_LORO_PAGE_CONTENT_MESSAGE_DERIVATION_VERSION,
  PREPARE_MEETING_IN_DAILY_NOTE_MESSAGE_DERIVATION_VERSION,
  ACTIVATE_LORO_PAGE_MESSAGE_DERIVATION_VERSION,
  MIGRATE_LEGACY_PAGE_MESSAGE_DERIVATION_VERSION,
  LEGACY_PAGE_MIGRATION_ENGINE_VERSION,
  MUTATION_ATTRIBUTION_VERSION,
  AcceptChatForkLedgerCommand,
  AcceptPageProposalLedgerCommand,
  AgentJobMutationAttribution,
  AgentChangeDecisionLedgerCommand,
  ApplySupertagLedgerCommand,
  ApplySupertagLedgerFieldValue,
  ApplySupertagLedgerPayload,
  AddFactLedgerCommand,
  AddFactLedgerPayload,
  AssignTagLedgerCommand,
  AssignTagLedgerPayload,
  CreateEdgeLedgerCommand,
  CreateEdgeLedgerPayload,
  CreateTagLedgerCommand,
  CreateTagLedgerPayload,
  EnsureLoroPageLedgerCommand,
  EnsureLoroPageLedgerPayload,
  CommitLoroPageContentLedgerCommand,
  CommitLoroPageContentLedgerPayload,
  PrepareMeetingInDailyNoteLedgerCommand,
  PrepareMeetingInDailyNoteLedgerPayload,
  ActivateLoroPageLedgerCommand,
  ActivateLoroPageLedgerPayload,
  MigrateLegacyPageLedgerCommand,
  MigrateLegacyPageLedgerPayload,
  DefineTagFieldLedgerCommand,
  DefineTagFieldLedgerPayload,
  UnassignTagLedgerCommand,
  UnassignTagLedgerPayload,
  SyncNoteReferencesLedgerCommand,
  SyncNoteReferencesLedgerEdge,
  SyncNoteReferencesLedgerPayload,
  CreateRelationDefinitionLedgerCommand,
  CreateRelationDefinitionLedgerPayload,
  CreateBookmarkLedgerCommand,
  CreateBookmarkLedgerPayload,
  CreateBookmarkLedgerTitle,
  CreateBookmarkLedgerTitleAbsent,
  CreateBookmarkLedgerTitlePresent,
  AppendTranscriptSegmentLedgerCommand,
  AppendTranscriptSegmentLedgerPayload,
  AppendTranscriptSegmentLedgerSpeaker,
  AppendTranscriptSegmentLedgerSpeakerAbsent,
  AppendTranscriptSegmentLedgerSpeakerPresent,
  StartMeetingLedgerCommand,
  StartMeetingLedgerPayload,
  CreateNodeLedgerCommand,
  CreateNodeWithIntentLedgerCommand,
  CreateNodeWithIntentLedgerPayload,
  HumanUiMutationAttribution,
  LedgerCommand,
  LedgerReceipt,
  MutationAttribution,
  MutationCommitMessage,
  MutationRequestId,
  SystemMutationAttribution,
  acceptChatForkCommitMessage,
  createNodeCommitMessage,
  normalizeCreateNodeTitle,
  applySupertagCommitMessage,
  addFactCommitMessage,
  assignTagCommitMessage,
  createEdgeCommitMessage,
  createTagCommitMessage,
  defineTagFieldCommitMessage,
  unassignTagCommitMessage,
  syncNoteReferencesCommitMessage,
  createRelationDefinitionCommitMessage,
  createBookmarkCommitMessage,
  appendTranscriptSegmentCommitMessage,
  startMeetingCommitMessage,
  normalizeCreateTagName
} from "./ledger.js"
export {
  ActorContexts,
  MUTATION_REQUEST_V2_VERSION,
  MUTATION_TEXT_MAX_SCALARS,
  MUTATION_TEXT_MAX_UTF8_BYTES,
  UNICODE_VALIDATION_TABLE_VERSION,
  decodeMutationRequestV2,
  decodeActorContext,
  decodeLedgerEventV2,
  decodeOutboxDeliveryV2,
  decodeOutboxIntentV2,
  decodeDeliveryRecordV2,
  decodeResolvedMutationIntentV2,
  decideWorkspaceReplayV2,
  digestCanonicalV2,
  commandFingerprintMaterialV2,
  custodyDigestMaterialV2,
  resolvedActorCustodyDigestV2,
  createPreAuthorizationIdentityV2,
  decidePreAuthorizationReplayV2,
  eventDigestMaterialV2,
  normalizeMutationText
} from "./ledger-v2.js"
export type {
  ActorContext,
  DeliveryRecordV2,
  IngressEvidenceV2,
  LedgerEventV2,
  MutationRequestV2,
  OutboxDeliveryV2,
  OutboxIntentV2,
  ResolvedMutationIntentV2
} from "./ledger-v2.js"
export {
  LedgerActivityActor,
  LedgerActivityType,
  LedgerActivityEntry,
  ListRecentLedgerActivityInput,
  ListRecentLedgerActivityOutput
} from "./ledger-rpc.js"

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
  NodeAlreadyExists,
  OAuthExchangeFailed,
  ObserverVerificationFailed,
  PageFormatMismatch,
  LoroContentConflict,
  LoroSemanticCommitRequired,
  LoroRequestIdentityConflict,
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
  CreateNodeWithIntentInput,
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
  TagFieldValueKind,
  normalizeTagFieldName
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
  AutomergePageDocumentDescriptor,
  LegacyPageDocumentDescriptor,
  LoroPageDocumentDescriptor,
  MigratedLoroPageDocumentDescriptor,
  NativeLoroPageDocumentDescriptor,
  PageDocumentDescriptor,
  PageDocumentFormat
} from "./page-document-format.js"

export {
  CommitLoroPageContentInput,
  CommitLoroPageContentOutput,
  CreateLoroPageInput,
  CreateLoroPageOutput,
  CreationIntent,
  LoroMutationIntentV1,
  GetPageDocumentDescriptorInput,
  GetPageDocumentDescriptorOutput,
  GetLegacyPageProjectionInput,
  GetLegacyPageProjectionOutput,
  MigrateLegacyPageInput,
  MigrateLegacyPageOutput,
  LoroPageSyncMessageInput,
  LoroPageSyncMessageOutput,
  StartLoroPageSyncInput,
  StartLoroPageSyncOutput
} from "./page-document-rpc.js"

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

export {
  decodeRpcError,
  encodeRpcError,
  LORO_SEMANTIC_COMMIT_REQUIRED_MESSAGE,
  RpcErrorEnvelope
} from "./rpc-error.js"

export { NodesRepository } from "./nodes-repository.js"
export { PagesRepository } from "./pages-repository.js"
export { TagsRepository } from "./tags-repository.js"
export { FactsRepository } from "./facts-repository.js"
export { EdgesRepository } from "./edges-repository.js"
export { RelationDefinitionsRepository } from "./relation-definitions-repository.js"
export { GraphIssuesRepository } from "./graph-issues-repository.js"

export { JsonValue } from "./json-value.js"
export {
  WORKFORCE_SCHEMA_VERSION, WORKFORCE_EVENT_CANONICAL_VERSION, WORKFORCE_STANDUP_PROJECTION_VERSION,
  canonicalWorkforceValueV1, canonicalWorkforcePreimageV1, digestWorkforcePreimageV1,
  compareCanonicalWorkforcePreimagesV1, decodeWorkforceStandupInput,
  type NonEmptyString, type Version, type MicroEmployeeId, type JobId, type WorkflowId,
  type ScheduleId, type CouncilId, type OccurrenceId, type RunId, type EventId, type FactId,
  type LocalDate as WorkforceLocalDate, type CivilTimeZone, type Sequence, type Utf8Digest, type WorkforceDigest, type DefinitionKind,
  type DefinitionIdByKind, type DefinitionRef, type MicroEmployeeDefinition, type JobDefinition,
  type WorkflowDefinition, type ScheduleDefinition, type CouncilDefinition, type WorkforceDefinition,
  type ScheduleOccurrenceRef, type RunRef, type WorkforceResult, type WorkforceClaim,
  type ExternalDiagnostic, type RunObservedEvent, type ResultObservedEvent, type ClaimObservedEvent,
  type DiagnosticObservedEvent, type WorkforceEvent, type WorkforceRunFact, type Availability,
  type WorkforceInputName, type InputName, type WorkforceStandupInput, type WorkforceDecodeError, type Either,
  type CanonicalWorkforceValue
} from "./workforce.js"
export {
  RUN_IDENTITY_VERSION, WORKFORCE_MUTATION_PROVENANCE_VERSION,
  WORKFORCE_MUTATION_BRIDGE_INPUT_VERSION, WORKFORCE_MUTATION_BRIDGE_OUTPUT_VERSION,
  bridgeWorkforceMutationProvenance,
  type RunIdentity, type WorkforceMutationProvenance, type WorkforceMutationBridgeRecord,
  type WorkforceMutationBridgeInput, type WorkforceMutationBridgeDiagnostic,
  type WorkforceMutationBridgeOutput
} from "./workforce-mutation-provenance.js"
export {
  projectWorkforceStandup,
  type WorkforceProjectionDiagnostic,
  type WorkforceStandupProjection
} from "./workforce-projection.js"
export { CANONICAL_SNAPSHOT_VERSION, canonicalJson, canonicalJsonBytes, canonicalSha256, sha256Hex, sha256HexSync } from "./canonical-hash.js"
export {
  STANDUP_PUBLICATION_PROTOCOL_VERSION, STANDUP_PUBLICATION_SLOT_IDENTITY_VERSION, STANDUP_PUBLICATION_REQUEST_ID_VERSION, STANDUP_PUBLICATION_CHILD_NODE_ID_VERSION, STANDUP_PUBLICATION_FINGERPRINT_VERSION, STANDUP_PUBLICATION_MAX_TEXT_BYTES,
  canonicalStandupPublicationSlot, canonicalStandupPublicationText, standupPublicationSlotDigest, standupPublicationRequestIdentity, standupPublicationChildNodeId, standupPublicationFingerprint,
  StandupPublicationReference, StandupPublicationCompanionStatus, StandupPublication, ListStandupPublicationsInput, ListStandupPublicationsOutput,
  type StandupPublicationDefinitionKind, type StandupPublicationDefinitionRef, type StandupPublicationSlotIdentity, type CanonicalStandupPublicationSlot, type CanonicalStandupPublicationText, type StandupPublicationFingerprintInput, type StandupPublicationCompanionStatus as StandupPublicationCompanionStatusType
} from "./standup-publication.js"
export { LORO_PAGE_META_CONTAINER, LORO_PROSEMIRROR_CONTAINER, LORO_PAGE_SCHEMA_VERSION } from "./loro-page-contract.js"
export {
  AgentChangeOperation, AgentChangeProposal, AgentChangeProposalDecision, AgentChangeProposalState, AgentChangeReservation,
  AgentChangeSnapshot, AgentChangeTargetKind, agentChangeReservationKey
} from "./agent-change-proposal.js"
export { Page } from "./page.js"
export { canonicalAutomergeHeadsHash } from "./automerge-heads.js"
export { PageProposal, PageProposalProvenance, PageCommit } from "./page-proposal.js"
export {
  ProposePageEditInput, ProposePageEditOutput, PreviewPageProposalInput, PreviewPageProposalOutput,
  AcceptPageProposalInput, AcceptPageProposalOutput, RevertPageProposalInput, RevertPageProposalOutput
} from "./page-proposal-rpc.js"
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
  DecideAgentChangeProposalInput,
  DecideAgentChangeProposalOutput,
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
  GatekeeperBindingSummary,
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
  ListGatekeeperBindingsInput,
  ListGatekeeperBindingsOutput,
  SyncGoogleCalendarInput,
  SyncGoogleCalendarOutput
} from "./gatekeeper-rpc.js"

export {
  GetTodayBriefInput,
  GetTodayBriefOutput,
  PrepareMeetingInDailyNoteInput,
  PrepareMeetingInDailyNoteOutput,
  IanaTimeZone,
  LocalDate,
  TodayBriefCalendarHistory,
  TodayBriefEvent,
  TodayBriefHistoryStatus,
  TodayBriefPerson
} from "./today-brief-rpc.js"

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
