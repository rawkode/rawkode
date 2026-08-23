// `MeetingsService` end-to-end tests — Phase 6 task item 1's "startMeeting/endMeeting/
// appendTranscriptSegment/getMeeting/listMeetings, storing large transcript/audio content per the
// plan's storage-tier split (R2 for audio blobs, DO SQLite for structured transcript
// segments/metadata)". Runs over REAL Cap'n Web RPC against a REAL `WorkspaceDurableObject`
// (`connectToWorkspace`/`connectToWorkspaceWithSocketAs`, same harness every other backend test in this
// suite uses) — every RPC decode/encode, `requireRoleForGovernedWorkspace` gating, and
// `typed-storage-effect` write in `MeetingsService` runs for real. The R2 storage-tier split is
// proven separately, via the `ctx.exports`-only `debugStoreMeetingAudioChunk`/
// `debugGetMeetingAudioChunk` hooks (see `workspace-durable-object.ts`'s own doc comment on those
// methods for why no public RPC entrypoint exists yet) against a real, locally-simulated
// `MEETING_AUDIO` R2 binding — not mocked.

import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import { CreateWorkspaceInput, CreateWorkspaceOutput, type EntityId } from "@athenaeum/domain"
import {
  connectToUserAs,
  connectToWorkspace,
  connectToWorkspaceWithSocketAs,
  devSignIn,
  freshWorkspaceId,
  rejectionToDomainError,
  workspaceDurableObjectStub
} from "./support.js"

describe("MeetingsService: startMeeting/endMeeting/appendTranscriptSegment/getMeeting/listMeetings", () => {
  it("round-trips a full meeting lifecycle on an ungoverned workspace", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspace(workspaceId)
    try {
      const started = (await stub.startMeeting({ workspaceId, title: "Weekly sync" })) as {
        meeting: { id: string; title: string; endedAt?: string }
      }
      expect(started.meeting.title).toBe("Weekly sync")
      expect(started.meeting.endedAt).toBeUndefined()
      const meetingId = started.meeting.id

      // Appended out of chronological order — `getMeeting` must still return them sorted by
      // `startOffsetMs`, per meeting-rpc.ts's own doc comment on `GetMeetingOutput`.
      const second = (await stub.appendTranscriptSegment({
        workspaceId,
        meetingId,
        text: "...so let's ship it Friday.",
        startOffsetMs: 5_000,
        endOffsetMs: 7_200,
        source: "on-device"
      })) as { segment: { id: string; text: string; source: string } }
      expect(second.segment.source).toBe("on-device")

      const first = (await stub.appendTranscriptSegment({
        workspaceId,
        meetingId,
        text: "Let's get started.",
        startOffsetMs: 0,
        endOffsetMs: 1_500,
        source: "cloud"
      })) as { segment: { id: string; text: string; source: string } }
      expect(first.segment.source).toBe("cloud")

      const endedAt = new Date().toISOString()
      const ended = (await stub.endMeeting({ workspaceId, meetingId, endedAt })) as { meeting: { endedAt: string } }
      expect(ended.meeting.endedAt).toBe(endedAt)

      const got = (await stub.getMeeting({ workspaceId, meetingId })) as {
        meeting: { id: string; endedAt: string }
        segments: ReadonlyArray<{ id: string; text: string; startOffsetMs: number }>
        speakers: ReadonlyArray<unknown>
      }
      expect(got.meeting.id).toBe(meetingId)
      expect(got.meeting.endedAt).toBe(endedAt)
      expect(got.segments.map((s) => s.text)).toEqual(["Let's get started.", "...so let's ship it Friday."])
      expect(got.speakers).toEqual([])

      const listed = (await stub.listMeetings({ workspaceId })) as { meetings: ReadonlyArray<{ id: string }> }
      expect(listed.meetings.map((m) => m.id)).toContain(meetingId)
    } finally {
      stub[Symbol.dispose]()
    }
  })

  it("fails with MeetingNotFound for a meetingId that was never created", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspace(workspaceId)
    try {
      const bogusMeetingId = freshWorkspaceId() // any well-formed EntityId that was never startMeeting'd

      const endError = await rejectionToDomainError(
        stub.endMeeting({ workspaceId, meetingId: bogusMeetingId, endedAt: new Date().toISOString() })
      )
      expect(endError._tag).toBe("MeetingNotFound")

      const appendError = await rejectionToDomainError(
        stub.appendTranscriptSegment({
          workspaceId,
          meetingId: bogusMeetingId,
          text: "unreachable",
          startOffsetMs: 0,
          endOffsetMs: 1,
          source: "on-device"
        })
      )
      expect(appendError._tag).toBe("MeetingNotFound")

      const getError = await rejectionToDomainError(stub.getMeeting({ workspaceId, meetingId: bogusMeetingId }))
      expect(getError._tag).toBe("MeetingNotFound")
    } finally {
      stub[Symbol.dispose]()
    }
  })

  it("rejects an anonymous caller on a GOVERNED workspace (requireRoleForGovernedWorkspace, no exceptions)", async () => {
    const ownerEmail = `meetings-owner-${crypto.randomUUID()}@rawkode.academy`
    const { credential } = await devSignIn(ownerEmail)
    const { stub: userStub, socket: userSocket } = await connectToUserAs(credential)
    let workspaceId: EntityId
    try {
      const created = Schema.decodeUnknownSync(CreateWorkspaceOutput)(
        await userStub.createWorkspace(Schema.encodeSync(CreateWorkspaceInput)(new CreateWorkspaceInput({ title: "Governed meetings workspace" })))
      )
      workspaceId = created.workspace.workspaceId
    } finally {
      userStub[Symbol.dispose]()
      userSocket.close()
    }

    const anonymousStub = await connectToWorkspace(workspaceId)
    try {
      const startError = await rejectionToDomainError(anonymousStub.startMeeting({ workspaceId, title: "Should be rejected" }))
      expect(startError._tag).toBe("Unauthorized")

      const listError = await rejectionToDomainError(anonymousStub.listMeetings({ workspaceId }))
      expect(listError._tag).toBe("Unauthorized")
    } finally {
      anonymousStub[Symbol.dispose]()
    }

    // The owner's own credentialed connection works exactly as the ungoverned-workspace case above.
    const { stub: ownerWorkspaceStub, socket: ownerSocket } = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const started = (await ownerWorkspaceStub.startMeeting({ workspaceId, title: "Owner-started meeting" })) as {
        meeting: { id: string }
      }
      expect(typeof started.meeting.id).toBe("string")
    } finally {
      ownerWorkspaceStub[Symbol.dispose]()
      ownerSocket.close()
    }
  })
})

