import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  AutomergePageDocumentDescriptor,
  CreateLoroPageInput,
  CreateLoroPageOutput,
  CreationIntent,
  HumanUiMutationAttribution,
  GetPageDocumentDescriptorOutput,
  GetLegacyPageProjectionInput,
  GetLegacyPageProjectionOutput,
  MigrateLegacyPageInput,
  MigrateLegacyPageOutput,
  LoroPageDocumentDescriptor,
  LoroPageSyncMessageInput,
  LoroPageSyncMessageOutput,
  LoroMutationIntentV1,
  LegacyPageDocumentDescriptor,
  MigratedLoroPageDocumentDescriptor,
  NativeLoroPageDocumentDescriptor,
  PageDocumentDescriptor,
  PageDocumentFormat,
  StartLoroPageSyncInput,
  StartLoroPageSyncOutput
} from "./index.js"
import type { PageDocumentFormat as PageDocumentFormatType } from "./index.js"
import { EntityId } from "./node.js"

const nodeId = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
const activeFormat: PageDocumentFormatType = "loro-v1"

const descriptor = new MigratedLoroPageDocumentDescriptor({
  nodeId: EntityId.make(nodeId),
  activeFormat,
  storageVersion: 1,
  automerge: new AutomergePageDocumentDescriptor({
    docId: "legacy-page-doc",
    headsHash: "legacy-heads",
    bytesSha256: "legacy-bytes-sha"
  }),
  loro: new LoroPageDocumentDescriptor({
    schemaVersion: 1,
    snapshotSha256: "loro-snapshot-sha"
  })
})

