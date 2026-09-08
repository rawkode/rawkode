// Real proof of Phase 3's `AgentEditService` (plan §"Agent-native editing & gatekeeper
// integrations"), exercised over the real production Cap'n Web RPC path exactly like every other
// feature in this suite — never a shortcut into `AgentEditService` internals. Drives
// `sendChatMessage` against a deterministic `ModelClientScripted` double (no real LLM API key is
// available in this environment — see `model-client-anthropic.test.ts`'s own header comment for
// why a real live-model test is not possible here) programmed to "create two nodes and link them,
// then reply," proving: the pending records exist; are invisible to normal reads (`listNodes`);
// become visible after `mergeChanges`; are fully gone after a simulated `revertChanges`. Also
// proves `reconcilePendingChanges`'s two crash scenarios and the fallback binding-naming scheme.

import { afterEach, describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { LoroDoc, LoroList, LoroMap, LoroText } from "loro-crdt/bundler"
import {
  AcceptChatForkInput,
  AcceptChatForkOutput,
  AddFactInput,
  AddFactOutput,
  ApplyPageEditInput,
  BaseTagFieldIds,
  BaseTagIds,
  ChatForkPreviewInput,
  ChatForkPreviewOutput,
  ChatToolResultBlock,
  CreateChatInput,
  CreateChatOutput,
  CreateLoroPageInput,
  CreateLoroPageOutput,
  CreatePageInput,
  CreatePageOutput,
  CreateRelationDefinitionInput,
  CreateRelationDefinitionOutput,
  CreateTagInput,
  CreateTagOutput,
  CreationIntent,
  GetChatInput,
  GetChatOutput,
  GetChatReviewInput,
  GetChatReviewOutput,
  DecideChatReviewInput,
  DecideChatReviewOutput,
  GetPageDocumentDescriptorInput,
  GetPageDocumentDescriptorOutput,
  GetPageTextInput,
  GetPageTextOutput,
  HumanUiMutationAttribution,
  LedgerCommand,
  ListChatChangesInput,
  ListChatChangesOutput,
  ListNodesInput,
  ListNodesOutput,
  ListPendingChangesInput,
  ListPendingChangesOutput,
  ListRecentLedgerActivityOutput,
  ListTagFieldsInput,
  ListTagFieldsOutput,
  LoroMutationIntentV1,
  MergeChangesInput,
  MergeChangesOutput,
  MigrateLegacyPageInput,
  MigrateLegacyPageOutput,
  ModelClient,
  ModelTurnFinalText,
  ModelTurnToolCalls,
  NodesChangedEvent,
  RevertChangesInput,
  RevertChangesOutput,
  RunViewInput,
  RunViewOutput,
  SendChatMessageInput,
  SendChatMessageOutput,
  StartLoroPageSyncInput,
  StartLoroPageSyncOutput,
  SyncFeedInput,
  SyncFeedOutput,
  ToolCallRequest,
  ViewSpec,
  type EntityId
} from "@athenaeum/domain"
import { agentEditTestHooks, deriveFallbackBindingName } from "../src/agent-edit-service-live.js"
import { agentEditModelClientTestHook } from "../src/workspace-durable-object.js"
import { ledgerCustodyTestHook, ledgerExecuteTestHook } from "../src/ledger-service.js"
import { makeModelClientScripted } from "../src/model-client-scripted.js"
import { connectToWorkspace, connectToWorkspaceAsTestUser, connectToWorkspaceWithSocketAs, devSignIn, freshWorkspaceId, rejectionToDomainError, workspaceDurableObjectStub } from "./support.js"

const readLoroText = (snapshot: Uint8Array): string => {
  const doc = new LoroDoc()
  doc.import(snapshot)
  const root = doc.getMap("athenaeum-prosemirror-v1")
  const leaves: Array<LoroText> = []
  const visit = (value: unknown): void => {
    if (value instanceof LoroText) {
      leaves.push(value)
      return
    }
    if (value instanceof LoroList) {
      for (let index = 0; index < value.length; index++) visit(value.get(index))
      return
    }
    if (value instanceof LoroMap) {
      const children = value.get("children")
      if (children !== undefined) visit(children)
    }
  }
  visit(root)
  return leaves.map((leaf) => leaf.toString()).join("")
}

const relationDefinitionInput = (args: {
  readonly workspaceId: EntityId
  readonly forwardName: string
  readonly inverseName: string
  readonly requestId: string
}) => new CreateRelationDefinitionInput({
  workspaceId: args.workspaceId,
  forwardName: args.forwardName,
  inverseName: args.inverseName,
  sourceTagId: BaseTagIds.Person,
  targetTagId: BaseTagIds.Person,
  cardinality: "many-to-many",
  requestId: args.requestId,
  commitMessage: `Define ${args.forwardName} for this agent test.`,
  attribution: new HumanUiMutationAttribution({ version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-graph-view" })
})

/** Programs a fresh `ModelClientScripted` double and installs its `converse` implementation as
 *  `agentEditModelClientTestHook.converse` — read LIVE by every `sendChatMessage` call (see that
 *  hook's own doc comment), so this can be called at any point in a test, including after the
 *  workspace's DO already exists and other (non-agent) RPC calls have already been made against it —
 *  exactly what every test below needs, since a relationDefinition/node id often must be minted
 *  via a real RPC call before the script referencing it can be constructed. */
const installScriptedModel = (script: ReadonlyArray<ModelTurnToolCalls | ModelTurnFinalText>) => {
  const scripted = makeModelClientScripted(script)
  const service = Effect.runSync(ModelClient.pipe(Effect.provide(scripted.layer)))
  agentEditModelClientTestHook.converse = service.converse
  return scripted
}

const readPageDescriptor = async (
  workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>>,
  workspaceId: EntityId,
  nodeId: EntityId
) => Schema.decodeUnknownSync(GetPageDocumentDescriptorOutput)(
  await workspaceStub.getPageDocumentDescriptor(
    Schema.encodeSync(GetPageDocumentDescriptorInput)(new GetPageDocumentDescriptorInput({ workspaceId, nodeId }))
  )
).descriptor

const readSyncFeed = async (
  workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>>,
  workspaceId: EntityId
) => Schema.decodeUnknownSync(SyncFeedOutput)(
  await workspaceStub.syncFeed(Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 100 })))
).entries

const readChatChanges = async (
  workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>>,
  chatId: EntityId
) => Schema.decodeUnknownSync(ListChatChangesOutput)(
  await workspaceStub.listChatChanges(Schema.encodeSync(ListChatChangesInput)(new ListChatChangesInput({ chatId })))
).changes

const runAgentReadNote = async (args: {
  readonly workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>>
  readonly chatId: EntityId
  readonly binding: string
  readonly toolCallId: string
}): Promise<{ readonly text: string; readonly turn: SendChatMessageOutput }> => {
  const scripted = installScriptedModel([
    new ModelTurnToolCalls({
      kind: "tool_calls",
      calls: [new ToolCallRequest({
        id: args.toolCallId,
        name: "readNote",
        input: { binding: args.binding }
      })]
    }),
    new ModelTurnFinalText({ kind: "final_text", text: "Read the note." })
  ])
  const turn = Schema.decodeUnknownSync(SendChatMessageOutput)(
    await args.workspaceStub.sendChatMessage(
      Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({
        chatId: args.chatId,
        text: `Read ${args.binding}.`
      }))
    )
  )
  expect(scripted.remaining()).toBe(0)
  const chat = Schema.decodeUnknownSync(GetChatOutput)(
    await args.workspaceStub.getChat(Schema.encodeSync(GetChatInput)(new GetChatInput({ chatId: args.chatId })))
  )
  const toolMessage = [...chat.messages].reverse().find(
    (message) => message.role === "tool" && message.content.includes(`\"${args.toolCallId}\"`)
  )
  if (toolMessage === undefined) throw new Error(`missing ${args.toolCallId} tool result`)
  const result = JSON.parse(toolMessage.content) as { readonly result: string; readonly isError: boolean }
  expect(result.isError).toBe(false)
  const output = JSON.parse(result.result) as { readonly text: unknown }
  if (typeof output.text !== "string") throw new Error("readNote result did not contain text")
  return { text: output.text, turn }
}

const runAgentEditNote = async (args: {
  readonly workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>>
  readonly chatId: EntityId
  readonly binding: string
  readonly toolCallId: string
  readonly index: number
  readonly deleteCount: number
  readonly insertText: string
  readonly commitMessage: string
}): Promise<{ readonly text: string; readonly turn: SendChatMessageOutput }> => {
  const scripted = installScriptedModel([
    new ModelTurnToolCalls({
      kind: "tool_calls",
      calls: [new ToolCallRequest({
        id: args.toolCallId,
        name: "editNote",
        input: {
          binding: args.binding,
          index: args.index,
          deleteCount: args.deleteCount,
          insertText: args.insertText,
          commitMessage: args.commitMessage
        }
      })]
    }),
    new ModelTurnFinalText({ kind: "final_text", text: "Updated the note." })
  ])
  const turn = Schema.decodeUnknownSync(SendChatMessageOutput)(
    await args.workspaceStub.sendChatMessage(
      Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({
        chatId: args.chatId,
        text: "Update the note."
      }))
    )
  )
  expect(scripted.remaining()).toBe(0)
  const chat = Schema.decodeUnknownSync(GetChatOutput)(
    await args.workspaceStub.getChat(Schema.encodeSync(GetChatInput)(new GetChatInput({ chatId: args.chatId })))
  )
  const toolMessage = [...chat.messages].reverse().find(
    (message) => message.role === "tool" && message.content.includes(`\"${args.toolCallId}\"`)
  )
  if (toolMessage === undefined) throw new Error(`missing ${args.toolCallId} tool result`)
  const result = JSON.parse(toolMessage.content) as { readonly result: string; readonly isError: boolean }
  expect(result.isError).toBe(false)
  const output = JSON.parse(result.result) as { readonly text: unknown }
  if (typeof output.text !== "string") throw new Error("editNote result did not contain text")
  return { text: output.text, turn }
}

const migrateLegacyPage = async (args: {
  readonly workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>>
  readonly workspaceId: EntityId
  readonly nodeId: EntityId
  readonly requestId: string
}) => {
  const legacy = await readPageDescriptor(args.workspaceStub, args.workspaceId, args.nodeId)
  if (legacy.activeFormat !== "automerge-v1" || legacy.automerge === undefined) {
    throw new Error("expected a legacy Automerge descriptor before migration")
  }
  const intent = new LoroMutationIntentV1({
    requestId: args.requestId,
    commitMessage: "Migrate this agent read fixture to Loro.",
    attribution: new HumanUiMutationAttribution({
      version: "athenaeum.mutation-attribution.v1",
      kind: "humanUi",
      surface: "rich-text-editor"
    })
  })
  const migrated = Schema.decodeUnknownSync(MigrateLegacyPageOutput)(
    await args.workspaceStub.migrateLegacyPage(
      Schema.encodeSync(MigrateLegacyPageInput)(new MigrateLegacyPageInput({
        workspaceId: args.workspaceId,
        nodeId: args.nodeId,
        expectedStorageVersion: legacy.storageVersion,
        expectedAutomerge: legacy.automerge,
        intent
      }))
    )
  )
  return { legacy, migrated }
}

const createChatWithBoundNotes = async (args: {
  readonly workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>>
  readonly workspaceId: EntityId
  readonly notes: ReadonlyArray<{ readonly title: string; readonly binding: string }>
}) => {
  const chat = Schema.decodeUnknownSync(CreateChatOutput)(
    await args.workspaceStub.createChat(
      Schema.encodeSync(CreateChatInput)(new CreateChatInput({
        workspaceId: args.workspaceId,
        title: "Agent page-format read routing"
      }))
    )
  ).chat
  const scripted = installScriptedModel([
    new ModelTurnToolCalls({
      kind: "tool_calls",
      calls: args.notes.map((note, index) => new ToolCallRequest({
        id: `create-bound-note-${index}`,
        name: "createNode",
        input: { title: note.title, binding: note.binding }
      }))
    }),
    new ModelTurnFinalText({ kind: "final_text", text: "Created the notes." })
  ])
  await args.workspaceStub.sendChatMessage(
    Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({
      chatId: chat.id,
      text: "Create the notes."
    }))
  )
  expect(scripted.remaining()).toBe(0)
  const pending = Schema.decodeUnknownSync(ListPendingChangesOutput)(
    await args.workspaceStub.listPendingChanges(
      Schema.encodeSync(ListPendingChangesInput)(new ListPendingChangesInput({ chatId: chat.id }))
    )
  )
  const nodeIdByBinding = new Map<string, EntityId>()
  for (const note of args.notes) {
    const node = pending.nodes.find((candidate) => candidate.title === note.title)
    if (node === undefined) throw new Error(`missing bound ${note.title} note`)
    nodeIdByBinding.set(note.binding, node.id)
  }
  return { chat, nodeIdByBinding }
}

