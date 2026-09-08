import * as Schema from "effect/Schema"
import { EntityId, IsoDateTimeString } from "./node.js"

export const AgentChangeOperation = Schema.Literal("merge", "revert")
export type AgentChangeOperation = typeof AgentChangeOperation.Type
export const AgentChangeProposalState = Schema.Literal("reserved", "accepted", "rejected", "conflicted", "reverted")
export type AgentChangeProposalState = typeof AgentChangeProposalState.Type
export const AgentChangeTargetKind = Schema.Literal("node", "fact", "edge", "app", "appCodeVersion")
export type AgentChangeTargetKind = typeof AgentChangeTargetKind.Type

/** Immutable evidence captured before a future accept/reject decision is made. */
export class AgentChangeSnapshot extends Schema.Class<AgentChangeSnapshot>("AgentChangeSnapshot")({
  kind: AgentChangeTargetKind,
  id: Schema.String.pipe(Schema.minLength(1)),
  canonicalRowBytes: Schema.Uint8ArrayFromSelf,
  sha256: Schema.String.pipe(Schema.minLength(1)),
  expectedDurableVersion: Schema.String.pipe(Schema.minLength(1)),
  pendingChatId: EntityId,
  pendingSequence: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  selectionPosition: Schema.Number.pipe(Schema.int(), Schema.nonNegative())
}) {}

/** Immutable capture evidence. Terminal state belongs to the separate decision row below. */
export class AgentChangeProposal extends Schema.Class<AgentChangeProposal>("AgentChangeProposal")({
  proposalId: EntityId,
  workspaceId: EntityId,
  chatId: EntityId,
  operation: AgentChangeOperation,
  rangeBoundary: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  requestId: Schema.String.pipe(Schema.minLength(1)),
  requestCanonicalPayload: Schema.Uint8ArrayFromSelf,
  requestFingerprint: Schema.String.pipe(Schema.minLength(1)),
  actor: Schema.String.pipe(Schema.minLength(1)),
  provenance: Schema.String.pipe(Schema.minLength(1)),
  capturedAt: IsoDateTimeString,
  snapshot: Schema.Array(AgentChangeSnapshot)
}) {}

/** Mutable lifecycle data cannot overwrite immutable proposal evidence. */
export class AgentChangeProposalDecision extends Schema.Class<AgentChangeProposalDecision>("AgentChangeProposalDecision")({
  proposalId: EntityId,
  state: AgentChangeProposalState
}) {}

/** A single target can be reserved by exactly one live proposal. */
export class AgentChangeReservation extends Schema.Class<AgentChangeReservation>("AgentChangeReservation")({
  key: Schema.String.pipe(Schema.minLength(1)),
  kind: AgentChangeTargetKind,
  id: Schema.String.pipe(Schema.minLength(1)),
  proposalId: EntityId,
  expectedDurableVersion: Schema.String.pipe(Schema.minLength(1)),
  expectedDigest: Schema.String.pipe(Schema.minLength(1)),
  state: Schema.Literal("reserved"),
  capturedAt: IsoDateTimeString
}) {}

export const agentChangeReservationKey = (kind: AgentChangeTargetKind, id: string): string => `${kind}:${id}`
