import { LoroDoc, LoroList, LoroMap, LoroText } from "loro-crdt/bundler"
import * as Automerge from "@automerge/automerge"
import * as Schema from "effect/Schema"
import { afterEach, describe, expect, it } from "vitest"
import {
  ApplyPageEditInput,
  AutomergePageDocumentDescriptor,
  CreateNodeInput,
  CreateNodeOutput,
  CreatePageInput,
  GetPageDocumentDescriptorInput,
  GetPageDocumentDescriptorOutput,
  GetLegacyPageProjectionInput,
  GetLegacyPageProjectionOutput,
  HumanUiMutationAttribution,
  LoroMutationIntentV1,
  MigrateLegacyPageInput,
  MigrateLegacyPageOutput,
  PageSyncMessageInput,
  PageSyncMessageOutput,
  StartPageSyncInput,
  StartPageSyncOutput,
  StartLoroPageSyncInput,
  StartLoroPageSyncOutput,
  ValidationError
} from "@athenaeum/domain"
import { connectToWorkspace, connectToWorkspaceAsTestUser, freshWorkspaceId, rejectionToDomainError, workspaceDurableObjectStub } from "./support.js"

const textFromSnapshot = (snapshot: Uint8Array): string => {
  const doc = new LoroDoc()
  doc.import(snapshot)
  const rootChildren = doc.getMap("athenaeum-prosemirror-v1").get("children")
  if (!(rootChildren instanceof LoroList)) throw new Error("missing Loro root children")
  const paragraph = rootChildren.get(0)
  if (!(paragraph instanceof LoroMap)) throw new Error("missing Loro paragraph")
  const children = paragraph.get("children")
  if (!(children instanceof LoroList)) throw new Error("missing Loro paragraph children")
  const leaf = children.get(0)
  if (!(leaf instanceof LoroText)) throw new Error("missing Loro text leaf")
  return leaf.toString()
}

type LegacyDoc = { text: string; schemaVersion?: unknown; [key: string]: unknown }

const driveLegacySync = async (
  stub: Awaited<ReturnType<typeof connectToWorkspace>>,
  workspaceId: string,
  nodeId: string,
  mutate: (doc: Automerge.Doc<LegacyDoc>) => Automerge.Doc<LegacyDoc>
): Promise<void> => {
  const sessionId = crypto.randomUUID()
  let doc = Automerge.init<LegacyDoc>()
  let syncState = Automerge.initSyncState()
  let started = Schema.decodeUnknownSync(StartPageSyncOutput)(await stub.startPageSync(
    Schema.encodeSync(StartPageSyncInput)(new StartPageSyncInput({ workspaceId, nodeId, sessionId }))
  ))
  let serverMessage = started.message
  let ordinal = 0
  const exchange = async (): Promise<void> => {
    for (let round = 0; round < 20; round += 1) {
      if (serverMessage !== null) {
        const [nextDoc, nextState] = Automerge.receiveSyncMessage(doc, syncState, serverMessage)
        doc = nextDoc
        syncState = nextState
      }
      const [nextState, outgoing] = Automerge.generateSyncMessage(doc, syncState)
      syncState = nextState
      if (outgoing === null) return
      const response = Schema.decodeUnknownSync(PageSyncMessageOutput)(await stub.pageSyncMessage(
        Schema.encodeSync(PageSyncMessageInput)(new PageSyncMessageInput({
          workspaceId, nodeId, sessionId, ordinal, message: outgoing
        }))
      ))
      if (response.reset) throw new Error("legacy sync session unexpectedly reset")
      ordinal += 1
      serverMessage = response.message
      if (response.converged && serverMessage === null) return
    }
    throw new Error("legacy sync did not converge")
  }
  await exchange()
  doc = mutate(doc)
  await exchange()
}

const readLegacyProjection = async (
  stub: Awaited<ReturnType<typeof connectToWorkspace>>,
  workspaceId: string,
  nodeId: string
) => Schema.decodeUnknownSync(GetLegacyPageProjectionOutput)(await stub.getLegacyPageProjection(
  Schema.encodeSync(GetLegacyPageProjectionInput)(new GetLegacyPageProjectionInput({ workspaceId, nodeId }))
))

const readLegacyDescriptor = async (
  stub: Awaited<ReturnType<typeof connectToWorkspace>>,
  workspaceId: string,
  nodeId: string
) => Schema.decodeUnknownSync(GetPageDocumentDescriptorOutput)(await stub.getPageDocumentDescriptor(
  Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId }))
)).descriptor

const migrationIntent = (message = "Migrate a lossless legacy page") => new LoroMutationIntentV1({
  requestId: crypto.randomUUID(), commitMessage: message,
  attribution: new HumanUiMutationAttribution({
    version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor"
  })
})