/** Deliberately invalid Loro page used to prove that an agent read surfaces the typed validation
 * error instead of falling through to the legacy Automerge reader. */
const invalidLoroPageSnapshot = (): Uint8Array => {
  const doc = new LoroDoc()
  doc.getMap("athenaeum-page-meta-v1").set("schemaVersion", 1)
  const root = doc.getMap("athenaeum-prosemirror-v1")
  root.set("nodeName", "doc")
  root.getOrCreateContainer("attributes", new LoroMap())
  root.getOrCreateContainer("children", new LoroList())
  doc.commit()
  return doc.export({ mode: "snapshot" })
}

describe("AgentEditService: fallback binding naming (deriveFallbackBindingName)", () => {
  it("slugifies a title into a valid, deterministic ChatBindingName-shaped identifier", () => {
    expect(deriveFallbackBindingName("Alice Johnson")).toBe("ALICE_JOHNSON")
    expect(deriveFallbackBindingName("q3 roadmap!!")).toBe("Q3_ROADMAP")
  })

  it("falls back to a safe default for a title with no identifier-safe characters", () => {
    expect(deriveFallbackBindingName("???")).toBe("NODE")
    expect(deriveFallbackBindingName("")).toBe("NODE")
  })

  it("prefixes a leading-digit slug so the result is still a valid identifier", () => {
    expect(deriveFallbackBindingName("2026 plan")).toBe("NODE_2026_PLAN")
  })

  it("is deterministic — same title always derives the same slug", () => {
    expect(deriveFallbackBindingName("Weekly Sync")).toBe(deriveFallbackBindingName("Weekly Sync"))
  })
})

describe("AgentEditService: smoke test — create two nodes and link them, then reply", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
    agentEditModelClientTestHook.converse = undefined
    ledgerExecuteTestHook.afterMutation = undefined
    ledgerCustodyTestHook.beforeInsert = undefined
  })

  it("pending records exist, invisible to normal reads, visible after mergeChanges, gone after revertChanges", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)

    // Person → Person "knows" relation, needed for the scripted addEdge call — a real, immediate
    // (non-agent) RPC call, made before the script (which needs this id) is constructed.
    const relationDefinition = Schema.decodeUnknownSync(CreateRelationDefinitionOutput)(
      await workspaceStub.createRelationDefinition(
        Schema.encodeSync(CreateRelationDefinitionInput)(
          relationDefinitionInput({ workspaceId, forwardName: "knows", inverseName: "isKnownBy", requestId: "agent-knows-1" })
        )
      )
    ).relationDefinition

    const scripted = installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [
          new ToolCallRequest({ id: "call_1", name: "createNode", input: { title: "Alice", binding: "ALICE" } }),
          new ToolCallRequest({ id: "call_2", name: "createNode", input: { title: "Bob", binding: "BOB" } }),
          new ToolCallRequest({
            id: "call_3",
            name: "addEdge",
            input: { relationDefinitionId: relationDefinition.id, sourceBinding: "ALICE", targetBinding: "BOB" }
          })
        ]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "Created Alice and Bob, and linked Alice knows Bob." })
    ])

    const chat = Schema.decodeUnknownSync(CreateChatOutput)(
      await workspaceStub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Test chat" })))
    ).chat

    const turn = Schema.decodeUnknownSync(SendChatMessageOutput)(
      await workspaceStub.sendChatMessage(
        Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Create Alice and Bob and link them." }))
      )
    )

    // The scripted double was called exactly twice (tool_calls turn, then final_text turn) and
    // consumed its whole script.
    expect(scripted.calls.length).toBe(2)
    expect(scripted.remaining()).toBe(0)

    // Three ChangesMessage batches were produced — one per tool call (createNode/createNode/addEdge).
    expect(turn.changesSequences).toEqual([0, 1, 2])

    const changes = Schema.decodeUnknownSync(ListChatChangesOutput)(
      await workspaceStub.listChatChanges(Schema.encodeSync(ListChatChangesInput)(new ListChatChangesInput({ chatId: chat.id })))
    ).changes
    expect(changes.length).toBe(3)
    expect(changes[0]!.createdNodes?.[0]!.title).toBe("Alice")
    expect(changes[1]!.createdNodes?.[0]!.title).toBe("Bob")
    expect(changes[2]!.addedEdges?.[0]!.relationDefinitionId).toBe(relationDefinition.id)

    // --- Pending records are invisible to normal listNodes -----------------------------------
    const nodesBeforeMerge = Schema.decodeUnknownSync(ListNodesOutput)(
      await workspaceStub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
    ).nodes
    expect(nodesBeforeMerge.find((n) => n.title === "Alice")).toBeUndefined()
    expect(nodesBeforeMerge.find((n) => n.title === "Bob")).toBeUndefined()

    // --- listPendingChanges (web-stage addition): unlike listChatChanges's permanent audit
    // trail, this reflects live pending state — both nodes present, both still carrying `pending`.
    const pendingBeforeMerge = Schema.decodeUnknownSync(ListPendingChangesOutput)(
      await workspaceStub.listPendingChanges(
        Schema.encodeSync(ListPendingChangesInput)(new ListPendingChangesInput({ chatId: chat.id }))
      )
    )
    expect(pendingBeforeMerge.nodes.map((n) => n.title).sort()).toEqual(["Alice", "Bob"])
    expect(pendingBeforeMerge.edges.length).toBe(1)
    expect(pendingBeforeMerge.nodes.every((n) => n.pending !== undefined)).toBe(true)

    // --- mergeChanges promotes everything up through the last batch --------------------------
    const merged = Schema.decodeUnknownSync(MergeChangesOutput)(
      await workspaceStub.mergeChanges(Schema.encodeSync(MergeChangesInput)(new MergeChangesInput({ chatId: chat.id, mergeThrough: 2 })))
    )
    expect(merged).toEqual(new MergeChangesOutput({ chatId: chat.id, mergeThrough: 2 }))
    const compatibilityDecision = (await workspaceDurableObjectStub(workspaceId).debugListLedgerCommandIdentities()).find((entry) => entry.type === "agentChangeDecision")
    expect(compatibilityDecision?.requestIdentity).toMatch(/^reviewed-chat-decision:v2:legacy-merge-/)
    expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCustody(compatibilityDecision!.requestIdentity)).toMatchObject({ type: "agentChangeDecision", actorKind: "user", targetKind: "chat", targetId: chat.id })

    const nodesAfterMerge = Schema.decodeUnknownSync(ListNodesOutput)(
      await workspaceStub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
    ).nodes
    expect(nodesAfterMerge.find((n) => n.title === "Alice")).toBeDefined()
    expect(nodesAfterMerge.find((n) => n.title === "Bob")).toBeDefined()

    // --- listPendingChanges reflects the merge: nothing left pending for this chat, even though
    // listChatChanges (asserted above) still shows the full 3-batch history forever.
    const pendingAfterMerge = Schema.decodeUnknownSync(ListPendingChangesOutput)(
      await workspaceStub.listPendingChanges(
        Schema.encodeSync(ListPendingChangesInput)(new ListPendingChangesInput({ chatId: chat.id }))
      )
    )
    expect(pendingAfterMerge).toEqual(new ListPendingChangesOutput({ nodes: [], facts: [], edges: [] }))
  })

  it("revertChanges deletes pending records for a chat that was never merged — fully gone, not just hidden", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)

    installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [new ToolCallRequest({ id: "call_1", name: "createNode", input: { title: "Discard Me", binding: "DISCARD" } })]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "Created a node." })
    ])

    const chat = Schema.decodeUnknownSync(CreateChatOutput)(
      await workspaceStub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Revert test" })))
    ).chat

    const turn = Schema.decodeUnknownSync(SendChatMessageOutput)(
      await workspaceStub.sendChatMessage(
        Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Create a node." }))
      )
    )
    expect(turn.changesSequences).toEqual([0])

    const pendingBeforeRevert = Schema.decodeUnknownSync(ListPendingChangesOutput)(
      await workspaceStub.listPendingChanges(
        Schema.encodeSync(ListPendingChangesInput)(new ListPendingChangesInput({ chatId: chat.id }))
      )
    )
    expect(pendingBeforeRevert.nodes.map((n) => n.title)).toEqual(["Discard Me"])

    const reverted = Schema.decodeUnknownSync(RevertChangesOutput)(
      await workspaceStub.revertChanges(Schema.encodeSync(RevertChangesInput)(new RevertChangesInput({ chatId: chat.id, revertFrom: 0 })))
    )
    expect(reverted).toEqual(new RevertChangesOutput({ chatId: chat.id, revertFrom: 0 }))

    const nodes = Schema.decodeUnknownSync(ListNodesOutput)(
      await workspaceStub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
    ).nodes
    expect(nodes.find((n) => n.title === "Discard Me")).toBeUndefined()

    // listPendingChanges (unlike listChatChanges) reflects the revert: nothing left pending — the
    // underlying node row is actually gone, not just filtered, per the existing test's own title.
    const pendingAfterRevert = Schema.decodeUnknownSync(ListPendingChangesOutput)(
      await workspaceStub.listPendingChanges(
        Schema.encodeSync(ListPendingChangesInput)(new ListPendingChangesInput({ chatId: chat.id }))
      )
    )
    expect(pendingAfterRevert).toEqual(new ListPendingChangesOutput({ nodes: [], facts: [], edges: [] }))

    // A second revert of the same range is a safe no-op (nothing left to delete).
    await workspaceStub.revertChanges(Schema.encodeSync(RevertChangesInput)(new RevertChangesInput({ chatId: chat.id, revertFrom: 0 })))
  })
})

