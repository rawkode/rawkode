import { describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import { createNodeCommitMessage, normalizeCreateNodeTitle, LedgerCommand } from "./ledger.js"

describe("transitional ledger domain contract", () => {
  it("derives the versioned human message from a normalized title", () => {
    expect(normalizeCreateNodeTitle("  A\n  node  ")).toBe("A node")
    expect(createNodeCommitMessage("  A\n  node  ")).toBe("Create node to record A node.")
  })

  it("rejects malformed immutable command records", () => {
    expect(() => Schema.decodeUnknownSync(LedgerCommand)({ version: "wrong" })).toThrow()
  })
})
