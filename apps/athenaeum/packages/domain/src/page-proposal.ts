import * as Schema from "effect/Schema"
import { EntityId, IsoDateTimeString } from "./node.js"

/** A durable, reviewable proposed change to a page. The bytes are an Automerge save, never text. */
export class PageProposalProvenance extends Schema.Class<PageProposalProvenance>("PageProposalProvenance")({
  chatId: Schema.String.pipe(Schema.minLength(1)),
  assistantMessageId: Schema.String.pipe(Schema.minLength(1)),
  toolCallId: Schema.String.pipe(Schema.minLength(1)),
  toolName: Schema.String.pipe(Schema.minLength(1)),
  source: Schema.Literal("agent", "human")
}) {}

export class PageProposal extends Schema.Class<PageProposal>("PageProposal")({
  proposalId: EntityId,
  workspaceId: EntityId,
  nodeId: EntityId,
  status: Schema.Literal("proposed", "accepting", "accepted", "reverted", "failed"),
  proposalBytes: Schema.Uint8ArrayFromSelf,
  proposalHeadsHash: Schema.String.pipe(Schema.minLength(1)),
  baseHeadsHash: Schema.String.pipe(Schema.minLength(1)),
  index: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  deleteCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  insertText: Schema.String,
  rationale: Schema.String.pipe(Schema.minLength(1)),
  provenance: PageProposalProvenance,
  createdAt: IsoDateTimeString,
  updatedAt: IsoDateTimeString
}) {}

export class PageCommit extends Schema.Class<PageCommit>("PageCommit")({
  proposalId: EntityId,
  committedBytes: Schema.Uint8ArrayFromSelf,
  committedHeadsHash: Schema.String.pipe(Schema.minLength(1)),
  committedAt: IsoDateTimeString,
  provenance: PageProposalProvenance
}) {}
