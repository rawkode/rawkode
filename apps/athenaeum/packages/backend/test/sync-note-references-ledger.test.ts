import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  CreateNodeInput,
  CreateNodeOutput,
  HumanUiMutationAttribution,
  LedgerCommand,
  ListBacklinksInput,
  ListBacklinksOutput,
  SyncFeedInput,
  SyncFeedOutput,
  SyncNoteReferencesInput,
  SyncNoteReferencesLedgerCommand,
  SyncNoteReferencesOutput,
  EntityId
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

const attribution = () => new HumanUiMutationAttribution({
  version: "athenaeum.mutation-attribution.v1",
  kind: "humanUi",
  surface: "rich-text-editor"
})

const input = (args: {
  readonly workspaceId: EntityId
  readonly nodeId: EntityId
  readonly referencedNodeIds: readonly EntityId[]
  readonly requestId: string
  readonly commitMessage?: string
}) => Schema.encodeSync(SyncNoteReferencesInput)(new SyncNoteReferencesInput({
  workspaceId: args.workspaceId,
  nodeId: args.nodeId,
  referencedNodeIds: [...args.referencedNodeIds],
  requestId: args.requestId,
  commitMessage: args.commitMessage ?? "Keep note mentions current.",
  attribution: attribution()
}))

describe.sequential("syncNoteReferences ledger authority slice", () => {
  afterEach(() => {
    ledgerExecuteTestHook.afterMutation = undefined
  })

  const createNode = async (stub: Awaited<ReturnType<typeof connectToWorkspaceWithSocketAs>>["stub"], workspaceId: EntityId, title: string) =>
    Schema.decodeUnknownSync(CreateNodeOutput)(await stub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title })))).node

  it("records a canonical desired set and exact create journal, then replays permutations", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential, email } = await devSignIn(`sync-ledger-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const note = await createNode(connection.stub, workspaceId, "Daily Note")
      const firstTarget = await createNode(connection.stub, workspaceId, "First")
      const secondTarget = await createNode(connection.stub, workspaceId, "Second")
      const first = Schema.decodeUnknownSync(SyncNoteReferencesOutput)(await connection.stub.syncNoteReferences(input({
        workspaceId, nodeId: note.id, referencedNodeIds: [secondTarget.id, firstTarget.id], requestId: "sync-ledger-create"
      })))
      const feedAfterFirst = Schema.decodeUnknownSync(SyncFeedOutput)(await connection.stub.syncFeed(
        Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 100 }))
      )).entries
      const replay = Schema.decodeUnknownSync(SyncNoteReferencesOutput)(await connection.stub.syncNoteReferences(input({
        workspaceId, nodeId: note.id, referencedNodeIds: [firstTarget.id, secondTarget.id, firstTarget.id], requestId: "sync-ledger-create"
      })))
      expect(replay).toEqual(first)
      expect(replay.edges.map((edge) => edge.targetNodeId)).toEqual([firstTarget.id, secondTarget.id].sort())
      expect(Schema.decodeUnknownSync(SyncFeedOutput)(await connection.stub.syncFeed(
        Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 100 }))
      )).entries).toEqual(feedAfterFirst)
      expect((await rejectionToDomainError(connection.stub.syncNoteReferences(input({
        workspaceId, nodeId: note.id, referencedNodeIds: [firstTarget.id], requestId: "sync-ledger-create"
      }))))._tag).toBe("ValidationError")

      const native = workspaceDurableObjectStub(workspaceId)
      const command = Schema.decodeUnknownSync(LedgerCommand)(await native.debugGetLedgerCommand("sync-note-references:sync-ledger-create"))
      expect(command).toMatchObject({
        type: "syncNoteReferences",
        principal: email,
        message: "Reconciled note mentions.",
        payload: {
          nodeId: note.id,
          referencedNodeIds: [firstTarget.id, secondTarget.id].sort(),
          commitMessage: "Keep note mentions current.",
          attribution: { kind: "humanUi", surface: "rich-text-editor" }
        }
      })
      expect((command as SyncNoteReferencesLedgerCommand).payload.created).toHaveLength(2)
      expect(await native.debugGetLedgerEvent("sync-note-references:sync-ledger-create")).toMatchObject({
        kind: "sync-note-references",
        payload: { nodeId: note.id, referencedNodeIds: [firstTarget.id, secondTarget.id].sort(), removed: [] }
      })
      expect(await native.debugGetLedgerOutboxIntent("sync-note-references:sync-ledger-create")).not.toBeNull()
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("records removed tombstones, while a no-op request gets a receipt without an event", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`sync-ledger-noop-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const note = await createNode(connection.stub, workspaceId, "Daily Note")
      const keep = await createNode(connection.stub, workspaceId, "Keep")
      const drop = await createNode(connection.stub, workspaceId, "Drop")
      const created = Schema.decodeUnknownSync(SyncNoteReferencesOutput)(await connection.stub.syncNoteReferences(input({
        workspaceId, nodeId: note.id, referencedNodeIds: [keep.id, drop.id], requestId: "sync-ledger-seed"
      })))
      const noop = Schema.decodeUnknownSync(SyncNoteReferencesOutput)(await connection.stub.syncNoteReferences(input({
        workspaceId, nodeId: note.id, referencedNodeIds: [drop.id, keep.id], requestId: "sync-ledger-noop"
      })))
      expect(noop).toEqual(created)
      const native = workspaceDurableObjectStub(workspaceId)
      expect(await native.debugGetLedgerReceipt("sync-note-references:sync-ledger-noop")).toMatchObject({
        output: { version: "athenaeum.workspace-ledger-receipt.v2", type: "syncNoteReferences" }
      })
      expect(await native.debugGetLedgerEvent("sync-note-references:sync-ledger-noop")).toBeNull()
      expect(await native.debugGetLedgerOutboxIntent("sync-note-references:sync-ledger-noop")).toBeNull()

      const replaced = await connection.stub.syncNoteReferences(input({
        workspaceId, nodeId: note.id, referencedNodeIds: [keep.id], requestId: "sync-ledger-remove"
      }))
      expect(Schema.decodeUnknownSync(SyncNoteReferencesOutput)(replaced).edges.map((edge) => edge.targetNodeId)).toEqual([keep.id])
      const event = await native.debugGetLedgerEvent("sync-note-references:sync-ledger-remove")
      expect(event).toMatchObject({ kind: "sync-note-references", payload: { created: [] } })
      expect((event as { payload: { removed: Array<{ id: string; targetNodeId: string }> } }).payload.removed).toEqual([
        { id: created.edges.find((edge) => edge.targetNodeId === drop.id)!.id, relationDefinitionId: expect.any(String), sourceNodeId: note.id, targetNodeId: drop.id }
      ])
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("rejects anonymous callers and invalid targets without any ledger or graph writes", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`sync-ledger-auth-${crypto.randomUUID()}@example.com`)
    const authenticated = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    const anonymous = await connectToWorkspace(workspaceId)
    try {
      const note = await createNode(authenticated.stub, workspaceId, "Daily Note")
      const bogus = EntityId.make("00000000-0000-4000-8000-000000000099")
      expect((await rejectionToDomainError(anonymous.syncNoteReferences(input({
        workspaceId, nodeId: note.id, referencedNodeIds: [bogus], requestId: "sync-ledger-anonymous"
      }))))._tag).toBe("Unauthorized")
      expect((await rejectionToDomainError(authenticated.stub.syncNoteReferences(input({
        workspaceId, nodeId: note.id, referencedNodeIds: [bogus], requestId: "sync-ledger-invalid"
      }))))._tag).toBe("NodeNotFound")
      const native = workspaceDurableObjectStub(workspaceId)
      expect(await native.debugGetLedgerCommand("sync-note-references:sync-ledger-anonymous")).toBeNull()
      expect(await native.debugGetLedgerCommand("sync-note-references:sync-ledger-invalid")).toBeNull()
      expect(Schema.decodeUnknownSync(SyncFeedOutput)(await authenticated.stub.syncFeed(
        Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 100 }))
      )).entries.filter((entry) => entry.entityKind === "edge")).toHaveLength(0)
    } finally {
      authenticated.stub[Symbol.dispose]()
      anonymous[Symbol.dispose]()
    }
  })

  it("rolls back reconciliation, feed, journal, and ledger rows at the transaction failpoint", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`sync-ledger-rollback-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const note = await createNode(connection.stub, workspaceId, "Daily Note")
      const target = await createNode(connection.stub, workspaceId, "Target")
      await connection.stub.syncNoteReferences(input({
        workspaceId, nodeId: note.id, referencedNodeIds: [target.id], requestId: "sync-ledger-removal-seed"
      }))
      const feedBeforeRemoval = Schema.decodeUnknownSync(SyncFeedOutput)(await connection.stub.syncFeed(
        Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 100 }))
      )).entries
      ledgerExecuteTestHook.afterMutation = () => { throw new Error("syncNoteReferences ledger failpoint") }
      expect((await rejectionToDomainError(connection.stub.syncNoteReferences(input({
        workspaceId, nodeId: note.id, referencedNodeIds: [], requestId: "sync-ledger-rollback"
      }))))._tag).toBe("UnexpectedError")
      ledgerExecuteTestHook.afterMutation = undefined
      const native = workspaceDurableObjectStub(workspaceId)
      expect(await native.debugGetLedgerCommand("sync-note-references:sync-ledger-rollback")).toBeNull()
      expect(await native.debugGetLedgerReceipt("sync-note-references:sync-ledger-rollback")).toBeNull()
      expect(await native.debugGetLedgerEvent("sync-note-references:sync-ledger-rollback")).toBeNull()
      expect(await native.debugGetLedgerOutboxIntent("sync-note-references:sync-ledger-rollback")).toBeNull()
      expect(Schema.decodeUnknownSync(SyncFeedOutput)(await connection.stub.syncFeed(
        Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 100 }))
      )).entries).toEqual(feedBeforeRemoval)
      const backlinks = Schema.decodeUnknownSync(ListBacklinksOutput)(await connection.stub.listBacklinks(
        Schema.encodeSync(ListBacklinksInput)(new ListBacklinksInput({ workspaceId, nodeId: target.id }))
      )).edges
      expect(backlinks).toHaveLength(1)
    } finally {
      ledgerExecuteTestHook.afterMutation = undefined
      connection.stub[Symbol.dispose]()
    }
  })
})
