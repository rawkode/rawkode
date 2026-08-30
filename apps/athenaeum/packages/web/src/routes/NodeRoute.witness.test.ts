/** @vitest-environment happy-dom */

import { describe, expect, it } from "vitest"
import { AutomergePageDocumentDescriptor, LegacyPageDocumentDescriptor, LoroPageDocumentDescriptor, MigratedLoroPageDocumentDescriptor, NativeLoroPageDocumentDescriptor } from "@athenaeum/domain"
import { pageWitness, samePageWitness } from "./NodeRoute.js"

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
