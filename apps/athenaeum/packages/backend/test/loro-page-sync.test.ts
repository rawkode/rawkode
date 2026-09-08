import { LoroDoc, LoroList, LoroMap, LoroText, VersionVector } from "loro-crdt/bundler"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { evictDurableObject } from "cloudflare:test"
import { afterEach, describe, expect, it } from "vitest"
import {
  AcceptPageProposalInput,
  ApplyPageEditInput,
  CommitLoroPageContentInput,
  CommitLoroPageContentOutput,
  CreateLoroPageInput,
  CreateWorkspaceInput,
  CreateWorkspaceOutput,
  CreationIntent,
  HumanUiMutationAttribution,
  CreateLoroPageOutput,
  CreateNodeInput,
  CreateNodeOutput,
  CreatePageInput,
  GetPageDocumentDescriptorInput,
  GetPageDocumentDescriptorOutput,
  GetLegacyPageProjectionInput,
  GetLegacyPageProjectionOutput,
  GetPageTextInput,
  LoroSemanticCommitRequired,
  LoroPageSyncMessageInput,
  LoroPageSyncMessageOutput,
  LoroMutationIntentV1,
  MigrateLegacyPageInput,
  MigrateLegacyPageOutput,
  PageFormatMismatch,
  PageProposalProvenance,
  ProposePageEditInput,
  ProposePageEditOutput,
  ValidationError,
  StartLoroPageSyncInput,
  StartLoroPageSyncOutput,
  SyncFeedInput,
  SyncFeedOutput
} from "@athenaeum/domain"
import { connectToUserAs, connectToWorkspace, connectToWorkspaceAsTestUser, devSignIn, freshWorkspaceId, rejectionToDomainError, workspaceDurableObjectStub } from "./support.js"
import { pagePersistenceTestHook } from "../src/workspace-durable-object.js"
import { ledgerExecuteTestHook } from "../src/ledger-service.js"
import { legacyPageProjectionTestHook } from "../src/loro-page-service-live.js"
import { decodePageDocumentFormatRow } from "../src/pages-repository-live.js"

