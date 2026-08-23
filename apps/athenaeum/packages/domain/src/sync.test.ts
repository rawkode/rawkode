import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { EntityId } from "./node.js"
import { AutomergeSyncSession, SyncFeedEntry, WorkspaceEpoch } from "./sync.js"

const validUuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6"

describe("SyncFeedEntry schema", () => {
  it("round-trips a put entry with a structured payload", () => {
    const entry = new SyncFeedEntry({
      replicaEpoch: 3,
      monotonicCounter: 142,
      entityKind: "node",
      entityId: EntityId.make(validUuid),
      operation: "put",
      payload: { title: "Daily note", createdAt: "2026-08-20T12:00:00.000Z" },
      hash: "sha256:abc123"
    })
    const encoded = Schema.encodeSync(SyncFeedEntry)(entry)
    expect(Schema.decodeUnknownSync(SyncFeedEntry)(encoded)).toEqual(entry)
  })

  it("round-trips a delete entry", () => {
    const entry = new SyncFeedEntry({
      replicaEpoch: 0,
      monotonicCounter: 0,
      entityKind: "edge",
      entityId: EntityId.make(validUuid),
      operation: "delete",
      payload: null,
      hash: "sha256:tombstone"
    })
    expect(Schema.decodeUnknownSync(SyncFeedEntry)(Schema.encodeSync(SyncFeedEntry)(entry))).toEqual(
      entry
    )
  })

  it("rejects an unknown operation", () => {
    const result = Schema.decodeUnknownEither(SyncFeedEntry)({
      replicaEpoch: 0,
      monotonicCounter: 0,
      entityKind: "node",
      entityId: validUuid,
      operation: "patch",
      payload: {},
      hash: "h"
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects a negative monotonicCounter", () => {
    const result = Schema.decodeUnknownEither(SyncFeedEntry)({
      replicaEpoch: 0,
      monotonicCounter: -1,
      entityKind: "node",
      entityId: validUuid,
      operation: "put",
      payload: {},
      hash: "h"
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects a fractional replicaEpoch", () => {
    const result = Schema.decodeUnknownEither(SyncFeedEntry)({
      replicaEpoch: 1.5,
      monotonicCounter: 0,
      entityKind: "node",
      entityId: validUuid,
      operation: "put",
      payload: {},
      hash: "h"
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("WorkspaceEpoch schema", () => {
  it("round-trips a non-empty opaque token", () => {
    const epoch = WorkspaceEpoch.make("epoch-9f8e7d6c")
    expect(Schema.decodeUnknownSync(WorkspaceEpoch)(Schema.encodeSync(WorkspaceEpoch)(epoch))).toEqual(
      epoch
    )
  })

  it("rejects an empty epoch token", () => {
    const result = Schema.decodeUnknownEither(WorkspaceEpoch)("")
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("AutomergeSyncSession schema", () => {
  it("round-trips a resumed session", () => {
    const session = new AutomergeSyncSession({ sessionId: "sess-1", ordinal: 7, reset: false })
    expect(
      Schema.decodeUnknownSync(AutomergeSyncSession)(Schema.encodeSync(AutomergeSyncSession)(session))
    ).toEqual(session)
  })

  it("round-trips a reset session", () => {
    const session = new AutomergeSyncSession({ sessionId: "sess-2", ordinal: 0, reset: true })
    expect(
      Schema.decodeUnknownSync(AutomergeSyncSession)(Schema.encodeSync(AutomergeSyncSession)(session))
    ).toEqual(session)
  })

  it("rejects a negative ordinal", () => {
    const result = Schema.decodeUnknownEither(AutomergeSyncSession)({
      sessionId: "sess-3",
      ordinal: -1,
      reset: false
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})
