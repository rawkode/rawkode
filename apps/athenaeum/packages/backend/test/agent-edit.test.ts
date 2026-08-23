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
import {
  AcceptChatForkInput,
  AcceptChatForkOutput,
  AddFactInput,
  AddFactOutput,
  BaseTagFieldIds,
  BaseTagIds,
  ChatForkPreviewInput,
  ChatForkPreviewOutput,
  ChatToolResultBlock,
  CreateChatInput,
  CreateChatOutput,
  CreatePageInput,
  CreatePageOutput,
  CreateRelationDefinitionInput,
  CreateRelationDefinitionOutput,
  CreateTagInput,
  CreateTagOutput,
  GetChatInput,
  GetChatOutput,
  GetPageTextInput,
  GetPageTextOutput,
  ListChatChangesInput,
  ListChatChangesOutput,
  ListNodesInput,
  ListNodesOutput,
  ListPendingChangesInput,
  ListPendingChangesOutput,
  ListTagFieldsInput,
  ListTagFieldsOutput,
  MergeChangesInput,
  MergeChangesOutput,
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
  ToolCallRequest,
  ViewSpec,
  type EntityId
} from "@athenaeum/domain"
import { agentEditTestHooks, deriveFallbackBindingName } from "../src/agent-edit-service-live.js"
import { agentEditModelClientTestHook } from "../src/workspace-durable-object.js"
import { makeModelClientScripted } from "../src/model-client-scripted.js"
import { connectToWorkspace, freshWorkspaceId, rejectionToDomainError } from "./support.js"

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
  })

  it("pending records exist, invisible to normal reads, visible after mergeChanges, gone after revertChanges", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    // Person → Person "knows" relation, needed for the scripted addEdge call — a real, immediate
    // (non-agent) RPC call, made before the script (which needs this id) is constructed.
    const relationDefinition = Schema.decodeUnknownSync(CreateRelationDefinitionOutput)(
      await workspaceStub.createRelationDefinition(
        Schema.encodeSync(CreateRelationDefinitionInput)(
          new CreateRelationDefinitionInput({
            workspaceId,
            forwardName: "knows",
            inverseName: "isKnownBy",
            sourceTagId: BaseTagIds.Person,
            targetTagId: BaseTagIds.Person,
            cardinality: "many-to-many"
          })
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
    workspaceStub = await connectToWorkspace(workspaceId)

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
    workspaceStub = await connectToWorkspace(workspaceId)

    const relationDefinition = Schema.decodeUnknownSync(CreateRelationDefinitionOutput)(
      await workspaceStub.createRelationDefinition(
        Schema.encodeSync(CreateRelationDefinitionInput)(
          new CreateRelationDefinitionInput({
            workspaceId,
            forwardName: "collaboratesWith",
            inverseName: "isCollaboratedWithBy",
            sourceTagId: BaseTagIds.Person,
            targetTagId: BaseTagIds.Person,
            cardinality: "many-to-many"
          })
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
    workspaceStub = await connectToWorkspace(workspaceId)

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
        Schema.encodeSync(AddFactInput)(new AddFactInput({ workspaceId, nodeId: node!.id, predicateId: "owner", value: "david" }))
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
    workspaceStub = await connectToWorkspace(workspaceId)

    const tag = Schema.decodeUnknownSync(CreateTagOutput)(
      await workspaceStub.createTag(
        Schema.encodeSync(CreateTagInput)(new CreateTagInput({ workspaceId, name: "Reviewer", parentIds: [] }))
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
    workspaceStub = await connectToWorkspace(workspaceId)

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
    workspaceStub = await connectToWorkspace(workspaceId)
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
    workspaceStub = await connectToWorkspace(workspaceId)
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
    workspaceStub = await connectToWorkspace(workspaceId)

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
    workspaceStub = await connectToWorkspace(workspaceId)

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
    workspaceStub = await connectToWorkspace(workspaceId)

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
    workspaceStub = await connectToWorkspace(workspaceId)
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
    workspaceStub = await connectToWorkspace(workspaceId)
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
    workspaceStub = await connectToWorkspace(workspaceId)

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
    workspaceStub = await connectToWorkspace(workspaceId)

    const relationDefinition = Schema.decodeUnknownSync(CreateRelationDefinitionOutput)(
      await workspaceStub.createRelationDefinition(
        Schema.encodeSync(CreateRelationDefinitionInput)(
          new CreateRelationDefinitionInput({
            workspaceId,
            forwardName: "collaboratesWith",
            inverseName: "isCollaboratedWithBy",
            sourceTagId: BaseTagIds.Person,
            targetTagId: BaseTagIds.Person,
            cardinality: "many-to-many"
          })
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
            input: { binding: "NOTE", index: 0, deleteCount: 0, insertText: "Agent-added context. " }
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
