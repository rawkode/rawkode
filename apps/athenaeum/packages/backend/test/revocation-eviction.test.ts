// Resolves the plan's "Caveat on ctx.abort() reuse" finding for real (not just by decision — by
// running both sides against a real Automerge sync session over real Cap'n Web RPC and observing
// the actual `reset` bit each approach produces):
//
// 1. "ctx.abort()-style isolate reset forces reset:true" — reproduces cloudflare-os's own
//    `scheduleRevocationRestart` mechanism (a forced full-DO restart) against this app's stateful
//    Automerge sync session and confirms the plan's caveat is real: the in-memory `sessions` Map
//    (`notes-service-live.ts`) does not survive, so the affected session is forced into the
//    expensive `reset: true` full-resync path — exactly as the plan worried, not merely as an
//    untested hypothesis.
// 2. "evictSessions (the gentler drain) avoids it" — proves `workspace-durable-object.ts#evictSessions`
//    (the real mechanism this stage builds instead) evicts precisely the targeted connection,
//    leaves every other live session completely untouched (no forced resync for bystanders), and
//    even lets the evicted party itself resume its exact prior session cheaply on reconnect
//    (no forced resync there either) — because the DO instance, and thus its in-memory Automerge
//    session state, is never destroyed, only the one offending transport is closed.
//
// `abortAllDurableObjects()` (from `cloudflare:test`) is the same real Miniflare-level ungraceful
// reset primitive `test/do-recovery.test.ts` already uses as "the closest available proxy for a
// hard kill" — reused here for the same reason: it genuinely destroys the DO instance's in-memory
// state (not a simulation of that destruction), which is exactly what `ctx.abort()` does too.

import { afterEach, describe, expect, it } from "vitest"
import { abortAllDurableObjects } from "cloudflare:test"
import * as Automerge from "@automerge/automerge"
import * as Schema from "effect/Schema"
import {
  CreateNodeInput,
  CreateNodeOutput,
  CreatePageInput,
  PageSyncMessageInput,
  PageSyncMessageOutput,
  StartPageSyncInput,
  StartPageSyncOutput,
  type EntityId
} from "@athenaeum/domain"
import {
  connectToWorkspace,
  connectToWorkspaceWithSocketAs,
  devSignIn,
  freshWorkspaceId,
  workspaceDurableObjectStub,
  waitUntil,
  type WorkspaceApi
} from "./support.js"
import type { RpcStub } from "capnweb"

interface PageDoc {
  text: string
  readonly [key: string]: unknown
}

/** Runs a real Automerge sync handshake (mirrors `web/src/automerge-page.ts#syncPageWithServer`'s
 *  loop exactly, reimplemented locally so this suite has no cross-package test dependency and
 *  full control over `sessionId`/ordinals) until convergence, returning the converged local doc,
 *  sync state, and the next ordinal this session expects. */
const runInitialHandshake = async (
  stub: RpcStub<WorkspaceApi>,
  workspaceId: EntityId,
  nodeId: EntityId,
  sessionId: string
): Promise<{ doc: Automerge.Doc<PageDoc>; syncState: Automerge.SyncState; nextOrdinal: number }> => {
  let doc = Automerge.init<PageDoc>()
  let syncState = Automerge.initSyncState()
  let ordinal = 0

  let serverMessage = Schema.decodeUnknownSync(StartPageSyncOutput)(
    await stub.startPageSync(
      Schema.encodeSync(StartPageSyncInput)(new StartPageSyncInput({ workspaceId, nodeId, sessionId }))
    )
  ).message

  for (let round = 0; round < 20; round++) {
    if (serverMessage !== null) {
      const [nextDoc, nextState] = Automerge.receiveSyncMessage(doc, syncState, serverMessage)
      doc = nextDoc
      syncState = nextState
    }
    const [afterGen, outMessage] = Automerge.generateSyncMessage(doc, syncState)
    syncState = afterGen
    if (outMessage === null) break

    const response = Schema.decodeUnknownSync(PageSyncMessageOutput)(
      await stub.pageSyncMessage(
        Schema.encodeSync(PageSyncMessageInput)(
          new PageSyncMessageInput({ workspaceId, nodeId, sessionId, ordinal, message: outMessage })
        )
      )
    )
    if (response.reset) throw new Error("unexpected reset:true during a fresh initial handshake")
    ordinal += 1
    serverMessage = response.message
    if (response.converged && serverMessage === null) break
  }

  return { doc, syncState, nextOrdinal: ordinal }
}

/** One more real round trip after the handshake: apply a genuine local edit, generate a real
 *  sync message from it, and send it at `ordinal` — the "is this session still alive and
 *  responding normally" probe both tests below use, before and after their respective
 *  disruption. Returns the response's `reset` bit (the property under test) and the advanced
 *  state for a caller that wants to probe again later. */
