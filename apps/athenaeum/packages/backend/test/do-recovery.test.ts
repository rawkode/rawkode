// Phase 0 Verify-stage exit criterion #2's second half (plan §"Verification"): "...confirm the
// same for a DO eviction/hibernation mid-fiber (kill the isolate mid-await inside an Effect
// program and verify recovery on next wake)."
//
// isProxyTest: true for the first two suites in this file, and honestly so. `@cloudflare/vitest-
// pool-workers` gives real, non-synthetic primitives for disrupting a running Durable Object
// instance (`evictDurableObject`, `abortAllDurableObjects` from `cloudflare:test`) — these are
// genuine Miniflare-level instance teardowns, not mocks. But neither one lets a test choose the
// exact point *inside* a running Effect program's `await` chain at which the isolate dies, the way
// production isolate eviction genuinely can (mid-storage-write, mid-external-fetch, anywhere).
// What's provable here, and what isn't, is stated per test below — see also cloudflare-os's own
// `workshop-backend/__integration__/open-gadget-rpc.test.ts`, which documents the identical gap
// for its own DO-reset tests ("local aborts reject flagless — flag-based recovery is untestable
// locally").
//
// `typed-storage-effect`'s collection operations (`Collection.put`/`get`/`list`) are themselves
// synchronous (`Effect.try` wrapping a direct `storage.kv`/`storage.transactionSync()` call, not a
// genuine async I/O await) — see `typed-storage-effect/src/collection.ts`. There is therefore no
// externally-observable "mid-write await" window to land a kill inside even in principle, without
// modifying production code to add an artificial delay.
//
// UPDATE (post-review): the third suite below, "genuine mid-fiber kill", closes that gap for real
// rather than leaving it as a permanent proxy. It uses `nodes-repository-live.ts`'s
// `putTestHook.beforeWrite` — a narrow, test-only injection point (`undefined`/no-op unless a test
// sets it) that a running `put()` Effect program `yield*`s through immediately before the actual
// storage write — to park a real fiber at a real, externally-observable suspension point, confirm
// (by polling a flag the hook flips on entry) that the fiber is genuinely parked there, *then* kill
// the isolate, and assert the write never landed and the DO recovers cleanly afterward. That test
// satisfies the literal exit criterion ("kill the isolate mid-`await` inside a running Effect
// program and verify recovery on next wake") without racing timing against a network round trip.
// The two proxy suites are kept as-is (not deleted) because they still cover something the new
// suite doesn't: real *graceful* eviction with durable-storage recovery (`evictDurableObject`,
// which requires no active references and so cannot be combined with an in-flight call), and an
// ungraceful reset raced against the network boundary rather than a chosen fiber-internal point.

import { afterEach, describe, expect, it } from "vitest"
import { abortAllDurableObjects, evictDurableObject } from "cloudflare:test"
import { exports } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { CreateNodeInput, CreateNodeOutput, ListNodesInput, ListNodesOutput, type EntityId } from "@athenaeum/domain"
import { putTestHook } from "../src/nodes-repository-live.js"
import { connectToWorkspace, freshWorkspaceId } from "./support.js"

/** Settles `promise` without throwing, reporting outcome instead — used where a raced
 *  disruption is expected to sometimes (not always, deterministically) reject the in-flight
 *  call, and the test cares about post-disruption consistency more than which specific outcome
 *  this particular run landed on. */
const settle = async (
  promise: Promise<unknown>
): Promise<{ status: "fulfilled"; value: unknown } | { status: "rejected"; reason: unknown }> => {
  try {
    return { status: "fulfilled", value: await promise }
  } catch (reason) {
    return { status: "rejected", reason }
  }
}

describe("DO eviction — graceful (evictDurableObject), real recovery-on-next-wake", () => {
  it(
    "isProxyTest: durable storage survives a real Miniflare eviction, and a fresh stub " +
      "recovers cleanly on next wake",
    async () => {
      const workspaceId: EntityId = freshWorkspaceId()

      // Write, then close the connection *before* evicting. `evictDurableObject` rejects with
      // "it still has active references" if anything (an open WebSocket session counts) is still
      // holding the instance open — an open connection is inherently incompatible with "this
      // isolate is gone", so a live WebSocket session can never be raced against eviction the way
      // it can against `abortAllDurableObjects()` below. This is sequential
      // (write-then-close-then-evict), not concurrent — documented honestly as a narrower proof
      // than the ungraceful test below: it demonstrates real Miniflare-level isolate teardown +
      // durable-storage recovery, not disruption of an in-flight operation.
      const workspaceStub = await connectToWorkspace(workspaceId)
      const createInput = Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Survives eviction" }))
      const created = Schema.decodeUnknownSync(CreateNodeOutput)(await workspaceStub.createNode(createInput))
      expect(created.node.title).toBe("Survives eviction")
      workspaceStub[Symbol.dispose]()

      const doStub = exports.WorkspaceDurableObject.getByName(workspaceId)
      await evictDurableObject(doStub)

      // "The next wake": a fresh connection, after the isolate was genuinely torn down and
      // Miniflare re-created it on demand.
      const freshStub = await connectToWorkspace(workspaceId)
      try {
        const listed = Schema.decodeUnknownSync(ListNodesOutput)(
          await freshStub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
        )
        expect(listed.nodes.map((n) => n.title)).toEqual(["Survives eviction"])

        // The recovered instance keeps working normally, not just able to read back one value.
        const created2 = Schema.decodeUnknownSync(CreateNodeOutput)(
          await freshStub.createNode(
            Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "After re-wake" }))
          )
        )
        expect(created2.node.title).toBe("After re-wake")
      } finally {
        freshStub[Symbol.dispose]()
      }
    }
  )
})

