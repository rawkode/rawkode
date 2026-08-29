import * as Schema from "effect/Schema"
import { EntityId } from "./node.js"
import { AutomergePageDocumentDescriptor, LegacyPageDocumentDescriptor, PageDocumentDescriptor } from "./page-document-format.js"
import {
  AgentJobMutationAttribution,
  HumanUiMutationAttribution,
  MutationAttribution,
  MutationCommitMessage,
  MutationRequestId,
  SystemMutationAttribution
} from "./ledger.js"

/**
 * The Loro command boundary intentionally owns normalization.  It accepts raw bounded wire
 * strings, trims each semantic field once, and validates the canonical value.  Do not reuse this
 * for older ledger routes: changing their historic request identities would break replay.
 */
const canonicalLoroString = (maximum: number) => Schema.transform(
  Schema.String.pipe(Schema.maxLength(maximum + 256)),
  Schema.String.pipe(Schema.minLength(1), Schema.maxLength(maximum)),
  { decode: (value) => value.trim(), encode: (value) => value }
)

export const LoroMutationRequestId = canonicalLoroString(200)
export const LoroMutationCommitMessage = canonicalLoroString(500)
const LoroAttributionId = canonicalLoroString(200)

const LoroHumanUiMutationAttributionV1 = Schema.Struct({
  version: Schema.Literal("athenaeum.mutation-attribution.v1"),
  kind: Schema.Literal("humanUi"),
  surface: Schema.Literal("rich-text-editor", "web-supertag-field-editor", "web-supertags-manager", "web-graph-view", "web-backlinks", "web-bookmarks", "ios-supertags", "macos", "watch-quick-capture")
})
const LoroAgentJobMutationAttributionV1 = Schema.Struct({
  version: Schema.Literal("athenaeum.mutation-attribution.v1"), kind: Schema.Literal("agentJob"), jobId: LoroAttributionId, runId: LoroAttributionId
})
const LoroSystemMutationAttributionV1 = Schema.Struct({
  version: Schema.Literal("athenaeum.mutation-attribution.v1"), kind: Schema.Literal("system"), source: LoroAttributionId
})
const LoroMutationAttributionWireV1 = Schema.Union(LoroHumanUiMutationAttributionV1, LoroAgentJobMutationAttributionV1, LoroSystemMutationAttributionV1)
export const LoroMutationAttributionV1 = Schema.transform(
  LoroMutationAttributionWireV1,
  MutationAttribution,
  {
    decode: (value) => value.kind === "humanUi"
      ? new HumanUiMutationAttribution(value)
      : value.kind === "agentJob"
        ? new AgentJobMutationAttribution(value)
        : new SystemMutationAttribution(value),
    encode: (value) => value
  }
)

/** Canonical immutable intent shared by semantic Loro writes and Loro activation. */
export class LoroMutationIntentV1 extends Schema.Class<LoroMutationIntentV1>("LoroMutationIntentV1")({
  requestId: LoroMutationRequestId,
  commitMessage: LoroMutationCommitMessage,
  attribution: LoroMutationAttributionV1
}) {}

const LoroSha256 = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/))
const boundedNonEmptyBytes = (maximum: number) => Schema.Uint8ArrayFromSelf.pipe(
  Schema.filter((value) => value.length > 0 && value.length <= maximum, {
    message: () => `expected between 1 and ${maximum} bytes`
  })
)
const LoroVersionVectorBytes = boundedNonEmptyBytes(4096)
const LoroUpdateBytes = boundedNonEmptyBytes(2 * 1024 * 1024)

/**
 * Creation request ids are canonicalized at the public wire decode boundary.  A retry whose
 * caller retained the same logical id must therefore hit the same ledger identity even when a
 * transport adds harmless leading/trailing whitespace.  Blank (after trimming) and overlong ids
 * are rejected before the request reaches the durable object.
 *
 * Native mirrors this rule with the explicit ECMAScript `String.prototype.trim()` scalar set
 * before serializing.
 */
export const CreationIntentRequestId = Schema.transform(
  Schema.String.pipe(Schema.maxLength(200)),
  MutationRequestId,
  { decode: (requestId) => requestId.trim(), encode: (requestId) => requestId }
)

// Loro page-document RPCs deliberately use a distinct wire surface from sync-rpc.ts's legacy
// Automerge session. This format boundary prevents a stale Automerge client from receiving Loro
// bytes and makes backend routing reject incompatible active formats deterministically.

export class GetPageDocumentDescriptorInput extends Schema.Class<GetPageDocumentDescriptorInput>(
  "GetPageDocumentDescriptorInput"
)({
  workspaceId: EntityId,
  nodeId: EntityId
}) {}

export class GetPageDocumentDescriptorOutput extends Schema.Class<GetPageDocumentDescriptorOutput>(
  "GetPageDocumentDescriptorOutput"
)({
  descriptor: PageDocumentDescriptor
}) {}

/**
 * A server-owned, flattened view of an Automerge-era page. This deliberately never exposes
 * Automerge bytes or sync state: clients may cache and display the text with its exact source
 * witness, but must ask the server to migrate before editing it as Loro.
 */
export class GetLegacyPageProjectionInput extends Schema.Class<GetLegacyPageProjectionInput>(
  "GetLegacyPageProjectionInput"
)({
  workspaceId: EntityId,
  nodeId: EntityId
}) {}

