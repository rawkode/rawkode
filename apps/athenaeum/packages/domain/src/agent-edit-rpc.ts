import * as Schema from "effect/Schema"
import { Chat, ChatMessageRecord } from "./chat.js"
import { ChangesMessage } from "./changes-message.js"
import { Edge } from "./edge.js"
import { Fact } from "./fact.js"
import { EntityId, Node } from "./node.js"

// Wire schemas for `AgentEditService`'s RPC surface (plan §"Agent-native editing & gatekeeper
// integrations", task item 7: "createChat, sendChatMessage..., mergeChanges, revertChanges,
// listChatChanges"). Same one-`Schema.Class`-pair-per-method convention as rpc.ts/graph-rpc.ts/
// chat-fork-rpc.ts. `chatId` is `EntityId` throughout (unlike chat-fork-rpc.ts's plain-string
// `chatId`, which predates the real `chats` collection — see chat.ts's header comment): every
// method here operates against a real, persisted `Chat` row (chat.ts), so its id is the same
// branded `EntityId` `Chat.id`/`ChatMessageRecord.chatId`/`PendingMarker.chatId` already use.

export class CreateChatInput extends Schema.Class<CreateChatInput>("CreateChatInput")({
  workspaceId: EntityId,
  title: Schema.String.pipe(Schema.minLength(1))
}) {}

export class CreateChatOutput extends Schema.Class<CreateChatOutput>("CreateChatOutput")({
  chat: Chat
}) {}

export class ListChatsInput extends Schema.Class<ListChatsInput>("ListChatsInput")({
  workspaceId: EntityId
}) {}

export class ListChatsOutput extends Schema.Class<ListChatsOutput>("ListChatsOutput")({
  chats: Schema.Array(Chat)
}) {}

export class GetChatInput extends Schema.Class<GetChatInput>("GetChatInput")({
  chatId: EntityId
}) {}

/** `messages` is this chat's full persisted log, in `sequence` order — everything a client needs
 *  to render history, including `"tool"`-role rows (the crash-recovery log entries — see
 *  agent-edit-service-live.ts's header comment) a normal chat UI may choose to collapse/hide. */
export class GetChatOutput extends Schema.Class<GetChatOutput>("GetChatOutput")({
  chat: Chat,
  messages: Schema.Array(ChatMessageRecord)
}) {}

/**
 * Runs one full agent turn (plan: "given a user message, calls ModelClient.converse with the
 * chat's history + available tools, executes any tool calls the model requests via the
 * mechanisms above, loops until a final text reply, returns the full turn's messages + which
 * changes batch(es) it produced"). `text` is the user's new message; the prior history is
 * loaded server-side from the chat's own persisted log, not supplied by the caller.
 */
export class SendChatMessageInput extends Schema.Class<SendChatMessageInput>("SendChatMessageInput")({
  chatId: EntityId,
  text: Schema.String.pipe(Schema.minLength(1))
}) {}

/** `messages` is every `ChatMessageRecord` this turn appended (the user message, any `"tool"`-
 *  role log rows, and the final `"assistant"` reply) — not the chat's whole history, just this
 *  call's own delta, so a client can append rather than re-fetch. `changesSequences` is every
 *  `ChangesMessage.sequence` this turn produced, in order — the "which changes batch(es) it
 *  produced" the plan asks for; a client fetches their content via `listChatChanges`. */
export class SendChatMessageOutput extends Schema.Class<SendChatMessageOutput>("SendChatMessageOutput")({
  messages: Schema.Array(ChatMessageRecord),
  changesSequences: Schema.Array(Schema.Number.pipe(Schema.int(), Schema.nonNegative()))
}) {}

/** Promotes (clears `pending` on) every pending node/fact/edge this chat produced with
 *  `sequence <= mergeThrough`, per `multi-gadget.md` §Q15 — see agent-edit-service-live.ts for
 *  the full algorithm. */
export class MergeChangesInput extends Schema.Class<MergeChangesInput>("MergeChangesInput")({
  chatId: EntityId,
  mergeThrough: Schema.Number.pipe(Schema.int(), Schema.nonNegative())
}) {}

export class MergeChangesOutput extends Schema.Class<MergeChangesOutput>("MergeChangesOutput")({
  chatId: EntityId,
  mergeThrough: Schema.Number.pipe(Schema.int(), Schema.nonNegative())
}) {}

/** Deletes every pending node/fact/edge this chat produced with `sequence >= revertFrom`, per
 *  §Q15's `revertChanges`. */
export class RevertChangesInput extends Schema.Class<RevertChangesInput>("RevertChangesInput")({
  chatId: EntityId,
  revertFrom: Schema.Number.pipe(Schema.int(), Schema.nonNegative())
}) {}

export class RevertChangesOutput extends Schema.Class<RevertChangesOutput>("RevertChangesOutput")({
  chatId: EntityId,
  revertFrom: Schema.Number.pipe(Schema.int(), Schema.nonNegative())
}) {}

export class ListChatChangesInput extends Schema.Class<ListChatChangesInput>("ListChatChangesInput")({
  chatId: EntityId
}) {}

/** `listChatChanges` returns this chat's full `changes` *audit trail* — every `ChangesMessage`
 *  batch it has ever produced, forever, regardless of whether `mergeChanges`/`revertChanges` has
 *  since promoted or deleted the pending records it summarizes (`mergeChanges`/`revertChanges`,
 *  per §Q15, mutate `Node.pending`/`Fact.pending`/`Edge.pending` and — for a revert — the entity
 *  rows themselves; neither ever touches the `changesMessages` collection). A client wanting "what
 *  is still pending right now" (an accept/revert UI's actual question) needs
 *  `ListPendingChangesOutput` below instead — see its own doc comment. */
export class ListChatChangesOutput extends Schema.Class<ListChatChangesOutput>("ListChatChangesOutput")({
  changes: Schema.Array(ChangesMessage)
}) {}

export class ListPendingChangesInput extends Schema.Class<ListPendingChangesInput>("ListPendingChangesInput")({
  chatId: EntityId
}) {}

/**
 * The live, authoritative answer to "what does this chat currently have pending" — every
 * `Node`/`Fact`/`Edge` this chat has proposed (via `createNode`/`addFact`/`addEdge`) whose
 * `pending` marker is still set, i.e. not yet promoted by `mergeChanges` or deleted by
 * `revertChanges`. Added for the web-stage accept/revert UI after `ListChatChangesOutput`'s
 * append-only audit-trail semantics (see its own doc comment) turned out to be the wrong data
 * source for that UI: a `ChangesMessage` batch stays in the stream forever, so deriving "pending"
 * from it would keep showing already-accepted/-reverted items indefinitely. This method exposes
 * exactly the query `mergeChanges`/`revertChanges` themselves already run internally
 * (`pendingNodesForChat`/`pendingFactsForChat`/`pendingEdgesForChat` in
 * `agent-edit-service-live.ts`) — no new business logic, just a read-only RPC front end onto it.
 */
export class ListPendingChangesOutput extends Schema.Class<ListPendingChangesOutput>("ListPendingChangesOutput")({
  nodes: Schema.Array(Node),
  facts: Schema.Array(Fact),
  edges: Schema.Array(Edge)
}) {}
