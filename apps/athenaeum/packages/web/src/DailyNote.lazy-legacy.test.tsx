/** @vitest-environment happy-dom */

import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { describe, expect, it, vi } from "vitest"
import {
  CreationIntent,
  HumanUiMutationAttribution,
  PageNotFound,
  UnexpectedError,
  type EntityId,
  type PageDocumentDescriptor
} from "@athenaeum/domain"
import { createLoroPage } from "./loro-page.js"
import { loadLegacyDailyNote, resolveDailyNote } from "./DailyNote.js"
import type { LegacyDailyNoteCell, LegacyDailyNoteModule } from "./legacy-daily-note.js"
import type { WorkspaceRpcClientService } from "./rpc-client.js"

const nodeId = "00000000-0000-4000-8000-000000000002" as EntityId
const date = new Date("2026-08-27T12:00:00.000Z")
const creationIntent = new CreationIntent({
  requestId: "00000000-0000-4000-8000-000000000003",
  commitMessage: "Create daily note",
  attribution: new HumanUiMutationAttribution({
    version: "athenaeum.mutation-attribution.v1",
    kind: "humanUi",
    surface: "rich-text-editor"
  })
})

const EmptyLegacyEditor: LegacyDailyNoteModule["RichNoteEditor"] = () => <div />

const nativeLoroDescriptor = (id = nodeId): Extract<PageDocumentDescriptor, { activeFormat: "loro-v1" }> => ({
  nodeId: id,
  storageVersion: 1,
  activeFormat: "loro-v1",
  loro: { schemaVersion: 1, snapshotSha256: "native-loro-snapshot" }
} as Extract<PageDocumentDescriptor, { activeFormat: "loro-v1" }>)

const migratedLoroDescriptor = (): Extract<PageDocumentDescriptor, { activeFormat: "loro-v1" }> => ({
  nodeId,
  storageVersion: 2,
  activeFormat: "loro-v1",
  automerge: {
    docId: "legacy-doc",
    headsHash: "legacy-heads",
    bytesSha256: "legacy-bytes"
  },
  loro: { schemaVersion: 1, snapshotSha256: "migrated-loro-snapshot" }
} as Extract<PageDocumentDescriptor, { activeFormat: "loro-v1" }>)

const makeLoroClient = (
  descriptor: PageDocumentDescriptor | undefined,
  options: { readonly createDescriptor?: PageDocumentDescriptor } = {}
) => {
  const page = createLoroPage()
  const legacyPageRpc = vi.fn()
  const descriptorRpc = vi.fn(() => descriptor === undefined
    ? Effect.fail(new PageNotFound({ nodeId }))
    : Effect.succeed({ descriptor }))
  const createLoroRpc = vi.fn(() => Effect.succeed({ descriptor: options.createDescriptor! }))
  const client = {
    getNode: vi.fn(() => Effect.succeed({})),
    createNode: vi.fn(() => Effect.succeed({})),
    createNodeWithIntent: vi.fn(() => Effect.succeed({})),
    getPageDocumentDescriptor: descriptorRpc,
    createLoroPage: createLoroRpc,
    startLoroPageSync: vi.fn(() => Effect.succeed({
      sessionId: "loro-server-session",
      message: page.doc.export({ mode: "snapshot" }),
      serverVersion: page.doc.version().encode()
    })),
    loroPageSyncMessage: vi.fn(() => Effect.succeed({
      sessionId: "loro-server-session",
      ordinal: 0,
      update: null,
      serverVersion: page.doc.version().encode(),
      converged: true,
      reset: false
    })),
    startPageSync: legacyPageRpc,
    pageSyncMessage: legacyPageRpc
  } as unknown as WorkspaceRpcClientService

  return { client, createLoroRpc, legacyPageRpc }
}

