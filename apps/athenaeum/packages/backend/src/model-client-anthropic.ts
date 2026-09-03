// `ModelClientAnthropic` — the real-HTTP-client half of the plan's "two real Layer
// implementations" (plan §"Agent-native editing & gatekeeper integrations", "1. Pluggable
// model-client design"). Builds a genuine Anthropic Messages API (`POST /v1/messages`) request
// from a `ChatThread`/`ToolSpec[]` and parses a genuine response back into a `ModelTurnResult` —
// request/response shape verified against Anthropic's own current documentation (headers,
// content-block shapes, `stop_reason` values), not guessed. **No real Anthropic API key is
// available in this environment** — per this task's hard constraint, this Layer is real,
// correctly-shaped, and genuinely unreachable-without-configuration: `makeModelClientAnthropicLive`
// with `apiKey: undefined` fails every `converse` call with `ModelUnavailable` before attempting
// any network I/O, and is never exercised end-to-end against the real API here. It IS exercised
// against a mocked `HttpFetch` layer (see model-client-anthropic.test.ts) to prove the request-
// building and response-parsing logic independently of network access — **a real live-model
// integration test is explicitly not possible in this environment** and would need to run
// wherever `ANTHROPIC_API_KEY` is actually configured. Full design: docs/agent-model-client.md.
//
// Adversarial-review fix: `thinking: {type: "disabled"}` is sent on every request — see
// `THINKING_DISABLED`'s own doc comment below for why (`DEFAULT_MODEL` runs adaptive thinking on
// by default, and `ChatContentBlock` has no thinking-block representation to round-trip it).

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import {
  type ChatContentBlock,
  type ChatMessage,
  ModelClient,
  ModelRequestFailed,
  ModelResponseInvalid,
  ModelTurnFinalText,
  ModelTurnToolCalls,
  ModelUnavailable,
  ToolCallRequest,
  type ToolSpec
} from "@athenaeum/domain"
import { type AiGatewayRoute, gatewayAuthHeader, gatewayHttpUrl } from "./ai-gateway-route.js"

/**
 * The one seam this module reaches the network through — a minimal `fetch`-shaped
 * `Context.Tag`, not `@effect/platform`'s `HttpClient` (this workspace has no dependency on
 * `@effect/platform` yet, and pulling one in for a single outbound call is more machinery than
 * this stub needs). This is deliberately the *only* thing `model-client-anthropic.test.ts`
 * mocks — "mock only the HTTP layer, not the whole client" (this task's hard constraint) means
 * every other line in this file (request construction, response parsing, error mapping) runs
 * for real in that test, against a fake `fetch` standing in for the network.
 */
export class HttpFetch extends Context.Tag("@athenaeum/backend/HttpFetch")<
  HttpFetch,
  { readonly fetch: (url: string, init: RequestInit) => Promise<Response> }
>() {}

/** Production default: the real global `fetch` (available in `workerd`, subject to this
 *  project's `global_fetch_strictly_public` compatibility flag — see `wrangler.jsonc`'s own
 *  comment on that flag, added specifically for "agent tools, gatekeeper calls" like this one). */
export const HttpFetchLive: Layer.Layer<HttpFetch> = Layer.succeed(HttpFetch, {
  fetch: (url, init) => fetch(url, init)
})

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
const ANTHROPIC_VERSION = "2023-06-01"
const DEFAULT_MODEL = "claude-opus-5"
const DEFAULT_MAX_TOKENS = 4096

// Adversarial-review fix (significant finding): `claude-opus-5` — this module's own
// `DEFAULT_MODEL` — runs adaptive thinking ON BY DEFAULT when the `thinking` parameter is
// omitted (unlike Opus 4.8/4.7, where omitting it meant no thinking; current Anthropic docs,
// confirmed via the `claude-api` skill's cached model-migration reference). This client never
// set `thinking` at all, so every real turn against the real default model would silently run
// adaptive thinking — and `ChatContentBlock` (model-client.ts) has no `thinking`/`redacted_thinking`
// variant, so any thinking blocks in the response would be silently dropped by `parseResponseBody`
// below (never echoed back into the next turn's history), contrary to Anthropic's documented
// multi-turn pattern ("pass thinking blocks back unchanged when continuing on the same model").
//
// Fix chosen: explicitly disable thinking (`thinking: {type: "disabled"}`) rather than adding a
// `ChatThinkingBlock` domain variant and threading it through request/response — this module's own
// header comment already documents thinking support as deliberately out of scope for this stage
// ("if a future caller enables extended thinking" — an assumption that turned out to be false only
// because Opus 5 defaults it on, not because this stage ever intended to support it). Disabling
// explicitly closes that gap without expanding this spike's scope.
//
// Effort constraint that makes this valid: `thinking: {type: "disabled"}` on Claude Opus 5 is
// accepted only at `output_config.effort` "high" or below — pairing it with "xhigh"/"max" returns
// a 400. This module never sets `output_config.effort` at all, which defaults to "high" (the
// docs' own words: "default high (equivalent to omitting it)") — squarely within the accepted
// range, so no `output_config` needs to be added here. If a future stage adds an effort override
// above "high", this constraint must be revisited together.
//
// Untestable without a live key (hard constraint, same as the rest of this file): the actual
// 400-at-xhigh/max boundary, and the real shape of a live Opus 5 response with thinking disabled,
// cannot be exercised here — model-client-anthropic.test.ts proves only that this client SENDS
// `thinking: {type: "disabled"}` on every request, via the same mocked-HTTP-layer pattern as
// every other assertion in that file.
const THINKING_DISABLED = { type: "disabled" } as const