describe("MeetingsService: R2 storage-tier split (real, locally-simulated MEETING_AUDIO binding)", () => {
  afterEach(() => {
    // No test-hook state to reset here (the R2 binding itself is real, not swapped) — kept as an
    // explicit `afterEach` anyway so a future addition to this suite that DOES install a hook has
    // an obvious place to reset it, matching every other test file's own convention.
  })

  it("round-trips a real audio chunk through R2, addressed by (workspaceId, meetingId, chunkIndex)", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspace(workspaceId)
    let meetingId: string
    try {
      const started = (await stub.startMeeting({ workspaceId, title: "Audio-bearing meeting" })) as { meeting: { id: string } }
      meetingId = started.meeting.id
    } finally {
      stub[Symbol.dispose]()
    }

    const doStub = workspaceDurableObjectStub(workspaceId)
    const audioBytes = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252, 253, 254, 255])

    const missingBeforeWrite = await doStub.debugGetMeetingAudioChunk(meetingId, 0)
    expect(missingBeforeWrite).toBeUndefined()

    const stored = await doStub.debugStoreMeetingAudioChunk(meetingId, 0, audioBytes, "audio/wav")
    expect(stored.r2Key).toBe(`meetings/${workspaceId}/${meetingId}/audio/000000.bin`)

    const readBack = await doStub.debugGetMeetingAudioChunk(meetingId, 0)
    expect(readBack).toBeInstanceOf(Uint8Array)
    expect(Array.from(readBack as Uint8Array)).toEqual(Array.from(audioBytes))

    // A different chunk index for the same meeting is a genuinely separate R2 object.
    const missingOtherChunk = await doStub.debugGetMeetingAudioChunk(meetingId, 1)
    expect(missingOtherChunk).toBeUndefined()
  })

  it("fails with MeetingNotFound for an audio chunk against a meeting that doesn't exist", async () => {
    const workspaceId = freshWorkspaceId()
    const doStub = workspaceDurableObjectStub(workspaceId)
    const bogusMeetingId = freshWorkspaceId()

    await expect(
      doStub.debugStoreMeetingAudioChunk(bogusMeetingId, 0, new Uint8Array([1]), "audio/wav")
    ).rejects.toThrow(/MeetingNotFound/)
  })
})
