import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  ChatMessage,
  ChatTextBlock,
  ChatThread,
  ChatToolResultBlock,
  ChatToolUseBlock,
  ModelRequestFailed,
  ModelResponseInvalid,
  ModelTurnFinalText,
  ModelTurnResult,
  ModelTurnToolCalls,
  ModelUnavailable,
  ToolCallRequest,
  ToolSpec
} from "./model-client.js"

describe("ChatThread schema", () => {
  it("round-trips a thread with text, tool_use, and tool_result blocks", () => {
    const thread = new ChatThread({
      systemPrompt: "You are a helpful workspace-editing assistant.",
      messages: [
        new ChatMessage({
          role: "user",
          content: [new ChatTextBlock({ type: "text", text: "Rename this note" })]
        }),
        new ChatMessage({
          role: "assistant",
          content: [
            new ChatToolUseBlock({ type: "tool_use", id: "call-1", name: "renameNote", input: { title: "New title" } })
          ]
        }),
        new ChatMessage({
          role: "user",
          content: [new ChatToolResultBlock({ type: "tool_result", toolUseId: "call-1", content: "ok", isError: false })]
        })
      ]
    })

    const encoded = Schema.encodeSync(ChatThread)(thread)
    expect(Schema.decodeUnknownSync(ChatThread)(encoded)).toEqual(thread)
  })

  it("systemPrompt is optional", () => {
    const thread = new ChatThread({ messages: [] })
    const encoded = Schema.encodeSync(ChatThread)(thread)
    expect(encoded.systemPrompt).toBeUndefined()
    expect(Schema.decodeUnknownSync(ChatThread)(encoded)).toEqual(thread)
  })
})

describe("ToolSpec / ToolCallRequest schemas", () => {
  it("round-trips a JSON-Schema-shaped inputSchema", () => {
    const spec = new ToolSpec({
      name: "createNode",
      description: "Create a new graph node",
      inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }
    })
    const encoded = Schema.encodeSync(ToolSpec)(spec)
    expect(Schema.decodeUnknownSync(ToolSpec)(encoded)).toEqual(spec)
  })

  it("rejects an empty tool name", () => {
    const result = Schema.decodeUnknownEither(ToolSpec)({ name: "", description: "x", inputSchema: {} })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("round-trips a ToolCallRequest", () => {
    const call = new ToolCallRequest({ id: "call-1", name: "createNode", input: { title: "Hello" } })
    const encoded = Schema.encodeSync(ToolCallRequest)(call)
    expect(Schema.decodeUnknownSync(ToolCallRequest)(encoded)).toEqual(call)
  })
})

describe("ModelTurnResult discriminated union", () => {
  it("round-trips a tool_calls turn", () => {
    const turn = new ModelTurnToolCalls({
      kind: "tool_calls",
      calls: [new ToolCallRequest({ id: "call-1", name: "createNode", input: { title: "Hello" } })]
    })
    const encoded = Schema.encodeSync(ModelTurnResult)(turn)
    const decoded = Schema.decodeUnknownSync(ModelTurnResult)(encoded)
    expect(decoded).toEqual(turn)
    expect(decoded.kind).toBe("tool_calls")
  })

  it("round-trips a final_text turn", () => {
    const turn = new ModelTurnFinalText({ kind: "final_text", text: "Done." })
    const encoded = Schema.encodeSync(ModelTurnResult)(turn)
    const decoded = Schema.decodeUnknownSync(ModelTurnResult)(encoded)
    expect(decoded).toEqual(turn)
    expect(decoded.kind).toBe("final_text")
  })

  it("rejects an unrecognized kind", () => {
    const result = Schema.decodeUnknownEither(ModelTurnResult)({ kind: "something_else" })
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("ModelError variants", () => {
  it("are Data.TaggedError instances with the expected _tag", () => {
    expect(new ModelUnavailable({ message: "no API key configured" })._tag).toBe("ModelUnavailable")
    expect(new ModelRequestFailed({ message: "network error", status: 500 })._tag).toBe("ModelRequestFailed")
    expect(new ModelResponseInvalid({ message: "malformed response" })._tag).toBe("ModelResponseInvalid")
  })
})
