import {
  AGENT_CHANGE_DECISION_MESSAGE_DERIVATION_VERSION,
  ACCEPT_CHAT_FORK_MESSAGE_DERIVATION_VERSION,
  APPLY_SUPERTAG_MESSAGE_DERIVATION_VERSION,
  ADD_FACT_MESSAGE_DERIVATION_VERSION,
  CREATE_NODE_WITH_INTENT_MESSAGE_DERIVATION_VERSION,
  AddFactLedgerCommand,
  AddFactLedgerPayload,
  CreateNodeWithIntentLedgerCommand,
  CreateNodeWithIntentLedgerPayload,
  CreateAppLedgerCommand,
  CreateAppLedgerPayload,
  UpdateAppCodeLedgerCommand,
  UpdateAppCodeLedgerPayload,
  DeleteAppLedgerCommand,
  DeleteAppLedgerPayload,
  AssignTagLedgerCommand,
  AssignTagLedgerPayload,
  CreateEdgeLedgerCommand,
  CreateEdgeLedgerPayload,
  CreateTagLedgerCommand,
  CreateTagLedgerPayload,
  UpdateTagLedgerCommand,
  UpdateTagLedgerPayload,
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
  UnassignTagLedgerCommand,
  UnassignTagLedgerPayload,
  ApplySupertagLedgerCommand,
  ApplySupertagLedgerPayload,
  canonicalJsonBytes,
  LEDGER_COMMAND_VERSION,
  LEDGER_MESSAGE_DERIVATION_VERSION,
  LedgerCommand,
  MutationAttribution,
  MutationCommitMessage,
  canonicalMutationCommitMessage,
  canonicalMutationProvenance,
  COMMIT_MESSAGE_MIRROR_DERIVATION_VERSION,
  applySupertagCommitMessage,
  addFactCommitMessage,
  assignTagCommitMessage,
  createEdgeCommitMessage,
  createTagCommitMessage,
  updateTagCommitMessage,
  unassignTagCommitMessage,
  acceptChatForkCommitMessage,
  createNodeCommitMessage,
  sha256HexSync,
  CREATE_EDGE_MESSAGE_DERIVATION_VERSION,
  CREATE_TAG_MESSAGE_DERIVATION_VERSION,
  UPDATE_TAG_MESSAGE_DERIVATION_VERSION,
  ENSURE_LORO_PAGE_MESSAGE_DERIVATION_VERSION,
  COMMIT_LORO_PAGE_CONTENT_MESSAGE_DERIVATION_VERSION,
  PREPARE_MEETING_IN_DAILY_NOTE_MESSAGE_DERIVATION_VERSION,
  ACTIVATE_LORO_PAGE_MESSAGE_DERIVATION_VERSION,
  MIGRATE_LEGACY_PAGE_MESSAGE_DERIVATION_VERSION,
  LEGACY_PAGE_MIGRATION_ENGINE_VERSION,
  DEFINE_TAG_FIELD_MESSAGE_DERIVATION_VERSION,
  ASSIGN_TAG_MESSAGE_DERIVATION_VERSION,
  UNASSIGN_TAG_MESSAGE_DERIVATION_VERSION,
  DefineTagFieldLedgerCommand,
  DefineTagFieldLedgerPayload,
  defineTagFieldCommitMessage,
  SYNC_NOTE_REFERENCES_MESSAGE_DERIVATION_VERSION,
  SyncNoteReferencesLedgerCommand,
  SyncNoteReferencesLedgerEdge,
  SyncNoteReferencesLedgerPayload,
  syncNoteReferencesCommitMessage,
  CREATE_RELATION_DEFINITION_MESSAGE_DERIVATION_VERSION,
  CreateRelationDefinitionLedgerCommand,
  CreateRelationDefinitionLedgerPayload,
  createRelationDefinitionCommitMessage,
  CREATE_BOOKMARK_MESSAGE_DERIVATION_VERSION,
  CreateBookmarkLedgerCommand,
  CreateBookmarkLedgerPayload,
  createBookmarkCommitMessage,
  LINK_CALENDAR_EVENT_TO_NODE_MESSAGE_DERIVATION_VERSION,
  LinkCalendarEventToNodeLedgerCommand,
  LinkCalendarEventToNodeLedgerPayload,
  linkCalendarEventToNodeCommitMessage,
  APPEND_TRANSCRIPT_SEGMENT_MESSAGE_DERIVATION_VERSION,
  AppendTranscriptSegmentLedgerCommand,
  AppendTranscriptSegmentLedgerPayload,
  AppendTranscriptSegmentLedgerSpeaker,
  appendTranscriptSegmentCommitMessage,
  START_MEETING_MESSAGE_DERIVATION_VERSION,
  CALENDAR_PROJECTION_MESSAGE_DERIVATION_VERSION,
  APP_LIFECYCLE_MESSAGE_DERIVATION_VERSION,
  CalendarProjectionLedgerCommand,
  CalendarProjectionLedgerPayload,
  StartMeetingLedgerCommand,
  StartMeetingLedgerPayload,
  startMeetingCommitMessage,
  createAppCommitMessage,
  updateAppCodeCommitMessage,
  deleteAppCommitMessage,
  EntityId,
  IsoDateTimeString,
  type StandupRecordedWorkOperation
} from "@athenaeum/domain"
import * as Schema from "effect/Schema"
import { issueLedgerMutationCapability, type LedgerMutationCapability } from "./ledger-mutation-capability.js"
import type { LedgerMutationScope } from "./ledger-mutation-capability.js"

/** Test-only synchronous failpoint. Production leaves this unset; tests use it to prove that
 * graph writes, command rows, receipts, events, and outbox rows all roll back together. */
export const ledgerExecuteTestHook: { afterMutation: (() => void) | undefined } = {
  afterMutation: undefined
}

/** Test-only custody failpoint. Production leaves this unset; the gateway tests use it to prove
 * that a custody failure rolls back the command, CRDT projection, side effects, and receipt as
 * one transaction rather than leaving an unaudited write behind. */
export const ledgerCustodyTestHook: { beforeInsert: (() => void) | undefined } = {
  beforeInsert: undefined
}

const LEDGER_RECEIPT_V2_VERSION = "athenaeum.workspace-ledger-receipt.v2" as const

interface StoredLedgerReceiptV2 extends StoredLedgerReceipt {
  readonly version: typeof LEDGER_RECEIPT_V2_VERSION
  readonly type: string
}

const encodeLedgerReceiptV2 = (type: string, output: unknown): string => JSON.stringify({
  version: LEDGER_RECEIPT_V2_VERSION,
  type,
  output
})

/** Workspace-local transitional ledger. This is not an authority service and is intentionally
 * not a separate Durable Object: it shares WorkspaceDO SQLite so its command, receipt and the
 * existing projections can commit in one `transactionSync` scope. */
export interface CreateNodeLedgerCommand {
  readonly requestIdentity: string
  readonly requestId: string
  readonly fingerprint: string
  readonly workspaceId: string
  readonly principal: string
  readonly policy: string
  readonly title: string
  readonly payload: unknown
  readonly createdAt: string
}

export interface CreateNodeWithIntentLedgerCommandInput {
  readonly requestIdentity: string
  readonly requestId: string
  readonly fingerprint: string
  readonly workspaceId: string
  readonly principal: string
  readonly policy: string
  readonly nodeId: string
  /** Caller-selected id only; generated identities must not make a retry conflict. */
  readonly requestedNodeId?: string
  readonly title: string
  readonly commitMessage: typeof MutationCommitMessage.Type
  readonly attribution: typeof MutationAttribution.Type
  readonly createdAt: string
}

export interface StoredLedgerReceipt {
  readonly fingerprint: string
  readonly output: unknown
}

export interface AgentChangeDecisionLedgerCommand {
  readonly requestIdentity: string
  readonly requestId: string
  readonly fingerprint: string
  readonly workspaceId: string
  readonly proposalId: string
  readonly decision: "accept" | "reject"
  readonly principal: string
  readonly provenance: string
  readonly policy: string
  readonly message: string
  readonly payload: unknown
  readonly createdAt: string
}

export interface ApplySupertagLedgerCommandInput {
  readonly requestIdentity: string
  readonly requestId: string
  readonly fingerprint: string
  readonly workspaceId: string
  readonly principal: string
  readonly policy: string
  readonly nodeId: string
  readonly tagId: string
  readonly fieldValues: ReadonlyArray<{ readonly fieldId: string; readonly value: unknown }>
  readonly commitMessage: typeof MutationCommitMessage.Type
  readonly attribution: typeof MutationAttribution.Type
  readonly createdAt: string
}

export interface AddFactLedgerCommandInput {
  readonly requestIdentity: string; readonly requestId: string; readonly fingerprint: string
  readonly workspaceId: string; readonly principal: string; readonly policy: string
  readonly nodeId: string; readonly predicateId: string; readonly value: unknown; readonly factId?: string
  readonly commitMessage: typeof MutationCommitMessage.Type; readonly attribution: typeof MutationAttribution.Type
  readonly createdAt: string
}

export interface CreateEdgeLedgerCommandInput {
  readonly requestIdentity: string; readonly requestId: string; readonly fingerprint: string
  readonly workspaceId: string; readonly principal: string; readonly policy: string
  readonly relationDefinitionId: string; readonly sourceNodeId: string; readonly targetNodeId: string
  readonly commitMessage: typeof MutationCommitMessage.Type; readonly attribution: typeof MutationAttribution.Type
  readonly createdAt: string
}

export interface CreateTagLedgerCommandInput {
  readonly requestIdentity: string; readonly requestId: string; readonly fingerprint: string
  readonly workspaceId: string; readonly principal: string; readonly policy: string
  readonly name: string; readonly parentIds: ReadonlyArray<string>
  readonly commitMessage: typeof MutationCommitMessage.Type; readonly attribution: typeof MutationAttribution.Type
  readonly createdAt: string
}

export interface UpdateTagLedgerCommandInput {
  readonly requestIdentity: string; readonly requestId: string; readonly fingerprint: string
  readonly workspaceId: string; readonly principal: string; readonly policy: string
  readonly tagId: string; readonly expectedRevision: string; readonly name: string; readonly parentIds: ReadonlyArray<string>
  readonly commitMessage: typeof MutationCommitMessage.Type; readonly attribution: typeof MutationAttribution.Type
  readonly createdAt: string
}

export interface EnsureLoroPageLedgerCommandInput {
  readonly requestIdentity: string; readonly requestId: string; readonly fingerprint: string
  readonly workspaceId: string; readonly principal: string; readonly policy: string; readonly nodeId: string
  readonly outcome: "created" | "alreadyExisted"; readonly storageVersion: number; readonly schemaVersion: number
  readonly commitMessage: typeof MutationCommitMessage.Type; readonly attribution: typeof MutationAttribution.Type
  readonly createdAt: string
}

export interface CommitLoroPageContentLedgerCommandInput {
  readonly requestIdentity: string; readonly requestId: string; readonly fingerprint: string
  readonly workspaceId: string; readonly principal: string; readonly policy: string; readonly nodeId: string
  readonly expectedStorageVersion: number; readonly expectedSnapshotSha256: string
  readonly baseVersionVectorSha256: string; readonly resultVersionVectorSha256: string; readonly resultSnapshotSha256: string
  readonly updateSha256: string; readonly updateLength: number
  readonly commitMessage: typeof MutationCommitMessage.Type; readonly attribution: typeof MutationAttribution.Type; readonly createdAt: string
}
export interface PrepareMeetingInDailyNoteLedgerCommandInput {
  readonly requestIdentity: string; readonly requestId: string; readonly fingerprint: string
  readonly workspaceId: string; readonly principal: string; readonly policy: string; readonly nodeId: string
  readonly localDate: string; readonly timeZone: string; readonly occurrenceKey: string; readonly status: "created" | "alreadyPrepared"; readonly resultSnapshotSha256: string
  readonly commitMessage: typeof MutationCommitMessage.Type; readonly attribution: typeof MutationAttribution.Type; readonly createdAt: string
}
export interface ActivateLoroPageLedgerCommandInput {
  readonly requestIdentity: string; readonly requestId: string; readonly fingerprint: string; readonly workspaceId: string; readonly principal: string; readonly policy: string; readonly nodeId: string
  readonly expectedAutomergeHeadsHash: string; readonly expectedAutomergeBytesSha256: string; readonly snapshotSha256: string; readonly snapshotLength: number; readonly storageVersion: number; readonly schemaVersion: number
  readonly commitMessage: typeof MutationCommitMessage.Type; readonly attribution: typeof MutationAttribution.Type; readonly createdAt: string
}
export interface MigrateLegacyPageLedgerCommandInput {
  readonly requestIdentity: string; readonly requestId: string; readonly fingerprint: string; readonly workspaceId: string; readonly principal: string; readonly policy: string; readonly nodeId: string
  readonly sourceStorageVersion: number; readonly sourceAutomerge: { readonly docId: string; readonly headsHash: string; readonly bytesSha256: string }
  readonly resultSnapshotSha256: string; readonly resultSnapshotLength: number; readonly storageVersion: number; readonly schemaVersion: number
  readonly commitMessage: typeof MutationCommitMessage.Type; readonly attribution: typeof MutationAttribution.Type; readonly createdAt: string
}

export interface DefineTagFieldLedgerCommandInput {
  readonly requestIdentity: string; readonly requestId: string; readonly fingerprint: string
  readonly workspaceId: string; readonly principal: string; readonly policy: string
  readonly tagId: string; readonly name: string; readonly valueKind: "text" | "number" | "date" | "checkbox" | "entity-ref"
  readonly sortOrder: number
  readonly commitMessage: typeof MutationCommitMessage.Type; readonly attribution: typeof MutationAttribution.Type
  readonly createdAt: string
}

export interface SyncNoteReferencesLedgerCommandInput {
  readonly requestIdentity: string; readonly requestId: string; readonly fingerprint: string
  readonly workspaceId: string; readonly principal: string; readonly policy: string
  readonly nodeId: string; readonly referencedNodeIds: ReadonlyArray<string>
  readonly created: ReadonlyArray<{ readonly id: string; readonly relationDefinitionId: string; readonly sourceNodeId: string; readonly targetNodeId: string }>
  readonly removed: ReadonlyArray<{ readonly id: string; readonly relationDefinitionId: string; readonly sourceNodeId: string; readonly targetNodeId: string }>
  readonly commitMessage: typeof MutationCommitMessage.Type; readonly attribution: typeof MutationAttribution.Type
  readonly createdAt: string
}