describe("Loro page-document contracts", () => {
  it("round-trips the versioned descriptor and descriptor output", () => {
    const encoded = Schema.encodeSync(PageDocumentDescriptor)(descriptor)
    expect(Schema.decodeUnknownSync(PageDocumentDescriptor)(encoded)).toEqual(descriptor)

    const output = new GetPageDocumentDescriptorOutput({ descriptor })
    expect(
      Schema.decodeUnknownSync(GetPageDocumentDescriptorOutput)(
        Schema.encodeSync(GetPageDocumentDescriptorOutput)(output)
      )
    ).toEqual(output)

    const legacyDescriptor = new AutomergePageDocumentDescriptor({
      docId: "legacy-page-doc", headsHash: "legacy-heads", bytesSha256: "legacy-bytes-sha"
    })
    const legacyProjection = new GetLegacyPageProjectionOutput({
      content: { kind: "plainText", text: "" },
      descriptor: new LegacyPageDocumentDescriptor({
        nodeId: EntityId.make(nodeId), storageVersion: 1, activeFormat: "automerge-v1", automerge: legacyDescriptor
      }),
      readOnly: true,
      migrationRequired: true
    })
    expect(
      Schema.decodeUnknownSync(GetLegacyPageProjectionOutput)(
        Schema.encodeSync(GetLegacyPageProjectionOutput)(legacyProjection)
      )
    ).toEqual(legacyProjection)
    expect(
      Schema.decodeUnknownSync(GetLegacyPageProjectionInput)({ workspaceId: nodeId, nodeId })
    ).toEqual(new GetLegacyPageProjectionInput({ workspaceId: EntityId.make(nodeId), nodeId: EntityId.make(nodeId) }))

    const migration = new MigrateLegacyPageInput({
      workspaceId: EntityId.make(nodeId), nodeId: EntityId.make(nodeId), expectedStorageVersion: 1,
      expectedAutomerge: legacyDescriptor,
      intent: new LoroMutationIntentV1({ requestId: "migrate-legacy-contract-test", commitMessage: "Migrate a legacy note", attribution: new HumanUiMutationAttribution({ version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor" }) })
    })
    expect(Schema.decodeUnknownSync(MigrateLegacyPageInput)(Schema.encodeSync(MigrateLegacyPageInput)(migration))).toEqual(migration)
    expect(Schema.decodeUnknownSync(MigrateLegacyPageOutput)(Schema.encodeSync(MigrateLegacyPageOutput)(new MigrateLegacyPageOutput({ descriptor })))).toEqual(new MigrateLegacyPageOutput({ descriptor }))

    const create = new CreateLoroPageInput({
      workspaceId: EntityId.make(nodeId),
      nodeId: EntityId.make(nodeId),
      creationIntent: new CreationIntent({
        requestId: "create-loro-contract-test",
        commitMessage: "Create today's note",
        attribution: new HumanUiMutationAttribution({
          version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor"
        })
      })
    })
    expect(Schema.decodeUnknownSync(CreateLoroPageInput)(Schema.encodeSync(CreateLoroPageInput)(create))).toEqual(create)
    const nativeDescriptor = new NativeLoroPageDocumentDescriptor({
      nodeId: EntityId.make(nodeId),
      activeFormat: "loro-v1",
      storageVersion: 1,
      loro: new LoroPageDocumentDescriptor({ schemaVersion: 1, snapshotSha256: "native-loro-snapshot" })
    })
    const nativeOutput = new CreateLoroPageOutput({ descriptor: nativeDescriptor })
    expect(Schema.decodeUnknownSync(CreateLoroPageOutput)(Schema.encodeSync(CreateLoroPageOutput)(nativeOutput))).toEqual(nativeOutput)
    expect(nativeDescriptor).not.toHaveProperty("automerge")
  })

  it("canonicalizes CreationIntent request ids once at the public wire boundary", () => {
    const encoded = {
      workspaceId: nodeId,
      nodeId,
      creationIntent: {
        requestId: "  creation-request-id  ",
        commitMessage: "Create today's note",
        attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor" }
      }
    }
    const decoded = Schema.decodeUnknownSync(CreateLoroPageInput)(encoded)
    expect(decoded.creationIntent.requestId).toBe("creation-request-id")
    expect(Either.isLeft(Schema.decodeUnknownEither(CreateLoroPageInput)({
      ...encoded, creationIntent: { ...encoded.creationIntent, requestId: " \n\t " }
    }))).toBe(true)
  })

  it("accepts only the exact iOS Supertags human surface", () => {
    const encoded = { workspaceId: nodeId, nodeId, creationIntent: { requestId: "ios-supertags", commitMessage: "Apply a Supertag", attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "ios-supertags" } } }
    expect(Schema.decodeUnknownSync(CreateLoroPageInput)(encoded).creationIntent.attribution).toMatchObject({ surface: "ios-supertags" })
    for (const surface of ["ios-supertag", "ios-supertags\n", "ios-supertags "]) expect(Either.isLeft(Schema.decodeUnknownEither(CreateLoroPageInput)({ ...encoded, creationIntent: { ...encoded.creationIntent, attribution: { ...encoded.creationIntent.attribution, surface } } }))).toBe(true)
  })

  it("requires valid format, positive storage/schema versions, and required wire bytes", () => {
    expect(Schema.decodeUnknownSync(PageDocumentFormat)("automerge-v1")).toBe("automerge-v1")
    expect(Schema.decodeUnknownSync(PageDocumentFormat)("loro-v1")).toBe("loro-v1")
    expect(Either.isLeft(Schema.decodeUnknownEither(PageDocumentFormat)("yjs-v1"))).toBe(true)
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(PageDocumentDescriptor)({
          ...descriptor,
          storageVersion: 0
        })
      )
    ).toBe(true)
    expect(Either.isLeft(Schema.decodeUnknownEither(GetLegacyPageProjectionOutput)({
      content: { kind: "plainText", text: "legacy" }, descriptor, readOnly: false, migrationRequired: true
    }))).toBe(true)
    expect(Either.isLeft(Schema.decodeUnknownEither(GetLegacyPageProjectionOutput)({
      content: { kind: "plainText", text: "legacy" }, descriptor, readOnly: true, migrationRequired: false
    }))).toBe(true)
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(PageDocumentDescriptor)({
          nodeId,
          activeFormat: "loro-v1",
          storageVersion: 1,
          loro: { schemaVersion: 1, snapshotSha256: "native" },
          automerge: undefined
        })
      )
    ).toBe(false)
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(PageDocumentDescriptor)({
          nodeId,
          activeFormat: "automerge-v1",
          storageVersion: 1,
          loro: { schemaVersion: 1, snapshotSha256: "orphan" }
        })
      )
    ).toBe(true)
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(PageDocumentDescriptor)({
          nodeId,
          activeFormat: "loro-v1",
          storageVersion: 1,
          loro: { schemaVersion: 1, snapshotSha256: "native" },
          automerge: { docId: "stale" }
        })
      )
    ).toBe(true)
  })

  it("round-trips required Loro sync versions and accepts only nullable response updates", () => {
    const startInput = new StartLoroPageSyncInput({
      workspaceId: EntityId.make(nodeId),
      nodeId: EntityId.make(nodeId),
      sessionId: "session-1"
    })
    expect(
      Schema.decodeUnknownSync(StartLoroPageSyncInput)(
        Schema.encodeSync(StartLoroPageSyncInput)(startInput)
      )
    ).toEqual(startInput)

    const start = new StartLoroPageSyncOutput({
      sessionId: "session-1",
      message: new Uint8Array([1]),
      serverVersion: new Uint8Array([2])
    })
    expect(
      Schema.decodeUnknownSync(StartLoroPageSyncOutput)(Schema.encodeSync(StartLoroPageSyncOutput)(start))
    ).toEqual(start)

    const update = new LoroPageSyncMessageInput({
      workspaceId: EntityId.make(nodeId),
      nodeId: EntityId.make(nodeId),
      sessionId: "session-1",
      ordinal: 0,
      update: new Uint8Array([4]),
      clientVersion: new Uint8Array([5])
    })
    expect(
      Schema.decodeUnknownSync(LoroPageSyncMessageInput)(
        Schema.encodeSync(LoroPageSyncMessageInput)(update)
      )
    ).toEqual(update)

    const response = new LoroPageSyncMessageOutput({
      sessionId: "session-1",
      ordinal: 0,
      update: null,
      serverVersion: new Uint8Array([3]),
      converged: true,
      reset: false
    })
    expect(
      Schema.decodeUnknownSync(LoroPageSyncMessageOutput)(
        Schema.encodeSync(LoroPageSyncMessageOutput)(response)
      )
    ).toEqual(response)
  })
})
