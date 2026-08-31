import * as Schema from "effect/Schema"
import { EntityId } from "./node.js"
import { Page } from "./page.js"

// Wire schemas for the Phase 3 Automerge-fork-as-chat-branch spike (plan §"Agent-native editing
// & gatekeeper integrations", risk #4: "a chat's pending note edits are a per-chat Automerge
// fork (Automerge.clone); accept = merge fork into mainline heads, revert = discard fork...
// This specific combination has no precedent in either source codebase — flagged for its own
// mini-spike"). Full design writeup, including the two hard questions this spike resolves
// (cross-device fork visibility; interaction with the real Automerge sync-session protocol):
// apps/athenaeum/docs/automerge-fork-spike.md.
//
// `chatId` is a plain caller-chosen string, not `EntityId` — Phase 3's real `chats` collection
// (plan §"Storage & domain model") doesn't exist yet; this spike only needs a stable key to
// namespace fork state per chat, and validating it as a non-empty string is enough for that.
// Same one-Schema.Class-pair-per-method convention as page-rpc.ts/graph-rpc.ts.

export class ForkChatEditInput extends Schema.Class<ForkChatEditInput>("ForkChatEditInput")({
  workspaceId: EntityId,
  chatId: Schema.String.pipe(Schema.minLength(1)),
  nodeId: EntityId
}) {}

export class ForkChatEditOutput extends Schema.Class<ForkChatEditOutput>("ForkChatEditOutput")({
  text: Schema.String
}) {}

export class ApplyChatForkEditInput extends Schema.Class<ApplyChatForkEditInput>("ApplyChatForkEditInput")({
  workspaceId: EntityId,
  chatId: Schema.String.pipe(Schema.minLength(1)),
  nodeId: EntityId,
  index: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  deleteCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  insertText: Schema.String
}) {}

export class ApplyChatForkEditOutput extends Schema.Class<ApplyChatForkEditOutput>("ApplyChatForkEditOutput")({
  text: Schema.String
}) {}

/**
 * Read the current state of a chat's fork, without mutating anything — the mechanism backing
 * "any number of watchers can observe a chat's live edit preview" (see the spike doc's cross-
 * device decision). `forked: false` means no fork is active for this `(chatId, nodeId)` pair
 * (either never forked, or already accepted/reverted); `text` is `""` in that case, never the
 * mainline page's text — this method never falls back to reading mainline, by design, so a
 * caller can't accidentally mistake a stale/absent fork for "the fork agrees with mainline."
 */
export class ChatForkPreviewInput extends Schema.Class<ChatForkPreviewInput>("ChatForkPreviewInput")({
  workspaceId: EntityId,
  chatId: Schema.String.pipe(Schema.minLength(1)),
  nodeId: EntityId
}) {}

export class ChatForkPreviewOutput extends Schema.Class<ChatForkPreviewOutput>("ChatForkPreviewOutput")({
  forked: Schema.Boolean,
  text: Schema.String
}) {}

export class AcceptChatForkInput extends Schema.Class<AcceptChatForkInput>("AcceptChatForkInput")({
  workspaceId: EntityId,
  chatId: Schema.String.pipe(Schema.minLength(1)),
  nodeId: EntityId,
  /** New callers bind acceptance to the exact preview; legacy callers retain compatibility. */
  expectedPreviewDigest: Schema.optional(Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)))
}) {}

export class AcceptChatForkOutput extends Schema.Class<AcceptChatForkOutput>("AcceptChatForkOutput")({
  page: Page,
  text: Schema.String
}) {}

export class RevertChatForkInput extends Schema.Class<RevertChatForkInput>("RevertChatForkInput")({
  workspaceId: EntityId,
  chatId: Schema.String.pipe(Schema.minLength(1)),
  nodeId: EntityId
}) {}

/** Ack-only shape (mirrors `graph-rpc.ts`'s `AssignTagOutput`) — revert always succeeds, even if
 *  no fork was active (see `ChatForkService.revert`'s own doc comment). */
export class RevertChatForkOutput extends Schema.Class<RevertChatForkOutput>("RevertChatForkOutput")({
  chatId: Schema.String,
  nodeId: EntityId
}) {}
