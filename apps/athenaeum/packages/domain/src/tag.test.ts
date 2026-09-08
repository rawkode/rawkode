import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { EntityId } from "./node.js"
import { BASE_TAGS, BaseTagIds, Tag } from "./tag.js"

const validUuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
const validUuid2 = "3fa85f64-5717-4562-b3fc-2c963f66afa7"

describe("Tag schema", () => {
  it("round-trips encode/decode with parentIds", () => {
    const tag = new Tag({
      id: EntityId.make(validUuid),
      name: "Employee",
      parentIds: [EntityId.make(validUuid2)],
      builtin: false
    })

    const encoded = Schema.encodeSync(Tag)(tag)
    expect(encoded).toEqual({
      id: validUuid,
      name: "Employee",
      parentIds: [validUuid2],
      builtin: false
    })
    expect(Schema.decodeUnknownSync(Tag)(encoded)).toEqual(tag)
  })

  it("accepts an empty parentIds array (a root tag)", () => {
    const result = Schema.decodeUnknownEither(Tag)({
      id: validUuid,
      name: "Root",
      parentIds: [],
      builtin: false
    })
    expect(Either.isRight(result)).toBe(true)
  })

  it("rejects an empty name", () => {
    const result = Schema.decodeUnknownEither(Tag)({
      id: validUuid,
      name: "",
      parentIds: [],
      builtin: false
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("BASE_TAGS", () => {
  it("has exactly the 8 plan-named tags, all builtin, no parents", () => {
    expect(BASE_TAGS).toHaveLength(8)
    expect(BASE_TAGS.map((tag) => tag.name)).toEqual([
      "Person",
      "Organization",
      "Company",
      "Event",
      "Place",
      "Area",
      "Project",
      "Task"
    ])
    for (const tag of BASE_TAGS) {
      expect(tag.builtin).toBe(true)
      expect(tag.parentIds).toEqual([])
    }
  })

  it("every base tag id is a distinct, schema-valid EntityId", () => {
    const ids = BASE_TAGS.map((tag) => tag.id)
    expect(new Set(ids).size).toBe(8)
    for (const id of ids) {
      expect(() => Schema.decodeUnknownSync(EntityId)(id)).not.toThrow()
    }
  })

  it("BaseTagIds and BASE_TAGS agree on id assignment", () => {
    expect(BASE_TAGS.find((tag) => tag.name === "Person")?.id).toBe(BaseTagIds.Person)
    expect(BASE_TAGS.find((tag) => tag.name === "Task")?.id).toBe(BaseTagIds.Task)
  })

  it("every BASE_TAGS row round-trips through the Tag schema", () => {
    for (const tag of BASE_TAGS) {
      const encoded = Schema.encodeSync(Tag)(tag)
      expect(Schema.decodeUnknownSync(Tag)(encoded)).toEqual(tag)
    }
  })
})
