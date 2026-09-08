import { describe, expect, it } from "vitest"
import { HumanUiMutationAttribution, LoroMutationIntentV1, type PageDocumentDescriptor } from "@athenaeum/domain"
import { createLoroPage } from "./loro-page.js"
import { CheckpointedLoroWriter } from "./checkpointed-loro-writer.js"

const descriptor = {
  nodeId: "00000000-0000-4000-8000-000000000002",
  storageVersion: 1,
  activeFormat: "loro-v1" as const,
  loro: { schemaVersion: 1, snapshotSha256: "a".repeat(64) }
} as unknown as Extract<PageDocumentDescriptor, { activeFormat: "loro-v1" }>
const intent = () => new LoroMutationIntentV1({
  requestId: "request-a", commitMessage: "Edit daily note",
  attribution: new HumanUiMutationAttribution({ version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor" })
})

describe("CheckpointedLoroWriter", () => {
  it("freezes A, preserves B in a fresh replica, and retries immutable A bytes", () => {
    const base = createLoroPage().doc
    const writer = new CheckpointedLoroWriter({ doc: base, descriptor })
    writer.workingDraft.getMap("athenaeum-page-meta-v1").set("A", "one")
    writer.workingDraft.commit()

    const flight = writer.freeze(intent())
    const retry = writer.retry()
    expect(retry.requestId).toBe("request-a")
    expect(retry.intent.commitMessage).toBe("Edit daily note")
    expect(retry.update).toEqual(flight.update)

    writer.workingDraft.getMap("athenaeum-page-meta-v1").set("B", "two")
    writer.workingDraft.commit()
    // A's bounded update was frozen before B existed.
    const onlyA = writer.acceptedBase.doc.fork()
    onlyA.import(flight.update)
    expect(onlyA.getMap("athenaeum-page-meta-v1").get("A")).toBe("one")
    expect(onlyA.getMap("athenaeum-page-meta-v1").get("B")).toBeUndefined()

    writer.accept({ doc: onlyA, descriptor: { ...descriptor, storageVersion: 2, loro: { ...descriptor.loro, snapshotSha256: "b".repeat(64) } } as typeof descriptor }, {
      storageVersion: 2, resultSnapshotSha256: "b".repeat(64)
    } as never)
    expect(writer.workingDraft.getMap("athenaeum-page-meta-v1").get("A")).toBe("one")
    expect(writer.workingDraft.getMap("athenaeum-page-meta-v1").get("B")).toBe("two")
    expect(writer.inFlight).toBeUndefined()
  })

  it("drops only the conflicted A custody and leaves B visible without rebase", () => {
    const writer = new CheckpointedLoroWriter({ doc: createLoroPage().doc, descriptor })
    writer.workingDraft.getMap("athenaeum-page-meta-v1").set("A", "one")
    writer.workingDraft.commit()
    writer.freeze(intent())
    writer.workingDraft.getMap("athenaeum-page-meta-v1").set("B", "two")
    writer.workingDraft.commit()
    writer.rejectConflict()
    expect(writer.inFlight).toBeUndefined()
    expect(writer.workingDraft.getMap("athenaeum-page-meta-v1").get("B")).toBe("two")
  })
})
