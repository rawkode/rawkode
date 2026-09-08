# Agent model-client design

Status: Phase 3 pre-work spike, complete. Resolves plan item "1. Pluggable model-client design"
from the "Agent-native editing & gatekeeper integrations" section of the architecture plan.

## The interface

`ModelClient` (`packages/domain/src/model-client.ts`) is a `Context.Tag` with one method:

```ts
converse(thread: ChatThread, availableTools: ReadonlyArray<ToolSpec>): Effect.Effect<ModelTurnResult, ModelError>
```

- `ChatThread` = `{ systemPrompt?: string, messages: ChatMessage[] }`. `ChatMessage` =
  `{ role: "user" | "assistant", content: ChatContentBlock[] }`. `ChatContentBlock` is a
  discriminated union of `ChatTextBlock` (`{type:"text", text}`), `ChatToolUseBlock`
  (`{type:"tool_use", id, name, input}`), and `ChatToolResultBlock`
  (`{type:"tool_result", toolUseId, content, isError?}`).
- `ToolSpec` = `{ name, description, inputSchema: JsonValue }` — one tool the model may call.
- `ModelTurnResult` is the discriminated union the plan asked for: `ModelTurnToolCalls`
  (`{kind:"tool_calls", calls: ToolCallRequest[]}`) or `ModelTurnFinalText`
  (`{kind:"final_text", text}`).
- `ModelError` is a closed union of three `Data.TaggedError`s: `ModelUnavailable` (no way to
  answer right now — unconfigured API key, or a scripted double's script is exhausted),
  `ModelRequestFailed` (the outbound call itself failed — network error or non-2xx status), and
  `ModelResponseInvalid` (a response came back but didn't decode into a `ModelTurnResult`).

### Why this shape

The content-block union is deliberately modeled after Anthropic's own Messages API content
blocks (`text` / `tool_use` / `tool_result`), not a generic ad-hoc shape. This isn't an
Anthropic dependency leaking into `domain` — it's picking the right generalization once: "a turn
in a tool-calling conversation" already has this shape in most current provider APIs, and
choosing something else would just require a lossy translation layer in
`ModelClientAnthropic` for no benefit. A `ModelClientScripted` turn, or a future non-Anthropic
provider client, uses the exact same blocks with no adapter needed.

`ModelClient` lives in `packages/domain` (zero Cloudflare/`fetch`/env-binding deps), following
the same interface-in-domain / implementation-in-backend split as `PagesRepository` and every
other repository `Context.Tag` in this codebase. Both real implementations live in
`packages/backend`, because both need something domain must never depend on: `ModelClientScripted`
needs nothing Cloudflare-specific, but is *conceptually* a backend-test-support module (like
`nodes-subscription.ts`); `ModelClientAnthropic` needs `fetch` and (eventually) a Worker secret
binding for its API key.

`ModelError` is **not** wired into `rpc-error.ts`'s `RpcErrorEnvelope`/`DomainError` union.
`ModelClient` is consumed server-side, in-process, by the not-yet-built `AgentEditService` — it
never itself crosses the Cap'n Web RPC throw boundary. If a future RPC method needs to surface a
model failure to a client directly, folding these into `DomainError` is a small, isolated
follow-up at that point, not something to speculate about now.

## The two Layers

### `ModelClientScripted` (`packages/backend/src/model-client-scripted.ts`)

A deterministic test double: `makeModelClientScripted(script: ModelTurnResult[])` returns
`{ layer, calls, remaining }`. Each `converse()` call shifts the next entry off `script`'s copy
and returns it; calling `converse()` more times than the script has entries fails with
`ModelUnavailable`. `calls` records every `(thread, availableTools)` pair passed in, so a test
can assert not just what the client returned but what it was called with — e.g. that a second
turn's thread correctly included the `tool_result` block from the first turn's `tool_use`.

Deliberately **not** a module-level mutable queue: `makeModelClientScripted` is a factory each
test calls once, closing over a fresh array — the same discipline this codebase already applies
to other instance-scoped state (see `sync-feed-service-live.ts`'s `currentEpochAndGeneration` doc
comment on why module-level `Map`s risk leaking across DO instances colocated in one isolate; the
test-double analog is leaking script state across concurrently-running tests). Real, repeatable
tests: `packages/backend/test/model-client-scripted.test.ts` proves ordered turn delivery, call
recording, exhaustion failure, and a realistic propose-tool-call → tool-result → final-text round
trip — the exact shape `AgentEditService`'s agent loop will drive.

### `ModelClientAnthropic` (`packages/backend/src/model-client-anthropic.ts`)

A real HTTP client against Anthropic's Messages API (`POST https://api.anthropic.com/v1/messages`,
header `anthropic-version: 2023-06-01`, `x-api-key`), request/response shape verified against
Anthropic's current documentation:

- **Request**: `{ model, max_tokens, system?, messages, tools? }`. `messages` maps
  `ChatMessage[]` structurally (role passthrough, content blocks renamed field-for-field:
  `toolUseId` → `tool_use_id`, `isError` → `is_error`). `tools` maps `ToolSpec[]` to
  `{ name, description, input_schema }`. `system` and `tools` are omitted entirely (not sent as
  empty string/array) when absent, matching the real API's own optional-field convention.
- **Response**: decoded with a deliberately loose envelope schema (`content: unknown[]`,
  `stop_reason: string | null`) rather than an exhaustive union over every Anthropic content-block
  type — a response carrying a block type this client doesn't act on (e.g. `thinking`, if a
  future caller enables extended thinking) must not fail decoding. `stop_reason === "tool_use"`
  → validate and collect every `tool_use` block into `ModelTurnToolCalls`; anything else →
  concatenate every `text` block into `ModelTurnFinalText`.
