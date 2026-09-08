// Proves `CloudTranscriptionClientOpenAI`'s request-building and response-parsing logic is
// genuinely correct, by mocking *only* the HTTP layer (`HttpFetch`) — same discipline as
// `model-client-anthropic.test.ts`: real Effect programs run through the real
// `makeCloudTranscriptionClientOpenAILive` implementation end-to-end; only the network call
// inside `HttpFetch.fetch` is a fake. **No real OpenAI API key is used or required.**

import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import { CloudTranscriptionClient, TranscribeAudioInput } from "@athenaeum/domain"
import { HttpFetch } from "../src/model-client-anthropic.js"
import { makeCloudTranscriptionClientOpenAILive } from "../src/cloud-transcription-client-openai.js"
import type { AiGatewayRoute } from "../src/ai-gateway-route.js"

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

const sampleInput = (overrides: Partial<{ languageHint: string }> = {}) =>
  new TranscribeAudioInput({
    audio: new Uint8Array([1, 2, 3, 4, 5]),
    mimeType: "audio/wav",
    filename: "chunk-0001.wav",
    ...overrides
  })

const runTranscribe = (
  httpLayer: Layer.Layer<HttpFetch>,
  apiKey: string | undefined,
  input: TranscribeAudioInput,
  model?: string,
  gateway?: AiGatewayRoute
) =>
  Effect.gen(function* () {
    const client = yield* CloudTranscriptionClient
    return yield* client.transcribe(input)
  }).pipe(
    Effect.provide(
      makeCloudTranscriptionClientOpenAILive({ apiKey, ...(model ? { model } : {}), gateway }).pipe(Layer.provide(httpLayer))
    )
  )

describe("CloudTranscriptionClientOpenAI: unconfigured (no API key)", () => {
  it("fails with TranscriptionUnavailable without ever calling fetch", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { text: "hi" }))
    const exit = await Effect.runPromiseExit(runTranscribe(mock.layer, undefined, sampleInput()))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("TranscriptionUnavailable")
    }
    expect(mock.calls).toHaveLength(0)
  })

  it("also fails cleanly on an empty-string key, not just undefined", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { text: "hi" }))
    const exit = await Effect.runPromiseExit(runTranscribe(mock.layer, "", sampleInput()))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(mock.calls).toHaveLength(0)
  })
})

describe("CloudTranscriptionClientOpenAI: request construction", () => {
  it("sends the correct URL, method, Authorization header, and multipart fields", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { text: "the quick brown fox" }))
    await Effect.runPromise(runTranscribe(mock.layer, "sk-test-key", sampleInput({ languageHint: "en" })))

    expect(mock.calls).toHaveLength(1)
    const call = mock.calls[0]!
    expect(call.url).toBe("https://api.openai.com/v1/audio/transcriptions")
    expect(call.init.method).toBe("POST")
    const headers = call.init.headers as Record<string, string>
    expect(headers["Authorization"]).toBe("Bearer sk-test-key")
    // Deliberately NOT asserting a content-type header here: FormData bodies must carry the
    // runtime-generated multipart boundary in their own content-type, which this client never
    // sets manually (setting one by hand would omit/mismatch the boundary and break every real
    // multipart parse) — see the implementation's own comment on this.
    expect(headers["content-type"]).toBeUndefined()

    const form = call.init.body as FormData
    expect(form.get("model")).toBe("whisper-1")
    expect(form.get("response_format")).toBe("verbose_json")
    expect(form.get("language")).toBe("en")
    const file = form.get("file") as File
    expect(file.name).toBe("chunk-0001.wav")
    expect(file.type).toBe("audio/wav")
    const bytes = new Uint8Array(await file.arrayBuffer())
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5])
  })

  it("omits the language field entirely when no languageHint is given", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { text: "hi" }))
    await Effect.runPromise(runTranscribe(mock.layer, "sk-test-key", sampleInput()))
    const form = mock.calls[0]!.init.body as FormData
    expect(form.get("language")).toBeNull()
  })

  it("respects a configured model override", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { text: "hi" }))
    await Effect.runPromise(runTranscribe(mock.layer, "sk-test-key", sampleInput(), "gpt-4o-transcribe"))
    const form = mock.calls[0]!.init.body as FormData
    expect(form.get("model")).toBe("gpt-4o-transcribe")
  })
})

