import * as Context from "effect/Context"
import * as Data from "effect/Data"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { JsonValue } from "./json-value.js"

// Phase 3 spike (plan §"Agent-native editing", "1. Pluggable model-client design"): a
// provider-agnostic interface the future `AgentEditService` (backend) drives, with two real
// `Layer` implementations — `ModelClientScripted` (backend, deterministic test double) and
// `ModelClientAnthropic` (backend, a real HTTP client against Anthropic's Messages API). This
// file owns only the *interface*: entity/wire schemas, the closed `ModelError` failure channel,
// and the `ModelClient` Context.Tag — zero Cloudflare/`fetch`/env-binding dependencies, exactly
// like every other `*Repository`/`*Client` Context.Tag in this package (see `PagesRepository`'s
// own doc comment for the interface-lives-in-domain / implementation-lives-in-backend split).
// Full design rationale: `apps/athenaeum/docs/agent-model-client.md`.

/**
 * One block of a chat message's content. Named and shaped after Anthropic's own Messages API
 * content-block union (`text` / `tool_use` / `tool_result`) deliberately — not because this
 * package depends on Anthropic, but because that shape is already the right generalization for
 * "a turn in a tool-calling conversation" and picking a different one would just require a
 * lossy translation layer in `ModelClientAnthropic` for no benefit. A `ModelClientScripted`
 * turn (or a future non-Anthropic provider) uses the exact same blocks.
 */
export class ChatTextBlock extends Schema.Class<ChatTextBlock>("ChatTextBlock")({
  type: Schema.Literal("text"),
  text: Schema.String
}) {}

/** An assistant turn's request to call a tool — mirrors `ToolCallRequest` below field-for-field
 *  (this is the "as sent back in conversation history" shape; `ToolCallRequest` is "as returned
 *  from `converse` for the caller to act on"). Kept as two separate schemas rather than one
 *  reused type because they play different roles: this one is a `ChatMessage` content block (one
 *  of several in an array, alongside text/tool_result), `ToolCallRequest` is the top-level
 *  `ModelTurnToolCalls.calls` element a caller pattern-matches on directly. */
export class ChatToolUseBlock extends Schema.Class<ChatToolUseBlock>("ChatToolUseBlock")({
  type: Schema.Literal("tool_use"),
  id: Schema.String.pipe(Schema.minLength(1)),
  name: Schema.String.pipe(Schema.minLength(1)),
  input: JsonValue
}) {}

/** A prior tool call's result, fed back into the next `converse` call's `thread.messages` as a
 *  `user`-role message's content block — the standard tool-use round-trip shape every provider
 *  with tool calling uses in some form. */
export class ChatToolResultBlock extends Schema.Class<ChatToolResultBlock>("ChatToolResultBlock")({
  type: Schema.Literal("tool_result"),
  toolUseId: Schema.String.pipe(Schema.minLength(1)),
  content: Schema.String,
  isError: Schema.optional(Schema.Boolean)
}) {}

export const ChatContentBlock = Schema.Union(ChatTextBlock, ChatToolUseBlock, ChatToolResultBlock)
export type ChatContentBlock = typeof ChatContentBlock.Type

/** One turn in the conversation. `role` is deliberately just `"user" | "assistant"` (not a
 *  third `"tool"` role) — per Anthropic's own convention (and most providers'), a tool result is
 *  a `user`-role message whose content happens to be a `tool_result` block, not a separate role;
 *  modeling it that way here means `ModelClientAnthropic`'s message mapping is a structural
 *  no-op, not a role-remapping step. */
export class ChatMessage extends Schema.Class<ChatMessage>("ChatMessage")({
  role: Schema.Literal("user", "assistant"),
  content: Schema.Array(ChatContentBlock)
}) {}

/** The full conversation `ModelClient.converse` is asked to continue. `systemPrompt` is separate
 *  from `messages` (not a `"system"`-role message) because every current provider's API treats
 *  the system prompt as its own top-level request field, not a conversation turn. */
export class ChatThread extends Schema.Class<ChatThread>("ChatThread")({
  systemPrompt: Schema.optional(Schema.String),
  messages: Schema.Array(ChatMessage)
}) {}

/** One tool the model may call this turn — the caller-supplied half of tool calling (as opposed
 *  to `ToolCallRequest`, the model's response). `inputSchema` is `JsonValue` (see json-value.ts's
 *  own doc comment for why `Schema.Unknown` is the wrong call here too): a JSON Schema object is
 *  exactly the kind of arbitrarily-nested-but-JSON-safe structure `JsonValue` exists for, and a
 *  provider client validates/forwards it without needing to understand JSON Schema itself. */
