// Phase 0 Verify-stage exit criterion #2 (plan §"Verification"): "A live-subscription round trip:
// a Layer.scoped service hands back a Collection.subscribe-backed RpcTarget stub to the client;
// the client abruptly disconnects (simulated crash, not a clean unmount) instead of calling
// Symbol.dispose; confirm server-side Effect resources backing that subscription are actually
// released (not leaked)."
//
// Instrumentation: `subscriptionLifecycle` (`src/nodes-subscription.ts`) is incremented at the
// exact point `NodesSubscription`'s owned `Scope` finishes closing — i.e. once
// `Collection.subscribe`'s release (the raw collection's `unsubscribe`) has actually run, not
// merely been requested. See that module's doc comment for why this is a real release signal and
// not just a dispose-was-called flag.

import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import { CreateNodeInput, CreateNodeOutput, ListNodesInput, NodesChangedEvent } from "@athenaeum/domain"
import { subscriptionLifecycle } from "../src/nodes-subscription.js"
import { connectToWorkspace, connectToWorkspaceWithSocket, freshWorkspaceId, waitUntil } from "./support.js"

describe("subscribeToNodes: live push", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined

  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("next() resolves with an updated snapshot after a node is created on another connection", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)
    const writerStub = await connectToWorkspace(workspaceId)

    try {
      using sub = await workspaceStub.subscribeToNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))

      const initial = Schema.decodeUnknownSync(NodesChangedEvent)(await sub.next())
      expect(initial.nodes).toHaveLength(0)

      const pending = sub.next()
      await writerStub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Pushed live" }))
      )

      const pushed = Schema.decodeUnknownSync(NodesChangedEvent)(await pending)
      expect(pushed.nodes.map((n) => n.title)).toEqual(["Pushed live"])

      const pending2 = sub.next()
      await writerStub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Pushed live 2" }))
      )
      const pushed2 = Schema.decodeUnknownSync(NodesChangedEvent)(await pending2)
      expect(pushed2.nodes.map((n) => n.title).sort()).toEqual(["Pushed live", "Pushed live 2"])
    } finally {
      writerStub[Symbol.dispose]()
    }
  })
})

describe("subscribeToNodes: disposal releases the server-side resource", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined

  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("a clean stub[Symbol.dispose]() releases the subscription (baseline)", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const disposedBefore = subscriptionLifecycle.disposed
    const createdBefore = subscriptionLifecycle.created

    const sub = await workspaceStub.subscribeToNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
    // Drain the initial snapshot first — confirms the subscription is fully registered
    // server-side before we tear it down, not disposing something that never finished setting up.
    await sub.next()
    expect(subscriptionLifecycle.created).toBe(createdBefore + 1)

    sub[Symbol.dispose]()
    await waitUntil(() => subscriptionLifecycle.disposed > disposedBefore)
    expect(subscriptionLifecycle.disposed).toBe(disposedBefore + 1)
  })

  it(
    "an abrupt disconnect (raw WebSocket closed directly, Symbol.dispose never called) still " +
      "releases the server-side subscription resource",
    async () => {
      const workspaceId = freshWorkspaceId()
      const { stub, socket } = await connectToWorkspaceWithSocket(workspaceId)

      const disposedBefore = subscriptionLifecycle.disposed
      const createdBefore = subscriptionLifecycle.created

      const sub = await stub.subscribeToNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
      // Drain the initial snapshot — proves the subscription (and its Collection.subscribe
      // registration) is fully live server-side before the connection dies, exactly as the prior
      // manual smoke test's "drained its initial snapshot (confirming it was fully registered
      // server-side)" step did against a real wrangler dev process.
      await sub.next()
      expect(subscriptionLifecycle.created).toBe(createdBefore + 1)

      // The crash: close the raw transport directly, never going through `sub[Symbol.dispose]()`
      // or the stub's own release protocol at all. Cap'n Web's session-abort path (triggered by
      // any transport loss, clean or not — see `nodes-subscription.ts`'s module doc comment,
      // which cites the shipped `RpcSession.abort()`/`disposeRpcTarget()` source) is what should
      // still run this export's `[Symbol.dispose]()`.
      //
      // What this does NOT prove, honestly stated: `workerd`'s in-process `WebSocketPair` close
      // is a clean protocol-level close event, not a severed TCP connection the way a genuinely
      // crashed OS process would look on the wire (no FIN/RST asymmetry to exploit here, unlike
      // the prior manual smoke test's `rawWs._socket.destroy()` against a real `wrangler dev`
      // process). The distinguishing factor under test is real, though: the *client's own Cap'n
      // Web stub* never cooperates — no `release` RPC control message is ever sent for this
      // export, which is the actual mechanism a real crash (no goodbye frame, just connection
      // loss) and this test both share, and a clean `stub[Symbol.dispose]()` does not.
      socket.close()

      await waitUntil(() => subscriptionLifecycle.disposed > disposedBefore, 10_000)
      expect(subscriptionLifecycle.disposed).toBe(disposedBefore + 1)
      // No leak: exactly as many disposals happened as subscriptions were created in this test.
      expect(subscriptionLifecycle.created - subscriptionLifecycle.disposed).toBe(
        createdBefore - disposedBefore
      )
    }
  )

  it("the DO keeps serving normally after an abrupt subscription disconnect (no leaked/broken state)", async () => {
    const workspaceId = freshWorkspaceId()
    const { stub, socket } = await connectToWorkspaceWithSocket(workspaceId)

    const sub = await stub.subscribeToNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
    await sub.next()
    socket.close()

    const disposedBefore = subscriptionLifecycle.disposed
    await waitUntil(() => subscriptionLifecycle.disposed > disposedBefore - 1)

    // A fresh connection to the same workspace, after the crash, behaves completely normally.
    workspaceStub = await connectToWorkspace(workspaceId)
    const created = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "After the crash" }))
      )
    )
    expect(created.node.title).toBe("After the crash")
  })
})