- Network/HTTP failures map to `ModelRequestFailed` (with `status` set on a non-2xx response);
  a malformed body or an envelope that doesn't decode maps to `ModelResponseInvalid`.

**The HTTP boundary is a real `Context.Tag`, `HttpFetch`** (`{ fetch(url, init): Promise<Response> }`),
not `@effect/platform`'s `HttpClient` — this workspace has no dependency on `@effect/platform` yet
and pulling one in for a single outbound call is more machinery than this stub needs.
`HttpFetchLive` wires it to the real global `fetch` (available in `workerd`); tests provide a
`Layer.succeed(HttpFetch, { fetch: mockFn })` instead. This is the *only* thing
`model-client-anthropic.test.ts` mocks — request construction, header/body assembly, and response
parsing all run for real against the fake `fetch`, per this task's hard constraint ("mock only
the HTTP layer, not the whole client").

**Hard-constraint behavior, verified by test**: `makeModelClientAnthropicLive({ apiKey: undefined })`
(or an empty-string key) fails every `converse()` call with `ModelUnavailable` **before any
network I/O is attempted** — `mock.calls` is asserted to be empty in that case. No real Anthropic
API key is available or used anywhere in this environment or its tests.

## Known, documented simplifications (not built in this spike)

- **No streaming.** `max_tokens` defaults to 4096, well under the non-streaming SDK timeout risk
  threshold documented for real Anthropic clients; a production `AgentEditService` turn that
  needs a larger budget should add streaming support at that point, not before it's needed.
- **No `refusal` stop-reason handling.** A refusal currently falls through to
  `ModelTurnFinalText` with whatever (often empty) text Anthropic returned, rather than a
  distinct error/result variant. Straightforward to add — a `stop_reason` passthrough or a third
  `ModelTurnRefusal` variant — deferred because nothing in this spike needs to distinguish it yet.
- **No prompt caching, thinking/effort configuration, or fallbacks parameter.** All real,
  documented Anthropic features; omitted because they tune cost/latency/safety behavior an
  `AgentEditService` doesn't exist yet to need tuned. Adding them is additive to
  `ModelClientAnthropicConfig`, not a redesign.
- **`model`/`maxTokens` are the only configuration knobs**, both optional with defaults
  (`claude-opus-5`, 4096). Wiring `ANTHROPIC_API_KEY` from an actual Cloudflare Worker secret
  binding into `Env` and constructing this Layer inside `WorkspaceDurableObject` is deliberately left
  to whichever stage actually builds `AgentEditService` — this spike proves the Layer works
  correctly in isolation (against a mocked HTTP layer), not that it's wired into production yet.

**A real live-model integration test is not possible in this environment** (no
`ANTHROPIC_API_KEY` available) and is explicitly out of scope here — the unit tests in
`model-client-anthropic.test.ts` prove the request-building/response-parsing logic is correct by
construction; only an environment with a real key can additionally prove Anthropic's live API
actually accepts the requests this client builds.

## What the next stage (`AgentEditService`) builds against

- Depend on `ModelClient` via `Context.Tag`, exactly like every other backend service depends on
  its collaborators (`NotesService` depends on `NodesRepository`/`PagesRepository`/`SyncFeedService`
  the same way).
- In tests, provide `makeModelClientScripted([...]).layer` and assert against `.calls` — no
  network, fully deterministic, real coverage of the tool-calling loop mechanics (propose →
  execute → feed result back → repeat until `final_text`).
- In production, provide `makeModelClientAnthropicLive({ apiKey: env.ANTHROPIC_API_KEY })` layered
  over `HttpFetchLive`, once `Env` gains an `ANTHROPIC_API_KEY?: string` binding and
  `WorkspaceDurableObject`'s constructor wires it in alongside its other service Layers.
