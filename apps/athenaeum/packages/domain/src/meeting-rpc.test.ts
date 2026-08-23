import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  AppendTranscriptSegmentInput,
  AppendTranscriptSegmentOutput,
  EndMeetingInput,
  EndMeetingOutput,
  GetMeetingInput,
  GetMeetingOutput,
  ListMeetingsInput,
  ListMeetingsOutput,
  StartMeetingInput,
  StartMeetingOutput
} from "./meeting-rpc.js"
import { Meeting, Speaker, TranscriptSegmentRecord } from "./meeting.js"
import { EntityId, IsoDateTimeString } from "./node.js"

const roundTrip = <A, I>(schema: Schema.Schema<A, I>, value: A) => {
  const encoded = Schema.encodeSync(schema)(value)
  expect(Schema.decodeUnknownSync(schema)(encoded)).toEqual(value)
}

const workspaceId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa6")
const meetingId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa7")
const speakerId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa8")
const segmentId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa9")
const startedAt = Schema.decodeUnknownSync(IsoDateTimeString)(new Date(0).toISOString())
const endedAt = Schema.decodeUnknownSync(IsoDateTimeString)(new Date(1_000).toISOString())

const meeting = new Meeting({ id: meetingId, workspaceId, title: "Standup", startedAt })
const endedMeeting = new Meeting({ id: meetingId, workspaceId, title: "Standup", startedAt, endedAt })
const speaker = new Speaker({ id: speakerId, meetingId, label: "Speaker 1" })
const segment = new TranscriptSegmentRecord({
  id: segmentId,
  meetingId,
  speakerId,
  text: "Morning.",
  startOffsetMs: 0,
  endOffsetMs: 500,
  source: "on-device"
})

describe("startMeeting/endMeeting RPC schemas", () => {
  it("round-trips StartMeetingInput/Output", () => {
    roundTrip(StartMeetingInput, new StartMeetingInput({ workspaceId, title: "Standup" }))
    roundTrip(StartMeetingOutput, new StartMeetingOutput({ meeting }))
  })

  it("round-trips EndMeetingInput/Output", () => {
    roundTrip(EndMeetingInput, new EndMeetingInput({ workspaceId, meetingId, endedAt }))
    roundTrip(EndMeetingOutput, new EndMeetingOutput({ meeting: endedMeeting }))
  })
})

describe("appendTranscriptSegment RPC schema", () => {
  it("round-trips with speakerId present", () => {
    roundTrip(
      AppendTranscriptSegmentInput,
      new AppendTranscriptSegmentInput({
        workspaceId,
        meetingId,
        speakerId,
        text: "Morning.",
        startOffsetMs: 0,
        endOffsetMs: 500,
        source: "on-device"
      })
    )
    roundTrip(AppendTranscriptSegmentOutput, new AppendTranscriptSegmentOutput({ segment }))
  })

  it("round-trips with speakerId absent", () => {
    roundTrip(
      AppendTranscriptSegmentInput,
      new AppendTranscriptSegmentInput({
        workspaceId,
        meetingId,
        text: "Unattributed.",
        startOffsetMs: 500,
        endOffsetMs: 900,
        source: "cloud"
      })
    )
  })
})

describe("getMeeting/listMeetings RPC schemas", () => {
  it("round-trips GetMeetingInput/Output with a full transcript + speaker roster", () => {
    roundTrip(GetMeetingInput, new GetMeetingInput({ workspaceId, meetingId }))
    roundTrip(
      GetMeetingOutput,
      new GetMeetingOutput({ meeting, segments: [segment], speakers: [speaker] })
    )
  })

  it("round-trips GetMeetingOutput with an empty transcript/speaker roster", () => {
    roundTrip(GetMeetingOutput, new GetMeetingOutput({ meeting, segments: [], speakers: [] }))
  })

  it("round-trips ListMeetingsInput/Output", () => {
    roundTrip(ListMeetingsInput, new ListMeetingsInput({ workspaceId }))
    roundTrip(ListMeetingsOutput, new ListMeetingsOutput({ meetings: [meeting, endedMeeting] }))
  })
})
