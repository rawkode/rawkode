/** @vitest-environment happy-dom */

import * as Effect from "effect/Effect"
import { describe, expect, it, vi } from "vitest"
import { CreationIntent, HumanUiMutationAttribution, PageNotFound, type EntityId, type PageDocumentDescriptor } from "@athenaeum/domain"
import { createLoroPage } from "./loro-page.js"
import { resolveDailyNote } from "./DailyNote.js"
import type { WorkspaceRpcClientService } from "./rpc-client.js"

const nodeId = "00000000-0000-4000-8000-000000000002" as EntityId
const date = new Date("2026-08-27T12:00:00.000Z")
const creationIntent = new CreationIntent({
  requestId: "00000000-0000-4000-8000-000000000003", commitMessage: "Create daily note",
  attribution: new HumanUiMutationAttribution({ version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor" })
})
const loro = (): Extract<PageDocumentDescriptor, { activeFormat: "loro-v1" }> => ({
  nodeId, storageVersion: 1, activeFormat: "loro-v1", loro: { schemaVersion: 1, snapshotSha256: "loro-snapshot" }
} as Extract<PageDocumentDescriptor, { activeFormat: "loro-v1" }>)
const legacy = (): Extract<PageDocumentDescriptor, { activeFormat: "automerge-v1" }> => ({
  nodeId, storageVersion: 1, activeFormat: "automerge-v1",
  automerge: { docId: "legacy-doc", headsHash: "legacy-heads", bytesSha256: "legacy-bytes" }
} as Extract<PageDocumentDescriptor, { activeFormat: "automerge-v1" }>)

const makeClient = (descriptor: PageDocumentDescriptor | undefined) => {
  const page = createLoroPage()
  const legacyWrite = vi.fn(() => Effect.die("legacy write transport must not run"))
  const projection = vi.fn(() => Effect.succeed({
    descriptor: legacy(), content: { kind: "plainText" as const, text: "Legacy note" }, readOnly: true as const, migrationRequired: true as const
  }))
  const client = {
    getNode: vi.fn(() => Effect.succeed({})), createNodeWithIntent: vi.fn(() => Effect.succeed({})),
    getPageDocumentDescriptor: vi.fn(() => descriptor === undefined ? Effect.fail(new PageNotFound({ nodeId })) : Effect.succeed({ descriptor })),
    createLoroPage: vi.fn(() => Effect.succeed({ descriptor: loro() })), getLegacyPageProjection: projection,
    startPageSync: legacyWrite, pageSyncMessage: legacyWrite, applyPageEdit: legacyWrite,
    startLoroPageSync: vi.fn(() => Effect.succeed({ sessionId: "loro-session", message: page.doc.export({ mode: "snapshot" }), serverVersion: page.doc.version().encode() })),
    loroPageSyncMessage: vi.fn(() => Effect.succeed({ sessionId: "loro-session", ordinal: 0, update: null, serverVersion: page.doc.version().encode(), converged: true, reset: false }))
  } as unknown as WorkspaceRpcClientService
  return { client, legacyWrite, projection }
}

describe("DailyNote web Automerge freeze", () => {
  it("resolves Loro without legacy projection or write transports", async () => {
    const { client, legacyWrite, projection } = makeClient(loro())
    expect((await Effect.runPromise(resolveDailyNote(client, creationIntent, date))).format).toBe("loro-v1")
    expect(projection).not.toHaveBeenCalled(); expect(legacyWrite).not.toHaveBeenCalled()
  })
  it("creates missing pages directly as Loro", async () => {
    const { client, legacyWrite, projection } = makeClient(undefined)
    expect((await Effect.runPromise(resolveDailyNote(client, creationIntent, date))).format).toBe("loro-v1")
    expect(client.createLoroPage).toHaveBeenCalledTimes(1); expect(projection).not.toHaveBeenCalled(); expect(legacyWrite).not.toHaveBeenCalled()
  })
  it("loads only the server-owned read-only projection for Automerge", async () => {
    const { client, legacyWrite, projection } = makeClient(legacy())
    expect(await Effect.runPromise(resolveDailyNote(client, creationIntent, date))).toMatchObject({
      format: "automerge-v1", projection: { readOnly: true, migrationRequired: true, content: { kind: "plainText", text: "Legacy note" } }
    })
    expect(projection).toHaveBeenCalledTimes(1); expect(legacyWrite).not.toHaveBeenCalled()
  })
  it("fails closed on a stale projection witness", async () => {
    const { client, legacyWrite } = makeClient(legacy())
    const staleClient = {
      ...client,
      getLegacyPageProjection: vi.fn(() => Effect.succeed({ descriptor: { ...legacy(), storageVersion: 2 }, content: { kind: "plainText" as const, text: "stale" }, readOnly: true as const, migrationRequired: true as const }))
    } as WorkspaceRpcClientService
    const result = await Effect.runPromise(Effect.either(resolveDailyNote(staleClient, creationIntent, date)))
    expect(result._tag).toBe("Left")
    if (result._tag !== "Left") throw new Error("expected stale projection failure")
    expect(result.left).toMatchObject({ _tag: "UnexpectedError" })
    expect(legacyWrite).not.toHaveBeenCalled()
  })
})