const META = "athenaeum-page-meta-v1"
const PM_ROOT = "athenaeum-prosemirror-v1"
const creationIntent = () => new CreationIntent({
  requestId: crypto.randomUUID(), commitMessage: "Create native Loro page",
  attribution: new HumanUiMutationAttribution({ version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor" })
})
const migrationIntent = (commitMessage = "Migrate legacy Automerge page") => new LoroMutationIntentV1({
  requestId: crypto.randomUUID(), commitMessage,
  attribution: new HumanUiMutationAttribution({ version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor" })
})

const encodeLegacyMigration = (
  workspaceId: string,
  nodeId: string,
  legacy: GetPageDocumentDescriptorOutput["descriptor"],
  intent: LoroMutationIntentV1
) => {
  if (legacy.activeFormat !== "automerge-v1" || legacy.automerge === undefined) throw new Error("expected legacy Automerge descriptor")
  return Schema.encodeSync(MigrateLegacyPageInput)(new MigrateLegacyPageInput({
    workspaceId, nodeId, expectedStorageVersion: legacy.storageVersion, expectedAutomerge: legacy.automerge, intent
  }))
}

const readLegacyDescriptor = async (
  stub: Awaited<ReturnType<typeof connectToWorkspace>>,
  workspaceId: string,
  nodeId: string
) => Schema.decodeUnknownSync(GetPageDocumentDescriptorOutput)(await stub.getPageDocumentDescriptor(
  Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId }))
)).descriptor

const migrateLegacy = async (
  stub: Awaited<ReturnType<typeof connectToWorkspace>>,
  workspaceId: string,
  nodeId: string,
  intent = migrationIntent()
) => {
  const legacy = await readLegacyDescriptor(stub, workspaceId, nodeId)
  const migrated = Schema.decodeUnknownSync(MigrateLegacyPageOutput)(await stub.migrateLegacyPage(
    encodeLegacyMigration(workspaceId, nodeId, legacy, intent)
  ))
  return { legacy, migrated, intent }
}

const createNativeLoroPageWithText = async (
  stub: Awaited<ReturnType<typeof connectToWorkspace>>,
  workspaceId: string,
  nodeId: string,
  text: string
) => {
  const created = Schema.decodeUnknownSync(CreateLoroPageOutput)(await stub.createLoroPage(
    Schema.encodeSync(CreateLoroPageInput)(new CreateLoroPageInput({ workspaceId, nodeId, creationIntent: creationIntent() }))
  ))
  if (text.length === 0) return created
  if (created.descriptor.activeFormat !== "loro-v1" || created.descriptor.loro === undefined) throw new Error("expected native Loro descriptor")
  const started = Schema.decodeUnknownSync(StartLoroPageSyncOutput)(await stub.startLoroPageSync(
    Schema.encodeSync(StartLoroPageSyncInput)(new StartLoroPageSyncInput({ workspaceId, nodeId, sessionId: crypto.randomUUID() }))
  ))
  const client = new LoroDoc()
  client.import(started.message)
  const rootChildren = client.getMap(PM_ROOT).get("children")
  if (!(rootChildren instanceof LoroList)) throw new Error("missing Loro root children")
  const paragraph = rootChildren.get(0)
  if (!(paragraph instanceof LoroMap)) throw new Error("missing Loro paragraph")
  const paragraphChildren = paragraph.get("children")
  if (!(paragraphChildren instanceof LoroList)) throw new Error("missing Loro paragraph children")
  const leaf = paragraphChildren.get(0)
  if (!(leaf instanceof LoroText)) throw new Error("missing Loro text leaf")
  leaf.insert(0, text)
  client.commit()
  return Schema.decodeUnknownSync(CommitLoroPageContentOutput)(await stub.commitLoroPageContent(
    Schema.encodeSync(CommitLoroPageContentInput)(new CommitLoroPageContentInput({
      workspaceId,
      nodeId,
      intent: migrationIntent("Seed native Loro content"),
      expectedStorageVersion: created.descriptor.storageVersion,
      expectedSnapshotSha256: created.descriptor.loro.snapshotSha256,
      expectedVersionVector: started.serverVersion,
      update: client.export({ mode: "update", from: VersionVector.decode(started.serverVersion) })
    }))
  ))
}

const makeInvalidPageSnapshot = (): Uint8Array => {
  const doc = new LoroDoc()
  doc.getMap(META).set("schemaVersion", 1)
  const root = doc.getMap(PM_ROOT)
  root.set("nodeName", "doc")
  root.getOrCreateContainer("children", new LoroList())
  doc.commit()
  return doc.export({ mode: "snapshot" })
}

const rawContentUpdate = (started: StartLoroPageSyncOutput): { readonly update: Uint8Array; readonly clientVersion: Uint8Array } => {
  const client = new LoroDoc()
  client.import(started.message)
  const children = client.getMap(PM_ROOT).get("children")
  if (!(children instanceof LoroList)) throw new Error("missing root children")
  const paragraph = children.get(0)
  if (!(paragraph instanceof LoroMap)) throw new Error("missing paragraph")
  const text = (paragraph.get("children") as LoroList).get(0)
  if (!(text instanceof LoroText)) throw new Error("missing paragraph text")
  text.insert(text.length, " raw content")
  client.commit()
  return {
    update: client.export({ mode: "update", from: VersionVector.decode(started.serverVersion) }),
    clientVersion: client.version().encode()
  }
}

const textFromPageSnapshot = (snapshot: Uint8Array): string => {
  const doc = new LoroDoc()
  doc.import(snapshot)
  const root = doc.getMap(PM_ROOT)
  const rootChildren = root.get("children")
  if (!(rootChildren instanceof LoroList)) throw new Error("missing root children")
  const paragraph = rootChildren.get(0)
  if (!(paragraph instanceof LoroMap)) throw new Error("missing paragraph")
  const paragraphChildren = paragraph.get("children")
  if (!(paragraphChildren instanceof LoroList)) throw new Error("missing paragraph children")
  const loroText = paragraphChildren.get(0)
  if (!(loroText instanceof LoroText)) throw new Error("missing paragraph text")
  return loroText.toString()
}

describe("Loro page documents", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined

  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
    ledgerExecuteTestHook.afterMutation = undefined
    legacyPageProjectionTestHook.onRead = undefined
  })

  it("serves text and witness through one authoritative legacy projection read and rejects migrated pages", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Legacy projection" }))
      )
    ).node
    await workspaceStub.createPage(
      Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id }))
    )
    await workspaceStub.applyPageEdit(
      Schema.encodeSync(ApplyPageEditInput)(
        new ApplyPageEditInput({ workspaceId, nodeId: node.id, index: 0, deleteCount: 0, insertText: "authoritative" })
      )
    )

    let projectionReads = 0
    legacyPageProjectionTestHook.onRead = () => { projectionReads += 1 }

    const projection = Schema.decodeUnknownSync(GetLegacyPageProjectionOutput)(
      await workspaceStub.getLegacyPageProjection(
        Schema.encodeSync(GetLegacyPageProjectionInput)(new GetLegacyPageProjectionInput({ workspaceId, nodeId: node.id }))
      )
    )
    expect(projection).toMatchObject({
      content: { kind: "plainText", text: "authoritative" }, readOnly: true, migrationRequired: true,
      descriptor: { nodeId: node.id, activeFormat: "automerge-v1", automerge: { docId: expect.any(String), headsHash: expect.any(String), bytesSha256: expect.any(String) } }
    })
    expect(projectionReads).toBe(1)

    const migrated = await migrateLegacy(workspaceStub, workspaceId, node.id)
    expect(migrated.migrated.descriptor).toMatchObject({ activeFormat: "loro-v1", storageVersion: 2 })
    expect(migrated.migrated).toMatchObject({ descriptor: { activeFormat: "loro-v1" } })
    const error = await rejectionToDomainError(workspaceStub.getLegacyPageProjection(
      Schema.encodeSync(GetLegacyPageProjectionInput)(new GetLegacyPageProjectionInput({ workspaceId, nodeId: node.id }))
    ))
    expect(error).toBeInstanceOf(PageFormatMismatch)
    expect(error).toMatchObject({ expected: "automerge-v1", actual: "loro-v1" })
  })

  it("migrates a page without overwriting its Automerge source and converges concurrent Loro edits", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Loro note" }))
      )
    ).node

    await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id })))
    await workspaceStub.applyPageEdit(Schema.encodeSync(ApplyPageEditInput)(new ApplyPageEditInput({
      workspaceId, nodeId: node.id, index: 0, deleteCount: 0, insertText: "Hello"
    })))
    const legacy = Schema.decodeUnknownSync(GetPageDocumentDescriptorOutput)(
      await workspaceStub.getPageDocumentDescriptor(
        Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId: node.id }))
      )
    ).descriptor
    expect(legacy.activeFormat).toBe("automerge-v1")

    const intent = migrationIntent()
    const activated = Schema.decodeUnknownSync(MigrateLegacyPageOutput)(await workspaceStub.migrateLegacyPage(
      encodeLegacyMigration(workspaceId, node.id, legacy, intent)
    ))
    const loroDescriptor = Schema.decodeUnknownSync(GetPageDocumentDescriptorOutput)(
      await workspaceStub.getPageDocumentDescriptor(
        Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId: node.id }))
      )
    ).descriptor
    expect(activated).toMatchObject({ descriptor: { activeFormat: "loro-v1" } })
    expect(loroDescriptor.activeFormat).toBe("loro-v1")
    expect(loroDescriptor.storageVersion).toBe(2)
    expect(loroDescriptor.automerge).toEqual(legacy.automerge)
    expect(loroDescriptor.loro?.schemaVersion).toBe(1)

    const identity = `migrate-legacy-page:${intent.requestId}`
    const native = workspaceDurableObjectStub(workspaceId)
    const activationArtifacts = {
      command: await native.debugGetLedgerCommand(identity),
      receipt: await native.debugGetLedgerReceipt(identity),
      event: await native.debugGetLedgerEvent(identity),
      outbox: await native.debugGetLedgerOutboxIntent(identity)
    }
    expect(activationArtifacts.command).toMatchObject({
      type: "migrateLegacyPage", requestId: intent.requestId,
      payload: {
        nodeId: node.id, sourceStorageVersion: legacy.storageVersion,
        sourceAutomerge: legacy.automerge,
        migrationEngineVersion: "automerge-flat-text-to-loro-v1",
        resultSnapshotSha256: loroDescriptor.loro?.snapshotSha256,
        storageVersion: loroDescriptor.storageVersion
      }
    })
    expect(activationArtifacts.receipt).toMatchObject({ output: { type: "migrateLegacyPage" } })
    expect(activationArtifacts.event).not.toBeNull()
    expect(activationArtifacts.outbox).not.toBeNull()
    expect(JSON.stringify(activationArtifacts)).not.toMatch(/Uint8Array|"snapshot"\s*:/i)

    const replay = await workspaceStub.migrateLegacyPage(encodeLegacyMigration(workspaceId, node.id, legacy, intent))
    expect(replay).toEqual(activated)
    expect({
      command: await native.debugGetLedgerCommand(identity), receipt: await native.debugGetLedgerReceipt(identity),
      event: await native.debugGetLedgerEvent(identity), outbox: await native.debugGetLedgerOutboxIntent(identity)
    }).toEqual(activationArtifacts)

    const conflictIntent = new LoroMutationIntentV1({
      requestId: intent.requestId, commitMessage: "A different migration rationale",
      attribution: intent.attribution
    })
    const conflict = await rejectionToDomainError(workspaceStub.migrateLegacyPage(
      encodeLegacyMigration(workspaceId, node.id, legacy, conflictIntent)
    ))
    expect(conflict).toBeInstanceOf(ValidationError)
    expect(conflict.message).toMatch(/request identity|different/i)
    expect(await native.debugGetLedgerCommand(identity)).toEqual(activationArtifacts.command)

    const legacyError = await rejectionToDomainError(
      workspaceStub.getPageText(
        Schema.encodeSync(GetPageTextInput)(new GetPageTextInput({ workspaceId, nodeId: node.id }))
      )
    )
    expect(legacyError).toBeInstanceOf(PageFormatMismatch)
    expect(legacyError).toMatchObject({ expected: "automerge-v1", actual: "loro-v1" })

    const startA = Schema.decodeUnknownSync(StartLoroPageSyncOutput)(
      await workspaceStub.startLoroPageSync(
        Schema.encodeSync(StartLoroPageSyncInput)(new StartLoroPageSyncInput({ workspaceId, nodeId: node.id, sessionId: "a" }))
      )
    )
    const startB = Schema.decodeUnknownSync(StartLoroPageSyncOutput)(
      await workspaceStub.startLoroPageSync(
        Schema.encodeSync(StartLoroPageSyncInput)(new StartLoroPageSyncInput({ workspaceId, nodeId: node.id, sessionId: "b" }))
      )
    )
    const clientA = new LoroDoc()
    clientA.import(startA.message)
    const clientB = new LoroDoc()
    clientB.import(startB.message)
    const knownA = VersionVector.decode(startA.serverVersion)
    const knownB = VersionVector.decode(startB.serverVersion)
    const textA = clientA.getMap(PM_ROOT).get("children") as LoroList
    const paragraphA = textA.get(0) as LoroMap
    const bodyA = paragraphA.get("children") as LoroList
    const loroTextA = bodyA.get(0) as LoroText
    loroTextA.insert(loroTextA.length, " A")
    clientA.commit()
    const updateA = await rejectionToDomainError(
      workspaceStub.loroPageSyncMessage(
        Schema.encodeSync(LoroPageSyncMessageInput)(
          new LoroPageSyncMessageInput({
            workspaceId,
            nodeId: node.id,
            sessionId: "a",
            ordinal: 0,
            update: clientA.export({ mode: "update", from: knownA }),
            clientVersion: clientA.version().encode()
          })
        )
      )
    )
    expect(updateA).toBeInstanceOf(LoroSemanticCommitRequired)

    const textB = clientB.getMap(PM_ROOT).get("children") as LoroList
    const paragraphB = textB.get(0) as LoroMap
    const bodyB = paragraphB.get("children") as LoroList
    const loroTextB = bodyB.get(0) as LoroText
    loroTextB.insert(loroTextB.length, " B")
    clientB.commit()
    const updateB = await rejectionToDomainError(
      workspaceStub.loroPageSyncMessage(
        Schema.encodeSync(LoroPageSyncMessageInput)(
          new LoroPageSyncMessageInput({
            workspaceId,
            nodeId: node.id,
            sessionId: "b",
            ordinal: 0,
            update: clientB.export({ mode: "update", from: knownB }),
            clientVersion: clientB.version().encode()
          })
        )
      )
    )
    expect(updateB).toBeInstanceOf(LoroSemanticCommitRequired)

    workspaceStub[Symbol.dispose]()
    workspaceStub = undefined
    await evictDurableObject(workspaceDurableObjectStub(workspaceId))
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const reloaded = Schema.decodeUnknownSync(StartLoroPageSyncOutput)(
      await workspaceStub.startLoroPageSync(
        Schema.encodeSync(StartLoroPageSyncInput)(new StartLoroPageSyncInput({ workspaceId, nodeId: node.id, sessionId: "reload" }))
      )
    )
    expect(textFromPageSnapshot(reloaded.message)).toContain("Hello")
    const refreshedDescriptor = Schema.decodeUnknownSync(GetPageDocumentDescriptorOutput)(
      await workspaceStub.getPageDocumentDescriptor(
        Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId: node.id }))
      )
    ).descriptor
    expect(refreshedDescriptor.loro?.schemaVersion).toBe(1)
    expect(refreshedDescriptor.loro?.snapshotSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(refreshedDescriptor.loro?.snapshotSha256).toBe(loroDescriptor.loro?.snapshotSha256)
    expect(refreshedDescriptor.storageVersion).toBe(loroDescriptor.storageVersion)
  })

  it("rejects legacy migration when accepted Automerge proposal history remains replay-addressable", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Accepted Automerge proposal" }))
      )
    ).node
    await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id })))
    const proposed = Schema.decodeUnknownSync(ProposePageEditOutput)(
      await workspaceStub.proposePageEdit(
        Schema.encodeSync(ProposePageEditInput)(
          new ProposePageEditInput({
            workspaceId,
            nodeId: node.id,
            index: 0,
            deleteCount: 0,
            insertText: "preserved",
            rationale: "Exercise the accepted proposal activation guard.",
            provenance: new PageProposalProvenance({
              chatId: "loro-activation-guard",
              assistantMessageId: "loro-activation-guard-message",
              toolCallId: "loro-activation-guard-tool",
              toolName: "editNote",
              source: "agent"
            })
          })
        )
      )
    )
    await workspaceStub.acceptPageProposal(
      Schema.encodeSync(AcceptPageProposalInput)(
        new AcceptPageProposalInput({ workspaceId, proposalId: proposed.proposal.proposalId })
      )
    )
    const legacy = await readLegacyDescriptor(workspaceStub, workspaceId, node.id)
    const error = await rejectionToDomainError(workspaceStub.migrateLegacyPage(
      encodeLegacyMigration(workspaceId, node.id, legacy, migrationIntent("Migrate despite accepted proposal"))
    ))
    expect(error).toBeInstanceOf(ValidationError)
    expect(error).toMatchObject({ message: expect.stringContaining("non-reverted Automerge proposal history") })
  })

  it("rejects migration when the Automerge source changed after the client read it", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Stale activation" }))
      )
    ).node
    await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id })))
    const legacy = Schema.decodeUnknownSync(GetPageDocumentDescriptorOutput)(
      await workspaceStub.getPageDocumentDescriptor(
        Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId: node.id }))
      )
    ).descriptor

    await workspaceStub.applyPageEdit(
      Schema.encodeSync(ApplyPageEditInput)(
        new ApplyPageEditInput({ workspaceId, nodeId: node.id, index: 0, deleteCount: 0, insertText: "newer" })
      )
    )

    const error = await rejectionToDomainError(workspaceStub.migrateLegacyPage(
      encodeLegacyMigration(workspaceId, node.id, legacy, migrationIntent("Migrate stale legacy page"))
    ))
    expect(error).toBeInstanceOf(ValidationError)
  })

  it("hard-disables the historical caller-supplied activation route", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Disabled activation" }))
      )
    ).node
    await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id })))
    const before = await readLegacyDescriptor(workspaceStub, workspaceId, node.id)
    const error = await rejectionToDomainError(workspaceStub.activateLoroPage({
      workspaceId, nodeId: node.id, loroSnapshot: new Uint8Array([1, 2, 3])
    }))
    expect(error).toBeInstanceOf(ValidationError)
    expect(error.message).toMatch(/disabled/i)
    expect(await readLegacyDescriptor(workspaceStub, workspaceId, node.id)).toEqual(before)
  })

  it("accepts a valid native Loro page with the shared ProseMirror contract", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Rich Loro page" }))
      )
    ).node
    const created = await createNativeLoroPageWithText(workspaceStub, workspaceId, node.id, "native rich-text root")
    expect(created).toMatchObject({ descriptor: { activeFormat: "loro-v1", loro: { schemaVersion: 1 } } })
  })

  it("rejects a sync update with an out-of-range heading attribute before publication", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Invalid Loro attribute" }))
      )
    ).node
    await createNativeLoroPageWithText(workspaceStub, workspaceId, node.id, "durable")
    const before = Schema.decodeUnknownSync(GetPageDocumentDescriptorOutput)(
      await workspaceStub.getPageDocumentDescriptor(
        Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId: node.id }))
      )
    ).descriptor
    const started = Schema.decodeUnknownSync(StartLoroPageSyncOutput)(
      await workspaceStub.startLoroPageSync(
        Schema.encodeSync(StartLoroPageSyncInput)(new StartLoroPageSyncInput({ workspaceId, nodeId: node.id, sessionId: "invalid-attribute" }))
      )
    )
    const client = new LoroDoc()
    client.import(started.message)
    const children = client.getMap(PM_ROOT).get("children")
    if (!(children instanceof LoroList)) throw new Error("missing root children")
    const paragraph = children.get(0)
    if (!(paragraph instanceof LoroMap)) throw new Error("missing paragraph")
    paragraph.set("nodeName", "heading")
    const attributes = paragraph.get("attributes")
    if (!(attributes instanceof LoroMap)) throw new Error("missing paragraph attributes")
    attributes.set("level", 4)
    client.commit()

    const error = await rejectionToDomainError(
      workspaceStub.loroPageSyncMessage(
        Schema.encodeSync(LoroPageSyncMessageInput)(
          new LoroPageSyncMessageInput({
            workspaceId,
            nodeId: node.id,
            sessionId: "invalid-attribute",
            ordinal: 0,
            update: client.export({ mode: "update", from: VersionVector.decode(started.serverVersion) }),
            clientVersion: client.version().encode()
          })
        )
      )
    )
    expect(error).toBeInstanceOf(LoroSemanticCommitRequired)
    const after = Schema.decodeUnknownSync(GetPageDocumentDescriptorOutput)(
      await workspaceStub.getPageDocumentDescriptor(
        Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId: node.id }))
      )
    ).descriptor
    expect(after.loro).toEqual(before.loro)
  })

  it("rejects a contract-breaking sync update without publishing it and reloads the last valid snapshot", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Invalid sync update" }))
      )
    ).node
    await createNativeLoroPageWithText(workspaceStub, workspaceId, node.id, "durable")
    const before = Schema.decodeUnknownSync(GetPageDocumentDescriptorOutput)(
      await workspaceStub.getPageDocumentDescriptor(
        Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId: node.id }))
      )
    ).descriptor
    const started = Schema.decodeUnknownSync(StartLoroPageSyncOutput)(
      await workspaceStub.startLoroPageSync(
        Schema.encodeSync(StartLoroPageSyncInput)(new StartLoroPageSyncInput({ workspaceId, nodeId: node.id, sessionId: "invalid" }))
      )
    )
    const client = new LoroDoc()
    client.import(started.message)
    client.getMap(META).set("schemaVersion", 2)
    client.commit()

    const error = await rejectionToDomainError(
      workspaceStub.loroPageSyncMessage(
        Schema.encodeSync(LoroPageSyncMessageInput)(
          new LoroPageSyncMessageInput({
            workspaceId,
            nodeId: node.id,
            sessionId: "invalid",
            ordinal: 0,
            update: client.export({ mode: "update", from: VersionVector.decode(started.serverVersion) }),
            clientVersion: client.version().encode()
          })
        )
      )
    )
    expect(error).toBeInstanceOf(LoroSemanticCommitRequired)
    const after = Schema.decodeUnknownSync(GetPageDocumentDescriptorOutput)(
      await workspaceStub.getPageDocumentDescriptor(
        Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId: node.id }))
      )
    ).descriptor
    expect(after.loro).toEqual(before.loro)

    workspaceStub[Symbol.dispose]()
    workspaceStub = undefined
    await evictDurableObject(workspaceDurableObjectStub(workspaceId))
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const reloaded = Schema.decodeUnknownSync(StartLoroPageSyncOutput)(
      await workspaceStub.startLoroPageSync(
        Schema.encodeSync(StartLoroPageSyncInput)(new StartLoroPageSyncInput({ workspaceId, nodeId: node.id, sessionId: "reloaded-valid" }))
      )
    )
    expect(textFromPageSnapshot(reloaded.message)).toBe("durable")
  })

  it("rejects a contract-invalid durable Loro snapshot on reload even when its descriptor hash matches", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Invalid durable Loro" }))
      )
    ).node
    await createNativeLoroPageWithText(workspaceStub, workspaceId, node.id, "valid first")

    await workspaceDurableObjectStub(workspaceId).debugReplaceLoroPageSnapshot(node.id, makeInvalidPageSnapshot())
    workspaceStub[Symbol.dispose]()
    workspaceStub = undefined
    await evictDurableObject(workspaceDurableObjectStub(workspaceId))
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const error = await rejectionToDomainError(
      workspaceStub.startLoroPageSync(
        Schema.encodeSync(StartLoroPageSyncInput)(new StartLoroPageSyncInput({ workspaceId, nodeId: node.id, sessionId: "invalid-reload" }))
      )
    )
    expect(error).toBeInstanceOf(ValidationError)
  })

  it("rejects a migrated page when its retained Automerge witness drifts", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Migrated witness" }))
      )
    ).node
    await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id })))
    await migrateLegacy(workspaceStub, workspaceId, node.id)
    const migrated = Schema.decodeUnknownSync(GetPageDocumentDescriptorOutput)(
      await workspaceStub.getPageDocumentDescriptor(
        Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId: node.id }))
      )
    ).descriptor
    if (migrated.activeFormat !== "loro-v1" || migrated.automerge === undefined || migrated.loro === undefined) {
      throw new Error("expected a migrated Loro descriptor")
    }

    await workspaceDurableObjectStub(workspaceId).debugReplacePageDocumentFormat(node.id, {
      activeFormat: "loro-v1",
      storageVersion: migrated.storageVersion,
      automerge: {
        docId: migrated.automerge.docId,
        headsHash: migrated.automerge.headsHash,
        bytesSha256: "tampered-witness"
      },
      loro: {
        schemaVersion: migrated.loro.schemaVersion,
        snapshotSha256: migrated.loro.snapshotSha256
      }
    })
    const error = await rejectionToDomainError(
      workspaceStub.getPageDocumentDescriptor(
        Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId: node.id }))
      )
    )
    expect(error._tag).toBe("UnexpectedError")
    expect(error.message).toContain("inconsistent Automerge witness")
  })
})