export interface CreateRelationDefinitionLedgerCommandInput {
  readonly requestIdentity: string; readonly requestId: string; readonly fingerprint: string
  readonly workspaceId: string; readonly principal: string; readonly policy: string
  readonly forwardName: string; readonly inverseName: string; readonly sourceTagId: string; readonly targetTagId: string
  readonly cardinality: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many"
  readonly commitMessage: typeof MutationCommitMessage.Type; readonly attribution: typeof MutationAttribution.Type
  readonly createdAt: string
}

export interface CreateBookmarkLedgerCommandInput {
  readonly requestIdentity: string; readonly requestId: string; readonly fingerprint: string
  readonly workspaceId: string; readonly principal: string; readonly policy: string
  readonly url: string; readonly title?: string; readonly bookmarkId?: string; readonly capturedAt?: string
  readonly commitMessage: typeof MutationCommitMessage.Type; readonly attribution: typeof MutationAttribution.Type
  readonly createdAt: string
}

export interface LinkCalendarEventToNodeLedgerCommandInput {
  readonly requestIdentity: string; readonly requestId: string; readonly fingerprint: string
  readonly workspaceId: string; readonly principal: string; readonly policy: string
  readonly calendarEventId: string; readonly nodeId: string
  readonly commitMessage: typeof MutationCommitMessage.Type; readonly attribution: typeof MutationAttribution.Type
  readonly createdAt: string
}

export interface CalendarProjectionLedgerCommandInput {
  readonly requestIdentity: string; readonly requestId: string; readonly fingerprint: string
  readonly workspaceId: string; readonly principal: string; readonly policy: string
  readonly calendarEventId: string; readonly sourceRevisionDigest: string
  readonly attendeeObservationDigests: ReadonlyArray<string>
  readonly commitMessage: typeof MutationCommitMessage.Type; readonly attribution: typeof MutationAttribution.Type
  readonly createdAt: string
}

export interface AppendTranscriptSegmentLedgerCommandInput {
  readonly requestIdentity: string; readonly requestId: string; readonly fingerprint: string
  readonly workspaceId: string; readonly principal: string; readonly policy: string
  readonly meetingId: string; readonly speakerId?: string; readonly text: string
  readonly startOffsetMs: number; readonly endOffsetMs: number; readonly source: "on-device" | "cloud"
  readonly commitMessage: typeof MutationCommitMessage.Type; readonly attribution: typeof MutationAttribution.Type
  readonly createdAt: string
}

export interface StartMeetingLedgerCommandInput {
  readonly requestIdentity: string; readonly requestId: string; readonly fingerprint: string
  readonly workspaceId: string; readonly principal: string; readonly policy: string
  readonly title: string
  readonly commitMessage: typeof MutationCommitMessage.Type; readonly attribution: typeof MutationAttribution.Type
  readonly createdAt: string
}

export interface AssignTagLedgerCommandInput {
  readonly requestIdentity: string; readonly requestId: string; readonly fingerprint: string
  readonly workspaceId: string; readonly principal: string; readonly policy: string
  readonly nodeId: string; readonly tagId: string
  readonly commitMessage: typeof MutationCommitMessage.Type; readonly attribution: typeof MutationAttribution.Type
  readonly createdAt: string
}

export interface UnassignTagLedgerCommandInput {
  readonly requestIdentity: string; readonly requestId: string; readonly fingerprint: string
  readonly workspaceId: string; readonly principal: string; readonly policy: string
  readonly nodeId: string; readonly tagId: string
  readonly commitMessage: typeof MutationCommitMessage.Type; readonly attribution: typeof MutationAttribution.Type
  readonly createdAt: string
}

export interface ExecuteLedgerV2Input<T> {
  readonly requestIdentity: string
  readonly fingerprint: string
  readonly type: string
  /** Required only by capability-gated internal projections. The ledger binds this scope to the
   * command fingerprint before it invokes `mutate`; replay never mints a capability. */
  readonly mutationScope?: Omit<LedgerMutationScope, "type" | "fingerprint">
  /** First execution receives an unforgeable capability. Legacy zero-argument callbacks remain
   * assignable; replay never invokes this callback or issues a capability. */
  readonly mutate: (capability: LedgerMutationCapability) => T
  readonly encodeOutput: (output: T) => unknown
  readonly decodeOutput: (output: unknown) => T
  readonly appendCommand: () => void
  /** Custody is immutable evidence for new ledger writes. It is deliberately a separate step
   * after the command row so a failed transaction cannot leave an orphan action trail. */
  readonly appendCustody?: () => void
  /** Replays must prove the stored custody still belongs to this exact command. */
  readonly validateReplayCustody?: () => void
  readonly appendSideEffects?: () => void
}

export type LedgerCustodyType =
  | "commitLoroPageContent"
  | "ensureLoroPage"
  | "migrateLegacyPage"
  | "prepareMeetingInDailyNote"
  | "createNodeWithIntent"
  | "addFact"
  | "assignTag"
  | "updateTag"
  | "agentChangeDecision"
  | "createApp"
  | "updateAppCode"
  | "deleteApp"
  | "calendarProjection"

interface BaseLedgerCustodyInput {
  readonly requestIdentity: string
  readonly fingerprint: string
  readonly type: LedgerCustodyType
  readonly workspaceId: string
  readonly actorKind: "user" | "employee" | "system"
  readonly actorLabel: string
  readonly targetId: string
  readonly employeeId?: string
  readonly jobId?: string
  readonly runId?: string
  readonly grantId?: string
  readonly chatId?: string
  readonly toolCallId?: string
}

export type LedgerCustodyInput =
  | (BaseLedgerCustodyInput & {
      readonly type: Exclude<LedgerCustodyType, "calendarProjection" | "updateTag" | "agentChangeDecision">
      readonly targetKind: "node"
    })
  | (BaseLedgerCustodyInput & { readonly type: "updateTag"; readonly targetKind: "tag" })
  | (BaseLedgerCustodyInput & { readonly type: "agentChangeDecision"; readonly targetKind: "chat"; readonly actorKind: "user" })
  | (BaseLedgerCustodyInput & { readonly type: "createApp" | "updateAppCode" | "deleteApp"; readonly targetKind: "app"; readonly actorKind: "user" })
  | (BaseLedgerCustodyInput & {
      readonly type: "calendarProjection"
      readonly targetKind: "calendarEvent"
    })

const isNonBlankString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0

const assertLedgerCustodyShape = (input: LedgerCustodyInput): void => {
  if (!isNonBlankString(input.requestIdentity) || !isNonBlankString(input.fingerprint) ||
    !isNonBlankString(input.workspaceId) || !isNonBlankString(input.actorLabel) ||
    input.actorLabel.length > 200 || !isNonBlankString(input.targetId) ||
    !["commitLoroPageContent", "ensureLoroPage", "migrateLegacyPage", "prepareMeetingInDailyNote", "createNodeWithIntent", "addFact", "assignTag", "updateTag", "agentChangeDecision", "createApp", "updateAppCode", "deleteApp", "calendarProjection"].includes(input.type) ||
    !["user", "employee", "system"].includes(input.actorKind) ||
    (input.type === "calendarProjection" ? input.targetKind !== "calendarEvent" : input.type === "updateTag" ? input.targetKind !== "tag" : input.type === "agentChangeDecision" ? input.targetKind !== "chat" : ["createApp", "updateAppCode", "deleteApp"].includes(input.type) ? input.targetKind !== "app" : input.targetKind !== "node") ||
    Schema.decodeUnknownOption(EntityId)(input.targetId)._tag === "None") {
    throw new LedgerConflict("invalid ledger custody shape")
  }
  for (const value of [input.employeeId, input.jobId, input.runId, input.grantId, input.chatId, input.toolCallId]) {
    if (value !== undefined && !isNonBlankString(value)) throw new LedgerConflict("invalid ledger custody reference")
  }
  if (input.actorKind === "employee" &&
    [input.employeeId, input.jobId, input.runId, input.grantId].some((value) => !isNonBlankString(value))) {
    throw new LedgerConflict("employee ledger custody requires employee, job, run, and grant references")
  }
  if (input.actorKind === "employee" && (input.chatId !== undefined || input.toolCallId !== undefined)) {
    throw new LedgerConflict("employee ledger custody cannot carry chat references")
  }
  if (input.type === "agentChangeDecision" && (input.actorKind !== "user" || input.chatId !== undefined || input.toolCallId !== undefined ||
    input.employeeId !== undefined || input.jobId !== undefined || input.runId !== undefined || input.grantId !== undefined)) {
    throw new LedgerConflict("reviewed chat decisions require authenticated user custody without employee or chat-tool references")
  }
  if (["createApp", "updateAppCode", "deleteApp"].includes(input.type) &&
    (input.actorKind !== "user" || input.chatId !== undefined || input.toolCallId !== undefined || input.employeeId !== undefined || input.jobId !== undefined || input.runId !== undefined || input.grantId !== undefined)) {
    throw new LedgerConflict("App lifecycle writes require authenticated user custody without employee or chat-tool references")
  }
  if (input.actorKind === "user" && (input.chatId === undefined) !== (input.toolCallId === undefined)) {
    throw new LedgerConflict("chat ledger custody requires both chat and tool references")
  }
  if (input.actorKind !== "employee" && (input.employeeId !== undefined || input.jobId !== undefined || input.runId !== undefined || input.grantId !== undefined)) {
    throw new LedgerConflict("employee references require employee ledger custody")
  }
}

const reportableRecordedWork = {
  createNodeWithIntent: { operation: "createdNode", targetKind: "node", payloadTarget: "nodeId" },
  addFact: { operation: "recordedFact", targetKind: "node", payloadTarget: "nodeId" },
  assignTag: { operation: "assignedSupertag", targetKind: "node", payloadTarget: "nodeId" },
  updateTag: { operation: "updatedSupertag", targetKind: "tag", payloadTarget: "tagId" },
  ensureLoroPage: { operation: "createdDocument", targetKind: "node", payloadTarget: "nodeId" },
  commitLoroPageContent: { operation: "updatedDocument", targetKind: "node", payloadTarget: "nodeId" },
  prepareMeetingInDailyNote: { operation: "preparedMeeting", targetKind: "node", payloadTarget: "nodeId" }
} as const satisfies Record<string, { readonly operation: StandupRecordedWorkOperation; readonly targetKind: "node" | "tag"; readonly payloadTarget: "nodeId" | "tagId" }>

type ReportableRecordedWorkType = keyof typeof reportableRecordedWork
const isReportableRecordedWorkType = (value: unknown): value is ReportableRecordedWorkType =>
  typeof value === "string" && value in reportableRecordedWork

const mirrorsCommitMessageForAttribution = (attribution: MutationAttribution): boolean =>
  attribution.kind === "agentJob"

const messageDerivationForAttribution = (
  attribution: MutationAttribution,
  legacyVersion: string,
): string => mirrorsCommitMessageForAttribution(attribution)
  ? COMMIT_MESSAGE_MIRROR_DERIVATION_VERSION
  : legacyVersion

export type LedgerRecordedWorkRunInput = Readonly<{
  readonly workspaceId: string
  readonly microEmployeeId: string
  readonly jobId: string
  readonly runId: string
  readonly grantId: string
  readonly requestIdentity: string
  readonly childNodeId: string
  readonly committedAt: string
}>
export type LedgerRecordedWorkItem = Readonly<{
  readonly operation: StandupRecordedWorkOperation
  readonly commitMessage: string
  readonly targetKind: "node" | "tag"
  readonly targetId: string
}>
export type LedgerRecordedWorkProjection =
  | Readonly<{ readonly state: "available"; readonly items: readonly LedgerRecordedWorkItem[]; readonly remainingCount: number }>
  | Readonly<{ readonly state: "unavailable" }>

export const ledgerRecordedWorkKey = (input: Pick<LedgerRecordedWorkRunInput, "workspaceId" | "runId">): string =>
  `${input.workspaceId}:${input.runId}`

export const MAX_EVIDENCE_RUNS_PER_STANDUP = 50
export const MAX_EVIDENCE_ITEMS_PER_RUN = 8
export const MAX_EVIDENCE_REMAINDER = 9_999
const MAX_EVIDENCE_CANDIDATES = MAX_EVIDENCE_ITEMS_PER_RUN + MAX_EVIDENCE_REMAINDER
const EVIDENCE_CANDIDATE_SENTINEL = MAX_EVIDENCE_CANDIDATES + 1

type RecordedWorkRow = Readonly<{
  readonly custodyRequestIdentity: string
  readonly custodyFingerprint: string
  readonly custodyType: string
  readonly custodyWorkspaceId: string
  readonly actorKind: string
  readonly actorLabel: string
  readonly employeeId: string | null
  readonly jobId: string | null
  readonly runId: string | null
  readonly grantId: string | null
  readonly targetKind: string | null
  readonly targetId: string | null
  readonly commandRequestIdentity: string | null
  readonly commandFingerprint: string | null
  readonly commandType: string | null
  readonly commandWorkspaceId: string | null
  readonly messageDerivationVersion: string | null
  readonly message: string | null
  readonly payload: string | null
  readonly createdAt: string | null
  readonly candidatePosition: number
  readonly candidateCount: number
}>

const decodeRecordedWorkPayload = (type: ReportableRecordedWorkType, raw: unknown): { readonly targetId: string; readonly commitMessage: string; readonly attribution: MutationAttribution } | undefined => {
  const extract = <T extends { readonly commitMessage: string; readonly attribution: MutationAttribution }>(decoded: unknown, target: (value: T) => string) => {
    if (typeof decoded !== "object" || decoded === null || (decoded as { readonly _tag?: unknown })._tag !== "Some") return undefined
    const value = (decoded as { readonly value: T }).value
    return { targetId: target(value), commitMessage: value.commitMessage, attribution: value.attribution }
  }
  try {
    switch (type) {
      case "createNodeWithIntent": return extract(Schema.decodeUnknownOption(CreateNodeWithIntentLedgerPayload, { onExcessProperty: "error" })(raw), (value: CreateNodeWithIntentLedgerPayload) => value.nodeId)
      case "addFact": return extract(Schema.decodeUnknownOption(AddFactLedgerPayload, { onExcessProperty: "error" })(raw), (value: AddFactLedgerPayload) => value.nodeId)
      case "assignTag": return extract(Schema.decodeUnknownOption(AssignTagLedgerPayload, { onExcessProperty: "error" })(raw), (value: AssignTagLedgerPayload) => value.nodeId)
      case "updateTag": return extract(Schema.decodeUnknownOption(UpdateTagLedgerPayload, { onExcessProperty: "error" })(raw), (value: UpdateTagLedgerPayload) => value.tagId)
      case "ensureLoroPage": return extract(Schema.decodeUnknownOption(EnsureLoroPageLedgerPayload, { onExcessProperty: "error" })(raw), (value: EnsureLoroPageLedgerPayload) => value.nodeId)
      case "commitLoroPageContent": return extract(Schema.decodeUnknownOption(CommitLoroPageContentLedgerPayload, { onExcessProperty: "error" })(raw), (value: CommitLoroPageContentLedgerPayload) => value.nodeId)
      case "prepareMeetingInDailyNote": return extract(Schema.decodeUnknownOption(PrepareMeetingInDailyNoteLedgerPayload, { onExcessProperty: "error" })(raw), (value: PrepareMeetingInDailyNoteLedgerPayload) => value.nodeId)
    }
  } catch {
    return undefined
  }
}