export class ToolSpec extends Schema.Class<ToolSpec>("ToolSpec")({
  name: Schema.String.pipe(Schema.minLength(1)),
  description: Schema.String,
  inputSchema: JsonValue
}) {}

/** One tool call the model wants executed, as returned to the caller inside
 *  `ModelTurnToolCalls.calls`. `id` round-trips back as `ChatToolResultBlock.toolUseId` on the
 *  next `converse` call — providers require this pairing to associate a result with its call. */
export class ToolCallRequest extends Schema.Class<ToolCallRequest>("ToolCallRequest")({
  id: Schema.String.pipe(Schema.minLength(1)),
  name: Schema.String.pipe(Schema.minLength(1)),
  input: JsonValue
}) {}

/**
 * `converse`'s two possible outcomes, per the plan: "a discriminated union of 'call these
 * tools' / 'final text reply'." `kind` (not `_tag`) is the discriminant field name — this union
 * crosses no `Data.TaggedError`/`Cause` machinery, so there's no reason to borrow that
 * convention; a plain `Schema.Literal` discriminant keeps `Schema.Union`'s own discrimination
 * working without extra ceremony.
 */
export class ModelTurnToolCalls extends Schema.Class<ModelTurnToolCalls>("ModelTurnToolCalls")({
  kind: Schema.Literal("tool_calls"),
  calls: Schema.Array(ToolCallRequest)
}) {}

export class ModelTurnFinalText extends Schema.Class<ModelTurnFinalText>("ModelTurnFinalText")({
  kind: Schema.Literal("final_text"),
  text: Schema.String
}) {}

export const ModelTurnResult = Schema.Union(ModelTurnToolCalls, ModelTurnFinalText)
export type ModelTurnResult = typeof ModelTurnResult.Type

// --- ModelError: the closed failure channel every ModelClient implementation shares ----------
//
// Three variants, one per place a real provider call can fail, chosen to be implementation-
// agnostic (a scripted double can raise all three; a real HTTP client's failure modes map onto
// them 1:1 — see `ModelClientAnthropic`'s own doc comment):
// - `ModelUnavailable` — there is no way to produce a turn right now: no API key configured
//   (the hard-constraint case this task exists to handle cleanly — see
//   docs/agent-model-client.md), or (scripted double only) the pre-programmed script is
//   exhausted. Both are "this client cannot answer," not "the network/provider failed."
// - `ModelRequestFailed` — an outbound call was attempted and failed before/without producing a
//   usable response: network failure, timeout, or a non-2xx HTTP status.
// - `ModelResponseInvalid` — a response was received but could not be decoded into a
//   `ModelTurnResult`: malformed JSON, an unrecognized `stop_reason`, a tool_use block with a
//   non-JSON-safe `input`, etc.
//
// Not wired into `rpc-error.ts`'s `RpcErrorEnvelope`/`DomainError` union — `ModelClient` is
// consumed server-side, in-process, by the (not-yet-built) `AgentEditService`; it never itself
// crosses the Cap'n Web throw boundary. If/when a future RPC method surfaces a model failure to
// a client directly, folding these into `DomainError` is a small, isolated addition at that
// point — deliberately not done speculatively here.

export class ModelUnavailable extends Data.TaggedError("ModelUnavailable")<{
  readonly message: string
}> {}

export class ModelRequestFailed extends Data.TaggedError("ModelRequestFailed")<{
  readonly message: string
  readonly status?: number
}> {}

export class ModelResponseInvalid extends Data.TaggedError("ModelResponseInvalid")<{
  readonly message: string
}> {}

export type ModelError = ModelUnavailable | ModelRequestFailed | ModelResponseInvalid

/**
 * The pluggable model-client service (plan: "an Effect `Context.Tag` service, e.g.
 * `ModelClient`, with a method like `converse(thread, availableTools): Effect<ModelTurnResult,
 * ModelError>`"). Interface only — see `packages/backend/src/model-client-scripted.ts` and
 * `packages/backend/src/model-client-anthropic.ts` for the two real `Layer` implementations.
 */
export class ModelClient extends Context.Tag("@athenaeum/domain/ModelClient")<
  ModelClient,
  {
    readonly converse: (
      thread: ChatThread,
      availableTools: ReadonlyArray<ToolSpec>
    ) => Effect.Effect<ModelTurnResult, ModelError>
  }
>() {}
