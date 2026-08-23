import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { Meeting, Speaker, TranscriptSegmentRecord, TranscriptSegmentSource } from "./meeting.js"
import { EntityId, IsoDateTimeString } from "./node.js"

const id = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa6")
const workspaceId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa7")
const meetingId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa8")
const nodeId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa9")
const speakerId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afaa")
const startedAt = Schema.decodeUnknownSync(IsoDateTimeString)(new Date(0).toISOString())
const endedAt = Schema.decodeUnknownSync(IsoDateTimeString)(new Date(1_000).toISOString())

describe("Meeting", () => {
  it("round-trips with endedAt and linkedNodeId present", () => {
    const meeting = new Meeting({
      id,
      workspaceId,
      title: "Weekly sync",
      startedAt,
      endedAt,
      linkedNodeId: nodeId
    })
    const encoded = Schema.encodeSync(Meeting)(meeting)
    expect(Schema.decodeUnknownSync(Meeting)(encoded)).toEqual(meeting)
  })

  it("round-trips with endedAt/linkedNodeId absent, and omits them from the encoded shape", () => {
    const meeting = new Meeting({ id, workspaceId, title: "In progress", startedAt })
    const encoded = Schema.encodeSync(Meeting)(meeting)
    expect(Schema.decodeUnknownSync(Meeting)(encoded)).toEqual(meeting)
    expect("endedAt" in encoded).toBe(false)
    expect("linkedNodeId" in encoded).toBe(false)
  })

  it("rejects an empty title", () => {
    const result = Schema.decodeUnknownEither(Meeting)({
      id,
      workspaceId,
      title: "",
      startedAt
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("Speaker", () => {
  it("round-trips", () => {
    const speaker = new Speaker({ id: speakerId, meetingId, label: "Speaker 1" })
    const encoded = Schema.encodeSync(Speaker)(speaker)
    expect(Schema.decodeUnknownSync(Speaker)(encoded)).toEqual(speaker)
  })

  it("rejects an empty label", () => {
    const result = Schema.decodeUnknownEither(Speaker)({ id: speakerId, meetingId, label: "" })
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("TranscriptSegmentSource", () => {
  it("accepts both documented sources", () => {
    for (const source of ["on-device", "cloud"]) {
      expect(Schema.decodeUnknownSync(TranscriptSegmentSource)(source)).toBe(source)
    }
  })

  it("rejects an undocumented source", () => {
    const result = Schema.decodeUnknownEither(TranscriptSegmentSource)("microphone")
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("TranscriptSegmentRecord", () => {
  it("round-trips with speakerId present, on-device source", () => {
    const segment = new TranscriptSegmentRecord({
      id,
      meetingId,
      speakerId,
      text: "Let's get started.",
      startOffsetMs: 0,
      endOffsetMs: 1_500,
      source: "on-device"
    })
    const encoded = Schema.encodeSync(TranscriptSegmentRecord)(segment)
    expect(Schema.decodeUnknownSync(TranscriptSegmentRecord)(encoded)).toEqual(segment)
  })

  it("round-trips with speakerId absent, cloud source, and omits speakerId from the encoded shape", () => {
    const segment = new TranscriptSegmentRecord({
      id,
      meetingId,
      text: "Sorry, could you repeat that?",
      startOffsetMs: 1_500,
      endOffsetMs: 3_200,
      source: "cloud"
    })
    const encoded = Schema.encodeSync(TranscriptSegmentRecord)(segment)
    expect(Schema.decodeUnknownSync(TranscriptSegmentRecord)(encoded)).toEqual(segment)
    expect("speakerId" in encoded).toBe(false)
  })

  it("rejects a negative startOffsetMs", () => {
    const result = Schema.decodeUnknownEither(TranscriptSegmentRecord)({
      id,
      meetingId,
      text: "x",
      startOffsetMs: -1,
      endOffsetMs: 10,
      source: "cloud"
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects a non-integer offset", () => {
    const result = Schema.decodeUnknownEither(TranscriptSegmentRecord)({
      id,
      meetingId,
      text: "x",
      startOffsetMs: 1.5,
      endOffsetMs: 10,
      source: "cloud"
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})
