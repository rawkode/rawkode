import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  AddedEdgeSummary,
  AddedFactSummary,
  ChangesMessage,
  CreatedAppSummary,
  CreatedNodeSummary,
  NoteEditSummary,
  UpdatedAppCodeSummary
} from "./changes-message.js"
import { EntityId } from "./node.js"

const validUuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
const validUuid2 = "3fa85f64-5717-4562-b3fc-2c963f66afa7"
const validUuid3 = "3fa85f64-5717-4562-b3fc-2c963f66afa8"
const validUuid4 = "3fa85f64-5717-4562-b3fc-2c963f66afa9"

describe("ChangesMessage schema", () => {
  it("round-trips a batch touching all four kinds", () => {
    const message = new ChangesMessage({
      chatId: EntityId.make(validUuid),
      sequence: 3,
      createdNodes: [new CreatedNodeSummary({ nodeId: EntityId.make(validUuid2), title: "Roadmap" })],
      addedFacts: [
        new AddedFactSummary({ factId: EntityId.make(validUuid3), nodeId: EntityId.make(validUuid2), predicateId: "status" })
      ],
      addedEdges: [
        new AddedEdgeSummary({
          edgeId: EntityId.make(validUuid4),
          relationDefinitionId: EntityId.make(validUuid),
          sourceNodeId: EntityId.make(validUuid2),
          targetNodeId: EntityId.make(validUuid3)
        })
      ],
      noteEdits: [new NoteEditSummary({ nodeId: EntityId.make(validUuid2), headsHash: "abc123" })]
    })
    const encoded = Schema.encodeSync(ChangesMessage)(message)
    expect(Schema.decodeUnknownSync(ChangesMessage)(encoded)).toEqual(message)
  })

  it("round-trips a batch touching createdApps and updatedAppCode", () => {
    const message = new ChangesMessage({
      chatId: EntityId.make(validUuid),
      sequence: 1,
      createdApps: [new CreatedAppSummary({ appId: EntityId.make(validUuid2), title: "Counter" })],
      updatedAppCode: [
        new UpdatedAppCodeSummary({ appId: EntityId.make(validUuid2), kind: "server", version: 2 })
      ]
    })
    const encoded = Schema.encodeSync(ChangesMessage)(message)
    expect(Schema.decodeUnknownSync(ChangesMessage)(encoded)).toEqual(message)
    expect("createdNodes" in encoded).toBe(false)
  })

  it("rejects an updatedAppCode entry with version 0", () => {
    const result = Schema.decodeUnknownEither(ChangesMessage)({
      chatId: validUuid,
      sequence: 0,
      updatedAppCode: [{ appId: validUuid2, kind: "server", version: 0 }]
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("round-trips a creation-only batch (a no-op update per multi-gadget.md §Q15)", () => {
    const message = new ChangesMessage({
      chatId: EntityId.make(validUuid),
      sequence: 0,
      createdNodes: [new CreatedNodeSummary({ nodeId: EntityId.make(validUuid2), title: "Roadmap" })]
    })
    const encoded = Schema.encodeSync(ChangesMessage)(message)
    expect(encoded).toEqual({
      chatId: validUuid,
      sequence: 0,
      createdNodes: [{ nodeId: validUuid2, title: "Roadmap" }]
    })
    expect("addedFacts" in encoded).toBe(false)
    expect("addedEdges" in encoded).toBe(false)
    expect("noteEdits" in encoded).toBe(false)
  })

  it("round-trips a message with all four batch fields omitted", () => {
    const message = new ChangesMessage({ chatId: EntityId.make(validUuid), sequence: 5 })
    const encoded = Schema.encodeSync(ChangesMessage)(message)
    expect(encoded).toEqual({ chatId: validUuid, sequence: 5 })
    expect(Schema.decodeUnknownSync(ChangesMessage)(encoded)).toEqual(message)
  })

  it("rejects a negative sequence", () => {
    const result = Schema.decodeUnknownEither(ChangesMessage)({ chatId: validUuid, sequence: -1 })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects an addedFacts entry with an empty predicateId", () => {
    const result = Schema.decodeUnknownEither(ChangesMessage)({
      chatId: validUuid,
      sequence: 0,
      addedFacts: [{ factId: validUuid2, nodeId: validUuid3, predicateId: "" }]
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})
