// Proves `ModelClientAnthropic`'s request-building and response-parsing logic is genuinely
// correct, by mocking *only* the HTTP layer (`HttpFetch`) — never the `ModelClient` itself and
// never any of this module's own request/response code. This is the test the plan's hard
// constraint asks for: "write unit tests that mock only the HTTP layer (not the whole client)
// to prove the request-building/response-parsing logic is correct" — real Effect programs run
// through the real `makeModelClientAnthropicLive` implementation end-to-end; only the network
// call inside `HttpFetch.fetch` is a fake. **No real Anthropic API key is used or required —
// exercising this against the live API is explicitly out of scope for this environment (see
// model-client-anthropic.ts's own header comment); if/when a real key is available elsewhere,
// the same request-building code path this test proves correct is what would run.**

import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import {
  ChatMessage,
  ChatTextBlock,
  ChatThread,
  ChatToolResultBlock,
  ChatToolUseBlock,
  ModelClient,
  ModelTurnFinalText,
  ModelTurnToolCalls,
  ToolCallRequest,
  ToolSpec
} from "@athenaeum/domain"
import { HttpFetch, makeModelClientAnthropicLive } from "../src/model-client-anthropic.js"
import type { AiGatewayRoute } from "../src/ai-gateway-route.js"

/** A recorded call into the mocked `fetch` — captures exactly what `ModelClientAnthropic` sent,
 *  so tests can assert on the real request shape rather than trusting the implementation. */
interface RecordedFetchCall {
  readonly url: string
  readonly init: RequestInit
}

const mockHttpFetch = (
  handler: (call: RecordedFetchCall) => Response
): { readonly layer: Layer.Layer<HttpFetch>; readonly calls: Array<RecordedFetchCall> } => {
  const calls: Array<RecordedFetchCall> = []
  const layer = Layer.succeed(HttpFetch, {
    fetch: (url, init) => {
      const call = { url, init }
      calls.push(call)
      return Promise.resolve(handler(call))
    }
  })
  return { layer, calls }
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const userThread = (text: string, systemPrompt?: string): ChatThread =>
  new ChatThread({
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    messages: [new ChatMessage({ role: "user", content: [new ChatTextBlock({ type: "text", text })] })]
  })

const runConverse = (
  httpLayer: Layer.Layer<HttpFetch>,
  apiKey: string | undefined,
  thread: ChatThread,
  tools: ReadonlyArray<ToolSpec> = [],
  gateway?: AiGatewayRoute
) =>
  Effect.gen(function* () {
    const client = yield* ModelClient
    return yield* client.converse(thread, tools)
  }).pipe(Effect.provide(makeModelClientAnthropicLive({ apiKey, gateway }).pipe(Layer.provide(httpLayer))))

describe("ModelClientAnthropic: unconfigured (no API key)", () => {
  it("fails with ModelUnavailable without ever calling fetch", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { content: [], stop_reason: "end_turn" }))

    const exit = await Effect.runPromiseExit(runConverse(mock.layer, undefined, userThread("hi")))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("ModelUnavailable")
    }
    expect(mock.calls).toHaveLength(0)
  })

  it("also fails cleanly on an empty-string key, not just undefined", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { content: [], stop_reason: "end_turn" }))
    const exit = await Effect.runPromiseExit(runConverse(mock.layer, "", userThread("hi")))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(mock.calls).toHaveLength(0)
  })
})

