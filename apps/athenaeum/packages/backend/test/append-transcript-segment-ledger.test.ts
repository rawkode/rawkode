import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  AppendTranscriptSegmentInput,
  AppendTranscriptSegmentLedgerCommand,
  AppendTranscriptSegmentOutput,
  HumanUiMutationAttribution,
  LedgerCommand,
  ListRecentLedgerActivityOutput,
  GetMeetingOutput,
  SyncFeedInput,
  SyncFeedOutput,
  type EntityId
} from "@athenaeum/domain"
import { ledgerExecuteTestHook } from "../src/ledger-service.js"
import {
  connectToWorkspace,
  connectToWorkspaceWithSocketAs,
  devSignIn,
  freshWorkspaceId,
  rejectionToDomainError,
  workspaceDurableObjectStub
} from "./support.js"

const attribution = (surface: "macos" | "web-backlinks" = "macos") => new HumanUiMutationAttribution({
  version: "athenaeum.mutation-attribution.v1",
  kind: "humanUi",
  surface
})

const input = (args: {
  readonly workspaceId: EntityId
  readonly meetingId: EntityId
  readonly requestId: string
  readonly speakerId?: EntityId
  readonly text?: string
  readonly startOffsetMs?: number
  readonly endOffsetMs?: number
  readonly source?: "on-device" | "cloud"
  readonly commitMessage?: string
  readonly attribution?: HumanUiMutationAttribution
}) => Schema.encodeSync(AppendTranscriptSegmentInput)(new AppendTranscriptSegmentInput({
  workspaceId: args.workspaceId,
  meetingId: args.meetingId,
  requestId: args.requestId,
  commitMessage: args.commitMessage ?? "Capture this transcript segment for the second brain.",
  attribution: args.attribution ?? attribution(),
  ...(args.speakerId === undefined ? {} : { speakerId: args.speakerId }),
  text: args.text ?? "  Preserve exact transcript text.  ",
  startOffsetMs: args.startOffsetMs ?? 1_250,
  endOffsetMs: args.endOffsetMs ?? 2_500,
  source: args.source ?? "on-device"
}))

const meeting = async (stub: Awaited<ReturnType<typeof connectToWorkspace>>, workspaceId: EntityId, meetingId: EntityId) =>
  Schema.decodeUnknownSync(GetMeetingOutput)(await stub.getMeeting({ workspaceId, meetingId }))

const feed = async (stub: Awaited<ReturnType<typeof connectToWorkspace>>, workspaceId: EntityId) =>
  Schema.decodeUnknownSync(SyncFeedOutput)(await stub.syncFeed(
    Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 100 }))
  )).entries