export interface ModelClientAnthropicConfig {
  /** The real secret, read by the caller from wherever it lives (a Worker secret binding, per
   *  the plan's own phrasing — "reading its API key from an environment binding/secret").
   *  `undefined` in every environment that hasn't configured one, including this one. */
  readonly apiKey: string | undefined
  readonly model?: string
  readonly maxTokens?: number
  /** `undefined` (the default) => DIRECT mode, calling `api.anthropic.com` exactly as before this
   *  config field existed. When set (`resolveAiGatewayRoute(env)` in `ai-gateway-route.ts` found
   *  both `CF_AI_GATEWAY_ACCOUNT_ID`/`CF_AI_GATEWAY_NAME` configured), every request is routed
   *  through Cloudflare AI Gateway's per-provider passthrough endpoint instead — see
   *  docs/ai-gateway-decisions.md §1. `apiKey` is unaffected either way: pass-through, not BYOK. */
  readonly gateway?: AiGatewayRoute
}

// --- Request construction ---------------------------------------------------------------------

/** `ChatContentBlock` → Anthropic's own content-block wire shape. A structural rename, not a
 *  lossy translation — see `model-client.ts`'s own doc comment on why `ChatContentBlock` is
 *  already shaped after Anthropic's union: this function only ever renames fields
 *  (`toolUseId` → `tool_use_id`, `isError` → `is_error`), it never has to choose what to drop. */
const toAnthropicContentBlock = (block: ChatContentBlock): unknown => {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text }
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input }
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        ...(block.isError === undefined ? {} : { is_error: block.isError })
      }
  }
}

const toAnthropicMessage = (message: ChatMessage): unknown => ({
  role: message.role,
  content: message.content.map(toAnthropicContentBlock)
})

const toAnthropicTool = (tool: ToolSpec): unknown => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.inputSchema
})

// --- Response parsing ----------------------------------------------------------------------
//
// Deliberately loose rather than an exhaustive Schema.Union over every Anthropic content-block
// type (text/tool_use/thinking/redacted_thinking/server_tool_use/...) — this client only acts on
// `text` and `tool_use` blocks (per `ModelTurnResult`'s own two-variant union), and a response
// carrying a block type it doesn't recognize must not fail decoding just because this stub doesn't
// understand it yet. This request now always sends `thinking: {type: "disabled"}` (see
// `THINKING_DISABLED`'s doc comment), so a real Opus 5 response should never actually contain a
// `thinking` block — but this tolerance is kept regardless, both as defense against a
// misconfigured future request and because the same leniency covers any other block type
// (`server_tool_use`, etc.) this stub was never going to act on anyway.
// Known, documented simplification (see docs/agent-model-client.md): `stop_reason: "refusal"` is
// not given special handling — its (usually empty) text content is returned as an ordinary
// `ModelTurnFinalText`, not surfaced as a distinct error. A real caller that needs to detect
// refusals should inspect the returned text / a future `stop_reason` passthrough; wiring that in
// is straightforward but out of scope for this spike.

const AnthropicToolUseBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown
})

