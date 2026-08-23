import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { App, AppCodeKind, AppCodeVersion, AppIcon, MAX_APP_CODE_BYTES } from "./app.js"
import { EntityId, IsoDateTimeString, PendingMarker } from "./node.js"

const validUuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
const validUuid2 = "3fa85f64-5717-4562-b3fc-2c963f66afa7"
const validUlid = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
const validIso = "2026-08-20T12:00:00.000Z"

describe("AppCodeKind", () => {
  it("accepts client and server", () => {
    expect(Schema.decodeUnknownSync(AppCodeKind)("client")).toBe("client")
    expect(Schema.decodeUnknownSync(AppCodeKind)("server")).toBe("server")
  })

  it("rejects an unrecognized kind", () => {
    const result = Schema.decodeUnknownEither(AppCodeKind)("worker")
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("AppIcon", () => {
  it("accepts an emoji", () => {
    expect(Schema.decodeUnknownSync(AppIcon)("🧮")).toBe("🧮")
  })

  it("accepts a short identifier", () => {
    expect(Schema.decodeUnknownSync(AppIcon)("todo")).toBe("todo")
  })

  it("rejects an empty string", () => {
    const result = Schema.decodeUnknownEither(AppIcon)("")
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects a string longer than 32 chars", () => {
    const result = Schema.decodeUnknownEither(AppIcon)("x".repeat(33))
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("MAX_APP_CODE_BYTES", () => {
  it("is 256 KiB", () => {
    expect(MAX_APP_CODE_BYTES).toBe(256 * 1024)
  })
})

describe("App schema", () => {
  it("round-trips a codeless, non-pending App", () => {
    const app = new App({
      id: EntityId.make(validUuid),
      workspaceId: EntityId.make(validUuid2),
      title: "Counter",
      icon: AppIcon.make("🧮"),
      clientCodeVersion: 0,
      serverCodeVersion: 0,
      createdAt: IsoDateTimeString.make(validIso),
      updatedAt: IsoDateTimeString.make(validIso)
    })
    const encoded = Schema.encodeSync(App)(app)
    expect("pending" in encoded).toBe(false)
    expect(Schema.decodeUnknownSync(App)(encoded)).toEqual(app)
  })

  it("round-trips an App with both code pointers advanced", () => {
    const app = new App({
      id: EntityId.make(validUlid),
      workspaceId: EntityId.make(validUuid2),
      title: "Todo List",
      icon: AppIcon.make("todo"),
      clientCodeVersion: 3,
      serverCodeVersion: 2,
      createdAt: IsoDateTimeString.make(validIso),
      updatedAt: IsoDateTimeString.make(validIso)
    })
    const encoded = Schema.encodeSync(App)(app)
    expect(encoded.clientCodeVersion).toBe(3)
    expect(encoded.serverCodeVersion).toBe(2)
    expect(Schema.decodeUnknownSync(App)(encoded)).toEqual(app)
  })

  it("round-trips a pending (agent-proposed) App", () => {
    const app = new App({
      id: EntityId.make(validUuid),
      workspaceId: EntityId.make(validUuid2),
      title: "Agent-proposed App",
      icon: AppIcon.make("✨"),
      clientCodeVersion: 0,
      serverCodeVersion: 0,
      createdAt: IsoDateTimeString.make(validIso),
      updatedAt: IsoDateTimeString.make(validIso),
      pending: new PendingMarker({ chatId: EntityId.make(validUuid2) })
    })
    const encoded = Schema.encodeSync(App)(app)
    expect(encoded.pending).toEqual({ chatId: validUuid2 })
    expect(Schema.decodeUnknownSync(App)(encoded)).toEqual(app)
  })

  it("rejects an empty title", () => {
    const result = Schema.decodeUnknownEither(App)({
      id: validUuid,
      workspaceId: validUuid2,
      title: "",
      icon: "🧮",
      clientCodeVersion: 0,
      serverCodeVersion: 0,
      createdAt: validIso,
      updatedAt: validIso
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects a negative clientCodeVersion", () => {
    const result = Schema.decodeUnknownEither(App)({
      id: validUuid,
      workspaceId: validUuid2,
      title: "Counter",
      icon: "🧮",
      clientCodeVersion: -1,
      serverCodeVersion: 0,
      createdAt: validIso,
      updatedAt: validIso
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects a non-integer serverCodeVersion", () => {
    const result = Schema.decodeUnknownEither(App)({
      id: validUuid,
      workspaceId: validUuid2,
      title: "Counter",
      icon: "🧮",
      clientCodeVersion: 0,
      serverCodeVersion: 1.5,
      createdAt: validIso,
      updatedAt: validIso
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("AppCodeVersion schema", () => {
  it("round-trips a client code version", () => {
    const codeVersion = new AppCodeVersion({
      id: EntityId.make(validUuid),
      appId: EntityId.make(validUuid2),
      kind: "client",
      version: 1,
      code: "export default function App() { return <div>Hello</div> }",
      createdAt: IsoDateTimeString.make(validIso)
    })
    const encoded = Schema.encodeSync(AppCodeVersion)(codeVersion)
    expect(Schema.decodeUnknownSync(AppCodeVersion)(encoded)).toEqual(codeVersion)
  })

  it("round-trips a server code version", () => {
    const codeVersion = new AppCodeVersion({
      id: EntityId.make(validUuid),
      appId: EntityId.make(validUuid2),
      kind: "server",
      version: 4,
      code: "export default { async fetch(req) { return new Response('ok') } }",
      createdAt: IsoDateTimeString.make(validIso)
    })
    const encoded = Schema.encodeSync(AppCodeVersion)(codeVersion)
    expect(Schema.decodeUnknownSync(AppCodeVersion)(encoded)).toEqual(codeVersion)
  })

  it("rejects version 0 (versions are 1-based)", () => {
    const result = Schema.decodeUnknownEither(AppCodeVersion)({
      id: validUuid,
      appId: validUuid2,
      kind: "client",
      version: 0,
      code: "",
      createdAt: validIso
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects a negative version", () => {
    const result = Schema.decodeUnknownEither(AppCodeVersion)({
      id: validUuid,
      appId: validUuid2,
      kind: "server",
      version: -1,
      code: "",
      createdAt: validIso
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects an unrecognized kind", () => {
    const result = Schema.decodeUnknownEither(AppCodeVersion)({
      id: validUuid,
      appId: validUuid2,
      kind: "worker",
      version: 1,
      code: "",
      createdAt: validIso
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("accepts empty code (a version can legitimately be an empty file)", () => {
    const result = Schema.decodeUnknownEither(AppCodeVersion)({
      id: validUuid,
      appId: validUuid2,
      kind: "client",
      version: 1,
      code: "",
      createdAt: validIso
    })
    expect(Either.isRight(result)).toBe(true)
  })
})