const decodeRecordedWorkRow = (row: RecordedWorkRow, input: LedgerRecordedWorkRunInput): LedgerRecordedWorkItem | undefined => {
  if (
    !isNonBlankString(row.actorLabel) || row.actorLabel.length > 200 ||
    !isReportableRecordedWorkType(row.custodyType) || row.commandRequestIdentity !== row.custodyRequestIdentity ||
    row.commandFingerprint !== row.custodyFingerprint || row.commandType !== row.custodyType ||
    row.commandWorkspaceId !== row.custodyWorkspaceId || row.custodyWorkspaceId !== input.workspaceId ||
    row.actorKind !== "employee" || row.employeeId !== input.microEmployeeId || row.jobId !== input.jobId ||
    row.runId !== input.runId || row.grantId !== input.grantId || row.targetKind !== reportableRecordedWork[row.custodyType].targetKind ||
    row.payload === null || row.message === null || row.createdAt === null ||
    Schema.decodeUnknownOption(IsoDateTimeString)(row.createdAt)._tag === "None" ||
    !Number.isFinite(Date.parse(row.createdAt)) || !Number.isFinite(Date.parse(input.committedAt)) ||
    Date.parse(row.createdAt) > Date.parse(input.committedAt) ||
    row.messageDerivationVersion !== COMMIT_MESSAGE_MIRROR_DERIVATION_VERSION) return undefined
  let raw: unknown
  try { raw = JSON.parse(row.payload) } catch { return undefined }
  const payload = decodeRecordedWorkPayload(row.custodyType, raw)
  if (payload === undefined || payload.targetId !== row.targetId || payload.attribution.kind !== "agentJob" ||
    payload.attribution.jobId !== input.jobId || payload.attribution.runId !== input.runId) return undefined
  let commitMessage: string
  try { commitMessage = canonicalMutationCommitMessage(payload.commitMessage) } catch { return undefined }
  if (commitMessage !== payload.commitMessage || commitMessage !== row.message) return undefined
  return { operation: reportableRecordedWork[row.custodyType].operation, commitMessage, targetKind: row.targetKind, targetId: row.targetId }
}

export class LedgerConflict extends Error {}

