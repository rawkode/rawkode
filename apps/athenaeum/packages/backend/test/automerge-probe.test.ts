// Empirical resolution of whether `@automerge/automerge` actually runs under real `workerd`
// (via `@cloudflare/vitest-pool-workers`, the same runner every other suite in this package
// uses) — not asserted from the package's `workerd` export-condition metadata alone. See
// `automerge-probe-durable-object.ts`'s doc comment.

import { exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

describe("Automerge support inside workerd (Phase 1 CRDT note-body storage prerequisite)", () => {
  it("initializes the WASM module and merges two concurrently-edited Text documents", async () => {
    const probeId = exports.AutomergeProbeDurableObject.newUniqueId()
    const stub = exports.AutomergeProbeDurableObject.get(probeId)

    const result = await stub.probeAutomerge()

    if (!result.supported) {
      throw new Error(
        `@automerge/automerge is NOT usable inside workerd — error: ${result.error}\n` +
          `This would block the plan's "Automerge note-body storage" requirement entirely.`
      )
    }

    // docA inserted "world" at the end, docB inserted "Say: " at the start, of the shared
    // "Hello " seed text — a real CRDT merge (not string concatenation) produces exactly this.
    expect(result.mergedText).toBe("Say: Hello world")
  })
})