describe("AgentEditService: reviewed decisions share one ledger transaction", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
    agentEditModelClientTestHook.converse = undefined
    ledgerExecuteTestHook.afterMutation = undefined
    ledgerCustodyTestHook.beforeInsert = undefined
  })

  it("records typed chat custody, privacy-safe side effects, and replays without mutating twice", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [new ToolCallRequest({ id: "ledger-call", name: "createNode", input: { title: "Ledgered node", binding: "LEDGERED" } })]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "Created the ledgered node." })
    ])
    const chat = Schema.decodeUnknownSync(CreateChatOutput)(
      await workspaceStub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Ledger review" })))
    ).chat
    await workspaceStub.sendChatMessage(
      Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Create a node." }))
    )
    const review = Schema.decodeUnknownSync(GetChatReviewOutput)(
      await workspaceStub.getChatReview(Schema.encodeSync(GetChatReviewInput)(new GetChatReviewInput({ chatId: chat.id })))
    )
    const decisionInput = new DecideChatReviewInput({
      chatId: chat.id,
      operation: "accept",
      sequenceBoundary: 0,
      expectedWitness: review.witness,
      requestId: "chat-ledger-1",
      message: "Accept the reviewed node.",
      provenance: "agent-edit-review.test"
    })
    const before = await workspaceDurableObjectStub(workspaceId).debugGetLedgerArtifactCounts()
    const first = await workspaceStub.decideChatReview(Schema.encodeSync(DecideChatReviewInput)(decisionInput))
    const afterFirst = await workspaceDurableObjectStub(workspaceId).debugGetLedgerArtifactCounts()
    expect(afterFirst.commands - before.commands).toBe(1)
    expect(afterFirst.receipts - before.receipts).toBe(1)
    expect(afterFirst.events - before.events).toBe(1)
    expect(afterFirst.outboxIntents - before.outboxIntents).toBe(1)

    const identity = "reviewed-chat-decision:v2:chat-ledger-1"
    const command = await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand(identity)
    expect(command).toMatchObject({ type: "agentChangeDecision", requestId: "chat-ledger-1", message: "Accept the reviewed node." })
    expect(command?.payload).toMatchObject({ schema: "athenaeum.reviewed-chat-decision.v1", chatId: chat.id, range: "all", pendingAppCount: 0, pendingAppWitness: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const custody = await workspaceDurableObjectStub(workspaceId).debugGetLedgerCustody(identity)
    expect(custody).toMatchObject({ type: "agentChangeDecision", actorKind: "user", targetKind: "chat", targetId: chat.id })
    expect(custody?.actorLabel).toMatch(/@example\.com$/)
    expect(command?.principal).toBe(custody?.actorLabel)
    const event = await workspaceDurableObjectStub(workspaceId).debugGetLedgerEvent(identity)
    expect(JSON.stringify(event)).not.toContain(chat.id)
    expect(event).toMatchObject({ kind: "agent-change-decision", payload: { schema: "athenaeum.agent-change-decision-event.v1", operation: "accept", range: "all" } })
    expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerOutboxIntent(identity)).toEqual(event)
    expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerReceipt(identity)).toMatchObject({
      output: { version: "athenaeum.workspace-ledger-receipt.v2", type: "agentChangeDecision" }
    })
    const activity = Schema.decodeUnknownSync(ListRecentLedgerActivityOutput)(await workspaceStub.listRecentLedgerActivity({ workspaceId, limit: 20 }))
    const decisionActivity = activity.entries.find((entry) => entry.type === "agentChangeDecision")
    expect(decisionActivity).toMatchObject({ actor: "you", message: "Accept the reviewed node." })
    expect(decisionActivity?.target).toBeUndefined()

    const replay = await workspaceStub.decideChatReview(Schema.encodeSync(DecideChatReviewInput)(decisionInput))
    expect(replay).toEqual(first)
    expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerArtifactCounts()).toEqual(afterFirst)
  })

  it("rejects anonymous compatibility promotion without changing pending state or ledger artifacts", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const anonymous = await connectToWorkspace(workspaceId)
    try {
      installScriptedModel([
        new ModelTurnToolCalls({
          kind: "tool_calls",
          calls: [new ToolCallRequest({ id: "anonymous-compat-call", name: "createNode", input: { title: "Auth required", binding: "AUTH_REQUIRED" } })]
        }),
        new ModelTurnFinalText({ kind: "final_text", text: "Created a node." })
      ])
      const chat = Schema.decodeUnknownSync(CreateChatOutput)(
        await workspaceStub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Anonymous compatibility" })))
      ).chat
      await workspaceStub.sendChatMessage(Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Create a node." })))
      const before = await workspaceDurableObjectStub(workspaceId).debugGetLedgerArtifactCounts()
      await expect(anonymous.mergeChanges(Schema.encodeSync(MergeChangesInput)(new MergeChangesInput({ chatId: chat.id, mergeThrough: 0 })))).rejects.toThrow(/authenticated user is required/i)
      const pending = Schema.decodeUnknownSync(ListPendingChangesOutput)(await workspaceStub.listPendingChanges(
        Schema.encodeSync(ListPendingChangesInput)(new ListPendingChangesInput({ chatId: chat.id }))
      ))
      expect(pending.nodes.map((node) => node.title)).toEqual(["Auth required"])
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerArtifactCounts()).toEqual(before)
    } finally {
      anonymous[Symbol.dispose]()
    }
  })

  it("rolls back the promotion and all ledger artifacts when a post-mutation step fails", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [new ToolCallRequest({ id: "rollback-call", name: "createNode", input: { title: "Rollback me", binding: "ROLLBACK" } })]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "Created a node." })
    ])
    const chat = Schema.decodeUnknownSync(CreateChatOutput)(
      await workspaceStub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Rollback review" })))
    ).chat
    await workspaceStub.sendChatMessage(Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Create a node." })))
    const review = Schema.decodeUnknownSync(GetChatReviewOutput)(
      await workspaceStub.getChatReview(Schema.encodeSync(GetChatReviewInput)(new GetChatReviewInput({ chatId: chat.id })))
    )
    const makeInput = (requestId: string) => new DecideChatReviewInput({
      chatId: chat.id, operation: "accept", sequenceBoundary: 0, expectedWitness: review.witness,
      requestId, message: "Accept with rollback proof.", provenance: "agent-edit-rollback.test"
    })
    const native = workspaceDurableObjectStub(workspaceId)
    const before = await native.debugGetLedgerArtifactCounts()
    ledgerExecuteTestHook.afterMutation = () => { throw new Error("simulate decision failure") }
    await expect(workspaceStub.decideChatReview(Schema.encodeSync(DecideChatReviewInput)(makeInput("rollback-after-mutation")))).rejects.toThrow(/ledgered chat review decision failed/)
    ledgerExecuteTestHook.afterMutation = undefined
    expect(await native.debugGetLedgerArtifactCounts()).toEqual(before)
    expect((await workspaceStub.listPendingChanges(Schema.encodeSync(ListPendingChangesInput)(new ListPendingChangesInput({ chatId: chat.id })))).nodes).toHaveLength(1)

    ledgerCustodyTestHook.beforeInsert = () => { throw new Error("simulate custody failure") }
    await expect(workspaceStub.decideChatReview(Schema.encodeSync(DecideChatReviewInput)(makeInput("rollback-before-custody")))).rejects.toThrow(/ledgered chat review decision failed/)
    ledgerCustodyTestHook.beforeInsert = undefined
    expect(await native.debugGetLedgerArtifactCounts()).toEqual(before)
    expect((await workspaceStub.listPendingChanges(Schema.encodeSync(ListPendingChangesInput)(new ListPendingChangesInput({ chatId: chat.id })))).nodes).toHaveLength(1)

    await workspaceStub.decideChatReview(Schema.encodeSync(DecideChatReviewInput)(makeInput("rollback-success")))
    expect((await workspaceStub.listPendingChanges(Schema.encodeSync(ListPendingChangesInput)(new ListPendingChangesInput({ chatId: chat.id })))).nodes).toHaveLength(0)
  })
})

// Direct, dedicated proof of the plan's own Phase 3 exit-criterion wording (quoted verbatim):
// "an agent chat creates/links multiple notes and graph entities in one turn, the changes are
// reviewable (accept/revert)... and a simulated mid-turn crash... leaves no orphaned or
// duplicated pending records on the next turn." This describe block covers the first clause
// end-to-end in ONE scripted turn — create two nodes, add a fact to one, link them with an edge,
// then reply — with an exhaustive (not spot-check) assertion of the resulting pending-record set
// before accepting. The crash-mid-turn clause is deliberately NOT re-proven here via test hooks
// (already covered above, "crash-safety — reconcilePendingChanges") — it was instead proven for
// real, out-of-band of this Vitest suite, by literally SIGKILLing a real `wrangler dev` (workerd)
// process mid-turn against real persisted DO SQLite storage and observing `reconcilePendingChanges`
// recover correctly on reconnect (see this task's own final report for the full transcript: a
// 5000-tool-call turn genuinely killed at tool call #2270, restarted against the same
// `--persist-to` storage, and reconciled to exactly 2270 nodes — no gaps, no duplicates, no
// orphans). A literal process kill cannot be driven from inside this in-process Vitest suite (the
// whole point of vitest-pool-workers is a single long-lived workerd instance for test speed), so
// that half of the exit criterion was necessarily verified via the real `phase3-driver` CLI
// against a real standalone `wrangler dev`, not here.
describe("AgentEditService: exit-criterion scenario — create two nodes, add a fact to one, link them with an edge, then reply", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
    agentEditModelClientTestHook.converse = undefined
  })

  it("produces exactly the expected pending nodes/fact/edge, invisible to mainline reads, complete and correct — then fully promotable", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)

    const relationDefinition = Schema.decodeUnknownSync(CreateRelationDefinitionOutput)(
      await workspaceStub.createRelationDefinition(
        Schema.encodeSync(CreateRelationDefinitionInput)(
          relationDefinitionInput({ workspaceId, forwardName: "collaboratesWith", inverseName: "isCollaboratedWithBy", requestId: "agent-collaborates-1" })
        )
      )
    ).relationDefinition

    // ONE scripted turn, four tool calls: create two nodes, add a fact to the first, link both
    // with an edge — then a final_text reply. Matches the exit criterion's own wording exactly
    // ("creates/links multiple notes and graph entities in one turn").
    const scripted = installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [
          new ToolCallRequest({ id: "call_1", name: "createNode", input: { title: "Carol", binding: "CAROL" } }),
          new ToolCallRequest({ id: "call_2", name: "createNode", input: { title: "Dave", binding: "DAVE" } }),
          new ToolCallRequest({
            id: "call_3",
            name: "addFact",
            input: { binding: "CAROL", predicateId: "role", value: "lead" }
          }),
          new ToolCallRequest({
            id: "call_4",
            name: "addEdge",
            input: { relationDefinitionId: relationDefinition.id, sourceBinding: "CAROL", targetBinding: "DAVE" }
          })
        ]
      }),
      new ModelTurnFinalText({
        kind: "final_text",
        text: "Created Carol and Dave, set Carol's role to lead, and linked Carol collaboratesWith Dave."
      })
    ])

    const chat = Schema.decodeUnknownSync(CreateChatOutput)(
      await workspaceStub.createChat(
        Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Exit-criterion scenario" }))
      )
    ).chat

    const turn = Schema.decodeUnknownSync(SendChatMessageOutput)(
      await workspaceStub.sendChatMessage(
        Schema.encodeSync(SendChatMessageInput)(
          new SendChatMessageInput({ chatId: chat.id, text: "Create Carol and Dave, mark Carol as lead, and link them." })
        )
      )
    )

    // One converse() call for the tool_calls turn, one for the final_text turn — the whole script
    // consumed, nothing left unscripted.
    expect(scripted.calls.length).toBe(2)
    expect(scripted.remaining()).toBe(0)

    // Four tool calls, four ChangesMessage batches (§Q15: one per tool call, not per turn — see
    // this file's own doc comment on why), sequential from 0.
    expect(turn.changesSequences).toEqual([0, 1, 2, 3])

    // --- Completeness: the pending-record set is EXACTLY {2 nodes, 1 fact, 1 edge} — not a
    // spot-check of a couple of fields, every node/fact/edge produced by the turn accounted for.
    const pending = Schema.decodeUnknownSync(ListPendingChangesOutput)(
      await workspaceStub.listPendingChanges(
        Schema.encodeSync(ListPendingChangesInput)(new ListPendingChangesInput({ chatId: chat.id }))
      )
    )
    expect(pending.nodes).toHaveLength(2)
    expect(pending.facts).toHaveLength(1)
    expect(pending.edges).toHaveLength(1)

    const carol = pending.nodes.find((n) => n.title === "Carol")
    const dave = pending.nodes.find((n) => n.title === "Dave")
    expect(carol).toBeDefined()
    expect(dave).toBeDefined()
    // Every pending record carries the SAME chat's PendingMarker — none accidentally attributed
    // to a different/no chat.
    for (const node of pending.nodes) expect(node.pending?.chatId).toBe(chat.id)
    expect(pending.facts[0]!.nodeId).toBe(carol!.id)
    expect(pending.facts[0]!.predicateId).toBe("role")
    expect(pending.facts[0]!.value).toBe("lead")
    expect(pending.facts[0]!.pending?.chatId).toBe(chat.id)
    expect(pending.edges[0]!.sourceNodeId).toBe(carol!.id)
    expect(pending.edges[0]!.targetNodeId).toBe(dave!.id)
    expect(pending.edges[0]!.relationDefinitionId).toBe(relationDefinition.id)
    expect(pending.edges[0]!.pending?.chatId).toBe(chat.id)

    // Every pending record is stamped (sequence defined) — this turn ran to completion with no
    // crash, so nothing should be left in the "logged but unflushed" unstamped state.
    expect(pending.nodes.every((n) => n.pending?.sequence !== undefined)).toBe(true)
    expect(pending.facts.every((f) => f.pending?.sequence !== undefined)).toBe(true)
    expect(pending.edges.every((e) => e.pending?.sequence !== undefined)).toBe(true)

    // --- The permanent audit trail (listChatChanges) independently agrees: exactly 4 batches,
    // one createdNodes/createdNodes/addedFacts/addedEdges summary each, in call order.
    const changes = Schema.decodeUnknownSync(ListChatChangesOutput)(
      await workspaceStub.listChatChanges(Schema.encodeSync(ListChatChangesInput)(new ListChatChangesInput({ chatId: chat.id })))
    ).changes
    expect(changes).toHaveLength(4)
    expect(changes[0]!.createdNodes?.[0]!.title).toBe("Carol")
    expect(changes[1]!.createdNodes?.[0]!.title).toBe("Dave")
    expect(changes[2]!.addedFacts?.[0]!.predicateId).toBe("role")
    expect(changes[3]!.addedEdges?.[0]!.relationDefinitionId).toBe(relationDefinition.id)

    // --- Invisibility: none of this shows up in a mainline listNodes/listBacklinks read yet.
    const nodesBeforeMerge = Schema.decodeUnknownSync(ListNodesOutput)(
      await workspaceStub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
    ).nodes
    expect(nodesBeforeMerge.find((n) => n.title === "Carol")).toBeUndefined()
    expect(nodesBeforeMerge.find((n) => n.title === "Dave")).toBeUndefined()

    // --- Reviewable: mergeChanges promotes every batch (accept "the whole turn").
    const merged = Schema.decodeUnknownSync(MergeChangesOutput)(
      await workspaceStub.mergeChanges(Schema.encodeSync(MergeChangesInput)(new MergeChangesInput({ chatId: chat.id, mergeThrough: 3 })))
    )
    expect(merged).toEqual(new MergeChangesOutput({ chatId: chat.id, mergeThrough: 3 }))

    const nodesAfterMerge = Schema.decodeUnknownSync(ListNodesOutput)(
      await workspaceStub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
    ).nodes
    expect(nodesAfterMerge.find((n) => n.title === "Carol")).toBeDefined()
    expect(nodesAfterMerge.find((n) => n.title === "Dave")).toBeDefined()

    // Nothing left pending for this chat after a full accept.
    const pendingAfterMerge = Schema.decodeUnknownSync(ListPendingChangesOutput)(
      await workspaceStub.listPendingChanges(
        Schema.encodeSync(ListPendingChangesInput)(new ListPendingChangesInput({ chatId: chat.id }))
      )
    )
    expect(pendingAfterMerge).toEqual(new ListPendingChangesOutput({ nodes: [], facts: [], edges: [] }))
  })
})

