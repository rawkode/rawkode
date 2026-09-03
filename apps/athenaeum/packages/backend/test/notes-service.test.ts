// Storage/Views stage verification: "creating a page and applying edits works and persists"
// (task's own smoke-test checklist) plus "two independent Automerge sync sessions (simulating two
// 'tabs'/reconnects of the same single web client) correctly converge after concurrent local
// edits merge."

import { afterEach, describe, expect, it } from "vitest"
import * as Automerge from "@automerge/automerge"
import * as Schema from "effect/Schema"
import {
  ApplyPageEditOutput,
  CreateNodeOutput,
  CreateNodeInput,
  CreatePageOutput,
  CreatePageInput,
  GetPageTextInput,
  GetPageTextOutput,
  ApplyPageEditInput,
  StartPageSyncInput,
  StartPageSyncOutput,
  PageSyncMessageInput,
  PageSyncMessageOutput,
  type EntityId
} from "@athenaeum/domain"
import { notesServiceSessionCapTestHook } from "../src/notes-service-live.js"
import { pagePersistenceTestHook } from "../src/workspace-durable-object.js"
import { connectToWorkspace, freshWorkspaceId, rejectionToDomainError } from "./support.js"

describe("createPage / getPageText / applyPageEdit: real Automerge persistence", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined

  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("creates an empty page, applies local edits, and the result persists across calls", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Daily note" })))
    ).node

    const created = Schema.decodeUnknownSync(CreatePageOutput)(
      await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id })))
    )
    expect(created.text).toBe("")
    expect(created.page.nodeId).toBe(node.id)

    const afterFirstEdit = Schema.decodeUnknownSync(ApplyPageEditOutput)(
      await workspaceStub.applyPageEdit(
        Schema.encodeSync(ApplyPageEditInput)(
          new ApplyPageEditInput({ workspaceId, nodeId: node.id, index: 0, deleteCount: 0, insertText: "Hello, Athenaeum" })
        )
      )
    )
    expect(afterFirstEdit.text).toBe("Hello, Athenaeum")

    const afterSecondEdit = Schema.decodeUnknownSync(ApplyPageEditOutput)(
      await workspaceStub.applyPageEdit(
        Schema.encodeSync(ApplyPageEditInput)(
          new ApplyPageEditInput({ workspaceId, nodeId: node.id, index: 7, deleteCount: 9, insertText: "world" })
        )
      )
    )
    expect(afterSecondEdit.text).toBe("Hello, world")
    // The heads hash must have actually changed across edits — proof this is real CRDT state
    // advancing, not a static/stubbed value.
    expect(afterSecondEdit.page.headsHash).not.toBe(afterFirstEdit.page.headsHash)

    // Persistence: a fresh RPC call (not relying on any in-request cache) sees the latest text.
    const fetched = Schema.decodeUnknownSync(GetPageTextOutput)(
      await workspaceStub.getPageText(Schema.encodeSync(GetPageTextInput)(new GetPageTextInput({ workspaceId, nodeId: node.id })))
    )
    expect(fetched.text).toBe("Hello, world")
    expect(fetched.page.headsHash).toBe(afterSecondEdit.page.headsHash)
  })

  it("createPage is idempotent: calling it again on an existing page returns the current state, not a fresh empty doc", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Note" })))
    ).node

    await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id })))
    await workspaceStub.applyPageEdit(
      Schema.encodeSync(ApplyPageEditInput)(
        new ApplyPageEditInput({ workspaceId, nodeId: node.id, index: 0, deleteCount: 0, insertText: "already here" })
      )
    )

    const secondCreate = Schema.decodeUnknownSync(CreatePageOutput)(
      await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id })))
    )
    expect(secondCreate.text).toBe("already here")
  })
})

