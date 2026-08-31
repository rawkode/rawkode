import { describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import { Chat, ChatMessageRecord } from "./chat.js"
import { GetChatReviewOutput } from "./agent-edit-rpc.js"

const chatId = "00000000-0000-4000-8000-000000000001"

describe("GetChatReviewOutput", () => {
  it("requires a coherent transcript and fixed-width independent witnesses", () => {
    const value = {
      chat: new Chat({ id: chatId as never, workspaceId: chatId as never, title: "Review", createdAt: "2026-08-31T00:00:00.000Z" as never }),
      messages: [new ChatMessageRecord({ id: "00000000-0000-4000-8000-000000000002" as never, chatId: chatId as never, role: "assistant", content: "Done", sequence: 0 })],
      items: [{ lane: "structured", kind: "unresolved", sequence: 0, label: "Unresolved relationship endpoint", stamped: false, targetAvailable: false, actionable: false }],
      witness: "a".repeat(64),
      noteForkWitness: "b".repeat(64),
      structuredForks: { total: 0, shown: 0, truncated: false, unavailable: 0 },
      legacyForks: { total: 0, shown: 0, truncated: false, unavailable: 0 }
    }
    expect(Schema.decodeUnknownSync(GetChatReviewOutput)(value)).toMatchObject(value)
    expect(Schema.decodeUnknownEither(GetChatReviewOutput)({ ...value, witness: "short" })._tag).toBe("Left")
  })
})
