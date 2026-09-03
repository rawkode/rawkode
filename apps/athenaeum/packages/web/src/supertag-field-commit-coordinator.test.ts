import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  AddFactInput,
  HumanUiMutationAttribution,
  type EntityId
} from "@athenaeum/domain"
import {
  FieldCommitCoordinator,
  fieldDraftValue,
  type FieldCommitRequestContext
} from "./supertag-field-commit-coordinator.js"

type Request = FieldCommitRequestContext

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

const entityId = (value: string): EntityId => value as EntityId

const workspaceId = entityId("00000000-0000-4000-8000-000000000001")
const nodeId = entityId("00000000-0000-4000-8000-000000000002")
const acceptedFactId = entityId("00000000-0000-4000-8000-000000000003")

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const makeCoordinator = (submit: (request: Request) => Promise<{ readonly factId: EntityId }>) => {
  let requestNumber = 0
  return new FieldCommitCoordinator<Request>({
    makeRequest: (context) => context,
    requestIdFactory: () => `request-${++requestNumber}`,
    submit
  })
}

const seed = <TRequest extends object>(coordinator: FieldCommitCoordinator<TRequest>, factId?: string) => {
  coordinator.setFields([{
    fieldId: "email",
    valueKind: "text",
    accepted: { raw: "", checked: false },
    ...(factId === undefined ? {} : { factId: entityId(factId) })
  }])
}

