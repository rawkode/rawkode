import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { EntityId, IsoDateTimeString } from "./node.js"
import {
  EndVoiceSessionInput,
  EndVoiceSessionOutput,
  StartVoiceSessionInput,
  StartVoiceSessionOutput
} from "./voice-session-rpc.js"
import { VoiceSession } from "./voice-session.js"

const roundTrip = <A, I>(schema: Schema.Schema<A, I>, value: A) => {
  const encoded = Schema.encodeSync(schema)(value)
  expect(Schema.decodeUnknownSync(schema)(encoded)).toEqual(value)
}

const workspaceId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa6")
const chatId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa7")
const voiceSessionId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa8")
const startedAt = Schema.decodeUnknownSync(IsoDateTimeString)(new Date(0).toISOString())
const endedAt = Schema.decodeUnknownSync(IsoDateTimeString)(new Date(1_000).toISOString())

describe("startVoiceSession/endVoiceSession RPC schemas", () => {
  it("round-trips StartVoiceSessionInput/Output", () => {
    roundTrip(StartVoiceSessionInput, new StartVoiceSessionInput({ workspaceId, chatId }))
    roundTrip(
      StartVoiceSessionOutput,
      new StartVoiceSessionOutput({
        voiceSession: new VoiceSession({
          id: voiceSessionId,
          workspaceId,
          chatId,
          startedAt,
          status: "active"
        })
      })
    )
  })

  it("round-trips EndVoiceSessionInput/Output", () => {
    roundTrip(
      EndVoiceSessionInput,
      new EndVoiceSessionInput({ workspaceId, voiceSessionId, endedAt })
    )
    roundTrip(
      EndVoiceSessionOutput,
      new EndVoiceSessionOutput({
        voiceSession: new VoiceSession({
          id: voiceSessionId,
          workspaceId,
          chatId,
          startedAt,
          endedAt,
          status: "ended"
        })
      })
    )
  })
})