describe("ModelClientAnthropic: request construction", () => {
  it("sends the correct URL, headers, model, max_tokens, system, messages, and tools", async () => {
    const mock = mockHttpFetch(() =>
      jsonResponse(200, { content: [{ type: "text", text: "hi back" }], stop_reason: "end_turn" })
    )

    const tools = [
      new ToolSpec({ name: "createNode", description: "Create a node", inputSchema: { type: "object", properties: {} } })
    ]

    await Effect.runPromise(runConverse(mock.layer, "sk-test-key", userThread("Hello", "You are helpful."), tools))

    expect(mock.calls).toHaveLength(1)
    const call = mock.calls[0]!
    expect(call.url).toBe("https://api.anthropic.com/v1/messages")
    expect(call.init.method).toBe("POST")

    const headers = call.init.headers as Record<string, string>
    expect(headers["x-api-key"]).toBe("sk-test-key")
    expect(headers["anthropic-version"]).toBe("2023-06-01")
    expect(headers["content-type"]).toBe("application/json")

    const body = JSON.parse(call.init.body as string)
    expect(body.model).toBe("claude-opus-5")
    expect(body.max_tokens).toBe(4096)
    expect(body.system).toBe("You are helpful.")
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Hello" }] }])
    expect(body.tools).toEqual([
      { name: "createNode", description: "Create a node", input_schema: { type: "object", properties: {} } }
    ])
  })

  // Adversarial-review fix (significant finding): DEFAULT_MODEL (claude-opus-5) runs adaptive
  // thinking on by default when `thinking` is omitted, and `ChatContentBlock` has no
  // thinking-block variant to round-trip one — so this client must always explicitly disable
  // thinking, on every request, not just the one the "request construction" test above happens
  // to check field-by-field. See model-client-anthropic.ts's own `THINKING_DISABLED` doc comment.
  it("always sends thinking: {type: disabled} — Opus 5 defaults thinking on otherwise", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { content: [], stop_reason: "end_turn" }))
    await Effect.runPromise(runConverse(mock.layer, "sk-test-key", userThread("Hello")))
    const body = JSON.parse(mock.calls[0]!.init.body as string)
    expect(body.thinking).toEqual({ type: "disabled" })
    // Also confirm the *other* half of the constraint this relies on: no output_config.effort is
    // ever sent, so effort silently defaults to "high" (Anthropic's own documented default) —
    // squarely within the "disabled thinking accepted at effort high or below" rule. If a future
    // change starts sending output_config.effort, this assertion is the tripwire that forces that
    // change to also revisit THINKING_DISABLED.
    expect("output_config" in body).toBe(false)
  })

  it("omits system and tools entirely when not provided (not empty-string/empty-array)", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { content: [], stop_reason: "end_turn" }))
    await Effect.runPromise(runConverse(mock.layer, "sk-test-key", userThread("Hello")))
    const body = JSON.parse(mock.calls[0]!.init.body as string)
    expect("system" in body).toBe(false)
    expect("tools" in body).toBe(false)
  })

  it("respects a configured model and maxTokens override", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { content: [], stop_reason: "end_turn" }))
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* ModelClient
        yield* client.converse(userThread("hi"), [])
      }).pipe(
        Effect.provide(
          makeModelClientAnthropicLive({ apiKey: "sk-test", model: "claude-haiku-4-5", maxTokens: 512 }).pipe(
            Layer.provide(mock.layer)
          )
        )
      )
    )
    const body = JSON.parse(mock.calls[0]!.init.body as string)
    expect(body.model).toBe("claude-haiku-4-5")
    expect(body.max_tokens).toBe(512)
  })

  it("maps tool_use and tool_result content blocks to Anthropic's wire shape", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { content: [], stop_reason: "end_turn" }))
    const thread = new ChatThread({
      messages: [
        new ChatMessage({
          role: "assistant",
          content: [new ChatToolUseBlock({ type: "tool_use", id: "call-1", name: "createNode", input: { title: "X" } })]
        }),
        new ChatMessage({
          role: "user",
          content: [new ChatToolResultBlock({ type: "tool_result", toolUseId: "call-1", content: "created", isError: false })]
        })
      ]
    })
    await Effect.runPromise(runConverse(mock.layer, "sk-test", thread))
    const body = JSON.parse(mock.calls[0]!.init.body as string)
    expect(body.messages).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "createNode", input: { title: "X" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "created", is_error: false }] }
    ])
  })
})