describe("AgentEditService: addFact tool produces a pending fact invisible until merged", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
    agentEditModelClientTestHook.converse = undefined
  })

  it("addFact via the agent tool is real, pending, and mainline-invisible until mergeChanges", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`agent-add-fact-${crypto.randomUUID()}@example.com`)
    workspaceStub = (await connectToWorkspaceWithSocketAs(workspaceId, credential)).stub

    installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [
          new ToolCallRequest({ id: "call_1", name: "createNode", input: { title: "Project X", binding: "PROJ" } }),
          new ToolCallRequest({ id: "call_2", name: "addFact", input: { binding: "PROJ", predicateId: "status", value: "active" } })
        ]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "Done." })
    ])

    const chat = Schema.decodeUnknownSync(CreateChatOutput)(
      await workspaceStub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Fact test" })))
    ).chat

    const turn = Schema.decodeUnknownSync(SendChatMessageOutput)(
      await workspaceStub.sendChatMessage(
        Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Create Project X, mark active." }))
      )
    )
    expect(turn.changesSequences).toEqual([0, 1])

    await workspaceStub.mergeChanges(Schema.encodeSync(MergeChangesInput)(new MergeChangesInput({ chatId: chat.id, mergeThrough: 1 })))

    const nodes = Schema.decodeUnknownSync(ListNodesOutput)(
      await workspaceStub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
    ).nodes
    const node = nodes.find((n) => n.title === "Project X")
    expect(node).toBeDefined()

    // A duplicate, ordinary (non-pending) addFact on the now-mainline node succeeds normally —
    // proof the promoted node is fully usable via the standard RPC surface.
    const directFact = Schema.decodeUnknownSync(AddFactOutput)(
      await workspaceStub.addFact(
        Schema.encodeSync(AddFactInput)(new AddFactInput({ workspaceId, nodeId: node!.id, predicateId: "owner", value: "david", requestId: "agent-test-owner", commitMessage: "Set owner.", attribution: new HumanUiMutationAttribution({ version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-supertag-field-editor" }) }))
      )
    )
    expect(directFact.fact.predicateId).toBe("owner")
  })
})

describe("AgentEditService: defineSupertag tool — mainline schema mutation, no pending row", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
    agentEditModelClientTestHook.converse = undefined
  })

  it("defineSupertag adds a field to a tag immediately (visible via listTagFields, no ChangesMessage produced)", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`agent-tag-${crypto.randomUUID()}@example.com`)
    workspaceStub = (await connectToWorkspaceWithSocketAs(workspaceId, credential)).stub

    const tag = Schema.decodeUnknownSync(CreateTagOutput)(
      await workspaceStub.createTag(
        Schema.encodeSync(CreateTagInput)(new CreateTagInput({
          workspaceId,
          name: "Reviewer",
          parentIds: [],
          requestId: `agent-create-tag-${crypto.randomUUID()}`,
          commitMessage: "Define the Reviewer Supertag for the agent test.",
          attribution: new HumanUiMutationAttribution({
            version: "athenaeum.mutation-attribution.v1",
            kind: "humanUi",
            surface: "web-supertags-manager"
          })
        }))
      )
    ).tag

    installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [
          new ToolCallRequest({
            id: "call_1",
            name: "defineSupertag",
            input: { tagId: tag.id, name: "level", valueKind: "text", sortOrder: 0 }
          })
        ]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "Added the field." })
    ])

    const chat = Schema.decodeUnknownSync(CreateChatOutput)(
      await workspaceStub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Field test" })))
    ).chat

    const turn = Schema.decodeUnknownSync(SendChatMessageOutput)(
      await workspaceStub.sendChatMessage(
        Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Add a level field to Reviewer." }))
      )
    )
    // No pending row: `defineSupertag` is a mainline schema mutation, like `createTag` itself —
    // it never produces a `ChangesMessage`/pending record, so `changesSequences` stays empty.
    expect(turn.changesSequences).toEqual([])

    const fields = Schema.decodeUnknownSync(ListTagFieldsOutput)(
      await workspaceStub.listTagFields(Schema.encodeSync(ListTagFieldsInput)(new ListTagFieldsInput({ workspaceId, tagId: tag.id })))
    ).fields
    expect(fields.map((f) => f.field.name)).toEqual(["level"])
  })
})

describe("AgentEditService: applySupertag tool produces pending facts invisible until merged", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
    agentEditModelClientTestHook.converse = undefined
  })

  it("applySupertag tags the bound node and seeds pending field values, real and mainline-invisible until mergeChanges", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)

    installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [
          new ToolCallRequest({ id: "call_1", name: "createNode", input: { title: "Ada Lovelace", binding: "ADA" } }),
          new ToolCallRequest({
            id: "call_2",
            name: "applySupertag",
            input: {
              binding: "ADA",
              tagId: BaseTagIds.Person,
              fieldValues: [{ fieldId: BaseTagFieldIds.PersonRole, value: "Mathematician" }]
            }
          })
        ]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "Done." })
    ])

    const chat = Schema.decodeUnknownSync(CreateChatOutput)(
      await workspaceStub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Supertag test" })))
    ).chat

    const turn = Schema.decodeUnknownSync(SendChatMessageOutput)(
      await workspaceStub.sendChatMessage(
        Schema.encodeSync(SendChatMessageInput)(
          new SendChatMessageInput({ chatId: chat.id, text: "Create Ada, tag her Person, role Mathematician." })
        )
      )
    )
    expect(turn.changesSequences).toEqual([0, 1])

    const changes = Schema.decodeUnknownSync(ListChatChangesOutput)(
      await workspaceStub.listChatChanges(Schema.encodeSync(ListChatChangesInput)(new ListChatChangesInput({ chatId: chat.id })))
    ).changes
    expect(changes[1]!.addedFacts?.[0]!.predicateId).toBe(BaseTagFieldIds.PersonRole)

    await workspaceStub.mergeChanges(Schema.encodeSync(MergeChangesInput)(new MergeChangesInput({ chatId: chat.id, mergeThrough: 1 })))

    const nodes = Schema.decodeUnknownSync(ListNodesOutput)(
      await workspaceStub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
    ).nodes
    const node = nodes.find((n) => n.title === "Ada Lovelace")
    expect(node).toBeDefined()

    // The promoted fact is real and queryable through the standard read-model path, not just
    // trusted from the tool-call's own echoed output. `eq`/`in` `ViewSpec` filters JSON-encode
    // their bound parameter (`read-model.ts`'s `jsonParam`), which only round-trips against a
    // column that is ITSELF stored JSON-encoded — true for `graph_facts.value`, not for a plain
    // string column like `nodeId` (workouts.test.ts's own established finding/workaround) — so
    // this fetches the whole (small, per-test-workspace) view unfiltered and filters/parses in
    // JS, exactly that suite's own pattern.
    const allFacts = Schema.decodeUnknownSync(RunViewOutput)(
      await workspaceStub.runView(
        Schema.encodeSync(RunViewInput)(
          new RunViewInput({
            workspaceId,
            viewName: "graph_facts",
            viewSpec: new ViewSpec({ view: "table", visibleColumns: ["nodeId", "predicateId", "value"], rowLimit: 50 })
          })
        )
      )
    ).rows as ReadonlyArray<{ nodeId: string; predicateId: string; value: string }>
    const nodeFacts = allFacts.filter((f) => f.nodeId === node!.id)
    expect(nodeFacts).toHaveLength(1)
    expect(nodeFacts[0]!.predicateId).toBe(BaseTagFieldIds.PersonRole)
    expect(JSON.parse(nodeFacts[0]!.value)).toBe("Mathematician")
  })
})

describe("AgentEditService: applySupertag tool crash-safety — reconcilePendingChanges", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
    agentEditModelClientTestHook.converse = undefined
    agentEditTestHooks.skipToolLog = false
    agentEditTestHooks.skipFlush = false
    agentEditTestHooks.skipReconcile = false
  })

  /** Sets up a chat with an already-mainline node bound as `binding`, so the scripted turn under
   *  test can call `applySupertag` directly (its own `resolveNodeBinding` needs a real binding,
   *  same precondition every other tool test here that isn't itself testing `createNode`
   *  arranges up front). */
  const createChatWithBoundNode = async (
    stub: NonNullable<typeof workspaceStub>,
    workspaceId: ReturnType<typeof freshWorkspaceId>,
    binding: string
  ) => {
    const chat = Schema.decodeUnknownSync(CreateChatOutput)(
      await stub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Supertag crash-safety" })))
    ).chat
    installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [new ToolCallRequest({ id: "setup_1", name: "createNode", input: { title: "Node", binding } })]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "..." })
    ])
    await stub.sendChatMessage(
      Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "setup" }))
    )
    await stub.mergeChanges(Schema.encodeSync(MergeChangesInput)(new MergeChangesInput({ chatId: chat.id, mergeThrough: 0 })))
    return chat
  }

  it("orphan case: a pending applySupertag fact with no logged tool call is reaped, not re-adopted", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const chat = await createChatWithBoundNode(workspaceStub, workspaceId, "PERSON")

    // Baseline: the setup turn above already produced one `ChangesMessage` (the bound node's own
    // `createNode` call) — `listChatChanges` accumulates across the whole chat, so every
    // assertion below compares against this baseline, not an absolute 0/1.
    const baseline = Schema.decodeUnknownSync(ListChatChangesOutput)(
      await workspaceStub.listChatChanges(Schema.encodeSync(ListChatChangesInput)(new ListChatChangesInput({ chatId: chat.id })))
    ).changes.length

    installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [
          new ToolCallRequest({
            id: "call_1",
            name: "applySupertag",
            input: {
              binding: "PERSON",
              tagId: BaseTagIds.Person,
              fieldValues: [{ fieldId: BaseTagFieldIds.PersonRole, value: "Orphan Role" }]
            }
          })
        ]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "..." })
    ])

    // Same three-hook crash simulation as the generic `createNode` orphan test above: the pending
    // fact write happens, but neither the tool-call log, the flush, nor `sendChatMessage`'s own
    // automatic end-of-turn reconcile ever lands.
    agentEditTestHooks.skipToolLog = true
    agentEditTestHooks.skipFlush = true
    agentEditTestHooks.skipReconcile = true
    const turn = Schema.decodeUnknownSync(SendChatMessageOutput)(
      await workspaceStub.sendChatMessage(
        Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Apply an orphan supertag." }))
      )
    )
    expect(turn.changesSequences).toEqual([])

    agentEditTestHooks.skipToolLog = false
    agentEditTestHooks.skipFlush = false
    agentEditTestHooks.skipReconcile = false
    installScriptedModel([new ModelTurnFinalText({ kind: "final_text", text: "noop" })])
    await workspaceStub.sendChatMessage(
      Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "trigger reconcile" }))
    )

    const changes = Schema.decodeUnknownSync(ListChatChangesOutput)(
      await workspaceStub.listChatChanges(Schema.encodeSync(ListChatChangesInput)(new ListChatChangesInput({ chatId: chat.id })))
    ).changes
    // No NEW `ChangesMessage` beyond the baseline — the orphan was reaped, not re-adopted.
    expect(changes.length).toBe(baseline)

    // A merge over any range is a safe no-op — the orphaned fact was reaped, nothing left pending.
    await workspaceStub.mergeChanges(Schema.encodeSync(MergeChangesInput)(new MergeChangesInput({ chatId: chat.id, mergeThrough: 100 })))
    const pending = Schema.decodeUnknownSync(ListPendingChangesOutput)(
      await workspaceStub.listPendingChanges(Schema.encodeSync(ListPendingChangesInput)(new ListPendingChangesInput({ chatId: chat.id })))
    )
    expect(pending.facts).toEqual([])
  })

  it("re-adopt case: a pending applySupertag fact whose tool call WAS logged, but never flushed, is re-adopted on reconcile", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const chat = await createChatWithBoundNode(workspaceStub, workspaceId, "PERSON")

    // Baseline: the setup turn above already produced one `ChangesMessage` (the bound node's own
    // `createNode` call) — see the orphan-case test's identical baseline comment above.
    const baseline = Schema.decodeUnknownSync(ListChatChangesOutput)(
      await workspaceStub.listChatChanges(Schema.encodeSync(ListChatChangesInput)(new ListChatChangesInput({ chatId: chat.id })))
    ).changes.length

    installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [
          new ToolCallRequest({
            id: "call_1",
            name: "applySupertag",
            input: {
              binding: "PERSON",
              tagId: BaseTagIds.Person,
              fieldValues: [{ fieldId: BaseTagFieldIds.PersonRole, value: "Readopt Role" }]
            }
          })
        ]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "..." })
    ])

    // Crash lands between the log write and the flush: logged, but neither the flush nor the
    // automatic end-of-turn reconcile (same call) ever runs.
    agentEditTestHooks.skipFlush = true
    agentEditTestHooks.skipReconcile = true
    await workspaceStub.sendChatMessage(
      Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Apply a re-adopt supertag." }))
    )

    const beforeReconcile = Schema.decodeUnknownSync(ListChatChangesOutput)(
      await workspaceStub.listChatChanges(Schema.encodeSync(ListChatChangesInput)(new ListChatChangesInput({ chatId: chat.id })))
    ).changes
    // No NEW `ChangesMessage` yet — the flush that would have produced one never ran.
    expect(beforeReconcile.length).toBe(baseline)

    agentEditTestHooks.skipFlush = false
    agentEditTestHooks.skipReconcile = false
    installScriptedModel([new ModelTurnFinalText({ kind: "final_text", text: "noop" })])
    await workspaceStub.sendChatMessage(
      Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "trigger reconcile" }))
    )

    const afterReconcile = Schema.decodeUnknownSync(ListChatChangesOutput)(
      await workspaceStub.listChatChanges(Schema.encodeSync(ListChatChangesInput)(new ListChatChangesInput({ chatId: chat.id })))
    ).changes
    // Exactly one NEW `ChangesMessage` beyond the baseline — the re-adopt sweep's own flush.
    expect(afterReconcile.length).toBe(baseline + 1)
    const readopted = afterReconcile[afterReconcile.length - 1]!
    expect(readopted.addedFacts?.[0]!.predicateId).toBe(BaseTagFieldIds.PersonRole)

    // The re-adopted fact is now mergeable.
    await workspaceStub.mergeChanges(
      Schema.encodeSync(MergeChangesInput)(new MergeChangesInput({ chatId: chat.id, mergeThrough: readopted.sequence }))
    )
    const pending = Schema.decodeUnknownSync(ListPendingChangesOutput)(
      await workspaceStub.listPendingChanges(Schema.encodeSync(ListPendingChangesInput)(new ListPendingChangesInput({ chatId: chat.id })))
    )
    expect(pending.facts).toEqual([])
  })
})

