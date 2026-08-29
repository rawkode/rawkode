// Real proof of the Phase 3 "Automerge-fork-as-chat-branch" mini-spike (plan §"Agent-native
// editing & gatekeeper integrations", risk #4), exercised over the real production Cap'n Web RPC
// path (`connectToWorkspace`) exactly like every other feature in this suite — not a shortcut into
// `ChatForkService` internals. Proves, against real Automerge/real DO SQLite storage:
//
// 1. Fork isolation: applying edits to a fork never changes what `getPageText` (mainline) sees.
// 2. Accept correctly merges the fork's edits into mainline, including when mainline was ALSO
//    edited directly (via applyPageEdit) while the fork was open — a real CRDT merge, not an
//    overwrite.
// 3. Revert discards the fork with zero effect on mainline, including no leaked sync-feed state.
// 4. Cross-device/cross-tab visibility: a SECOND live RPC connection to the same workspace sees the
//    exact same fork preview a first connection does — the resolved "server-side, DO-instance-
//    scoped, any number of watchers" design (see chat-fork-service-live.ts's header comment).
// 5. The Automerge sync-session protocol (startPageSync/pageSyncMessage) never sees fork content
//    while a fork is open — proof forks don't participate in that protocol at all.
// 6. Fork edits never append to the structured-record sync feed; exactly one new entry appears
//    on accept, none on revert.

import { afterEach, describe, expect, it } from "vitest"
import * as Automerge from "@automerge/automerge"
import * as Schema from "effect/Schema"
import {
  AcceptChatForkInput,
  AcceptChatForkOutput,
  ApplyChatForkEditInput,
  ApplyChatForkEditOutput,
  ApplyPageEditInput,
  ChatForkPreviewInput,
  ChatForkPreviewOutput,
  CreateNodeInput,
  CreateNodeOutput,
  CreatePageInput,
  ForkChatEditInput,
  ForkChatEditOutput,
  GetPageTextInput,
  GetPageTextOutput,
  PageSyncMessageInput,
  PageSyncMessageOutput,
  RevertChatForkInput,
  RevertChatForkOutput,
  StartPageSyncInput,
  StartPageSyncOutput,
  SyncFeedInput,
  SyncFeedOutput,
  type EntityId
} from "@athenaeum/domain"
import { connectToWorkspace, freshWorkspaceId, rejectionToDomainError, workspaceDurableObjectStub } from "./support.js"

const CHAT_ID = "chat-1"

/** Sets up a fresh workspace with one node + created page, returning the connected stub + nodeId. */
const setupWorkspaceWithPage = async () => {
  const workspaceId = freshWorkspaceId()
  const workspaceStub = await connectToWorkspace(workspaceId)
  const node = Schema.decodeUnknownSync(CreateNodeOutput)(
    await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Fork spike note" })))
  ).node
  await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id })))
  await workspaceStub.applyPageEdit(
    Schema.encodeSync(ApplyPageEditInput)(
      new ApplyPageEditInput({ workspaceId, nodeId: node.id, index: 0, deleteCount: 0, insertText: "Mainline content" })
    )
  )
  return { workspaceId, workspaceStub, nodeId: node.id as EntityId }
}

describe("ChatForkService: fork isolation from mainline", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("editing a fork never changes what getPageText (mainline) returns", async () => {
    const setup = await setupWorkspaceWithPage()
    workspaceStub = setup.workspaceStub
    const { workspaceId, nodeId } = setup

    const forked = Schema.decodeUnknownSync(ForkChatEditOutput)(
      await workspaceStub.forkChatEdit(Schema.encodeSync(ForkChatEditInput)(new ForkChatEditInput({ workspaceId, chatId: CHAT_ID, nodeId })))
    )
    expect(forked.text).toBe("Mainline content")

    const edited = Schema.decodeUnknownSync(ApplyChatForkEditOutput)(
      await workspaceStub.applyChatForkEdit(
        Schema.encodeSync(ApplyChatForkEditInput)(
          new ApplyChatForkEditInput({ workspaceId, chatId: CHAT_ID, nodeId, index: 0, deleteCount: 9, insertText: "Agent-proposed " })
        )
      )
    )
    expect(edited.text).toBe("Agent-proposed content")

    // Mainline is completely unaffected — the load-bearing isolation proof.
    const mainline = Schema.decodeUnknownSync(GetPageTextOutput)(
      await workspaceStub.getPageText(Schema.encodeSync(GetPageTextInput)(new GetPageTextInput({ workspaceId, nodeId })))
    )
    expect(mainline.text).toBe("Mainline content")

    const preview = Schema.decodeUnknownSync(ChatForkPreviewOutput)(
      await workspaceStub.chatForkPreview(Schema.encodeSync(ChatForkPreviewInput)(new ChatForkPreviewInput({ workspaceId, chatId: CHAT_ID, nodeId })))
    )
    expect(preview).toEqual(new ChatForkPreviewOutput({ forked: true, text: "Agent-proposed content" }))
  })
})