describe("FieldCommitCoordinator", () => {
  it("retains the returned fact id for a queued edit before the initial refetch", async () => {
    const calls: Request[] = []
    const first = deferred<{ readonly factId: EntityId }>()
    const second = deferred<{ readonly factId: EntityId }>()
    const coordinator = makeCoordinator((request) => {
      calls.push(request)
      return calls.length === 1 ? first.promise : second.promise
    })
    seed(coordinator)

    coordinator.updateDraft("email", { raw: "a@example.com", checked: false })
    coordinator.commit("email")
    coordinator.updateDraft("email", { raw: "b@example.com", checked: false })
    coordinator.commit("email")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.factId).toBeUndefined()
    first.resolve({ factId: entityId("fact-a") })
    await flush()

    expect(calls).toHaveLength(2)
    expect(calls[1]?.factId).toBe("fact-a")
    expect(calls[1]?.requestId).toBe("request-2")
    second.resolve({ factId: entityId("fact-a") })
    await flush()
    expect(coordinator.snapshot("email")?.accepted.raw).toBe("b@example.com")
  })

  it("coalesces multiple in-flight edits into one latest write", async () => {
    const calls: Request[] = []
    const first = deferred<{ readonly factId: EntityId }>()
    const second = deferred<{ readonly factId: EntityId }>()
    const coordinator = makeCoordinator((request) => {
      calls.push(request)
      return calls.length === 1 ? first.promise : second.promise
    })
    seed(coordinator, "fact-existing")

    coordinator.updateDraft("email", { raw: "A", checked: false })
    coordinator.commit("email")
    coordinator.updateDraft("email", { raw: "B", checked: false })
    coordinator.updateDraft("email", { raw: "C", checked: false })
    coordinator.commit("email")
    first.resolve({ factId: entityId("fact-existing") })
    await flush()

    expect(calls).toHaveLength(2)
    expect(calls[1]?.draft.raw).toBe("C")
    expect(calls[1]?.factId).toBe("fact-existing")
    second.resolve({ factId: entityId("fact-existing") })
    await flush()
  })

  it("retries the exact frozen request after a failure", async () => {
    const calls: Request[] = []
    const first = deferred<{ readonly factId: EntityId }>()
    const retry = deferred<{ readonly factId: EntityId }>()
    const coordinator = makeCoordinator((request) => {
      calls.push(request)
      return calls.length === 1 ? first.promise : retry.promise
    })
    seed(coordinator)
    coordinator.updateDraft("email", { raw: "failed@example.com", checked: false })
    coordinator.commit("email")
    first.reject(new Error("temporary"))
    await flush()

    expect(coordinator.snapshot("email")?.phase).toBe("failed")
    coordinator.retry("email")
    expect(calls).toHaveLength(2)
    expect(calls[1]).toBe(calls[0])
    retry.resolve({ factId: entityId("fact-retried") })
    await flush()
    expect(coordinator.snapshot("email")?.factId).toBe("fact-retried")
  })

  it("freezes the complete AddFactInput and retries its identical encoded wire payload", async () => {
    const calls: AddFactInput[] = []
    const first = deferred<{ readonly factId: EntityId }>()
    const retry = deferred<{ readonly factId: EntityId }>()
    let requestNumber = 0
    const coordinator = new FieldCommitCoordinator<AddFactInput>({
      makeRequest: ({ fieldId, draft, factId, requestId }) =>
        new AddFactInput({
          workspaceId,
          nodeId,
          predicateId: fieldId,
          value: draft.raw,
          requestId,
          commitMessage: "Update a Supertag field.",
          attribution: new HumanUiMutationAttribution({
            version: "athenaeum.mutation-attribution.v1",
            kind: "humanUi",
            surface: "web-supertag-field-editor"
          }),
          ...(factId === undefined ? {} : { id: factId })
        }),
      requestIdFactory: () => `request-${++requestNumber}`,
      submit: (request) => {
        calls.push(request)
        return calls.length === 1 ? first.promise : retry.promise
      }
    })
    seed(coordinator)

    coordinator.updateDraft("email", { raw: "frozen@example.com", checked: false })
    coordinator.commit("email")

    const encodedA = Schema.encodeSync(AddFactInput)(calls[0]!)
    expect(Object.isFrozen(calls[0]!)).toBe(true)
    expect(Object.isFrozen(calls[0]!.attribution)).toBe(true)

    first.reject(new Error("response lost"))
    await flush()
    expect(coordinator.snapshot("email")?.phase).toBe("failed")

    coordinator.retry("email")
    expect(calls).toHaveLength(2)
    expect(calls[1]).toBe(calls[0])
    expect(Schema.encodeSync(AddFactInput)(calls[1]!)).toEqual(encodedA)

    retry.resolve({ factId: acceptedFactId })
    await flush()
  })

  it("retries A before sending queued B after A fails", async () => {
    const calls: Request[] = []
    const first = deferred<{ readonly factId: EntityId }>()
    const retry = deferred<{ readonly factId: EntityId }>()
    const second = deferred<{ readonly factId: EntityId }>()
    const coordinator = makeCoordinator((request) => {
      calls.push(request)
      return calls.length === 1 ? first.promise : calls.length === 2 ? retry.promise : second.promise
    })
    seed(coordinator)
    coordinator.updateDraft("email", { raw: "A", checked: false })
    coordinator.commit("email")
    coordinator.updateDraft("email", { raw: "B", checked: false })
    coordinator.commit("email")
    first.reject(new Error("temporary"))
    await flush()

    expect(calls).toHaveLength(1)
    expect(coordinator.snapshot("email")?.queued?.raw).toBe("B")
    coordinator.retry("email")
    retry.resolve({ factId: entityId("fact-a") })
    await flush()

    expect(calls).toHaveLength(3)
    expect(calls[1]).toBe(calls[0])
    expect(calls[2]?.draft.raw).toBe("B")
    expect(calls[2]?.factId).toBe("fact-a")
    second.resolve({ factId: entityId("fact-a") })
    await flush()
  })

  it("drains two dirty fields and makes repeated close requests idempotent", async () => {
    const calls: Request[] = []
    const results = [deferred<{ readonly factId: EntityId }>(), deferred<{ readonly factId: EntityId }>()]
    const coordinator = new FieldCommitCoordinator<Request>({
      makeRequest: (context) => context,
      requestIdFactory: (() => {
        let value = 0
        return () => `request-${++value}`
      })(),
      submit: (request) => {
        calls.push(request)
        return results[calls.length - 1]!.promise
      }
    })
    coordinator.setFields([
      { fieldId: "email", valueKind: "text", accepted: { raw: "", checked: false } },
      { fieldId: "company", valueKind: "text", accepted: { raw: "", checked: false } }
    ])
    coordinator.updateDraft("email", { raw: "a@example.com", checked: false })
    coordinator.updateDraft("company", { raw: "Acme", checked: false })
    const closing = coordinator.requestClose()
    expect(coordinator.requestClose()).toBe(closing)
    expect(calls).toHaveLength(2)

    let settled = false
    void closing.then(() => { settled = true })
    results[0]!.resolve({ factId: entityId("fact-email") })
    await flush()
    expect(settled).toBe(false)
    results[1]!.resolve({ factId: entityId("fact-company") })
    await flush()
    await expect(closing).resolves.toBe(true)
    expect(coordinator.isFrozen()).toBe(false)
  })

  it("keeps dirty state authoritative over a stale reload", async () => {
    const pending = deferred<{ readonly factId: EntityId }>()
    const coordinator = makeCoordinator(() => pending.promise)
    seed(coordinator)
    coordinator.updateDraft("email", { raw: "typed@example.com", checked: false })
    coordinator.commit("email")
    coordinator.setFields([{
      fieldId: "email",
      valueKind: "text",
      accepted: { raw: "stale@example.com", checked: false },
      factId: entityId("stale-fact")
    }])
    expect(coordinator.snapshot("email")?.draft.raw).toBe("typed@example.com")
    expect(coordinator.snapshot("email")?.frozen).toBeDefined()
    pending.resolve({ factId: entityId("fact-accepted") })
    await flush()
  })

  it("keeps a locally accepted output authoritative over a stale reload", async () => {
    const pending = deferred<{ readonly factId: EntityId }>()
    const coordinator = makeCoordinator(() => pending.promise)
    seed(coordinator)
    coordinator.updateDraft("email", { raw: "accepted@example.com", checked: false })
    coordinator.commit("email")
    pending.resolve({ factId: entityId("fact-accepted") })
    await flush()

    coordinator.setFields([{
      fieldId: "email",
      valueKind: "text",
      accepted: { raw: "stale@example.com", checked: false },
      factId: entityId("stale-fact")
    }])

    expect(coordinator.snapshot("email")?.accepted.raw).toBe("accepted@example.com")
    expect(coordinator.snapshot("email")?.factId).toBe("fact-accepted")
  })

  it("does not let a stale reload overwrite queued or failed A/B state", async () => {
    const first = deferred<{ readonly factId: EntityId }>()
    const coordinator = makeCoordinator(() => first.promise)
    seed(coordinator)

    coordinator.updateDraft("email", { raw: "A", checked: false })
    coordinator.commit("email")
    coordinator.updateDraft("email", { raw: "B", checked: false })
    coordinator.commit("email")
    first.reject(new Error("offline"))
    await flush()

    coordinator.setFields([{
      fieldId: "email",
      valueKind: "text",
      accepted: { raw: "stale", checked: false },
      factId: entityId("stale-fact")
    }])

    const snapshot = coordinator.snapshot("email")
    expect(snapshot?.phase).toBe("failed")
    expect(snapshot?.draft.raw).toBe("B")
    expect(snapshot?.frozen?.draft.raw).toBe("A")
    expect(snapshot?.queued?.raw).toBe("B")
    expect(snapshot?.factId).toBeUndefined()
  })

  it("reports accepted results once and preserves checkbox values through the same state machine", async () => {
    const accepted: Array<{ readonly fieldId: string; readonly factId: EntityId }> = []
    const coordinator = new FieldCommitCoordinator<Request>({
      makeRequest: (context) => context,
      requestIdFactory: () => "checkbox-request",
      submit: async () => ({ factId: acceptedFactId }),
      onAccepted: (fieldId, result) => accepted.push({ fieldId, factId: result.factId })
    })
    coordinator.setFields([{
      fieldId: "done",
      valueKind: "checkbox",
      accepted: { raw: "", checked: false }
    }])

    coordinator.updateDraft("done", { raw: "", checked: true })
    coordinator.commit("done")
    await flush()

    expect(fieldDraftValue("checkbox", { raw: "ignored", checked: true })).toBe(true)
    expect(coordinator.snapshot("done")?.accepted.checked).toBe(true)
    expect(accepted).toEqual([{ fieldId: "done", factId: acceptedFactId }])
  })

  it("keeps a close drain blocked after A fails until that exact A retry is accepted", async () => {
    const first = deferred<{ readonly factId: EntityId }>()
    const retry = deferred<{ readonly factId: EntityId }>()
    let calls = 0
    const coordinator = makeCoordinator(() => (++calls === 1 ? first.promise : retry.promise))
    seed(coordinator)
    coordinator.updateDraft("email", { raw: "A", checked: false })
    const closing = coordinator.requestClose()
    first.reject(new Error("offline"))
    await flush()

    let resolved = false
    void closing.then(() => { resolved = true })
    await flush()
    expect(resolved).toBe(false)
    expect(coordinator.snapshot("email")?.phase).toBe("failed")

    coordinator.retry("email")
    retry.resolve({ factId: acceptedFactId })
    await expect(closing).resolves.toBe(true)
  })

  it("waits for a blur-started field commit before removal and blocks close", async () => {
    const pending = deferred<{ readonly factId: EntityId }>()
    const calls: Request[] = []
    const coordinator = makeCoordinator((request) => {
      calls.push(request)
      return pending.promise
    })
    seed(coordinator)
    coordinator.updateDraft("email", { raw: "blurred@example.com", checked: false })
    coordinator.commit("email")
    let removed = false
    const removing = coordinator.requestRemoval(async () => { removed = true })
    await flush()
    expect(removed).toBe(false)
    await expect(coordinator.requestClose()).resolves.toBe(false)
    pending.resolve({ factId: entityId("fact-email") })
    await expect(removing).resolves.toBe(true)
    expect(removed).toBe(true)
    expect(calls).toHaveLength(1)
  })
})
