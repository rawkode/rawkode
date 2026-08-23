import { describe, expect, it } from "vitest"
import { WORKSPACE_MUTATION_ROUTING } from "../src/mutation-routing-manifest.js"

describe("Workspace mutation routing manifest", () => {
  it("keeps only createNode on the transitional ledger", () => {
    // The registry is the checked-in source-authoritative inventory; its explicit direct entries
    // make any new mutation routing decision reviewable rather than silently inheriting a claim.
    expect(Object.keys(WORKSPACE_MUTATION_ROUTING)).toContain("appRunHttp")
    expect(WORKSPACE_MUTATION_ROUTING.createNode).toBe("ledger")
    expect(Object.entries(WORKSPACE_MUTATION_ROUTING).filter(([, route]) => route === "ledger")).toEqual([["createNode", "ledger"]])
  })
})