describe("ChatForkService: accept merges the fork into mainline", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("a simple accept incorporates the fork's edit into mainline", async () => {
    const setup = await setupWorkspaceWithPage()
    workspaceStub = setup.workspaceStub
    const { workspaceId, nodeId } = setup

    await workspaceStub.forkChatEdit(Schema.encodeSync(ForkChatEditInput)(new ForkChatEditInput({ workspaceId, chatId: CHAT_ID, nodeId })))
    await workspaceStub.applyChatForkEdit(
      Schema.encodeSync(ApplyChatForkEditInput)(
        new ApplyChatForkEditInput({ workspaceId, chatId: CHAT_ID, nodeId, index: "Mainline content".length, deleteCount: 0, insertText: " — agent addition" })
      )
    )

    const native = workspaceDurableObjectStub(workspaceId)
    const artifactsBefore = await native.debugGetLedgerArtifactCounts()
    const accepted = Schema.decodeUnknownSync(AcceptChatForkOutput)(
      await workspaceStub.acceptChatFork(Schema.encodeSync(AcceptChatForkInput)(new AcceptChatForkInput({ workspaceId, chatId: CHAT_ID, nodeId })))
    )
    const artifactsAfterFirst = await native.debugGetLedgerArtifactCounts()
    const replay = Schema.decodeUnknownSync(AcceptChatForkOutput)(
      await workspaceStub.acceptChatFork(Schema.encodeSync(AcceptChatForkInput)(new AcceptChatForkInput({ workspaceId, chatId: CHAT_ID, nodeId })))
    )
    expect(accepted.text).toBe("Mainline content — agent addition")
    expect(replay).toEqual(accepted)
    expect(artifactsAfterFirst.events).toBe(artifactsBefore.events + 1)
    expect(artifactsAfterFirst.outboxIntents).toBe(artifactsBefore.outboxIntents + 1)
    expect(await native.debugGetLedgerArtifactCounts()).toEqual(artifactsAfterFirst)

    const mainline = Schema.decodeUnknownSync(GetPageTextOutput)(
      await workspaceStub.getPageText(Schema.encodeSync(GetPageTextInput)(new GetPageTextInput({ workspaceId, nodeId })))
    )
    expect(mainline.text).toBe("Mainline content — agent addition")
    expect(mainline.page.headsHash).toBe(accepted.page.headsHash)

    // The fork is gone — a fresh preview reports not-forked.
    const preview = Schema.decodeUnknownSync(ChatForkPreviewOutput)(
      await workspaceStub.chatForkPreview(Schema.encodeSync(ChatForkPreviewInput)(new ChatForkPreviewInput({ workspaceId, chatId: CHAT_ID, nodeId })))
    )
    expect(preview).toEqual(new ChatForkPreviewOutput({ forked: false, text: "" }))
  })

  it("a real CRDT merge: mainline edited directly WHILE the fork is open, then accepted — both edits survive", async () => {
    const setup = await setupWorkspaceWithPage()
    workspaceStub = setup.workspaceStub
    const { workspaceId, nodeId } = setup

    // Fork first, capturing "Mainline content".
    await workspaceStub.forkChatEdit(Schema.encodeSync(ForkChatEditInput)(new ForkChatEditInput({ workspaceId, chatId: CHAT_ID, nodeId })))

    // Concurrently, mainline is edited directly (e.g. the user typing in their own tab) —
    // append " [user edit]" at the end.
    await workspaceStub.applyPageEdit(
      Schema.encodeSync(ApplyPageEditInput)(
        new ApplyPageEditInput({ workspaceId, nodeId, index: "Mainline content".length, deleteCount: 0, insertText: " [user edit]" })
      )
    )

    // The agent edits its fork — prepend "Agent: " at the start. The fork was cloned BEFORE the
    // user edit above, so this is a genuinely concurrent, divergent edit relative to mainline.
    await workspaceStub.applyChatForkEdit(
      Schema.encodeSync(ApplyChatForkEditInput)(
        new ApplyChatForkEditInput({ workspaceId, chatId: CHAT_ID, nodeId, index: 0, deleteCount: 0, insertText: "Agent: " })
      )
    )

    const accepted = Schema.decodeUnknownSync(AcceptChatForkOutput)(
      await workspaceStub.acceptChatFork(Schema.encodeSync(AcceptChatForkInput)(new AcceptChatForkInput({ workspaceId, chatId: CHAT_ID, nodeId })))
    )
    // Automerge's merge deterministically interleaves genuinely concurrent same-position edits;
    // what matters for this proof is that BOTH edits' content survived the merge, not the exact
    // character ordering Automerge chose.
    expect(accepted.text).toContain("Agent: ")
    expect(accepted.text).toContain("[user edit]")
    expect(accepted.text).toContain("Mainline content")
  })

  it("accepts the newest proposed chat-fork cycle instead of replaying an earlier accepted cycle", async () => {
    const setup = await setupWorkspaceWithPage()
    workspaceStub = setup.workspaceStub
    const { workspaceId, nodeId } = setup

    await workspaceStub.forkChatEdit(Schema.encodeSync(ForkChatEditInput)(new ForkChatEditInput({ workspaceId, chatId: CHAT_ID, nodeId })))
    await workspaceStub.applyChatForkEdit(Schema.encodeSync(ApplyChatForkEditInput)(
      new ApplyChatForkEditInput({ workspaceId, chatId: CHAT_ID, nodeId, index: "Mainline content".length, deleteCount: 0, insertText: " one" })
    ))
    const first = Schema.decodeUnknownSync(AcceptChatForkOutput)(
      await workspaceStub.acceptChatFork(Schema.encodeSync(AcceptChatForkInput)(new AcceptChatForkInput({ workspaceId, chatId: CHAT_ID, nodeId })))
    )
    expect(first.text).toBe("Mainline content one")

    await workspaceStub.forkChatEdit(Schema.encodeSync(ForkChatEditInput)(new ForkChatEditInput({ workspaceId, chatId: CHAT_ID, nodeId })))
    await workspaceStub.applyChatForkEdit(Schema.encodeSync(ApplyChatForkEditInput)(
      new ApplyChatForkEditInput({ workspaceId, chatId: CHAT_ID, nodeId, index: first.text.length, deleteCount: 0, insertText: " two" })
    ))
    const second = Schema.decodeUnknownSync(AcceptChatForkOutput)(
      await workspaceStub.acceptChatFork(Schema.encodeSync(AcceptChatForkInput)(new AcceptChatForkInput({ workspaceId, chatId: CHAT_ID, nodeId })))
    )
    expect(second.text).toBe("Mainline content one two")
  })
})

