// THROWAWAY empirical spike for rich-text-editor-decisions.md item 3 ("Sync protocol
// compatibility — EMPIRICAL"). Not a permanent regression suite addition — proves, against the
// REAL WorkspaceDurableObject / NotesService / startPageSync / pageSyncMessage RPCs (unchanged
// this pass), that a document containing real block markers (A.splitBlock — the same primitive
// @automerge/prosemirror's traversal.ts drives) and an inline mark (A.mark) syncs, persists, and
// round-trips correctly through the existing session-sync protocol, with ZERO changes to
// notes-service-live.ts or the wire protocol. The backend never inspects doc contents beyond the
// single top-level "text" key — this test is the empirical proof of that opacity claim, not just
// an assertion.

import { afterEach, describe, expect, it } from "vitest"
import * as Automerge from "@automerge/automerge"
import * as Schema from "effect/Schema"
import {
  CreateNodeOutput,
  CreateNodeInput,
  CreatePageInput,
  GetPageTextInput,
  GetPageTextOutput,
  StartPageSyncInput,
  StartPageSyncOutput,
  PageSyncMessageInput,
  PageSyncMessageOutput,
  type EntityId
} from "@athenaeum/domain"
import { connectToWorkspace, freshWorkspaceId } from "./support.js"

describe("rich-text-editor-decisions item 3: sync protocol is schema-agnostic (empirical)", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined

  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("a document with block markers + marks syncs through the unmodified startPageSync/pageSyncMessage protocol and persists correctly", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Rich note" })))
    ).node
    await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id })))

    const sessionId = "rich-text-spike-session"
    // Same discipline as automerge-page.ts's emptyPageDoc(): Automerge.init(), never .from() —
    // avoids the independent-genesis LWW bug this codebase already found/fixed once.
    let doc = Automerge.init<{ text: string }>()

    const syncOnce = async (): Promise<void> => {
      const started = Schema.decodeUnknownSync(StartPageSyncOutput)(
        await workspaceStub!.startPageSync(
          Schema.encodeSync(StartPageSyncInput)(new StartPageSyncInput({ workspaceId, nodeId: node.id, sessionId }))
        )
      )
      let syncState = Automerge.initSyncState()
      let serverMessage = started.message
      let ordinal = 0
      for (let i = 0; i < 10; i++) {
        if (serverMessage !== null) {
          const [nextDoc, nextState] = Automerge.receiveSyncMessage(doc, syncState, serverMessage)
          doc = nextDoc
          syncState = nextState
        }
        const [afterGen, outMessage] = Automerge.generateSyncMessage(doc, syncState)
        syncState = afterGen
        if (outMessage === null) break
        const response = Schema.decodeUnknownSync(PageSyncMessageOutput)(
          await workspaceStub!.pageSyncMessage(
            Schema.encodeSync(PageSyncMessageInput)(
              new PageSyncMessageInput({ workspaceId, nodeId: node.id, sessionId, ordinal, message: outMessage })
            )
          )
        )
        expect(response.reset).toBe(false)
        ordinal += 1
        serverMessage = response.message
        if (response.converged && serverMessage === null) break
      }
    }

    // Pull down the server's genesis empty doc first (same order every real client uses).
    await syncOnce()

    // Build real rich content: heading + paragraph-with-bold-mark, via the exact primitives
    // @automerge/prosemirror's traversal.ts drives (A.splitBlock / A.mark), not a simplification.
    doc = Automerge.change(doc, (d) => {
      Automerge.splice(d, ["text"], 0, 0, "Heading OneBody text with emphasis.")
    })
    doc = Automerge.change(doc, (d) => {
      Automerge.splitBlock(d, ["text"], 0, {
        type: new Automerge.ImmutableString("heading"),
        parents: [],
        attrs: { level: 1 },
        isEmbed: false
      })
    })
    doc = Automerge.change(doc, (d) => {
      // index 12 = 1 (marker) + "Heading One".length (11)
      Automerge.splitBlock(d, ["text"], 12, {
        type: new Automerge.ImmutableString("paragraph"),
        parents: [],
        attrs: {},
        isEmbed: false
      })
    })
    doc = Automerge.change(doc, (d) => {
      // "emphasis" starts at: 1 + 11 + 1 + "Body text with ".length(15) = 28
      Automerge.mark(d, ["text"], { start: 28, end: 36, expand: "none" }, "em", true)
    })

    await syncOnce()

    // 1. The server accepted and persisted this — proven via a completely independent read path
    //    (getPageText), not just the client's own post-sync `doc`.
    const fetched = Schema.decodeUnknownSync(GetPageTextOutput)(
      await workspaceStub.getPageText(Schema.encodeSync(GetPageTextInput)(new GetPageTextInput({ workspaceId, nodeId: node.id })))
    )
    // The server's own getPageText reads via `doc.text` (notes-service-live.ts's loadDoc + plain
    // `doc.text` property) — the SAME flat-with-U+FFFC-markers representation the native
    // empirical test (RichTextCompatTests.swift) found. This confirms the backend really is fully
    // schema-agnostic: it never validates, rejects, or reinterprets the block markers/marks, it
    // just stores and relays the opaque Automerge ops.
    expect(fetched.text).toContain("\u{FFFC}Heading One");
    expect(fetched.text).toContain("Body text with emphasis.");

    // 2. A second, completely independent sync session (simulating a reload) pulls the exact same
    //    rich content back down through the real protocol from scratch.
    const reloadSessionId = "rich-text-spike-reload"
    let reloadDoc = Automerge.init<{ text: string }>()
    let reloadSyncState = Automerge.initSyncState()
    const startedReload = Schema.decodeUnknownSync(StartPageSyncOutput)(
      await workspaceStub.startPageSync(
        Schema.encodeSync(StartPageSyncInput)(new StartPageSyncInput({ workspaceId, nodeId: node.id, sessionId: reloadSessionId }))
      )
    )
    let reloadServerMessage = startedReload.message
    let reloadOrdinal = 0
    for (let i = 0; i < 10; i++) {
      if (reloadServerMessage !== null) {
        const [nextDoc, nextState] = Automerge.receiveSyncMessage(reloadDoc, reloadSyncState, reloadServerMessage)
        reloadDoc = nextDoc
        reloadSyncState = nextState
      }
      const [afterGen, outMessage] = Automerge.generateSyncMessage(reloadDoc, reloadSyncState)
      reloadSyncState = afterGen
      if (outMessage === null) break
      const response = Schema.decodeUnknownSync(PageSyncMessageOutput)(
        await workspaceStub.pageSyncMessage(
          Schema.encodeSync(PageSyncMessageInput)(
            new PageSyncMessageInput({ workspaceId, nodeId: node.id, sessionId: reloadSessionId, ordinal: reloadOrdinal, message: outMessage })
          )
        )
      )
      expect(response.reset).toBe(false)
      reloadOrdinal += 1
      reloadServerMessage = response.message
      if (response.converged && reloadServerMessage === null) break
    }

    // 3. Verify the reloaded doc's real rich structure (block markers + mark) survived the round
    //    trip bit-for-bit at the CRDT level, using A.spans — not just the flat text.
    const reloadSpans = Automerge.spans(reloadDoc, ["text"])
    const headingSpan = reloadSpans.find(
      (s): s is Extract<typeof s, { type: "block" }> => s.type === "block" && String(s.value.type) === "heading"
    )
    expect(headingSpan).toBeDefined()
    expect(headingSpan?.value.attrs).toEqual({ level: 1 })

    const markedSpan = reloadSpans.find((s) => s.type === "text" && s.value === "emphasis" && s.marks?.em === true)
    expect(markedSpan).toBeDefined()
  })
})
