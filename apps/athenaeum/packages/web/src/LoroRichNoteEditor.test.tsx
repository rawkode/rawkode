// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest"
import { EditorState } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import { LoroSyncPlugin, loroSyncPluginKey, updateLoroToPmState, type LoroDocType } from "loro-prosemirror"
import { type PageDocumentDescriptor } from "@athenaeum/domain"
import { act } from "react"
import { createRoot } from "react-dom/client"

const runtimeMock = vi.hoisted(() => ({ runPromise: vi.fn() }))
const runtimeConnectionIdentityMock = vi.hoisted(() => ({ current: Object.freeze({}) }))
vi.mock("./runtime.js", () => ({
  runtime: runtimeMock,
  get runtimeConnectionIdentity() { return runtimeConnectionIdentityMock.current }
}))

import { LORO_CUSTODY_PRESENTATION_POLL_MS, createLoroEditorBinding, createSerializedLoroSyncQueue, isHumanLoroDocumentTransaction, LoroConflictNotice, LoroRichNoteEditor, LoroSemanticCheckpointCoordinator, type LoroCheckpointTransportResult } from "./LoroRichNoteEditor.js"
import { createLoroPage, inspectLoroPage, loroPagePmContainerId } from "./loro-page.js"
import { richTextSchemaAdapter } from "./rich-text/schema.js"
import { CheckpointedLoroWriter, type FrozenLoroIntent } from "./checkpointed-loro-writer.js"
import { LoroSemanticCustodyRegistry } from "./loro-semantic-custody.js"
import editorSource from "./LoroRichNoteEditor.tsx?raw"
import legacyEditorSource from "./RichNoteEditor.tsx?raw"

const testDescriptor = (storageVersion = 1, byte = "a") => ({
  nodeId: "00000000-0000-4000-8000-000000000002",
  storageVersion,
  activeFormat: "loro-v1" as const,
  loro: { schemaVersion: 1, snapshotSha256: byte.repeat(64) }
}) as unknown as Extract<PageDocumentDescriptor, { activeFormat: "loro-v1" }>

const deferredResult = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

/** Wait for the real LoroSyncPlugin `update-state` init transaction, never synthesize it. */
const flushOfficialLoroPluginInit = async (
  currentView: () => EditorView,
  previousView?: EditorView
): Promise<EditorView> => {
  for (let round = 0; round < 8; round += 1) {
    const view = currentView()
    if (view !== previousView && loroSyncPluginKey.getState(view.state)?.snapshot === null) return view
    await Promise.resolve()
    // A rebind is delivered through a Promise continuation; only then is the official plugin's
    // zero-delay init timer registered. Advance the next real timer rather than synthesizing an
    // update transaction or assuming one microtask is enough.
    if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync()
    else await vi.advanceTimersByTimeAsync(0)
  }
  throw new Error("official LoroSyncPlugin did not reach its snapshot-ready state")
}