const AnthropicResponseEnvelope = Schema.Struct({
  content: Schema.Array(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  stop_reason: Schema.NullOr(Schema.String)
})

const parseResponseBody = (
  body: unknown
): Effect.Effect<ModelTurnToolCalls | ModelTurnFinalText, ModelResponseInvalid> =>
  Schema.decodeUnknown(AnthropicResponseEnvelope)(body).pipe(
    Effect.mapError(
      (parseError) =>
        new ModelResponseInvalid({
          message: `Anthropic response did not match the expected envelope: ${parseError.message}`
        })
    ),
    Effect.flatMap((envelope) =>
      Effect.gen(function* () {
        if (envelope.stop_reason === "tool_use") {
          const toolUseBlocks = envelope.content.filter(
            (block): boolean => block["type"] === "tool_use"
          )
          if (toolUseBlocks.length === 0) {
            return yield* Effect.fail(
              new ModelResponseInvalid({
                message: "Anthropic response has stop_reason \"tool_use\" but no tool_use content blocks"
              })
            )
          }
          const calls = yield* Effect.forEach(toolUseBlocks, (block) =>
            Schema.decodeUnknown(AnthropicToolUseBlock)(block).pipe(
              Effect.mapError(
                (parseError) =>
                  new ModelResponseInvalid({
                    message: `Anthropic tool_use block did not match the expected shape: ${parseError.message}`
                  })
              ),
              Effect.map(
                (decoded) => new ToolCallRequest({ id: decoded.id, name: decoded.name, input: decoded.input as never })
              )
            ))
          return new ModelTurnToolCalls({ kind: "tool_calls", calls })
        }

        const text = envelope.content
          .filter((block): boolean => block["type"] === "text")
          .map((block) => (typeof block["text"] === "string" ? block["text"] : ""))
          .join("")
        return new ModelTurnFinalText({ kind: "final_text", text })
      })
    )
  )

// --- The Layer -----------------------------------------------------------------------------

export const makeModelClientAnthropicLive = (
  config: ModelClientAnthropicConfig
): Layer.Layer<ModelClient, never, HttpFetch> =>
  Layer.effect(
    ModelClient,
    Effect.gen(function* () {
      const http = yield* HttpFetch
      const model = config.model ?? DEFAULT_MODEL
      const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
      // GATEWAY mode: route through Cloudflare AI Gateway's per-provider passthrough endpoint
      // (a pure URL-prefix swap — the request/response shape below is completely unchanged either
      // way). DIRECT mode (config.gateway undefined, the default) is exactly today's behavior.
      // See ai-gateway-route.ts's header comment and docs/ai-gateway-decisions.md §1.
      const requestUrl = config.gateway === undefined
        ? ANTHROPIC_API_URL
        : gatewayHttpUrl(config.gateway, "anthropic/v1/messages")

      return {
        converse: (thread, availableTools) =>
          Effect.gen(function* () {
            // Hard constraint: cleanly no-op/erroring when unconfigured — never attempts network
            // I/O without a real key. Checked on every call (not memoized at Layer-build time) so
            // a key that becomes available later (e.g. a secret rotated in) is picked up without
            // rebuilding the Layer.
            const apiKey = config.apiKey
            if (apiKey === undefined || apiKey.length === 0) {
              return yield* Effect.fail(
                new ModelUnavailable({
                  message: "ModelClientAnthropic: no API key configured (ANTHROPIC_API_KEY unset)"
                })
              )
            }

            const requestBody = {
              model,
              max_tokens: maxTokens,
              // See THINKING_DISABLED's own doc comment above for why this is always sent —
              // DEFAULT_MODEL (claude-opus-5) runs adaptive thinking by default otherwise, and
              // this client has no domain representation for thinking content blocks.
              thinking: THINKING_DISABLED,
              ...(thread.systemPrompt === undefined ? {} : { system: thread.systemPrompt }),
              messages: thread.messages.map(toAnthropicMessage),
              ...(availableTools.length === 0 ? {} : { tools: availableTools.map(toAnthropicTool) })
            }

            const response = yield* Effect.tryPromise({
              try: () =>
                http.fetch(requestUrl, {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "x-api-key": apiKey,
                    "anthropic-version": ANTHROPIC_VERSION,
                    ...gatewayAuthHeader(config.gateway)
                  },
                  body: JSON.stringify(requestBody)
                }),
              catch: (cause) =>
                new ModelRequestFailed({
                  message: `request to Anthropic Messages API failed: ${cause instanceof Error ? cause.message : String(cause)}`
                })
            })

            if (!response.ok) {
              const bodyText = yield* Effect.tryPromise({
                try: () => response.text(),
                catch: () => new ModelRequestFailed({ message: "failed to read error response body", status: response.status })
              }).pipe(Effect.catchAll(() => Effect.succeed("<unreadable body>")))
              return yield* Effect.fail(
                new ModelRequestFailed({
                  message: `Anthropic Messages API returned ${response.status}: ${bodyText}`,
                  status: response.status
                })
              )
            }

            const json = yield* Effect.tryPromise({
              try: () => response.json(),
              catch: (cause) =>
                new ModelResponseInvalid({
                  message: `Anthropic response body was not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`
                })
            })

            return yield* parseResponseBody(json)
          })
      }
    })
  )