describe("ChatForkService: revert leaves mainline completely unaffected, no leaked state", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("revert discards the fork; mainline text/headsHash are byte-identical to before the fork existed", async () => {
    const setup = await setupWorkspaceWithPage()
    workspaceStub = setup.workspaceStub
    const { workspaceId, nodeId } = setup

    const before = Schema.decodeUnknownSync(GetPageTextOutput)(
      await workspaceStub.getPageText(Schema.encodeSync(GetPageTextInput)(new GetPageTextInput({ workspaceId, nodeId })))
    )

    await workspaceStub.forkChatEdit(Schema.encodeSync(ForkChatEditInput)(new ForkChatEditInput({ workspaceId, chatId: CHAT_ID, nodeId })))
    await workspaceStub.applyChatForkEdit(
      Schema.encodeSync(ApplyChatForkEditInput)(
        new ApplyChatForkEditInput({ workspaceId, chatId: CHAT_ID, nodeId, index: 0, deleteCount: 0, insertText: "DISCARD ME " })
      )
    )

    const reverted = Schema.decodeUnknownSync(RevertChatForkOutput)(
      await workspaceStub.revertChatFork(Schema.encodeSync(RevertChatForkInput)(new RevertChatForkInput({ workspaceId, chatId: CHAT_ID, nodeId })))
    )
    expect(reverted).toEqual(new RevertChatForkOutput({ chatId: CHAT_ID, nodeId }))

    const after = Schema.decodeUnknownSync(GetPageTextOutput)(
      await workspaceStub.getPageText(Schema.encodeSync(GetPageTextInput)(new GetPageTextInput({ workspaceId, nodeId })))
    )
    expect(after).toEqual(before)

    const preview = Schema.decodeUnknownSync(ChatForkPreviewOutput)(
      await workspaceStub.chatForkPreview(Schema.encodeSync(ChatForkPreviewInput)(new ChatForkPreviewInput({ workspaceId, chatId: CHAT_ID, nodeId })))
    )
    expect(preview).toEqual(new ChatForkPreviewOutput({ forked: false, text: "" }))
  })

  it("reverting a chat/node pair that was never forked is a safe no-op", async () => {
    const setup = await setupWorkspaceWithPage()
    workspaceStub = setup.workspaceStub
    const { workspaceId, nodeId } = setup

    const reverted = Schema.decodeUnknownSync(RevertChatForkOutput)(
      await workspaceStub.revertChatFork(
        Schema.encodeSync(RevertChatForkInput)(new RevertChatForkInput({ workspaceId, chatId: "never-forked-chat", nodeId }))
      )
    )
    expect(reverted).toEqual(new RevertChatForkOutput({ chatId: "never-forked-chat", nodeId }))
  })

  it("applyChatForkEdit / accept without an active fork fail with a typed ValidationError, not a crash", async () => {
    const setup = await setupWorkspaceWithPage()
    workspaceStub = setup.workspaceStub
    const { workspaceId, nodeId } = setup

    const applyError = await rejectionToDomainError(
      workspaceStub.applyChatForkEdit(
        Schema.encodeSync(ApplyChatForkEditInput)(
          new ApplyChatForkEditInput({ workspaceId, chatId: "no-fork", nodeId, index: 0, deleteCount: 0, insertText: "x" })
        )
      )
    )
    expect(applyError._tag).toBe("ValidationError")

    const acceptError = await rejectionToDomainError(
      workspaceStub.acceptChatFork(Schema.encodeSync(AcceptChatForkInput)(new AcceptChatForkInput({ workspaceId, chatId: "no-fork", nodeId })))
    )
    expect(acceptError._tag).toBe("ValidationError")
  })
})

