import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { Fact } from "./fact.js"
import { EntityId, PendingMarker } from "./node.js"

const validUuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
const validUuid2 = "3fa85f64-5717-4562-b3fc-2c963f66afa7"

describe("Fact schema", () => {
  it("round-trips a scalar string value", () => {
    const fact = new Fact({
      id: EntityId.make(validUuid),
      nodeId: EntityId.make(validUuid2),
      predicateId: "status",
      value: "done"
    })
    const encoded = Schema.encodeSync(Fact)(fact)
    expect(Schema.decodeUnknownSync(Fact)(encoded)).toEqual(fact)
  })

  it("round-trips a numeric value", () => {
    const fact = new Fact({
      id: EntityId.make(validUuid),
      nodeId: EntityId.make(validUuid2),
      predicateId: "capacity-day",
      value: 3
    })
    expect(Schema.decodeUnknownSync(Fact)(Schema.encodeSync(Fact)(fact))).toEqual(fact)
  })

  it("round-trips a null value", () => {
    const fact = new Fact({
      id: EntityId.make(validUuid),
      nodeId: EntityId.make(validUuid2),
      predicateId: "due-date",
      value: null
    })
    expect(Schema.decodeUnknownSync(Fact)(Schema.encodeSync(Fact)(fact))).toEqual(fact)
  })

  it("round-trips a nested object/array JSON value", () => {
    const fact = new Fact({
      id: EntityId.make(validUuid),
      nodeId: EntityId.make(validUuid2),
      predicateId: "address",
      value: {
        street: "1 Infinite Loop",
        tags: ["home", "primary"],
        geo: { lat: 37.33, lng: -122.03 },
        verified: true
      }
    })
    const encoded = Schema.encodeSync(Fact)(fact)
    expect(Schema.decodeUnknownSync(Fact)(encoded)).toEqual(fact)
  })

  it("rejects an empty predicateId", () => {
    const result = Schema.decodeUnknownEither(Fact)({
      id: validUuid,
      nodeId: validUuid2,
      predicateId: "",
      value: "x"
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects a non-JSON-safe value (e.g. undefined inside an object)", () => {
    const result = Schema.decodeUnknownEither(Fact)({
      id: validUuid,
      nodeId: validUuid2,
      predicateId: "bad",
      value: { nested: undefined }
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("omits pending from the encoded shape when absent", () => {
    const fact = new Fact({
      id: EntityId.make(validUuid),
      nodeId: EntityId.make(validUuid2),
      predicateId: "status",
      value: "done"
    })
    const encoded = Schema.encodeSync(Fact)(fact)
    expect("pending" in encoded).toBe(false)
  })

  it("round-trips a pending fact", () => {
    const fact = new Fact({
      id: EntityId.make(validUuid),
      nodeId: EntityId.make(validUuid2),
      predicateId: "status",
      value: "done",
      pending: new PendingMarker({ chatId: EntityId.make(validUuid2), sequence: 4 })
    })
    const encoded = Schema.encodeSync(Fact)(fact)
    expect(Schema.decodeUnknownSync(Fact)(encoded)).toEqual(fact)
  })
})
