import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { GraphIssue } from "./graph-issue.js"
import { EntityId, IsoDateTimeString } from "./node.js"

const validUuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
const validUuid2 = "3fa85f64-5717-4562-b3fc-2c963f66afa7"
const validUuid3 = "3fa85f64-5717-4562-b3fc-2c963f66afa8"
const validUuid4 = "3fa85f64-5717-4562-b3fc-2c963f66afa9"
const validUuid5 = "3fa85f64-5717-4562-b3fc-2c963f66afaa"
const validIso = "2026-08-20T12:00:00.000Z"

describe("GraphIssue schema", () => {
  it("round-trips encode/decode with multiple conflicting edges", () => {
    const issue = new GraphIssue({
      id: EntityId.make(validUuid),
      kind: "concurrent-max-one-edge-conflict",
      relationDefinitionId: EntityId.make(validUuid2),
      nodeId: EntityId.make(validUuid3),
      conflictingEdgeIds: [EntityId.make(validUuid4), EntityId.make(validUuid5)],
      createdAt: IsoDateTimeString.make(validIso)
    })
    const encoded = Schema.encodeSync(GraphIssue)(issue)
    expect(encoded.conflictingEdgeIds).toEqual([validUuid4, validUuid5])
    expect(Schema.decodeUnknownSync(GraphIssue)(encoded)).toEqual(issue)
  })

  it("rejects an unknown issue kind", () => {
    const result = Schema.decodeUnknownEither(GraphIssue)({
      id: validUuid,
      kind: "some-other-conflict",
      relationDefinitionId: validUuid2,
      nodeId: validUuid3,
      conflictingEdgeIds: [validUuid4],
      createdAt: validIso
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("accepts an empty conflictingEdgeIds array at the schema level", () => {
    // The schema doesn't enforce "at least 2 conflicting edges" — that invariant belongs to
    // whatever raises GraphIssueDetected (errors.ts), not to the storage row's own shape.
    const result = Schema.decodeUnknownEither(GraphIssue)({
      id: validUuid,
      kind: "concurrent-max-one-edge-conflict",
      relationDefinitionId: validUuid2,
      nodeId: validUuid3,
      conflictingEdgeIds: [],
      createdAt: validIso
    })
    expect(Either.isRight(result)).toBe(true)
  })
})
