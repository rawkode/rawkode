// Empirical probe for whether `@automerge/automerge` (the plan's chosen CRDT — plan §"Storage &
// domain model": "CRDT choice: Automerge... not Yjs") actually runs inside `workerd`, following
// the exact same discipline as `fts-probe-durable-object.ts`'s FTS5 probe: a real capability
// check run against the real runtime this app deploys to, not asserted from package.json
// metadata alone. `@automerge/automerge@3.4.1`'s package.json declares a `workerd` export
// condition (`dist/mjs/entrypoints/fullfat_workerd.js`, which `initSync`s a bundled `.wasm`
// module synchronously at import time) — this probe confirms that condition is actually picked
// up and actually works under `@cloudflare/vitest-pool-workers`, not just that the package claims
// to support it.
//
// Deliberately a standalone scratch DO (mirrors the FTS5 probe's own rationale) — kept as a
// permanent, cheap regression test guarding against a future Workers-platform/Automerge-version
// regression of this capability.

import { DurableObject } from "cloudflare:workers"
import * as Automerge from "@automerge/automerge"
import type { Env } from "./index.js"

export interface AutomergeProbeResult {
  readonly supported: true
  readonly mergedText: string
}

export type AutomergeProbeOutcome = AutomergeProbeResult | { readonly supported: false; readonly error: string }

export class AutomergeProbeDurableObject extends DurableObject<Env> {
  /**
   * Creates two independent Automerge documents (simulating two offline replicas), makes
   * concurrent, non-conflicting edits to a shared `Text` object on each, merges them, and returns
   * the merged text plus the binary-round-trip size — proof the WASM module actually initialized
   * and real CRDT merge semantics work, not just that the import resolved.
   */
  async probeAutomerge(): Promise<AutomergeProbeOutcome> {
    try {
      type Doc = { text: string }
      let docA = Automerge.from<Doc>({ text: "Hello " })
      let docB = Automerge.merge(Automerge.init<Doc>(), docA)

      docA = Automerge.change(docA, (draft) => {
        Automerge.splice(draft, ["text"], draft.text.length, 0, "world")
      })
      docB = Automerge.change(docB, (draft) => {
        Automerge.splice(draft, ["text"], 0, 0, "Say: ")
      })

      const merged = Automerge.merge(docA, docB)
      const bytes = Automerge.save(merged)
      const reloaded = Automerge.load<Doc>(bytes)

      return { supported: true, mergedText: reloaded.text }
    } catch (error) {
      return { supported: false, error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) }
    }
  }
}