describe("DailyNote lazy Automerge compatibility boundary", () => {
  it.each([
    ["native Loro", nativeLoroDescriptor()],
    ["migrated Loro with both witnesses", migratedLoroDescriptor()]
  ])("does not load or initialize legacy state for %s", async (_caseName, descriptor) => {
    const { client, legacyPageRpc } = makeLoroClient(descriptor)
    const legacyLoader = vi.fn(() => Effect.die("legacy loader must not run"))
    const cell: LegacyDailyNoteCell = { session: null }

    const resolved = await Effect.runPromise(resolveDailyNote(client, cell, creationIntent, date, legacyLoader))

    expect(resolved.format).toBe("loro-v1")
    expect(legacyLoader).not.toHaveBeenCalled()
    expect(cell.session).toBeNull()
    expect(legacyPageRpc).not.toHaveBeenCalled()
  })

  it("creates a Loro page before considering the legacy loader", async () => {
    const created = nativeLoroDescriptor()
    const { client, createLoroRpc, legacyPageRpc } = makeLoroClient(undefined, { createDescriptor: created })
    const legacyLoader = vi.fn(() => Effect.die("legacy loader must not run"))
    const cell: LegacyDailyNoteCell = { session: null }

    const resolved = await Effect.runPromise(resolveDailyNote(client, cell, creationIntent, date, legacyLoader))

    expect(resolved.format).toBe("loro-v1")
    expect(createLoroRpc).toHaveBeenCalledTimes(1)
    expect(legacyLoader).not.toHaveBeenCalled()
    expect(cell.session).toBeNull()
    expect(legacyPageRpc).not.toHaveBeenCalled()
  })

  it("maps only a failed legacy module load to an ordinary UnexpectedError", async () => {
    const rejected = new Error("chunk request failed")
    const result = await Effect.runPromise(Effect.either(loadLegacyDailyNote(() => Promise.reject(rejected))))

    expect(result._tag).toBe("Left")
    if (result._tag !== "Left") throw new Error("expected the module-load failure")
    expect(result.left).toMatchObject({
      _tag: "UnexpectedError",
      message: expect.stringContaining("chunk request failed")
    })
  })

  it("preserves a loaded adapter's typed sync failure instead of recasting it as a loader failure", async () => {
    const typedFailure = new PageNotFound({ nodeId })
    const adapter: LegacyDailyNoteModule = {
      RichNoteEditor: EmptyLegacyEditor,
      resolveLegacyDailyNote: vi.fn(() => Effect.fail(typedFailure)) as LegacyDailyNoteModule["resolveLegacyDailyNote"]
    }
    const descriptor = {
      nodeId,
      storageVersion: 1,
      activeFormat: "automerge-v1",
      automerge: { docId: "legacy-doc", headsHash: "legacy-heads", bytesSha256: "legacy-bytes" }
    } as PageDocumentDescriptor
    const { client } = makeLoroClient(descriptor)

    const result = await Effect.runPromise(Effect.either(resolveDailyNote(
      client,
      { session: null },
      creationIntent,
      date,
      () => Effect.succeed(adapter)
    )))

    expect(result._tag).toBe("Left")
    if (result._tag !== "Left") throw new Error("expected the adapter's typed sync failure")
    expect(result.left).toBe(typedFailure)
    expect(result.left._tag).toBe("PageNotFound")
  })

  it("interrupts an actual deferred legacy loader before it can create a session, call RPC, or publish", async () => {
    const deferred = await Effect.runPromise(Deferred.make<LegacyDailyNoteModule>())
    let signalLoaderStarted!: () => void
    const loaderStarted = new Promise<void>((resolve) => { signalLoaderStarted = resolve })
    const sessionFactory = vi.fn()
    const rpc = vi.fn()
    const publication = vi.fn()
    const adapter: LegacyDailyNoteModule = {
      RichNoteEditor: EmptyLegacyEditor,
      resolveLegacyDailyNote: vi.fn(() => {
        sessionFactory()
        rpc()
        publication()
        return Effect.succeed({}) as never
      }) as LegacyDailyNoteModule["resolveLegacyDailyNote"]
    }
    const loader = () => {
      signalLoaderStarted()
      return Effect.runPromise(Deferred.await(deferred))
    }
    const cell: LegacyDailyNoteCell = { session: null }
    const program = loadLegacyDailyNote(loader).pipe(
      Effect.flatMap((legacy) => legacy.resolveLegacyDailyNote(
        {} as WorkspaceRpcClientService,
        "00000000-0000-4000-8000-000000000001" as EntityId,
        nodeId,
        cell
      ))
    )

    const fiber = Effect.runFork(program)
    await loaderStarted
    await Effect.runPromise(Fiber.interrupt(fiber))
    await Effect.runPromise(Deferred.succeed(deferred, adapter))
    await Promise.resolve()

    expect(adapter.resolveLegacyDailyNote).not.toHaveBeenCalled()
    expect(sessionFactory).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
    expect(publication).not.toHaveBeenCalled()
    expect(cell.session).toBeNull()
  })

  it("passes a loaded legacy module's editor and session through the handoff", async () => {
    const session = { id: "legacy-module-session" }
    const RichNoteEditor = EmptyLegacyEditor
    const adapter: LegacyDailyNoteModule = {
      RichNoteEditor,
      resolveLegacyDailyNote: vi.fn(() => Effect.succeed({
        format: "automerge-v1" as const,
        nodeId,
        doc: {} as never,
        session
      })) as LegacyDailyNoteModule["resolveLegacyDailyNote"]
    }
    const descriptor = {
      nodeId,
      storageVersion: 1,
      activeFormat: "automerge-v1",
      automerge: { docId: "legacy-doc", headsHash: "legacy-heads", bytesSha256: "legacy-bytes" }
    } as PageDocumentDescriptor
    const { client } = makeLoroClient(descriptor)
    const cell: LegacyDailyNoteCell = { session }

    const resolved = await Effect.runPromise(resolveDailyNote(
      client,
      cell,
      creationIntent,
      date,
      () => Effect.succeed(adapter)
    ))

    expect(adapter.resolveLegacyDailyNote).toHaveBeenCalledTimes(1)
    expect(resolved).toMatchObject({ format: "automerge-v1", session })
    if (resolved.format !== "automerge-v1") throw new Error("expected legacy handoff")
    expect(resolved.RichNoteEditor).toBe(RichNoteEditor)
    expect(resolved.session).toBe(cell.session)
  })
})
