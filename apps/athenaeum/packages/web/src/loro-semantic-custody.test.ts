import { describe, expect, it, vi } from "vitest"
import type { EntityId, PageDocumentDescriptor } from "@athenaeum/domain"
import { createLoroPage } from "./loro-page.js"
import {
  LoroSemanticCustodyRegistry,
  type LoroAuthorityReload,
  type LoroCheckpointTransportResult
} from "./loro-semantic-custody.js"
import type { FrozenLoroIntent } from "./checkpointed-loro-writer.js"

const workspaceA = "00000000-0000-4000-8000-000000000001" as EntityId
const workspaceB = "00000000-0000-4000-8000-000000000011" as EntityId
const nodeA = "00000000-0000-4000-8000-000000000002" as EntityId
const nodeB = "00000000-0000-4000-8000-000000000012" as EntityId

const descriptor = (nodeId: EntityId, storageVersion = 1, byte = "a", schemaVersion = 1) => ({
  nodeId,
  storageVersion,
  activeFormat: "loro-v1" as const,
  loro: { schemaVersion, snapshotSha256: byte.repeat(64) }
}) as unknown as Extract<PageDocumentDescriptor, { activeFormat: "loro-v1" }>

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const edit = (doc: ReturnType<typeof createLoroPage>["doc"], key: string, value: string): void => {
  doc.getMap("athenaeum-page-meta-v1").set(key, value)
  doc.commit()
}

const resultFor = (
  base: ReturnType<typeof createLoroPage>["doc"],
  flight: FrozenLoroIntent,
  storageVersion: number,
  byte: string
): LoroCheckpointTransportResult => {
  const authority = base.fork()
  authority.import(flight.update)
  return {
    authoritative: { doc: authority, descriptor: descriptor(nodeA, storageVersion, byte) },
    receipt: { storageVersion, resultSnapshotSha256: byte.repeat(64) } as never
  }
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

// The registry never reaches for an implicit timer in tests; Vitest controls this injected clock.
const injectedClock = {
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)
}