export class GetLegacyPageProjectionOutput extends Schema.Class<GetLegacyPageProjectionOutput>(
  "GetLegacyPageProjectionOutput"
)({
  /** The server deliberately withholds raw legacy text unless it can prove the old document is
   * losslessly representable as one unmarked Loro paragraph. */
  content: Schema.Union(
    Schema.Struct({ kind: Schema.Literal("plainText"), text: Schema.String.pipe(Schema.maxLength(1024 * 1024)) }),
    Schema.Struct({ kind: Schema.Literal("richTextUnsupported") }),
    Schema.Struct({ kind: Schema.Literal("tooLarge") })
  ),
  /** Strictly legacy so callers cannot mistake a migrated witness for editable source content. */
  descriptor: LegacyPageDocumentDescriptor,
  readOnly: Schema.Literal(true),
  migrationRequired: Schema.Literal(true)
}) {}

/** Server-derived migration only.  The client supplies a complete immutable source witness and
 * intent, never CRDT bytes or a target schema; the Workspace DO derives both from authority. */
export class MigrateLegacyPageInput extends Schema.Class<MigrateLegacyPageInput>("MigrateLegacyPageInput")({
  workspaceId: EntityId,
  nodeId: EntityId,
  expectedStorageVersion: Schema.Number.pipe(Schema.int(), Schema.positive()),
  expectedAutomerge: AutomergePageDocumentDescriptor,
  intent: LoroMutationIntentV1
}) {}

export class MigrateLegacyPageOutput extends Schema.Class<MigrateLegacyPageOutput>("MigrateLegacyPageOutput")({
  descriptor: PageDocumentDescriptor
}) {}

/** Immutable caller evidence for one logical Loro-page creation.  This is deliberately required:
 * retry code must retain it rather than inventing provenance after an uncertain response. */
export class CreationIntent extends Schema.Class<CreationIntent>(
  "CreationIntent"
)({
  requestId: CreationIntentRequestId,
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

/** Create a new page directly in the authoritative Loro/ProseMirror format. The legacy
 * `CreatePageInput` remains available for Automerge compatibility clients and migrations. */
export class CreateLoroPageInput extends Schema.Class<CreateLoroPageInput>(
  "CreateLoroPageInput"
)({
  workspaceId: EntityId,
  nodeId: EntityId,
  /** Captured once by the caller at the creation intent boundary and reused on uncertain retries. */
  creationIntent: CreationIntent
}) {}

export class CreateLoroPageOutput extends Schema.Class<CreateLoroPageOutput>(
  "CreateLoroPageOutput"
)({
  descriptor: PageDocumentDescriptor
}) {}

/** Safe witness-only receipt for a semantic Loro content write. */
export class CommitLoroPageContentInput extends Schema.Class<CommitLoroPageContentInput>("CommitLoroPageContentInput")({
  workspaceId: EntityId,
  nodeId: EntityId,
  intent: LoroMutationIntentV1,
  expectedStorageVersion: Schema.Number.pipe(Schema.int(), Schema.positive()),
  expectedSnapshotSha256: LoroSha256,
  expectedVersionVector: LoroVersionVectorBytes,
  update: LoroUpdateBytes
}) {}

export class CommitLoroPageContentOutput extends Schema.Class<CommitLoroPageContentOutput>("CommitLoroPageContentOutput")({
  descriptor: PageDocumentDescriptor,
  storageVersion: Schema.Number.pipe(Schema.int(), Schema.positive()),
  resultSnapshotSha256: LoroSha256,
  baseVersionVectorSha256: LoroSha256,
  resultVersionVectorSha256: LoroSha256,
  updateSha256: LoroSha256
}) {}

export class StartLoroPageSyncInput extends Schema.Class<StartLoroPageSyncInput>(
  "StartLoroPageSyncInput"
)({
  workspaceId: EntityId,
  nodeId: EntityId,
  sessionId: Schema.String.pipe(Schema.minLength(1))
}) {}

export class StartLoroPageSyncOutput extends Schema.Class<StartLoroPageSyncOutput>(
  "StartLoroPageSyncOutput"
)({
  sessionId: Schema.String.pipe(Schema.minLength(1)),
  message: Schema.Uint8ArrayFromSelf,
  serverVersion: Schema.Uint8ArrayFromSelf
}) {}

export class LoroPageSyncMessageInput extends Schema.Class<LoroPageSyncMessageInput>(
  "LoroPageSyncMessageInput"
)({
  workspaceId: EntityId,
  nodeId: EntityId,
  sessionId: Schema.String.pipe(Schema.minLength(1)),
  ordinal: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  update: Schema.Uint8ArrayFromSelf,
  clientVersion: Schema.Uint8ArrayFromSelf
}) {}

export class LoroPageSyncMessageOutput extends Schema.Class<LoroPageSyncMessageOutput>(
  "LoroPageSyncMessageOutput"
)({
  sessionId: Schema.String.pipe(Schema.minLength(1)),
  ordinal: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  update: Schema.NullOr(Schema.Uint8ArrayFromSelf),
  serverVersion: Schema.Uint8ArrayFromSelf,
  converged: Schema.Boolean,
  reset: Schema.Boolean
}) {}