describe("DO eviction — ungraceful (abortAllDurableObjects), closest available proxy for a hard kill", () => {
  it(
    "isProxyTest: an ungraceful reset raced against an in-flight write leaves the DO in a " +
      "consistent, non-corrupt state and recovers cleanly on the next call",
    async () => {
      const workspaceId: EntityId = freshWorkspaceId()
      const workspaceStub = await connectToWorkspace(workspaceId)

      const createInput = Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Racing the reset" }))

      // Unlike evictDurableObject, abortAllDurableObjects() does not document waiting for
      // in-flight requests to drain — it resets every running DO instance immediately. Racing it
      // against the write means the write's own outcome is genuinely non-deterministic run to
      // run (it may complete before the reset lands, or the reset may sever the connection
      // first) — which is exactly the property a real isolate-eviction-mid-await needs to have,
      // even though the *kill point* itself isn't chosen deterministically the way a literal
      // `Fiber.interrupt` at a hand-picked `yield*` would be.
      const [writeOutcome] = await Promise.all([settle(workspaceStub.createNode(createInput)), abortAllDurableObjects()])

      // Whichever way the race landed, the DO must recover cleanly and never be left corrupt:
      // either exactly zero or exactly one "Racing the reset" node exists afterward — never a
      // duplicate, never a decode failure, never a hang.
      const freshStub = await connectToWorkspace(workspaceId)
      try {
        const listed = Schema.decodeUnknownSync(ListNodesOutput)(
          await freshStub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
        )
        const matching = listed.nodes.filter((n) => n.title === "Racing the reset")
        expect(matching.length).toBeLessThanOrEqual(1)

        if (writeOutcome.status === "fulfilled") {
          // The write's own response reached the client before the reset severed anything —
          // durable storage must actually agree with that.
          expect(matching).toHaveLength(1)
        }

        // The instance keeps working normally after the reset, not just able to answer one read.
        const created2 = Schema.decodeUnknownSync(CreateNodeOutput)(
          await freshStub.createNode(
            Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "After the reset" }))
          )
        )
        expect(created2.node.title).toBe("After the reset")

        const listedAfter = Schema.decodeUnknownSync(ListNodesOutput)(
          await freshStub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
        )
        expect(listedAfter.nodes.some((n) => n.title === "After the reset")).toBe(true)
      } finally {
        freshStub[Symbol.dispose]()
      }
    }
  )
})

describe("DO eviction — genuine mid-fiber kill (not a proxy)", () => {
  afterEach(() => {
    // The hook is a shared module-level mutable — always leave it clean for every other test in
    // this file/process, whether this test passed, failed, or threw before reaching its own reset.
    putTestHook.beforeWrite = undefined
  })

  it(
    "killing the isolate while a running Effect program is parked inside put()'s injected " +
      "await point leaves the write un-landed, and the DO recovers cleanly on next wake",
    async () => {
      const workspaceId: EntityId = freshWorkspaceId()
      const workspaceStub = await connectToWorkspace(workspaceId)

      // The real, externally-observable signal that the fiber servicing the write below has
      // reached `nodes-repository-live.ts`'s injected `yield*` point — i.e. is genuinely
      // suspended immediately *before* the storage write runs, not merely "the request was sent"
      // or "some time has passed". The inner `Effect.promise` never resolves on its own: nothing
      // but the isolate dying (or the process exiting) ever ends this suspension.
      let hookEntered = false
      putTestHook.beforeWrite = () =>
        Effect.sync(() => {
          hookEntered = true
        }).pipe(Effect.flatMap(() => Effect.promise(() => new Promise<void>(() => {}))))

      const createInput = Schema.encodeSync(CreateNodeInput)(
        new CreateNodeInput({ workspaceId, title: "Killed mid-fiber" })
      )
      const pendingCreate = workspaceStub.createNode(createInput).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason })
      )

      const hookEnteredAt = Date.now()
      while (!hookEntered) {
        if (Date.now() - hookEnteredAt > 5_000) {
          throw new Error("timed out waiting for putTestHook.beforeWrite to run — the fiber never reached it")
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }

      // The fiber servicing `createNode` is now genuinely, verifiably suspended mid-`await`
      // inside the running Effect program, before its storage write. Kill the isolate *now* —
      // this is the literal exit criterion's "mid-await inside a running Effect program" clause,
      // chosen deterministically rather than raced against network timing.
      await abortAllDurableObjects()

      const outcome = await pendingCreate
      // The isolate died while genuinely parked before the write ran — the call can never have
      // actually succeeded, regardless of how the client-side promise settles.
      expect(outcome.status).toBe("rejected")

      putTestHook.beforeWrite = undefined

      const freshStub = await connectToWorkspace(workspaceId)
      try {
        const listed = Schema.decodeUnknownSync(ListNodesOutput)(
          await freshStub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
        )
        // No corruption: the write that was killed mid-flight, before it ever reached storage,
        // never landed.
        expect(listed.nodes.some((n) => n.title === "Killed mid-fiber")).toBe(false)

        // The instance keeps working normally after the kill, not just able to answer one read.
        const created2 = Schema.decodeUnknownSync(CreateNodeOutput)(
          await freshStub.createNode(
            Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "After the mid-fiber kill" }))
          )
        )
        expect(created2.node.title).toBe("After the mid-fiber kill")

        const listedAfter = Schema.decodeUnknownSync(ListNodesOutput)(
          await freshStub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
        )
        expect(listedAfter.nodes.map((n) => n.title)).toEqual(["After the mid-fiber kill"])
      } finally {
        freshStub[Symbol.dispose]()
      }
    }
  )
})
