import * as Schema from "effect/Schema"
import { BookmarkUrl } from "./bookmark.js"
import { JsonValue } from "./json-value.js"
import { EntityId, IsoDateTimeString } from "./node.js"
import { canonicalJsonBytes, sha256HexSync } from "./canonical-hash.js"

/**
 * Transitional, workspace-local command ledger contract. It is deliberately a domain contract,
 * not an authority system or a Durable Object of its own: only the Workspace DO derives and
 * persists these records while the broader mutation surface remains direct.
 */
export const LEDGER_COMMAND_VERSION = "athenaeum.workspace-ledger.v1" as const
/**
 * The current public `createNode` input has no caller-provided rationale. This version marks the
 * deterministic, server-derived compatibility placeholder until the full command contract adds
 * required caller/job rationale.
 */
export const LEDGER_MESSAGE_DERIVATION_VERSION = "create-node-title-compat.v1" as const
export const CREATE_NODE_WITH_INTENT_MESSAGE_DERIVATION_VERSION = "caller-rationale.v1" as const
export const ACCEPT_CHAT_FORK_MESSAGE_DERIVATION_VERSION = "accept-chat-fork-proposal.v1" as const
export const AGENT_CHANGE_DECISION_MESSAGE_DERIVATION_VERSION = "caller-rationale.v1" as const
export const APPLY_SUPERTAG_MESSAGE_DERIVATION_VERSION = "apply-supertag.v1" as const
export const ADD_FACT_MESSAGE_DERIVATION_VERSION = "add-fact.v1" as const
export const CREATE_EDGE_MESSAGE_DERIVATION_VERSION = "create-edge.v1" as const
export const CREATE_TAG_MESSAGE_DERIVATION_VERSION = "create-tag.v1" as const
export const UPDATE_TAG_MESSAGE_DERIVATION_VERSION = "update-tag.v1" as const
export const DEFINE_TAG_FIELD_MESSAGE_DERIVATION_VERSION = "define-tag-field.v1" as const
export const ASSIGN_TAG_MESSAGE_DERIVATION_VERSION = "assign-tag.v1" as const
export const UNASSIGN_TAG_MESSAGE_DERIVATION_VERSION = "unassign-tag.v1" as const
export const SYNC_NOTE_REFERENCES_MESSAGE_DERIVATION_VERSION = "sync-note-references.v1" as const
export const CREATE_RELATION_DEFINITION_MESSAGE_DERIVATION_VERSION = "create-relation-definition.v1" as const
export const CREATE_BOOKMARK_MESSAGE_DERIVATION_VERSION = "create-bookmark.v1" as const
export const LINK_CALENDAR_EVENT_TO_NODE_MESSAGE_DERIVATION_VERSION = "link-calendar-event-to-node.v1" as const
export const APPEND_TRANSCRIPT_SEGMENT_MESSAGE_DERIVATION_VERSION = "append-transcript-segment.v1" as const
export const START_MEETING_MESSAGE_DERIVATION_VERSION = "start-meeting.v1" as const
export const CALENDAR_PROJECTION_MESSAGE_DERIVATION_VERSION = "calendar-projection.v1" as const
export const ENSURE_LORO_PAGE_MESSAGE_DERIVATION_VERSION = "ensure-loro-page.v1" as const
export const COMMIT_LORO_PAGE_CONTENT_MESSAGE_DERIVATION_VERSION = "commit-loro-page-content.v1" as const
export const PREPARE_MEETING_IN_DAILY_NOTE_MESSAGE_DERIVATION_VERSION = "prepare-meeting-in-daily-note.v1" as const
export const ACTIVATE_LORO_PAGE_MESSAGE_DERIVATION_VERSION = "activate-loro-page.v1" as const
/** Bump when server-side Automerge-to-Loro derivation changes. This is evidence, not content. */
export const MIGRATE_LEGACY_PAGE_MESSAGE_DERIVATION_VERSION = "migrate-legacy-page.v1" as const
export const LEGACY_PAGE_MIGRATION_ENGINE_VERSION = "automerge-flat-text-to-loro-v1" as const
export const MUTATION_ATTRIBUTION_VERSION = "athenaeum.mutation-attribution.v1" as const
/** A command whose persisted message is the canonical human/job rationale, not an operation label. */
export const COMMIT_MESSAGE_MIRROR_DERIVATION_VERSION = "commit-message-mirror.v1" as const

const boundedId = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200))
export const MutationRequestId = boundedId
export const MutationCommitMessage = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(500))
export type MutationRequestId = typeof MutationRequestId.Type
export type MutationCommitMessage = typeof MutationCommitMessage.Type

const utf8ByteLength = (value: string): number => {
  let length = 0
  for (const character of value) {
    const point = character.codePointAt(0)!
    length += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
  }
  return length
}

const isWellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1)
      if (low < 0xdc00 || low > 0xdfff) return false
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

/**
 * The one canonical spelling used when an edit is auditable as an employee's explanation.
 * Trim only: changing Unicode, punctuation, or internal whitespace would make an authored reason
 * say something different.  The byte bound keeps the public standup projection bounded too.
 */
