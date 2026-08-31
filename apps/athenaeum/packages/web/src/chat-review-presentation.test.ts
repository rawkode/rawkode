import { ChatReviewItem, EntityId } from "@athenaeum/domain"
import { describe, expect, it } from "vitest"
import { chatReviewPresentationWitness, isNoteForkReviewItem, visibleReviewLabel } from "./chat-review-presentation.js"

const nodeId = EntityId.make("00000000-0000-4000-8000-000000000001")
const witness = "a".repeat(64)
const noteForkWitness = "b".repeat(64)

describe("chat review presentation", () => {
  it("uses only the server-resolved label and treats a fork as a separate review lane", () => {
    const change = new ChatReviewItem({ lane: "structured", kind: "fact", sequence: 3, label: "Set \"Role\" on \"Avery\"", nodeId, stamped: true, targetAvailable: true, actionable: true })
    const fork = new ChatReviewItem({
      lane: "legacy-fork", kind: "node", sequence: 4, label: "Edited \"Daily note\"", nodeId, stamped: true, targetAvailable: true, actionable: true, forkPreviewLines: ["A safe proposed note body"]
    })
    const hiddenFork = new ChatReviewItem({
      lane: "legacy-fork", kind: "unresolved", sequence: 0, label: "This note edit’s target is unavailable.", stamped: true, targetAvailable: false, actionable: false
    })

    expect(visibleReviewLabel(change)).toBe('Set "Role" on "Avery"')
    expect(isNoteForkReviewItem(change)).toBe(false)
    expect(isNoteForkReviewItem(fork)).toBe(true)
    expect(isNoteForkReviewItem(hiddenFork)).toBe(true)
    expect(visibleReviewLabel({ ...change, label: "   " })).toBe("A pending change has unavailable details.")
  })

  it("makes the complete ordered response a canonical SHA-256 witness", () => {
    const items = [new ChatReviewItem({ lane: "structured", kind: "node", sequence: 2, label: "Created \"Avery\"", nodeId, stamped: true, targetAvailable: true, actionable: true })]
    const input = { chatId: nodeId, witness, noteForkWitness, items }
    const first = chatReviewPresentationWitness(input)

    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(chatReviewPresentationWitness({ ...input, items: [...items] })).toBe(first)
    expect(chatReviewPresentationWitness({ ...input, items: [new ChatReviewItem({ lane: "structured", kind: "node", sequence: 3, label: "Created \"Avery\"", nodeId, stamped: true, targetAvailable: true, actionable: true })] })).not.toBe(first)
    expect(chatReviewPresentationWitness({ ...input, items: [...items].reverse() })).toBe(first)
  })
})