describe("Loro page format storage boundary", () => {
  it("rejects malformed mixed-format rows before service routing", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        decodePageDocumentFormatRow({
          nodeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          activeFormat: "loro-v1",
          storageVersion: 1,
          automerge: { docId: "only-one-field" },
          loro: { schemaVersion: 1, snapshotSha256: "snapshot" }
        })
      )
    )
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("native Loro page creation", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined

  afterEach(() => {
    pagePersistenceTestHook.afterPrepareBeforeCommit = undefined
    ledgerExecuteTestHook.afterMutation = undefined
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("creates a valid native Loro page without Automerge metadata and replays idempotently", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Native Loro" }))
      )
    ).node

    const intent = creationIntent()
    const created = Schema.decodeUnknownSync(CreateLoroPageOutput)(
      await workspaceStub.createLoroPage(
        Schema.encodeSync(CreateLoroPageInput)(new CreateLoroPageInput({ workspaceId, nodeId: node.id, creationIntent: intent }))
      )
    )
    expect(created.descriptor.activeFormat).toBe("loro-v1")
    expect(created.descriptor).not.toHaveProperty("automerge")
    expect(created.descriptor.loro?.schemaVersion).toBe(1)

    const started = Schema.decodeUnknownSync(StartLoroPageSyncOutput)(
      await workspaceStub.startLoroPageSync(
        Schema.encodeSync(StartLoroPageSyncInput)(new StartLoroPageSyncInput({ workspaceId, nodeId: node.id, sessionId: "native-genesis" }))
      )
    )
    expect(textFromPageSnapshot(started.message)).toBe("")

    const feedBefore = Schema.decodeUnknownSync(SyncFeedOutput)(
      await workspaceStub.syncFeed(Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 100 })))
    )
    const pageEntriesBefore = feedBefore.entries.filter((entry) => entry.entityKind === "page" && entry.entityId === node.id)
    expect(pageEntriesBefore).toHaveLength(1)

    const replay = Schema.decodeUnknownSync(CreateLoroPageOutput)(
      await workspaceStub.createLoroPage(
        Schema.encodeSync(CreateLoroPageInput)(new CreateLoroPageInput({ workspaceId, nodeId: node.id, creationIntent: intent }))
      )
    )
    expect(replay.descriptor).toEqual(created.descriptor)

    const feedAfter = Schema.decodeUnknownSync(SyncFeedOutput)(
      await workspaceStub.syncFeed(Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 100 })))
    )
    expect(feedAfter.entries.filter((entry) => entry.entityKind === "page" && entry.entityId === node.id)).toHaveLength(1)

    const staleCreate = await rejectionToDomainError(
      workspaceStub.createPage(
        Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id }))
      )
    )
    expect(staleCreate).toBeInstanceOf(PageFormatMismatch)
    expect(staleCreate).toMatchObject({ expected: "automerge-v1", actual: "loro-v1" })

    const descriptorAfterReject = Schema.decodeUnknownSync(GetPageDocumentDescriptorOutput)(
      await workspaceStub.getPageDocumentDescriptor(
        Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId: node.id }))
      )
    ).descriptor
    expect(descriptorAfterReject).toEqual(created.descriptor)
  })

  it("rolls back all native Loro creation rows before publishing cache or feed state", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Native rollback" }))
      )
    ).node

    pagePersistenceTestHook.afterPrepareBeforeCommit = () => {
      throw new Error("native Loro create failpoint")
    }
    const retryIntent = creationIntent()
    const failed = await rejectionToDomainError(
      workspaceStub.createLoroPage(
        Schema.encodeSync(CreateLoroPageInput)(new CreateLoroPageInput({ workspaceId, nodeId: node.id, creationIntent: retryIntent }))
      )
    )
    expect(failed._tag).toBe("UnexpectedError")

    const missing = await rejectionToDomainError(
      workspaceStub.getPageDocumentDescriptor(
        Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId: node.id }))
      )
    )
    expect(missing._tag).toBe("PageNotFound")

    const feed = Schema.decodeUnknownSync(SyncFeedOutput)(
      await workspaceStub.syncFeed(Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 100 })))
    )
    expect(feed.entries.some((entry) => entry.entityKind === "page" && entry.entityId === node.id)).toBe(false)

    pagePersistenceTestHook.afterPrepareBeforeCommit = undefined
    const retried = Schema.decodeUnknownSync(CreateLoroPageOutput)(
      await workspaceStub.createLoroPage(
        Schema.encodeSync(CreateLoroPageInput)(new CreateLoroPageInput({ workspaceId, nodeId: node.id, creationIntent: retryIntent }))
      )
    )
    expect(retried.descriptor.activeFormat).toBe("loro-v1")
  })
})

