import { evictDurableObject } from "cloudflare:test"
import * as Schema from "effect/Schema"
import { afterEach, describe, expect, it } from "vitest"
import {
  CreateLoroPageInput,
  CreateLoroPageOutput,
  CreateNodeInput,
  CreateNodeOutput,
  CreatePageInput,
  CreationIntent,
  type EntityId,
  GetPageDocumentDescriptorInput,
  GetPageDocumentDescriptorOutput,
  HumanUiMutationAttribution,
  LedgerCommand,
  ListRecentLedgerActivityOutput,
  LoroMutationIntentV1,
  MigrateLegacyPageInput,
  PageFormatMismatch,
  SyncFeedInput,
  SyncFeedOutput
} from "@athenaeum/domain"
import { ledgerExecuteTestHook } from "../src/ledger-service.js"
import { pagePersistenceTestHook } from "../src/workspace-durable-object.js"
import {
  connectToWorkspace,
  connectToWorkspaceWithSocketAs,
  devSignIn,
  freshWorkspaceId,
  rejectionToDomainError,
  workspaceDurableObjectStub
} from "./support.js"

const attribution = (surface: "rich-text-editor" | "web-graph-view" = "rich-text-editor") =>
  new HumanUiMutationAttribution({
    version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface
  })

const intent = (requestId: string, commitMessage = "Create the native Loro page.", surface: "rich-text-editor" | "web-graph-view" = "rich-text-editor") =>
  new CreationIntent({ requestId, commitMessage, attribution: attribution(surface) })
const migrationIntent = (requestId: string) => new LoroMutationIntentV1({
  requestId, commitMessage: "Migrate the legacy Automerge page.", attribution: attribution()
})

const encodeCreate = (workspaceId: EntityId, nodeId: EntityId, creationIntent: CreationIntent) =>
  Schema.encodeSync(CreateLoroPageInput)(new CreateLoroPageInput({
    workspaceId,
    nodeId,
    creationIntent
  }))

const createNode = async (stub: Awaited<ReturnType<typeof connectToWorkspace>>, workspaceId: EntityId, title: string) =>
  Schema.decodeUnknownSync(CreateNodeOutput)(await stub.createNode(
    Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title }))
  )).node

