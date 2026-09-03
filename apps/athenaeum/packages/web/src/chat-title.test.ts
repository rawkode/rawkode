import { describe, expect, it } from "vitest"
import { chatTitleFromMessage } from "./chat-title.js"

describe("chatTitleFromMessage", () => {
  it("normalizes whitespace without changing a short prompt", () => {
    expect(chatTitleFromMessage("  Prepare   the standup\nfor tomorrow  ")).toBe(
      "Prepare the standup for tomorrow"
    )
  })

  it("truncates long prompts to a readable title", () => {
    const title = chatTitleFromMessage("A".repeat(200))
    expect(title).toHaveLength(48)
    expect(title.endsWith("…")).toBe(true)
  })

  it("provides a valid fallback for an empty prompt", () => {
    expect(chatTitleFromMessage(" \n\t ")).toBe("New chat")
  })
})