describe("runtime-scoped Loro semantic custody", () => {
  it("locks human edits while an external mutation is in flight and unlocks only after verified reload", async () => {
    const registry = new LoroSemanticCustodyRegistry()
    const runtime = Object.freeze({})
    const connection = Object.freeze({})
    const page = createLoroPage()
    const reloaded = page.doc.fork()
    const attachment = registry.attach({
      runtime, runtimeConnectionIdentity: connection, workspaceId: workspaceA, nodeId: nodeA,
      initial: { doc: page.doc, descriptor: descriptor(nodeA) },
      makeIntent: () => ({ requestId: "external", commitMessage: "External", attribution: { kind: "humanUi", surface: "rich-text-editor" } } as never),
      transport: async () => { throw new Error("not used") },
      loadAuthority: async () => ({ workspaceId: workspaceA, nodeId: nodeA, doc: reloaded, descriptor: descriptor(nodeA, 2, "b") }),
      snapshotDigest: async () => "b".repeat(64)
    })

    expect(attachment.beginExternalCommit()).toBe(true)
    expect(attachment.snapshot().state).toBe("externalCommit")
    edit(attachment.snapshot().workingDraft!, "whileLocked", "rejected")
    expect(attachment.noteHumanEdit()).toBe(false)
    expect(await attachment.reloadAfterExternalCommit()).toBe(true)
    expect(attachment.snapshot().state).toBe("clean")
    edit(attachment.snapshot().workingDraft!, "afterReload", "accepted")
    expect(attachment.noteHumanEdit()).toBe(true)
    attachment.detach()
  })

  it("keeps an external mutation read-only and exposes an explicit reload retry after failure", async () => {
    const registry = new LoroSemanticCustodyRegistry()
    const runtime = Object.freeze({})
    const connection = Object.freeze({})
    const page = createLoroPage()
    const reloaded = page.doc.fork()
    let attempts = 0
    const attachment = registry.attach({
      runtime, runtimeConnectionIdentity: connection, workspaceId: workspaceA, nodeId: nodeA,
      initial: { doc: page.doc, descriptor: descriptor(nodeA) },
      makeIntent: () => ({ requestId: "external", commitMessage: "External", attribution: { kind: "humanUi", surface: "rich-text-editor" } } as never),
      transport: async () => { throw new Error("not used") },
      loadAuthority: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("authority unavailable")
        return { workspaceId: workspaceA, nodeId: nodeA, doc: reloaded, descriptor: descriptor(nodeA, 2, "b") }
      },
      snapshotDigest: async () => "b".repeat(64)
    })

    expect(attachment.beginExternalCommit()).toBe(true)
    expect(await attachment.reloadAfterExternalCommit()).toBe(false)
    expect(attachment.snapshot().state).toBe("externalCommitFailed")
    expect(attachment.noteHumanEdit()).toBe(false)
    expect(await attachment.reloadAfterExternalCommit()).toBe(true)
    expect(attachment.snapshot().state).toBe("clean")
    expect(attempts).toBe(2)
    attachment.detach()
  })

  it("finishes an entered external mutation after its editor detaches", async () => {
    const registry = new LoroSemanticCustodyRegistry()
    const runtime = Object.freeze({})
    const connection = Object.freeze({})
    const page = createLoroPage()
    const reloaded = page.doc.fork()
    const attachment = registry.attach({
      runtime, runtimeConnectionIdentity: connection, workspaceId: workspaceA, nodeId: nodeA,
      initial: { doc: page.doc, descriptor: descriptor(nodeA) },
      makeIntent: () => ({ requestId: "external-detached", commitMessage: "External", attribution: { kind: "humanUi", surface: "rich-text-editor" } } as never),
      transport: async () => { throw new Error("not used") },
      loadAuthority: async () => ({ workspaceId: workspaceA, nodeId: nodeA, doc: reloaded, descriptor: descriptor(nodeA, 2, "b") }),
      snapshotDigest: async () => "b".repeat(64)
    })

    expect(attachment.beginExternalCommit()).toBe(true)
    attachment.detach()
    expect(registry.hasOwner(runtime, workspaceA, nodeA)).toBe(true)

    // The coordinator that entered the external mutation may outlive the editor component.
    expect(await attachment.reloadAfterExternalCommit()).toBe(true)
    expect(registry.hasOwner(runtime, workspaceA, nodeA)).toBe(false)
  })

  it("reattaches a newer authority after a detached external reload stays failed", async () => {
    const registry = new LoroSemanticCustodyRegistry()
    const runtime = Object.freeze({})
    const connection = Object.freeze({})
    const page = createLoroPage()
    const authority = page.doc.fork()
    let attempts = 0
    const options = {
      runtime, runtimeConnectionIdentity: connection, workspaceId: workspaceA, nodeId: nodeA,
      initial: { doc: page.doc, descriptor: descriptor(nodeA) },
      makeIntent: () => ({ requestId: "external-detached-failure", commitMessage: "External", attribution: { kind: "humanUi", surface: "rich-text-editor" } } as never),
      transport: async () => { throw new Error("not used") },
      loadAuthority: async () => {
        attempts += 1
        if (attempts < 3) throw new Error("authority unavailable")
        return { workspaceId: workspaceA, nodeId: nodeA, doc: authority, descriptor: descriptor(nodeA, 2, "b") }
      },
      snapshotDigest: async () => "b".repeat(64)
    }
    const attachment = registry.attach(options)

    expect(attachment.beginExternalCommit()).toBe(true)
    attachment.detach()
    expect(await attachment.reloadAfterExternalCommit()).toBe(false)
    expect(await attachment.reloadAfterExternalCommit()).toBe(false)
    expect(attachment.snapshot().state).toBe("externalCommitFailed")

    // A remount can now present the newer descriptor, but the retained owner must remain the
    // recovery authority until its explicit server reload verifies that descriptor.
    const reopened = registry.attach({
      ...options,
      initial: { doc: authority, descriptor: descriptor(nodeA, 2, "b") }
    })
    expect(reopened.active).toBe(true)
    expect(reopened.snapshot().state).toBe("externalCommitFailed")
    expect(await reopened.reloadAfterExternalCommit()).toBe(true)
    expect(reopened.snapshot().state).toBe("clean")
    reopened.detach()
    expect(registry.hasOwner(runtime, workspaceA, nodeA)).toBe(false)
    expect(attempts).toBe(3)
  })

  it("keeps a pre-freeze human edit after detach and retires only after it settles", async () => {
    vi.useFakeTimers()
    try {
      const registry = new LoroSemanticCustodyRegistry()
      const runtime = Object.freeze({})
      const connection = Object.freeze({})
      const page = createLoroPage()
      let attachment: ReturnType<typeof registry.attach>
      const transport = vi.fn(async (flight: FrozenLoroIntent) =>
        resultFor(attachment.snapshot().acceptedBase!.doc, flight, 2, "b"))
      attachment = registry.attach({
        runtime, runtimeConnectionIdentity: connection, workspaceId: workspaceA, nodeId: nodeA,
        initial: { doc: page.doc, descriptor: descriptor(nodeA) },
        makeIntent: () => ({ requestId: "pre-freeze", commitMessage: "Edit daily note", attribution: { kind: "humanUi", surface: "rich-text-editor" } } as never),
        transport,
        loadAuthority: async () => { throw new Error("not used") },
        debounceMs: 10, clock: injectedClock
      })
      edit(attachment.snapshot().workingDraft!, "A", "one")
      expect(attachment.noteHumanEdit()).toBe(true)
      attachment.detach()

      expect(registry.hasOwner(runtime, workspaceA, nodeA)).toBe(true)
      await vi.advanceTimersByTimeAsync(10)
      await flush()
      expect(transport).toHaveBeenCalledTimes(1)
      expect(registry.hasOwner(runtime, workspaceA, nodeA)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("retains immutable A and visible B across detach, delayed conflict, and reopen", async () => {
    vi.useFakeTimers()
    try {
      const registry = new LoroSemanticCustodyRegistry()
      const runtime = Object.freeze({})
      const connection = Object.freeze({})
      const page = createLoroPage()
      const response = deferred<LoroCheckpointTransportResult>()
      const flights: FrozenLoroIntent[] = []
      const options = {
        runtime, runtimeConnectionIdentity: connection, workspaceId: workspaceA, nodeId: nodeA,
        initial: { doc: page.doc, descriptor: descriptor(nodeA) },
        makeIntent: () => ({ requestId: `A-${flights.length + 1}`, commitMessage: "Edit daily note", attribution: { kind: "humanUi", surface: "rich-text-editor" } } as never),
        transport: (flight: FrozenLoroIntent) => {
          flights.push(flight)
          return response.promise
        },
        loadAuthority: async () => { throw new Error("not used") },
        debounceMs: 10, clock: injectedClock
      }
      const first = registry.attach(options)
      edit(first.snapshot().workingDraft!, "A", "one")
      first.noteHumanEdit()
      await vi.advanceTimersByTimeAsync(10)
      expect(flights).toHaveLength(1)
      const frozenA = flights[0]!
      edit(first.snapshot().workingDraft!, "B", "two")
      first.noteHumanEdit()
      first.detach()

      response.reject({ _tag: "LoroContentConflict" })
      await flush()
      expect(registry.hasOwner(runtime, workspaceA, nodeA)).toBe(true)

      const reopened = registry.attach(options)
      const snapshot = reopened.snapshot()
      expect(snapshot.state).toBe("retainedConflict")
      expect(snapshot.frozenA).toBe(frozenA)
      expect(snapshot.workingDraft!.getMap("athenaeum-page-meta-v1").get("B")).toBe("two")
      expect(reopened.manualRetry()).toBe(false)
      expect(flights).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("retries immutable A with bounded backoff, then manually sends exact A before exactly one B", async () => {
    vi.useFakeTimers()
    try {
      const registry = new LoroSemanticCustodyRegistry()
      const runtime = Object.freeze({})
      const connection = Object.freeze({})
      const page = createLoroPage()
      const flights: FrozenLoroIntent[] = []
      const firstLoss = deferred<LoroCheckpointTransportResult>()
      const manual = deferred<LoroCheckpointTransportResult>()
      const bResult = deferred<LoroCheckpointTransportResult>()
      let latestAttachment: ReturnType<typeof registry.attach>
      const transport = (flight: FrozenLoroIntent): Promise<LoroCheckpointTransportResult> => {
        flights.push(flight)
        if (flights.length === 1) return firstLoss.promise
        if (flights.length <= 4) return Promise.reject(new Error("response lost"))
        if (flights.length === 5) return manual.promise
        return bResult.promise
      }
      const options = {
        runtime, runtimeConnectionIdentity: connection, workspaceId: workspaceA, nodeId: nodeA,
        initial: { doc: page.doc, descriptor: descriptor(nodeA) },
        makeIntent: () => ({ requestId: `request-${flights.length + 1}`, commitMessage: "Edit daily note", attribution: { kind: "humanUi", surface: "rich-text-editor" } } as never),
        transport,
        loadAuthority: async () => { throw new Error("not used") },
        debounceMs: 10, clock: injectedClock
      }
      const first = registry.attach(options)
      latestAttachment = first
      edit(first.snapshot().workingDraft!, "A", "one")
      first.noteHumanEdit()
      await vi.advanceTimersByTimeAsync(10)
      // B is typed into the fresh post-freeze replica while immutable A is still in flight.
      edit(first.snapshot().workingDraft!, "B", "two")
      first.noteHumanEdit()
      firstLoss.reject(new Error("response lost"))
      await flush()
      await vi.advanceTimersByTimeAsync(100)
      await vi.advanceTimersByTimeAsync(250)
      await vi.advanceTimersByTimeAsync(500)
      await flush()
      expect(flights).toHaveLength(4)
      expect(flights.slice(1)).toEqual([flights[0], flights[0], flights[0]])

      first.detach()
      latestAttachment = registry.attach(options)
      expect(latestAttachment.snapshot().state).toBe("retainedRetry")
      expect(latestAttachment.manualRetry()).toBe(true)
      expect(flights).toHaveLength(5)
      expect(flights[4]).toBe(flights[0])

      manual.resolve(resultFor(latestAttachment.snapshot().acceptedBase!.doc, flights[4]!, 2, "b"))
      await flush()
      await vi.advanceTimersByTimeAsync(10)
      expect(flights).toHaveLength(6)
      expect(flights[5]!.requestId).not.toBe(flights[0]!.requestId)
      expect(Array.from(flights[5]!.update)).not.toEqual(Array.from(flights[0]!.update))
      bResult.resolve(resultFor(latestAttachment.snapshot().acceptedBase!.doc, flights[5]!, 3, "c"))
      await flush()
      expect(latestAttachment.snapshot().state).toBe("clean")
    } finally {
      vi.useRealTimers()
    }
  })

  it("retains request identity failure without retrying or minting a replacement request", async () => {
    vi.useFakeTimers()
    try {
      const registry = new LoroSemanticCustodyRegistry()
      const runtime = Object.freeze({})
      const connection = Object.freeze({})
      const page = createLoroPage()
      const calls: FrozenLoroIntent[] = []
      const response = deferred<LoroCheckpointTransportResult>()
      const options = {
        runtime, runtimeConnectionIdentity: connection, workspaceId: workspaceA, nodeId: nodeA,
        initial: { doc: page.doc, descriptor: descriptor(nodeA) },
        makeIntent: () => ({ requestId: "identity-A", commitMessage: "Edit daily note", attribution: { kind: "humanUi", surface: "rich-text-editor" } } as never),
        transport: (flight: FrozenLoroIntent) => {
          calls.push(flight)
          return response.promise
        },
        loadAuthority: async () => { throw new Error("not used") },
        debounceMs: 10, clock: injectedClock
      }
      const attachment = registry.attach(options)
      edit(attachment.snapshot().workingDraft!, "A", "one")
      attachment.noteHumanEdit()
      await vi.advanceTimersByTimeAsync(10)
      edit(attachment.snapshot().workingDraft!, "B", "two")
      attachment.noteHumanEdit()
      attachment.detach()
      response.reject({ _tag: "RequestIdentityConflict" })
      await flush()
      await vi.advanceTimersByTimeAsync(10_000)
      const reopened = registry.attach(options)
      const snapshot = reopened.snapshot()
      expect(snapshot.state).toBe("retainedRequestIdentity")
      expect(snapshot.frozenA).toBe(calls[0])
      expect(snapshot.workingDraft!.getMap("athenaeum-page-meta-v1").get("B")).toBe("two")
      expect(reopened.manualRetry()).toBe(false)
      expect(calls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("makes stale recovery tokens inert and preserves B when explicit authority verification fails", async () => {
    vi.useFakeTimers()
    try {
      const registry = new LoroSemanticCustodyRegistry()
      const runtime = Object.freeze({})
      const connection = Object.freeze({})
      const page = createLoroPage()
      const response = deferred<LoroCheckpointTransportResult>()
      const reload = deferred<LoroAuthorityReload>()
      const flights: FrozenLoroIntent[] = []
      const options = {
        runtime, runtimeConnectionIdentity: connection, workspaceId: workspaceA, nodeId: nodeA,
        initial: { doc: page.doc, descriptor: descriptor(nodeA) },
        makeIntent: () => ({ requestId: "conflict-A", commitMessage: "Edit daily note", attribution: { kind: "humanUi", surface: "rich-text-editor" } } as never),
        transport: (flight: FrozenLoroIntent) => {
          flights.push(flight)
          return response.promise
        },
        loadAuthority: () => reload.promise,
        snapshotDigest: async () => "not-the-server-digest",
        debounceMs: 10, clock: injectedClock
      }
      const first = registry.attach(options)
      edit(first.snapshot().workingDraft!, "A", "one")
      first.noteHumanEdit()
      await vi.advanceTimersByTimeAsync(10)
      edit(first.snapshot().workingDraft!, "B", "two")
      first.noteHumanEdit()
      response.reject({ _tag: "LoroContentConflict" })
      await flush()
      const frozenA = first.snapshot().frozenA

      const recovery = first.discardAndReload()
      expect(first.snapshot().state).toBe("recovering")
      first.detach()
      const reopened = registry.attach(options)
      expect(reopened.snapshot().state).toBe("recovering")
      const authority = createLoroPage().doc
      reload.resolve({ workspaceId: workspaceA, nodeId: nodeA, doc: authority, descriptor: descriptor(nodeA, 2, "b") })
      await expect(recovery).resolves.toBe(false)
      expect(reopened.snapshot().state).toBe("retainedConflict")
      expect(reopened.snapshot().frozenA).toBe(frozenA)
      expect(reopened.snapshot().workingDraft!.getMap("athenaeum-page-meta-v1").get("B")).toBe("two")
      expect(flights).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ["rejects unsupported schema v2", () => ({
      workspaceId: workspaceA, nodeId: nodeA, doc: createLoroPage().doc, descriptor: descriptor(nodeA, 2, "b", 2)
    }), async () => "b".repeat(64)],
    ["rejects unsafe storageVersion", () => ({
      workspaceId: workspaceA, nodeId: nodeA, doc: createLoroPage().doc, descriptor: descriptor(nodeA, Number.MAX_SAFE_INTEGER + 1, "b")
    }), async () => "b".repeat(64)],
    ["rejects unsafe schemaVersion", () => ({
      workspaceId: workspaceA, nodeId: nodeA, doc: createLoroPage().doc, descriptor: descriptor(nodeA, 2, "b", Number.MAX_SAFE_INTEGER + 1)
    }), async () => "b".repeat(64)],
    ["rejects descriptor and document schema mismatch", () => {
      const doc = createLoroPage().doc
      doc.getMap("athenaeum-page-meta-v1").set("schemaVersion", 2)
      doc.commit()
      return { workspaceId: workspaceA, nodeId: nodeA, doc, descriptor: descriptor(nodeA, 2, "b") }
    }, async () => "b".repeat(64)],
    ["rejects scope mismatch", () => ({
      workspaceId: workspaceB, nodeId: nodeA, doc: createLoroPage().doc, descriptor: descriptor(nodeA, 2, "b")
    }), async () => "b".repeat(64)],
    ["rejects noncanonical snapshot digest", () => ({
      workspaceId: workspaceA,
      nodeId: nodeA,
      doc: createLoroPage().doc,
      descriptor: {
        ...descriptor(nodeA, 2, "b"),
        loro: { schemaVersion: 1, snapshotSha256: "B".repeat(64) }
      } as Extract<PageDocumentDescriptor, { activeFormat: "loro-v1" }>
    }), async () => "B".repeat(64)],
    ["rejects snapshot digest mismatch", () => ({
      workspaceId: workspaceA, nodeId: nodeA, doc: createLoroPage().doc, descriptor: descriptor(nodeA, 2, "b")
    }), async () => "a".repeat(64)],
    ["rejects a noncanonical export digest", () => ({
      workspaceId: workspaceA, nodeId: nodeA, doc: createLoroPage().doc, descriptor: descriptor(nodeA, 2, "b")
    }), async () => "B".repeat(64)]
  ])("%s and retains the exact frozen A/B conflict custody", async (_label, makeCandidate, snapshotDigest) => {
    vi.useFakeTimers()
    try {
      const registry = new LoroSemanticCustodyRegistry()
      const runtime = Object.freeze({})
      const connection = Object.freeze({})
      const page = createLoroPage()
      const response = deferred<LoroCheckpointTransportResult>()
      const attachment = registry.attach({
        runtime, runtimeConnectionIdentity: connection, workspaceId: workspaceA, nodeId: nodeA,
        initial: { doc: page.doc, descriptor: descriptor(nodeA) },
        makeIntent: () => ({ requestId: "verify-A", commitMessage: "Edit daily note", attribution: { kind: "humanUi", surface: "rich-text-editor" } } as never),
        transport: () => response.promise,
        loadAuthority: async () => makeCandidate() as LoroAuthorityReload,
        snapshotDigest: snapshotDigest as (doc: ReturnType<typeof createLoroPage>["doc"]) => Promise<string>,
        debounceMs: 10, clock: injectedClock
      })
      edit(attachment.snapshot().workingDraft!, "A", "one")
      attachment.noteHumanEdit()
      await vi.advanceTimersByTimeAsync(10)
      const frozenA = attachment.snapshot().frozenA
      const frozenBytes = Array.from(frozenA!.update)
      edit(attachment.snapshot().workingDraft!, "B", "two")
      attachment.noteHumanEdit()
      response.reject({ _tag: "LoroContentConflict" })
      await flush()

      await expect(attachment.discardAndReload()).resolves.toBe(false)
      const snapshot = attachment.snapshot()
      expect(snapshot.state).toBe("retainedConflict")
      expect(snapshot.frozenA).toBe(frozenA)
      expect(Array.from(snapshot.frozenA!.update)).toEqual(frozenBytes)
      expect(snapshot.workingDraft!.getMap("athenaeum-page-meta-v1").get("B")).toBe("two")
    } finally {
      vi.useRealTimers()
    }
  })

  it("rejects invalid explicit reload for retained request identity without clearing exact A or B", async () => {
    vi.useFakeTimers()
    try {
      const registry = new LoroSemanticCustodyRegistry()
      const runtime = Object.freeze({})
      const connection = Object.freeze({})
      const page = createLoroPage()
      const response = deferred<LoroCheckpointTransportResult>()
      const attachment = registry.attach({
        runtime, runtimeConnectionIdentity: connection, workspaceId: workspaceA, nodeId: nodeA,
        initial: { doc: page.doc, descriptor: descriptor(nodeA) },
        makeIntent: () => ({ requestId: "identity-verify-A", commitMessage: "Edit daily note", attribution: { kind: "humanUi", surface: "rich-text-editor" } } as never),
        transport: () => response.promise,
        loadAuthority: async () => ({
          workspaceId: workspaceA, nodeId: nodeA, doc: createLoroPage().doc,
          descriptor: { ...descriptor(nodeA, 2, "b"), loro: { schemaVersion: 1, snapshotSha256: "B".repeat(64) } } as Extract<PageDocumentDescriptor, { activeFormat: "loro-v1" }>
        }),
        snapshotDigest: async () => "B".repeat(64),
        debounceMs: 10, clock: injectedClock
      })
      edit(attachment.snapshot().workingDraft!, "A", "one")
      attachment.noteHumanEdit()
      await vi.advanceTimersByTimeAsync(10)
      const frozenA = attachment.snapshot().frozenA
      const frozenBytes = Array.from(frozenA!.update)
      edit(attachment.snapshot().workingDraft!, "B", "two")
      attachment.noteHumanEdit()
      response.reject({ _tag: "RequestIdentityConflict" })
      await flush()

      await expect(attachment.discardAndReload()).resolves.toBe(false)
      const snapshot = attachment.snapshot()
      expect(snapshot.state).toBe("retainedRequestIdentity")
      expect(snapshot.frozenA).toBe(frozenA)
      expect(Array.from(snapshot.frozenA!.update)).toEqual(frozenBytes)
      expect(snapshot.workingDraft!.getMap("athenaeum-page-meta-v1").get("B")).toBe("two")
    } finally {
      vi.useRealTimers()
    }
  })

  it("clears retained A and B atomically only after a verified explicit authority reload", async () => {
    vi.useFakeTimers()
    try {
      const registry = new LoroSemanticCustodyRegistry()
      const runtime = Object.freeze({})
      const connection = Object.freeze({})
      const page = createLoroPage()
      const response = deferred<LoroCheckpointTransportResult>()
      const authority = createLoroPage().doc
      const attachment = registry.attach({
        runtime, runtimeConnectionIdentity: connection, workspaceId: workspaceA, nodeId: nodeA,
        initial: { doc: page.doc, descriptor: descriptor(nodeA) },
        makeIntent: () => ({ requestId: "reload-A", commitMessage: "Edit daily note", attribution: { kind: "humanUi", surface: "rich-text-editor" } } as never),
        transport: () => response.promise,
        loadAuthority: async () => ({
          workspaceId: workspaceA, nodeId: nodeA, doc: authority, descriptor: descriptor(nodeA, 2, "b")
        }),
        snapshotDigest: async () => "b".repeat(64),
        debounceMs: 10, clock: injectedClock
      })
      edit(attachment.snapshot().workingDraft!, "A", "one")
      attachment.noteHumanEdit()
      await vi.advanceTimersByTimeAsync(10)
      edit(attachment.snapshot().workingDraft!, "B", "two")
      attachment.noteHumanEdit()
      response.reject({ _tag: "LoroContentConflict" })
      await flush()

      await expect(attachment.discardAndReload()).resolves.toBe(true)
      const snapshot = attachment.snapshot()
      expect(snapshot.state).toBe("clean")
      expect(snapshot.frozenA).toBeUndefined()
      expect(snapshot.workingDraft!.getMap("athenaeum-page-meta-v1").get("B")).toBeUndefined()
      attachment.detach()
      expect(registry.hasOwner(runtime, workspaceA, nodeA)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("fails closed on a same-key witness mismatch without starting a second transport", async () => {
    vi.useFakeTimers()
    try {
      const registry = new LoroSemanticCustodyRegistry()
      const runtime = Object.freeze({})
      const connection = Object.freeze({})
      const page = createLoroPage()
      const pending = deferred<LoroCheckpointTransportResult>()
      const transport = vi.fn(() => pending.promise)
      const options = {
        runtime, runtimeConnectionIdentity: connection, workspaceId: workspaceA, nodeId: nodeA,
        initial: { doc: page.doc, descriptor: descriptor(nodeA) },
        makeIntent: () => ({ requestId: "A", commitMessage: "Edit daily note", attribution: { kind: "humanUi", surface: "rich-text-editor" } } as never),
        transport,
        loadAuthority: async () => { throw new Error("not used") },
        debounceMs: 10, clock: injectedClock
      }
      const current = registry.attach(options)
      edit(current.snapshot().workingDraft!, "A", "one")
      current.noteHumanEdit()
      await vi.advanceTimersByTimeAsync(10)
      const stale = registry.attach({ ...options, initial: { doc: createLoroPage().doc, descriptor: descriptor(nodeA, 2, "b") } })
      expect(stale.snapshot().active).toBe(false)
      expect(stale.snapshot().bindable).toBe(false)
      expect(stale.snapshot().failure).toBe("witnessMismatch")
      expect(stale.noteHumanEdit()).toBe(false)
      expect(transport).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("never adopts custody across workspace, node, runtime, or connection identity", () => {
    const registry = new LoroSemanticCustodyRegistry()
    const runtimeA = Object.freeze({})
    const runtimeB = Object.freeze({})
    const connectionA = Object.freeze({})
    const connectionB = Object.freeze({})
    const page = createLoroPage()
    const base = {
      initial: { doc: page.doc, descriptor: descriptor(nodeA) },
      makeIntent: () => ({ requestId: "A", commitMessage: "Edit daily note", attribution: { kind: "humanUi", surface: "rich-text-editor" } } as never),
      transport: async () => { throw new Error("not used") },
      loadAuthority: async () => { throw new Error("not used") },
      clock: injectedClock
    }
    const same = registry.attach({ ...base, runtime: runtimeA, runtimeConnectionIdentity: connectionA, workspaceId: workspaceA, nodeId: nodeA })
    const otherWorkspace = registry.attach({ ...base, runtime: runtimeA, runtimeConnectionIdentity: connectionA, workspaceId: workspaceB, nodeId: nodeA })
    const otherNode = registry.attach({ ...base, runtime: runtimeA, runtimeConnectionIdentity: connectionA, workspaceId: workspaceA, nodeId: nodeB, initial: { doc: createLoroPage().doc, descriptor: descriptor(nodeB) } })
    const otherRuntime = registry.attach({ ...base, runtime: runtimeB, runtimeConnectionIdentity: connectionB, workspaceId: workspaceA, nodeId: nodeA })
    const wrongConnection = registry.attach({ ...base, runtime: runtimeA, runtimeConnectionIdentity: connectionB, workspaceId: workspaceA, nodeId: nodeA })
    expect(otherWorkspace.snapshot().workingDraft).not.toBe(same.snapshot().workingDraft)
    expect(otherNode.snapshot().workingDraft).not.toBe(same.snapshot().workingDraft)
    expect(otherRuntime.snapshot().workingDraft).not.toBe(same.snapshot().workingDraft)
    expect(wrongConnection.snapshot().failure).toBe("runtimeScopeMismatch")
  })

  it("retires an unattached owner only after its detached A then B both accept", async () => {
    vi.useFakeTimers()
    try {
      const registry = new LoroSemanticCustodyRegistry()
      const runtime = Object.freeze({})
      const connection = Object.freeze({})
      const page = createLoroPage()
      const results = [deferred<LoroCheckpointTransportResult>(), deferred<LoroCheckpointTransportResult>()]
      const flights: FrozenLoroIntent[] = []
      let attachment: ReturnType<typeof registry.attach>
      const transport = (flight: FrozenLoroIntent) => {
        flights.push(flight)
        return results[flights.length - 1]!.promise
      }
      attachment = registry.attach({
        runtime, runtimeConnectionIdentity: connection, workspaceId: workspaceA, nodeId: nodeA,
        initial: { doc: page.doc, descriptor: descriptor(nodeA) },
        makeIntent: () => ({ requestId: `A-${flights.length + 1}`, commitMessage: "Edit daily note", attribution: { kind: "humanUi", surface: "rich-text-editor" } } as never),
        transport,
        loadAuthority: async () => { throw new Error("not used") },
        debounceMs: 10, clock: injectedClock
      })
      edit(attachment.snapshot().workingDraft!, "A", "one")
      attachment.noteHumanEdit()
      await vi.advanceTimersByTimeAsync(10)
      edit(attachment.snapshot().workingDraft!, "B", "two")
      attachment.noteHumanEdit()
      attachment.detach()
      expect(registry.hasOwner(runtime, workspaceA, nodeA)).toBe(true)

      results[0]!.resolve(resultFor(attachment.snapshot().acceptedBase!.doc, flights[0]!, 2, "b"))
      await flush()
      await vi.advanceTimersByTimeAsync(10)
      expect(flights).toHaveLength(2)
      expect(registry.hasOwner(runtime, workspaceA, nodeA)).toBe(true)
      results[1]!.resolve(resultFor(attachment.snapshot().acceptedBase!.doc, flights[1]!, 3, "c"))
      await flush()
      expect(registry.hasOwner(runtime, workspaceA, nodeA)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