describe("Loro page persistence publication boundaries", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined

  afterEach(() => {
    pagePersistenceTestHook.afterPrepareBeforeCommit = undefined
    ledgerExecuteTestHook.afterMutation = undefined
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("rejects a public raw candidate before the Loro transaction and leaves its session retryable", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Loro rollback" }))
      )
    ).node
    await createNativeLoroPageWithText(workspaceStub, workspaceId, node.id, "before rollback")

    const sessionId = "loro-publication-rollback"
    const started = Schema.decodeUnknownSync(StartLoroPageSyncOutput)(
      await workspaceStub.startLoroPageSync(
        Schema.encodeSync(StartLoroPageSyncInput)(new StartLoroPageSyncInput({ workspaceId, nodeId: node.id, sessionId }))
      )
    )
    const local = new LoroDoc()
    local.import(started.message)
    const root = local.getMap(PM_ROOT)
    const children = root.get("children")
    if (!(children instanceof LoroList)) throw new Error("missing Loro root children")
    const paragraph = children.get(0)
    if (!(paragraph instanceof LoroMap)) throw new Error("missing Loro paragraph")
    const paragraphChildren = paragraph.get("children")
    if (!(paragraphChildren instanceof LoroList)) throw new Error("missing Loro paragraph children")
    const text = paragraphChildren.get(0)
    if (!(text instanceof LoroText)) throw new Error("missing Loro paragraph text")
    text.insert(text.length, " + changed")
    local.commit()
    const update = local.export({ mode: "update", from: VersionVector.decode(started.serverVersion) })
    expect(update.byteLength).toBeGreaterThan(0)

    const failed = await rejectionToDomainError(
      workspaceStub.loroPageSyncMessage(
        Schema.encodeSync(LoroPageSyncMessageInput)(
          new LoroPageSyncMessageInput({
            workspaceId,
            nodeId: node.id,
            sessionId,
            ordinal: 0,
            update,
            clientVersion: local.version().encode()
          })
        )
      )
    )
    expect(failed).toBeInstanceOf(LoroSemanticCommitRequired)

    // A fresh session reads through the service cache. It must still see the committed snapshot,
    // not the candidate that was prepared inside the rolled-back transaction.
    const beforeRetry = Schema.decodeUnknownSync(StartLoroPageSyncOutput)(
      await workspaceStub.startLoroPageSync(
        Schema.encodeSync(StartLoroPageSyncInput)(new StartLoroPageSyncInput({ workspaceId, nodeId: node.id, sessionId: "loro-cache-probe" }))
      )
    )
    expect(textFromPageSnapshot(beforeRetry.message)).toBe("before rollback")

    const retried = Schema.decodeUnknownSync(LoroPageSyncMessageOutput)(
      await workspaceStub.loroPageSyncMessage(
        Schema.encodeSync(LoroPageSyncMessageInput)(
          new LoroPageSyncMessageInput({
            workspaceId,
            nodeId: node.id,
            sessionId,
            ordinal: 0,
            update: new Uint8Array(),
            clientVersion: started.serverVersion
          })
        )
      )
    )
    expect(retried.ordinal).toBe(0)
    const afterRetry = Schema.decodeUnknownSync(StartLoroPageSyncOutput)(
      await workspaceStub.startLoroPageSync(
        Schema.encodeSync(StartLoroPageSyncInput)(new StartLoroPageSyncInput({ workspaceId, nodeId: node.id, sessionId: "loro-after-retry" }))
      )
    )
    expect(textFromPageSnapshot(afterRetry.message)).toBe("before rollback")
  })

  it("rolls back migration descriptor, feed, ledger artifacts, and cache publication on a ledger failpoint", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(await workspaceStub.createNode(
      Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Activation ledger rollback" }))
    )).node
    await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id })))
    const legacy = Schema.decodeUnknownSync(GetPageDocumentDescriptorOutput)(await workspaceStub.getPageDocumentDescriptor(
      Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId: node.id }))
    )).descriptor
    const intent = migrationIntent("Migrate with a ledger failpoint")
    const identity = `migrate-legacy-page:${intent.requestId}`
    ledgerExecuteTestHook.afterMutation = () => { throw new Error("migration ledger failpoint") }
    const failed = await rejectionToDomainError(workspaceStub.migrateLegacyPage(
      encodeLegacyMigration(workspaceId, node.id, legacy, intent)
    ))
    expect(failed._tag).toBe("UnexpectedError")
    const native = workspaceDurableObjectStub(workspaceId)
    expect(await native.debugGetLedgerCommand(identity)).toBeNull()
    expect(await native.debugGetLedgerReceipt(identity)).toBeNull()
    expect(await native.debugGetLedgerEvent(identity)).toBeNull()
    expect(await native.debugGetLedgerOutboxIntent(identity)).toBeNull()
    const after = Schema.decodeUnknownSync(GetPageDocumentDescriptorOutput)(await workspaceStub.getPageDocumentDescriptor(
      Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId: node.id }))
    )).descriptor
    expect(after).toEqual(legacy)
    const feed = Schema.decodeUnknownSync(SyncFeedOutput)(await workspaceStub.syncFeed(
      Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 100 }))
    ))
    expect(feed.entries.filter((entry) => entry.entityKind === "page" && entry.entityId === node.id)).toHaveLength(1)
    expect(await rejectionToDomainError(workspaceStub.startLoroPageSync(
      Schema.encodeSync(StartLoroPageSyncInput)(new StartLoroPageSyncInput({ workspaceId, nodeId: node.id, sessionId: "activation-failpoint-cache" }))
    ))).toBeInstanceOf(PageFormatMismatch)
  })
})

