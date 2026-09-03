import { describe, expect, it } from "vitest"
import { EntityId } from "@athenaeum/domain"
import { createReferenceReconciler } from "./reference-reconciliation.js"

const nodeA = EntityId.make("00000000-0000-4000-8000-00000000000a")
const nodeB = EntityId.make("00000000-0000-4000-8000-00000000000b")

type Deferred = {
  readonly plan: { readonly referencedNodeIds: readonly EntityId[]; readonly requestId: string }
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: Error) => void
}

const deferred = (plan: Deferred["plan"]): Deferred => {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { plan, promise, resolve, reject }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("serialized note-reference reconciliation", () => {
  it("queues an empty state behind a delayed create so the old plan cannot land last", async () => {
    const calls: Deferred[] = []
    const reconciler = createReferenceReconciler({
      send: async (plan) => {
        const call = deferred(plan)
        calls.push(call)
        await call.promise
      }
    })

    reconciler.request([nodeA])
    reconciler.request([])
    expect(calls).toHaveLength(1)
    calls[0]!.resolve()
    await flush()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.plan.referencedNodeIds).toEqual([])
    expect(calls[1]!.plan.requestId).not.toBe(calls[0]!.plan.requestId)
    calls[1]!.resolve()
    await flush()
    expect(reconciler.snapshot()).toMatchObject({ confirmedKey: "", desiredKey: "", activeInFlight: false })
  })

  it("retries a failed plan with the same id before applying a newer desired state", async () => {
    const calls: Deferred[] = []
    const errors: unknown[] = []
    const reconciler = createReferenceReconciler({
      send: async (plan) => {
        const call = deferred(plan)
        calls.push(call)
        await call.promise
      },
      onError: (error) => errors.push(error)
    })

    reconciler.request([nodeA])
    const requestId = calls[0]!.plan.requestId
    calls[0]!.reject(new Error("transport failed after the server applied the write"))
    await flush()
    reconciler.request([nodeB])
    expect(calls).toHaveLength(2)
    expect(calls[1]!.plan.requestId).toBe(requestId)
    expect(calls[1]!.plan.referencedNodeIds).toEqual([nodeA])
    calls[1]!.resolve()
    await flush()
    expect(calls).toHaveLength(3)
    expect(calls[2]!.plan.referencedNodeIds).toEqual([nodeB])
    calls[2]!.resolve()
    await flush()
    expect(errors).toHaveLength(1)
    expect(reconciler.snapshot()).toMatchObject({ confirmedKey: String(nodeB), desiredKey: String(nodeB), activeInFlight: false })
  })
})
