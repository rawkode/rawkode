import * as Schema from "effect/Schema"
import { afterEach, describe, expect, it } from "vitest"
import { LoroDoc, LoroList, LoroMap, LoroText, VersionVector } from "loro-crdt/bundler"
import {
  CommitLoroPageContentInput,
  CommitLoroPageContentOutput,
  CreateLoroPageInput,
  CreateLoroPageOutput,
  CreateNodeInput,
  CreateNodeOutput,
  CreationIntent,
  GetPageDocumentDescriptorInput,
  GetPageDocumentDescriptorOutput,
  HumanUiMutationAttribution,
  LoroContentConflict,
  LoroRequestIdentityConflict,
  LoroMutationIntentV1,
  ListRecentLedgerActivityOutput,
  StartLoroPageSyncInput,
  StartLoroPageSyncOutput,
  SyncFeedInput,
  SyncFeedOutput,
  ValidationError,
  sha256HexSync
} from "@athenaeum/domain"
import { connectToWorkspace, connectToWorkspaceAsTestUser, freshWorkspaceId, rejectionToDomainError, workspaceDurableObjectStub } from "./support.js"
import { commitLoroPageContentLedgerFingerprint, LedgerConflict, ledgerCustodyTestHook, ledgerExecuteTestHook } from "../src/ledger-service.js"
import { pagePersistenceTestHook } from "../src/workspace-durable-object.js"
import { loroVersionVectorIdentity } from "../src/loro-page-service-live.js"
import { WorkspaceLoroMutationGateway } from "../src/workspace-loro-mutation-gateway.js"
import versionVectorIdentityFixture from "../../../fixtures/loro-version-vector-identity.json"

const fixture = versionVectorIdentityFixture as {
  readonly format: string
  readonly encodedVersionVectorBase64: string
  readonly entries: ReadonlyArray<{ readonly peer: string; readonly counter: number }>
  readonly canonicalPreimage: string
  readonly sha256: string
}

const attribution = () => new HumanUiMutationAttribution({ version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor" })
const intent = (requestId: string) => new LoroMutationIntentV1({ requestId, commitMessage: "Commit semantic Loro content", attribution: attribution() })

const prepare = async () => {
  const workspaceId = freshWorkspaceId()
  const stub = await connectToWorkspaceAsTestUser(workspaceId)
  const node = Schema.decodeUnknownSync(CreateNodeOutput)(await stub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Ledgered Loro content" })))).node
  const created = Schema.decodeUnknownSync(CreateLoroPageOutput)(await stub.createLoroPage(Schema.encodeSync(CreateLoroPageInput)(new CreateLoroPageInput({ workspaceId, nodeId: node.id, creationIntent: new CreationIntent({ requestId: crypto.randomUUID(), commitMessage: "Create Loro page", attribution: attribution() }) }))))
  const started = Schema.decodeUnknownSync(StartLoroPageSyncOutput)(await stub.startLoroPageSync(Schema.encodeSync(StartLoroPageSyncInput)(new StartLoroPageSyncInput({ workspaceId, nodeId: node.id, sessionId: crypto.randomUUID() }))))
  const client = new LoroDoc(); client.import(started.message)
  const root = client.getMap("athenaeum-prosemirror-v1").get("children") as LoroList
  const paragraph = root.get(0) as LoroMap
  const text = (paragraph.get("children") as LoroList).get(0) as LoroText
  text.insert(text.length, " semantic")
  client.commit()
  return { workspaceId, stub, node, created, started, update: client.export({ mode: "update", from: VersionVector.decode(started.serverVersion) }) }
}

const descriptor = async (fixture: Awaited<ReturnType<typeof prepare>>) =>
  Schema.decodeUnknownSync(GetPageDocumentDescriptorOutput)(await fixture.stub.getPageDocumentDescriptor(
    Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId: fixture.workspaceId, nodeId: fixture.node.id }))
  )).descriptor

const feed = async (fixture: Awaited<ReturnType<typeof prepare>>) =>
  Schema.decodeUnknownSync(SyncFeedOutput)(await fixture.stub.syncFeed(
    Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId: fixture.workspaceId, limit: 100 }))
  )).entries.filter((entry) => entry.entityKind === "page" && entry.entityId === fixture.node.id)

