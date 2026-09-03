import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { Edge } from "./edge.js"
import { EntityId, PendingMarker } from "./node.js"

const validUuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
const validUuid2 = "3fa85f64-5717-4562-b3fc-2c963f66afa7"
const validUuid3 = "3fa85f64-5717-4562-b3fc-2c963f66afa8"
const validUuid4 = "3fa85f64-5717-4562-b3fc-2c963f66afa9"

describe("Edge schema", () => {
  it("round-trips encode/decode", () => {
    const edge = new Edge({
      id: EntityId.make(validUuid),
      relationDefinitionId: EntityId.make(validUuid2),
      sourceNodeId: EntityId.make(validUuid3),
      targetNodeId: EntityId.make(validUuid4)
    })
    const encoded = Schema.encodeSync(Edge)(edge)
    expect(encoded).toEqual({
      id: validUuid,
      relationDefinitionId: validUuid2,
      sourceNodeId: validUuid3,
      targetNodeId: validUuid4
    })
    expect(Schema.decodeUnknownSync(Edge)(encoded)).toEqual(edge)
  })

  it("rejects a non-ULID/UUID sourceNodeId", () => {
    const result = Schema.decodeUnknownEither(Edge)({
      id: validUuid,
      relationDefinitionId: validUuid2,
      sourceNodeId: "not-an-id",
      targetNodeId: validUuid4
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("round-trips a pending edge, omitting pending from the encoded shape when absent", () => {
    const mainlineEdge = new Edge({
      id: EntityId.make(validUuid),
      relationDefinitionId: EntityId.make(validUuid2),
      sourceNodeId: EntityId.make(validUuid3),
      targetNodeId: EntityId.make(validUuid4)
    })
    expect("pending" in Schema.encodeSync(Edge)(mainlineEdge)).toBe(false)

    const pendingEdge = new Edge({
      id: EntityId.make(validUuid),
      relationDefinitionId: EntityId.make(validUuid2),
      sourceNodeId: EntityId.make(validUuid3),
      targetNodeId: EntityId.make(validUuid4),
      pending: new PendingMarker({ chatId: EntityId.make(validUuid2) })
    })
    const encoded = Schema.encodeSync(Edge)(pendingEdge)
    expect(Schema.decodeUnknownSync(Edge)(encoded)).toEqual(pendingEdge)
  })
})