describe("ModelClientAnthropic: AI Gateway routing", () => {
  it("DIRECT mode (gateway undefined) is unchanged — calls api.anthropic.com directly", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { content: [], stop_reason: "end_turn" }))
    await Effect.runPromise(runConverse(mock.layer, "sk-test-key", userThread("hi"), [], undefined))
    expect(mock.calls[0]!.url).toBe("https://api.anthropic.com/v1/messages")
    const headers = mock.calls[0]!.init.headers as Record<string, string>
    expect(headers["cf-aig-authorization"]).toBeUndefined()
  })

  it("GATEWAY mode routes through the per-provider passthrough endpoint, x-api-key unchanged", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { content: [], stop_reason: "end_turn" }))
    const gateway: AiGatewayRoute = { accountId: "acct-123", gatewayName: "my-gateway" }
    await Effect.runPromise(runConverse(mock.layer, "sk-test-key", userThread("hi"), [], gateway))
    expect(mock.calls[0]!.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct-123/my-gateway/anthropic/v1/messages"
    )
    const headers = mock.calls[0]!.init.headers as Record<string, string>
    expect(headers["x-api-key"]).toBe("sk-test-key")
    expect(headers["anthropic-version"]).toBe("2023-06-01")
    expect(headers["cf-aig-authorization"]).toBeUndefined()
  })

  it("GATEWAY mode adds cf-aig-authorization only when an Authenticated Gateway token is configured", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { content: [], stop_reason: "end_turn" }))
    const gateway: AiGatewayRoute = { accountId: "acct-123", gatewayName: "my-gateway", authToken: "run-token-xyz" }
    await Effect.runPromise(runConverse(mock.layer, "sk-test-key", userThread("hi"), [], gateway))
    const headers = mock.calls[0]!.init.headers as Record<string, string>
    expect(headers["cf-aig-authorization"]).toBe("Bearer run-token-xyz")
  })
})

describe("ModelClientAnthropic: response parsing", () => {
  it("parses a stop_reason: tool_use response into ModelTurnToolCalls", async () => {
    const mock = mockHttpFetch(() =>
      jsonResponse(200, {
        content: [
          { type: "text", text: "Let me create that." },
          { type: "tool_use", id: "toolu_01", name: "createNode", input: { title: "New note" } }
        ],
        stop_reason: "tool_use"
      })
    )
    const result = await Effect.runPromise(runConverse(mock.layer, "sk-test", userThread("Create a note")))
    expect(result).toEqual(
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [new ToolCallRequest({ id: "toolu_01", name: "createNode", input: { title: "New note" } })]
      })
    )
  })

  it("parses an end_turn response into ModelTurnFinalText, concatenating multiple text blocks", async () => {
    const mock = mockHttpFetch(() =>
      jsonResponse(200, {
        content: [{ type: "text", text: "Part one. " }, { type: "text", text: "Part two." }],
        stop_reason: "end_turn"
      })
    )
    const result = await Effect.runPromise(runConverse(mock.layer, "sk-test", userThread("Explain")))
    expect(result).toEqual(new ModelTurnFinalText({ kind: "final_text", text: "Part one. Part two." }))
  })

  it("tolerates unrecognized content-block types (e.g. thinking) without failing", async () => {
    const mock = mockHttpFetch(() =>
      jsonResponse(200, {
        content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "Answer." }],
        stop_reason: "end_turn"
      })
    )
    const result = await Effect.runPromise(runConverse(mock.layer, "sk-test", userThread("hi")))
    expect(result).toEqual(new ModelTurnFinalText({ kind: "final_text", text: "Answer." }))
  })

  it("fails with ModelRequestFailed on a non-2xx HTTP status", async () => {
    const mock = mockHttpFetch(() => new Response("rate limited", { status: 429 }))
    const exit = await Effect.runPromiseExit(runConverse(mock.layer, "sk-test", userThread("hi")))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("ModelRequestFailed")
      expect((exit.cause.error as { status?: number }).status).toBe(429)
    }
  })

  it("fails with ModelResponseInvalid on malformed JSON", async () => {
    const mock = mockHttpFetch(() => new Response("not json{{{", { status: 200 }))
    const exit = await Effect.runPromiseExit(runConverse(mock.layer, "sk-test", userThread("hi")))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("ModelResponseInvalid")
    }
  })

  it("fails with ModelResponseInvalid when the envelope shape doesn't match", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { unexpected: true }))
    const exit = await Effect.runPromiseExit(runConverse(mock.layer, "sk-test", userThread("hi")))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("ModelResponseInvalid")
    }
  })

  it("fails with ModelResponseInvalid when stop_reason is tool_use but no tool_use blocks are present", async () => {
    const mock = mockHttpFetch(() =>
      jsonResponse(200, { content: [{ type: "text", text: "oops" }], stop_reason: "tool_use" })
    )
    const exit = await Effect.runPromiseExit(runConverse(mock.layer, "sk-test", userThread("hi")))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("ModelResponseInvalid")
    }
  })
})