export const canonicalMutationCommitMessage = (value: unknown): MutationCommitMessage => {
  if (typeof value !== "string") throw new TypeError("commit message must be a string")
  const canonical = value.trim()
  if (!isWellFormedUnicode(canonical) || Array.from(canonical).length > 500 || utf8ByteLength(canonical) > 2_000) throw new TypeError("commit message exceeds public bounds")
  return Schema.decodeUnknownSync(MutationCommitMessage)(canonical)
}

/** Asserted author evidence. Principal, capability, and policy remain server-derived authority. */
export class HumanUiMutationAttribution extends Schema.Class<HumanUiMutationAttribution>(
  "HumanUiMutationAttribution"
)({
  version: Schema.Literal(MUTATION_ATTRIBUTION_VERSION),
  kind: Schema.Literal("humanUi"),
  surface: Schema.Literal("rich-text-editor", "agent-chat", "web-supertag-field-editor", "web-supertags-manager", "web-graph-view", "web-backlinks", "web-bookmarks", "web-calendar", "ios-supertags", "macos", "watch-quick-capture")
}) {}

export class AgentJobMutationAttribution extends Schema.Class<AgentJobMutationAttribution>(
  "AgentJobMutationAttribution"
)({
  version: Schema.Literal(MUTATION_ATTRIBUTION_VERSION),
  kind: Schema.Literal("agentJob"),
  jobId: boundedId,
  runId: boundedId
}) {}

export class SystemMutationAttribution extends Schema.Class<SystemMutationAttribution>(
  "SystemMutationAttribution"
)({
  version: Schema.Literal(MUTATION_ATTRIBUTION_VERSION),
  kind: Schema.Literal("system"),
  source: boundedId
}) {}

export const MutationAttribution = Schema.Union(
  HumanUiMutationAttribution,
  AgentJobMutationAttribution,
  SystemMutationAttribution
)
export type MutationAttribution = typeof MutationAttribution.Type

/** Strict private payload for the mainline `applySupertag` ledger command. */
export class ApplySupertagLedgerFieldValue extends Schema.Class<ApplySupertagLedgerFieldValue>(
  "ApplySupertagLedgerFieldValue"
)({
  fieldId: EntityId,
  value: JsonValue
}) {}