describe("AgentEditService: ModelClientScripted drives multi-turn tool-error recovery", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
    agentEditModelClientTestHook.converse = undefined
  })

  it("a tool call that errors is surfaced back to the model as isError:true, and the model recovers with a different tool call on its next turn", async () => {
    // Three separate scripted turns (three separate `converse()` calls, not three tool calls in
    // one turn) — proves `sendChatMessage`'s tool-calling loop genuinely iterates across multiple
    // model turns, and that a failed tool call does not abort the turn:
    //   1. tool_calls: linkCalendarEvent — guaranteed to fail with `ToolNotImplemented` (Phase 3
    //      has no calendar concept yet; see `linkCalendarEventTool`'s own doc comment), so this
    //      scenario needs no fragile setup to force an error.
    //   2. tool_calls: createNode — the model "changing its mind" after seeing its own tool's
    //      error on the previous turn's `tool_result`, recovering with a different tool entirely.
    //   3. final_text — the turn concludes normally.
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)

    const scripted = installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [
          new ToolCallRequest({
            id: "call_1",
            name: "linkCalendarEvent",
            input: { binding: "EVT", calendarEventId: "google-evt-1" }
          })
        ]
      }),
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [new ToolCallRequest({ id: "call_2", name: "createNode", input: { title: "Recovered", binding: "REC" } })]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "Calendar linking isn't available yet, so I created a note instead." })
    ])

    const chat = Schema.decodeUnknownSync(CreateChatOutput)(
      await workspaceStub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Error recovery test" })))
    ).chat

    const turn = Schema.decodeUnknownSync(SendChatMessageOutput)(
      await workspaceStub.sendChatMessage(
        Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Link a calendar event." }))
      )
    )

    // Three real `converse()` calls consumed the whole three-entry script.
    expect(scripted.calls.length).toBe(3)
    expect(scripted.remaining()).toBe(0)

    // The second `converse()` call's thread carries the FIRST call's failure back to the model as
    // a real `tool_result` content block with `isError: true` — proof the model genuinely "saw"
    // the error (not just that the turn happened not to crash).
    const secondCallThread = scripted.calls[1]!.thread
    const lastMessageOfSecondCall = secondCallThread.messages[secondCallThread.messages.length - 1]!
    expect(lastMessageOfSecondCall.content[0]).toEqual(
      new ChatToolResultBlock({
        type: "tool_result",
        toolUseId: "call_1",
        content: "linkCalendarEvent is not implemented until Phase 5 (Google Calendar gatekeeper).",
        isError: true
      })
    )

    // Only the SECOND tool call (createNode) produced a pending entity/`ChangesMessage` batch —
    // the failed `linkCalendarEvent` call produced none, so sequence numbering starts at 0 on the
    // call that actually succeeded, not on call order.
    expect(turn.changesSequences).toEqual([0])

    const changes = Schema.decodeUnknownSync(ListChatChangesOutput)(
      await workspaceStub.listChatChanges(Schema.encodeSync(ListChatChangesInput)(new ListChatChangesInput({ chatId: chat.id })))
    ).changes
    expect(changes.length).toBe(1)
    expect(changes[0]!.createdNodes?.[0]!.title).toBe("Recovered")

    // The recovered node is real, pending, and (as with every other pending-record scenario in
    // this suite) invisible to mainline reads until merged.
    const nodesBeforeMerge = Schema.decodeUnknownSync(ListNodesOutput)(
      await workspaceStub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
    ).nodes
    expect(nodesBeforeMerge.find((n) => n.title === "Recovered")).toBeUndefined()

    await workspaceStub.mergeChanges(Schema.encodeSync(MergeChangesInput)(new MergeChangesInput({ chatId: chat.id, mergeThrough: 0 })))
    const nodesAfterMerge = Schema.decodeUnknownSync(ListNodesOutput)(
      await workspaceStub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
    ).nodes
    expect(nodesAfterMerge.find((n) => n.title === "Recovered")).toBeDefined()
  })
})

describe("AgentEditService: crash-safety — reconcilePendingChanges", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
    agentEditModelClientTestHook.converse = undefined
    agentEditTestHooks.skipToolLog = false
    agentEditTestHooks.skipFlush = false
    agentEditTestHooks.skipReconcile = false
  })

  it("orphan case: a pending record with no logged tool call is reaped, not re-adopted", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)

    installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [new ToolCallRequest({ id: "call_1", name: "createNode", input: { title: "Orphan", binding: "ORPHAN" } })]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "..." })
    ])

    const chat = Schema.decodeUnknownSync(CreateChatOutput)(
      await workspaceStub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Orphan test" })))
    ).chat

    // Simulate a crash: the pending write happens, but NEITHER the tool-call log NOR the flush
    // NOR `sendChatMessage`'s own automatic start-/end-of-turn reconcile ever lands (the DO dies
    // before any of them) — all three hooks on throughout this call.
    agentEditTestHooks.skipToolLog = true
    agentEditTestHooks.skipFlush = true
    agentEditTestHooks.skipReconcile = true
    const turn = Schema.decodeUnknownSync(SendChatMessageOutput)(
      await workspaceStub.sendChatMessage(
        Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Create an orphan." }))
      )
    )
    expect(turn.changesSequences).toEqual([])

    // Now simulate "the DO restarts" (hooks back to normal) and run a real reconcile sweep by
    // sending a fresh message. The orphaned node has no logged tool call anywhere in this chat's
    // history, so reconcile must reap (delete) it, not re-adopt it.
    agentEditTestHooks.skipToolLog = false
    agentEditTestHooks.skipFlush = false
    agentEditTestHooks.skipReconcile = false
    installScriptedModel([new ModelTurnFinalText({ kind: "final_text", text: "noop" })])
    await workspaceStub.sendChatMessage(
      Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "trigger reconcile" }))
    )

    const changes = Schema.decodeUnknownSync(ListChatChangesOutput)(
      await workspaceStub.listChatChanges(Schema.encodeSync(ListChatChangesInput)(new ListChatChangesInput({ chatId: chat.id })))
    ).changes
    expect(changes.length).toBe(0)

    const nodes = Schema.decodeUnknownSync(ListNodesOutput)(
      await workspaceStub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
    ).nodes
    expect(nodes.find((n) => n.title === "Orphan")).toBeUndefined()

    // A merge over any range is a safe no-op — there is nothing left pending to promote.
    await workspaceStub.mergeChanges(Schema.encodeSync(MergeChangesInput)(new MergeChangesInput({ chatId: chat.id, mergeThrough: 100 })))
    const nodesAfterMerge = Schema.decodeUnknownSync(ListNodesOutput)(
      await workspaceStub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
    ).nodes
    expect(nodesAfterMerge.find((n) => n.title === "Orphan")).toBeUndefined()
  })

  it("re-adopt case: a pending record whose tool call WAS logged, but never flushed, is re-adopted (stamped) on reconcile", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)

    installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [new ToolCallRequest({ id: "call_1", name: "createNode", input: { title: "Readopt Me", binding: "READOPT" } })]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "..." })
    ])

    const chat = Schema.decodeUnknownSync(CreateChatOutput)(
      await workspaceStub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Re-adopt test" })))
    ).chat

    // Simulate a crash landing between the log write and the flush: the tool call IS logged, but
    // neither the flush that would stamp `pending.sequence` NOR `sendChatMessage`'s own automatic
    // end-of-turn reconcile (which runs inside this SAME call) ever runs.
    agentEditTestHooks.skipFlush = true
    agentEditTestHooks.skipReconcile = true
    await workspaceStub.sendChatMessage(
      Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Create a node to re-adopt." }))
    )

    const beforeReconcile = Schema.decodeUnknownSync(ListChatChangesOutput)(
      await workspaceStub.listChatChanges(Schema.encodeSync(ListChatChangesInput)(new ListChatChangesInput({ chatId: chat.id })))
    ).changes
    expect(beforeReconcile.length).toBe(0)

    // An unstamped crash-recovery row is disclosed only as non-actionable recovery work. Neither
    // accept nor revert may claim to have decided it before reconciliation has durably stamped it.
    const recoveryReview = Schema.decodeUnknownSync(GetChatReviewOutput)(
      await workspaceStub.getChatReview(Schema.encodeSync(GetChatReviewInput)(new GetChatReviewInput({ chatId: chat.id })))
    )
    expect(recoveryReview.items.some((item) => !item.stamped && !item.actionable)).toBe(true)
    for (const operation of ["accept", "revert"] as const) {
      await expect(workspaceStub.decideChatReview(
        Schema.encodeSync(DecideChatReviewInput)(new DecideChatReviewInput({
          chatId: chat.id, operation, sequenceBoundary: 0, expectedWitness: recoveryReview.witness,
          requestId: `recovery-${operation}`, message: "Do not decide recovery work", provenance: "user-review"
        }))
      )).rejects.toThrow(/unfinished recovery/)
    }

    // "The DO restarts": both hooks back to normal, and a fresh turn's start-of-turn reconcile
    // finds the logged-but-unstamped record and re-adopts it (stamps it via a brand-new
    // `ChangesMessage`) before the model is even called.
    agentEditTestHooks.skipFlush = false
    agentEditTestHooks.skipReconcile = false
    installScriptedModel([new ModelTurnFinalText({ kind: "final_text", text: "noop" })])
    await workspaceStub.sendChatMessage(
      Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "trigger reconcile" }))
    )

    const afterReconcile = Schema.decodeUnknownSync(ListChatChangesOutput)(
      await workspaceStub.listChatChanges(Schema.encodeSync(ListChatChangesInput)(new ListChatChangesInput({ chatId: chat.id })))
    ).changes
    expect(afterReconcile.length).toBe(1)
    expect(afterReconcile[0]!.createdNodes?.[0]!.title).toBe("Readopt Me")

    // The re-adopted record is now mergeable.
    await workspaceStub.mergeChanges(
      Schema.encodeSync(MergeChangesInput)(new MergeChangesInput({ chatId: chat.id, mergeThrough: afterReconcile[0]!.sequence }))
    )
    const nodes = Schema.decodeUnknownSync(ListNodesOutput)(
      await workspaceStub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
    ).nodes
    expect(nodes.find((n) => n.title === "Readopt Me")).toBeDefined()
  })
})