describe("CloudTranscriptionClientOpenAI: AI Gateway routing", () => {
  it("DIRECT mode (gateway undefined) is unchanged — calls api.openai.com directly", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { text: "hi" }))
    await Effect.runPromise(runTranscribe(mock.layer, "sk-test-key", sampleInput(), undefined, undefined))
    expect(mock.calls[0]!.url).toBe("https://api.openai.com/v1/audio/transcriptions")
    const headers = mock.calls[0]!.init.headers as Record<string, string>
    expect(headers["cf-aig-authorization"]).toBeUndefined()
  })

  it("GATEWAY mode routes through the per-provider passthrough endpoint, Authorization unchanged", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { text: "hi" }))
    const gateway: AiGatewayRoute = { accountId: "acct-123", gatewayName: "my-gateway" }
    await Effect.runPromise(runTranscribe(mock.layer, "sk-test-key", sampleInput(), undefined, gateway))
    expect(mock.calls[0]!.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct-123/my-gateway/openai/audio/transcriptions"
    )
    const headers = mock.calls[0]!.init.headers as Record<string, string>
    expect(headers["Authorization"]).toBe("Bearer sk-test-key")
    expect(headers["cf-aig-authorization"]).toBeUndefined()
  })

  it("GATEWAY mode adds cf-aig-authorization only when an Authenticated Gateway token is configured", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { text: "hi" }))
    const gateway: AiGatewayRoute = { accountId: "acct-123", gatewayName: "my-gateway", authToken: "run-token-xyz" }
    await Effect.runPromise(runTranscribe(mock.layer, "sk-test-key", sampleInput(), undefined, gateway))
    const headers = mock.calls[0]!.init.headers as Record<string, string>
    expect(headers["cf-aig-authorization"]).toBe("Bearer run-token-xyz")
  })
})

describe("CloudTranscriptionClientOpenAI: response parsing", () => {
  it("parses text, segments, and languageDetected from a verbose_json response", async () => {
    const mock = mockHttpFetch(() =>
      jsonResponse(200, {
        text: "the quick brown fox",
        language: "english",
        segments: [
          { id: 0, seek: 0, start: 0, end: 1.2, text: "the quick", tokens: [], temperature: 0, avg_logprob: -0.1, compression_ratio: 1.1, no_speech_prob: 0.01 },
          { id: 1, seek: 0, start: 1.2, end: 2.5, text: " brown fox", tokens: [], temperature: 0, avg_logprob: -0.1, compression_ratio: 1.1, no_speech_prob: 0.01 }
        ]
      })
    )
    const result = await Effect.runPromise(runTranscribe(mock.layer, "sk-test", sampleInput()))
    expect(result.text).toBe("the quick brown fox")
    expect(result.languageDetected).toBe("english")
    expect(result.segments).toHaveLength(2)
    expect(result.segments[0]!.text).toBe("the quick")
    expect(result.segments[0]!.startSeconds).toBe(0)
    expect(result.segments[0]!.endSeconds).toBe(1.2)
  })

  it("tolerates a response with no segments field at all", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { text: "hi" }))
    const result = await Effect.runPromise(runTranscribe(mock.layer, "sk-test", sampleInput()))
    expect(result.text).toBe("hi")
    expect(result.segments).toEqual([])
    expect(result.languageDetected).toBeUndefined()
  })

  it("fails with TranscriptionRequestFailed on a non-2xx HTTP status", async () => {
    const mock = mockHttpFetch(() => new Response("invalid_api_key", { status: 401 }))
    const exit = await Effect.runPromiseExit(runTranscribe(mock.layer, "sk-test", sampleInput()))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("TranscriptionRequestFailed")
      expect((exit.cause.error as { status?: number }).status).toBe(401)
    }
  })

  it("fails with TranscriptionResponseInvalid on malformed JSON", async () => {
    const mock = mockHttpFetch(() => new Response("not json{{{", { status: 200 }))
    const exit = await Effect.runPromiseExit(runTranscribe(mock.layer, "sk-test", sampleInput()))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("TranscriptionResponseInvalid")
    }
  })

  it("fails with TranscriptionResponseInvalid when the envelope shape doesn't match", async () => {
    const mock = mockHttpFetch(() => jsonResponse(200, { unexpected: true }))
    const exit = await Effect.runPromiseExit(runTranscribe(mock.layer, "sk-test", sampleInput()))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("TranscriptionResponseInvalid")
    }
  })
})