describe("ChatForkService: cross-connection ('cross-device') fork preview visibility", () => {
  let stubA: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  let stubB: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    stubA?.[Symbol.dispose]()
    stubB?.[Symbol.dispose]()
    stubA = undefined
    stubB = undefined
  })

  it("a second live RPC connection to the same workspace sees the identical fork preview the first does", async () => {
    const workspaceId = freshWorkspaceId()
    stubA = await connectToWorkspace(workspaceId)
    stubB = await connectToWorkspace(workspaceId)

    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await stubA.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Shared note" })))
    ).node
    await stubA.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id })))

    // Connection A forks and edits.
    await stubA.forkChatEdit(Schema.encodeSync(ForkChatEditInput)(new ForkChatEditInput({ workspaceId, chatId: CHAT_ID, nodeId: node.id })))
    await stubA.applyChatForkEdit(
      Schema.encodeSync(ApplyChatForkEditInput)(
        new ApplyChatForkEditInput({ workspaceId, chatId: CHAT_ID, nodeId: node.id, index: 0, deleteCount: 0, insertText: "Live preview text" })
      )
    )

    // Connection B — a genuinely separate WebSocket session, standing in for a second device or
    // browser tab watching the same chat — reads the identical fork state via its own call.
    const previewFromA = Schema.decodeUnknownSync(ChatForkPreviewOutput)(
      await stubA.chatForkPreview(
        Schema.encodeSync(ChatForkPreviewInput)(new ChatForkPreviewInput({ workspaceId, chatId: CHAT_ID, nodeId: node.id }))
      )
    )
    const previewFromB = Schema.decodeUnknownSync(ChatForkPreviewOutput)(
      await stubB.chatForkPreview(
        Schema.encodeSync(ChatForkPreviewInput)(new ChatForkPreviewInput({ workspaceId, chatId: CHAT_ID, nodeId: node.id }))
      )
    )
    expect(previewFromB).toEqual(previewFromA)
    expect(previewFromB.text).toBe("Live preview text")

    // Neither connection's mainline read sees the fork content.
    const mainlineFromB = Schema.decodeUnknownSync(GetPageTextOutput)(
      await stubB.getPageText(Schema.encodeSync(GetPageTextInput)(new GetPageTextInput({ workspaceId, nodeId: node.id })))
    )
    expect(mainlineFromB.text).toBe("")
  })
})