describe("AgentEditService: errors surface as typed DomainErrors, not opaque failures", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
    agentEditModelClientTestHook.converse = undefined
  })

  it("getChat on an unknown chatId fails with a typed ChatNotFound", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const bogusChatId = freshWorkspaceId() as unknown as EntityId
    const error = await rejectionToDomainError(
      workspaceStub.getChat(Schema.encodeSync(GetChatInput)(new GetChatInput({ chatId: bogusChatId })))
    )
    expect(error._tag).toBe("ChatNotFound")
  })

  it("sendChatMessage with no ModelClient configured (real ModelClientAnthropic, no API key) fails with UnexpectedError, not a crash", async () => {
    // Deliberately does NOT install a scripted model — this workspace's `sendChatMessage` falls
    // through to the real production default, `ModelClientAnthropic` with `env.ANTHROPIC_API_KEY`
    // unset in this environment (hard constraint: no real key available here). `ModelUnavailable`
    // is mapped to `UnexpectedError` by `sendChatMessage` (see agent-edit-service-live.ts's own
    // doc comment on why, rather than growing `DomainError` further for this stage).
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const chat = Schema.decodeUnknownSync(CreateChatOutput)(
      await workspaceStub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "No model" })))
    ).chat
    const error = await rejectionToDomainError(
      workspaceStub.sendChatMessage(
        Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "hello" }))
      )
    )
    expect(error._tag).toBe("UnexpectedError")
  })
})

// Web-stage regression test: found by real browser verification of the Phase 3 chat UI (a
// `createNode` agent-tool call's pending node showed up live in `subscribeToNodes` immediately,
// before `mergeChanges` — contradicting `PendingMarker`'s own doc comment and
// `nodes-repository-live.ts`'s already-filtered `.list()`). `NodesSubscription`
// (`nodes-subscription.ts`) tracks the raw `nodes` collection directly rather than going through
// `NodesRepository.list()`, so it never inherited that filter; fixed there, proven here.
describe("subscribeToNodes: pending records stay invisible until mergeChanges (web-stage fix)", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
    agentEditModelClientTestHook.converse = undefined
  })

  it("a pending createNode is not pushed to a live subscriber until the chat's changes are merged", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)

    installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [new ToolCallRequest({ id: "call_1", name: "createNode", input: { title: "Hidden Until Merged", binding: "HIDDEN" } })]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "Created it." })
    ])

    const chat = Schema.decodeUnknownSync(CreateChatOutput)(
      await workspaceStub.createChat(Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Sub test" })))
    ).chat

    using sub = await workspaceStub.subscribeToNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
    const initial = Schema.decodeUnknownSync(NodesChangedEvent)(await sub.next())
    expect(initial.nodes).toHaveLength(0)

    const pending = sub.next()
    const turn = Schema.decodeUnknownSync(SendChatMessageOutput)(
      await workspaceStub.sendChatMessage(
        Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Create a node." }))
      )
    )
    expect(turn.changesSequences).toEqual([0])

    // The pending node's creation does NOT push a change to this subscriber: race `pending`
    // against a short timer sentinel rather than asserting a negative with no bound at all — the
    // timer should win every time, since nothing server-side will ever offer to the queue for a
    // pending-only write.
    const timerSentinel = Symbol("timeout")
    const raceResult = await Promise.race([
      pending,
      new Promise<typeof timerSentinel>((resolve) => setTimeout(() => resolve(timerSentinel), 200))
    ])
    expect(raceResult).toBe(timerSentinel)

    // mergeChanges promotes the node (`nodesRepository.put` with `pending` cleared) — *that* write
    // is what finally resolves the still-pending `sub.next()` call from above.
    await workspaceStub.mergeChanges(
      Schema.encodeSync(MergeChangesInput)(new MergeChangesInput({ chatId: chat.id, mergeThrough: 0 }))
    )
    const pushed = Schema.decodeUnknownSync(NodesChangedEvent)(await pending)
    expect(pushed.nodes.map((n) => n.title)).toEqual(["Hidden Until Merged"])
  })
})

// Adversarial-review fix (finding: "add a test exercising a single agent turn that mixes
// editNoteTool with createNode/addFact/addEdge and verifies both kinds of pending state are
// reviewable"). Every prior test in this suite and chat-fork.test.ts deliberately exercised only
// ONE of the two pending mechanisms at a time (structured `pending`-flag records via
// createNode/addFact/addEdge, or the Automerge chat-fork via editNote) — this is the first test
// proving they coexist correctly within a single turn: `mergeChanges` promoting the structured
// records must NOT touch the still-open note fork, and the note fork's own accept/revert
// (`acceptChatFork`/`revertChatFork`) must work independently, on the same chat, at the same time.
// Also proves the client-discoverability fix in agent-tools.ts's `EditNoteToolOutput.nodeId` —
// the exact mechanism `ChatPanel.tsx`'s `decodeEditNoteNodeId` and the native
// `PendingChangesView` rely on to find which node an `editNote` tool call forked.
describe("AgentEditService: a single turn mixing editNote with createNode/addFact/addEdge — both pending mechanisms reviewable together", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
    agentEditModelClientTestHook.converse = undefined
  })

  it("structured pending records promote via mergeChanges while the note fork stays open, reviewable, and independently acceptable", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)

    const relationDefinition = Schema.decodeUnknownSync(CreateRelationDefinitionOutput)(
      await workspaceStub.createRelationDefinition(
        Schema.encodeSync(CreateRelationDefinitionInput)(
          relationDefinitionInput({ workspaceId, forwardName: "collaboratesWith", inverseName: "isCollaboratedWithBy", requestId: "agent-collaborates-2" })
        )
      )
    ).relationDefinition

    const chat = Schema.decodeUnknownSync(CreateChatOutput)(
      await workspaceStub.createChat(
        Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Mixed-mechanism scenario" }))
      )
    ).chat

    // Turn 1: create the note node this turn's editNote call will target, and give it a real
    // Automerge page — `editNote`/`chatFork.fork()` requires an existing `Page` (PageNotFound
    // otherwise, see notes-service-live.ts's `loadDoc`), and `createNode` alone never creates one.
    installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [new ToolCallRequest({ id: "call_1", name: "createNode", input: { title: "Meeting notes", binding: "NOTE" } })]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "Created the note." })
    ])
    await workspaceStub.sendChatMessage(
      Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Create a note." }))
    )

    const afterTurn1 = Schema.decodeUnknownSync(ListPendingChangesOutput)(
      await workspaceStub.listPendingChanges(
        Schema.encodeSync(ListPendingChangesInput)(new ListPendingChangesInput({ chatId: chat.id }))
      )
    )
    const noteNodeId = afterTurn1.nodes.find((n) => n.title === "Meeting notes")!.id

    await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: noteNodeId })))

    // Turn 2: ONE scripted turn mixing all four tool kinds — createNode, addFact, addEdge, AND
    // editNote — exactly the exit criterion's own wording.
    const scripted = installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [
          new ToolCallRequest({ id: "call_2", name: "createNode", input: { title: "Dave", binding: "DAVE" } }),
          new ToolCallRequest({
            id: "call_3",
            name: "addFact",
            input: { binding: "NOTE", predicateId: "topic", value: "planning" }
          }),
          new ToolCallRequest({
            id: "call_4",
            name: "addEdge",
            input: { relationDefinitionId: relationDefinition.id, sourceBinding: "NOTE", targetBinding: "DAVE" }
          }),
          new ToolCallRequest({
            id: "call_5",
            name: "editNote",
            input: {
              binding: "NOTE", index: 0, deleteCount: 0, insertText: "Agent-added context. ",
              commitMessage: "Add meeting context"
            }
          })
        ]
      }),
      new ModelTurnFinalText({
        kind: "final_text",
        text: "Added Dave, tagged the note's topic, linked them, and drafted a note edit for your review."
      })
    ])

    const turn = Schema.decodeUnknownSync(SendChatMessageOutput)(
      await workspaceStub.sendChatMessage(
        Schema.encodeSync(SendChatMessageInput)(
          new SendChatMessageInput({
            chatId: chat.id,
            text: "Add Dave, tag the note's topic, link them, and add context to the note."
          })
        )
      )
    )
    expect(scripted.remaining()).toBe(0)
    // Three structured-record batches (createNode/addFact/addEdge) — editNote produces none (see
    // agent-tools.ts's EditNoteToolOutput doc comment: it deliberately never touches `refs`, so it
    // never reaches executeToolCall's ChangesMessage-flush branch).
    expect(turn.changesSequences).toEqual([1, 2, 3])

    // --- Kind 1 reviewable: structured pending (NOTE from turn 1, Dave/fact/edge from turn 2).
    const pendingBeforeMerge = Schema.decodeUnknownSync(ListPendingChangesOutput)(
      await workspaceStub.listPendingChanges(
        Schema.encodeSync(ListPendingChangesInput)(new ListPendingChangesInput({ chatId: chat.id }))
      )
    )
    expect(pendingBeforeMerge.nodes.map((n) => n.title).sort()).toEqual(["Dave", "Meeting notes"])
    expect(pendingBeforeMerge.facts).toHaveLength(1)
    expect(pendingBeforeMerge.facts[0]!.predicateId).toBe("topic")
    expect(pendingBeforeMerge.edges).toHaveLength(1)

    // The review RPC is the one coherent read used by both clients: it carries the transcript,
    // server-derived labels, and independent witnesses in one snapshot. Opaque graph ids must
    // never become user-facing copy, even though they remain structural action identities.
    const reviewBeforeMerge = Schema.decodeUnknownSync(GetChatReviewOutput)(
      await workspaceStub.getChatReview(
        Schema.encodeSync(GetChatReviewInput)(new GetChatReviewInput({ chatId: chat.id }))
      )
    )
    expect(reviewBeforeMerge.chat.id).toBe(chat.id)
    expect(reviewBeforeMerge.messages.length).toBeGreaterThan(0)
    expect(reviewBeforeMerge.items.map((item) => item.label)).toEqual([
      'Create “Meeting notes”',
      'Create “Dave”',
      'Set topic on “Meeting notes” to "planning"',
      'Link “Meeting notes” to “Dave”'
    ])
    expect(reviewBeforeMerge.items.some((item) => item.label.includes(noteNodeId))).toBe(false)
    expect(reviewBeforeMerge.witness).toMatch(/^[a-f0-9]{64}$/)
    expect(reviewBeforeMerge.noteForkWitness).toMatch(/^[a-f0-9]{64}$/)
    expect(reviewBeforeMerge.items.every((item) => item.stamped && item.targetAvailable && item.actionable)).toBe(true)
    expect(reviewBeforeMerge.structuredForks.truncated).toBe(false)

    // The reviewed decision recomputes the complete raw pending preimage in the same DO
    // transaction. A stale witness cannot merge or revert even if the caller knows a sequence.
    await expect(workspaceStub.decideChatReview(
      Schema.encodeSync(DecideChatReviewInput)(new DecideChatReviewInput({
        chatId: chat.id, operation: "accept", sequenceBoundary: 3, expectedWitness: "0".repeat(64),
        requestId: "review-stale-witness", message: "Accept reviewed changes", provenance: "user-review"
      }))
    )).rejects.toThrow(/stale/)
    for (const sequenceBoundary of [2, 4]) {
      await expect(workspaceStub.decideChatReview(
        Schema.encodeSync(DecideChatReviewInput)(new DecideChatReviewInput({
          chatId: chat.id, operation: "accept", sequenceBoundary, expectedWitness: reviewBeforeMerge.witness,
          requestId: `review-boundary-${sequenceBoundary}`, message: "Accept reviewed changes", provenance: "user-review"
        }))
      )).rejects.toThrow(/boundary/)
    }
    const reviewedDecision = Schema.decodeUnknownSync(DecideChatReviewOutput)(
      await workspaceStub.decideChatReview(
        Schema.encodeSync(DecideChatReviewInput)(new DecideChatReviewInput({
          chatId: chat.id, operation: "accept", sequenceBoundary: 3, expectedWitness: reviewBeforeMerge.witness,
          requestId: "review-accept-witness", message: "Accept reviewed changes", provenance: "user-review"
        }))
      )
    )
    expect(reviewedDecision.witness).toBe(reviewBeforeMerge.witness)

    const emptyReview = Schema.decodeUnknownSync(GetChatReviewOutput)(
      await workspaceStub.getChatReview(Schema.encodeSync(GetChatReviewInput)(new GetChatReviewInput({ chatId: chat.id })))
    )
    await expect(workspaceStub.decideChatReview(
      Schema.encodeSync(DecideChatReviewInput)(new DecideChatReviewInput({
        chatId: chat.id, operation: "revert", sequenceBoundary: 0, expectedWitness: emptyReview.witness,
        requestId: "review-empty", message: "Revert reviewed changes", provenance: "user-review"
      }))
    )).rejects.toThrow(/no stamped changes/)

    // --- Kind 2 reviewable + discoverable: the tool log's `editNote` entry carries `nodeId`
    // (the adversarial-review fix) equal to the real note node — proving a client CAN discover
    // which node to call chatForkPreview/acceptChatFork/revertChatFork against, from data it
    // already fetches via getChat, with no second binding-resolution RPC.
    const chatLog = Schema.decodeUnknownSync(GetChatOutput)(
      await workspaceStub.getChat(Schema.encodeSync(GetChatInput)(new GetChatInput({ chatId: chat.id })))
    )
    const editNoteLogMessage = chatLog.messages.find((m) => m.role === "tool" && m.content.includes('"call_5"'))
    expect(editNoteLogMessage).toBeDefined()
    const editNoteResult = JSON.parse((editNoteLogMessage as { content: string }).content) as {
      result: string
      isError: boolean
    }
    expect(editNoteResult.isError).toBe(false)
    const editNoteOutput = JSON.parse(editNoteResult.result) as { text: string; nodeId: string }
    expect(editNoteOutput.nodeId).toBe(noteNodeId)
    expect(editNoteOutput.text).toBe("Agent-added context. ")

    // --- Kind 2 reviewable via the real chat-fork RPC surface: forked, correct preview text.
    const previewBeforeMerge = Schema.decodeUnknownSync(ChatForkPreviewOutput)(
      await workspaceStub.chatForkPreview(
        Schema.encodeSync(ChatForkPreviewInput)(new ChatForkPreviewInput({ workspaceId, chatId: chat.id, nodeId: noteNodeId }))
      )
    )
    expect(previewBeforeMerge).toEqual(new ChatForkPreviewOutput({ forked: true, text: "Agent-added context. " }))

    // --- Independence, direction 1: mergeChanges (kind 1's accept) promotes every structured
    // record — including the NOTE node itself, whose title is unrelated to its still-open note
    // fork — WITHOUT touching the fork at all.
    await workspaceStub.mergeChanges(
      Schema.encodeSync(MergeChangesInput)(new MergeChangesInput({ chatId: chat.id, mergeThrough: 3 }))
    )
    const pendingAfterMerge = Schema.decodeUnknownSync(ListPendingChangesOutput)(
      await workspaceStub.listPendingChanges(
        Schema.encodeSync(ListPendingChangesInput)(new ListPendingChangesInput({ chatId: chat.id }))
      )
    )
    expect(pendingAfterMerge).toEqual(new ListPendingChangesOutput({ nodes: [], facts: [], edges: [] }))

    const previewAfterMerge = Schema.decodeUnknownSync(ChatForkPreviewOutput)(
      await workspaceStub.chatForkPreview(
        Schema.encodeSync(ChatForkPreviewInput)(new ChatForkPreviewInput({ workspaceId, chatId: chat.id, nodeId: noteNodeId }))
      )
    )
    expect(previewAfterMerge).toEqual(new ChatForkPreviewOutput({ forked: true, text: "Agent-added context. " }))

    // --- Independence, direction 2: kind 2's own accept (acceptChatFork) now lands the note edit
    // onto real mainline, independently of the mergeChanges call above.
    const accepted = Schema.decodeUnknownSync(AcceptChatForkOutput)(
      await workspaceStub.acceptChatFork(
        Schema.encodeSync(AcceptChatForkInput)(new AcceptChatForkInput({ workspaceId, chatId: chat.id, nodeId: noteNodeId }))
      )
    )
    expect(accepted.text).toBe("Agent-added context. ")

    const mainlineText = Schema.decodeUnknownSync(GetPageTextOutput)(
      await workspaceStub.getPageText(Schema.encodeSync(GetPageTextInput)(new GetPageTextInput({ workspaceId, nodeId: noteNodeId })))
    ).text
    expect(mainlineText).toBe("Agent-added context. ")

    const previewAfterAccept = Schema.decodeUnknownSync(ChatForkPreviewOutput)(
      await workspaceStub.chatForkPreview(
        Schema.encodeSync(ChatForkPreviewInput)(new ChatForkPreviewInput({ workspaceId, chatId: chat.id, nodeId: noteNodeId }))
      )
    )
    expect(previewAfterAccept).toEqual(new ChatForkPreviewOutput({ forked: false, text: "" }))
  })
})