/** Private evidence for an authenticated node creation. */
export class CreateNodeWithIntentLedgerPayload extends Schema.Class<CreateNodeWithIntentLedgerPayload>("CreateNodeWithIntentLedgerPayload")({
  nodeId: EntityId,
  title: Schema.String.pipe(Schema.minLength(1)),
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

export class ApplySupertagLedgerPayload extends Schema.Class<ApplySupertagLedgerPayload>(
  "ApplySupertagLedgerPayload"
)({
  nodeId: EntityId,
  tagId: EntityId,
  fieldValues: Schema.Array(ApplySupertagLedgerFieldValue),
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

export class AddFactLedgerPayload extends Schema.Class<AddFactLedgerPayload>("AddFactLedgerPayload")({
  nodeId: EntityId,
  predicateId: Schema.String.pipe(Schema.minLength(1)),
  value: JsonValue,
  factId: Schema.optional(EntityId),
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

/** Strict private payload for the ledgered public relationship mutation. The caller rationale and
 * asserted attribution stay out of the public activity stream, but remain part of the immutable
 * command so retries cannot silently change why or on whose behalf the edge was created. */
export class CreateEdgeLedgerPayload extends Schema.Class<CreateEdgeLedgerPayload>("CreateEdgeLedgerPayload")({
  relationDefinitionId: EntityId,
  sourceNodeId: EntityId,
  targetNodeId: EntityId,
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

/** Strict private payload for the ledgered public Supertag-definition mutation. The normalized
 * name and ordered parent ids are the exact values persisted by the public route; caller rationale
 * and asserted attribution remain private command data. */
export class CreateTagLedgerPayload extends Schema.Class<CreateTagLedgerPayload>("CreateTagLedgerPayload")({
  name: Schema.String.pipe(Schema.minLength(1)),
  parentIds: Schema.Array(EntityId),
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

export class UpdateTagLedgerPayload extends Schema.Class<UpdateTagLedgerPayload>("UpdateTagLedgerPayload")({
  tagId: EntityId,
  expectedRevision: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  name: Schema.String.pipe(Schema.minLength(1)),
  parentIds: Schema.Array(EntityId),
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

/** Metadata-only creation record. CRDT bytes and snapshots must never enter the command ledger. */
export class EnsureLoroPageLedgerPayload extends Schema.Class<EnsureLoroPageLedgerPayload>("EnsureLoroPageLedgerPayload")({
  nodeId: EntityId,
  outcome: Schema.Literal("created", "alreadyExisted"),
  format: Schema.Literal("loro-v1"),
  storageVersion: Schema.Number.pipe(Schema.int(), Schema.positive()),
  schemaVersion: Schema.Number.pipe(Schema.int(), Schema.positive()),
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

/** Digest-only command evidence: CRDT updates, snapshots, and version-vector wire bytes never
 * enter the ledger. */
export class CommitLoroPageContentLedgerPayload extends Schema.Class<CommitLoroPageContentLedgerPayload>("CommitLoroPageContentLedgerPayload")({
  nodeId: EntityId, expectedStorageVersion: Schema.Number.pipe(Schema.int(), Schema.positive()),
  expectedSnapshotSha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  baseVersionVectorSha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  resultVersionVectorSha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  resultSnapshotSha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  updateSha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)), updateLength: Schema.Number.pipe(Schema.int(), Schema.positive()),
  commitMessage: MutationCommitMessage, attribution: MutationAttribution
}) {}
export class PrepareMeetingInDailyNoteLedgerPayload extends Schema.Class<PrepareMeetingInDailyNoteLedgerPayload>("PrepareMeetingInDailyNoteLedgerPayload")({
  nodeId: EntityId, localDate: Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}$/)), timeZone: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)), occurrenceKey: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  status: Schema.Literal("created", "alreadyPrepared"), resultSnapshotSha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  commitMessage: MutationCommitMessage, attribution: MutationAttribution
}) {}
export class ActivateLoroPageLedgerPayload extends Schema.Class<ActivateLoroPageLedgerPayload>("ActivateLoroPageLedgerPayload")({
  nodeId: EntityId, expectedAutomergeHeadsHash: Schema.String.pipe(Schema.minLength(1)), expectedAutomergeBytesSha256: Schema.String.pipe(Schema.minLength(1)),
  snapshotSha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)), snapshotLength: Schema.Number.pipe(Schema.int(), Schema.positive()),
  storageVersion: Schema.Number.pipe(Schema.int(), Schema.positive()), schemaVersion: Schema.Number.pipe(Schema.int(), Schema.positive()),
  commitMessage: MutationCommitMessage, attribution: MutationAttribution
}) {}

/** Digest-only evidence for a server-derived legacy migration. */
export class MigrateLegacyPageLedgerPayload extends Schema.Class<MigrateLegacyPageLedgerPayload>("MigrateLegacyPageLedgerPayload")({
  nodeId: EntityId,
  sourceStorageVersion: Schema.Number.pipe(Schema.int(), Schema.positive()),
  sourceAutomerge: Schema.Struct({
    docId: Schema.String.pipe(Schema.minLength(1)),
    headsHash: Schema.String.pipe(Schema.minLength(1)),
    bytesSha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/))
  }),
  migrationEngineVersion: Schema.Literal(LEGACY_PAGE_MIGRATION_ENGINE_VERSION),
  resultSnapshotSha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  resultSnapshotLength: Schema.Number.pipe(Schema.int(), Schema.positive()),
  storageVersion: Schema.Number.pipe(Schema.int(), Schema.positive()),
  schemaVersion: Schema.Number.pipe(Schema.int(), Schema.positive()),
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

/** Strict private payload for the ledgered public Supertag-field definition mutation. The
 * normalized field name and schema shape are retained for replay/audit, while caller rationale
 * and asserted attribution remain private command data. */
export class DefineTagFieldLedgerPayload extends Schema.Class<DefineTagFieldLedgerPayload>("DefineTagFieldLedgerPayload")({
  tagId: EntityId,
  name: Schema.String.pipe(Schema.minLength(1)),
  valueKind: Schema.Literal("text", "number", "date", "checkbox", "entity-ref"),
  sortOrder: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

/** Strict private payloads for node/Supertag membership changes. The public activity projection
 * uses fixed operation labels; caller rationale and asserted attribution remain private here. */
export class AssignTagLedgerPayload extends Schema.Class<AssignTagLedgerPayload>("AssignTagLedgerPayload")({
  nodeId: EntityId,
  tagId: EntityId,
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

export class UnassignTagLedgerPayload extends Schema.Class<UnassignTagLedgerPayload>("UnassignTagLedgerPayload")({
  nodeId: EntityId,
  tagId: EntityId,
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

/** A strict, immutable edge journal entry. Created entries retain their generated identity; removed
 * entries are tombstones captured before deletion so downstream consumers can remove the exact row. */
export class SyncNoteReferencesLedgerEdge extends Schema.Class<SyncNoteReferencesLedgerEdge>("SyncNoteReferencesLedgerEdge")({
  id: EntityId,
  relationDefinitionId: EntityId,
  sourceNodeId: EntityId,
  targetNodeId: EntityId
}) {}

/** Private payload for desired-set mention reconciliation. The public activity stream only exposes
 * the fixed operation label; rationale and asserted attribution stay in this command. */
export class SyncNoteReferencesLedgerPayload extends Schema.Class<SyncNoteReferencesLedgerPayload>("SyncNoteReferencesLedgerPayload")({
  nodeId: EntityId,
  referencedNodeIds: Schema.Array(EntityId),
  created: Schema.Array(SyncNoteReferencesLedgerEdge),
  removed: Schema.Array(SyncNoteReferencesLedgerEdge),
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

/** Strict private payload for creating a relation definition. Relation names intentionally remain
 * byte-for-byte as supplied; only the caller rationale is trimmed at the public boundary. */
export class CreateRelationDefinitionLedgerPayload extends Schema.Class<CreateRelationDefinitionLedgerPayload>("CreateRelationDefinitionLedgerPayload")({
  relationDefinitionId: EntityId,
  forwardName: Schema.String.pipe(Schema.minLength(1)),
  inverseName: Schema.String.pipe(Schema.minLength(1)),
  sourceTagId: EntityId,
  targetTagId: EntityId,
  cardinality: Schema.Literal("one-to-one", "one-to-many", "many-to-one", "many-to-many"),
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

/** Strict private payload for a bookmark capture. URL/title are retained only in this command
 * payload; public activity and delivery side effects carry the generated bookmark identity only. */
export class CreateBookmarkLedgerTitleAbsent extends Schema.Class<CreateBookmarkLedgerTitleAbsent>("CreateBookmarkLedgerTitleAbsent")({
  present: Schema.Literal(false),
  value: Schema.Null
}) {}

export class CreateBookmarkLedgerTitlePresent extends Schema.Class<CreateBookmarkLedgerTitlePresent>("CreateBookmarkLedgerTitlePresent")({
  present: Schema.Literal(true),
  value: Schema.String
}) {}

export const CreateBookmarkLedgerTitle = Schema.Union(
  CreateBookmarkLedgerTitleAbsent,
  CreateBookmarkLedgerTitlePresent
)

export class CreateBookmarkLedgerPayload extends Schema.Class<CreateBookmarkLedgerPayload>("CreateBookmarkLedgerPayload")({
  bookmarkId: EntityId,
  url: BookmarkUrl,
  title: CreateBookmarkLedgerTitle,
  capturedAt: IsoDateTimeString,
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

/** Private evidence for linking a retained calendar projection to a mainline node. */
export class LinkCalendarEventToNodeLedgerPayload extends Schema.Class<LinkCalendarEventToNodeLedgerPayload>("LinkCalendarEventToNodeLedgerPayload")({
  calendarEventId: EntityId,
  nodeId: EntityId,
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

/** Compact replay receipt; WorkspaceDO re-resolves visible current state before returning it. */
export class LinkCalendarEventToNodeLedgerReceipt extends Schema.Class<LinkCalendarEventToNodeLedgerReceipt>("LinkCalendarEventToNodeLedgerReceipt")({
  calendarEventId: EntityId,
  nodeId: EntityId
}) {}

/** Private evidence for an atomic provider-event projection. Raw provider ids and attendee
 * addresses remain in backend-private collections; audit and delivery records use digests only. */
export class CalendarProjectionLedgerPayload extends Schema.Class<CalendarProjectionLedgerPayload>("CalendarProjectionLedgerPayload")({
  calendarEventId: EntityId,
  sourceRevisionDigest: Schema.String.pipe(Schema.minLength(1)),
  attendeeObservationDigests: Schema.Array(Schema.String.pipe(Schema.minLength(1))),
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

/** Optional speaker identity is encoded as a strict marker instead of relying on JSON's
 * omission semantics. This keeps absent, explicit, and malformed values distinct in the private
 * command payload and in the replay fingerprint. */
export class AppendTranscriptSegmentLedgerSpeakerAbsent extends Schema.Class<AppendTranscriptSegmentLedgerSpeakerAbsent>("AppendTranscriptSegmentLedgerSpeakerAbsent")({
  present: Schema.Literal(false),
  value: Schema.Null
}) {}

export class AppendTranscriptSegmentLedgerSpeakerPresent extends Schema.Class<AppendTranscriptSegmentLedgerSpeakerPresent>("AppendTranscriptSegmentLedgerSpeakerPresent")({
  present: Schema.Literal(true),
  value: EntityId
}) {}

export const AppendTranscriptSegmentLedgerSpeaker = Schema.Union(
  AppendTranscriptSegmentLedgerSpeakerAbsent,
  AppendTranscriptSegmentLedgerSpeakerPresent
)

/** Strict private payload for one transcript append. Transcript text remains private command
 * data; public activity and delivery side effects expose only the meeting and generated segment
 * identities. */
export class AppendTranscriptSegmentLedgerPayload extends Schema.Class<AppendTranscriptSegmentLedgerPayload>("AppendTranscriptSegmentLedgerPayload")({
  segmentId: EntityId,
  meetingId: EntityId,
  speakerId: AppendTranscriptSegmentLedgerSpeaker,
  text: Schema.String,
  startOffsetMs: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  endOffsetMs: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  source: Schema.Literal("on-device", "cloud"),
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

/** Strict private payload for one meeting-session start. The title and caller rationale stay out
 * of the public activity projection, while server-generated identity/time remain durable audit
 * evidence and are deliberately excluded from replay identity. */
export class StartMeetingLedgerPayload extends Schema.Class<StartMeetingLedgerPayload>("StartMeetingLedgerPayload")({
  meetingId: EntityId,
  title: Schema.String.pipe(Schema.minLength(1)),
  startedAt: IsoDateTimeString,
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

export const normalizeCreateNodeTitle = (title: string): string => title.trim().replace(/\s+/g, " ")

/**
 * Compatibility-only rationale: the server must not pretend the title is caller intent. Keeping
 * the derivation pure makes explicit-id replays immutable and deterministic; a future full
 * command contract must require caller/job rationale instead of extending this placeholder.
 */
export const createNodeCommitMessage = (title: string): string =>
  `Create node to record ${normalizeCreateNodeTitle(title)}.`

/** The acceptance decision is deliberately derived from the immutable proposal identity, rather
 * than the mutable page text. The proposal row retains the human/job rationale and provenance. */
export const acceptChatForkCommitMessage = (proposalId: string, nodeId: string): string =>
  `Accept chat fork proposal ${proposalId} for page ${nodeId}.`

/** Public activity is deliberately derived from the operation, never from caller text. */
export const applySupertagCommitMessage = (): string => "Applied Supertag to a workspace node."
export const addFactCommitMessage = (): string => "Updated a workspace fact."
/** Privacy-safe public activity label; caller rationale remains private in the command payload. */
export const createEdgeCommitMessage = (): string => "Created a relationship between workspace nodes."
/** Public activity label for a schema mutation; caller rationale remains private in the payload. */
export const createTagCommitMessage = (): string => "Created a Supertag definition."
export const updateTagCommitMessage = (): string => "Updated a Supertag definition."
/** Privacy-safe public label for adding a schema field; caller rationale remains private. */
export const defineTagFieldCommitMessage = (): string => "Added a field to a Supertag definition."
/** Privacy-safe public labels describe the requested operation, not private caller rationale. */
export const assignTagCommitMessage = (): string => "Requested a Supertag membership."
export const unassignTagCommitMessage = (): string => "Requested removal of a Supertag membership."
/** Privacy-safe public label for the client-derived mention projection. */
export const syncNoteReferencesCommitMessage = (): string => "Reconciled note mentions."
/** Privacy-safe public label for creating a relation definition. */
export const createRelationDefinitionCommitMessage = (): string => "Created a relation definition."
/** Privacy-safe public label for bookmark capture; URL/title remain private command data. */
export const createBookmarkCommitMessage = (): string => "Captured a bookmark."
/** Privacy-safe public label; calendar details remain private command data. */
export const linkCalendarEventToNodeCommitMessage = (): string => "Linked a calendar event to a workspace node."
/** Privacy-safe public label for transcript capture; transcript text remains private command data. */
export const appendTranscriptSegmentCommitMessage = (): string => "Appended a transcript segment."
/** Privacy-safe public label for meeting-session capture; title remains private command data. */
export const startMeetingCommitMessage = (): string => "Started a meeting."

/** Canonical public-route normalization. Internal GraphService callers retain their existing
 * exact-name behavior; the public createTag RPC uses this once for mutation, output, payload,
 * fingerprint, and side-effect metadata so retries cannot disagree with the stored tag. */
export const normalizeTagName = (name: string): string => name.normalize("NFKC").trim().replace(/\s+/gu, " ")
export const normalizeCreateTagName = normalizeTagName
/**
 * The persisted uniqueness key is deliberately narrower than Unicode Default Case Folding.
 * It uses ECMAScript's locale-independent simple lowercase after NFKC and is versioned so a
 * future full UAX #44 case-fold migration can be explicit. In v1, `İ` differs from `i` and
 * `ß` differs from `ss`; do not treat either pair as duplicate names.
 */
export const TAG_NAME_KEY_VERSION = "unicode-nfkc-simple-lower.v1" as const
export const tagNameKey = (name: string): string => normalizeTagName(name).toLowerCase()
/** Stable server-issued optimistic-concurrency token. Parent order is part of the persisted tag
 * contract and therefore part of the revision; a reorder must conflict with another edit rather
 * than silently overwriting it with the same token. */
export const tagRevision = (tag: { readonly id: string; readonly name: string; readonly parentIds: ReadonlyArray<string> }): string =>
  sha256HexSync(canonicalJsonBytes({ version: "tag-revision.v1", tagId: tag.id, normalizedName: normalizeTagName(tag.name), parentIds: [...tag.parentIds] }))

export class CreateNodeLedgerCommand extends Schema.Class<CreateNodeLedgerCommand>("CreateNodeLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION),
  requestId: Schema.String.pipe(Schema.minLength(1)),
  fingerprint: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal("createNode"),
  workspaceId: EntityId,
  principal: Schema.String.pipe(Schema.minLength(1)),
  capability: Schema.Literal("build"),
  policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(LEDGER_MESSAGE_DERIVATION_VERSION),
  message: Schema.String.pipe(Schema.minLength(1)),
  payload: Schema.Unknown,
  createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

export class CreateNodeWithIntentLedgerCommand extends Schema.Class<CreateNodeWithIntentLedgerCommand>("CreateNodeWithIntentLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION), requestId: MutationRequestId,
  fingerprint: Schema.String.pipe(Schema.minLength(1)), type: Schema.Literal("createNodeWithIntent"),
  workspaceId: EntityId, principal: Schema.String.pipe(Schema.minLength(1)), capability: Schema.Literal("build"),
  policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(CREATE_NODE_WITH_INTENT_MESSAGE_DERIVATION_VERSION, COMMIT_MESSAGE_MIRROR_DERIVATION_VERSION),
  message: MutationCommitMessage, payload: CreateNodeWithIntentLedgerPayload,
  createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

export class AcceptChatForkLedgerCommand extends Schema.Class<AcceptChatForkLedgerCommand>("AcceptChatForkLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION),
  requestId: Schema.String.pipe(Schema.minLength(1)),
  fingerprint: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal("acceptChatFork"),
  workspaceId: EntityId,
  principal: Schema.String.pipe(Schema.minLength(1)),
  capability: Schema.Literal("build"),
  policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(ACCEPT_CHAT_FORK_MESSAGE_DERIVATION_VERSION),
  message: Schema.String.pipe(Schema.minLength(1)),
  payload: Schema.Unknown,
  createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

export class AcceptPageProposalLedgerCommand extends Schema.Class<AcceptPageProposalLedgerCommand>("AcceptPageProposalLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION),
  requestId: Schema.String.pipe(Schema.minLength(1)),
  fingerprint: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal("acceptPageProposal"),
  workspaceId: EntityId,
  principal: Schema.String.pipe(Schema.minLength(1)),
  capability: Schema.Literal("build"),
  policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal("caller-rationale.v1"),
  message: Schema.String.pipe(Schema.minLength(1)),
  payload: Schema.Unknown,
  createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

/** A proposal decision is a semantic workspace mutation.  The proposal snapshot is the
 * immutable target set; this command records the authenticated principal, trusted provenance,
 * and the caller's reason in the same ledger transaction as the decision. */
export class AgentChangeDecisionLedgerCommand extends Schema.Class<AgentChangeDecisionLedgerCommand>("AgentChangeDecisionLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION),
  requestId: Schema.String.pipe(Schema.minLength(1)),
  fingerprint: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal("agentChangeDecision"),
  workspaceId: EntityId,
  proposalId: EntityId,
  decision: Schema.Literal("accept", "reject"),
  principal: Schema.String.pipe(Schema.minLength(1)),
  provenance: Schema.String.pipe(Schema.minLength(1)),
  capability: Schema.Literal("build"),
  policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(AGENT_CHANGE_DECISION_MESSAGE_DERIVATION_VERSION),
  message: Schema.String.pipe(Schema.minLength(1)),
  payload: Schema.Unknown,
  createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

/** Mainline Supertag application command. Attribution and caller rationale are private payload
 * data; the persisted `message` is the deterministic server-derived activity label. */
export class ApplySupertagLedgerCommand extends Schema.Class<ApplySupertagLedgerCommand>(
  "ApplySupertagLedgerCommand"
)({
  version: Schema.Literal(LEDGER_COMMAND_VERSION),
  requestId: MutationRequestId,
  fingerprint: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal("applySupertag"),
  workspaceId: EntityId,
  principal: Schema.String.pipe(Schema.minLength(1)),
  capability: Schema.Literal("build"),
  policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(APPLY_SUPERTAG_MESSAGE_DERIVATION_VERSION),
  message: Schema.String.pipe(Schema.minLength(1)),
  payload: ApplySupertagLedgerPayload,
  createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

export class AddFactLedgerCommand extends Schema.Class<AddFactLedgerCommand>("AddFactLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION),
  requestId: MutationRequestId,
  fingerprint: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal("addFact"),
  workspaceId: EntityId,
  principal: Schema.String.pipe(Schema.minLength(1)),
  capability: Schema.Literal("build"),
  policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(ADD_FACT_MESSAGE_DERIVATION_VERSION, COMMIT_MESSAGE_MIRROR_DERIVATION_VERSION),
  message: MutationCommitMessage,
  payload: AddFactLedgerPayload,
  createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

export class CreateEdgeLedgerCommand extends Schema.Class<CreateEdgeLedgerCommand>("CreateEdgeLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION),
  requestId: MutationRequestId,
  fingerprint: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal("createEdge"),
  workspaceId: EntityId,
  principal: Schema.String.pipe(Schema.minLength(1)),
  capability: Schema.Literal("build"),
  policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(CREATE_EDGE_MESSAGE_DERIVATION_VERSION),
  message: Schema.String.pipe(Schema.minLength(1)),
  payload: CreateEdgeLedgerPayload,
  createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

export class CreateTagLedgerCommand extends Schema.Class<CreateTagLedgerCommand>("CreateTagLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION),
  requestId: MutationRequestId,
  fingerprint: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal("createTag"),
  workspaceId: EntityId,
  principal: Schema.String.pipe(Schema.minLength(1)),
  capability: Schema.Literal("build"),
  policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(CREATE_TAG_MESSAGE_DERIVATION_VERSION),
  message: Schema.String.pipe(Schema.minLength(1)),
  payload: CreateTagLedgerPayload,
  createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

export class UpdateTagLedgerCommand extends Schema.Class<UpdateTagLedgerCommand>("UpdateTagLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION), requestId: MutationRequestId,
  fingerprint: Schema.String.pipe(Schema.minLength(1)), type: Schema.Literal("updateTag"), workspaceId: EntityId,
  principal: Schema.String.pipe(Schema.minLength(1)), capability: Schema.Literal("build"), policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(UPDATE_TAG_MESSAGE_DERIVATION_VERSION, COMMIT_MESSAGE_MIRROR_DERIVATION_VERSION), message: MutationCommitMessage,
  payload: UpdateTagLedgerPayload, createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

export class EnsureLoroPageLedgerCommand extends Schema.Class<EnsureLoroPageLedgerCommand>("EnsureLoroPageLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION), requestId: MutationRequestId,
  fingerprint: Schema.String.pipe(Schema.minLength(1)), type: Schema.Literal("ensureLoroPage"),
  workspaceId: EntityId, principal: Schema.String.pipe(Schema.minLength(1)), capability: Schema.Literal("build"),
  policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(ENSURE_LORO_PAGE_MESSAGE_DERIVATION_VERSION, COMMIT_MESSAGE_MIRROR_DERIVATION_VERSION),
  message: MutationCommitMessage, payload: EnsureLoroPageLedgerPayload,
  createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

export class CommitLoroPageContentLedgerCommand extends Schema.Class<CommitLoroPageContentLedgerCommand>("CommitLoroPageContentLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION), requestId: MutationRequestId,
  fingerprint: Schema.String.pipe(Schema.minLength(1)), type: Schema.Literal("commitLoroPageContent"), workspaceId: EntityId,
  principal: Schema.String.pipe(Schema.minLength(1)), capability: Schema.Literal("build"), policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(COMMIT_LORO_PAGE_CONTENT_MESSAGE_DERIVATION_VERSION, COMMIT_MESSAGE_MIRROR_DERIVATION_VERSION), message: MutationCommitMessage,
  payload: CommitLoroPageContentLedgerPayload, createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}
export class PrepareMeetingInDailyNoteLedgerCommand extends Schema.Class<PrepareMeetingInDailyNoteLedgerCommand>("PrepareMeetingInDailyNoteLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION), requestId: MutationRequestId, fingerprint: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal("prepareMeetingInDailyNote"), workspaceId: EntityId, principal: Schema.String.pipe(Schema.minLength(1)), capability: Schema.Literal("build"), policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(PREPARE_MEETING_IN_DAILY_NOTE_MESSAGE_DERIVATION_VERSION, COMMIT_MESSAGE_MIRROR_DERIVATION_VERSION), message: MutationCommitMessage, payload: PrepareMeetingInDailyNoteLedgerPayload, createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}
export class ActivateLoroPageLedgerCommand extends Schema.Class<ActivateLoroPageLedgerCommand>("ActivateLoroPageLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION), requestId: MutationRequestId, fingerprint: Schema.String.pipe(Schema.minLength(1)), type: Schema.Literal("activateLoroPage"),
  workspaceId: EntityId, principal: Schema.String.pipe(Schema.minLength(1)), capability: Schema.Literal("build"), policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(ACTIVATE_LORO_PAGE_MESSAGE_DERIVATION_VERSION), message: Schema.String.pipe(Schema.minLength(1)), payload: ActivateLoroPageLedgerPayload, createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}
export class MigrateLegacyPageLedgerCommand extends Schema.Class<MigrateLegacyPageLedgerCommand>("MigrateLegacyPageLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION), requestId: MutationRequestId,
  fingerprint: Schema.String.pipe(Schema.minLength(1)), type: Schema.Literal("migrateLegacyPage"),
  workspaceId: EntityId, principal: Schema.String.pipe(Schema.minLength(1)), capability: Schema.Literal("build"), policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(MIGRATE_LEGACY_PAGE_MESSAGE_DERIVATION_VERSION), message: Schema.String.pipe(Schema.minLength(1)), payload: MigrateLegacyPageLedgerPayload,
  createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

export class DefineTagFieldLedgerCommand extends Schema.Class<DefineTagFieldLedgerCommand>("DefineTagFieldLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION),
  requestId: MutationRequestId,
  fingerprint: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal("defineTagField"),
  workspaceId: EntityId,
  principal: Schema.String.pipe(Schema.minLength(1)),
  capability: Schema.Literal("build"),
  policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(DEFINE_TAG_FIELD_MESSAGE_DERIVATION_VERSION),
  message: Schema.String.pipe(Schema.minLength(1)),
  payload: DefineTagFieldLedgerPayload,
  createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

export class AssignTagLedgerCommand extends Schema.Class<AssignTagLedgerCommand>("AssignTagLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION),
  requestId: MutationRequestId,
  fingerprint: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal("assignTag"),
  workspaceId: EntityId,
  principal: Schema.String.pipe(Schema.minLength(1)),
  capability: Schema.Literal("build"),
  policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(ASSIGN_TAG_MESSAGE_DERIVATION_VERSION, COMMIT_MESSAGE_MIRROR_DERIVATION_VERSION),
  message: MutationCommitMessage,
  payload: AssignTagLedgerPayload,
  createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

export class UnassignTagLedgerCommand extends Schema.Class<UnassignTagLedgerCommand>("UnassignTagLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION),
  requestId: MutationRequestId,
  fingerprint: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal("unassignTag"),
  workspaceId: EntityId,
  principal: Schema.String.pipe(Schema.minLength(1)),
  capability: Schema.Literal("build"),
  policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(UNASSIGN_TAG_MESSAGE_DERIVATION_VERSION),
  message: Schema.String.pipe(Schema.minLength(1)),
  payload: UnassignTagLedgerPayload,
  createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

export class SyncNoteReferencesLedgerCommand extends Schema.Class<SyncNoteReferencesLedgerCommand>("SyncNoteReferencesLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION),
  requestId: MutationRequestId,
  fingerprint: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal("syncNoteReferences"),
  workspaceId: EntityId,
  principal: Schema.String.pipe(Schema.minLength(1)),
  capability: Schema.Literal("build"),
  policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(SYNC_NOTE_REFERENCES_MESSAGE_DERIVATION_VERSION),
  message: Schema.String.pipe(Schema.minLength(1)),
  payload: SyncNoteReferencesLedgerPayload,
  createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

export class CreateRelationDefinitionLedgerCommand extends Schema.Class<CreateRelationDefinitionLedgerCommand>("CreateRelationDefinitionLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION),
  requestId: MutationRequestId,
  fingerprint: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal("createRelationDefinition"),
  workspaceId: EntityId,
  principal: Schema.String.pipe(Schema.minLength(1)),
  capability: Schema.Literal("build"),
  policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(CREATE_RELATION_DEFINITION_MESSAGE_DERIVATION_VERSION),
  message: Schema.String.pipe(Schema.minLength(1)),
  payload: CreateRelationDefinitionLedgerPayload,
  createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

export class CreateBookmarkLedgerCommand extends Schema.Class<CreateBookmarkLedgerCommand>("CreateBookmarkLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION),
  requestId: MutationRequestId,
  fingerprint: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal("createBookmark"),
  workspaceId: EntityId,
  principal: Schema.String.pipe(Schema.minLength(1)),
  capability: Schema.Literal("build"),
  policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(CREATE_BOOKMARK_MESSAGE_DERIVATION_VERSION),
  message: Schema.String.pipe(Schema.minLength(1)),
  payload: CreateBookmarkLedgerPayload,
  createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

export class LinkCalendarEventToNodeLedgerCommand extends Schema.Class<LinkCalendarEventToNodeLedgerCommand>("LinkCalendarEventToNodeLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION), requestId: MutationRequestId,
  fingerprint: Schema.String.pipe(Schema.minLength(1)), type: Schema.Literal("linkCalendarEventToNode"),
  workspaceId: EntityId, principal: Schema.String.pipe(Schema.minLength(1)), capability: Schema.Literal("build"),
  policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(LINK_CALENDAR_EVENT_TO_NODE_MESSAGE_DERIVATION_VERSION),
  message: Schema.String.pipe(Schema.minLength(1)), payload: LinkCalendarEventToNodeLedgerPayload,
  createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

export class CalendarProjectionLedgerCommand extends Schema.Class<CalendarProjectionLedgerCommand>("CalendarProjectionLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION), requestId: MutationRequestId,
  fingerprint: Schema.String.pipe(Schema.minLength(1)), type: Schema.Literal("calendarProjection"),
  workspaceId: EntityId, principal: Schema.String.pipe(Schema.minLength(1)), capability: Schema.Literal("build"),
  policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(CALENDAR_PROJECTION_MESSAGE_DERIVATION_VERSION),
  message: MutationCommitMessage, payload: CalendarProjectionLedgerPayload,
  createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

export class AppendTranscriptSegmentLedgerCommand extends Schema.Class<AppendTranscriptSegmentLedgerCommand>("AppendTranscriptSegmentLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION),
  requestId: MutationRequestId,
  fingerprint: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal("appendTranscriptSegment"),
  workspaceId: EntityId,
  principal: Schema.String.pipe(Schema.minLength(1)),
  capability: Schema.Literal("build"),
  policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(APPEND_TRANSCRIPT_SEGMENT_MESSAGE_DERIVATION_VERSION),
  message: Schema.String.pipe(Schema.minLength(1)),
  payload: AppendTranscriptSegmentLedgerPayload,
  createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

export class StartMeetingLedgerCommand extends Schema.Class<StartMeetingLedgerCommand>("StartMeetingLedgerCommand")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION),
  requestId: MutationRequestId,
  fingerprint: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal("startMeeting"),
  workspaceId: EntityId,
  principal: Schema.String.pipe(Schema.minLength(1)),
  capability: Schema.Literal("build"),
  policy: Schema.String.pipe(Schema.minLength(1)),
  messageDerivationVersion: Schema.Literal(START_MEETING_MESSAGE_DERIVATION_VERSION),
  message: Schema.String.pipe(Schema.minLength(1)),
  payload: StartMeetingLedgerPayload,
  createdAt: Schema.String.pipe(Schema.minLength(1))
}) {}

export const LedgerCommand = Schema.Union(
  CreateNodeLedgerCommand,
  CreateNodeWithIntentLedgerCommand,
  AcceptChatForkLedgerCommand,
  AcceptPageProposalLedgerCommand,
  AgentChangeDecisionLedgerCommand,
  ApplySupertagLedgerCommand,
  AddFactLedgerCommand,
  CreateEdgeLedgerCommand,
  CreateTagLedgerCommand,
  UpdateTagLedgerCommand,
  EnsureLoroPageLedgerCommand,
  CommitLoroPageContentLedgerCommand,
  PrepareMeetingInDailyNoteLedgerCommand,
  ActivateLoroPageLedgerCommand,
  MigrateLegacyPageLedgerCommand,
  DefineTagFieldLedgerCommand,
  AssignTagLedgerCommand,
  UnassignTagLedgerCommand,
  SyncNoteReferencesLedgerCommand,
  CreateRelationDefinitionLedgerCommand,
  CreateBookmarkLedgerCommand,
  LinkCalendarEventToNodeLedgerCommand,
  CalendarProjectionLedgerCommand,
  AppendTranscriptSegmentLedgerCommand,
  StartMeetingLedgerCommand
)

export class LedgerReceipt extends Schema.Class<LedgerReceipt>("LedgerReceipt")({
  version: Schema.Literal(LEDGER_COMMAND_VERSION),
  requestId: Schema.String.pipe(Schema.minLength(1)),
  fingerprint: Schema.String.pipe(Schema.minLength(1)),
  commandKey: Schema.String.pipe(Schema.minLength(1)),
  nodeId: EntityId,
  output: Schema.Unknown
}) {}
