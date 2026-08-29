import { describe, expect, it } from "vitest"
import { MUTATION_INGRESS_REGISTRY, SERVICE_WRITE_SINKS, WORKSPACE_MUTATION_ROUTING } from "../src/mutation-routing-manifest.js"
import { REQUIRED_MUTATION_DISCOVERY_ADAPTERS } from "../src/mutation-ingress-policy-fixtures.js"
import { assertKnownDirectWriteSinks, assertNoUnknownWorkerEntrypoints } from "../scripts/mutation-ingress-discovery.mjs"

describe("Workspace mutation routing manifest", () => {
  it("records every ledger-routed mutation explicitly", () => {
    // The registry is the checked-in source-authoritative inventory; its explicit direct entries
    // make any new mutation routing decision reviewable rather than silently inheriting a claim.
    expect(Object.keys(WORKSPACE_MUTATION_ROUTING)).toContain("appRunHttp")
    expect(WORKSPACE_MUTATION_ROUTING.createNode).toBe("ledger")
    expect(WORKSPACE_MUTATION_ROUTING.migrateLegacyPage).toBe("ledger")
    expect(WORKSPACE_MUTATION_ROUTING).not.toHaveProperty("activateLoroPage")
    expect(WORKSPACE_MUTATION_ROUTING.commitLoroPageContent).toBe("ledger")
    expect(WORKSPACE_MUTATION_ROUTING.startLoroPageSync).toBe("direct")
    expect(WORKSPACE_MUTATION_ROUTING.loroPageSyncMessage).toBe("direct")
    expect(Object.entries(WORKSPACE_MUTATION_ROUTING).filter(([, route]) => route === "ledger")).toEqual([
      ["createNode", "ledger"], ["createNodeWithIntent", "ledger"], ["createLoroPage", "ledger"], ["acceptChatFork", "ledger"], ["acceptPageProposal", "ledger"],
      ["addFact", "ledger"], ["createRelationDefinition", "ledger"], ["createEdge", "ledger"], ["createTag", "ledger"], ["syncNoteReferences", "ledger"], ["assignTag", "ledger"], ["unassignTag", "ledger"], ["defineTagField", "ledger"],
      ["applySupertag", "ledger"], ["decideAgentChangeProposal", "ledger"], ["migrateLegacyPage", "ledger"], ["commitLoroPageContent", "ledger"], ["prepareMeetingInDailyNote", "ledger"], ["createBookmark", "ledger"], ["startMeeting", "ledger"], ["appendTranscriptSegment", "ledger"]
    ])
  })
  it("is a fail-closed inventory with no permanent semantic bypass", () => {
    expect(new Set(MUTATION_INGRESS_REGISTRY.map((entry) => entry.adapter))).toEqual(new Set(REQUIRED_MUTATION_DISCOVERY_ADAPTERS))
    for (const entry of MUTATION_INGRESS_REGISTRY) {
      if (entry.stateEffect === "semantic-mutation" && entry.disposition !== "strict") {
        expect(entry.migration).toBe("NLE-01")
        expect(entry.sunset).toBe("2026-12-31")
      }
    }
  })
  it("has one stable service-sink row for every discovered write boundary", () => {
    for (const symbol of SERVICE_WRITE_SINKS) {
      expect(MUTATION_INGRESS_REGISTRY.filter((entry) => entry.id === `service-sink:${symbol}`)).toHaveLength(1)
    }
    expect(() => {
      const unknown = "FutureQueueEntrypoint"
      if (!SERVICE_WRITE_SINKS.includes(unknown as never)) throw new Error(`unmapped service write sink: ${unknown}`)
    }).toThrow(/unmapped service write sink/)
  })
  it("fails closed for future Worker entrypoint kinds", () => {
    for (const kind of ["queue", "email", "tail", "websocket"]) {
      expect(() => assertNoUnknownWorkerEntrypoints(`export default {\n  async ${kind}() {}\n}`)).toThrow(`unknown Worker entrypoint kind: ${kind}`)
      expect(() => assertNoUnknownWorkerEntrypoints(`export default { async ["${kind}"]() {} }`)).toThrow(`unknown Worker entrypoint kind: ${kind}`)
      expect(() => assertNoUnknownWorkerEntrypoints(`export default { ${kind}: async () => {} }`)).toThrow(`unknown Worker entrypoint kind: ${kind}`)
    }
  })
  it("requires one static default Worker fetch handler", () => {
    for (const source of ["const worker = { async fetch() {} }; export default worker", "export default { ...base, async fetch() {} }", "export default {}", "export default { async fetch() {}, fetch: async () => {} }"]) expect(() => assertNoUnknownWorkerEntrypoints(source)).toThrow()
    expect(() => assertNoUnknownWorkerEntrypoints("export default { async fetch() {} }")).not.toThrow()
  })
  it("records every idempotent bootstrap root as named system initialization", () => {
    for (const symbol of ["ensureBaseTagsSeeded", "ensureBaseTagFieldsSeeded", "ensureMentionRelationSeeded", "ensureWorkoutTagsSeeded", "WorkspaceDurableObject.initializeOwner"]) {
      expect(MUTATION_INGRESS_REGISTRY).toContainEqual(expect.objectContaining({ id: `bootstrap:${symbol}`, disposition: "system-bootstrap", actorContext: "system" }))
    }
  })
  it("fails closed for nested direct writers and future repositories", () => {
    expect(() => assertKnownDirectWriteSinks({ "future-repository-live.ts": "collections.nodes.put(row)" }, [])).toThrow(/future-repository-live/)
    expect(() => assertKnownDirectWriteSinks({ "future-repository-live.ts": "sql.exec('delete')" }, ["other.ts"])).toThrow(/future-repository-live/)
    for (const source of ["db.prepare(query).run()", "repository.save(row)", "tx.put(key, value)"]) expect(() => assertKnownDirectWriteSinks({ "future-repository-live.ts": source }, [])).toThrow(/future-repository-live/)
    assertKnownDirectWriteSinks({ "future-repository-live.ts": "// db.prepare(query).run()\nconst note = 'repository.save(row)'" }, [])
  })
})