describe("AgentEditService: Loro note edits use the semantic ledger", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined

  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
    agentEditModelClientTestHook.converse = undefined
  })

  it("commits a Loro edit with chat provenance, no chat fork, and an idempotent retry", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const chat = Schema.decodeUnknownSync(CreateChatOutput)(
      await workspaceStub.createChat(
        Schema.encodeSync(CreateChatInput)(new CreateChatInput({ workspaceId, title: "Loro agent edit" }))
      )
    ).chat

    // The agent's binding map is intentionally chat-local. Create the target through the real
    // agent tool first, then promote its page into the canonical Loro format before the edit turn.
    installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [new ToolCallRequest({ id: "agent-create-note", name: "createNode", input: { title: "Loro note", binding: "NOTE" } })]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "Created the note." })
    ])
    await workspaceStub.sendChatMessage(
      Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Create a note for me." }))
    )
    const pending = Schema.decodeUnknownSync(ListPendingChangesOutput)(
      await workspaceStub.listPendingChanges(
        Schema.encodeSync(ListPendingChangesInput)(new ListPendingChangesInput({ chatId: chat.id }))
      )
    )
    const note = pending.nodes.find((node) => node.title === "Loro note")
    expect(note).toBeDefined()
    const noteNodeId = note!.id

    const created = Schema.decodeUnknownSync(CreateLoroPageOutput)(
      await workspaceStub.createLoroPage(
        Schema.encodeSync(CreateLoroPageInput)(new CreateLoroPageInput({
          workspaceId,
          nodeId: noteNodeId,
          creationIntent: new CreationIntent({
            requestId: "agent-loro-page",
            commitMessage: "Create the Loro note page",
            attribution: new HumanUiMutationAttribution({
              version: "athenaeum.mutation-attribution.v1",
              kind: "humanUi",
              surface: "rich-text-editor"
            })
          })
        }))
      )
    )
    expect(created.descriptor.activeFormat).toBe("loro-v1")

    const editScript = () => installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [new ToolCallRequest({
          id: "agent-edit-note",
          name: "editNote",
          input: {
            binding: "NOTE",
            index: 0,
            deleteCount: 0,
            insertText: "Enriched by the Loro employee. ",
            commitMessage: "Enrich the meeting note from the agent job"
          }
        })]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "Enriched the Loro note." })
    ])

    const firstScript = editScript()
    const firstTurn = Schema.decodeUnknownSync(SendChatMessageOutput)(
      await workspaceStub.sendChatMessage(
        Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Enrich this note." }))
      )
    )
    expect(firstScript.remaining()).toBe(0)
    expect(firstTurn.changesSequences).toEqual([])

    const sync = Schema.decodeUnknownSync(StartLoroPageSyncOutput)(
      await workspaceStub.startLoroPageSync(
        Schema.encodeSync(StartLoroPageSyncInput)(new StartLoroPageSyncInput({
          workspaceId,
          nodeId: noteNodeId,
          sessionId: "agent-loro-read"
        }))
      )
    )
    expect(readLoroText(sync.message)).toBe("Enriched by the Loro employee. ")

    const preview = Schema.decodeUnknownSync(ChatForkPreviewOutput)(
      await workspaceStub.chatForkPreview(
        Schema.encodeSync(ChatForkPreviewInput)(new ChatForkPreviewInput({
          workspaceId,
          chatId: chat.id,
          nodeId: noteNodeId
        }))
      )
    )
    expect(preview).toEqual(new ChatForkPreviewOutput({ forked: false, text: "" }))

    const requestIdentity = `agent-edit:${chat.id}:agent-edit-note`
    const native = workspaceDurableObjectStub(workspaceId)
    const command = Schema.decodeUnknownSync(LedgerCommand)(await native.debugGetLedgerCommand(requestIdentity))
    expect(command).toMatchObject({
      type: "commitLoroPageContent",
      principal: expect.stringContaining("@example.com"),
      capability: "build",
      payload: {
        nodeId: noteNodeId,
        commitMessage: "Enrich the meeting note from the agent job",
        attribution: {
          kind: "humanUi",
          surface: "agent-chat"
        }
      }
    })
    expect(await native.debugGetLedgerCustody(requestIdentity)).toMatchObject({
      type: "commitLoroPageContent",
      workspaceId,
      actorKind: "user",
      actorLabel: "You",
      chatId: chat.id,
      toolCallId: "agent-edit-note",
      targetKind: "node",
      targetId: noteNodeId
    })
    const artifactsBeforeRetry = await native.debugGetLedgerArtifactCounts()
    const artifacts = JSON.stringify({
      command,
      receipt: await native.debugGetLedgerReceipt(requestIdentity),
      event: await native.debugGetLedgerEvent(requestIdentity),
      outbox: await native.debugGetLedgerOutboxIntent(requestIdentity)
    })
    expect(artifacts).not.toContain("Enriched by the Loro employee.")

    const retryScript = editScript()
    await workspaceStub.sendChatMessage(
      Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({ chatId: chat.id, text: "Retry the enrichment." }))
    )
    expect(retryScript.remaining()).toBe(0)
    expect(await native.debugGetLedgerArtifactCounts()).toEqual(artifactsBeforeRetry)

    const retriedSync = Schema.decodeUnknownSync(StartLoroPageSyncOutput)(
      await workspaceStub.startLoroPageSync(
        Schema.encodeSync(StartLoroPageSyncInput)(new StartLoroPageSyncInput({
          workspaceId,
          nodeId: noteNodeId,
          sessionId: "agent-loro-read-retry"
        }))
      )
    )
    expect(readLoroText(retriedSync.message)).toBe("Enriched by the Loro employee. ")
  })

  it("replays identical agent insertions and deletions without rebuilding a stale splice", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const { chat, nodeIdByBinding } = await createChatWithBoundNotes({
      workspaceStub,
      workspaceId,
      notes: [{ title: "Agent replay note", binding: "NOTE" }]
    })
    const nodeId = nodeIdByBinding.get("NOTE")
    if (nodeId === undefined) throw new Error("missing replay note")
    await workspaceStub.createLoroPage(
      Schema.encodeSync(CreateLoroPageInput)(new CreateLoroPageInput({
        workspaceId,
        nodeId,
        creationIntent: new CreationIntent({
          requestId: "agent-replay-page",
          commitMessage: "Create the agent replay note.",
          attribution: new HumanUiMutationAttribution({
            version: "athenaeum.mutation-attribution.v1",
            kind: "humanUi",
            surface: "rich-text-editor"
          })
        })
      }))
    )

    const firstInsert = await runAgentEditNote({
      workspaceStub, chatId: chat.id, binding: "NOTE", toolCallId: "agent-replay-insert",
      index: 0, deleteCount: 0, insertText: "abcdef", commitMessage: "Seed replay text."
    })
    expect(firstInsert.text).toBe("abcdef")
    const retryInsert = await runAgentEditNote({
      workspaceStub, chatId: chat.id, binding: "NOTE", toolCallId: "agent-replay-insert",
      index: 0, deleteCount: 0, insertText: "abcdef", commitMessage: "Seed replay text."
    })
    expect(retryInsert.text).toBe("abcdef")

    const firstDelete = await runAgentEditNote({
      workspaceStub, chatId: chat.id, binding: "NOTE", toolCallId: "agent-replay-delete",
      index: 0, deleteCount: 3, insertText: "", commitMessage: "Remove the replay prefix."
    })
    expect(firstDelete.text).toBe("def")
    const retryDelete = await runAgentEditNote({
      workspaceStub, chatId: chat.id, binding: "NOTE", toolCallId: "agent-replay-delete",
      index: 0, deleteCount: 3, insertText: "", commitMessage: "Remove the replay prefix."
    })
    expect(retryDelete.text).toBe("def")
    const durable = await runAgentReadNote({
      workspaceStub, chatId: chat.id, binding: "NOTE", toolCallId: "agent-replay-read"
    })
    expect(durable.text).toBe("def")
  })
})