export const ledgerFingerprint = (command: Omit<CreateNodeLedgerCommand, "fingerprint" | "requestId" | "requestIdentity" | "createdAt">): string => {
  // A stable non-cryptographic fingerprint is sufficient for same-DO idempotency conflict
  // detection; it is not presented as a security primitive.
  const source = JSON.stringify({
    version: LEDGER_COMMAND_VERSION,
    type: "createNode",
    workspaceId: command.workspaceId,
    principal: command.principal,
    policy: command.policy,
    message: createNodeCommitMessage(command.title),
    payload: command.payload
  })
  let hash = 0x811c9dc5
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

export const createNodeWithIntentLedgerFingerprint = (command: Omit<CreateNodeWithIntentLedgerCommandInput, "fingerprint" | "requestIdentity" | "createdAt">): string =>
  sha256HexSync(canonicalJsonBytes({
    version: LEDGER_COMMAND_VERSION,
    type: "createNodeWithIntent",
    requestId: command.requestId,
    workspaceId: command.workspaceId,
    principal: command.principal,
    policy: command.policy,
    requestedNodeId: command.requestedNodeId ?? null,
    title: command.title,
    commitMessage: canonicalMutationCommitMessage(command.commitMessage),
    attribution: Schema.encodeSync(MutationAttribution)(command.attribution),
    messageDerivationVersion: messageDerivationForAttribution(command.attribution, CREATE_NODE_WITH_INTENT_MESSAGE_DERIVATION_VERSION)
  }))

export type AppLedgerCommandInput = Readonly<{
  requestIdentity: string; requestId: string; workspaceId: string; principal: string; policy: string
  appId: string; commitMessage: string; attribution: MutationAttribution; fingerprint: string; createdAt: string
  type: "createApp" | "updateAppCode" | "deleteApp"; payload: Record<string, unknown>
}>

/** Fingerprints bind every caller-controlled, destructive baseline. They deliberately use a
 * digest/byte length for source instead of source itself. */
export const appLedgerFingerprint = (command: Omit<AppLedgerCommandInput, "fingerprint" | "requestIdentity" | "createdAt">): string =>
  sha256HexSync(canonicalJsonBytes({
    version: LEDGER_COMMAND_VERSION, type: command.type, requestId: command.requestId,
    workspaceId: command.workspaceId, principal: command.principal, policy: command.policy,
    appId: command.appId, commitMessage: canonicalMutationCommitMessage(command.commitMessage),
    attribution: Schema.encodeSync(MutationAttribution)(command.attribution),
    messageDerivationVersion: APP_LIFECYCLE_MESSAGE_DERIVATION_VERSION,
    payload: command.payload
  }))

export const agentChangeDecisionLedgerFingerprint = (
  command: Omit<AgentChangeDecisionLedgerCommand, "fingerprint" | "requestId" | "requestIdentity" | "createdAt">
): string => sha256HexSync(canonicalJsonBytes({
  version: LEDGER_COMMAND_VERSION,
  type: "agentChangeDecision",
  workspaceId: command.workspaceId,
  proposalId: command.proposalId,
  decision: command.decision,
  principal: command.principal,
  provenance: canonicalMutationProvenance(command.provenance),
  policy: command.policy,
  messageDerivationVersion: AGENT_CHANGE_DECISION_MESSAGE_DERIVATION_VERSION,
  message: canonicalMutationCommitMessage(command.message),
  payload: command.payload
}))

/** Canonical, cryptographic identity for the mainline Supertag mutation. Timestamp is omitted so
 * retries of one request remain equivalent; caller rationale and asserted attribution are included
 * in the private command payload and therefore cannot silently drift across a retry. */
export const applySupertagLedgerFingerprint = (command: Omit<ApplySupertagLedgerCommandInput, "fingerprint" | "createdAt" | "requestIdentity">): string =>
  sha256HexSync(canonicalJsonBytes({
    version: LEDGER_COMMAND_VERSION,
    type: "applySupertag",
    requestId: command.requestId,
    workspaceId: command.workspaceId,
    principal: command.principal,
    policy: command.policy,
    nodeId: command.nodeId,
    tagId: command.tagId,
    fieldValues: command.fieldValues,
    commitMessage: command.commitMessage,
    attribution: Schema.encodeSync(MutationAttribution)(command.attribution),
    messageDerivationVersion: APPLY_SUPERTAG_MESSAGE_DERIVATION_VERSION
}))

export const addFactLedgerFingerprint = (command: Omit<AddFactLedgerCommandInput, "fingerprint" | "createdAt" | "requestIdentity">): string =>
  sha256HexSync(canonicalJsonBytes({ version: LEDGER_COMMAND_VERSION, type: "addFact", requestId: command.requestId,
    workspaceId: command.workspaceId, principal: command.principal, policy: command.policy, nodeId: command.nodeId,
    predicateId: command.predicateId, value: command.value, factId: command.factId ?? null, commitMessage: canonicalMutationCommitMessage(command.commitMessage),
    attribution: Schema.encodeSync(MutationAttribution)(command.attribution), messageDerivationVersion: messageDerivationForAttribution(command.attribution, ADD_FACT_MESSAGE_DERIVATION_VERSION) }))

/** Canonical identity for a public relationship mutation. Generated edge ids and timestamps are
 * deliberately excluded so an uncertain retry can replay the original result. */
export const createEdgeLedgerFingerprint = (
  command: Omit<CreateEdgeLedgerCommandInput, "fingerprint" | "createdAt" | "requestIdentity">
): string => sha256HexSync(canonicalJsonBytes({
  version: LEDGER_COMMAND_VERSION,
  type: "createEdge",
  requestId: command.requestId,
  workspaceId: command.workspaceId,
  principal: command.principal,
  policy: command.policy,
  relationDefinitionId: command.relationDefinitionId,
  sourceNodeId: command.sourceNodeId,
  targetNodeId: command.targetNodeId,
  commitMessage: command.commitMessage,
  attribution: Schema.encodeSync(MutationAttribution)(command.attribution),
  messageDerivationVersion: CREATE_EDGE_MESSAGE_DERIVATION_VERSION
}))

/** Canonical identity for a public Supertag-definition mutation. The public route supplies the
 * already-normalized name and ordered parent ids; generated tag ids and timestamps are excluded so
 * uncertain retries replay the original output. */
export const createTagLedgerFingerprint = (
  command: Omit<CreateTagLedgerCommandInput, "fingerprint" | "createdAt" | "requestIdentity">
): string => sha256HexSync(canonicalJsonBytes({
  version: LEDGER_COMMAND_VERSION,
  type: "createTag",
  requestId: command.requestId,
  workspaceId: command.workspaceId,
  principal: command.principal,
  policy: command.policy,
  name: command.name,
  parentIds: command.parentIds,
  commitMessage: command.commitMessage,
  attribution: Schema.encodeSync(MutationAttribution)(command.attribution),
  messageDerivationVersion: CREATE_TAG_MESSAGE_DERIVATION_VERSION
}))

export const updateTagLedgerFingerprint = (command: Omit<UpdateTagLedgerCommandInput, "fingerprint" | "createdAt" | "requestIdentity">): string =>
  sha256HexSync(canonicalJsonBytes({
    version: LEDGER_COMMAND_VERSION, type: "updateTag", requestId: command.requestId,
    workspaceId: command.workspaceId, principal: command.principal, policy: command.policy,
    tagId: command.tagId, expectedRevision: command.expectedRevision, name: command.name, parentIds: command.parentIds,
    commitMessage: canonicalMutationCommitMessage(command.commitMessage), attribution: Schema.encodeSync(MutationAttribution)(command.attribution),
    messageDerivationVersion: messageDerivationForAttribution(command.attribution, UPDATE_TAG_MESSAGE_DERIVATION_VERSION)
  }))

/** The fingerprint is built from normalized intent and the authoritative principal/policy. The
 * outcome is intentionally excluded: it is a durable first-execution fact, not caller input. */
export const ensureLoroPageLedgerFingerprint = (
  command: Omit<EnsureLoroPageLedgerCommandInput, "fingerprint" | "createdAt" | "requestIdentity" | "outcome" | "storageVersion" | "schemaVersion">
): string => sha256HexSync(canonicalJsonBytes({
  version: LEDGER_COMMAND_VERSION, type: "ensureLoroPage", requestId: command.requestId,
  workspaceId: command.workspaceId, principal: command.principal, policy: command.policy, nodeId: command.nodeId,
  commitMessage: canonicalMutationCommitMessage(command.commitMessage), attribution: Schema.encodeSync(MutationAttribution)(command.attribution),
  messageDerivationVersion: messageDerivationForAttribution(command.attribution, ENSURE_LORO_PAGE_MESSAGE_DERIVATION_VERSION)
}))

export const commitLoroPageContentLedgerFingerprint = (
  command: Omit<CommitLoroPageContentLedgerCommandInput, "fingerprint" | "createdAt" | "requestIdentity" | "resultVersionVectorSha256" | "resultSnapshotSha256">
): string => sha256HexSync(canonicalJsonBytes({
  version: LEDGER_COMMAND_VERSION, type: "commitLoroPageContent", requestId: command.requestId,
  workspaceId: command.workspaceId, principal: command.principal, capability: "build", policy: command.policy, nodeId: command.nodeId,
  expectedStorageVersion: command.expectedStorageVersion, expectedSnapshotSha256: command.expectedSnapshotSha256,
  baseVersionVectorSha256: command.baseVersionVectorSha256, updateSha256: command.updateSha256, updateLength: command.updateLength,
  commitMessage: canonicalMutationCommitMessage(command.commitMessage), attribution: Schema.encodeSync(MutationAttribution)(command.attribution),
  messageDerivationVersion: messageDerivationForAttribution(command.attribution, COMMIT_LORO_PAGE_CONTENT_MESSAGE_DERIVATION_VERSION)
}))

/** Stable identity for the private, user-directed agent-chat adapter. Its semantic splice is
 * intentionally independent of the current Loro CAS witness so a retried tool call can replay
 * after the first attempt has already advanced the page. The gateway still derives and checks this
 * value from the closed agent-chat binding; it is not caller-supplied authority. */
export const agentLoroEditLedgerFingerprint = (command: {
  readonly requestId: string
  readonly workspaceId: string
  readonly principal: string
  readonly policy: string
  readonly nodeId: string
  readonly index: number
  readonly deleteCount: number
  readonly insertText: string
  readonly commitMessage: string
  readonly attribution: typeof MutationAttribution.Type
}): string => sha256HexSync(canonicalJsonBytes({
  version: "athenaeum.agent-loro-edit.v1",
  requestId: command.requestId,
  workspaceId: command.workspaceId,
  principal: command.principal,
  policy: command.policy,
  nodeId: command.nodeId,
  index: command.index,
  deleteCount: command.deleteCount,
  insertText: command.insertText,
  commitMessage: command.commitMessage,
  attribution: Schema.encodeSync(MutationAttribution)(command.attribution)
}))

export const prepareMeetingInDailyNoteLedgerFingerprint = (command: Omit<PrepareMeetingInDailyNoteLedgerCommandInput, "fingerprint" | "createdAt" | "requestIdentity" | "status" | "resultSnapshotSha256">): string => sha256HexSync(canonicalJsonBytes({
  // Request ids identify one transport attempt; the stable event/date/page/time-zone request
  // identity is supplied by the caller. Human-facing commit messages and UI surfaces are
  // annotations, not operation identity: web and native retries must replay the same preparation
  // even when their copy or surface differs. The first accepted command still retains both
  // annotations for provenance.
  version: LEDGER_COMMAND_VERSION, type: "prepareMeetingInDailyNote", workspaceId: command.workspaceId,
  principal: command.principal, capability: "build", policy: command.policy, nodeId: command.nodeId,
  localDate: command.localDate, timeZone: command.timeZone, occurrenceKey: command.occurrenceKey,
  messageDerivationVersion: PREPARE_MEETING_IN_DAILY_NOTE_MESSAGE_DERIVATION_VERSION
}))
export const activateLoroPageLedgerFingerprint = (command: Omit<ActivateLoroPageLedgerCommandInput, "fingerprint" | "createdAt" | "requestIdentity" | "storageVersion">): string => sha256HexSync(canonicalJsonBytes({
  version: LEDGER_COMMAND_VERSION, type: "activateLoroPage", requestId: command.requestId, workspaceId: command.workspaceId, principal: command.principal, capability: "build", policy: command.policy, nodeId: command.nodeId,
  expectedAutomergeHeadsHash: command.expectedAutomergeHeadsHash, expectedAutomergeBytesSha256: command.expectedAutomergeBytesSha256, snapshotSha256: command.snapshotSha256, snapshotLength: command.snapshotLength, schemaVersion: command.schemaVersion,
  commitMessage: command.commitMessage, attribution: Schema.encodeSync(MutationAttribution)(command.attribution), messageDerivationVersion: ACTIVATE_LORO_PAGE_MESSAGE_DERIVATION_VERSION
}))
export const migrateLegacyPageLedgerFingerprint = (command: Omit<MigrateLegacyPageLedgerCommandInput, "fingerprint" | "createdAt" | "requestIdentity" | "resultSnapshotSha256" | "resultSnapshotLength" | "storageVersion">): string => sha256HexSync(canonicalJsonBytes({
  version: LEDGER_COMMAND_VERSION, type: "migrateLegacyPage", requestId: command.requestId, workspaceId: command.workspaceId,
  principal: command.principal, capability: "build", policy: command.policy, nodeId: command.nodeId,
  sourceStorageVersion: command.sourceStorageVersion, sourceAutomerge: command.sourceAutomerge,
  migrationEngineVersion: LEGACY_PAGE_MIGRATION_ENGINE_VERSION, schemaVersion: command.schemaVersion,
  commitMessage: command.commitMessage, attribution: Schema.encodeSync(MutationAttribution)(command.attribution),
  messageDerivationVersion: MIGRATE_LEGACY_PAGE_MESSAGE_DERIVATION_VERSION
}))

/** Canonical identity for the public Supertag-field definition mutation. Generated field ids and
 * timestamps are excluded so an uncertain retry replays the original definition exactly. */
export const defineTagFieldLedgerFingerprint = (
  command: Omit<DefineTagFieldLedgerCommandInput, "fingerprint" | "createdAt" | "requestIdentity">
): string => sha256HexSync(canonicalJsonBytes({
  version: LEDGER_COMMAND_VERSION,
  type: "defineTagField",
  requestId: command.requestId,
  workspaceId: command.workspaceId,
  principal: command.principal,
  policy: command.policy,
  tagId: command.tagId,
  name: command.name,
  valueKind: command.valueKind,
  sortOrder: command.sortOrder,
  commitMessage: command.commitMessage,
  attribution: Schema.encodeSync(MutationAttribution)(command.attribution),
  messageDerivationVersion: DEFINE_TAG_FIELD_MESSAGE_DERIVATION_VERSION
}))

/** Canonical identity for the desired-set mention projection. Generated edge ids and timestamps
 * are deliberately excluded; the exact created/removed journal is retained in the command payload
 * after the graph mutation succeeds. */
export const syncNoteReferencesLedgerFingerprint = (
  command: Omit<SyncNoteReferencesLedgerCommandInput, "fingerprint" | "createdAt" | "requestIdentity" | "created" | "removed">
): string => sha256HexSync(canonicalJsonBytes({
  version: LEDGER_COMMAND_VERSION,
  type: "syncNoteReferences",
  requestId: command.requestId,
  workspaceId: command.workspaceId,
  principal: command.principal,
  policy: command.policy,
  nodeId: command.nodeId,
  referencedNodeIds: [...command.referencedNodeIds].sort(),
  commitMessage: command.commitMessage,
  attribution: Schema.encodeSync(MutationAttribution)(command.attribution),
  messageDerivationVersion: SYNC_NOTE_REFERENCES_MESSAGE_DERIVATION_VERSION
}))

/** Canonical identity for relation-definition creation. Relation names are intentionally exact;
 * trimming or case-folding here would change the existing GraphService persistence contract. */
export const createRelationDefinitionLedgerFingerprint = (
  command: Omit<CreateRelationDefinitionLedgerCommandInput, "fingerprint" | "createdAt" | "requestIdentity">
): string => sha256HexSync(canonicalJsonBytes({
  version: LEDGER_COMMAND_VERSION,
  type: "createRelationDefinition",
  requestId: command.requestId,
  workspaceId: command.workspaceId,
  principal: command.principal,
  policy: command.policy,
  forwardName: command.forwardName,
  inverseName: command.inverseName,
  sourceTagId: command.sourceTagId,
  targetTagId: command.targetTagId,
  cardinality: command.cardinality,
  commitMessage: command.commitMessage,
  attribution: Schema.encodeSync(MutationAttribution)(command.attribution),
  messageDerivationVersion: CREATE_RELATION_DEFINITION_MESSAGE_DERIVATION_VERSION
}))

/** Canonical identity for bookmark capture. Generated bookmark identity and capture time are
 * excluded; optional title presence is explicit so absent, empty, whitespace, and non-empty
 * values cannot collapse during canonical serialization. */
export const createBookmarkLedgerFingerprint = (
  command: Omit<CreateBookmarkLedgerCommandInput, "fingerprint" | "createdAt" | "requestIdentity" | "bookmarkId" | "capturedAt">
): string => sha256HexSync(canonicalJsonBytes({
  version: LEDGER_COMMAND_VERSION,
  type: "createBookmark",
  requestId: command.requestId,
  workspaceId: command.workspaceId,
  principal: command.principal,
  policy: command.policy,
  url: command.url,
  title: { present: command.title !== undefined, value: command.title ?? null },
  commitMessage: command.commitMessage,
  attribution: Schema.encodeSync(MutationAttribution)(command.attribution),
  messageDerivationVersion: CREATE_BOOKMARK_MESSAGE_DERIVATION_VERSION
}))

export const linkCalendarEventToNodeLedgerFingerprint = (
  command: Omit<LinkCalendarEventToNodeLedgerCommandInput, "fingerprint" | "createdAt" | "requestIdentity">
): string => sha256HexSync(canonicalJsonBytes({
  version: LEDGER_COMMAND_VERSION,
  type: "linkCalendarEventToNode",
  requestId: command.requestId,
  workspaceId: command.workspaceId,
  principal: command.principal,
  policy: command.policy,
  calendarEventId: command.calendarEventId,
  nodeId: command.nodeId,
  commitMessage: command.commitMessage,
  attribution: Schema.encodeSync(MutationAttribution)(command.attribution),
  messageDerivationVersion: LINK_CALENDAR_EVENT_TO_NODE_MESSAGE_DERIVATION_VERSION
}))

/** Provider ids and emails are deliberately absent: replay identity is binding-local request
 * identity plus opaque source/attendee digests. */
export const calendarProjectionLedgerFingerprint = (
  command: Omit<CalendarProjectionLedgerCommandInput, "fingerprint" | "createdAt" | "requestIdentity" | "calendarEventId"> & {
    /** Private source-event identity strengthens the replay witness without entering the public
     * command payload (provider ids remain backend-private). */
    readonly sourceEventKeyDigest?: string
  }
): string => sha256HexSync(canonicalJsonBytes({
  version: LEDGER_COMMAND_VERSION, type: "calendarProjection", requestId: command.requestId,
  workspaceId: command.workspaceId, principal: command.principal, policy: command.policy,
  sourceRevisionDigest: command.sourceRevisionDigest,
  sourceEventKeyDigest: command.sourceEventKeyDigest ?? null,
  attendeeObservationDigests: [...command.attendeeObservationDigests].sort(),
  commitMessage: command.commitMessage, attribution: Schema.encodeSync(MutationAttribution)(command.attribution),
  messageDerivationVersion: CALENDAR_PROJECTION_MESSAGE_DERIVATION_VERSION
}))

/** Canonical identity for one transcript append. The optional speaker marker is explicit so
 * absent and present-with-value requests cannot collapse during retries; transcript text is kept
 * byte-for-byte and remains private to the command payload. */
export const appendTranscriptSegmentLedgerFingerprint = (
  command: Omit<AppendTranscriptSegmentLedgerCommandInput, "fingerprint" | "createdAt" | "requestIdentity">
): string => sha256HexSync(canonicalJsonBytes({
  version: LEDGER_COMMAND_VERSION,
  type: "appendTranscriptSegment",
  requestId: command.requestId,
  workspaceId: command.workspaceId,
  principal: command.principal,
  policy: command.policy,
  meetingId: command.meetingId,
  speakerId: { present: command.speakerId !== undefined, value: command.speakerId ?? null },
  text: command.text,
  startOffsetMs: command.startOffsetMs,
  endOffsetMs: command.endOffsetMs,
  source: command.source,
  commitMessage: command.commitMessage,
  attribution: Schema.encodeSync(MutationAttribution)(command.attribution),
  messageDerivationVersion: APPEND_TRANSCRIPT_SEGMENT_MESSAGE_DERIVATION_VERSION
}))

/** Canonical identity for a meeting-session start. Exact title semantics are retained; generated
 * meeting identity and start time are durable evidence, but excluded so a response-lost retry
 * returns the original session rather than minting a second one. */
export const startMeetingLedgerFingerprint = (
  command: Omit<StartMeetingLedgerCommandInput, "fingerprint" | "createdAt" | "requestIdentity">
): string => sha256HexSync(canonicalJsonBytes({
  version: LEDGER_COMMAND_VERSION,
  type: "startMeeting",
  requestId: command.requestId,
  workspaceId: command.workspaceId,
  principal: command.principal,
  policy: command.policy,
  title: command.title,
  commitMessage: command.commitMessage,
  attribution: Schema.encodeSync(MutationAttribution)(command.attribution),
  messageDerivationVersion: START_MEETING_MESSAGE_DERIVATION_VERSION
}))

const membershipLedgerFingerprint = (
  type: "assignTag" | "unassignTag",
  derivationVersion: string,
  command: Omit<AssignTagLedgerCommandInput, "fingerprint" | "createdAt" | "requestIdentity"> | Omit<UnassignTagLedgerCommandInput, "fingerprint" | "createdAt" | "requestIdentity">
): string => sha256HexSync(canonicalJsonBytes({
  version: LEDGER_COMMAND_VERSION,
  type,
  requestId: command.requestId,
  workspaceId: command.workspaceId,
  principal: command.principal,
  policy: command.policy,
  nodeId: command.nodeId,
  tagId: command.tagId,
  commitMessage: type === "assignTag" ? canonicalMutationCommitMessage(command.commitMessage) : command.commitMessage,
  attribution: Schema.encodeSync(MutationAttribution)(command.attribution),
  messageDerivationVersion: type === "assignTag"
    ? messageDerivationForAttribution(command.attribution, derivationVersion)
    : derivationVersion
}))

export const assignTagLedgerFingerprint = (
  command: Omit<AssignTagLedgerCommandInput, "fingerprint" | "createdAt" | "requestIdentity">
): string => membershipLedgerFingerprint("assignTag", ASSIGN_TAG_MESSAGE_DERIVATION_VERSION, command)

export const unassignTagLedgerFingerprint = (
  command: Omit<UnassignTagLedgerCommandInput, "fingerprint" | "createdAt" | "requestIdentity">
): string => membershipLedgerFingerprint("unassignTag", UNASSIGN_TAG_MESSAGE_DERIVATION_VERSION, command)

export class LedgerService {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS ledger_commands (
      requestIdentity TEXT PRIMARY KEY, requestId TEXT NOT NULL, fingerprint TEXT NOT NULL,
      version TEXT NOT NULL, type TEXT NOT NULL, workspaceId TEXT NOT NULL, principal TEXT NOT NULL,
      capability TEXT NOT NULL, policy TEXT NOT NULL, messageDerivationVersion TEXT NOT NULL,
      message TEXT NOT NULL, payload TEXT NOT NULL, createdAt TEXT NOT NULL
    )`)
    sql.exec(`CREATE TABLE IF NOT EXISTS ledger_receipts (
      requestIdentity TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, output TEXT NOT NULL
    )`)
    sql.exec(`CREATE TABLE IF NOT EXISTS ledger_outbox_intents (
      requestIdentity TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL
    )`)
    sql.exec(`CREATE TABLE IF NOT EXISTS ledger_events (
      requestIdentity TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL
    )`)
    sql.exec(`CREATE TABLE IF NOT EXISTS ledger_custody (
      requestIdentity TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, type TEXT NOT NULL,
      workspaceId TEXT NOT NULL, actorKind TEXT NOT NULL, actorLabel TEXT NOT NULL,
      employeeId TEXT, jobId TEXT, runId TEXT, grantId TEXT, chatId TEXT, toolCallId TEXT,
      targetKind TEXT NOT NULL, targetId TEXT NOT NULL
    )`)
    sql.exec(`CREATE TABLE IF NOT EXISTS ledger_custody_schema (
      id INTEGER PRIMARY KEY CHECK (id = 1), commandHighWater INTEGER NOT NULL
    )`)
    // The watermark is written exactly once. A missing custody row is only neutral legacy data
    // when its immutable command row predates this schema; newer omissions fail closed.
    sql.exec(`INSERT OR IGNORE INTO ledger_custody_schema (id, commandHighWater)
      SELECT 1, COALESCE(MAX(rowid), 0) FROM ledger_commands`)
  }

  existing(requestIdentity: string, fingerprint: string): StoredLedgerReceipt | undefined {
    const row = this.sql.exec<{ fingerprint: string; output: string }>(
      "SELECT fingerprint, output FROM ledger_receipts WHERE requestIdentity = ?", requestIdentity
    ).toArray()[0]
    if (row === undefined) return undefined
    if (row.fingerprint !== fingerprint) throw new LedgerConflict("request identity was already used for a different command")
    return { fingerprint: row.fingerprint, output: JSON.parse(row.output) }
  }

  /** Cutover probe for the pre-executeV2 reviewed-chat envelope. An exact historical receipt is
   * replayable without inventing custody; a command without its receipt is a deterministic
   * migration failure, so callers must retry with a fresh request id instead of duplicating the
   * decision. */
  legacyAgentChangeDecisionState(
    requestIdentity: string,
    fingerprint: string
  ): { readonly state: "absent" } | { readonly state: "exact"; readonly output: unknown } | { readonly state: "missing-receipt" } {
    const command = this.sql.exec<{ fingerprint: string; type: string }>(
      "SELECT fingerprint, type FROM ledger_commands WHERE requestIdentity = ?", requestIdentity
    ).toArray()[0]
    if (command === undefined) return { state: "absent" }
    if (command.type !== "agentChangeDecision" || command.fingerprint !== fingerprint) {
      throw new LedgerConflict("request identity was already used for a different command")
    }
    const receipt = this.sql.exec<{ fingerprint: string; output: string }>(
      "SELECT fingerprint, output FROM ledger_receipts WHERE requestIdentity = ?", requestIdentity
    ).toArray()[0]
    if (receipt === undefined) return { state: "missing-receipt" }
    if (receipt.fingerprint !== fingerprint) throw new LedgerConflict("request identity was already used for a different command")
    return { state: "exact", output: JSON.parse(receipt.output) }
  }

  private existingV2(requestIdentity: string, fingerprint: string, type: string): StoredLedgerReceiptV2 | undefined {
    const row = this.sql.exec<{ fingerprint: string; output: string }>(
      "SELECT fingerprint, output FROM ledger_receipts WHERE requestIdentity = ?", requestIdentity
    ).toArray()[0]
    if (row === undefined) return undefined
    if (row.fingerprint !== fingerprint) throw new LedgerConflict("request identity was already used for a different command")
    const parsed: unknown = JSON.parse(row.output)
    if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== LEDGER_RECEIPT_V2_VERSION) {
      throw new LedgerConflict("request identity has an incompatible legacy receipt")
    }
    const receipt = parsed as { version: unknown; type?: unknown; output?: unknown }
    if (receipt.type !== type) throw new LedgerConflict("request identity was already used for a different command type")
    return {
      version: LEDGER_RECEIPT_V2_VERSION,
      type,
      fingerprint: row.fingerprint,
      output: receipt.output
    }
  }

  /** Read-only replay probe used by semantic adapters that must avoid rebuilding a mutation
   * against already-advanced state. It deliberately reuses the same fingerprint/type conflict
   * checks as executeV2 and never returns the private receipt payload. */
  hasV2Receipt(requestIdentity: string, fingerprint: string, type: string): boolean {
    return this.existingV2(requestIdentity, fingerprint, type) !== undefined
  }

  /** Executes a typed mutation inside the caller-owned Workspace DO transaction. The order is
   * replay check -> graph callback -> test failpoint -> command/side effects -> v2 receipt. A thrown
   * callback or append rolls back the whole transaction, while a replay never invokes the mutation. */
  executeV2<T>(input: ExecuteLedgerV2Input<T>): T {
    const replay = this.existingV2(input.requestIdentity, input.fingerprint, input.type)
    if (replay !== undefined) {
      input.validateReplayCustody?.()
      return input.decodeOutput(replay.output)
    }
    const output = input.mutate(issueLedgerMutationCapability({
      type: input.type,
      workspaceId: input.mutationScope?.workspaceId ?? "",
      targetKind: input.mutationScope?.targetKind ?? "",
      targetId: input.mutationScope?.targetId ?? "",
      fingerprint: input.fingerprint
    }))
    ledgerExecuteTestHook.afterMutation?.()
    input.appendCommand()
    input.appendCustody?.()
    input.appendSideEffects?.()
    this.receiptV2(input.requestIdentity, input.fingerprint, input.type, input.encodeOutput(output))
    return output
  }

  appendCustody(input: LedgerCustodyInput): void {
    assertLedgerCustodyShape(input)
    ledgerCustodyTestHook.beforeInsert?.()
    this.sql.exec(`INSERT INTO ledger_custody (
      requestIdentity, fingerprint, type, workspaceId, actorKind, actorLabel,
      employeeId, jobId, runId, grantId, chatId, toolCallId, targetKind, targetId
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.requestIdentity, input.fingerprint, input.type, input.workspaceId, input.actorKind, input.actorLabel,
    input.employeeId ?? null, input.jobId ?? null, input.runId ?? null, input.grantId ?? null,
    input.chatId ?? null, input.toolCallId ?? null, input.targetKind, input.targetId)
  }

  validateCustody(input: LedgerCustodyInput): void {
    const row = this.sql.exec<{
      requestIdentity: string; fingerprint: string; type: LedgerCustodyType; workspaceId: string
      actorKind: "user" | "employee" | "system"; actorLabel: string
      employeeId: string | null; jobId: string | null; runId: string | null; grantId: string | null
      chatId: string | null; toolCallId: string | null; targetKind: "node" | "calendarEvent" | "tag" | "chat" | "app"; targetId: string
    }>(`SELECT requestIdentity, fingerprint, type, workspaceId, actorKind, actorLabel,
      employeeId, jobId, runId, grantId, chatId, toolCallId, targetKind, targetId
      FROM ledger_custody WHERE requestIdentity = ?`, input.requestIdentity).toArray()[0]
    if (row === undefined) {
      // App lifecycle commands were introduced with authenticated custody and have no historical
      // pre-custody form. Never let the generic legacy watermark exception turn a missing App
      // custody row into a successful replay; doing so would manufacture provenance after a
      // partial write or tamper.
      if (input.type === "createApp" || input.type === "updateAppCode" || input.type === "deleteApp") {
        throw new LedgerConflict("App lifecycle replay requires an authenticated custody row")
      }
      // A receipt written before custody was introduced can still be replayed without inventing
      // provenance. The immutable command watermark is the only authority for that historical
      // exception; a newer Loro receipt missing custody is a failed write and must stay blocked.
      const command = this.sql.exec<{ type: string; commandRowId: number; commandHighWater: number }>(
        `SELECT c.type, c.rowid AS commandRowId,
                (SELECT commandHighWater FROM ledger_custody_schema WHERE id = 1) AS commandHighWater
         FROM ledger_commands c WHERE c.requestIdentity = ?`, input.requestIdentity
      ).toArray()[0]
      if (command !== undefined && command.type === input.type && command.commandRowId <= command.commandHighWater) return
      throw new LedgerConflict("request identity has missing or mismatched custody")
    }
    const normalizedBase = {
      ...row,
      employeeId: row.employeeId ?? undefined, jobId: row.jobId ?? undefined, runId: row.runId ?? undefined,
      grantId: row.grantId ?? undefined, chatId: row.chatId ?? undefined, toolCallId: row.toolCallId ?? undefined
    }
    const normalized: LedgerCustodyInput = row.type === "calendarProjection" && row.targetKind === "calendarEvent"
      ? { ...normalizedBase, type: "calendarProjection", targetKind: "calendarEvent" }
      : row.type === "updateTag" && row.targetKind === "tag"
        ? { ...normalizedBase, type: "updateTag", targetKind: "tag" }
      : row.type === "agentChangeDecision" && row.targetKind === "chat" && row.actorKind === "user"
        ? { ...normalizedBase, actorKind: "user", type: "agentChangeDecision", targetKind: "chat" }
      : ["createApp", "updateAppCode", "deleteApp"].includes(row.type) && row.targetKind === "app" && row.actorKind === "user"
        ? { ...normalizedBase, actorKind: "user", type: row.type as "createApp" | "updateAppCode" | "deleteApp", targetKind: "app" }
      : row.type !== "calendarProjection" && row.type !== "updateTag" && row.type !== "agentChangeDecision" && row.targetKind === "node"
        ? { ...normalizedBase, type: row.type, targetKind: "node" }
        : (() => { throw new LedgerConflict("request identity has missing or mismatched custody") })()
    try { assertLedgerCustodyShape(normalized) } catch {
      throw new LedgerConflict("request identity has missing or mismatched custody")
    }
    if (Object.entries(input).some(([key, value]) => normalized[key as keyof LedgerCustodyInput] !== value) ||
      Object.keys(normalized).some((key) => !(key in input) && normalized[key as keyof LedgerCustodyInput] !== undefined)) {
      throw new LedgerConflict("request identity has missing or mismatched custody")
    }
  }

  /** Returns only the command-safe fields needed by the authenticated audit surface. The
   * chronological feed deliberately does not read receipts, event payloads, or outbox intents:
   * those are delivery/implementation records, not user-facing history. */
  listRecentActivity(
    limit: number,
    window: { readonly from?: string; readonly to?: string } = {}
  ): ReadonlyArray<{
    readonly type: string
    readonly principal: string
    readonly message: string
    readonly createdAt: string
    readonly actorKind?: "user" | "employee" | "system"
    readonly actorLabel?: string
    readonly targetKind?: "node" | "tag"
    readonly targetId?: string
  }> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 20)
    const predicates: string[] = []
    const bindings: string[] = []
    if (window.from !== undefined) {
      predicates.push("c.createdAt >= ?")
      bindings.push(window.from)
    }
    if (window.to !== undefined) {
      predicates.push("c.createdAt < ?")
      bindings.push(window.to)
    }
    const where = predicates.length === 0 ? "" : `WHERE ${predicates.join(" AND ")}`
    return this.sql.exec<{
      type: string
      principal: string
      message: string
      createdAt: string
      actorKind: "user" | "employee" | "system" | null
      actorLabel: string | null
      custodyType: string | null
      employeeId: string | null
      jobId: string | null
      runId: string | null
      grantId: string | null
      chatId: string | null
      toolCallId: string | null
      targetKind: "node" | "tag" | "chat" | "app" | null
      targetId: string | null
      commandRowId: number
      commandHighWater: number
    }>(
      `SELECT c.type, c.principal, c.message, c.createdAt,
              custody.actorKind, custody.actorLabel, custody.type AS custodyType,
              custody.employeeId, custody.jobId, custody.runId, custody.grantId, custody.chatId, custody.toolCallId,
              custody.targetKind, custody.targetId,
              c.rowid AS commandRowId,
              (SELECT commandHighWater FROM ledger_custody_schema WHERE id = 1) AS commandHighWater
       FROM ledger_commands c
       LEFT JOIN ledger_custody custody ON custody.requestIdentity = c.requestIdentity
       ${where}
       ORDER BY c.createdAt DESC, c.requestIdentity DESC
       LIMIT ?`,
      ...bindings,
      boundedLimit
    ).toArray().flatMap((row) => {
      if (row.actorKind === null) {
        // Only the four Loro gateway operations have mandatory custody in this vertical. Other
        // historical ledger routes remain visible through their legacy actor projection while
        // their own custody migrations are still pending.
        if ((row.type === "commitLoroPageContent" || row.type === "ensureLoroPage" || row.type === "migrateLegacyPage" || row.type === "prepareMeetingInDailyNote") && row.commandRowId > row.commandHighWater) return []
        return [{ type: row.type, principal: row.principal, message: row.message, createdAt: row.createdAt }]
      }
      if (row.actorLabel === null || row.custodyType !== row.type || row.targetId === null) return []
      if (row.custodyType === "agentChangeDecision" && row.targetKind === "chat") {
        if (row.actorKind !== "user") return []
        const custody: LedgerCustodyInput = {
          requestIdentity: "activity-row", fingerprint: "activity-row", type: "agentChangeDecision", workspaceId: "activity-row",
          actorKind: "user", actorLabel: row.actorLabel, targetKind: "chat", targetId: row.targetId
        }
        try { assertLedgerCustodyShape(custody) } catch { return [] }
        if (Schema.decodeUnknownOption(EntityId)(row.targetId)._tag === "None") return []
        // A chat id is intentionally not returned: the activity feed is a public audit summary,
        // while the command payload remains private evidence for the authenticated review route.
        return [{ type: row.type, principal: row.principal, message: row.message, createdAt: row.createdAt,
          actorKind: row.actorKind, actorLabel: row.actorLabel }]
      }
      if (["createApp", "updateAppCode", "deleteApp"].includes(row.custodyType) && row.targetKind === "app") {
        if (row.actorKind !== "user") return []
        const custody: LedgerCustodyInput = {
          requestIdentity: "activity-row", fingerprint: "activity-row", type: row.custodyType as "createApp" | "updateAppCode" | "deleteApp", workspaceId: "activity-row",
          actorKind: "user", actorLabel: row.actorLabel, targetKind: "app", targetId: row.targetId
        }
        try { assertLedgerCustodyShape(custody) } catch { return [] }
        // Public activity deliberately keeps App IDs and code identities private.
        return [{ type: row.type, principal: row.principal, message: row.message, createdAt: row.createdAt,
          actorKind: "user", actorLabel: row.actorLabel }]
      }
      const nodeCustodyTypes = [
        "commitLoroPageContent", "ensureLoroPage", "migrateLegacyPage", "prepareMeetingInDailyNote",
        "createNodeWithIntent", "addFact", "assignTag"
      ] as const
      const isNodeCustodyType = (value: string): value is typeof nodeCustodyTypes[number] =>
        nodeCustodyTypes.includes(value as typeof nodeCustodyTypes[number])
      if (row.custodyType !== "updateTag" && !isNodeCustodyType(row.custodyType)) return []
      if (row.custodyType === "updateTag" && row.targetKind !== "tag") return []
      if (row.custodyType !== "updateTag" && row.targetKind !== "node") return []
      if (row.actorKind !== "user" && row.actorKind !== "employee" && row.actorKind !== "system") return []
      const custody: LedgerCustodyInput = row.custodyType === "updateTag"
        ? {
            requestIdentity: "activity-row", fingerprint: "activity-row", type: "updateTag", workspaceId: "activity-row",
            actorKind: row.actorKind, actorLabel: row.actorLabel, employeeId: row.employeeId ?? undefined,
            jobId: row.jobId ?? undefined, runId: row.runId ?? undefined, grantId: row.grantId ?? undefined,
            chatId: row.chatId ?? undefined, toolCallId: row.toolCallId ?? undefined, targetKind: "tag", targetId: row.targetId
          }
        : {
            requestIdentity: "activity-row", fingerprint: "activity-row", type: row.custodyType, workspaceId: "activity-row",
            actorKind: row.actorKind, actorLabel: row.actorLabel, employeeId: row.employeeId ?? undefined,
            jobId: row.jobId ?? undefined, runId: row.runId ?? undefined, grantId: row.grantId ?? undefined,
            chatId: row.chatId ?? undefined, toolCallId: row.toolCallId ?? undefined, targetKind: "node", targetId: row.targetId
          }
      try { assertLedgerCustodyShape(custody) } catch { return [] }
      if (Schema.decodeUnknownOption(EntityId)(row.targetId)._tag === "None") return []
      return [{ type: row.type, principal: row.principal, message: row.message, createdAt: row.createdAt,
        actorKind: row.actorKind, actorLabel: row.actorLabel, targetKind: row.targetKind, targetId: row.targetId }]
    })
  }

  /**
   * Server-only evidence projection for a standup publication.  The input comes from an already
   * verified publication receipt; no RPC caller can ask for an arbitrary workforce run.  A single
   * corrupt reportable candidate poisons its whole run so a UI can never mistake a partial audit
   * trail for complete work.
   */
  projectRecordedWorkByRun(inputs: readonly LedgerRecordedWorkRunInput[]): ReadonlyMap<string, LedgerRecordedWorkProjection> {
    const expected = new Map<string, LedgerRecordedWorkRunInput>()
    const expectedByRun = new Map<string, LedgerRecordedWorkRunInput>()
    const invalidKeys = new Set<string>()
    const invalidRunIds = new Set<string>()
    for (const input of inputs.slice(0, MAX_EVIDENCE_RUNS_PER_STANDUP)) {
      const key = ledgerRecordedWorkKey(input)
      const valid = isNonBlankString(input.workspaceId) && isNonBlankString(input.microEmployeeId) &&
        isNonBlankString(input.jobId) && isNonBlankString(input.runId) && isNonBlankString(input.grantId) &&
        isNonBlankString(input.requestIdentity) && isNonBlankString(input.childNodeId) &&
        Schema.decodeUnknownOption(IsoDateTimeString)(input.committedAt)._tag === "Some"
      const previous = expectedByRun.get(input.runId)
      if (!valid || expected.has(key) || previous !== undefined || invalidRunIds.has(input.runId)) {
        invalidKeys.add(key)
        if (isNonBlankString(input.runId)) invalidRunIds.add(input.runId)
        if (previous !== undefined) invalidKeys.add(ledgerRecordedWorkKey(previous))
        continue
      }
      expected.set(key, input)
      expectedByRun.set(input.runId, input)
    }
    const result = new Map<string, { invalid: boolean; items: LedgerRecordedWorkItem[] }>()
    for (const [key] of expected) result.set(key, { invalid: invalidKeys.has(key), items: [] })
    for (const key of invalidKeys) if (!result.has(key)) result.set(key, { invalid: true, items: [] })
    if (expectedByRun.size === 0) return new Map([...result].map(([key, state]) => [key, { state: "unavailable" as const }]))

    const runPlaceholders = [...expectedByRun.keys()].map(() => "?").join(", ")
    const typePlaceholders = Object.keys(reportableRecordedWork).map(() => "?").join(", ")
    const companionIdentities = [...expected.values()].flatMap((input) => [
      `workforce-node:${input.requestIdentity}`,
      `workforce-loro:${input.requestIdentity}`
    ])
    const excludedPlaceholders = companionIdentities.map(() => "?").join(", ")
    const rows = this.sql.exec<RecordedWorkRow>(
      `WITH candidates AS (
         SELECT custody.requestIdentity AS custodyRequestIdentity, custody.fingerprint AS custodyFingerprint,
                custody.type AS custodyType, custody.workspaceId AS custodyWorkspaceId, custody.actorKind,
                custody.actorLabel, custody.employeeId, custody.jobId, custody.runId, custody.grantId, custody.targetKind, custody.targetId,
                command.requestIdentity AS commandRequestIdentity, command.fingerprint AS commandFingerprint,
                command.type AS commandType, command.workspaceId AS commandWorkspaceId,
                command.messageDerivationVersion, command.message, command.payload, command.createdAt,
                ROW_NUMBER() OVER (
                  PARTITION BY custody.runId
                  ORDER BY command.createdAt ASC, custody.requestIdentity ASC
                ) AS candidatePosition,
                COUNT(*) OVER (PARTITION BY custody.runId) AS candidateCount
         FROM ledger_custody custody
         LEFT JOIN ledger_commands command ON command.requestIdentity = custody.requestIdentity
         WHERE custody.runId IN (${runPlaceholders})
           AND custody.type IN (${typePlaceholders})
           AND custody.requestIdentity NOT IN (${excludedPlaceholders})
       )
       SELECT * FROM candidates
       WHERE candidatePosition <= ?
       ORDER BY runId ASC, candidatePosition ASC`,
      ...expectedByRun.keys(),
      ...Object.keys(reportableRecordedWork),
      ...companionIdentities,
      EVIDENCE_CANDIDATE_SENTINEL
    ).toArray()
    for (const row of rows) {
      const input = row.runId === null ? undefined : expectedByRun.get(row.runId)
      if (input === undefined) continue
      const key = ledgerRecordedWorkKey(input)
      const state = result.get(key)
      if (state === undefined) continue
      if (row.candidateCount > MAX_EVIDENCE_CANDIDATES) state.invalid = true
      const item = decodeRecordedWorkRow(row, input)
      if (item === undefined) state.invalid = true
      else if (row.candidatePosition <= MAX_EVIDENCE_CANDIDATES) state.items.push(item)
    }
    const projected = new Map<string, LedgerRecordedWorkProjection>()
    for (const [key, state] of result) {
      projected.set(key, state.invalid
        ? { state: "unavailable" }
        : {
            state: "available",
            items: state.items.slice(0, MAX_EVIDENCE_ITEMS_PER_RUN),
            remainingCount: Math.min(MAX_EVIDENCE_REMAINDER, Math.max(0, state.items.length - MAX_EVIDENCE_ITEMS_PER_RUN))
          })
    }
    return projected
  }

  append(command: CreateNodeLedgerCommand): void {
    // Decode the exact persisted shape before INSERT. The schema is the compatibility contract
    // for immutable records, not merely a read-side assertion in tests.
    const persisted = Schema.decodeUnknownSync(LedgerCommand)({
      version: LEDGER_COMMAND_VERSION,
      requestId: command.requestId,
      fingerprint: command.fingerprint,
      type: "createNode",
      workspaceId: command.workspaceId,
      principal: command.principal,
      capability: "build",
      policy: command.policy,
      messageDerivationVersion: LEDGER_MESSAGE_DERIVATION_VERSION,
      message: createNodeCommitMessage(command.title),
      payload: command.payload,
      createdAt: command.createdAt
    })
    this.sql.exec(
      `INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      command.requestIdentity, persisted.requestId, persisted.fingerprint, persisted.version, persisted.type,
      persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy, persisted.messageDerivationVersion,
      persisted.message, JSON.stringify(persisted.payload), persisted.createdAt
    )
  }

  appendCreateNodeWithIntent(command: CreateNodeWithIntentLedgerCommandInput): void {
    const commitMessage = canonicalMutationCommitMessage(command.commitMessage)
    const mirrorsCommitMessage = command.attribution.kind === "agentJob"
    const payload = Schema.decodeUnknownSync(CreateNodeWithIntentLedgerPayload)({
      nodeId: command.nodeId, title: command.title,
      commitMessage, attribution: command.attribution
    })
    const persisted = Schema.decodeUnknownSync(CreateNodeWithIntentLedgerCommand)({
      version: LEDGER_COMMAND_VERSION, requestId: command.requestId, fingerprint: command.fingerprint,
      type: "createNodeWithIntent", workspaceId: command.workspaceId, principal: command.principal,
      capability: "build", policy: command.policy,
      messageDerivationVersion: mirrorsCommitMessage ? COMMIT_MESSAGE_MIRROR_DERIVATION_VERSION : CREATE_NODE_WITH_INTENT_MESSAGE_DERIVATION_VERSION,
      message: commitMessage, payload, createdAt: command.createdAt
    })
    this.sql.exec(
      `INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      command.requestIdentity, persisted.requestId, persisted.fingerprint, persisted.version, persisted.type,
      persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy,
      persisted.messageDerivationVersion, persisted.message, JSON.stringify(persisted.payload), persisted.createdAt
    )
  }

  /** App lifecycle records are private command evidence. In particular `payload` is schema-
   * decoded before persistence so a caller can never smuggle raw source into the ledger. */
  appendAppLifecycle(command: AppLedgerCommandInput): void {
    const payload = command.type === "createApp"
      ? Schema.decodeUnknownSync(CreateAppLedgerPayload)(command.payload)
      : command.type === "updateAppCode"
        ? Schema.decodeUnknownSync(UpdateAppCodeLedgerPayload)(command.payload)
        : Schema.decodeUnknownSync(DeleteAppLedgerPayload)(command.payload)
    const raw = {
      version: LEDGER_COMMAND_VERSION, requestId: command.requestId, fingerprint: command.fingerprint,
      type: command.type, workspaceId: command.workspaceId, principal: command.principal,
      capability: "build", policy: command.policy, messageDerivationVersion: APP_LIFECYCLE_MESSAGE_DERIVATION_VERSION,
      message: command.type === "createApp" ? createAppCommitMessage()
        : command.type === "updateAppCode" ? updateAppCodeCommitMessage() : deleteAppCommitMessage(),
      payload, createdAt: command.createdAt
    }
    const persisted = command.type === "createApp"
      ? Schema.decodeUnknownSync(CreateAppLedgerCommand)(raw)
      : command.type === "updateAppCode"
        ? Schema.decodeUnknownSync(UpdateAppCodeLedgerCommand)(raw)
        : Schema.decodeUnknownSync(DeleteAppLedgerCommand)(raw)
    this.sql.exec(
      `INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      command.requestIdentity, persisted.requestId, persisted.fingerprint, persisted.version, persisted.type,
      persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy,
      persisted.messageDerivationVersion, persisted.message, JSON.stringify(persisted.payload), persisted.createdAt
    )
  }

  appendOutboxIntent(requestIdentity: string, nodeId: string): void {
    this.sql.exec("INSERT INTO ledger_outbox_intents (requestIdentity, kind, payload) VALUES (?, ?, ?)",
      requestIdentity, "sync-feed", JSON.stringify({ nodeId }))
  }

  appendApplySupertag(command: ApplySupertagLedgerCommandInput): void {
    const payload = Schema.decodeUnknownSync(ApplySupertagLedgerPayload)({
      nodeId: command.nodeId,
      tagId: command.tagId,
      fieldValues: command.fieldValues,
      commitMessage: command.commitMessage,
      attribution: command.attribution
    })
    const persisted = Schema.decodeUnknownSync(ApplySupertagLedgerCommand)({
      version: LEDGER_COMMAND_VERSION,
      requestId: command.requestId,
      fingerprint: command.fingerprint,
      type: "applySupertag",
      workspaceId: command.workspaceId,
      principal: command.principal,
      capability: "build",
      policy: command.policy,
      messageDerivationVersion: APPLY_SUPERTAG_MESSAGE_DERIVATION_VERSION,
      message: applySupertagCommitMessage(),
      payload,
      createdAt: command.createdAt
    })
    this.sql.exec(
      `INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      command.requestIdentity, persisted.requestId, persisted.fingerprint, persisted.version, persisted.type,
      persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy,
      persisted.messageDerivationVersion, persisted.message, JSON.stringify(persisted.payload), persisted.createdAt
    )
  }

  appendAddFact(command: AddFactLedgerCommandInput): void {
    const commitMessage = canonicalMutationCommitMessage(command.commitMessage)
    const mirrorsCommitMessage = command.attribution.kind === "agentJob"
    const payload = Schema.decodeUnknownSync(AddFactLedgerPayload)({ nodeId: command.nodeId, predicateId: command.predicateId,
      value: command.value, ...(command.factId === undefined ? {} : { factId: command.factId }), commitMessage, attribution: command.attribution })
    const persisted = Schema.decodeUnknownSync(AddFactLedgerCommand)({ version: LEDGER_COMMAND_VERSION, requestId: command.requestId,
      fingerprint: command.fingerprint, type: "addFact", workspaceId: command.workspaceId, principal: command.principal,
      capability: "build", policy: command.policy,
      messageDerivationVersion: mirrorsCommitMessage ? COMMIT_MESSAGE_MIRROR_DERIVATION_VERSION : ADD_FACT_MESSAGE_DERIVATION_VERSION,
      message: mirrorsCommitMessage ? commitMessage : addFactCommitMessage(), payload, createdAt: command.createdAt })
    this.sql.exec(`INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, command.requestIdentity, persisted.requestId, persisted.fingerprint,
      persisted.version, persisted.type, persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy,
      persisted.messageDerivationVersion, persisted.message, JSON.stringify(persisted.payload), persisted.createdAt)
  }

  appendCreateEdge(command: CreateEdgeLedgerCommandInput): void {
    const payload = Schema.decodeUnknownSync(CreateEdgeLedgerPayload)({
      relationDefinitionId: command.relationDefinitionId,
      sourceNodeId: command.sourceNodeId,
      targetNodeId: command.targetNodeId,
      commitMessage: command.commitMessage,
      attribution: command.attribution
    })
    const persisted = Schema.decodeUnknownSync(CreateEdgeLedgerCommand)({
      version: LEDGER_COMMAND_VERSION,
      requestId: command.requestId,
      fingerprint: command.fingerprint,
      type: "createEdge",
      workspaceId: command.workspaceId,
      principal: command.principal,
      capability: "build",
      policy: command.policy,
      messageDerivationVersion: CREATE_EDGE_MESSAGE_DERIVATION_VERSION,
      message: createEdgeCommitMessage(),
      payload,
      createdAt: command.createdAt
    })
    this.sql.exec(`INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, command.requestIdentity, persisted.requestId, persisted.fingerprint,
      persisted.version, persisted.type, persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy,
      persisted.messageDerivationVersion, persisted.message, JSON.stringify(persisted.payload), persisted.createdAt)
  }

  appendCreateTag(command: CreateTagLedgerCommandInput): void {
    const payload = Schema.decodeUnknownSync(CreateTagLedgerPayload)({
      name: command.name,
      parentIds: command.parentIds,
      commitMessage: command.commitMessage,
      attribution: command.attribution
    })
    const persisted = Schema.decodeUnknownSync(CreateTagLedgerCommand)({
      version: LEDGER_COMMAND_VERSION,
      requestId: command.requestId,
      fingerprint: command.fingerprint,
      type: "createTag",
      workspaceId: command.workspaceId,
      principal: command.principal,
      capability: "build",
      policy: command.policy,
      messageDerivationVersion: CREATE_TAG_MESSAGE_DERIVATION_VERSION,
      message: createTagCommitMessage(),
      payload,
      createdAt: command.createdAt
    })
    this.sql.exec(`INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, command.requestIdentity, persisted.requestId, persisted.fingerprint,
      persisted.version, persisted.type, persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy,
      persisted.messageDerivationVersion, persisted.message, JSON.stringify(persisted.payload), persisted.createdAt)
  }

  appendUpdateTag(command: UpdateTagLedgerCommandInput): void {
    const commitMessage = canonicalMutationCommitMessage(command.commitMessage)
    const mirrorsCommitMessage = command.attribution.kind === "agentJob"
    const payload = Schema.decodeUnknownSync(UpdateTagLedgerPayload)({
      tagId: command.tagId, expectedRevision: command.expectedRevision, name: command.name, parentIds: command.parentIds,
      commitMessage, attribution: command.attribution
    })
    const persisted = Schema.decodeUnknownSync(UpdateTagLedgerCommand)({
      version: LEDGER_COMMAND_VERSION, requestId: command.requestId, fingerprint: command.fingerprint, type: "updateTag",
      workspaceId: command.workspaceId, principal: command.principal, capability: "build", policy: command.policy,
      messageDerivationVersion: mirrorsCommitMessage ? COMMIT_MESSAGE_MIRROR_DERIVATION_VERSION : UPDATE_TAG_MESSAGE_DERIVATION_VERSION,
      message: mirrorsCommitMessage ? commitMessage : updateTagCommitMessage(), payload, createdAt: command.createdAt
    })
    this.sql.exec(`INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, command.requestIdentity, persisted.requestId, persisted.fingerprint,
      persisted.version, persisted.type, persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy,
      persisted.messageDerivationVersion, persisted.message, JSON.stringify(persisted.payload), persisted.createdAt)
  }

  appendEnsureLoroPage(command: EnsureLoroPageLedgerCommandInput): void {
    const commitMessage = canonicalMutationCommitMessage(command.commitMessage)
    const mirrorsCommitMessage = command.attribution.kind === "agentJob"
    const payload = Schema.decodeUnknownSync(EnsureLoroPageLedgerPayload)({
      nodeId: command.nodeId, outcome: command.outcome, format: "loro-v1",
      storageVersion: command.storageVersion, schemaVersion: command.schemaVersion,
      commitMessage, attribution: command.attribution
    })
    const persisted = Schema.decodeUnknownSync(EnsureLoroPageLedgerCommand)({
      version: LEDGER_COMMAND_VERSION, requestId: command.requestId, fingerprint: command.fingerprint,
      type: "ensureLoroPage", workspaceId: command.workspaceId, principal: command.principal,
      capability: "build", policy: command.policy,
      messageDerivationVersion: mirrorsCommitMessage ? COMMIT_MESSAGE_MIRROR_DERIVATION_VERSION : ENSURE_LORO_PAGE_MESSAGE_DERIVATION_VERSION,
      message: commitMessage, payload, createdAt: command.createdAt
    })
    this.sql.exec(`INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, command.requestIdentity, persisted.requestId, persisted.fingerprint,
      persisted.version, persisted.type, persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy,
      persisted.messageDerivationVersion, persisted.message, JSON.stringify(persisted.payload), persisted.createdAt)
  }

  appendCommitLoroPageContent(command: CommitLoroPageContentLedgerCommandInput): void {
    const commitMessage = canonicalMutationCommitMessage(command.commitMessage)
    const mirrorsCommitMessage = command.attribution.kind === "agentJob"
    const payload = Schema.decodeUnknownSync(CommitLoroPageContentLedgerPayload)({
      nodeId: command.nodeId, expectedStorageVersion: command.expectedStorageVersion, expectedSnapshotSha256: command.expectedSnapshotSha256,
      baseVersionVectorSha256: command.baseVersionVectorSha256, resultVersionVectorSha256: command.resultVersionVectorSha256,
      resultSnapshotSha256: command.resultSnapshotSha256, updateSha256: command.updateSha256, updateLength: command.updateLength,
      commitMessage, attribution: command.attribution
    })
    const persisted = Schema.decodeUnknownSync(CommitLoroPageContentLedgerCommand)({
      version: LEDGER_COMMAND_VERSION, requestId: command.requestId, fingerprint: command.fingerprint, type: "commitLoroPageContent",
      workspaceId: command.workspaceId, principal: command.principal, capability: "build", policy: command.policy,
      messageDerivationVersion: mirrorsCommitMessage ? COMMIT_MESSAGE_MIRROR_DERIVATION_VERSION : COMMIT_LORO_PAGE_CONTENT_MESSAGE_DERIVATION_VERSION,
      message: commitMessage, payload, createdAt: command.createdAt
    })
    this.sql.exec(`INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, command.requestIdentity, persisted.requestId, persisted.fingerprint,
      persisted.version, persisted.type, persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy,
      persisted.messageDerivationVersion, persisted.message, JSON.stringify(persisted.payload), persisted.createdAt)
  }
  appendPrepareMeetingInDailyNote(command: PrepareMeetingInDailyNoteLedgerCommandInput): void {
    const commitMessage = canonicalMutationCommitMessage(command.commitMessage)
    const mirrorsCommitMessage = command.attribution.kind === "agentJob"
    const payload = Schema.decodeUnknownSync(PrepareMeetingInDailyNoteLedgerPayload)({ nodeId: command.nodeId, localDate: command.localDate, timeZone: command.timeZone, occurrenceKey: command.occurrenceKey, status: command.status, resultSnapshotSha256: command.resultSnapshotSha256, commitMessage, attribution: command.attribution })
    const persisted = Schema.decodeUnknownSync(PrepareMeetingInDailyNoteLedgerCommand)({ version: LEDGER_COMMAND_VERSION, requestId: command.requestId, fingerprint: command.fingerprint, type: "prepareMeetingInDailyNote", workspaceId: command.workspaceId, principal: command.principal, capability: "build", policy: command.policy, messageDerivationVersion: mirrorsCommitMessage ? COMMIT_MESSAGE_MIRROR_DERIVATION_VERSION : PREPARE_MEETING_IN_DAILY_NOTE_MESSAGE_DERIVATION_VERSION, message: commitMessage, payload, createdAt: command.createdAt })
    this.sql.exec(`INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, command.requestIdentity, persisted.requestId, persisted.fingerprint, persisted.version, persisted.type, persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy, persisted.messageDerivationVersion, persisted.message, JSON.stringify(persisted.payload), persisted.createdAt)
  }
  appendActivateLoroPage(command: ActivateLoroPageLedgerCommandInput): void {
    const payload = Schema.decodeUnknownSync(ActivateLoroPageLedgerPayload)({ nodeId: command.nodeId, expectedAutomergeHeadsHash: command.expectedAutomergeHeadsHash, expectedAutomergeBytesSha256: command.expectedAutomergeBytesSha256, snapshotSha256: command.snapshotSha256, snapshotLength: command.snapshotLength, storageVersion: command.storageVersion, schemaVersion: command.schemaVersion, commitMessage: command.commitMessage, attribution: command.attribution })
    const persisted = Schema.decodeUnknownSync(ActivateLoroPageLedgerCommand)({ version: LEDGER_COMMAND_VERSION, requestId: command.requestId, fingerprint: command.fingerprint, type: "activateLoroPage", workspaceId: command.workspaceId, principal: command.principal, capability: "build", policy: command.policy, messageDerivationVersion: ACTIVATE_LORO_PAGE_MESSAGE_DERIVATION_VERSION, message: command.commitMessage, payload, createdAt: command.createdAt })
    this.sql.exec(`INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, command.requestIdentity, persisted.requestId, persisted.fingerprint, persisted.version, persisted.type, persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy, persisted.messageDerivationVersion, persisted.message, JSON.stringify(persisted.payload), persisted.createdAt)
  }
  appendMigrateLegacyPage(command: MigrateLegacyPageLedgerCommandInput): void {
    const payload = Schema.decodeUnknownSync(MigrateLegacyPageLedgerPayload)({
      nodeId: command.nodeId, sourceStorageVersion: command.sourceStorageVersion, sourceAutomerge: command.sourceAutomerge,
      migrationEngineVersion: LEGACY_PAGE_MIGRATION_ENGINE_VERSION, resultSnapshotSha256: command.resultSnapshotSha256,
      resultSnapshotLength: command.resultSnapshotLength, storageVersion: command.storageVersion, schemaVersion: command.schemaVersion,
      commitMessage: command.commitMessage, attribution: command.attribution
    })
    const persisted = Schema.decodeUnknownSync(MigrateLegacyPageLedgerCommand)({
      version: LEDGER_COMMAND_VERSION, requestId: command.requestId, fingerprint: command.fingerprint, type: "migrateLegacyPage",
      workspaceId: command.workspaceId, principal: command.principal, capability: "build", policy: command.policy,
      messageDerivationVersion: MIGRATE_LEGACY_PAGE_MESSAGE_DERIVATION_VERSION, message: command.commitMessage, payload, createdAt: command.createdAt
    })
    this.sql.exec(`INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, command.requestIdentity, persisted.requestId, persisted.fingerprint, persisted.version, persisted.type, persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy, persisted.messageDerivationVersion, persisted.message, JSON.stringify(persisted.payload), persisted.createdAt)
  }

  appendDefineTagField(command: DefineTagFieldLedgerCommandInput): void {
    const payload = Schema.decodeUnknownSync(DefineTagFieldLedgerPayload)({
      tagId: command.tagId,
      name: command.name,
      valueKind: command.valueKind,
      sortOrder: command.sortOrder,
      commitMessage: command.commitMessage,
      attribution: command.attribution
    })
    const persisted = Schema.decodeUnknownSync(DefineTagFieldLedgerCommand)({
      version: LEDGER_COMMAND_VERSION,
      requestId: command.requestId,
      fingerprint: command.fingerprint,
      type: "defineTagField",
      workspaceId: command.workspaceId,
      principal: command.principal,
      capability: "build",
      policy: command.policy,
      messageDerivationVersion: DEFINE_TAG_FIELD_MESSAGE_DERIVATION_VERSION,
      message: defineTagFieldCommitMessage(),
      payload,
      createdAt: command.createdAt
    })
    this.sql.exec(`INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, command.requestIdentity, persisted.requestId, persisted.fingerprint,
      persisted.version, persisted.type, persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy,
      persisted.messageDerivationVersion, persisted.message, JSON.stringify(persisted.payload), persisted.createdAt)
  }

  appendSyncNoteReferences(command: SyncNoteReferencesLedgerCommandInput): void {
    const edge = (value: { readonly id: string; readonly relationDefinitionId: string; readonly sourceNodeId: string; readonly targetNodeId: string }) =>
      Schema.decodeUnknownSync(SyncNoteReferencesLedgerEdge)(value)
    const payload = Schema.decodeUnknownSync(SyncNoteReferencesLedgerPayload)({
      nodeId: command.nodeId,
      referencedNodeIds: [...command.referencedNodeIds].sort(),
      created: [...command.created].sort((left, right) => left.targetNodeId.localeCompare(right.targetNodeId) || left.id.localeCompare(right.id)).map(edge),
      removed: [...command.removed].sort((left, right) => left.targetNodeId.localeCompare(right.targetNodeId) || left.id.localeCompare(right.id)).map(edge),
      commitMessage: command.commitMessage,
      attribution: command.attribution
    })
    const persisted = Schema.decodeUnknownSync(SyncNoteReferencesLedgerCommand)({
      version: LEDGER_COMMAND_VERSION,
      requestId: command.requestId,
      fingerprint: command.fingerprint,
      type: "syncNoteReferences",
      workspaceId: command.workspaceId,
      principal: command.principal,
      capability: "build",
      policy: command.policy,
      messageDerivationVersion: SYNC_NOTE_REFERENCES_MESSAGE_DERIVATION_VERSION,
      message: syncNoteReferencesCommitMessage(),
      payload,
      createdAt: command.createdAt
    })
    this.sql.exec(`INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, command.requestIdentity, persisted.requestId, persisted.fingerprint,
      persisted.version, persisted.type, persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy,
      persisted.messageDerivationVersion, persisted.message, JSON.stringify(persisted.payload), persisted.createdAt)
  }

  appendCreateRelationDefinition(command: CreateRelationDefinitionLedgerCommandInput, relationDefinitionId: string): void {
    const payload = Schema.decodeUnknownSync(CreateRelationDefinitionLedgerPayload)({
      relationDefinitionId,
      forwardName: command.forwardName,
      inverseName: command.inverseName,
      sourceTagId: command.sourceTagId,
      targetTagId: command.targetTagId,
      cardinality: command.cardinality,
      commitMessage: command.commitMessage,
      attribution: command.attribution
    })
    const persisted = Schema.decodeUnknownSync(CreateRelationDefinitionLedgerCommand)({
      version: LEDGER_COMMAND_VERSION,
      requestId: command.requestId,
      fingerprint: command.fingerprint,
      type: "createRelationDefinition",
      workspaceId: command.workspaceId,
      principal: command.principal,
      capability: "build",
      policy: command.policy,
      messageDerivationVersion: CREATE_RELATION_DEFINITION_MESSAGE_DERIVATION_VERSION,
      message: createRelationDefinitionCommitMessage(),
      payload: { ...payload, relationDefinitionId },
      createdAt: command.createdAt
    })
    this.sql.exec(`INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, command.requestIdentity, persisted.requestId, persisted.fingerprint,
      persisted.version, persisted.type, persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy,
      persisted.messageDerivationVersion, persisted.message, JSON.stringify(persisted.payload), persisted.createdAt)
  }

  appendCreateBookmark(command: CreateBookmarkLedgerCommandInput, bookmark: {
    readonly id: string
    readonly url: string
    readonly title?: string
    readonly capturedAt: string
  }): void {
    const payload = Schema.decodeUnknownSync(CreateBookmarkLedgerPayload)({
      bookmarkId: bookmark.id,
      url: bookmark.url,
      title: { present: bookmark.title !== undefined, value: bookmark.title ?? null },
      capturedAt: bookmark.capturedAt,
      commitMessage: command.commitMessage,
      attribution: command.attribution
    })
    const persisted = Schema.decodeUnknownSync(CreateBookmarkLedgerCommand)({
      version: LEDGER_COMMAND_VERSION,
      requestId: command.requestId,
      fingerprint: command.fingerprint,
      type: "createBookmark",
      workspaceId: command.workspaceId,
      principal: command.principal,
      capability: "build",
      policy: command.policy,
      messageDerivationVersion: CREATE_BOOKMARK_MESSAGE_DERIVATION_VERSION,
      message: createBookmarkCommitMessage(),
      payload,
      createdAt: command.createdAt
    })
    this.sql.exec(`INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, command.requestIdentity, persisted.requestId, persisted.fingerprint,
      persisted.version, persisted.type, persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy,
      persisted.messageDerivationVersion, persisted.message, JSON.stringify(persisted.payload), persisted.createdAt)
  }

  appendLinkCalendarEventToNode(command: LinkCalendarEventToNodeLedgerCommandInput): void {
    const payload = Schema.decodeUnknownSync(LinkCalendarEventToNodeLedgerPayload)({
      calendarEventId: command.calendarEventId,
      nodeId: command.nodeId,
      commitMessage: command.commitMessage,
      attribution: command.attribution
    })
    const persisted = Schema.decodeUnknownSync(LinkCalendarEventToNodeLedgerCommand)({
      version: LEDGER_COMMAND_VERSION,
      requestId: command.requestId,
      fingerprint: command.fingerprint,
      type: "linkCalendarEventToNode",
      workspaceId: command.workspaceId,
      principal: command.principal,
      capability: "build",
      policy: command.policy,
      messageDerivationVersion: LINK_CALENDAR_EVENT_TO_NODE_MESSAGE_DERIVATION_VERSION,
      message: linkCalendarEventToNodeCommitMessage(),
      payload,
      createdAt: command.createdAt
    })
    this.sql.exec(`INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, command.requestIdentity, persisted.requestId, persisted.fingerprint,
      persisted.version, persisted.type, persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy,
      persisted.messageDerivationVersion, persisted.message, JSON.stringify(persisted.payload), persisted.createdAt)
  }

  appendCalendarProjection(command: CalendarProjectionLedgerCommandInput): void {
    const payload = Schema.decodeUnknownSync(CalendarProjectionLedgerPayload)({
      calendarEventId: command.calendarEventId, sourceRevisionDigest: command.sourceRevisionDigest,
      attendeeObservationDigests: [...command.attendeeObservationDigests].sort(),
      commitMessage: command.commitMessage, attribution: command.attribution
    })
    const persisted = Schema.decodeUnknownSync(CalendarProjectionLedgerCommand)({
      version: LEDGER_COMMAND_VERSION, requestId: command.requestId, fingerprint: command.fingerprint,
      type: "calendarProjection", workspaceId: command.workspaceId, principal: command.principal,
      capability: "build", policy: command.policy,
      messageDerivationVersion: CALENDAR_PROJECTION_MESSAGE_DERIVATION_VERSION,
      message: command.commitMessage, payload, createdAt: command.createdAt
    })
    this.sql.exec(`INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, command.requestIdentity, persisted.requestId,
      persisted.fingerprint, persisted.version, persisted.type, persisted.workspaceId, persisted.principal,
      persisted.capability, persisted.policy, persisted.messageDerivationVersion, persisted.message,
      JSON.stringify(persisted.payload), persisted.createdAt)
  }

  appendTranscriptSegment(command: AppendTranscriptSegmentLedgerCommandInput, segment: {
    readonly id: string
    readonly meetingId: string
    readonly speakerId?: string
    readonly text: string
    readonly startOffsetMs: number
    readonly endOffsetMs: number
    readonly source: "on-device" | "cloud"
  }): void {
    const payload = Schema.decodeUnknownSync(AppendTranscriptSegmentLedgerPayload)({
      segmentId: segment.id,
      meetingId: segment.meetingId,
      speakerId: Schema.decodeUnknownSync(AppendTranscriptSegmentLedgerSpeaker)({
        present: segment.speakerId !== undefined,
        value: segment.speakerId ?? null
      }),
      text: segment.text,
      startOffsetMs: segment.startOffsetMs,
      endOffsetMs: segment.endOffsetMs,
      source: segment.source,
      commitMessage: command.commitMessage,
      attribution: command.attribution
    })
    const persisted = Schema.decodeUnknownSync(AppendTranscriptSegmentLedgerCommand)({
      version: LEDGER_COMMAND_VERSION,
      requestId: command.requestId,
      fingerprint: command.fingerprint,
      type: "appendTranscriptSegment",
      workspaceId: command.workspaceId,
      principal: command.principal,
      capability: "build",
      policy: command.policy,
      messageDerivationVersion: APPEND_TRANSCRIPT_SEGMENT_MESSAGE_DERIVATION_VERSION,
      message: appendTranscriptSegmentCommitMessage(),
      payload,
      createdAt: command.createdAt
    })
    this.sql.exec(`INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, command.requestIdentity, persisted.requestId, persisted.fingerprint,
      persisted.version, persisted.type, persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy,
      persisted.messageDerivationVersion, persisted.message, JSON.stringify(persisted.payload), persisted.createdAt)
  }

  appendStartMeeting(command: StartMeetingLedgerCommandInput, meeting: {
    readonly id: string
    readonly title: string
    readonly startedAt: string
  }): void {
    const payload = Schema.decodeUnknownSync(StartMeetingLedgerPayload)({
      meetingId: meeting.id,
      title: meeting.title,
      startedAt: meeting.startedAt,
      commitMessage: command.commitMessage,
      attribution: command.attribution
    })
    const persisted = Schema.decodeUnknownSync(StartMeetingLedgerCommand)({
      version: LEDGER_COMMAND_VERSION,
      requestId: command.requestId,
      fingerprint: command.fingerprint,
      type: "startMeeting",
      workspaceId: command.workspaceId,
      principal: command.principal,
      capability: "build",
      policy: command.policy,
      messageDerivationVersion: START_MEETING_MESSAGE_DERIVATION_VERSION,
      message: startMeetingCommitMessage(),
      payload,
      createdAt: command.createdAt
    })
    this.sql.exec(`INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, command.requestIdentity, persisted.requestId, persisted.fingerprint,
      persisted.version, persisted.type, persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy,
      persisted.messageDerivationVersion, persisted.message, JSON.stringify(persisted.payload), persisted.createdAt)
  }

  appendAssignTag(command: AssignTagLedgerCommandInput): void {
    const commitMessage = canonicalMutationCommitMessage(command.commitMessage)
    const mirrorsCommitMessage = mirrorsCommitMessageForAttribution(command.attribution)
    const payload = Schema.decodeUnknownSync(AssignTagLedgerPayload)({
      nodeId: command.nodeId,
      tagId: command.tagId,
      commitMessage,
      attribution: command.attribution
    })
    const persisted = Schema.decodeUnknownSync(AssignTagLedgerCommand)({
      version: LEDGER_COMMAND_VERSION,
      requestId: command.requestId,
      fingerprint: command.fingerprint,
      type: "assignTag",
      workspaceId: command.workspaceId,
      principal: command.principal,
      capability: "build",
      policy: command.policy,
      messageDerivationVersion: mirrorsCommitMessage ? COMMIT_MESSAGE_MIRROR_DERIVATION_VERSION : ASSIGN_TAG_MESSAGE_DERIVATION_VERSION,
      message: mirrorsCommitMessage ? commitMessage : assignTagCommitMessage(),
      payload,
      createdAt: command.createdAt
    })
    this.sql.exec(`INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, command.requestIdentity, persisted.requestId, persisted.fingerprint,
      persisted.version, persisted.type, persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy,
      persisted.messageDerivationVersion, persisted.message, JSON.stringify(persisted.payload), persisted.createdAt)
  }

  appendUnassignTag(command: UnassignTagLedgerCommandInput): void {
    const payload = Schema.decodeUnknownSync(UnassignTagLedgerPayload)({
      nodeId: command.nodeId,
      tagId: command.tagId,
      commitMessage: command.commitMessage,
      attribution: command.attribution
    })
    const persisted = Schema.decodeUnknownSync(UnassignTagLedgerCommand)({
      version: LEDGER_COMMAND_VERSION,
      requestId: command.requestId,
      fingerprint: command.fingerprint,
      type: "unassignTag",
      workspaceId: command.workspaceId,
      principal: command.principal,
      capability: "build",
      policy: command.policy,
      messageDerivationVersion: UNASSIGN_TAG_MESSAGE_DERIVATION_VERSION,
      message: unassignTagCommitMessage(),
      payload,
      createdAt: command.createdAt
    })
    this.sql.exec(`INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, command.requestIdentity, persisted.requestId, persisted.fingerprint,
      persisted.version, persisted.type, persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy,
      persisted.messageDerivationVersion, persisted.message, JSON.stringify(persisted.payload), persisted.createdAt)
  }

  appendEvent(requestIdentity: string, kind: string, payload: unknown): void {
    this.sql.exec(
      "INSERT INTO ledger_events (requestIdentity, kind, payload) VALUES (?, ?, ?)",
      requestIdentity, kind, JSON.stringify(payload)
    )
  }

  appendOutbox(requestIdentity: string, kind: string, payload: unknown): void {
    this.sql.exec(
      "INSERT INTO ledger_outbox_intents (requestIdentity, kind, payload) VALUES (?, ?, ?)",
      requestIdentity, kind, JSON.stringify(payload)
    )
  }

  /** Inserts only the immutable command row for an agent-change decision. Reviewed chat
   * decisions use this method from executeV2 so the v2 receipt remains the sole receipt owner. */
  appendAgentChangeDecisionCommand(command: AgentChangeDecisionLedgerCommand): void {
    const persisted = Schema.decodeUnknownSync(LedgerCommand)({
      version: LEDGER_COMMAND_VERSION,
      requestId: command.requestId,
      fingerprint: command.fingerprint,
      type: "agentChangeDecision",
      workspaceId: command.workspaceId,
      proposalId: command.proposalId,
      decision: command.decision,
      principal: command.principal,
      provenance: command.provenance,
      capability: "build",
      policy: command.policy,
      messageDerivationVersion: AGENT_CHANGE_DECISION_MESSAGE_DERIVATION_VERSION,
      message: command.message,
      payload: command.payload,
      createdAt: command.createdAt
    })
    this.sql.exec(
      `INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      command.requestIdentity, persisted.requestId, persisted.fingerprint, persisted.version, persisted.type,
      persisted.workspaceId, persisted.principal, persisted.capability, persisted.policy, persisted.messageDerivationVersion,
      persisted.message, JSON.stringify(persisted.payload), persisted.createdAt
    )
  }

  /** Appends the event/outbox pair for an agent-change decision. Callers choose the payload; the
   * reviewed-chat route passes a privacy-safe summary, while the historical proposal route keeps
   * its existing private result envelope for backward compatibility. */
  appendAgentChangeDecisionSideEffects(command: AgentChangeDecisionLedgerCommand, payload: unknown): void {
    const eventPayload = JSON.stringify(payload)
    this.sql.exec(
      "INSERT INTO ledger_events (requestIdentity, kind, payload) VALUES (?, ?, ?)",
      command.requestIdentity, "agent-change-decision", eventPayload
    )
    this.sql.exec(
      "INSERT INTO ledger_outbox_intents (requestIdentity, kind, payload) VALUES (?, ?, ?)",
      command.requestIdentity, "agent-change-decision", eventPayload
    )
  }

  /** Historical combined helper retained for proposal decisions which still use the v1 receipt
   * envelope. New executeV2 callers must compose the command and side-effect methods above. */
  appendAgentChangeDecision(command: AgentChangeDecisionLedgerCommand, output: unknown): void {
    this.appendAgentChangeDecisionCommand(command)
    this.appendAgentChangeDecisionSideEffects(command, { proposalId: command.proposalId, decision: command.decision, output })
    this.receipt(command.requestIdentity, command.fingerprint, output)
  }

  receipt(requestIdentity: string, fingerprint: string, output: unknown): void {
    this.sql.exec("INSERT INTO ledger_receipts (requestIdentity, fingerprint, output) VALUES (?, ?, ?)",
      requestIdentity, fingerprint, JSON.stringify(output))
  }

  private receiptV2(requestIdentity: string, fingerprint: string, type: string, output: unknown): void {
    this.sql.exec("INSERT INTO ledger_receipts (requestIdentity, fingerprint, output) VALUES (?, ?, ?)",
      requestIdentity, fingerprint, encodeLedgerReceiptV2(type, output))
  }

  /** Records a chat-fork acceptance as the command type promised by the public routing manifest.
   * The immutable proposal rationale is included in the commit message so the ledger explains why
   * the edit was accepted, while the proposal identity remains the replay key. */
  appendAcceptedChatFork(command: {
    readonly proposalId: string; readonly nodeId: string; readonly workspaceId: string; readonly principal: string; readonly policy: string
    readonly rationale: string; readonly provenance: unknown; readonly input: unknown; readonly result: unknown; readonly createdAt: string
  }): void {
    const requestIdentity = `chat-fork:${command.proposalId}`
    const fingerprint = `chat-fork:${command.proposalId}`
    if (this.existing(requestIdentity, fingerprint) !== undefined) return
    const message = `${acceptChatForkCommitMessage(command.proposalId, command.nodeId)} Reason: ${command.rationale.trim()}`
    const persisted = Schema.decodeUnknownSync(LedgerCommand)({
      version: LEDGER_COMMAND_VERSION, requestId: command.proposalId, fingerprint, type: "acceptChatFork",
      workspaceId: command.workspaceId, principal: command.principal, capability: "build", policy: command.policy,
      messageDerivationVersion: ACCEPT_CHAT_FORK_MESSAGE_DERIVATION_VERSION, message,
      payload: { provenance: command.provenance, input: command.input, result: command.result }, createdAt: command.createdAt
    })
    this.sql.exec(
      `INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      requestIdentity, persisted.requestId, persisted.fingerprint, persisted.version, persisted.type, persisted.workspaceId,
      persisted.principal, persisted.capability, persisted.policy, persisted.messageDerivationVersion, persisted.message,
      JSON.stringify(persisted.payload), persisted.createdAt
    )
    const sideEffect = { proposalId: command.proposalId, nodeId: command.nodeId }
    this.appendEvent(requestIdentity, "accept-chat-fork", sideEffect)
    this.appendOutbox(requestIdentity, "accept-chat-fork", sideEffect)
    this.receipt(requestIdentity, fingerprint, command.result)
  }

  /** The proposal path has caller-supplied rationale and provenance; unlike createNode it never
   * manufactures a message from a title. Kept here so the audit command/receipt shares the DO's
   * existing durable ledger tables and idempotency key. */
  appendAcceptedPageProposal(command: {
    readonly proposalId: string; readonly nodeId: string; readonly workspaceId: string; readonly principal: string; readonly policy: string
    readonly rationale: string; readonly provenance: unknown; readonly input: unknown; readonly result: unknown; readonly createdAt: string
  }): void {
    const requestIdentity = `page-proposal:${command.proposalId}`
    const fingerprint = `page-proposal:${command.proposalId}`
    if (this.existing(requestIdentity, fingerprint) !== undefined) return
    const persisted = Schema.decodeUnknownSync(LedgerCommand)({
      version: LEDGER_COMMAND_VERSION, requestId: command.proposalId, fingerprint, type: "acceptPageProposal",
      workspaceId: command.workspaceId, principal: command.principal, capability: "build", policy: command.policy,
      messageDerivationVersion: "caller-rationale.v1", message: command.rationale,
      payload: { provenance: command.provenance, input: command.input, result: command.result }, createdAt: command.createdAt
    })
    this.sql.exec(
      `INSERT INTO ledger_commands (requestIdentity, requestId, fingerprint, version, type, workspaceId, principal, capability, policy, messageDerivationVersion, message, payload, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      requestIdentity, persisted.requestId, persisted.fingerprint, persisted.version, persisted.type, persisted.workspaceId,
      persisted.principal, persisted.capability, persisted.policy, persisted.messageDerivationVersion, persisted.message,
      JSON.stringify(persisted.payload), persisted.createdAt
    )
    const sideEffect = { proposalId: command.proposalId, nodeId: command.nodeId }
    this.appendEvent(requestIdentity, "accept-page-proposal", sideEffect)
    this.appendOutbox(requestIdentity, "accept-page-proposal", sideEffect)
    this.receipt(requestIdentity, fingerprint, command.result)
  }
}
