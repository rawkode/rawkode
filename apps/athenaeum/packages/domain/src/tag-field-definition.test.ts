import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { EntityId } from "./node.js"
import { BaseTagIds } from "./tag.js"
import { BASE_TAG_FIELD_DEFINITIONS, BaseTagFieldIds, TagFieldDefinition } from "./tag-field-definition.js"

const ALL_VALUE_KINDS = ["text", "number", "date", "checkbox", "entity-ref"] as const

const validUuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
const validUuid2 = "3fa85f64-5717-4562-b3fc-2c963f66afa7"

describe("TagFieldDefinition schema", () => {
  it("round-trips encode/decode", () => {
    const field = new TagFieldDefinition({
      id: EntityId.make(validUuid),
      tagId: EntityId.make(validUuid2),
      name: "role",
      valueKind: "text",
      sortOrder: 0,
      builtin: false
    })

    const encoded = Schema.encodeSync(TagFieldDefinition)(field)
    expect(encoded).toEqual({
      id: validUuid,
      tagId: validUuid2,
      name: "role",
      valueKind: "text",
      sortOrder: 0,
      builtin: false
    })
    expect(Schema.decodeUnknownSync(TagFieldDefinition)(encoded)).toEqual(field)
  })

  it("accepts every TagFieldValueKind literal", () => {
    for (const valueKind of ALL_VALUE_KINDS) {
      const result = Schema.decodeUnknownEither(TagFieldDefinition)({
        id: validUuid,
        tagId: validUuid2,
        name: "field",
        valueKind,
        sortOrder: 0,
        builtin: false
      })
      expect(Either.isRight(result)).toBe(true)
    }
  })

  it("rejects an unknown valueKind", () => {
    const result = Schema.decodeUnknownEither(TagFieldDefinition)({
      id: validUuid,
      tagId: validUuid2,
      name: "field",
      valueKind: "url",
      sortOrder: 0,
      builtin: false
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects an empty name", () => {
    const result = Schema.decodeUnknownEither(TagFieldDefinition)({
      id: validUuid,
      tagId: validUuid2,
      name: "",
      valueKind: "text",
      sortOrder: 0,
      builtin: false
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects a negative sortOrder", () => {
    const result = Schema.decodeUnknownEither(TagFieldDefinition)({
      id: validUuid,
      tagId: validUuid2,
      name: "field",
      valueKind: "text",
      sortOrder: -1,
      builtin: false
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects a non-integer sortOrder", () => {
    const result = Schema.decodeUnknownEither(TagFieldDefinition)({
      id: validUuid,
      tagId: validUuid2,
      name: "field",
      valueKind: "text",
      sortOrder: 1.5,
      builtin: false
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("BASE_TAG_FIELD_DEFINITIONS", () => {
  it("has exactly the 15 decisions-doc-named fields, all builtin", () => {
    expect(BASE_TAG_FIELD_DEFINITIONS).toHaveLength(15)
    for (const field of BASE_TAG_FIELD_DEFINITIONS) {
      expect(field.builtin).toBe(true)
    }
  })

  it("every field id is a distinct, schema-valid EntityId", () => {
    const ids = BASE_TAG_FIELD_DEFINITIONS.map((field) => field.id)
    expect(new Set(ids).size).toBe(15)
    for (const id of ids) {
      expect(() => Schema.decodeUnknownSync(EntityId)(id)).not.toThrow()
    }
  })

  it("every field's tagId points at a real BaseTagIds member", () => {
    const baseTagIdSet = new Set(Object.values(BaseTagIds))
    for (const field of BASE_TAG_FIELD_DEFINITIONS) {
      expect(baseTagIdSet.has(field.tagId)).toBe(true)
    }
  })

  it("BaseTagFieldIds and BASE_TAG_FIELD_DEFINITIONS agree on id assignment", () => {
    expect(BASE_TAG_FIELD_DEFINITIONS.find((f) => f.name === "role" && f.tagId === BaseTagIds.Person)?.id).toBe(
      BaseTagFieldIds.PersonRole
    )
    expect(
      BASE_TAG_FIELD_DEFINITIONS.find((f) => f.name === "priority" && f.tagId === BaseTagIds.Task)?.id
    ).toBe(BaseTagFieldIds.TaskPriority)
  })

  it("Person has role, email, company fields with 0-based sortOrder", () => {
    const personFields = BASE_TAG_FIELD_DEFINITIONS.filter((f) => f.tagId === BaseTagIds.Person).sort(
      (a, b) => a.sortOrder - b.sortOrder
    )
    expect(personFields.map((f) => f.name)).toEqual(["role", "email", "company"])
    expect(personFields.map((f) => f.sortOrder)).toEqual([0, 1, 2])
    expect(personFields.find((f) => f.name === "company")?.valueKind).toBe("entity-ref")
  })

  it("Task has status, dueDate, priority fields", () => {
    const taskFields = BASE_TAG_FIELD_DEFINITIONS.filter((f) => f.tagId === BaseTagIds.Task).sort(
      (a, b) => a.sortOrder - b.sortOrder
    )
    expect(taskFields.map((f) => f.name)).toEqual(["status", "dueDate", "priority"])
    expect(taskFields.map((f) => f.valueKind)).toEqual(["text", "date", "text"])
  })

  it("every BASE_TAG_FIELD_DEFINITIONS row round-trips through the TagFieldDefinition schema", () => {
    for (const field of BASE_TAG_FIELD_DEFINITIONS) {
      const encoded = Schema.encodeSync(TagFieldDefinition)(field)
      expect(Schema.decodeUnknownSync(TagFieldDefinition)(encoded)).toEqual(field)
    }
  })
})
