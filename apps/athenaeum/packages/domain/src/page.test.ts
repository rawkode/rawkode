import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { EntityId } from "./node.js"
import { Page } from "./page.js"

const validUuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6"

describe("Page schema", () => {
  it("round-trips encode/decode", () => {
    const page = new Page({
      nodeId: EntityId.make(validUuid),
      automergeDocId: "doc-abc123",
      headsHash: "sha256:deadbeef"
    })

    const encoded = Schema.encodeSync(Page)(page)
    expect(encoded).toEqual({
      nodeId: validUuid,
      automergeDocId: "doc-abc123",
      headsHash: "sha256:deadbeef"
    })
    expect(Schema.decodeUnknownSync(Page)(encoded)).toEqual(page)
  })

  it("rejects an empty automergeDocId", () => {
    const result = Schema.decodeUnknownEither(Page)({
      nodeId: validUuid,
      automergeDocId: "",
      headsHash: "sha256:deadbeef"
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects an empty headsHash", () => {
    const result = Schema.decodeUnknownEither(Page)({
      nodeId: validUuid,
      automergeDocId: "doc-abc123",
      headsHash: ""
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})
