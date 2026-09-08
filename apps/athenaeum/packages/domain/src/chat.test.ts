import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { Chat, ChatMessageRecord } from "./chat.js"
import { ToolCallRequest } from "./model-client.js"
import { EntityId, IsoDateTimeString } from "./node.js"

const validUuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
const validUuid2 = "3fa85f64-5717-4562-b3fc-2c963f66afa7"
const validUuid3 = "3fa85f64-5717-4562-b3fc-2c963f66afa8"
const validIso = "2026-08-20T12:00:00.000Z"

describe("Chat schema", () => {
  it("round-trips encode/decode", () => {
    const chat = new Chat({
      id: EntityId.make(validUuid),
      workspaceId: EntityId.make(validUuid2),
      title: "Planning the roadmap",
      createdAt: IsoDateTimeString.make(validIso)
    })
    const encoded = Schema.encodeSync(Chat)(chat)
    expect(encoded).toEqual({
      id: validUuid,
      workspaceId: validUuid2,
      title: "Planning the roadmap",
      createdAt: validIso
    })
    expect(Schema.decodeUnknownSync(Chat)(encoded)).toEqual(chat)
  })

  it("rejects an empty title", () => {
    const result = Schema.decodeUnknownEither(Chat)({
      id: validUuid,
      workspaceId: validUuid2,
      title: "",
      createdAt: validIso
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("ChatMessageRecord schema", () => {
  it("round-trips a user message with no toolCalls (field omitted, not null)", () => {
    const message = new ChatMessageRecord({
      id: EntityId.make(validUuid),
      chatId: EntityId.make(validUuid2),
      role: "user",
      content: "Create a note about the roadmap",
      sequence: 0
    })
    const encoded = Schema.encodeSync(ChatMessageRecord)(message)
    expect(encoded).toEqual({
      id: validUuid,
      chatId: validUuid2,
      role: "user",
      content: "Create a note about the roadmap",
      sequence: 0
    })
    expect("toolCalls" in encoded).toBe(false)
    expect(Schema.decodeUnknownSync(ChatMessageRecord)(encoded)).toEqual(message)
  })

  it("round-trips an assistant message with toolCalls", () => {
    const message = new ChatMessageRecord({
      id: EntityId.make(validUuid),
      chatId: EntityId.make(validUuid2),
      role: "assistant",
      content: "",
      toolCalls: [new ToolCallRequest({ id: "call_1", name: "createNode", input: { title: "Roadmap" } })],
      sequence: 1
    })
    const encoded = Schema.encodeSync(ChatMessageRecord)(message)
    expect(Schema.decodeUnknownSync(ChatMessageRecord)(encoded)).toEqual(message)
  })

  it("round-trips a tool-role message", () => {
    const message = new ChatMessageRecord({
      id: EntityId.make(validUuid),
      chatId: EntityId.make(validUuid2),
      role: "tool",
      content: "{\"nodeId\":\"" + validUuid3 + "\"}",
      sequence: 2
    })
    const encoded = Schema.encodeSync(ChatMessageRecord)(message)
    expect(Schema.decodeUnknownSync(ChatMessageRecord)(encoded)).toEqual(message)
  })

  it("rejects a role outside user/assistant/tool", () => {
    const result = Schema.decodeUnknownEither(ChatMessageRecord)({
      id: validUuid,
      chatId: validUuid2,
      role: "system",
      content: "nope",
      sequence: 0
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects a negative sequence", () => {
    const result = Schema.decodeUnknownEither(ChatMessageRecord)({
      id: validUuid,
      chatId: validUuid2,
      role: "user",
      content: "x",
      sequence: -1
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})