describe("ChatForkService: does not interact with the Automerge sync-session protocol", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("startPageSync while a fork is open only ever offers mainline content, never the fork", async () => {
    const setup = await setupWorkspaceWithPage()
    workspaceStub = setup.workspaceStub
    const { workspaceId, nodeId } = setup

    await workspaceStub.forkChatEdit(Schema.encodeSync(ForkChatEditInput)(new ForkChatEditInput({ workspaceId, chatId: CHAT_ID, nodeId })))
    await workspaceStub.applyChatForkEdit(
      Schema.encodeSync(ApplyChatForkEditInput)(
        new ApplyChatForkEditInput({ workspaceId, chatId: CHAT_ID, nodeId, index: 0, deleteCount: 0, insertText: "SHOULD NOT SYNC " })
      )
    )

    // Drive a real Automerge sync session against an empty client doc — whatever the server
    // offers reconstructs to exactly mainline's text, never the fork's.
    const started = Schema.decodeUnknownSync(StartPageSyncOutput)(
      await workspaceStub.startPageSync(
        Schema.encodeSync(StartPageSyncInput)(new StartPageSyncInput({ workspaceId, nodeId, sessionId: "sync-session-1" }))
      )
    )
    expect(started.message).not.toBeNull()

    let clientDoc = Automerge.init<{ text: string }>()
    let clientSyncState = Automerge.initSyncState()

    // Apply the server's first offer, then generate the client's own response message — the
    // same two-step exchange notes-service-live.ts's own server side runs, mirrored client-side.
    const [afterReceive, syncStateAfterReceive] = Automerge.receiveSyncMessage(clientDoc, clientSyncState, started.message!)
    clientDoc = afterReceive
    const [syncStateAfterGenerate, clientMessage] = Automerge.generateSyncMessage(clientDoc, syncStateAfterReceive)
    clientSyncState = syncStateAfterGenerate

    const serverResponse = Schema.decodeUnknownSync(PageSyncMessageOutput)(
      await workspaceStub.pageSyncMessage(
        Schema.encodeSync(PageSyncMessageInput)(
          new PageSyncMessageInput({
            workspaceId,
            nodeId,
            sessionId: "sync-session-1",
            ordinal: 0,
            message: clientMessage ?? new Uint8Array()
          })
        )
      )
    )
    expect(serverResponse.reset).toBe(false)
    if (serverResponse.message !== null) {
      const [reconciled] = Automerge.receiveSyncMessage(clientDoc, clientSyncState, serverResponse.message)
      clientDoc = reconciled
    }

    // The reconstructed client doc — built entirely from real Automerge sync messages the server
    // sent — matches mainline exactly, never containing the fork's "SHOULD NOT SYNC" text.
    expect(clientDoc.text).toBe("Mainline content")
    expect(clientDoc.text).not.toContain("SHOULD NOT SYNC")
  })
})

describe("ChatForkService: sync feed is untouched by fork edits, gains exactly one entry on accept", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("no new sync-feed entries during fork/edit; exactly one new entry on accept; none on revert", async () => {
    const setup = await setupWorkspaceWithPage()
    workspaceStub = setup.workspaceStub
    const { workspaceId, nodeId } = setup

    const countEntries = async (): Promise<number> =>
      Schema.decodeUnknownSync(SyncFeedOutput)(
        await workspaceStub!.syncFeed(Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 1000 })))
      ).entries.length

    const beforeFork = await countEntries()

    await workspaceStub.forkChatEdit(Schema.encodeSync(ForkChatEditInput)(new ForkChatEditInput({ workspaceId, chatId: CHAT_ID, nodeId })))
    await workspaceStub.applyChatForkEdit(
      Schema.encodeSync(ApplyChatForkEditInput)(
        new ApplyChatForkEditInput({ workspaceId, chatId: CHAT_ID, nodeId, index: 0, deleteCount: 0, insertText: "x" })
      )
    )
    expect(await countEntries()).toBe(beforeFork)

    await workspaceStub.acceptChatFork(Schema.encodeSync(AcceptChatForkInput)(new AcceptChatForkInput({ workspaceId, chatId: CHAT_ID, nodeId })))
    expect(await countEntries()).toBe(beforeFork + 1)

    // A second fork/edit/revert cycle on the (now-merged) page adds nothing further.
    await workspaceStub.forkChatEdit(Schema.encodeSync(ForkChatEditInput)(new ForkChatEditInput({ workspaceId, chatId: CHAT_ID, nodeId })))
    await workspaceStub.applyChatForkEdit(
      Schema.encodeSync(ApplyChatForkEditInput)(
        new ApplyChatForkEditInput({ workspaceId, chatId: CHAT_ID, nodeId, index: 0, deleteCount: 0, insertText: "y" })
      )
    )
    await workspaceStub.revertChatFork(Schema.encodeSync(RevertChatForkInput)(new RevertChatForkInput({ workspaceId, chatId: CHAT_ID, nodeId })))
    expect(await countEntries()).toBe(beforeFork + 1)
  })
})