describe("page persistence publication boundaries", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined

  afterEach(() => {
    pagePersistenceTestHook.afterPrepareBeforeCommit = undefined
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("does not publish an Automerge candidate or advance its session when the transaction rolls back", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Rollback note" }))
      )
    ).node
    await workspaceStub.createPage(
      Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id }))
    )

    // Warm the committed empty document into NotesService's cache before preparing the failed
    // write. If the candidate leaked, the read below would incorrectly observe "after rollback".
    const before = Schema.decodeUnknownSync(GetPageTextOutput)(
      await workspaceStub.getPageText(
        Schema.encodeSync(GetPageTextInput)(new GetPageTextInput({ workspaceId, nodeId: node.id }))
      )
    )
    expect(before.text).toBe("")

    pagePersistenceTestHook.afterPrepareBeforeCommit = () => {
      throw new Error("page persistence failpoint")
    }
    const failed = await rejectionToDomainError(
      workspaceStub.applyPageEdit(
        Schema.encodeSync(ApplyPageEditInput)(
          new ApplyPageEditInput({ workspaceId, nodeId: node.id, index: 0, deleteCount: 0, insertText: "after rollback" })
        )
      )
    )
    expect(failed._tag).toBe("UnexpectedError")

    const stillBefore = Schema.decodeUnknownSync(GetPageTextOutput)(
      await workspaceStub.getPageText(
        Schema.encodeSync(GetPageTextInput)(new GetPageTextInput({ workspaceId, nodeId: node.id }))
      )
    )
    expect(stillBefore.text).toBe("")

    pagePersistenceTestHook.afterPrepareBeforeCommit = undefined
    const retried = Schema.decodeUnknownSync(ApplyPageEditOutput)(
      await workspaceStub.applyPageEdit(
        Schema.encodeSync(ApplyPageEditInput)(
          new ApplyPageEditInput({ workspaceId, nodeId: node.id, index: 0, deleteCount: 0, insertText: "after rollback" })
        )
      )
    )
    expect(retried.text).toBe("after rollback")
  })

  it("defers an Automerge reset-session deletion until the transaction succeeds", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Reset note" }))
      )
    ).node
    await workspaceStub.createPage(
      Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id }))
    )
    const sessionId = "page-reset-rollback"
    await workspaceStub.startPageSync(
      Schema.encodeSync(StartPageSyncInput)(new StartPageSyncInput({ workspaceId, nodeId: node.id, sessionId }))
    )

    pagePersistenceTestHook.afterPrepareBeforeCommit = () => {
      throw new Error("page reset failpoint")
    }
    const failed = await rejectionToDomainError(
      workspaceStub.pageSyncMessage(
        Schema.encodeSync(PageSyncMessageInput)(
          new PageSyncMessageInput({ workspaceId, nodeId: node.id, sessionId, ordinal: 1, message: new Uint8Array([1]) })
        )
      )
    )
    expect(failed._tag).toBe("UnexpectedError")

    pagePersistenceTestHook.afterPrepareBeforeCommit = undefined
    const reset = Schema.decodeUnknownSync(PageSyncMessageOutput)(
      await workspaceStub.pageSyncMessage(
        Schema.encodeSync(PageSyncMessageInput)(
          new PageSyncMessageInput({ workspaceId, nodeId: node.id, sessionId, ordinal: 1, message: new Uint8Array([1]) })
        )
      )
    )
    expect(reset.reset).toBe(true)
  })
})

describe("Automerge sync sessions: stable session id reuse (adversarial-review fix)", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("reusing the same sessionId across multiple separate sync rounds converges correctly each time", async () => {
    // Regression coverage for the fix in `automerge-page.ts`'s `SyncSessionHandle`: previously the
    // web client minted a brand-new sessionId on every debounced sync, so no real test exercised
    // *reusing* one id across more than one top-level `startPageSync` call for the same node. This
    // drives exactly that: three separate "debounced edit" rounds, each its own `startPageSync` +
    // `pageSyncMessage` exchange, all sharing one stable sessionId — the shape the fixed client
    // now actually produces.
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "N" })))
    ).node
    await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id })))

    const sessionId = "stable-session"
    // Same starting point `automerge-page.ts`'s `emptyPageDoc()` uses (`Automerge.init()`, never
    // `.from()` — see that function's doc comment for why): no local `text` field yet, so the
    // first round below must be a pure pull-down before any local edit can be applied to it,
    // exactly like `DailyNote.tsx`'s real resolve-then-edit ordering.
    let doc = Automerge.init<{ text: string }>()

    // One full startPageSync/pageSyncMessage exchange, reusing the shared `sessionId`/`doc`/
    // outer closure — mirrors `automerge-page.ts`'s `syncPageWithServer` (minus the `reset`
    // handling, deliberately: this test's whole point is proving `reset` never fires here).
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
        // The whole point of this test: reusing the session id must never trigger the
        // "no memory of this session" reclaim path.
        expect(response.reset).toBe(false)
        ordinal += 1
        serverMessage = response.message
        if (response.converged && serverMessage === null) break
      }
    }

    // Initial resolve — pulls the server's genesis `{text: ""}` doc down first, same order
    // `DailyNote.tsx`'s `resolveDailyNote` follows.
    await syncOnce()

    for (const insertText of ["Hello", " world", "!"]) {
      doc = Automerge.change(doc, (draft) => {
        Automerge.splice(draft, ["text"], draft.text.length, 0, insertText)
      })
      await syncOnce()
    }

    const fetched = Schema.decodeUnknownSync(GetPageTextOutput)(
      await workspaceStub.getPageText(Schema.encodeSync(GetPageTextInput)(new GetPageTextInput({ workspaceId, nodeId: node.id })))
    )
    expect(fetched.text).toBe("Hello world!")
  })
})