describe("appendTranscriptSegment ledger authority slice", () => {
  afterEach(() => {
    ledgerExecuteTestHook.afterMutation = undefined
  })

  it("preserves exact transcript semantics and replays without duplicate rows or public leakage", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential, email } = await devSignIn(`transcript-ledger-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const started = await connection.stub.startMeeting({ workspaceId, title: "Ledgered transcript", requestId: "transcript-start-1", commitMessage: "Start the ledgered transcript meeting.", attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "macos" } }) as { meeting: { id: EntityId } }
      const meetingId = started.meeting.id
      const first = Schema.decodeUnknownSync(AppendTranscriptSegmentOutput)(await connection.stub.appendTranscriptSegment(input({
        workspaceId, meetingId, requestId: "transcript-ledger-1"
      })))
      const replay = Schema.decodeUnknownSync(AppendTranscriptSegmentOutput)(await connection.stub.appendTranscriptSegment(input({
        workspaceId, meetingId, requestId: "transcript-ledger-1"
      })))
      expect(replay).toEqual(first)
      expect(first.segment.text).toBe("  Preserve exact transcript text.  ")
      expect(first.segment.startOffsetMs).toBe(1_250)
      expect(first.segment.endOffsetMs).toBe(2_500)

      const native = workspaceDurableObjectStub(workspaceId)
      const requestIdentity = "append-transcript-segment:transcript-ledger-1"
      const command = Schema.decodeUnknownSync(AppendTranscriptSegmentLedgerCommand)(await native.debugGetLedgerCommand(requestIdentity))
      expect(command).toMatchObject({
        type: "appendTranscriptSegment",
        principal: email,
        message: "Appended a transcript segment.",
        payload: {
          meetingId,
          segmentId: first.segment.id,
          speakerId: { present: false, value: null },
          text: "  Preserve exact transcript text.  ",
          startOffsetMs: 1_250,
          endOffsetMs: 2_500,
          source: "on-device",
          commitMessage: "Capture this transcript segment for the second brain.",
          attribution: { kind: "humanUi", surface: "macos" }
        }
      })
      expect(Schema.decodeUnknownSync(LedgerCommand)(command).type).toBe("appendTranscriptSegment")
      expect(await native.debugGetLedgerReceipt(requestIdentity)).toMatchObject({
        output: { version: "athenaeum.workspace-ledger-receipt.v2", type: "appendTranscriptSegment" }
      })
      const sideEffect = { meetingId, segmentId: first.segment.id }
      expect(await native.debugGetLedgerEvent(requestIdentity)).toEqual({ kind: "append-transcript-segment", payload: sideEffect })
      expect(await native.debugGetLedgerOutboxIntent(requestIdentity)).toEqual({ kind: "append-transcript-segment", payload: sideEffect })
      expect((await meeting(connection.stub, workspaceId, meetingId)).segments).toHaveLength(1)
      expect((await feed(connection.stub, workspaceId)).filter((entry) => entry.entityKind === "transcriptSegment" && entry.entityId === first.segment.id)).toHaveLength(1)

      const activity = Schema.decodeUnknownSync(ListRecentLedgerActivityOutput)(await connection.stub.listRecentLedgerActivity({ workspaceId, limit: 10 }))
      expect(activity.entries.find((entry) => entry.type === "appendTranscriptSegment")).toEqual({
        occurredAt: expect.any(String), type: "appendTranscriptSegment", actor: "you", message: "Appended a transcript segment."
      })
      expect(JSON.stringify(await native.debugGetLedgerEvent(requestIdentity))).not.toContain("Preserve exact")

      const empty = Schema.decodeUnknownSync(AppendTranscriptSegmentOutput)(await connection.stub.appendTranscriptSegment(input({
        workspaceId, meetingId, requestId: "transcript-empty", text: ""
      })))
      expect(empty.segment.text).toBe("")
      expect((await meeting(connection.stub, workspaceId, meetingId)).segments.filter((segment) => segment.id === empty.segment.id)).toHaveLength(1)
    } finally {
      connection.stub[Symbol.dispose]()
      connection.socket.close()
    }
  })

  it("treats speaker presence, exact text, offsets, source, rationale, and attribution as immutable request semantics", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`transcript-conflicts-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const started = await connection.stub.startMeeting({ workspaceId, title: "Conflict transcript", requestId: "transcript-start-2", commitMessage: "Start the conflict transcript meeting.", attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "macos" } }) as { meeting: { id: EntityId } }
      const meetingId = started.meeting.id
      const speakerId = freshWorkspaceId()
      const cases = [
        { requestId: "transcript-text-conflict", changed: { text: "changed" } },
        { requestId: "transcript-offset-conflict", changed: { startOffsetMs: 2_000 } },
        { requestId: "transcript-source-conflict", changed: { source: "cloud" as const } },
        { requestId: "transcript-speaker-conflict", changed: { speakerId } },
        { requestId: "transcript-rationale-conflict", changed: { commitMessage: "A different reason." } },
        { requestId: "transcript-attribution-conflict", changed: { attribution: attribution("web-backlinks") } }
      ] as const
      for (const testCase of cases) {
        const first = Schema.decodeUnknownSync(AppendTranscriptSegmentOutput)(await connection.stub.appendTranscriptSegment(input({ workspaceId, meetingId, requestId: testCase.requestId })))
        const error = await rejectionToDomainError(connection.stub.appendTranscriptSegment(input({ workspaceId, meetingId, requestId: testCase.requestId, ...testCase.changed })))
        expect(error._tag).toBe("ValidationError")
        expect((await meeting(connection.stub, workspaceId, meetingId)).segments.filter((segment) => segment.id === first.segment.id)).toHaveLength(1)
      }
      const absent = Schema.decodeUnknownSync(AppendTranscriptSegmentOutput)(await connection.stub.appendTranscriptSegment(input({ workspaceId, meetingId, requestId: "transcript-absent", speakerId: undefined })))
      const present = Schema.decodeUnknownSync(AppendTranscriptSegmentOutput)(await connection.stub.appendTranscriptSegment(input({ workspaceId, meetingId, requestId: "transcript-present", speakerId })))
      expect(absent.segment.speakerId).toBeUndefined()
      expect(present.segment.speakerId).toBe(speakerId)
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("append-transcript-segment:transcript-absent")).toMatchObject({ payload: { speakerId: { present: false, value: null } } })
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("append-transcript-segment:transcript-present")).toMatchObject({ payload: { speakerId: { present: true, value: speakerId } } })
    } finally {
      connection.stub[Symbol.dispose]()
      connection.socket.close()
    }
  })

  it("rejects anonymous, cross-workspace, and missing meetings, and rolls back every ledger side effect", async () => {
    const workspaceId = freshWorkspaceId()
    const otherWorkspaceId = freshWorkspaceId()
    const anonymous = await connectToWorkspace(workspaceId)
    const { credential } = await devSignIn(`transcript-invalid-${crypto.randomUUID()}@example.com`)
    const authenticated = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    const other = await connectToWorkspaceWithSocketAs(otherWorkspaceId, credential)
    try {
      expect((await rejectionToDomainError(anonymous.appendTranscriptSegment(input({ workspaceId, meetingId: freshWorkspaceId(), requestId: "transcript-anonymous" }))))._tag).toBe("Unauthorized")
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("append-transcript-segment:transcript-anonymous")).toBeNull()

      const bogusMeetingId = freshWorkspaceId()
      expect((await rejectionToDomainError(authenticated.stub.appendTranscriptSegment(input({ workspaceId, meetingId: bogusMeetingId, requestId: "transcript-missing" }))))._tag).toBe("MeetingNotFound")
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("append-transcript-segment:transcript-missing")).toBeNull()

      const foreignMeeting = await other.stub.startMeeting({ workspaceId: otherWorkspaceId, title: "Foreign transcript", requestId: "transcript-start-foreign", commitMessage: "Start the foreign transcript meeting.", attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "macos" } }) as { meeting: { id: EntityId } }
      expect((await rejectionToDomainError(authenticated.stub.appendTranscriptSegment(input({ workspaceId, meetingId: foreignMeeting.meeting.id, requestId: "transcript-cross-workspace" }))))._tag).toBe("MeetingNotFound")
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("append-transcript-segment:transcript-cross-workspace")).toBeNull()

      const started = await authenticated.stub.startMeeting({ workspaceId, title: "Rollback transcript", requestId: "transcript-start-rollback", commitMessage: "Start the rollback transcript meeting.", attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "macos" } }) as { meeting: { id: EntityId } }
      const rollbackMeetingId = started.meeting.id
      const before = await meeting(authenticated.stub, workspaceId, rollbackMeetingId)
      ledgerExecuteTestHook.afterMutation = () => { throw new Error("appendTranscriptSegment ledger failpoint") }
      expect((await rejectionToDomainError(authenticated.stub.appendTranscriptSegment(input({ workspaceId, meetingId: rollbackMeetingId, requestId: "transcript-rollback" }))))._tag).toBe("UnexpectedError")
      ledgerExecuteTestHook.afterMutation = undefined
      expect(await meeting(authenticated.stub, workspaceId, rollbackMeetingId)).toEqual(before)
      const native = workspaceDurableObjectStub(workspaceId)
      expect(await native.debugGetLedgerCommand("append-transcript-segment:transcript-rollback")).toBeNull()
      expect(await native.debugGetLedgerReceipt("append-transcript-segment:transcript-rollback")).toBeNull()
      expect(await native.debugGetLedgerEvent("append-transcript-segment:transcript-rollback")).toBeNull()
      expect(await native.debugGetLedgerOutboxIntent("append-transcript-segment:transcript-rollback")).toBeNull()
    } finally {
      ledgerExecuteTestHook.afterMutation = undefined
      authenticated.stub[Symbol.dispose]()
      authenticated.socket.close()
      other.stub[Symbol.dispose]()
      other.socket.close()
      anonymous[Symbol.dispose]()
    }
  })
})