describe.sequential("ensureLoroPage ledger contract", () => {
  afterEach(() => {
    ledgerExecuteTestHook.afterMutation = undefined
    pagePersistenceTestHook.afterPrepareBeforeCommit = undefined
  })

  it("rejects anonymous creation before producing ledger artifacts", async () => {
    const workspaceId = freshWorkspaceId()
    const stub = await connectToWorkspace(workspaceId)
    try {
      const node = await createNode(stub, workspaceId, "Anonymous Loro")
      const failed = await rejectionToDomainError(stub.createLoroPage(encodeCreate(workspaceId, node.id, intent("anonymous-loro"))))
      expect(failed._tag).toBe("Unauthorized")
      const native = workspaceDurableObjectStub(workspaceId)
      expect(await native.debugGetLedgerCommand("ensure-loro-page:anonymous-loro")).toBeNull()
      expect(await native.debugGetLedgerReceipt("ensure-loro-page:anonymous-loro")).toBeNull()
      expect(await native.debugGetLedgerEvent("ensure-loro-page:anonymous-loro")).toBeNull()
      expect(await native.debugGetLedgerOutboxIntent("ensure-loro-page:anonymous-loro")).toBeNull()
    } finally { stub[Symbol.dispose]() }
  })

  it("canonicalizes request identity, derives authority server-side, and stores metadata-only artifacts", async () => {
    const workspaceId = freshWorkspaceId()
    const signedIn = await devSignIn(`ensure-loro-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, signedIn.credential)
    try {
      const node = await createNode(connection.stub, workspaceId, "Canonical ledger route")
      const raw = intent("  canonical-loro-request  ", "  Create a canonical native Loro page.  ")
      const first = Schema.decodeUnknownSync(CreateLoroPageOutput)(await connection.stub.createLoroPage(encodeCreate(workspaceId, node.id, raw)))
      const replay = Schema.decodeUnknownSync(CreateLoroPageOutput)(await connection.stub.createLoroPage(encodeCreate(workspaceId, node.id, intent("canonical-loro-request", "Create a canonical native Loro page."))))
      expect(replay).toEqual(first)
      const identity = "ensure-loro-page:canonical-loro-request"
      const native = workspaceDurableObjectStub(workspaceId)
      const command = Schema.decodeUnknownSync(LedgerCommand)(await native.debugGetLedgerCommand(identity))
      expect(command).toMatchObject({
        type: "ensureLoroPage", requestId: "canonical-loro-request", principal: signedIn.email,
        policy: "ungoverned-authenticated-v1", message: "Create a canonical native Loro page.",
        payload: { nodeId: node.id, outcome: "created", format: "loro-v1", attribution: { kind: "humanUi", surface: "rich-text-editor" } }
      })
      const receipt = await native.debugGetLedgerReceipt(identity)
      const event = await native.debugGetLedgerEvent(identity)
      const outbox = await native.debugGetLedgerOutboxIntent(identity)
      expect(await native.debugGetLedgerCustody(identity)).toMatchObject({
        requestIdentity: identity,
        fingerprint: expect.any(String),
        type: "ensureLoroPage",
        workspaceId,
        actorKind: "user",
        actorLabel: "You",
        targetKind: "node",
        targetId: node.id
      })
      const activity = Schema.decodeUnknownSync(ListRecentLedgerActivityOutput)(await connection.stub.listRecentLedgerActivity({ workspaceId, limit: 10 }))
      expect(activity.entries.find((entry) => entry.type === "ensureLoroPage")).toMatchObject({
        actor: "you",
        actorDetail: { kind: "user", label: "You" },
        target: { kind: "node", id: node.id }
      })
      expect(receipt).toMatchObject({ output: { type: "ensureLoroPage", output: { descriptor: { nodeId: node.id } } } })
      expect(event).toEqual({ kind: "ensure-loro-page", payload: { nodeId: node.id, format: "loro-v1" } })
      expect(outbox).toEqual({ kind: "ensure-loro-page", payload: { nodeId: node.id, format: "loro-v1" } })
      // Descriptor hashes are intentional metadata; no CRDT snapshot/update byte payload is
      // persisted in command, receipt, event, or outbox artifacts.
      expect(JSON.stringify({ command, receipt, event, outbox })).not.toMatch(/"snapshot"\s*:|Uint8Array|"update"\s*:/i)
    } finally { connection.stub[Symbol.dispose]() }
  })

  it("rejects blank ids/messages and conflicting reuse of one canonical request id", async () => {
    const workspaceId = freshWorkspaceId()
    const signedIn = await devSignIn(`ensure-loro-conflict-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, signedIn.credential)
    try {
      const first = await createNode(connection.stub, workspaceId, "First request node")
      const second = await createNode(connection.stub, workspaceId, "Second request node")
      const blank = await rejectionToDomainError(connection.stub.createLoroPage(encodeCreate(workspaceId, first.id, intent(" \t\n "))))
      expect(blank._tag).toBe("ValidationError")
      const blankMessage = await rejectionToDomainError(connection.stub.createLoroPage(
        encodeCreate(workspaceId, first.id, intent("blank-message-loro", " \n\t "))
      ))
      expect(blankMessage._tag).toBe("ValidationError")
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("ensure-loro-page:blank-message-loro")).toBeNull()
      await connection.stub.createLoroPage(encodeCreate(workspaceId, first.id, intent("reuse-loro-request")))
      for (const changed of [
        encodeCreate(workspaceId, second.id, intent("reuse-loro-request")),
        encodeCreate(workspaceId, first.id, intent("reuse-loro-request", "A different rationale.")),
        encodeCreate(workspaceId, first.id, intent("reuse-loro-request", "Create the native Loro page.", "web-graph-view"))
      ]) {
        const failure = await rejectionToDomainError(connection.stub.createLoroPage(changed))
        expect(failure._tag).toBe("ValidationError")
      }
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("ensure-loro-page:reuse-loro-request")).not.toBeNull()
    } finally { connection.stub[Symbol.dispose]() }
  })

  it("records truthful pre-ledger migrated outcome, rejects legacy without artifacts, and rolls back all failed artifacts", async () => {
    const workspaceId = freshWorkspaceId()
    const signedIn = await devSignIn(`ensure-loro-existing-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, signedIn.credential)
    try {
      const migrated = await createNode(connection.stub, workspaceId, "Migrated pre-ledger")
      await connection.stub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: migrated.id })))
      const legacy = Schema.decodeUnknownSync(GetPageDocumentDescriptorOutput)(await connection.stub.getPageDocumentDescriptor(
        Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId: migrated.id }))
      )).descriptor
      if (legacy.activeFormat !== "automerge-v1" || legacy.automerge === undefined) throw new Error("expected legacy page")
      await connection.stub.migrateLegacyPage(Schema.encodeSync(MigrateLegacyPageInput)(new MigrateLegacyPageInput({
        workspaceId, nodeId: migrated.id, expectedStorageVersion: legacy.storageVersion,
        expectedAutomerge: legacy.automerge, intent: migrationIntent("migrate-pre-ledger-migrated")
      })))
      await connection.stub.createLoroPage(encodeCreate(workspaceId, migrated.id, intent("pre-ledger-migrated")))
      const migratedCommand = Schema.decodeUnknownSync(LedgerCommand)(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("ensure-loro-page:pre-ledger-migrated"))
      expect(migratedCommand).toMatchObject({ payload: { outcome: "alreadyExisted" } })

      const legacyOnly = await createNode(connection.stub, workspaceId, "Legacy only")
      await connection.stub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: legacyOnly.id })))
      const rejected = await rejectionToDomainError(connection.stub.createLoroPage(encodeCreate(workspaceId, legacyOnly.id, intent("legacy-loro-reject"))))
      expect(rejected).toBeInstanceOf(PageFormatMismatch)
      const native = workspaceDurableObjectStub(workspaceId)
      expect(await native.debugGetLedgerCommand("ensure-loro-page:legacy-loro-reject")).toBeNull()
      expect(await native.debugGetLedgerReceipt("ensure-loro-page:legacy-loro-reject")).toBeNull()
      expect(await native.debugGetLedgerEvent("ensure-loro-page:legacy-loro-reject")).toBeNull()
      expect(await native.debugGetLedgerOutboxIntent("ensure-loro-page:legacy-loro-reject")).toBeNull()

      const rollback = await createNode(connection.stub, workspaceId, "Rollback")
      ledgerExecuteTestHook.afterMutation = () => { throw new Error("ledger failpoint") }
      const failed = await rejectionToDomainError(connection.stub.createLoroPage(encodeCreate(workspaceId, rollback.id, intent("rollback-loro"))))
      expect(failed._tag).toBe("UnexpectedError")
      expect(await native.debugGetLedgerCommand("ensure-loro-page:rollback-loro")).toBeNull()
      expect(await native.debugGetLedgerReceipt("ensure-loro-page:rollback-loro")).toBeNull()
      expect(await native.debugGetLedgerEvent("ensure-loro-page:rollback-loro")).toBeNull()
      expect(await native.debugGetLedgerOutboxIntent("ensure-loro-page:rollback-loro")).toBeNull()
      const missing = await rejectionToDomainError(connection.stub.getPageDocumentDescriptor(
        Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId: rollback.id }))
      ))
      expect(missing._tag).toBe("PageNotFound")
      const feed = Schema.decodeUnknownSync(SyncFeedOutput)(await connection.stub.syncFeed(
        Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 100 }))
      ))
      expect(feed.entries.some((entry) => entry.entityKind === "page" && entry.entityId === rollback.id)).toBe(false)
    } finally { connection.stub[Symbol.dispose]() }
  })

  it("replays from canonical durable state after cache loss without another publish", async () => {
    const workspaceId = freshWorkspaceId()
    const signedIn = await devSignIn(`ensure-loro-replay-${crypto.randomUUID()}@example.com`)
    let connection = await connectToWorkspaceWithSocketAs(workspaceId, signedIn.credential)
    try {
      const node = await createNode(connection.stub, workspaceId, "Replay after eviction")
      const creation = intent("cache-loss-loro")
      const created = Schema.decodeUnknownSync(CreateLoroPageOutput)(await connection.stub.createLoroPage(encodeCreate(workspaceId, node.id, creation)))
      connection.stub[Symbol.dispose]()
      await evictDurableObject(workspaceDurableObjectStub(workspaceId))
      connection = await connectToWorkspaceWithSocketAs(workspaceId, signedIn.credential)
      const replay = Schema.decodeUnknownSync(CreateLoroPageOutput)(await connection.stub.createLoroPage(encodeCreate(workspaceId, node.id, creation)))
      expect(replay).toEqual(created)
      const feed = Schema.decodeUnknownSync(SyncFeedOutput)(await connection.stub.syncFeed(
        Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 100 }))
      ))
      expect(feed.entries.filter((entry) => entry.entityKind === "page" && entry.entityId === node.id)).toHaveLength(1)
    } finally { connection.stub[Symbol.dispose]() }
  })
})
