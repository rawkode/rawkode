import * as Schema from "effect/Schema"
import { ToolCallRequest } from "./model-client.js"
import { EntityId, IsoDateTimeString } from "./node.js"

// Phase 3 storage-schema task (plan §"Agent-native editing & gatekeeper integrations": "Chats
// are workspace-scoped, mirroring multi-gadget.md decision #4 — one agent turn can create/link
// multiple notes and entities at once"). This file owns the *persisted* workspace-storage chat
// entities — the `chats`/(implicitly) `chatMessages` collections named in the plan's
// §"Storage & domain model" collection list — as opposed to model-client.ts's `ChatThread`/
// `ChatMessage`, which are the ephemeral, provider-shaped payload `ModelClient.converse()` is
// called with on any single turn.
//
// Naming note (a genuine collision, resolved deliberately): the task that produced this file
// was worded against `multi-gadget.md`'s own vocabulary and asked for types literally named
// `ChatThread`/`ChatMessage`. Those names are already taken at this package's root export
// surface by model-client.ts's Anthropic-content-block-shaped wire types, which
// `packages/backend/src/model-client-anthropic.ts` and
// `packages/backend/src/model-client-scripted.ts` already import from `@athenaeum/domain` (i.e.
// real, shipped, tested code, not a stub) — reusing the names here would either collide at
// `index.ts`'s export surface or require renaming those already-verified files' imports, which
// the task's own hard constraints rule out ("Do not restructure or rewrite what already works").
// So: `Chat` (mirrors the plan's `chats` collection name the same way `Page`/`Tag`/`Fact`/`Edge`
// mirror theirs) for the persisted thread record, and `ChatMessageRecord` for the persisted
// per-message row — the `Record` suffix flags "this is the storage-log shape," distinct from
// model-client.ts's `ChatMessage`. A future `AgentEditService` (not built yet — Storage stage)
// is what will translate a chat's `ChatMessageRecord` history into a `ChatThread`/`ChatMessage[]`
// immediately before calling `ModelClient.converse()`; the two shapes are related but not the
// same type; see also `ChatMessageRecord`'s own doc comment for why the two also *differ*
// structurally, not just by name.

/**
 * A workspace-scoped chat thread (plan: "Chats are workspace-scoped... one agent turn can create/link
 * multiple notes and entities at once"). Mirrors the plan's exact field list: `{id, workspaceId,
 * title, createdAt}`.
 */
export class Chat extends Schema.Class<Chat>("Chat")({
  id: EntityId,
  workspaceId: EntityId,
  title: Schema.String.pipe(Schema.minLength(1)),
  createdAt: IsoDateTimeString
}) {}

/**
 * One persisted message in a `Chat`'s log. Mirrors the plan's exact field list: `{id, chatId,
 * role: "user"|"assistant"|"tool", content, toolCalls?, sequence}`.
 *
 * Deliberately *not* shaped like model-client.ts's `ChatMessage` (`{role: "user"|"assistant",
 * content: ChatContentBlock[]}`), even though both describe "one turn of a conversation" — they
 * serve different jobs. `ChatMessage` is the exact shape one specific provider call
 * (`ModelClient.converse`) is built from, chosen (per that file's own doc comment) to match
 * Anthropic's content-block union 1:1 so no lossy translation is needed *there*. This type is
 * the workspace's durable, provider-agnostic log record of what happened in a chat — used for
 * replay, crash recovery (§Q15's set-difference re-adoption needs a real persisted log to diff
 * against), UI history rendering, and the `pending`/`changes` accounting the plan describes —
 * none of which should be coupled to one provider's request format. Concretely: `role` includes
 * a third `"tool"` value (a tool's result, recorded as its own row) and `toolCalls` is a
 * separate optional field from `content` (an assistant row that requested tool calls carries
 * both), which is the OpenAI-style "message with an optional parallel tool_calls array" shape
 * `multi-gadget.md`'s own chat model uses — not Anthropic's "tool_result is just a content block
 * on a user-role message" convention `ChatMessage` deliberately mirrors instead. `toolCalls`
 * reuses model-client.ts's `ToolCallRequest` (`{id, name, input}`) rather than inventing a
 * second identical shape, since it's already the exact "one tool call the model asked for"
 * schema this needs.
 *
 * `content` is `Schema.String`, matching model-client.ts's `ChatToolResultBlock.content` (also a
 * plain string) — a `"tool"`-role row's content is the tool's (already-serialized, if
 * structured) result text; a `"user"`/`"assistant"`-role row's content is its text, which may be
 * empty when an `"assistant"` row's substance is entirely its `toolCalls`.
 */
export class ChatMessageRecord extends Schema.Class<ChatMessageRecord>("ChatMessageRecord")({
  id: EntityId,
  chatId: EntityId,
  role: Schema.Literal("user", "assistant", "tool"),
  content: Schema.String,
  toolCalls: Schema.optional(Schema.Array(ToolCallRequest)),
  sequence: Schema.Number.pipe(Schema.int(), Schema.nonNegative())
}) {}