const createLegacyPage = async (
  stub: Awaited<ReturnType<typeof connectToWorkspace>>,
  workspaceId: string,
  title: string
) => {
  const node = Schema.decodeUnknownSync(CreateNodeOutput)(await stub.createNode(
    Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title }))
  )).node
  await stub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id })))
  return node
}

describe("server-derived legacy page migration", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined

  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it.each(["", "first line\nsecond line", "emoji \u{1F469}\u{1F3FD}\u200D\u{1F4BB} e\u0301 \u05E9\u05DC\u05D5\u05DD"])("derives one canonical Loro paragraph without changing %j", async (sourceText) => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(await workspaceStub.createNode(
      Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Migration fixture" }))
    )).node
    await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id })))
    if (sourceText.length > 0) {
      await workspaceStub.applyPageEdit(Schema.encodeSync(ApplyPageEditInput)(new ApplyPageEditInput({ workspaceId, nodeId: node.id, index: 0, deleteCount: 0, insertText: sourceText })))
    }
    const legacy = Schema.decodeUnknownSync(GetPageDocumentDescriptorOutput)(await workspaceStub.getPageDocumentDescriptor(
      Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId: node.id }))
    )).descriptor
    if (legacy.activeFormat !== "automerge-v1") throw new Error("expected legacy source")
    const intent = new LoroMutationIntentV1({
      requestId: crypto.randomUUID(), commitMessage: "Migrate lossless plain-text legacy page",
      attribution: new HumanUiMutationAttribution({ version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor" })
    })
    const migrated = Schema.decodeUnknownSync(MigrateLegacyPageOutput)(await workspaceStub.migrateLegacyPage(
      Schema.encodeSync(MigrateLegacyPageInput)(new MigrateLegacyPageInput({
        workspaceId, nodeId: node.id, expectedStorageVersion: legacy.storageVersion,
        expectedAutomerge: new AutomergePageDocumentDescriptor(legacy.automerge), intent
      }))
    ))
    expect(migrated.descriptor).toMatchObject({ activeFormat: "loro-v1", storageVersion: legacy.storageVersion + 1, automerge: legacy.automerge })
    const started = Schema.decodeUnknownSync(StartLoroPageSyncOutput)(await workspaceStub.startLoroPageSync(
      Schema.encodeSync(StartLoroPageSyncInput)(new StartLoroPageSyncInput({ workspaceId, nodeId: node.id, sessionId: crypto.randomUUID() }))
    ))
    expect(textFromSnapshot(started.message)).toBe(sourceText)
    const command = await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand(`migrate-legacy-page:${intent.requestId}`)
    expect(command).toMatchObject({ type: "migrateLegacyPage", payload: { sourceStorageVersion: legacy.storageVersion, migrationEngineVersion: "automerge-flat-text-to-loro-v1" } })
    expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCustody(`migrate-legacy-page:${intent.requestId}`)).toMatchObject({
      type: "migrateLegacyPage", actorKind: "user", actorLabel: "You", targetKind: "node", targetId: node.id
    })
    if (sourceText.length > 0) expect(JSON.stringify(command)).not.toContain(sourceText)
  })

  it("withholds rich, marked, unknown-schema, and unknown-root legacy pages instead of flattening them", async () => {
    const cases: ReadonlyArray<{
      readonly name: string
      readonly mutate: (doc: Automerge.Doc<LegacyDoc>) => Automerge.Doc<LegacyDoc>
    }> = [
      {
        name: "marked text",
        mutate: (doc) => {
          const withText = Automerge.change(doc, (draft) => {
            Automerge.splice(draft, ["text"], 0, 0, "marked")
          })
          return Automerge.change(withText, (draft) => {
            Automerge.mark(draft, ["text"], { start: 0, end: 6, expand: "none" }, "em", true)
          })
        }
      },
      {
        name: "block marker",
        mutate: (doc) => {
          const withText = Automerge.change(doc, (draft) => {
            Automerge.splice(draft, ["text"], 0, 0, "block")
          })
          return Automerge.change(withText, (draft) => {
            Automerge.splitBlock(draft, ["text"], 0, {
              type: new Automerge.ImmutableString("paragraph"), parents: [], attrs: {}, isEmbed: false
            })
          })
        }
      },
      {
        name: "unknown root",
        mutate: (doc) => Automerge.change(doc, (draft) => { draft.unexpected = "not part of the flat contract" })
      },
      {
        name: "unsupported schema version",
        mutate: (doc) => Automerge.change(doc, (draft) => { draft.schemaVersion = 2 })
      }
    ]

    for (const testCase of cases) {
      const workspaceId = freshWorkspaceId()
      workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
      const node = await createLegacyPage(workspaceStub, workspaceId, `Unsupported ${testCase.name}`)
      await driveLegacySync(workspaceStub, workspaceId, node.id, testCase.mutate)

      const projection = await readLegacyProjection(workspaceStub, workspaceId, node.id)
      expect(projection.content, testCase.name).toEqual({ kind: "richTextUnsupported" })
      expect(projection).not.toHaveProperty("text")
      const before = await readLegacyDescriptor(workspaceStub, workspaceId, node.id)
      if (before.activeFormat !== "automerge-v1" || before.automerge === undefined) throw new Error("expected legacy descriptor")
      const failure = await rejectionToDomainError(workspaceStub.migrateLegacyPage(
        Schema.encodeSync(MigrateLegacyPageInput)(new MigrateLegacyPageInput({
          workspaceId,
          nodeId: node.id,
          expectedStorageVersion: before.storageVersion,
          expectedAutomerge: before.automerge,
          intent: migrationIntent(`Reject unsupported ${testCase.name}`)
        }))
      ))
      expect(failure).toBeInstanceOf(ValidationError)
      expect(failure.message).toMatch(/rich-text migration|requires rich/i)
      expect(await readLegacyDescriptor(workspaceStub, workspaceId, node.id)).toEqual(before)
      workspaceStub[Symbol.dispose]()
      workspaceStub = undefined
    }
  })

  it("classifies the UTF-8 boundary independently of JavaScript string length", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const exact = await createLegacyPage(workspaceStub, workspaceId, "Exactly one MiB UTF-8")
    const emoji = "\u{1F642}"
    const exactText = emoji.repeat(262_144) // 262,144 * 4 UTF-8 bytes = 1 MiB; 524,288 UTF-16 units.
    await workspaceStub.applyPageEdit(Schema.encodeSync(ApplyPageEditInput)(new ApplyPageEditInput({
      workspaceId, nodeId: exact.id, index: 0, deleteCount: 0, insertText: exactText
    })))
    const exactProjection = await readLegacyProjection(workspaceStub, workspaceId, exact.id)
    expect(exactProjection.content).toEqual({ kind: "plainText", text: exactText })

    const over = await createLegacyPage(workspaceStub, workspaceId, "Over one MiB UTF-8")
    const overText = `${exactText}${emoji}`
    await workspaceStub.applyPageEdit(Schema.encodeSync(ApplyPageEditInput)(new ApplyPageEditInput({
      workspaceId, nodeId: over.id, index: 0, deleteCount: 0, insertText: overText
    })))
    const overProjection = await readLegacyProjection(workspaceStub, workspaceId, over.id)
    expect(overProjection.content).toEqual({ kind: "tooLarge" })
    expect(overProjection).not.toHaveProperty("text")
    const overDescriptor = await readLegacyDescriptor(workspaceStub, workspaceId, over.id)
    if (overDescriptor.activeFormat !== "automerge-v1" || overDescriptor.automerge === undefined) throw new Error("expected legacy descriptor")
    const failure = await rejectionToDomainError(workspaceStub.migrateLegacyPage(
      Schema.encodeSync(MigrateLegacyPageInput)(new MigrateLegacyPageInput({
        workspaceId,
        nodeId: over.id,
        expectedStorageVersion: overDescriptor.storageVersion,
        expectedAutomerge: overDescriptor.automerge,
        intent: migrationIntent("Reject oversized legacy page")
      }))
    ))
    expect(failure).toBeInstanceOf(ValidationError)
    expect(failure.message).toMatch(/plain-text migration limit/i)
  })

  it("compares the complete source witness before migration", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const node = await createLegacyPage(workspaceStub, workspaceId, "Complete witness")
    const legacy = await readLegacyDescriptor(workspaceStub, workspaceId, node.id)
    if (legacy.activeFormat !== "automerge-v1" || legacy.automerge === undefined) throw new Error("expected legacy descriptor")
    const staleWitness = new AutomergePageDocumentDescriptor({
      docId: legacy.automerge.docId,
      headsHash: `${legacy.automerge.headsHash}-stale`,
      bytesSha256: legacy.automerge.bytesSha256
    })
    const failure = await rejectionToDomainError(workspaceStub.migrateLegacyPage(
      Schema.encodeSync(MigrateLegacyPageInput)(new MigrateLegacyPageInput({
        workspaceId, nodeId: node.id, expectedStorageVersion: legacy.storageVersion,
        expectedAutomerge: staleWitness, intent: migrationIntent("Reject stale witness")
      }))
    ))
    expect(failure).toBeInstanceOf(ValidationError)
    expect(failure.message).toMatch(/changed|witness/i)
  })
})