describe("AgentEditService: readNote follows the active page format", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined

  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
    agentEditModelClientTestHook.converse = undefined
  })

  it("reads a native Loro note before and after an agent edit without mutating page, ledger, proposal, sync, or ChangesMessage state", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const { chat, nodeIdByBinding } = await createChatWithBoundNotes({
      workspaceStub,
      workspaceId,
      notes: [{ title: "Native Loro note", binding: "NATIVE" }]
    })
    const nodeId = nodeIdByBinding.get("NATIVE")
    if (nodeId === undefined) throw new Error("missing native Loro note")

    const created = Schema.decodeUnknownSync(CreateLoroPageOutput)(
      await workspaceStub.createLoroPage(
        Schema.encodeSync(CreateLoroPageInput)(new CreateLoroPageInput({
          workspaceId,
          nodeId,
          creationIntent: new CreationIntent({
            requestId: "agent-read-native-loro-page",
            commitMessage: "Create the native Loro agent read fixture.",
            attribution: new HumanUiMutationAttribution({
              version: "athenaeum.mutation-attribution.v1",
              kind: "humanUi",
              surface: "rich-text-editor"
            })
          })
        }))
      )
    )
    expect(created.descriptor.activeFormat).toBe("loro-v1")

    const native = workspaceDurableObjectStub(workspaceId)
    const descriptorBeforeFirstRead = await readPageDescriptor(workspaceStub, workspaceId, nodeId)
    const artifactsBeforeFirstRead = await native.debugGetLedgerArtifactCounts()
    const feedBeforeFirstRead = await readSyncFeed(workspaceStub, workspaceId)
    const changesBeforeFirstRead = await readChatChanges(workspaceStub, chat.id)

    const firstRead = await runAgentReadNote({
      workspaceStub,
      chatId: chat.id,
      binding: "NATIVE",
      toolCallId: "read-native-before-edit"
    })
    expect(firstRead.text).toBe("")
    expect(firstRead.turn.changesSequences).toEqual([])
    expect(await readPageDescriptor(workspaceStub, workspaceId, nodeId)).toEqual(descriptorBeforeFirstRead)
    expect(await native.debugGetLedgerArtifactCounts()).toEqual(artifactsBeforeFirstRead)
    expect(await readSyncFeed(workspaceStub, workspaceId)).toEqual(feedBeforeFirstRead)
    expect(await readChatChanges(workspaceStub, chat.id)).toEqual(changesBeforeFirstRead)
    expect(Schema.decodeUnknownSync(ChatForkPreviewOutput)(
      await workspaceStub.chatForkPreview(
        Schema.encodeSync(ChatForkPreviewInput)(new ChatForkPreviewInput({ workspaceId, chatId: chat.id, nodeId }))
      )
    )).toEqual(new ChatForkPreviewOutput({ forked: false, text: "" }))

    const editScript = installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [new ToolCallRequest({
          id: "edit-native-loro",
          name: "editNote",
          input: {
            binding: "NATIVE",
            index: 0,
            deleteCount: 0,
            insertText: "Loro agent text.",
            commitMessage: "Add the native Loro agent fixture text."
          }
        })]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "Updated the Loro note." })
    ])
    const editTurn = Schema.decodeUnknownSync(SendChatMessageOutput)(
      await workspaceStub.sendChatMessage(
        Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({
          chatId: chat.id,
          text: "Add the Loro fixture text."
        }))
      )
    )
    expect(editScript.remaining()).toBe(0)
    expect(editTurn.changesSequences).toEqual([])
    expect(Schema.decodeUnknownSync(ChatForkPreviewOutput)(
      await workspaceStub.chatForkPreview(
        Schema.encodeSync(ChatForkPreviewInput)(new ChatForkPreviewInput({ workspaceId, chatId: chat.id, nodeId }))
      )
    )).toEqual(new ChatForkPreviewOutput({ forked: false, text: "" }))

    const descriptorBeforeSecondRead = await readPageDescriptor(workspaceStub, workspaceId, nodeId)
    const artifactsBeforeSecondRead = await native.debugGetLedgerArtifactCounts()
    const feedBeforeSecondRead = await readSyncFeed(workspaceStub, workspaceId)
    const changesBeforeSecondRead = await readChatChanges(workspaceStub, chat.id)

    const secondRead = await runAgentReadNote({
      workspaceStub,
      chatId: chat.id,
      binding: "NATIVE",
      toolCallId: "read-native-after-edit"
    })
    expect(secondRead.text).toBe("Loro agent text.")
    expect(secondRead.turn.changesSequences).toEqual([])
    expect(await readPageDescriptor(workspaceStub, workspaceId, nodeId)).toEqual(descriptorBeforeSecondRead)
    expect(await native.debugGetLedgerArtifactCounts()).toEqual(artifactsBeforeSecondRead)
    expect(await readSyncFeed(workspaceStub, workspaceId)).toEqual(feedBeforeSecondRead)
    expect(await readChatChanges(workspaceStub, chat.id)).toEqual(changesBeforeSecondRead)
  })

  it("reads a migrated Loro note by activeFormat even when its immutable Automerge witness remains", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const { chat, nodeIdByBinding } = await createChatWithBoundNotes({
      workspaceStub,
      workspaceId,
      notes: [{ title: "Migrated Loro note", binding: "MIGRATED" }]
    })
    const nodeId = nodeIdByBinding.get("MIGRATED")
    if (nodeId === undefined) throw new Error("missing migrated Loro note")

    await workspaceStub.createPage(
      Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId }))
    )
    await workspaceStub.applyPageEdit(
      Schema.encodeSync(ApplyPageEditInput)(new ApplyPageEditInput({
        workspaceId,
        nodeId,
        index: 0,
        deleteCount: 0,
        insertText: "Migrated Loro text."
      }))
    )
    const { legacy, migrated } = await migrateLegacyPage({
      workspaceStub,
      workspaceId,
      nodeId,
      requestId: "agent-read-migrate-fixture"
    })
    expect(legacy.activeFormat).toBe("automerge-v1")
    expect(migrated.descriptor).toMatchObject({
      activeFormat: "loro-v1",
      automerge: legacy.automerge
    })

    const native = workspaceDurableObjectStub(workspaceId)
    const descriptorBeforeRead = await readPageDescriptor(workspaceStub, workspaceId, nodeId)
    expect(descriptorBeforeRead.activeFormat).toBe("loro-v1")
    expect(descriptorBeforeRead.automerge).toEqual(legacy.automerge)
    const artifactsBeforeRead = await native.debugGetLedgerArtifactCounts()
    const feedBeforeRead = await readSyncFeed(workspaceStub, workspaceId)
    const changesBeforeRead = await readChatChanges(workspaceStub, chat.id)

    const read = await runAgentReadNote({
      workspaceStub,
      chatId: chat.id,
      binding: "MIGRATED",
      toolCallId: "read-migrated-loro"
    })
    expect(read.text).toBe("Migrated Loro text.")
    expect(read.turn.changesSequences).toEqual([])
    expect(await readPageDescriptor(workspaceStub, workspaceId, nodeId)).toEqual(descriptorBeforeRead)
    expect(await native.debugGetLedgerArtifactCounts()).toEqual(artifactsBeforeRead)
    expect(await readSyncFeed(workspaceStub, workspaceId)).toEqual(feedBeforeRead)
    expect(await readChatChanges(workspaceStub, chat.id)).toEqual(changesBeforeRead)
    expect(Schema.decodeUnknownSync(ChatForkPreviewOutput)(
      await workspaceStub.chatForkPreview(
        Schema.encodeSync(ChatForkPreviewInput)(new ChatForkPreviewInput({ workspaceId, chatId: chat.id, nodeId }))
      )
    )).toEqual(new ChatForkPreviewOutput({ forked: false, text: "" }))
  })

  it("surfaces a typed Loro validation error without falling back to Automerge", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const { chat, nodeIdByBinding } = await createChatWithBoundNotes({
      workspaceStub,
      workspaceId,
      notes: [{ title: "Corrupt Loro note", binding: "CORRUPT" }]
    })
    const nodeId = nodeIdByBinding.get("CORRUPT")
    if (nodeId === undefined) throw new Error("missing corrupt Loro note")

    await workspaceStub.createLoroPage(
      Schema.encodeSync(CreateLoroPageInput)(new CreateLoroPageInput({
        workspaceId,
        nodeId,
        creationIntent: new CreationIntent({
          requestId: "agent-read-invalid-loro-page",
          commitMessage: "Create the invalid Loro agent read fixture.",
          attribution: new HumanUiMutationAttribution({
            version: "athenaeum.mutation-attribution.v1",
            kind: "humanUi",
            surface: "rich-text-editor"
          })
        })
      }))
    )

    const native = workspaceDurableObjectStub(workspaceId)
    await native.debugReplaceLoroPageSnapshot(nodeId, invalidLoroPageSnapshot())
    const artifactsBeforeRead = await native.debugGetLedgerArtifactCounts()
    const feedBeforeRead = await readSyncFeed(workspaceStub, workspaceId)
    const changesBeforeRead = await readChatChanges(workspaceStub, chat.id)

    const scripted = installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [new ToolCallRequest({
          id: "read-invalid-loro",
          name: "readNote",
          input: { binding: "CORRUPT" }
        })]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "The read failed validation." })
    ])
    const turn = Schema.decodeUnknownSync(SendChatMessageOutput)(
      await workspaceStub.sendChatMessage(
        Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({
          chatId: chat.id,
          text: "Read the corrupt note."
        }))
      )
    )
    expect(scripted.remaining()).toBe(0)
    const toolMessage = turn.messages.find((message) => message.role === "tool")
    expect(toolMessage).toBeDefined()
    const result = JSON.parse(toolMessage!.content) as { readonly result: string; readonly isError: boolean }
    expect(result.isError).toBe(true)
    expect(result.result).toContain("Loro ProseMirror v1 root must contain at least one block")
    expect(await native.debugGetLedgerArtifactCounts()).toEqual(artifactsBeforeRead)
    expect(await readSyncFeed(workspaceStub, workspaceId)).toEqual(feedBeforeRead)
    expect(await readChatChanges(workspaceStub, chat.id)).toEqual(changesBeforeRead)
    expect(Schema.decodeUnknownSync(ChatForkPreviewOutput)(
      await workspaceStub.chatForkPreview(
        Schema.encodeSync(ChatForkPreviewInput)(new ChatForkPreviewInput({ workspaceId, chatId: chat.id, nodeId }))
      )
    )).toEqual(new ChatForkPreviewOutput({ forked: false, text: "" }))
  })

  it("keeps explicit legacy fallback and pending-chat-fork reads intact", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspaceAsTestUser(workspaceId)
    const { chat, nodeIdByBinding } = await createChatWithBoundNotes({
      workspaceStub,
      workspaceId,
      notes: [{ title: "Legacy Automerge note", binding: "LEGACY" }]
    })
    const nodeId = nodeIdByBinding.get("LEGACY")
    if (nodeId === undefined) throw new Error("missing legacy Automerge note")

    await workspaceStub.createPage(
      Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId }))
    )
    await workspaceStub.applyPageEdit(
      Schema.encodeSync(ApplyPageEditInput)(new ApplyPageEditInput({
        workspaceId,
        nodeId,
        index: 0,
        deleteCount: 0,
        insertText: "Legacy mainline text."
      }))
    )
    expect((await readPageDescriptor(workspaceStub, workspaceId, nodeId)).activeFormat).toBe("automerge-v1")

    const mainlineRead = await runAgentReadNote({
      workspaceStub,
      chatId: chat.id,
      binding: "LEGACY",
      toolCallId: "read-legacy-mainline"
    })
    expect(mainlineRead.text).toBe("Legacy mainline text.")
    expect(mainlineRead.turn.changesSequences).toEqual([])

    const forkScript = installScriptedModel([
      new ModelTurnToolCalls({
        kind: "tool_calls",
        calls: [new ToolCallRequest({
          id: "edit-legacy-pending-fork",
          name: "editNote",
          input: {
            binding: "LEGACY",
            index: 0,
            deleteCount: 0,
            insertText: "Draft: ",
            commitMessage: "Prepare the legacy review draft."
          }
        })]
      }),
      new ModelTurnFinalText({ kind: "final_text", text: "Prepared a legacy draft." })
    ])
    const forkTurn = Schema.decodeUnknownSync(SendChatMessageOutput)(
      await workspaceStub.sendChatMessage(
        Schema.encodeSync(SendChatMessageInput)(new SendChatMessageInput({
          chatId: chat.id,
          text: "Prepare a review draft."
        }))
      )
    )
    expect(forkScript.remaining()).toBe(0)
    expect(forkTurn.changesSequences).toEqual([])
    const pendingFork = Schema.decodeUnknownSync(ChatForkPreviewOutput)(
      await workspaceStub.chatForkPreview(
        Schema.encodeSync(ChatForkPreviewInput)(new ChatForkPreviewInput({ workspaceId, chatId: chat.id, nodeId }))
      )
    )
    expect(pendingFork).toEqual(new ChatForkPreviewOutput({
      forked: true,
      text: "Draft: Legacy mainline text."
    }))

    const pendingRead = await runAgentReadNote({
      workspaceStub,
      chatId: chat.id,
      binding: "LEGACY",
      toolCallId: "read-legacy-pending-fork"
    })
    expect(pendingRead.text).toBe("Draft: Legacy mainline text.")
    expect(pendingRead.turn.changesSequences).toEqual([])
    expect(Schema.decodeUnknownSync(ChatForkPreviewOutput)(
      await workspaceStub.chatForkPreview(
        Schema.encodeSync(ChatForkPreviewInput)(new ChatForkPreviewInput({ workspaceId, chatId: chat.id, nodeId }))
      )
    )).toEqual(pendingFork)
  })
})