const probeSession = async (
  stub: RpcStub<WorkspaceApi>,
  workspaceId: EntityId,
  nodeId: EntityId,
  sessionId: string,
  doc: Automerge.Doc<PageDoc>,
  syncState: Automerge.SyncState,
  ordinal: number,
  editText: string
): Promise<{ reset: boolean; doc: Automerge.Doc<PageDoc>; syncState: Automerge.SyncState; nextOrdinal: number }> => {
  const edited = Automerge.change(doc, (draft) => {
    Automerge.splice(draft, ["text"], draft.text.length, 0, editText)
  })
  const [afterGen, outMessage] = Automerge.generateSyncMessage(edited, syncState)
  if (outMessage === null) {
    throw new Error("expected a real outbound sync message after a local edit")
  }

  const response = Schema.decodeUnknownSync(PageSyncMessageOutput)(
    await stub.pageSyncMessage(
      Schema.encodeSync(PageSyncMessageInput)(
        new PageSyncMessageInput({ workspaceId, nodeId, sessionId, ordinal, message: outMessage })
      )
    )
  )

  return { reset: response.reset, doc: edited, syncState: afterGen, nextOrdinal: ordinal + 1 }
}

const freshEmail = (): string => `revocation-${crypto.randomUUID()}@rawkode.academy`

const createNodeWithPage = async (
  stub: RpcStub<WorkspaceApi>,
  workspaceId: EntityId,
  title: string
): Promise<EntityId> => {
  const created = Schema.decodeUnknownSync(CreateNodeOutput)(
    await stub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title })))
  )
  await stub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: created.node.id })))
  return created.node.id
}

describe("Caveat, part 1: ctx.abort()-style isolate reset forces reset:true (confirms the plan's worry)", () => {
  let stub: RpcStub<WorkspaceApi> | undefined

  afterEach(() => {
    stub?.[Symbol.dispose]()
    stub = undefined
  })

  it(
    "a live Automerge session survives a normal round trip, but forcing a whole-DO ungraceful " +
      "reset mid-session leaves the next message from the SAME session id/ordinal with no server " +
      "memory of it — forced into reset:true, the expensive full-resync path",
    async () => {
      const workspaceId = freshWorkspaceId()
      stub = await connectToWorkspace(workspaceId)
      const nodeId = await createNodeWithPage(stub, workspaceId, "Caveat part 1")
      const sessionId = crypto.randomUUID()

      const handshake = await runInitialHandshake(stub, workspaceId, nodeId, sessionId)

      // Baseline, before any disruption: the session is genuinely alive and responds normally.
      const before = await probeSession(
        stub,
        workspaceId,
        nodeId,
        sessionId,
        handshake.doc,
        handshake.syncState,
        handshake.nextOrdinal,
        "before-abort "
      )
      expect(before.reset).toBe(false)

      // The disruption: a real Miniflare-level ungraceful DO reset — the same primitive
      // `test/do-recovery.test.ts` already establishes as the closest available proxy for
      // `ctx.abort()`'s effect on in-memory state (both destroy the running instance immediately).
      // This is what cloudflare-os's own `scheduleRevocationRestart` does to evict a revoked
      // collaborator's live session.
      await abortAllDurableObjects()

      // Reconnect (the old connection is gone — the abort severed it too) and continue the exact
      // same session id at the exact next ordinal it was legitimately owed. A fresh
      // `WorkspaceDurableObject` instance was constructed for this connection; its `NotesService`'s
      // `sessions` Map (an in-memory closure — see notes-service-live.ts's own doc comment) starts
      // completely empty, with no memory of `sessionId` at all.
      const reconnected = await connectToWorkspace(workspaceId)
      try {
        const after = await probeSession(
          reconnected,
          workspaceId,
          nodeId,
          sessionId,
          before.doc,
          before.syncState,
          before.nextOrdinal,
          "after-abort "
        )
        // This is the caveat, confirmed empirically: the DO-wide reset forced this otherwise-live
        // session into the expensive reset:true path, exactly as the plan worried it might.
        expect(after.reset).toBe(true)
      } finally {
        reconnected[Symbol.dispose]()
      }
    }
  )
})

