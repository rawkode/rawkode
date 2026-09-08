import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { EntityId, IsoDateTimeString } from "./node.js"
import { VoiceSession, VoiceSessionStatus } from "./voice-session.js"

const id = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa6")
const workspaceId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa7")
const chatId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa8")
const startedAt = Schema.decodeUnknownSync(IsoDateTimeString)(new Date(0).toISOString())
const endedAt = Schema.decodeUnknownSync(IsoDateTimeString)(new Date(1_000).toISOString())

describe("VoiceSessionStatus", () => {
  it("accepts both documented statuses", () => {
    for (const status of ["active", "ended"]) {
      expect(Schema.decodeUnknownSync(VoiceSessionStatus)(status)).toBe(status)
    }
  })

  it("rejects an undocumented status", () => {
    const result = Schema.decodeUnknownEither(VoiceSessionStatus)("failed")
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("VoiceSession", () => {
  it("round-trips an ended session with endedAt present", () => {
    const session = new VoiceSession({ id, workspaceId, chatId, startedAt, endedAt, status: "ended" })
    const encoded = Schema.encodeSync(VoiceSession)(session)
    expect(Schema.decodeUnknownSync(VoiceSession)(encoded)).toEqual(session)
  })

  it("round-trips an active session with endedAt absent, and omits it from the encoded shape", () => {
    const session = new VoiceSession({ id, workspaceId, chatId, startedAt, status: "active" })
    const encoded = Schema.encodeSync(VoiceSession)(session)
    expect(Schema.decodeUnknownSync(VoiceSession)(encoded)).toEqual(session)
    expect("endedAt" in encoded).toBe(false)
  })

  it("rejects an undocumented status", () => {
    const result = Schema.decodeUnknownEither(VoiceSession)({
      id,
      workspaceId,
      chatId,
      startedAt,
      status: "paused"
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})