describe("Automerge sync sessions: server-side session cap (adversarial-review fix)", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
    // Restore the real production default — this hook is live-read module state
    // (`notes-service-live.ts`'s doc comment), so a test that lowers it must always put it back.
    notesServiceSessionCapTestHook.maxSessions = 2048
  })

  it("evicts the least-recently-touched session once the cap is exceeded, instead of growing unboundedly", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "N" })))
    ).node
    await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id })))

    notesServiceSessionCapTestHook.maxSessions = 3

    // Four distinct sessions started in order — with a cap of 3, starting the fourth must evict
    // the first (least-recently-touched).
    for (const sessionId of ["s1", "s2", "s3", "s4"]) {
      await workspaceStub.startPageSync(
        Schema.encodeSync(StartPageSyncInput)(new StartPageSyncInput({ workspaceId, nodeId: node.id, sessionId }))
      )
    }

    const s1Response = Schema.decodeUnknownSync(PageSyncMessageOutput)(
      await workspaceStub.pageSyncMessage(
        Schema.encodeSync(PageSyncMessageInput)(
          new PageSyncMessageInput({
            workspaceId,
            nodeId: node.id,
            sessionId: "s1",
            ordinal: 0,
            message: new Uint8Array([0])
          })
        )
      )
    )
    // Evicted — the server has no memory of "s1" anymore, so it must reclaim rather than desync.
    expect(s1Response.reset).toBe(true)

    const [, freshSyncMessage] = Automerge.generateSyncMessage(Automerge.init(), Automerge.initSyncState())
    const s4Response = Schema.decodeUnknownSync(PageSyncMessageOutput)(
      await workspaceStub.pageSyncMessage(
        Schema.encodeSync(PageSyncMessageInput)(
          new PageSyncMessageInput({
            workspaceId,
            nodeId: node.id,
            sessionId: "s4",
            ordinal: 0,
            message: freshSyncMessage!
          })
        )
      )
    )
    // Still within the cap — untouched by the eviction that took "s1".
    expect(s4Response.reset).toBe(false)
  })
})

