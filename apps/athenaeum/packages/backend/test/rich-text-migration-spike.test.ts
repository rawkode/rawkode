// THROWAWAY empirical spike for rich-text-editor-decisions.md item 4 ("Migration / backward-compat
// story for EXISTING plain-text notes"). Uses the real backend end-to-end (real
// WorkspaceDurableObject, real NotesService, real startPageSync/pageSyncMessage sync protocol,
// real DO SQLite persistence) to reconstruct an "existing Phase 0-7 flat-text note" via the exact
// unmodified `createNode`/`createPage`/`applyPageEdit` RPC sequence real Phase 0-7 clients used —
// then proves the migration story: wrap the existing flat text as one paragraph block, applied as
// ONE real Automerge change on the SAME already-synced doc (never a fresh `Automerge.from()`
// genesis), pushed back through the real sync protocol, and confirmed preserved + structurally
// upgraded from a totally independent reload session.
//
// (Local `.wrangler/state` dev data was also inspected for a literal pre-existing note to migrate
// against; the one node found there — "Daily Note — 2026-08-21" under workspace
// 036d3a5b-3f13-a0d4-96e9-14279f2dec15 — turned out to be test-fixture-originated (owned by
// collab-test@example.com, a sharing-test fixture email), not organic personal usage, so it is not
// a more authoritative source than reconstructing the identical real code path here.)

import { afterEach, describe, expect, it } from "vitest"
import * as Automerge from "@automerge/automerge"
import * as Schema from "effect/Schema"
import {
  CreateNodeOutput,
  CreateNodeInput,
  CreatePageInput,
  CreatePageOutput,
  ApplyPageEditInput,
  ApplyPageEditOutput,
  GetPageTextInput,
  GetPageTextOutput,
  StartPageSyncInput,
  StartPageSyncOutput,
  PageSyncMessageInput,
  PageSyncMessageOutput,
  type EntityId
} from "@athenaeum/domain"
import { connectToWorkspace, freshWorkspaceId } from "./support.js"

describe("rich-text-editor-decisions item 4: migrating an existing flat-Text note to rich structure", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined

  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("wraps existing flat text as one paragraph block via a single real Automerge change, preserving content and causal history", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    // --- Step 1: reconstruct "an existing Phase 0-7 note" via the exact unmodified code path
    // every real note so far has gone through — createNode -> createPage -> applyPageEdit.
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Existing daily note" })))
    ).node
    await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id })))
    const afterEdit = Schema.decodeUnknownSync(ApplyPageEditOutput)(
      await workspaceStub.applyPageEdit(
        Schema.encodeSync(ApplyPageEditInput)(
          new ApplyPageEditInput({
            workspaceId,
            nodeId: node.id,
            index: 0,
            deleteCount: 0,
            insertText: "Standup notes: shipped the rich text decisions doc. Talked to David about scope."
          })
        )
      )
    )
    expect(afterEdit.text).toBe("Standup notes: shipped the rich text decisions doc. Talked to David about scope.")
    const originalText = afterEdit.text

    // --- Step 2: a client resolves this existing note the normal way — a real sync session pull.
    const resolveSessionId = "migration-resolve"
    let doc = Automerge.init<{ text: string }>()
    const syncOnce = async (session: string): Promise<void> => {
      const started = Schema.decodeUnknownSync(StartPageSyncOutput)(
        await workspaceStub!.startPageSync(
          Schema.encodeSync(StartPageSyncInput)(new StartPageSyncInput({ workspaceId, nodeId: node.id, sessionId: session }))
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
              new PageSyncMessageInput({ workspaceId, nodeId: node.id, sessionId: session, ordinal, message: outMessage })
            )
          )
        )
        expect(response.reset).toBe(false)
        ordinal += 1
        serverMessage = response.message
        if (response.converged && serverMessage === null) break
      }
    }
    await syncOnce(resolveSessionId)
    expect(doc.text).toBe(originalText)
    const headsBeforeMigration = Automerge.getHeads(doc).slice().sort()
    const changeCountBeforeMigration = Automerge.getAllChanges(doc).length

    // --- Step 3: THE MIGRATION. Exactly one real Automerge change, in place on the same doc —
    // never Automerge.from({text: originalText}), which would be an independent genesis under a
    // fresh actor id with no causal link to the server's real history (the exact bug class
    // automerge-page.ts's emptyPageDoc() doc comment documents and this codebase already fixed
    // once for the analogous "fresh replica on reload" case).
    doc = Automerge.change(doc, (d) => {
      Automerge.splitBlock(d, ["text"], 0, {
        type: new Automerge.ImmutableString("paragraph"),
        parents: [],
        attrs: {},
        isEmbed: false
      })
    })

    await syncOnce("migration-push")

    // --- Step 4: an INDEPENDENT reload (fresh empty replica, fresh session id — a different
    // "device"/tab entirely) confirms the migration is durably stored server-side, not just a
    // client-local artifact of this one in-memory doc.
    let reloadDoc = Automerge.init<{ text: string }>()
    doc = reloadDoc // reuse syncOnce's closure over `doc`
    await syncOnce("migration-reload")
    reloadDoc = doc

    // Content preserved exactly, module the one new block-marker glyph the flat `.text` reader
    // shows (see rich-text-editor-decisions.md item 2's native findings for what that glyph is).
    expect(reloadDoc.text.replace(/\u{FFFC}/gu, "")).toBe(originalText)

    // Real block structure now exists.
    const spans = Automerge.spans(reloadDoc, ["text"])
    expect(spans[0]).toMatchObject({ type: "block", value: { type: expect.anything() } })
    expect(String((spans[0] as { type: "block"; value: { type: unknown } }).value.type)).toBe("paragraph")
    const textSpan = spans.find((s) => s.type === "text")
    expect(textSpan && "value" in textSpan ? textSpan.value : undefined).toBe(originalText)

    // Causal history is a real EXTENSION of the pre-migration history, not a replacement: every
    // pre-migration change hash is still present, plus exactly one more (the splitBlock change).
    const changesAfter = Automerge.getAllChanges(reloadDoc)
    expect(changesAfter.length).toBe(changeCountBeforeMigration + 1)
    const hashesAfter = new Set(changesAfter.map((c) => Automerge.decodeChange(c).hash))
    for (const head of headsBeforeMigration) {
      // Every pre-migration head is now an ancestor change still present in history (not pruned,
      // not replaced) — the concrete meaning of "in-place evolution of the same causal history".
      expect(hashesAfter.has(head)).toBe(true)
    }

    // Also verify via getPageText — an independent, non-Automerge-object read path — for good
    // measure, matching this file's sibling spike's discipline.
    const fetched = Schema.decodeUnknownSync(GetPageTextOutput)(
      await workspaceStub.getPageText(Schema.encodeSync(GetPageTextInput)(new GetPageTextInput({ workspaceId, nodeId: node.id })))
    )
    expect(fetched.text.replace(/\u{FFFC}/gu, "")).toBe(originalText)
  })
})