describe("Caveat, part 2: evictSessions (the gentler drain) resolves it for real", () => {
  it(
    "evictSessions closes exactly the targeted collaborator's socket, leaves a bystander's live " +
      "session completely unaffected (no forced resync), and even lets the evicted party's own " +
      "session resume cheaply (no forced resync) on reconnect with a still-valid credential",
    async () => {
      const workspaceId = freshWorkspaceId()
      const ownerEmail = freshEmail()
      const collabEmail = freshEmail()
      const { credential: ownerCredential } = await devSignIn(ownerEmail)
      const { credential: collabCredential } = await devSignIn(collabEmail)

      const owner = await connectToWorkspaceWithSocketAs(workspaceId, ownerCredential)
      const collab = await connectToWorkspaceWithSocketAs(workspaceId, collabCredential)

      try {
        // Two independent nodes/sessions — deliberately isolated from each other so this test
        // measures cross-session blast radius, not Automerge merge behavior.
        const ownerNodeId = await createNodeWithPage(owner.stub, workspaceId, "Owner's note")
        const collabNodeId = await createNodeWithPage(collab.stub, workspaceId, "Collaborator's note")
        const ownerSessionId = crypto.randomUUID()
        const collabSessionId = crypto.randomUUID()

        const ownerHandshake = await runInitialHandshake(owner.stub, workspaceId, ownerNodeId, ownerSessionId)
        const collabHandshake = await runInitialHandshake(collab.stub, workspaceId, collabNodeId, collabSessionId)

        // Both sessions genuinely alive before eviction.
        const ownerBefore = await probeSession(
          owner.stub,
          workspaceId,
          ownerNodeId,
          ownerSessionId,
          ownerHandshake.doc,
          ownerHandshake.syncState,
          ownerHandshake.nextOrdinal,
          "owner-before "
        )
        expect(ownerBefore.reset).toBe(false)
        const collabBefore = await probeSession(
          collab.stub,
          workspaceId,
          collabNodeId,
          collabSessionId,
          collabHandshake.doc,
          collabHandshake.syncState,
          collabHandshake.nextOrdinal,
          "collab-before "
        )
        expect(collabBefore.reset).toBe(false)

        // The real revocation-eviction mechanism, called exactly the way a future SharingService
        // would call it (native ctx.exports RPC, not Cap'n Web) — targeted at the collaborator
        // only.
        const evictResult = await workspaceDurableObjectStub(workspaceId).evictSessions({
          email: collabEmail,
          reason: "test: revoking collaborator access"
        })
        expect(evictResult.evictedCount).toBe(1)

        // The collaborator's raw socket actually closes, with the app-defined revocation code.
        await waitUntil(() => collab.socket.readyState === WebSocket.READY_STATE_CLOSED, 5_000)
        expect(collab.socket.readyState).toBe(WebSocket.READY_STATE_CLOSED)

        // The owner's socket is completely untouched — still open.
        expect(owner.socket.readyState).toBe(WebSocket.READY_STATE_OPEN)

        // Bystander proof: the owner's session continues normally, no forced resync — unlike
        // part 1's whole-DO reset, this targeted eviction never touched the DO's in-memory
        // NotesService state at all.
        const ownerAfter = await probeSession(
          owner.stub,
          workspaceId,
          ownerNodeId,
          ownerSessionId,
          ownerBefore.doc,
          ownerBefore.syncState,
          ownerBefore.nextOrdinal,
          "owner-after "
        )
        expect(ownerAfter.reset).toBe(false)

        // Cheap-reconnect proof: the evicted party reconnects (their dev credential was never
        // revoked — evictSessions only closed the transport, simulating a downgrade rather than a
        // full removal) and continues its EXACT prior session id/ordinal. Because the DO instance
        // itself was never destroyed, the server still remembers this session — reset:false, the
        // cheap incremental path, not a full resync.
        const collabReconnected = await connectToWorkspaceWithSocketAs(workspaceId, collabCredential)
        try {
          const collabAfter = await probeSession(
            collabReconnected.stub,
            workspaceId,
            collabNodeId,
            collabSessionId,
            collabBefore.doc,
            collabBefore.syncState,
            collabBefore.nextOrdinal,
            "collab-after "
          )
          expect(collabAfter.reset).toBe(false)
        } finally {
          collabReconnected.stub[Symbol.dispose]()
          collabReconnected.socket.close()
        }
      } finally {
        owner.stub[Symbol.dispose]()
        owner.socket.close()
        // collab.socket is already closed by evictSessions; collab.stub disposal is a harmless
        // no-op against an already-dead transport.
        collab.stub[Symbol.dispose]()
      }
    }
  )

  it("evictSessions with no email evicts every live session (the coarse 'evict everyone' case)", async () => {
    const workspaceId = freshWorkspaceId()
    const withSocketsA = await connectToWorkspaceWithSocketAs(workspaceId, (await devSignIn(freshEmail())).credential)
    const withSocketsB = await connectToWorkspaceWithSocketAs(workspaceId, (await devSignIn(freshEmail())).credential)
    try {
      const result = await workspaceDurableObjectStub(workspaceId).evictSessions({ reason: "evict everyone" })
      expect(result.evictedCount).toBe(2)

      await waitUntil(() => withSocketsA.socket.readyState === WebSocket.READY_STATE_CLOSED, 5_000)
      await waitUntil(() => withSocketsB.socket.readyState === WebSocket.READY_STATE_CLOSED, 5_000)
    } finally {
      withSocketsA.stub[Symbol.dispose]()
      withSocketsB.stub[Symbol.dispose]()
    }
  })
})
