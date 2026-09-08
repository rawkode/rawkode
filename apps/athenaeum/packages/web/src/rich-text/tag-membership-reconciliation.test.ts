import { describe, expect, it } from "vitest"
import { EntityId } from "@athenaeum/domain"
import { createTagMembershipReconciler } from "./tag-membership-reconciliation.js"

const tagA = EntityId.make("00000000-0000-4000-8000-00000000000a")
const tagB = EntityId.make("00000000-0000-4000-8000-00000000000b")

type Deferred = {
  readonly operations: readonly { readonly kind: "assign" | "unassign"; readonly tagId: EntityId; readonly requestId: string }[]
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: Error) => void
}

const deferred = (operations: Deferred["operations"]): Deferred => {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return Object.assign({ operations, resolve, reject }, { promise })
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("serialized tag-membership reconciliation", () => {
  it("queues an unassign behind a delayed assign so an old write cannot win the race", async () => {
    const calls: Array<ReturnType<typeof deferred>> = []
    const reconciler = createTagMembershipReconciler({
      send: async (operations) => {
        const call = deferred(operations)
        calls.push(call)
        await call.promise
      }
    })

    reconciler.request([tagA])
    reconciler.request([])
    expect(calls).toHaveLength(1)
    expect(calls[0].operations[0]).toMatchObject({ kind: "assign", tagId: tagA })

    calls[0].resolve()
    await flush()
    expect(calls).toHaveLength(2)
    expect(calls[1].operations[0]).toMatchObject({ kind: "unassign", tagId: tagA })

    calls[1].resolve()
    await flush()
    expect(reconciler.snapshot()).toMatchObject({ confirmedKey: "", desiredKey: "", activeInFlight: false })
  })

  it("retries the incomplete plan with the same request IDs before applying a newer target", async () => {
    const calls: Array<ReturnType<typeof deferred>> = []
    const errors: unknown[] = []
    const reconciler = createTagMembershipReconciler({
      send: async (operations) => {
        const call = deferred(operations)
        calls.push(call)
        await call.promise
      },
      onError: (error) => errors.push(error)
    })

    reconciler.request([tagA])
    const firstRequestId = calls[0].operations[0].requestId
    calls[0].reject(new Error("transport failed after the server applied the write"))
    await flush()
    reconciler.request([tagB])
    expect(calls).toHaveLength(2)
    expect(calls[1].operations).toEqual([{ ...calls[0].operations[0] }])
    expect(calls[1].operations[0].requestId).toBe(firstRequestId)

    calls[1].resolve()
    await flush()
    expect(calls).toHaveLength(3)
    expect(calls[2].operations.map((operation) => operation.kind)).toEqual(["assign", "unassign"])
    expect(calls[2].operations.map((operation) => operation.tagId)).toEqual([tagB, tagA])
    calls[2].resolve()
    await flush()
    expect(errors).toHaveLength(1)
    expect(reconciler.snapshot()).toMatchObject({ confirmedKey: String(tagB), desiredKey: String(tagB), activeInFlight: false })
  })
})