describe("serialized Loro editor sync queue", () => {
  const deferred = () => {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    return { promise, resolve, reject }
  }

  it("retries a failed debounced sync with backoff", async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const queue = createSerializedLoroSyncQueue(() => {
        calls += 1
        return calls === 1 ? Promise.reject(new Error("temporary sync failure")) : Promise.resolve()
      }, 10)

      queue.schedule()
      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toBe(1)

      await vi.advanceTimersByTimeAsync(100)

      expect(calls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("serializes overlapping syncs and retains work scheduled during a request", async () => {
    let active = 0
    let maximumActive = 0
    let calls = 0
    const releases: Array<() => void> = []
    const queue = createSerializedLoroSyncQueue(() => {
      calls += 1
      active += 1
      maximumActive = Math.max(maximumActive, active)
      return new Promise<void>((resolve) => {
        releases.push(() => {
          active -= 1
          resolve()
        })
      })
    }, 60_000)

    queue.schedule()
    const first = queue.flush()
    await Promise.resolve()
    queue.schedule()
    const second = queue.flush()
    await Promise.resolve()

    expect(calls).toBe(1)
    expect(maximumActive).toBe(1)
    releases.shift()!()
    await first
    await Promise.resolve()
    expect(calls).toBe(2)
    expect(maximumActive).toBe(1)
    releases.shift()!()
    await second
  })

  it("retains a newer scheduled value after an older sync succeeds", async () => {
    const values = ["A", "B"]
    const consumed: string[] = []
    const first = deferred()
    const second = deferred()
    const queue = createSerializedLoroSyncQueue(() => {
      consumed.push(values.shift()!)
      return consumed.length === 1 ? first.promise : second.promise
    }, 60_000)

    queue.schedule()
    const firstFlush = queue.flush()
    await Promise.resolve()
    queue.schedule()

    first.resolve()
    await firstFlush
    expect(consumed).toEqual(["A"])

    const secondFlush = queue.flush()
    await Promise.resolve()
    expect(consumed).toEqual(["A", "B"])
    second.resolve()
    await secondFlush
    expect(consumed).toEqual(["A", "B"])
  })

  it("retains a newer scheduled value after an older sync fails", async () => {
    const values = ["A", "B"]
    const consumed: string[] = []
    const first = deferred()
    const queue = createSerializedLoroSyncQueue(() => {
      consumed.push(values.shift()!)
      return consumed.length === 1 ? first.promise : Promise.resolve()
    }, 60_000)

    queue.schedule()
    const firstFlush = queue.flush()
    await Promise.resolve()
    queue.schedule()
    first.reject(new Error("A failed"))
    await expect(firstFlush).rejects.toThrow("A failed")

    await queue.flush()
    expect(consumed).toEqual(["A", "B"])
    await queue.flush()
    expect(consumed).toEqual(["A", "B"])
  })

  it("does not recreate a claimed newer value when an older request fails", async () => {
    const values = ["A", "B"]
    const consumed: string[] = []
    let active = 0
    let maximumActive = 0
    const first = deferred()
    const second = deferred()
    const queue = createSerializedLoroSyncQueue(() => {
      const value = values.shift()!
      consumed.push(value)
      active += 1
      maximumActive = Math.max(maximumActive, active)
      const completion = value === "A" ? first.promise : second.promise
      return completion.finally(() => {
        active -= 1
      })
    }, 60_000)

    queue.schedule()
    const firstFlush = queue.flush()
    await Promise.resolve()
    queue.schedule()
    const secondFlush = queue.flush()
    await Promise.resolve()
    expect(consumed).toEqual(["A"])
    expect(maximumActive).toBe(1)

    first.reject(new Error("A failed"))
    await expect(firstFlush).rejects.toThrow("A failed")
    await Promise.resolve()
    expect(consumed).toEqual(["A", "B"])
    expect(maximumActive).toBe(1)

    second.resolve()
    await secondFlush
    await queue.flush()
    expect(consumed).toEqual(["A", "B"])
    expect(maximumActive).toBe(1)
  })

  it("flushes dirty work immediately during teardown", async () => {
    let resolveSync: (() => void) | undefined
    let calls = 0
    const queue = createSerializedLoroSyncQueue(() => {
      calls += 1
      return new Promise<void>((resolve) => {
        resolveSync = resolve
      })
    }, 60_000)

    queue.schedule()
    const disposed = queue.dispose()
    await Promise.resolve()
    expect(calls).toBe(1)
    resolveSync!()
    await disposed
    expect(calls).toBe(1)
  })

  it("retains a failed sync for one bounded teardown retry", async () => {
    let calls = 0
    const queue = createSerializedLoroSyncQueue(() => {
      calls += 1
      return calls === 1 ? Promise.reject(new Error("temporary sync failure")) : Promise.resolve()
    }, 60_000)

    queue.schedule()
    await expect(queue.flush()).rejects.toThrow("temporary sync failure")

    await queue.dispose()

    expect(calls).toBe(2)
  })
})

describe("Loro semantic checkpoint coordinator", () => {
  it("keeps the production semantic editor off the legacy nonempty raw-sync path", () => {
    expect(editorSource).toContain("commitLoroPageContent")
    expect(editorSource).not.toContain("syncLoroPageWithServer")
  })

  it("uses real EditorView dispatch/rebind wiring: init/import do not commit, then A and B commit serially", async () => {
    vi.useFakeTimers()
    try {
      const writer = new CheckpointedLoroWriter({ doc: createLoroPage().doc, descriptor: testDescriptor() })
      const first = deferredResult<LoroCheckpointTransportResult>()
      const second = deferredResult<LoroCheckpointTransportResult>()
      const flights: Array<{ requestId: string; update: Uint8Array }> = []
      let calls = 0
      let binding!: ReturnType<typeof createLoroEditorBinding>
      const coordinator = new LoroSemanticCheckpointCoordinator({
        writer,
        debounceMs: 10,
        intent: () => ({ requestId: `editor-request-${calls + 1}`, commitMessage: "Edit daily note", attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor" } } as never),
        transport: (flight) => {
          calls += 1
          flights.push({ requestId: flight.requestId, update: flight.update })
          return (calls === 1 ? first : second).promise
        },
        onFreeze: () => binding.rebind(),
        onAccepted: () => binding.rebind(),
        onConflict: () => undefined,
        onError: () => undefined
      })
      binding = createLoroEditorBinding({
        container: document.createElement("div"),
        writer,
        coordinator,
        workspaceId: "00000000-0000-4000-8000-000000000001" as never,
        nodeId: "00000000-0000-4000-8000-000000000002" as never,
        onSupertagApplied: () => undefined
      })

      expect(binding.view!.dom.dataset.empty).toBe("true")
      expect(binding.view!.dom.getAttribute("aria-placeholder")).toBe("Start with what matters. Use # to connect a person or project; @ to link context.")

      // The real official plugin creates init/import transactions, but neither can reach transport.
      await vi.advanceTimersByTimeAsync(0)
      const remote = writer.workingDraft.fork()
      const remoteDoc = richTextSchemaAdapter.schema.node("doc", undefined, [
        richTextSchemaAdapter.schema.node("paragraph", undefined, richTextSchemaAdapter.schema.text("remote"))
      ])
      updateLoroToPmState(remote as LoroDocType, new Map(), EditorState.create({ schema: richTextSchemaAdapter.schema, doc: remoteDoc }), inspectLoroPage(writer.workingDraft).pmRoot.id)
      writer.workingDraft.import(remote.export({ mode: "update", from: writer.workingDraft.version() }))
      await Promise.resolve()
      expect(calls).toBe(0)

      binding.view!.dispatch(binding.view!.state.tr.insertText("A", 1))
      expect(binding.view!.dom.dataset.empty).toBeUndefined()
      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toBe(1)
      const a = writer.inFlight!

      // onFreeze re-bound the real view to a fresh B replica; B is not in A and cannot dispatch concurrently.
      binding.view!.dispatch(binding.view!.state.tr.insertText("B", 1))
      expect(calls).toBe(1)
      const authoritativeA = writer.acceptedBase.doc.fork()
      authoritativeA.import(a.update)
      first.resolve({
        authoritative: { doc: authoritativeA, descriptor: testDescriptor(2, "b") },
        receipt: { storageVersion: 2, resultSnapshotSha256: "b".repeat(64) } as never
      })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(0)
      // onAccepted re-bound the actual EditorView to authority+B before B's later batch freezes.
      expect(binding.view!.state.doc.textContent).toContain("B")
      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toBe(2)
      const b = writer.inFlight!
      expect(flights[0]!.requestId).not.toBe(flights[1]!.requestId)
      const afterB = authoritativeA.fork()
      afterB.import(b.update)
      expect(b.update).not.toEqual(a.update)
      second.resolve({
        authoritative: { doc: afterB, descriptor: testDescriptor(3, "c") },
        receipt: { storageVersion: 3, resultSnapshotSha256: "c".repeat(64) } as never
      })
      await coordinator.flush()
      binding.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it("serializes A then B, retries immutable A after response loss, and never overlaps requests", async () => {
    vi.useFakeTimers()
    try {
      const writer = new CheckpointedLoroWriter({ doc: createLoroPage().doc, descriptor: testDescriptor() })
      writer.workingDraft.getMap("athenaeum-page-meta-v1").set("A", "one")
      writer.workingDraft.commit()
      const first = deferredResult<LoroCheckpointTransportResult>()
      const retryA = deferredResult<LoroCheckpointTransportResult>()
      const second = deferredResult<LoroCheckpointTransportResult>()
      const flights: Array<{ requestId: string; update: Uint8Array }> = []
      let active = 0
      let maximumActive = 0
      let calls = 0
      const coordinator = new LoroSemanticCheckpointCoordinator({
        writer,
        debounceMs: 10,
        intent: () => ({ requestId: `request-${calls + 1}`, commitMessage: "Edit daily note", attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor" } } as never),
        transport: (flight) => {
          calls += 1
          flights.push({ requestId: flight.requestId, update: flight.update })
          active += 1
          maximumActive = Math.max(maximumActive, active)
          const deferred = calls === 1 ? first : calls === 2 ? retryA : second
          return deferred.promise.finally(() => { active -= 1 })
        },
        onFreeze: () => undefined,
        onAccepted: () => undefined,
        onConflict: () => undefined,
        onError: () => undefined
      })

      coordinator.noteHumanEdit()
      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toBe(1)
      const a = writer.inFlight!

      // B is edited in the fresh post-freeze replica and recorded, not dispatched.
      writer.workingDraft.getMap("athenaeum-page-meta-v1").set("B", "two")
      writer.workingDraft.commit()
      coordinator.noteHumanEdit()
      expect(calls).toBe(1)

      // A loses its response. The queue retries byte-for-byte with the same request identity.
      first.reject(new Error("response lost"))
      await vi.advanceTimersByTimeAsync(100)
      expect(calls).toBe(2)
      expect(flights[1]).toEqual(flights[0])
      expect(maximumActive).toBe(1)

      const authoritativeA = writer.acceptedBase.doc.fork()
      authoritativeA.import(a.update)
      retryA.resolve({
        authoritative: { doc: authoritativeA, descriptor: testDescriptor(2, "b") },
        receipt: { storageVersion: 2, resultSnapshotSha256: "b".repeat(64) } as never
      })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toBe(3)
      expect(maximumActive).toBe(1)

      const b = writer.inFlight!
      const afterB = authoritativeA.fork()
      afterB.import(b.update)
      expect(afterB.getMap("athenaeum-page-meta-v1").get("A")).toBe("one")
      expect(afterB.getMap("athenaeum-page-meta-v1").get("B")).toBe("two")
      second.resolve({
        authoritative: { doc: afterB, descriptor: testDescriptor(3, "c") },
        receipt: { storageVersion: 3, resultSnapshotSha256: "c".repeat(64) } as never
      })
      await coordinator.flush()
    } finally {
      vi.useRealTimers()
    }
  })

  it("enters terminal conflict with B retained and will not publish again before explicit recovery", async () => {
    vi.useFakeTimers()
    try {
      const writer = new CheckpointedLoroWriter({ doc: createLoroPage().doc, descriptor: testDescriptor() })
      writer.workingDraft.getMap("athenaeum-page-meta-v1").set("A", "one")
      writer.workingDraft.commit()
      let calls = 0
      let conflicts = 0
      const coordinator = new LoroSemanticCheckpointCoordinator({
        writer,
        debounceMs: 10,
        intent: () => ({ requestId: "request-a", commitMessage: "Edit daily note", attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor" } } as never),
        transport: async () => {
          calls += 1
          throw { _tag: "LoroContentConflict" }
        },
        onFreeze: () => undefined,
        onAccepted: () => undefined,
        onConflict: () => { conflicts += 1 },
        onError: () => undefined
      })
      coordinator.noteHumanEdit()
      await vi.advanceTimersByTimeAsync(10)
      writer.workingDraft.getMap("athenaeum-page-meta-v1").set("B", "two")
      writer.workingDraft.commit()
      coordinator.noteHumanEdit()
      await Promise.resolve()
      expect(coordinator.conflicted).toBe(true)
      expect(conflicts).toBe(1)
      expect(writer.workingDraft.getMap("athenaeum-page-meta-v1").get("B")).toBe("two")
      coordinator.noteHumanEdit()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(calls).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("drains a pending semantic request on navigation/unmount instead of dropping it", async () => {
    vi.useFakeTimers()
    try {
      const writer = new CheckpointedLoroWriter({ doc: createLoroPage().doc, descriptor: testDescriptor() })
      writer.workingDraft.getMap("athenaeum-page-meta-v1").set("stale", "draft")
      writer.workingDraft.commit()
      const requests: string[] = []
      const coordinator = new LoroSemanticCheckpointCoordinator({
        writer,
        debounceMs: 10,
        intent: () => ({ requestId: "stale", commitMessage: "Edit daily note", attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor" } } as never),
        transport: async (flight) => {
          requests.push(flight.requestId)
          const authority = writer.acceptedBase.doc.fork()
          authority.import(flight.update)
          return {
            authoritative: { doc: authority, descriptor: testDescriptor(2, "b") },
            receipt: { storageVersion: 2, resultSnapshotSha256: "b".repeat(64) } as never
          }
        },
        onFreeze: () => undefined,
        onAccepted: () => undefined,
        onConflict: () => undefined,
        onError: () => undefined
      })
      coordinator.noteHumanEdit()
      await coordinator.dispose()
      expect(requests).toEqual(["stale"])
      expect(writer.inFlight).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it("drains an already-recorded B after A when unmount begins during A flight", async () => {
    vi.useFakeTimers()
    try {
      const writer = new CheckpointedLoroWriter({ doc: createLoroPage().doc, descriptor: testDescriptor() })
      writer.workingDraft.getMap("athenaeum-page-meta-v1").set("A", "one")
      writer.workingDraft.commit()
      const aResult = deferredResult<LoroCheckpointTransportResult>()
      const bResult = deferredResult<LoroCheckpointTransportResult>()
      const flights: FrozenLoroIntent[] = []
      const coordinator = new LoroSemanticCheckpointCoordinator({
        writer,
        debounceMs: 10,
        intent: () => ({ requestId: `drain-${flights.length + 1}`, commitMessage: "Edit daily note", attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor" } } as never),
        transport: (flight) => {
          flights.push(flight)
          return flights.length === 1 ? aResult.promise : bResult.promise
        },
        onFreeze: () => undefined,
        onAccepted: () => undefined,
        onConflict: () => undefined,
        onError: () => undefined
      })
      coordinator.noteHumanEdit()
      await vi.advanceTimersByTimeAsync(10)
      writer.workingDraft.getMap("athenaeum-page-meta-v1").set("B", "two")
      writer.workingDraft.commit()
      coordinator.noteHumanEdit()

      const drain = coordinator.dispose()
      const authorityA = writer.acceptedBase.doc.fork()
      authorityA.import(flights[0]!.update)
      aResult.resolve({
        authoritative: { doc: authorityA, descriptor: testDescriptor(2, "b") },
        receipt: { storageVersion: 2, resultSnapshotSha256: "b".repeat(64) } as never
      })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(flights).toHaveLength(2)
      const authorityB = authorityA.fork()
      authorityB.import(flights[1]!.update)
      bResult.resolve({
        authoritative: { doc: authorityB, descriptor: testDescriptor(3, "c") },
        receipt: { storageVersion: 3, resultSnapshotSha256: "c".repeat(64) } as never
      })
      await drain
      expect(writer.inFlight).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it("treats request-identity reuse as terminal and never mints a replacement request", async () => {
    vi.useFakeTimers()
    try {
      const writer = new CheckpointedLoroWriter({ doc: createLoroPage().doc, descriptor: testDescriptor() })
      writer.workingDraft.getMap("athenaeum-page-meta-v1").set("A", "one")
      writer.workingDraft.commit()
      let calls = 0
      const coordinator = new LoroSemanticCheckpointCoordinator({
        writer,
        debounceMs: 10,
        intent: () => ({ requestId: "request-a", commitMessage: "Edit daily note", attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor" } } as never),
        transport: async () => {
          calls += 1
          throw { _tag: "ValidationError", message: "request identity was already used for a different command" }
        },
        onFreeze: () => undefined,
        onAccepted: () => undefined,
        onConflict: () => undefined,
        onError: () => undefined
      })
      coordinator.noteHumanEdit()
      await vi.advanceTimersByTimeAsync(10)
      await Promise.resolve()
      expect(coordinator.terminal).toBe(true)
      coordinator.noteHumanEdit()
      coordinator.retry()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(calls).toBe(1)
      expect(writer.inFlight?.requestId).toBe("request-a")
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("Loro semantic transaction eligibility", () => {
  it("sends one semantic command only for a real unowned local PM edit, never plugin init or imported Loro state", async () => {
    vi.useFakeTimers()
    try {
      const page = createLoroPage()
      const root = document.createElement("div")
      const classified: boolean[] = []
      const registry = new LoroSemanticCustodyRegistry()
      const transportCalls: FrozenLoroIntent[] = []
      let attachment!: ReturnType<typeof registry.attach>
      attachment = registry.attach({
        runtime: Object.freeze({}),
        runtimeConnectionIdentity: Object.freeze({}),
        workspaceId: "00000000-0000-4000-8000-000000000001" as never,
        nodeId: "00000000-0000-4000-8000-000000000002" as never,
        initial: { doc: page.doc, descriptor: testDescriptor() },
        makeIntent: () => ({ requestId: `pm-${transportCalls.length + 1}`, commitMessage: "Edit daily note", attribution: { kind: "humanUi", surface: "rich-text-editor" } } as never),
        transport: async (flight) => {
          transportCalls.push(flight)
          const authority = attachment.snapshot().acceptedBase!.doc.fork()
          authority.import(flight.update)
          return {
            authoritative: { doc: authority, descriptor: testDescriptor(2, "b") },
            receipt: { storageVersion: 2, resultSnapshotSha256: "b".repeat(64) } as never
          }
        },
        loadAuthority: async () => { throw new Error("not used") },
        debounceMs: 10
      })
      const empty = richTextSchemaAdapter.schema.topNodeType.createAndFill()
      if (empty === null) throw new Error("schema has no empty document")
      let view: EditorView
      view = new EditorView(root, {
        state: EditorState.create({
          schema: richTextSchemaAdapter.schema,
          doc: empty,
          plugins: [LoroSyncPlugin({ doc: attachment.snapshot().workingDraft as LoroDocType, containerId: loroPagePmContainerId(inspectLoroPage(attachment.snapshot().workingDraft!)) })]
        }),
        dispatchTransaction(transaction) {
          const human = isHumanLoroDocumentTransaction(transaction)
          classified.push(human)
          view.updateState(view.state.apply(transaction))
          if (human) attachment.noteHumanEdit()
        }
      })

      // Official plugin initialization uses its owned `update-state` transaction.
      await vi.advanceTimersByTimeAsync(0)
      expect(classified).not.toContain(true)

      const remote = attachment.snapshot().workingDraft!.fork()
      const remoteDoc = richTextSchemaAdapter.schema.node("doc", undefined, [
        richTextSchemaAdapter.schema.node("paragraph", undefined, richTextSchemaAdapter.schema.text("remote"))
      ])
      updateLoroToPmState(remote as LoroDocType, new Map(), EditorState.create({
        schema: richTextSchemaAdapter.schema, doc: remoteDoc
      }), page.pmRoot.id)
      attachment.snapshot().workingDraft!.import(remote.export({ mode: "update", from: attachment.snapshot().workingDraft!.version() }))
      await Promise.resolve()

      // Imported state is dispatched by LoroSyncPlugin with `non-local-updates` ownership.
      expect(classified.filter(Boolean)).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(10)
      expect(transportCalls).toHaveLength(0)

      view.dispatch(view.state.tr.insertText("local", 1))
      expect(classified.filter(Boolean)).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(10)
      expect(transportCalls).toHaveLength(1)
      view.destroy()
      attachment.detach()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("Loro conflict notice", () => {
  it("renders an accessible explicit discard/reload action and never implies automatic recovery", async () => {
    const host = document.createElement("div")
    const root = createRoot(host)
    const discard = vi.fn()
    await act(async () => {
      root.render(<LoroConflictNotice state="conflict" onDiscardAndReload={discard} />)
    })
    const alert = host.querySelector('[role="alert"]')
    const button = host.querySelector("button")
    expect(alert?.textContent).toContain("local draft is preserved")
    expect(button?.textContent).toBe("Reload and discard local draft")
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(discard).toHaveBeenCalledTimes(1)
    await act(async () => {
      root.render(<LoroConflictNotice state="resolving" onDiscardAndReload={discard} />)
    })
    expect(host.querySelector("button")).toBeNull()
    await act(async () => {
      root.render(<LoroConflictNotice state="externalCommitFailed" onDiscardAndReload={discard} />)
    })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("authoritative reload failed")
    expect(host.querySelector("button")?.textContent).toBe("Retry authoritative reload")
    root.unmount()
  })
})

describe("Loro editor custody UI", () => {
  it("renders the retained-conflict action through the live component and keeps the draft read-only", async () => {
    vi.useFakeTimers()
    const host = document.createElement("div")
    const root = createRoot(host)
    const pending = deferredResult<LoroCheckpointTransportResult>()
    let binding: ReturnType<typeof createLoroEditorBinding> | undefined
    try {
      runtimeMock.runPromise.mockReset()
      runtimeMock.runPromise.mockReturnValueOnce(pending.promise).mockReturnValueOnce(new Promise(() => undefined))
      await act(async () => {
        root.render(
          <LoroRichNoteEditor
            workspaceId={"00000000-0000-4000-8000-000000000021" as never}
            nodeId={"00000000-0000-4000-8000-000000000002" as never}
            initialPage={createLoroPage()}
            initialDescriptor={testDescriptor()}
            onSyncStatusChange={() => undefined}
            onSupertagApplied={() => undefined}
            onBindingReady={(next) => { binding = next }}
          />
        )
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      binding!.view!.dispatch(binding!.view!.state.tr.insertText("A", 1))
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      pending.reject({ _tag: "LoroContentConflict" })
      await act(async () => {
        await Promise.resolve()
        await vi.advanceTimersByTimeAsync(LORO_CUSTODY_PRESENTATION_POLL_MS)
      })

      const alert = host.querySelector('[role="alert"]')
      const button = host.querySelector(".sync-status-retry") as HTMLButtonElement | null
      expect(alert?.textContent).toContain("local draft is preserved")
      expect(button?.textContent).toBe("Reload and discard local draft")
      expect(binding!.view?.editable).toBe(false)
      await act(async () => {
        button?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
        await Promise.resolve()
        await vi.advanceTimersByTimeAsync(LORO_CUSTODY_PRESENTATION_POLL_MS)
      })
      expect(runtimeMock.runPromise).toHaveBeenCalledTimes(2)
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("Reloading authoritative note")
    } finally {
      await act(async () => { root.unmount() })
      vi.useRealTimers()
    }
  })

  it("uses the live EditorView wiring to freeze A, rebind B, then checkpoint B after A accepts", async () => {
    vi.useFakeTimers()
    const host = document.createElement("div")
    const root = createRoot(host)
    const aResult = deferredResult<LoroCheckpointTransportResult>()
    const bResult = deferredResult<LoroCheckpointTransportResult>()
    const page = createLoroPage()
    let binding: ReturnType<typeof createLoroEditorBinding> | undefined
    try {
      runtimeMock.runPromise.mockReset()
      runtimeMock.runPromise.mockReturnValueOnce(aResult.promise).mockReturnValueOnce(bResult.promise)
      await act(async () => {
        root.render(
          <LoroRichNoteEditor
            workspaceId={"00000000-0000-4000-8000-000000000022" as never}
            nodeId={"00000000-0000-4000-8000-000000000002" as never}
            initialPage={page}
            initialDescriptor={testDescriptor()}
            onSyncStatusChange={() => undefined}
            onSupertagApplied={() => undefined}
            onBindingReady={(next) => { binding = next }}
          />
        )
      })
      expect(binding!.view!.editable).toBe(false)
      await act(async () => { await flushOfficialLoroPluginInit(() => binding!.view!) })
      const beforeFreeze = binding!.view
      expect(beforeFreeze!.editable).toBe(true)
      binding!.view!.dispatch(binding!.view!.state.tr.insertText("A", 1))
      expect(beforeFreeze!.state.doc.textContent).toContain("A")
      expect((loroSyncPluginKey.getState(beforeFreeze!.state)!.doc as LoroDocType).version().compare(page.doc.version())).toBe(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      const bDraftView = await act(async () => flushOfficialLoroPluginInit(() => binding!.view!, beforeFreeze))
      expect(bDraftView).not.toBe(beforeFreeze)
      expect(bDraftView!.state.doc.textContent).toContain("A")
      const bDraftLoro = loroSyncPluginKey.getState(bDraftView!.state)!.doc as LoroDocType
      expect(JSON.stringify(inspectLoroPage(bDraftLoro).pmRoot.toJSON())).toContain("A")
      const authorityA = page.doc.fork()
      authorityA.import(bDraftLoro.export({ mode: "update", from: page.doc.version() }))
      bDraftView!.dispatch(bDraftView!.state.tr.insertText("B", 2))
      expect(bDraftView!.state.doc.textContent).toContain("B")
      expect(runtimeMock.runPromise).toHaveBeenCalledTimes(1)

      aResult.resolve({
        authoritative: { doc: authorityA, descriptor: testDescriptor(2, "b") },
        receipt: { storageVersion: 2, resultSnapshotSha256: "b".repeat(64) } as never
      })
      await act(async () => { await flushOfficialLoroPluginInit(() => binding!.view!, bDraftView!) })
      expect(binding!.view!.state.doc.textContent).toContain("B")
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(runtimeMock.runPromise).toHaveBeenCalledTimes(2)
      bResult.resolve({
        authoritative: { doc: page.doc.fork(), descriptor: testDescriptor(3, "c") },
        receipt: { storageVersion: 3, resultSnapshotSha256: "c".repeat(64) } as never
      })
      await act(async () => { await Promise.resolve() })
    } finally {
      await act(async () => { root.unmount() })
      vi.useRealTimers()
    }
  })
})

describe("Loro editor React navigation lifecycle", () => {
  const workspace = "00000000-0000-4000-8000-000000000001" as never
  const nodeA = "00000000-0000-4000-8000-000000000002" as never
  const nodeB = "00000000-0000-4000-8000-000000000003" as never
  const nodeDetached = "00000000-0000-4000-8000-000000000004" as never

  it("does not call detached UI status or retry callbacks after an owner later changes", async () => {
    vi.useFakeTimers()
    const host = document.createElement("div")
    const root = createRoot(host)
    const delayedA = deferredResult<LoroCheckpointTransportResult>()
    void delayedA.promise.catch(() => undefined)
    const statuses: string[] = []
    const retryRegistrations: Array<(() => void) | undefined> = []
    let binding: ReturnType<typeof createLoroEditorBinding> | undefined
    try {
      runtimeMock.runPromise.mockReset()
      runtimeMock.runPromise.mockReturnValueOnce(delayedA.promise)
      await act(async () => {
        root.render(
          <LoroRichNoteEditor
            workspaceId={workspace}
            nodeId={nodeDetached}
            initialPage={createLoroPage()}
            initialDescriptor={testDescriptor()}
            onSyncStatusChange={(status) => statuses.push(status)}
            onSyncRetryReady={(retry) => retryRegistrations.push(retry)}
            onSupertagApplied={() => undefined}
            onBindingReady={(next) => { binding = next }}
          />
        )
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      binding!.view!.dispatch(binding!.view!.state.tr.insertText("A", 1))
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(runtimeMock.runPromise).toHaveBeenCalledTimes(1)

      await act(async () => { root.unmount() })
      const statusCountAtDetach = statuses.length
      const retryCountAtDetach = retryRegistrations.length
      delayedA.reject({ _tag: "LoroContentConflict" })
      await act(async () => {
        await Promise.resolve()
        await vi.advanceTimersByTimeAsync(LORO_CUSTODY_PRESENTATION_POLL_MS * 3)
      })

      expect(statuses).toHaveLength(statusCountAtDetach)
      expect(retryRegistrations).toHaveLength(retryCountAtDetach)
    } finally {
      if (host.childNodes.length > 0) await act(async () => { root.unmount() })
      vi.useRealTimers()
    }
  })

  it("locks an old binding and blocks DOM edits immediately after a connection switch", async () => {
    vi.useFakeTimers()
    const host = document.createElement("div")
    const root = createRoot(host)
    const previousConnectionIdentity = runtimeConnectionIdentityMock.current
    let binding: ReturnType<typeof createLoroEditorBinding> | undefined
    try {
      runtimeMock.runPromise.mockReset()
      await act(async () => {
        root.render(
          <LoroRichNoteEditor
            workspaceId={workspace}
            nodeId={nodeA}
            initialPage={createLoroPage()}
            initialDescriptor={testDescriptor()}
            onSyncStatusChange={() => undefined}
            onSupertagApplied={() => undefined}
            onBindingReady={(next) => { binding = next }}
          />
        )
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      const oldView = binding!.view!
      const before = oldView.state.doc.textContent
      expect(oldView.dom.getAttribute("contenteditable")).toBe("true")
      expect(oldView.dom.getAttribute("data-athenaeum-daily-note-editor")).toBe("true")
      runtimeConnectionIdentityMock.current = Object.freeze({})

      await act(async () => {
        await vi.advanceTimersByTimeAsync(LORO_CUSTODY_PRESENTATION_POLL_MS)
      })

      expect(oldView.editable).toBe(false)
      expect(oldView.dom.getAttribute("contenteditable")).toBe("false")
      expect(oldView.dom.getAttribute("data-athenaeum-daily-note-editor")).toBeNull()

      const beforeInput = new Event("beforeinput", { bubbles: true, cancelable: true })
      expect(oldView.dom.dispatchEvent(beforeInput)).toBe(false)
      expect(beforeInput.defaultPrevented).toBe(true)

      oldView.dispatch(oldView.state.tr.insertText("blocked", 1))
      expect(oldView.state.doc.textContent).toBe(before)
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(runtimeMock.runPromise).not.toHaveBeenCalled()
    } finally {
      runtimeConnectionIdentityMock.current = previousConnectionIdentity
      await act(async () => { root.unmount() })
      vi.useRealTimers()
    }
  })

  it("marks actual legacy and Loro ProseMirror roots rather than their React containers", () => {
    expect(legacyEditorSource).toContain('view.dom.setAttribute("data-athenaeum-daily-note-editor", "true")')
    expect(editorSource).toContain('currentView.dom.setAttribute("data-athenaeum-daily-note-editor", "true")')
    expect(editorSource).toContain('currentView.dom.removeAttribute("data-athenaeum-daily-note-editor")')
    expect(legacyEditorSource).not.toContain('className="daily-note-body rich-note-editor" data-athenaeum-daily-note-editor')
    expect(editorSource).not.toContain('className="daily-note-body rich-note-editor"\n        data-athenaeum-daily-note-editor')
  })

  it("drains A after navigation without letting delayed A success mutate the active B editor", async () => {
    vi.useFakeTimers()
    const host = document.createElement("div")
    const root = createRoot(host)
    const delayedA = deferredResult<LoroCheckpointTransportResult>()
    void delayedA.promise.catch(() => undefined)
    const statusesA: string[] = []
    const statusesB: string[] = []
    let bindingA: ReturnType<typeof createLoroEditorBinding> | undefined
    let bindingB: ReturnType<typeof createLoroEditorBinding> | undefined
    try {
      runtimeMock.runPromise.mockReset()
      runtimeMock.runPromise.mockReturnValueOnce(delayedA.promise)
      const pageA = createLoroPage()
      const pageB = createLoroPage()
      await act(async () => {
        root.render(
          <LoroRichNoteEditor
            workspaceId={workspace}
            nodeId={nodeA}
            initialPage={pageA}
            initialDescriptor={testDescriptor()}
            onSyncStatusChange={(status) => statusesA.push(status)}
            onSupertagApplied={() => undefined}
            onBindingReady={(binding) => { bindingA = binding }}
          />
        )
      })
      await act(async () => { await flushOfficialLoroPluginInit(() => bindingA!.view!) })
      bindingA!.view!.dispatch(bindingA!.view!.state.tr.insertText("A", 1))
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(runtimeMock.runPromise).toHaveBeenCalledTimes(1)

      // Route identity changes while A is in flight. Cleanup invalidates A's binding only.
      await act(async () => {
        root.render(
          <LoroRichNoteEditor
            workspaceId={workspace}
            nodeId={nodeB}
            initialPage={pageB}
            initialDescriptor={testDescriptor()}
            onSyncStatusChange={(status) => statusesB.push(status)}
            onSupertagApplied={() => undefined}
            onBindingReady={(binding) => { bindingB = binding }}
          />
        )
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      const activeB = bindingB!
      expect(activeB.view?.isDestroyed).toBe(false)

      delayedA.resolve({
        authoritative: { doc: pageA.doc.fork(), descriptor: testDescriptor(2, "b") },
        receipt: { storageVersion: 2, resultSnapshotSha256: "b".repeat(64) } as never
      })
      await act(async () => { await Promise.resolve() })

      expect(bindingB).toBe(activeB)
      expect(activeB.view?.isDestroyed).toBe(false)
      expect(statusesB).not.toContain("synced")
      expect(host.querySelectorAll('[contenteditable="true"]')).toHaveLength(1)
    } finally {
      await act(async () => { root.unmount() })
      vi.useRealTimers()
    }
  })

  it("does not render old A conflict UI or clobber B when A conflicts after navigation", async () => {
    vi.useFakeTimers()
    const host = document.createElement("div")
    const root = createRoot(host)
    const delayedA = deferredResult<LoroCheckpointTransportResult>()
    void delayedA.promise.catch(() => undefined)
    const statusesB: string[] = []
    let bindingA: ReturnType<typeof createLoroEditorBinding> | undefined
    let bindingB: ReturnType<typeof createLoroEditorBinding> | undefined
    try {
      runtimeMock.runPromise.mockReset()
      runtimeMock.runPromise.mockReturnValueOnce(delayedA.promise)
      const pageA = createLoroPage()
      const pageB = createLoroPage()
      await act(async () => {
        root.render(
          <LoroRichNoteEditor
            workspaceId={workspace}
            nodeId={nodeA}
            initialPage={pageA}
            initialDescriptor={testDescriptor()}
            onSyncStatusChange={() => undefined}
            onSupertagApplied={() => undefined}
            onBindingReady={(binding) => { bindingA = binding }}
          />
        )
      })
      await act(async () => { await flushOfficialLoroPluginInit(() => bindingA!.view!) })
      bindingA!.view!.dispatch(bindingA!.view!.state.tr.insertText("A", 1))
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      await act(async () => {
        root.render(
          <LoroRichNoteEditor
            workspaceId={workspace}
            nodeId={nodeB}
            initialPage={pageB}
            initialDescriptor={testDescriptor()}
            onSyncStatusChange={(status) => statusesB.push(status)}
            onSupertagApplied={() => undefined}
            onBindingReady={(binding) => { bindingB = binding }}
          />
        )
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      const activeB = bindingB!
      delayedA.reject({ _tag: "LoroContentConflict" })
      await act(async () => { await Promise.resolve() })

      expect(bindingB).toBe(activeB)
      expect(activeB.view?.isDestroyed).toBe(false)
      expect(statusesB).not.toContain("conflict")
      expect(host.querySelector('[role="alert"]')).toBeNull()
    } finally {
      await act(async () => { root.unmount() })
      vi.useRealTimers()
    }
  })
})