describe("Automerge sync sessions: two independent 'tabs' converge after concurrent offline edits", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined

  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  /** Drives one full sync round for a client-side Automerge doc against the server, looping the
   *  real `generateSyncMessage`/`receiveSyncMessage` exchange (via `startPageSync`/
   *  `pageSyncMessage`) until both sides report nothing further to exchange. Returns the
   *  converged local doc. */
  const syncTab = async (
    stub: NonNullable<typeof workspaceStub>,
    workspaceId: ReturnType<typeof freshWorkspaceId>,
    nodeId: EntityId,
    localDoc: Automerge.Doc<{ text: string }>,
    sessionId: string
  ): Promise<Automerge.Doc<{ text: string }>> => {
    let doc = localDoc
    let clientSyncState = Automerge.initSyncState()

    const started = Schema.decodeUnknownSync(StartPageSyncOutput)(
      await stub.startPageSync(
        Schema.encodeSync(StartPageSyncInput)(new StartPageSyncInput({ workspaceId, nodeId, sessionId }))
      )
    )

    let pendingFromServer: Uint8Array | null = started.message
    let ordinal = 0

    for (let round = 0; round < 20; round++) {
      let clientOutMessage: Uint8Array | null = null
      if (pendingFromServer !== null) {
        const [nextDoc, nextState] = Automerge.receiveSyncMessage(doc, clientSyncState, pendingFromServer)
        doc = nextDoc
        clientSyncState = nextState
      }
      const [afterGenState, generated] = Automerge.generateSyncMessage(doc, clientSyncState)
      clientSyncState = afterGenState
      clientOutMessage = generated

      if (clientOutMessage === null) break

      const response = Schema.decodeUnknownSync(PageSyncMessageOutput)(
        await stub.pageSyncMessage(
          Schema.encodeSync(PageSyncMessageInput)(
            new PageSyncMessageInput({ workspaceId, nodeId, sessionId, ordinal, message: clientOutMessage })
          )
        )
      )
      expect(response.reset).toBe(false)
      ordinal += 1
      pendingFromServer = response.message
      if (response.converged && pendingFromServer === null) break
    }

    return doc
  }

  it("converges two concurrently-edited local replicas through the server", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Shared note" })))
    ).node
    await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id })))

    // "Tab A" and "Tab B": two independent local Automerge docs, each starting from nothing and
    // syncing down the (empty) server doc first — simulating two reconnects/tabs of the same
    // single Phase 1 web client (plan: "two independent Automerge sync sessions (simulating two
    // 'tabs'/reconnects of the same single web client, since Phase 1 is single-client)").
    let tabA = Automerge.init<{ text: string }>()
    tabA = await syncTab(workspaceStub, workspaceId, node.id, tabA, "tab-a-initial-sync")

    let tabB = Automerge.init<{ text: string }>()
    tabB = await syncTab(workspaceStub, workspaceId, node.id, tabB, "tab-b-initial-sync")

    // Concurrent, offline, non-overlapping local edits — neither tab has seen the other's edit
    // yet at this point.
    tabA = Automerge.change(tabA, (draft) => {
      Automerge.splice(draft, ["text"], 0, 0, "Hello ")
    })
    tabB = Automerge.change(tabB, (draft) => {
      Automerge.splice(draft, ["text"], 0, 0, "World ")
    })

    // Sync A up first, then B — B's sync necessarily merges against a server doc that already
    // contains A's edit (a real, order-sensitive CRDT merge, not independent writes).
    tabA = await syncTab(workspaceStub, workspaceId, node.id, tabA, "tab-a-second-sync")
    tabB = await syncTab(workspaceStub, workspaceId, node.id, tabB, "tab-b-second-sync")

    // A hasn't seen B's edit yet (it synced before B did) — one more round pulls B's change down.
    tabA = await syncTab(workspaceStub, workspaceId, node.id, tabA, "tab-a-third-sync")

    const serverText = Schema.decodeUnknownSync(GetPageTextOutput)(
      await workspaceStub.getPageText(
        Schema.encodeSync(GetPageTextInput)(new GetPageTextInput({ workspaceId, nodeId: node.id }))
      )
    ).text

    // Full three-way convergence: both local replicas and the server agree, byte for byte.
    expect(tabA.text).toBe(serverText)
    expect(tabB.text).toBe(serverText)
    // Both concurrent edits actually survived the merge (a real CRDT merge, not last-write-wins).
    expect(serverText).toContain("Hello")
    expect(serverText).toContain("World")
    expect(Automerge.getHeads(tabA).slice().sort()).toEqual(Automerge.getHeads(tabB).slice().sort())
  })

  it("an unknown/expired sessionId is answered with reset: true, not a silent failure", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "N" })))
    ).node
    await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id })))

    const response = Schema.decodeUnknownSync(PageSyncMessageOutput)(
      await workspaceStub.pageSyncMessage(
        Schema.encodeSync(PageSyncMessageInput)(
          new PageSyncMessageInput({
            workspaceId,
            nodeId: node.id,
            sessionId: "never-started",
            ordinal: 0,
            message: new Uint8Array([1, 2, 3])
          })
        )
      )
    )
    expect(response.reset).toBe(true)
    expect(response.converged).toBe(false)
  })
})
