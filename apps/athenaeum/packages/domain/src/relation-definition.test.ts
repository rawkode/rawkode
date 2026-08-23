import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { EntityId } from "./node.js"
import { RelationCardinality, RelationDefinition } from "./relation-definition.js"

const validUuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
const validUuid2 = "3fa85f64-5717-4562-b3fc-2c963f66afa7"
const validUuid3 = "3fa85f64-5717-4562-b3fc-2c963f66afa8"

describe("RelationDefinition schema", () => {
  it("round-trips encode/decode", () => {
    const def = new RelationDefinition({
      id: EntityId.make(validUuid),
      forwardName: "employs",
      inverseName: "employed by",
      sourceTagId: EntityId.make(validUuid2),
      targetTagId: EntityId.make(validUuid3),
      cardinality: "one-to-many"
    })
    const encoded = Schema.encodeSync(RelationDefinition)(def)
    expect(Schema.decodeUnknownSync(RelationDefinition)(encoded)).toEqual(def)
  })

  it("accepts all four cardinality literals", () => {
    for (const cardinality of [
      "one-to-one",
      "one-to-many",
      "many-to-one",
      "many-to-many"
    ] as const) {
      const result = Schema.decodeUnknownEither(RelationCardinality)(cardinality)
      expect(Either.isRight(result)).toBe(true)
    }
  })

  it("rejects an unknown cardinality literal", () => {
    const result = Schema.decodeUnknownEither(RelationCardinality)("many-to-many-to-many")
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects an empty forwardName", () => {
    const result = Schema.decodeUnknownEither(RelationDefinition)({
      id: validUuid,
      forwardName: "",
      inverseName: "employed by",
      sourceTagId: validUuid2,
      targetTagId: validUuid3,
      cardinality: "one-to-many"
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})