const encodedCommit = (fixture: Awaited<ReturnType<typeof prepare>>, requestId = "semantic-commit") =>
  Schema.encodeSync(CommitLoroPageContentInput)(new CommitLoroPageContentInput({
    workspaceId: fixture.workspaceId,
    nodeId: fixture.node.id,
    intent: intent(requestId),
    expectedStorageVersion: fixture.created.descriptor.storageVersion,
    expectedSnapshotSha256: fixture.created.descriptor.loro!.snapshotSha256,
    expectedVersionVector: fixture.started.serverVersion,
    update: fixture.update
  }))

describe.sequential("commitLoroPageContent ledger contract", () => {
  afterEach(() => {
    ledgerExecuteTestHook.afterMutation = undefined
    ledgerCustodyTestHook.beforeInsert = undefined
    pagePersistenceTestHook.afterPrepareBeforeCommit = undefined
    pagePersistenceTestHook.afterTransactionBeforePublish = undefined
  })

  it("uses the checked-in cross-runtime semantic version-vector fixture", () => {
    const vector = VersionVector.decode(Uint8Array.from(Buffer.from(fixture.encodedVersionVectorBase64, "base64")))
    const entries = [...vector.toJSON()]
      .map(([peer, counter]) => ({ peer: String(peer), counter }))
      .sort((left, right) => BigInt(left.peer) < BigInt(right.peer) ? -1 : BigInt(left.peer) > BigInt(right.peer) ? 1 : 0)
    expect(fixture.format).toBe("athenaeum.loro-version-vector-identity.v1")
    expect(entries).toEqual(fixture.entries)
    expect(entries.map(({ peer }) => peer)).toEqual(["2", "10"])
    expect(entries.map(({ counter }) => counter)).toEqual([3, 4])
    expect(loroVersionVectorIdentity(vector)).toBe(fixture.sha256)
  })

  it("rejects anonymous, blank canonical fields, and malformed provenance before any artifact", async () => {
    const workspaceId = freshWorkspaceId(); const stub = await connectToWorkspace(workspaceId)
    try {
      const base = { workspaceId, nodeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", expectedStorageVersion: 1, expectedSnapshotSha256: "0".repeat(64), expectedVersionVector: new Uint8Array([1]), update: new Uint8Array([1]) }
      const cases = [
        { requestId: " ", commitMessage: "meaning", attribution: { version: "athenaeum.mutation-attribution.v1", kind: "system", source: "system" } },
        { requestId: "blank-message", commitMessage: " \t", attribution: { version: "athenaeum.mutation-attribution.v1", kind: "system", source: "system" } },
        { requestId: "blank-job-id", commitMessage: "meaning", attribution: { version: "athenaeum.mutation-attribution.v1", kind: "agentJob", jobId: " ", runId: "run" } },
        { requestId: "blank-run-id", commitMessage: "meaning", attribution: { version: "athenaeum.mutation-attribution.v1", kind: "agentJob", jobId: "job", runId: " \n" } },
        { requestId: "blank-source", commitMessage: "meaning", attribution: { version: "athenaeum.mutation-attribution.v1", kind: "system", source: " " } }
      ]
      for (const intent of cases) {
        const failure = await rejectionToDomainError(stub.commitLoroPageContent({ ...base, intent }))
        expect(failure).toBeInstanceOf(ValidationError)
        expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand(`commit-loro-page-content:${intent.requestId.trim()}`)).toBeNull()
      }
      const anonymous = await rejectionToDomainError(stub.commitLoroPageContent({ ...base, intent: { requestId: "anonymous", commitMessage: "meaning", attribution: { version: "athenaeum.mutation-attribution.v1", kind: "system", source: "system" } } }))
      expect(anonymous._tag).toBe("Unauthorized")
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("commit-loro-page-content:anonymous")).toBeNull()
    } finally { stub[Symbol.dispose]() }
  })

  it("commits exactly once with digest-only artifacts, canonicalizes intent, and replays exactly", async () => {
    const fixture = await prepare()
    try {
      const encoded = { ...encodedCommit(fixture), intent: { ...encodedCommit(fixture).intent, requestId: "  semantic-commit  ", commitMessage: "  Commit semantic Loro content  " } }
      const first = Schema.decodeUnknownSync(CommitLoroPageContentOutput)(await fixture.stub.commitLoroPageContent(encoded))
      const replay = Schema.decodeUnknownSync(CommitLoroPageContentOutput)(await fixture.stub.commitLoroPageContent(encoded))
      expect(replay).toEqual(first)
      expect(first.storageVersion).toBe(fixture.created.descriptor.storageVersion + 1)
      const native = workspaceDurableObjectStub(fixture.workspaceId); const identity = "commit-loro-page-content:semantic-commit"
      const command = await native.debugGetLedgerCommand(identity); const receipt = await native.debugGetLedgerReceipt(identity); const event = await native.debugGetLedgerEvent(identity); const outbox = await native.debugGetLedgerOutboxIntent(identity)
      expect(command).toMatchObject({ type: "commitLoroPageContent", requestId: "semantic-commit", payload: { nodeId: fixture.node.id, updateLength: fixture.update.length } })
      expect(await native.debugGetLedgerCustody(identity)).toMatchObject({
        requestIdentity: identity,
        fingerprint: expect.any(String),
        type: "commitLoroPageContent",
        workspaceId: fixture.workspaceId,
        actorKind: "user",
        actorLabel: "You",
        targetKind: "node",
        targetId: fixture.node.id
      })
      const activity = Schema.decodeUnknownSync(ListRecentLedgerActivityOutput)(await fixture.stub.listRecentLedgerActivity({ workspaceId: fixture.workspaceId, limit: 20 }))
      expect(activity.entries.find((entry) => entry.type === "commitLoroPageContent")).toMatchObject({
        actor: "you",
        actorDetail: { kind: "user", label: "You" },
        target: { kind: "node", id: fixture.node.id }
      })
      expect(receipt).toMatchObject({ output: { type: "commitLoroPageContent" } }); expect(event).not.toBeNull(); expect(outbox).not.toBeNull()
      expect(JSON.stringify({ command, receipt, event, outbox })).not.toMatch(/Uint8Array|"update"\s*:|"snapshot"\s*:/i)
      expect(await descriptor(fixture)).toMatchObject({ storageVersion: first.storageVersion })
      expect(await feed(fixture)).toHaveLength(2) // creation plus the one semantic command
    } finally { fixture.stub[Symbol.dispose]() }
  })

  it("returns a typed request-identity conflict without duplicate artifacts or CRDT bytes", async () => {
    const fixture = await prepare()
    try {
      const encoded = encodedCommit(fixture, "immutable-request")
      const first = Schema.decodeUnknownSync(CommitLoroPageContentOutput)(await fixture.stub.commitLoroPageContent(encoded))
      const native = workspaceDurableObjectStub(fixture.workspaceId)
      const identity = "commit-loro-page-content:immutable-request"
      const before = {
        descriptor: await descriptor(fixture),
        feed: await feed(fixture),
        command: await native.debugGetLedgerCommand(identity),
        receipt: await native.debugGetLedgerReceipt(identity),
        event: await native.debugGetLedgerEvent(identity),
        outbox: await native.debugGetLedgerOutboxIntent(identity)
      }
      for (const changed of [
        { ...encoded, intent: { ...encoded.intent, commitMessage: "different meaning" } },
        { ...encoded, intent: { ...encoded.intent, attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "agent-chat" } } },
        { ...encoded, expectedStorageVersion: encoded.expectedStorageVersion + 1 },
        { ...encoded, update: Uint8Array.from([...encoded.update].reverse()) }
      ]) {
        const failure = await rejectionToDomainError(fixture.stub.commitLoroPageContent(changed))
        expect(failure).toBeInstanceOf(LoroRequestIdentityConflict)
        expect(failure).toMatchObject({ nodeId: fixture.node.id, requestId: "immutable-request" })
        expect(JSON.stringify(failure)).not.toMatch(/Uint8Array|update|snapshot|bytes/i)
      }
      expect(await descriptor(fixture)).toEqual(before.descriptor)
      expect(await feed(fixture)).toEqual(before.feed)
      expect(await native.debugGetLedgerCommand(identity)).toEqual(before.command)
      expect(await native.debugGetLedgerReceipt(identity)).toEqual(before.receipt)
      expect(await native.debugGetLedgerEvent(identity)).toEqual(before.event)
      expect(await native.debugGetLedgerOutboxIntent(identity)).toEqual(before.outbox)
      expect(first.storageVersion).toBe(before.descriptor.storageVersion)
    } finally { fixture.stub[Symbol.dispose]() }
  })

  it("uses LoroContentConflict only for truthful authoritative-base mismatches", async () => {
    const fixture = await prepare()
    try {
      const first = Schema.decodeUnknownSync(CommitLoroPageContentOutput)(await fixture.stub.commitLoroPageContent(encodedCommit(fixture, "first-base")))
      const stale = await rejectionToDomainError(fixture.stub.commitLoroPageContent(encodedCommit(fixture, "stale-base")))
      expect(stale).toBeInstanceOf(LoroContentConflict)
      if (!(stale instanceof LoroContentConflict)) throw new Error("expected LoroContentConflict")
      expect(stale).toMatchObject({ nodeId: fixture.node.id, expectedStorageVersion: fixture.created.descriptor.storageVersion, currentStorageVersion: first.storageVersion, expectedSnapshotSha256: fixture.created.descriptor.loro!.snapshotSha256, currentSnapshotSha256: first.resultSnapshotSha256 })
      expect(stale.expectedVersionVectorSha256).toHaveLength(64)
      expect(stale.currentVersionVectorSha256).toHaveLength(64)
      expect(await descriptor(fixture)).toMatchObject({ storageVersion: first.storageVersion })

      const current = await descriptor(fixture)
      const currentSync = Schema.decodeUnknownSync(StartLoroPageSyncOutput)(await fixture.stub.startLoroPageSync(
        Schema.encodeSync(StartLoroPageSyncInput)(new StartLoroPageSyncInput({ workspaceId: fixture.workspaceId, nodeId: fixture.node.id, sessionId: crypto.randomUUID() }))
      ))
      const currentBase = { ...encodedCommit(fixture), expectedStorageVersion: current.storageVersion, expectedSnapshotSha256: current.loro!.snapshotSha256, expectedVersionVector: currentSync.serverVersion }
      for (const invalid of [
        { ...currentBase, intent: Schema.encodeSync(LoroMutationIntentV1)(intent("bad-vector")), expectedVersionVector: new Uint8Array([1]) },
        { ...currentBase, intent: Schema.encodeSync(LoroMutationIntentV1)(intent("bad-update")), update: new Uint8Array([1]) },
        { ...currentBase, intent: Schema.encodeSync(LoroMutationIntentV1)(intent("no-advance")), update: fixture.update }
      ]) {
        expect(await rejectionToDomainError(fixture.stub.commitLoroPageContent(invalid))).toBeInstanceOf(ValidationError)
      }
    } finally { fixture.stub[Symbol.dispose]() }
  })

  it("rolls back prepared writes and reloads authority rather than publishing a failed candidate", async () => {
    const fixture = await prepare()
    try {
      const identity = "commit-loro-page-content:rollback-content"
      pagePersistenceTestHook.afterPrepareBeforeCommit = () => { throw new Error("after prepared candidate") }
      expect((await rejectionToDomainError(fixture.stub.commitLoroPageContent(encodedCommit(fixture, "rollback-content"))))._tag).toBe("UnexpectedError")
      const native = workspaceDurableObjectStub(fixture.workspaceId)
      expect(await native.debugGetLedgerCommand(identity)).toBeNull()
      expect(await native.debugGetLedgerReceipt(identity)).toBeNull()
      expect(await native.debugGetLedgerEvent(identity)).toBeNull()
      expect(await native.debugGetLedgerOutboxIntent(identity)).toBeNull()
      expect(await descriptor(fixture)).toEqual(fixture.created.descriptor)
    } finally { fixture.stub[Symbol.dispose]() }
  })

  it("rolls back every artifact when custody cannot be appended", async () => {
    const fixture = await prepare()
    try {
      const identity = "commit-loro-page-content:custody-rollback"
      ledgerCustodyTestHook.beforeInsert = () => { throw new Error("custody append failpoint") }
      expect((await rejectionToDomainError(fixture.stub.commitLoroPageContent(encodedCommit(fixture, "custody-rollback"))))._tag).toBe("UnexpectedError")
      const native = workspaceDurableObjectStub(fixture.workspaceId)
      expect(await native.debugGetLedgerCommand(identity)).toBeNull()
      expect(await native.debugGetLedgerCustody(identity)).toBeNull()
      expect(await native.debugGetLedgerReceipt(identity)).toBeNull()
      expect(await native.debugGetLedgerEvent(identity)).toBeNull()
      expect(await native.debugGetLedgerOutboxIntent(identity)).toBeNull()
      expect(await descriptor(fixture)).toEqual(fixture.created.descriptor)
    } finally { fixture.stub[Symbol.dispose]() }
  })

  it("rejects a gateway command identity/custody mismatch before it can mutate or append an artifact", async () => {
    const fixture = await prepare()
    try {
      const requestIdentity = "commit-loro-page-content:gateway-custody-request"
      const commandIdentity = "commit-loro-page-content:gateway-command-mismatch"
      const command = {
        requestIdentity: commandIdentity,
        requestId: commandIdentity,
        workspaceId: fixture.workspaceId,
        principal: "gateway-test@example.com",
        policy: "ungoverned-authenticated-v1",
        nodeId: fixture.node.id,
        expectedStorageVersion: fixture.created.descriptor.storageVersion,
        expectedSnapshotSha256: fixture.created.descriptor.loro!.snapshotSha256,
        baseVersionVectorSha256: loroVersionVectorIdentity(VersionVector.decode(fixture.started.serverVersion)),
        updateSha256: sha256HexSync(fixture.update),
        updateLength: fixture.update.length,
        commitMessage: "Reject mismatched gateway custody",
        attribution: attribution()
      }
      const fingerprint = commitLoroPageContentLedgerFingerprint(command)
      const custody = {
        requestIdentity,
        fingerprint,
        type: "commitLoroPageContent" as const,
        workspaceId: fixture.workspaceId,
        actorKind: "user" as const,
        actorLabel: "You",
        targetKind: "node" as const,
        targetId: fixture.node.id
      }
      // Validation is intentionally before the gateway touches either dependency. Supplying
      // impossible dependencies proves a bad command cannot reach Loro or Ledger at all.
      const gateway = new WorkspaceLoroMutationGateway(undefined as never, undefined as never)
      expect(() => gateway.commitContentWithinTransaction({
        requestIdentity, fingerprint, command, custody,
        expectedVersionVector: fixture.started.serverVersion, update: fixture.update
      })).toThrow(LedgerConflict)
      const native = workspaceDurableObjectStub(fixture.workspaceId)
      expect(await native.debugGetLedgerCommand(requestIdentity)).toBeNull()
      expect(await native.debugGetLedgerCommand(commandIdentity)).toBeNull()
      expect(await native.debugGetLedgerCustody(requestIdentity)).toBeNull()
      expect(await native.debugGetLedgerReceipt(requestIdentity)).toBeNull()
      expect(await native.debugGetLedgerEvent(requestIdentity)).toBeNull()
      expect(await native.debugGetLedgerOutboxIntent(requestIdentity)).toBeNull()
      expect(await descriptor(fixture)).toEqual(fixture.created.descriptor)
    } finally { fixture.stub[Symbol.dispose]() }
  })

  it("replay force-reloads durable authority over a populated stale cache after a post-transaction publication interruption", async () => {
    const fixture = await prepare()
    try {
      const encoded = encodedCommit(fixture, "force-reload-replay")
      pagePersistenceTestHook.afterTransactionBeforePublish = () => { throw new Error("interrupt cache publication") }
      expect((await rejectionToDomainError(fixture.stub.commitLoroPageContent(encoded)))._tag).toBe("UnexpectedError")

      // The receipt and durable page committed, but the service cache still contains the document
      // loaded by prepare(). Replaying must replace that stale cache with current durable bytes.
      pagePersistenceTestHook.afterTransactionBeforePublish = undefined
      const replay = Schema.decodeUnknownSync(CommitLoroPageContentOutput)(await fixture.stub.commitLoroPageContent(encoded))
      expect(replay.storageVersion).toBe(fixture.created.descriptor.storageVersion + 1)
      const synced = Schema.decodeUnknownSync(StartLoroPageSyncOutput)(await fixture.stub.startLoroPageSync(
        Schema.encodeSync(StartLoroPageSyncInput)(new StartLoroPageSyncInput({ workspaceId: fixture.workspaceId, nodeId: fixture.node.id, sessionId: "force-reload-probe" }))
      ))
      const current = new LoroDoc()
      current.import(synced.message)
      const root = current.getMap("athenaeum-prosemirror-v1").get("children") as LoroList
      const paragraph = root.get(0) as LoroMap
      const text = (paragraph.get("children") as LoroList).get(0) as LoroText
      expect(text.toString()).toContain("semantic")
      expect((await descriptor(fixture)).storageVersion).toBe(replay.storageVersion)
    } finally { fixture.stub[Symbol.dispose]() }
  })
})
