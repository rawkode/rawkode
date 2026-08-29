import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  HumanUiMutationAttribution,
  ListMeetingsInput,
  ListMeetingsOutput,
  ListRecentLedgerActivityOutput,
  StartMeetingInput,
  StartMeetingLedgerCommand,
  StartMeetingOutput,
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

const attribution = (surface: "macos" | "web-bookmarks" = "macos") => new HumanUiMutationAttribution({
  version: "athenaeum.mutation-attribution.v1",
  kind: "humanUi",
  surface
})

const input = (args: {
  readonly workspaceId: EntityId
  readonly requestId: string
  readonly title?: string
  readonly commitMessage?: string
  readonly attribution?: HumanUiMutationAttribution
}) => Schema.encodeSync(StartMeetingInput)(new StartMeetingInput({
  workspaceId: args.workspaceId,
  requestId: args.requestId,
  title: args.title ?? "  Preserve exact meeting title.  ",
  commitMessage: args.commitMessage ?? "Start this meeting session for the second brain.",
  attribution: args.attribution ?? attribution()
}))

const meetings = async (stub: Awaited<ReturnType<typeof connectToWorkspace>>, workspaceId: EntityId) =>
  Schema.decodeUnknownSync(ListMeetingsOutput)(await stub.listMeetings(
    Schema.encodeSync(ListMeetingsInput)(new ListMeetingsInput({ workspaceId }))
  )).meetings

const feed = async (stub: Awaited<ReturnType<typeof connectToWorkspace>>, workspaceId: EntityId) =>
  Schema.decodeUnknownSync(SyncFeedOutput)(await stub.syncFeed(
    Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 100 }))
  )).entries

describe("startMeeting ledger authority slice", () => {
  afterEach(() => {
    ledgerExecuteTestHook.afterMutation = undefined
  })

  it("preserves exact title semantics and replays an applied-then-response-lost start without duplicate side effects", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential, email } = await devSignIn(`meeting-ledger-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      // Model a response lost after commit: retrying the caller-owned identity must return the
      // historical meeting instead of starting another session.
      const first = Schema.decodeUnknownSync(StartMeetingOutput)(await connection.stub.startMeeting(input({
        workspaceId, requestId: "meeting-ledger-1"
      })))
      const replay = Schema.decodeUnknownSync(StartMeetingOutput)(await connection.stub.startMeeting(input({
        workspaceId, requestId: "meeting-ledger-1"
      })))
      expect(replay).toEqual(first)
      expect(first.meeting.title).toBe("  Preserve exact meeting title.  ")
      expect(await meetings(connection.stub, workspaceId)).toHaveLength(1)
      expect((await feed(connection.stub, workspaceId)).filter((entry) => entry.entityKind === "meeting")).toHaveLength(1)

      const native = workspaceDurableObjectStub(workspaceId)
      const requestIdentity = "start-meeting:meeting-ledger-1"
      const command = Schema.decodeUnknownSync(StartMeetingLedgerCommand)(await native.debugGetLedgerCommand(requestIdentity))
      expect(command).toMatchObject({
        type: "startMeeting",
        principal: email,
        message: "Started a meeting.",
        payload: {
          meetingId: first.meeting.id,
          title: "  Preserve exact meeting title.  ",
          commitMessage: "Start this meeting session for the second brain."
        }
      })
      expect(command.payload.startedAt).toBe(first.meeting.startedAt)
      expect(await native.debugGetLedgerEvent(requestIdentity)).toEqual({ kind: "start-meeting", payload: { meetingId: first.meeting.id } })
      expect(await native.debugGetLedgerOutboxIntent(requestIdentity)).toEqual({ kind: "start-meeting", payload: { meetingId: first.meeting.id } })

      const activity = Schema.decodeUnknownSync(ListRecentLedgerActivityOutput)(await connection.stub.listRecentLedgerActivity({ workspaceId, limit: 20 }))
      expect(activity.entries).toContainEqual(expect.objectContaining({ type: "startMeeting", message: "Started a meeting." }))
      expect(JSON.stringify(activity.entries)).not.toContain("Preserve exact meeting title")
    } finally {
      connection.stub[Symbol.dispose]()
      connection.socket.close()
    }
  })

  it("conflicts before mutation for an identity whose semantic title, rationale, attribution, or principal changes", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`meeting-conflict-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      await connection.stub.startMeeting(input({ workspaceId, requestId: "meeting-conflict" }))
      const changed = await rejectionToDomainError(connection.stub.startMeeting(input({
        workspaceId, requestId: "meeting-conflict", title: "  Preserve exact meeting title. "
      })))
      expect(changed._tag).toBe("ValidationError")
      expect(await meetings(connection.stub, workspaceId)).toHaveLength(1)
    } finally {
      connection.stub[Symbol.dispose]()
      connection.socket.close()
    }
  })

  it("fails closed for anonymous and cross-workspace requests and rolls back the meeting and ledger after mutation failure", async () => {
    const workspaceId = freshWorkspaceId()
    const anonymous = await connectToWorkspace(workspaceId)
    try {
      const anonymousError = await rejectionToDomainError(anonymous.startMeeting(input({ workspaceId, requestId: "meeting-anonymous" })))
      expect(anonymousError._tag).toBe("Unauthorized")
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("start-meeting:meeting-anonymous")).toBeNull()
    } finally {
      anonymous[Symbol.dispose]()
    }

    const { credential } = await devSignIn(`meeting-rollback-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const otherWorkspaceId = freshWorkspaceId()
      const crossWorkspaceError = await rejectionToDomainError(connection.stub.startMeeting(input({
        workspaceId: otherWorkspaceId, requestId: "meeting-cross-workspace"
      })))
      expect(crossWorkspaceError._tag).toBe("ValidationError")

      const malformedError = await rejectionToDomainError(connection.stub.startMeeting({
        workspaceId,
        requestId: "meeting-malformed",
        title: "A valid title",
        commitMessage: "",
        attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "macos" }
      }))
      expect(malformedError._tag).toBe("ValidationError")
      expect(await meetings(connection.stub, workspaceId)).toHaveLength(0)
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("start-meeting:meeting-malformed")).toBeNull()

      ledgerExecuteTestHook.afterMutation = () => { throw new Error("after mutation") }
      const rollbackError = await rejectionToDomainError(connection.stub.startMeeting(input({
        workspaceId, requestId: "meeting-rollback"
      })))
      expect(rollbackError._tag).toBe("UnexpectedError")
      const native = workspaceDurableObjectStub(workspaceId)
      expect(await meetings(connection.stub, workspaceId)).toHaveLength(0)
      expect((await feed(connection.stub, workspaceId)).filter((entry) => entry.entityKind === "meeting")).toHaveLength(0)
      expect(await native.debugGetLedgerCommand("start-meeting:meeting-rollback")).toBeNull()
      expect(await native.debugGetLedgerReceipt("start-meeting:meeting-rollback")).toBeNull()
      expect(await native.debugGetLedgerEvent("start-meeting:meeting-rollback")).toBeNull()
      expect(await native.debugGetLedgerOutboxIntent("start-meeting:meeting-rollback")).toBeNull()
    } finally {
      connection.stub[Symbol.dispose]()
      connection.socket.close()
    }
  })
})
