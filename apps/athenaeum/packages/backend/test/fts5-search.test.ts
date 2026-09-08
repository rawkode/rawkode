// Empirical resolution of the plan's flagged Phase 1 blocker (plan §"Full-text search": "confirm:
// (a) whether Cloudflare's DO SQLite driver supports FTS5 virtual tables (unconfirmed as of this
// plan)"; risk #5). Runs against a real `workerd` DO instance's real `storage.sql` (via
// `vitest-pool-workers`, the same runner every other suite in this package uses) — not mocked, not
// asserted from documentation.
//
// Kept as a permanent regression test (see `fts-probe-durable-object.ts`'s doc comment for why),
// not deleted after the initial empirical run.

import { exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

describe("DO SQLite FTS5 support (plan risk #5 / Full-text search blocker)", () => {
  it("creates an FTS5 virtual table, inserts rows, and MATCHes real results", async () => {
    const probeId = exports.FtsSearchProbeDurableObject.newUniqueId()
    const stub = exports.FtsSearchProbeDurableObject.get(probeId)

    const result = await stub.probeFts5()

    if (!result.supported) {
      throw new Error(
        `FTS5 is NOT supported on DO SQLite — driver error: ${result.error}\n` +
          `This confirms the plan's fallback branch (b): defer real full-text search, or (a): ` +
          `plain LIKE/substring search as a documented v1 gap.`
      )
    }

    // The MATCH query searched for "Athenaeum" — only the first inserted row contains it, so a
    // real, working FTS5 index returns exactly that row and not the unrelated grocery-list row.
    expect(result.matches).toEqual([
      {
        title: "Daily note 2026-08-20",
        body: "Resolved the FTS5 blocker for Athenaeum's Phase 1 Views+Search stage."
      }
    ])
  })
})
