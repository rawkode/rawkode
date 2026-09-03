import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { Bookmark, BookmarkUrl } from "./bookmark.js"
import { EntityId, IsoDateTimeString } from "./node.js"

const id = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa6")
const workspaceId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa7")
const nodeId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa8")
const capturedAt = Schema.decodeUnknownSync(IsoDateTimeString)(new Date(0).toISOString())

describe("BookmarkUrl", () => {
  it("accepts an absolute https URL", () => {
    expect(Schema.decodeUnknownSync(BookmarkUrl)("https://example.com/article")).toBe(
      "https://example.com/article"
    )
  })

  it("accepts an absolute http URL", () => {
    expect(Schema.decodeUnknownSync(BookmarkUrl)("http://example.com")).toBe("http://example.com")
  })

  it("rejects a non-http(s) scheme (e.g. javascript:)", () => {
    const result = Schema.decodeUnknownEither(BookmarkUrl)("javascript:alert(1)")
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects a relative path", () => {
    const result = Schema.decodeUnknownEither(BookmarkUrl)("/not/absolute")
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects a malformed string", () => {
    const result = Schema.decodeUnknownEither(BookmarkUrl)("not a url at all")
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("Bookmark", () => {
  it("round-trips with title and linkedNodeId present", () => {
    const bookmark = new Bookmark({
      id,
      workspaceId,
      url: Schema.decodeUnknownSync(BookmarkUrl)("https://example.com/article"),
      title: "An article",
      capturedAt,
      linkedNodeId: nodeId
    })
    const encoded = Schema.encodeSync(Bookmark)(bookmark)
    expect(Schema.decodeUnknownSync(Bookmark)(encoded)).toEqual(bookmark)
  })

  it("round-trips with title/linkedNodeId absent, and omits them from the encoded shape", () => {
    const bookmark = new Bookmark({
      id,
      workspaceId,
      url: Schema.decodeUnknownSync(BookmarkUrl)("https://example.com"),
      capturedAt
    })
    const encoded = Schema.encodeSync(Bookmark)(bookmark)
    expect(Schema.decodeUnknownSync(Bookmark)(encoded)).toEqual(bookmark)
    expect("title" in encoded).toBe(false)
    expect("linkedNodeId" in encoded).toBe(false)
  })
})