describe("raw Loro sync content fence", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspaceAsTestUser>> | undefined

  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("rejects a nonempty public raw frame before storage, ledger, or session advancement", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(await workspaceStub.createNode(
      Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Raw frame fence" }))
    )).node
    const created = Schema.decodeUnknownSync(CreateLoroPageOutput)(await workspaceStub.createLoroPage(
      Schema.encodeSync(CreateLoroPageInput)(new CreateLoroPageInput({ workspaceId, nodeId: node.id, creationIntent: creationIntent() }))
    ))
    const beforeFeed = Schema.decodeUnknownSync(SyncFeedOutput)(await workspaceStub.syncFeed(
      Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 100 }))
    )).entries
    const started = Schema.decodeUnknownSync(StartLoroPageSyncOutput)(await workspaceStub.startLoroPageSync(
      Schema.encodeSync(StartLoroPageSyncInput)(new StartLoroPageSyncInput({ workspaceId, nodeId: node.id, sessionId: "raw-fence" }))
    ))
    const raw = rawContentUpdate(started)
    expect(raw.update.byteLength).toBeGreaterThan(0)
    const native = workspaceDurableObjectStub(workspaceId)
    const beforeArtifacts = await native.debugGetLedgerArtifactCounts()

    const error = await rejectionToDomainError(workspaceStub.loroPageSyncMessage(
      Schema.encodeSync(LoroPageSyncMessageInput)(new LoroPageSyncMessageInput({
        workspaceId, nodeId: node.id, sessionId: "raw-fence", ordinal: 0, ...raw
      }))
    ))
    expect(error).toBeInstanceOf(LoroSemanticCommitRequired)
    expect(error).toEqual(new LoroSemanticCommitRequired({ nodeId: node.id }))
    expect(JSON.stringify(error)).not.toContain("raw content")
    expect(JSON.stringify(error)).not.toContain(String(raw.update))
    expect(await native.debugGetLedgerArtifactCounts()).toEqual(beforeArtifacts)

    const after = Schema.decodeUnknownSync(GetPageDocumentDescriptorOutput)(await workspaceStub.getPageDocumentDescriptor(
      Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId: node.id }))
    )).descriptor
    expect(after).toEqual(created.descriptor)
    const afterFeed = Schema.decodeUnknownSync(SyncFeedOutput)(await workspaceStub.syncFeed(
      Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 100 }))
    )).entries
    expect(afterFeed).toEqual(beforeFeed)

    // The rejected raw frame did not consume ordinal zero: an empty convergence/reset frame at
    // the same ordinal enters the existing session path normally.
    const empty = Schema.decodeUnknownSync(LoroPageSyncMessageOutput)(await workspaceStub.loroPageSyncMessage(
      Schema.encodeSync(LoroPageSyncMessageInput)(new LoroPageSyncMessageInput({
        workspaceId, nodeId: node.id, sessionId: "raw-fence", ordinal: 0,
        update: new Uint8Array(), clientVersion: started.serverVersion
      }))
    ))
    expect(empty.ordinal).toBe(0)
    expect(empty.converged || empty.reset).toBe(true)

    // An out-of-order empty protocol frame retains the established reset behavior. It cannot
    // carry content and must not change the durable descriptor.
    const resetStarted = Schema.decodeUnknownSync(StartLoroPageSyncOutput)(await workspaceStub.startLoroPageSync(
      Schema.encodeSync(StartLoroPageSyncInput)(new StartLoroPageSyncInput({ workspaceId, nodeId: node.id, sessionId: "raw-fence-reset" }))
    ))
    const reset = Schema.decodeUnknownSync(LoroPageSyncMessageOutput)(await workspaceStub.loroPageSyncMessage(
      Schema.encodeSync(LoroPageSyncMessageInput)(new LoroPageSyncMessageInput({
        workspaceId, nodeId: node.id, sessionId: "raw-fence-reset", ordinal: 1,
        update: new Uint8Array(), clientVersion: resetStarted.serverVersion
      }))
    ))
    expect(reset.reset).toBe(true)
    const afterReset = Schema.decodeUnknownSync(GetPageDocumentDescriptorOutput)(await workspaceStub.getPageDocumentDescriptor(
      Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId: node.id }))
    )).descriptor
    expect(afterReset).toEqual(created.descriptor)
  })

  it("keeps strict input, workspace, and authorization failures ahead of the raw-frame fence", async () => {
    const workspaceId = freshWorkspaceId()
    const authenticated = await connectToWorkspaceAsTestUser(workspaceId)
    const { credential } = await devSignIn(`raw-fence-owner-${crypto.randomUUID()}@example.com`)
    const owner = await connectToUserAs(credential)
    const governedWorkspaceId = Schema.decodeUnknownSync(CreateWorkspaceOutput)(await owner.stub.createWorkspace(
      Schema.encodeSync(CreateWorkspaceInput)(new CreateWorkspaceInput({ title: "Raw frame role gate" }))
    )).workspace.workspaceId
    const anonymous = await connectToWorkspace(governedWorkspaceId)
    try {
      const malformed = await rejectionToDomainError(authenticated.loroPageSyncMessage({
        workspaceId, nodeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", sessionId: "bad", ordinal: 0, update: null, clientVersion: new Uint8Array()
      }))
      expect(malformed).toBeInstanceOf(ValidationError)

      const wrongWorkspace = await rejectionToDomainError(authenticated.loroPageSyncMessage(
        Schema.encodeSync(LoroPageSyncMessageInput)(new LoroPageSyncMessageInput({
          workspaceId: freshWorkspaceId(), nodeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", sessionId: "wrong", ordinal: 0,
          update: new Uint8Array([1]), clientVersion: new Uint8Array()
        }))
      ))
      expect(wrongWorkspace).toBeInstanceOf(ValidationError)

      const unauthorized = await rejectionToDomainError(anonymous.loroPageSyncMessage(
        Schema.encodeSync(LoroPageSyncMessageInput)(new LoroPageSyncMessageInput({
          workspaceId: governedWorkspaceId, nodeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", sessionId: "anonymous", ordinal: 0,
          update: new Uint8Array([1]), clientVersion: new Uint8Array()
        }))
      ))
      expect(unauthorized._tag).toBe("Unauthorized")
    } finally {
      authenticated[Symbol.dispose]()
      anonymous[Symbol.dispose]()
      owner.stub[Symbol.dispose]()
      owner.socket.close()
    }
  })
})
