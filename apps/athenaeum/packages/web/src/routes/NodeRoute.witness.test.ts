/** @vitest-environment happy-dom */

import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import { AutomergePageDocumentDescriptor, LegacyPageDocumentDescriptor, LoroPageDocumentDescriptor, MigratedLoroPageDocumentDescriptor, NativeLoroPageDocumentDescriptor, PageNotFound } from "@athenaeum/domain"
import type { WorkspaceRpcClientService } from "../rpc-client.js"
import { createLoroPage } from "../loro-page.js"
import { pageWitness, resolveNodePagePreview, samePageWitness } from "./NodeRoute.js"

const nodeId = "00000000-0000-4000-8000-000000000042" as never
const loro = (snapshotSha256: string) => new LoroPageDocumentDescriptor({ schemaVersion: 1, snapshotSha256 })
const automerge = new AutomergePageDocumentDescriptor({ docId: "legacy", headsHash: "heads", bytesSha256: "bytes" })

describe("generic node page witness", () => {
  it("includes exact concrete variant and rejects ABA descriptor changes", () => {
    const legacy = pageWitness(new LegacyPageDocumentDescriptor({ nodeId, storageVersion: 7, activeFormat: "automerge-v1", automerge }))
    const migrated = pageWitness(new MigratedLoroPageDocumentDescriptor({ nodeId, storageVersion: 8, activeFormat: "loro-v1", automerge, loro: loro("first") }))
    const native = pageWitness(new NativeLoroPageDocumentDescriptor({ nodeId, storageVersion: 8, activeFormat: "loro-v1", loro: loro("first") }))
    const returned = pageWitness(new MigratedLoroPageDocumentDescriptor({ nodeId, storageVersion: 8, activeFormat: "loro-v1", automerge, loro: loro("second") }))
    expect(legacy.variant).toBe("legacy")
    expect(migrated.variant).toBe("migratedLoro")
    expect(native.variant).toBe("nativeLoro")
    expect(samePageWitness(migrated, returned)).toBe(false)
  })
})

describe("generic node page preview resolution", () => {
  it("keeps an initially absent legacy-or-Loro descriptor as missing", async () => {
    const client = {
      getPageDocumentDescriptor: () => Effect.fail(new PageNotFound({ nodeId }))
    } as unknown as WorkspaceRpcClientService

    await expect(Effect.runPromise(resolveNodePagePreview(client, nodeId))).resolves.toEqual({ kind: "missing" })
  })

  it("classifies legacy content disappearing after descriptor selection as stale", async () => {
    const descriptor = new LegacyPageDocumentDescriptor({
      nodeId,
      storageVersion: 7,
      activeFormat: "automerge-v1",
      automerge
    })
    let descriptorReads = 0
    const client = {
      getPageDocumentDescriptor: () => {
        descriptorReads += 1
        return descriptorReads === 1
          ? Effect.succeed({ descriptor })
          : Effect.fail(new PageNotFound({ nodeId }))
      },
      getPageText: () => Effect.succeed({ text: "Employee update" })
    } as unknown as WorkspaceRpcClientService

    await expect(Effect.runPromise(resolveNodePagePreview(client, nodeId))).resolves.toEqual({ kind: "stale" })
    expect(descriptorReads).toBe(2)
  })

  it("classifies a Loro page disappearing during convergence as stale", async () => {
    const descriptor = new NativeLoroPageDocumentDescriptor({
      nodeId,
      storageVersion: 8,
      activeFormat: "loro-v1",
      loro: loro("first")
    })
    const client = {
      getPageDocumentDescriptor: () => Effect.succeed({ descriptor }),
      startLoroPageSync: () => Effect.fail(new PageNotFound({ nodeId }))
    } as unknown as WorkspaceRpcClientService

    await expect(Effect.runPromise(resolveNodePagePreview(client, nodeId))).resolves.toEqual({ kind: "stale" })
  })

  it("classifies a Loro page disappearing at confirmation as stale", async () => {
    const descriptor = new NativeLoroPageDocumentDescriptor({
      nodeId,
      storageVersion: 8,
      activeFormat: "loro-v1",
      loro: loro("first")
    })
    let descriptorReads = 0
    const server = createLoroPage()
    const client = {
      getPageDocumentDescriptor: () => {
        descriptorReads += 1
        return descriptorReads === 1
          ? Effect.succeed({ descriptor })
          : Effect.fail(new PageNotFound({ nodeId }))
      },
      startLoroPageSync: () => Effect.succeed({
        sessionId: "session",
        message: server.doc.export({ mode: "snapshot" }),
        serverVersion: server.doc.version().encode()
      }),
      loroPageSyncMessage: () => Effect.succeed({
        sessionId: "session",
        ordinal: 0,
        update: null,
        serverVersion: server.doc.version().encode(),
        converged: true,
        reset: false
      })
    } as unknown as WorkspaceRpcClientService

    await expect(Effect.runPromise(resolveNodePagePreview(client, nodeId))).resolves.toEqual({ kind: "stale" })
    expect(descriptorReads).toBe(2)
  })
})
