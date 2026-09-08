// THROWAWAY empirical spike for rich-text-editor-decisions.md item 4 ("Migration / backward-compat
// story for EXISTING plain-text notes"). Connects to the REAL local `wrangler dev` backend
// (already running on :8787, real persisted .wrangler/state) and operates on the ACTUAL existing
// flat-Text daily note found in local dev data: workspaceId 036d3a5b-3f13-a0d4-96e9-14279f2dec15,
// nodeId 00000000-0000-4000-8000-000020260821 (today's deterministic daily-note id — genuinely
// created by a prior real `wrangler dev` + web app session, not fabricated by this script).
//
// Proves the migration story end-to-end against real backend state: sync the existing flat doc
// down for real, apply the "wrap as one paragraph block" migration as ONE real Automerge change
// (Automerge.splitBlock at index 0), sync it back up for real, then reload from a totally
// independent fresh sync session to confirm (a) the original text content is preserved, (b) the
// doc now has real block structure, (c) this was an in-place evolution of the SAME causal history
// (never Automerge.from() — that would be a fresh, causally-unrelated genesis, exactly the LWW
// data-loss class automerge-page.ts's emptyPageDoc() doc comment already found and fixed once).
//
// Run with bun (native WebSocket global, no `ws` npm dependency needed):
//   bun migrate-real-dev-note.mjs
import * as A from "../../../packages/web/node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_node.js"
import { newWebSocketRpcSession } from "../../../packages/backend/node_modules/capnweb/dist/index.js"

const workspaceId = "036d3a5b-3f13-a0d4-96e9-14279f2dec15"
const nodeId = "00000000-0000-4000-8000-000020260821"

const stub = newWebSocketRpcSession(`ws://localhost:8787/api/workspace/${workspaceId}`)

async function syncOnce(doc, session) {
  let syncState = A.initSyncState()
  const started = await stub.startPageSync({ workspaceId, nodeId, sessionId: session })
  let serverMessage = started.message
  let ordinal = 0
  for (let i = 0; i < 10; i++) {
    if (serverMessage !== null && serverMessage !== undefined) {
      const [nextDoc, nextState] = A.receiveSyncMessage(doc, syncState, serverMessage)
      doc = nextDoc
      syncState = nextState
    }
    const [afterGen, outMessage] = A.generateSyncMessage(doc, syncState)
    syncState = afterGen
    if (outMessage === null) break
    const response = await stub.pageSyncMessage({ workspaceId, nodeId, sessionId: session, ordinal, message: outMessage })
    if (response.reset) throw new Error("unexpected reset — session id collision or server restart")
    ordinal += 1
    serverMessage = response.message
    if (response.converged && (serverMessage === null || serverMessage === undefined)) break
  }
  return doc
}

console.log("Connecting to real local wrangler dev backend and syncing the real existing daily note...")
let doc = A.init()
doc = await syncOnce(doc, "migration-spike-" + Date.now())

const before = doc.text
console.log("=== REAL existing flat-Text daily note content ===")
console.log(JSON.stringify(before))
console.log("=== heads before migration ===", A.getHeads(doc).slice().sort())

// THE MIGRATION: wrap the existing flat text as the content of a single paragraph block, applied
// as ONE real Automerge change on top of the SAME already-synced doc.
doc = A.change(doc, (d) => {
  A.splitBlock(d, ["text"], 0, {
    type: new A.ImmutableString("paragraph"),
    parents: [],
    attrs: {},
    isEmbed: false
  })
})

doc = await syncOnce(doc, "migration-spike-push-" + Date.now())
console.log("=== migration change pushed to real backend ===")

// Independent reload: brand-new empty replica, brand-new session id — exactly what a real client
// reload does.
let reloadDoc = A.init()
reloadDoc = await syncOnce(reloadDoc, "migration-spike-reload-" + Date.now())

const reloadSpans = A.spans(reloadDoc, ["text"])
console.log("=== reloaded spans after migration (independent fresh sync session) ===")
console.log(
  JSON.stringify(reloadSpans, (_k, v) => (v instanceof A.ImmutableString ? { __immutableString: v.toString() } : v), 2)
)

const reloadedFlatText = reloadDoc.text
const originalCharsPreserved = reloadedFlatText.replace(/￼/g, "") === before
console.log("=== original content preserved (ignoring the one new block-marker glyph)? ===", originalCharsPreserved)
console.log("=== heads after migration+reload ===", A.getHeads(reloadDoc).slice().sort())

const allChangeHashes = A.getAllChanges(reloadDoc).map((c) => A.decodeChange(c).hash)
console.log("=== total real changes in this doc's history after migration ===", allChangeHashes.length)

stub[Symbol.dispose]()
