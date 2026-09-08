// Views+Search stage verification (task's "Confirm via real tests/smoke-testing" list):
//   - "at least a 'list all nodes tagged X' view (table view)... return correct results"
//   - "and a 'board grouped by a fact value'... return correct results"
//   - "a ViewSpec attempting to reference a disallowed table/column is rejected"
//   - "search returns correct results for a known substring/term across at least two nodes"
//
// All against a real `WorkspaceDurableObject` over a real Cap'n Web WebSocket session (same harness
// as `graph-service.test.ts`/`notes-service.test.ts`), seeding real data through the real
// mutation RPCs (`createNode`/`createTag`/`assignTag`/`addFact`/`createPage`/`applyPageEdit`)
// rather than writing into `read-model.ts`'s tables directly — this is an end-to-end check that
// the read-model stays in sync with the canonical writes, not just that the compiler/executor
// work in isolation.

import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  AddFactInput,
  AddFactOutput,
  AssignTagInput,
  AssignTagOutput,
  BaseTagIds,
  CreateNodeInput,
  CreateNodeOutput,
  CreatePageInput,
  CreatePageOutput,
  ApplyPageEditInput,
  ApplyPageEditOutput,
  CreateTagInput,
  CreateTagOutput,
  HumanUiMutationAttribution,
  RunViewInput,
  RunViewOutput,
  SearchNodesInput,
  SearchNodesOutput,
  ViewSpec,
  type EntityId
} from "@athenaeum/domain"
import { connectToWorkspace, connectToWorkspaceWithSocketAs, devSignIn, freshWorkspaceId, rejectionToDomainError } from "./support.js"

const webFieldAttribution = () => new HumanUiMutationAttribution({
  version: "athenaeum.mutation-attribution.v1",
  kind: "humanUi",
  surface: "web-supertag-field-editor"
})

const tagAttribution = () => new HumanUiMutationAttribution({
  version: "athenaeum.mutation-attribution.v1",
  kind: "humanUi",
  surface: "web-supertags-manager"
})

const assignInput = (workspaceId: EntityId, nodeId: EntityId, tagId: EntityId, requestId: string) => new AssignTagInput({
  workspaceId,
  nodeId,
  tagId,
  requestId,
  commitMessage: "Assign the Supertag for this view test.",
  attribution: new HumanUiMutationAttribution({
    version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-graph-view"
  })
})

describe("runView: graph_tags/graph_tag_closure see the seeded Base Tags too", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("a fresh workspace's graph_tags view already lists all 8 Base Tags (seeded outside GraphService.createTag)", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const spec = new ViewSpec({ view: "table", visibleColumns: ["id", "name", "builtin"], rowLimit: 50 })
    const output = Schema.decodeUnknownSync(RunViewOutput)(
      await workspaceStub.runView(
        Schema.encodeSync(RunViewInput)(new RunViewInput({ workspaceId, viewName: "graph_tags", viewSpec: spec }))
      )
    )

    const ids = output.rows.map((row) => (row as { id: string }).id).sort()
    expect(ids).toEqual(Object.values(BaseTagIds).sort())
    expect(output.rows.every((row) => (row as { builtin: number | boolean }).builtin === 1 || (row as { builtin: number | boolean }).builtin === true)).toBe(true)
  })

  it("hasTag against a Base Tag works via the read-model (not just the KV-backed listTagClosure RPC)", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`views-base-tag-${crypto.randomUUID()}@example.com`)
    workspaceStub = (await connectToWorkspaceWithSocketAs(workspaceId, credential)).stub

    const person = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Ada Lovelace" })))
    ).node
    Schema.decodeUnknownSync(AssignTagOutput)(
      await workspaceStub.assignTag(
        Schema.encodeSync(AssignTagInput)(assignInput(workspaceId, person.id, BaseTagIds.Person, `views-assign-person-${crypto.randomUUID()}`))
      )
    )

    const spec = new ViewSpec({
      filter: { op: "hasTag", tagId: BaseTagIds.Person },
      view: "table",
      visibleColumns: ["id", "title"],
      rowLimit: 50
    })
    const output = Schema.decodeUnknownSync(RunViewOutput)(
      await workspaceStub.runView(
        Schema.encodeSync(RunViewInput)(new RunViewInput({ workspaceId, viewName: "graph_nodes", viewSpec: spec }))
      )
    )

    expect(output.rows.some((row) => (row as { id: string }).id === person.id)).toBe(true)
  })
})

describe("runView: graph_nodes filtered by hasTag (table view)", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("returns exactly the nodes assigned the queried tag, and none of the untagged ones", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`views-tag-${crypto.randomUUID()}@example.com`)
    workspaceStub = (await connectToWorkspaceWithSocketAs(workspaceId, credential)).stub

    const tag = Schema.decodeUnknownSync(CreateTagOutput)(
      await workspaceStub.createTag(
        Schema.encodeSync(CreateTagInput)(new CreateTagInput({
          workspaceId,
          name: "Reviewer",
          parentIds: [],
          requestId: `views-create-tag-${crypto.randomUUID()}`,
          commitMessage: "Define the Reviewer Supertag for the view test.",
          attribution: tagAttribution()
        }))
      )
    ).tag

    const nodeA = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Tagged A" })))
    ).node
    const nodeB = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Tagged B" })))
    ).node
    const nodeC = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Untagged C" })))
    ).node

    Schema.decodeUnknownSync(AssignTagOutput)(
      await workspaceStub.assignTag(
        Schema.encodeSync(AssignTagInput)(assignInput(workspaceId, nodeA.id, tag.id, `views-assign-a-${crypto.randomUUID()}`))
      )
    )
    Schema.decodeUnknownSync(AssignTagOutput)(
      await workspaceStub.assignTag(
        Schema.encodeSync(AssignTagInput)(assignInput(workspaceId, nodeB.id, tag.id, `views-assign-b-${crypto.randomUUID()}`))
      )
    )
    // nodeC is deliberately left untagged.

    const spec = new ViewSpec({
      filter: { op: "hasTag", tagId: tag.id },
      view: "table",
      visibleColumns: ["id", "title"],
      rowLimit: 50
    })
    const output = Schema.decodeUnknownSync(RunViewOutput)(
      await workspaceStub.runView(
        Schema.encodeSync(RunViewInput)(new RunViewInput({ workspaceId, viewName: "graph_nodes", viewSpec: spec }))
      )
    )

    const titles = output.rows.map((row) => (row as { title: string }).title).sort()
    expect(titles).toEqual(["Tagged A", "Tagged B"])
    expect(output.rows.some((row) => (row as { id: string }).id === nodeC.id)).toBe(false)
  })
})

describe("runView: graph_nodes grouped by a fact value (board view)", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("annotates every row with its 'status' fact value, correctly per node", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`views-add-fact-${crypto.randomUUID()}@example.com`)
    workspaceStub = (await connectToWorkspaceWithSocketAs(workspaceId, credential)).stub

    const todo = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Write plan" })))
    ).node
    const doing = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Build backend" })))
    ).node
    const noStatus = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Unsorted idea" })))
    ).node

    Schema.decodeUnknownSync(AddFactOutput)(
      await workspaceStub.addFact(
        Schema.encodeSync(AddFactInput)(new AddFactInput({ workspaceId, nodeId: todo.id, predicateId: "status", value: "todo", requestId: "views-todo", commitMessage: "Set status.", attribution: webFieldAttribution() }))
      )
    )
    Schema.decodeUnknownSync(AddFactOutput)(
      await workspaceStub.addFact(
        Schema.encodeSync(AddFactInput)(
          new AddFactInput({ workspaceId, nodeId: doing.id, predicateId: "status", value: "doing", requestId: "views-doing", commitMessage: "Set status.", attribution: webFieldAttribution() })
        )
      )
    )
    // noStatus deliberately gets no "status" fact — its groupValue should come back null.

    const spec = new ViewSpec({
      view: "board",
      groupBy: "status",
      visibleColumns: ["id", "title"],
      rowLimit: 50
    })
    const output = Schema.decodeUnknownSync(RunViewOutput)(
      await workspaceStub.runView(
        Schema.encodeSync(RunViewInput)(new RunViewInput({ workspaceId, viewName: "graph_nodes", viewSpec: spec }))
      )
    )

    const byId = new Map(output.rows.map((row) => [(row as { id: string }).id, row as { groupValue: unknown }]))
    // Fact values are read-model-encoded as JSON text (read-model.ts's upsertFact/jsonParam
    // convention), so a JSON string value round-trips as its JSON-quoted form.
    expect(byId.get(todo.id)?.groupValue).toBe(JSON.stringify("todo"))
    expect(byId.get(doing.id)?.groupValue).toBe(JSON.stringify("doing"))
    expect(byId.get(noStatus.id)?.groupValue ?? null).toBeNull()
  })
})

describe("runView: rejects disallowed ViewSpec shapes", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("rejects visibleColumns referencing a column that isn't on the target view", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const spec = new ViewSpec({
      view: "table",
      // "secretColumn" names nothing on graph_nodes (or anywhere) — this is the disallowed-
      // column case the task asks to verify is rejected, not silently ignored or passed through
      // to raw SQL.
      visibleColumns: ["secretColumn"],
      rowLimit: 10
    })

    const error = await rejectionToDomainError(
      workspaceStub.runView(
        Schema.encodeSync(RunViewInput)(new RunViewInput({ workspaceId, viewName: "graph_nodes", viewSpec: spec }))
      )
    )
    expect(error._tag).toBe("ValidationError")
  })

  it("rejects a raw/ad-hoc table name at the RPC decode boundary before any SQL is built", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const spec = new ViewSpec({ view: "table", visibleColumns: ["id"], rowLimit: 10 })
    // Bypasses `RunViewInput`'s own `Schema.encodeSync` (which would refuse to encode an invalid
    // `GraphViewName` in the first place) to simulate a malicious/malformed client sending a raw
    // physical/internal table name directly over the wire.
    const rawInput = { workspaceId, viewName: "rm_nodes", viewSpec: Schema.encodeSync(ViewSpec)(spec) }

    const error = await rejectionToDomainError(workspaceStub.runView(rawInput))
    expect(error._tag).toBe("ValidationError")
  })

  it("rejects hasTag/fact-field predicates against a non-graph_nodes view", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const spec = new ViewSpec({
      filter: { op: "hasTag", tagId: "00000000-0000-0000-0000-000000000001" as any },
      view: "table",
      visibleColumns: ["id", "name"],
      rowLimit: 10
    })

    const error = await rejectionToDomainError(
      workspaceStub.runView(
        Schema.encodeSync(RunViewInput)(new RunViewInput({ workspaceId, viewName: "graph_tags", viewSpec: spec }))
      )
    )
    expect(error._tag).toBe("ValidationError")
  })

  it("rejects graph_text_search as a runView target (it's reachable only via searchNodes)", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const spec = new ViewSpec({ view: "table", visibleColumns: ["title"], rowLimit: 10 })
    const error = await rejectionToDomainError(
      workspaceStub.runView(
        Schema.encodeSync(RunViewInput)(new RunViewInput({ workspaceId, viewName: "graph_text_search", viewSpec: spec }))
      )
    )
    expect(error._tag).toBe("ValidationError")
  })
})

describe("searchNodes: FTS5 full-text search over node title + page body", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("finds a known term across two nodes' page bodies and excludes an unrelated third node", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const nodeA = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Meeting notes" })))
    ).node
    const nodeB = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Follow-up" })))
    ).node
    const nodeC = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Grocery list" })))
    ).node

    for (const [node, body] of [
      [nodeA, "Discussed the athenaeum-fts5rollout plan with the team."],
      [nodeB, "Action item: finish the athenaeum-fts5rollout by Friday."],
      [nodeC, "Milk, eggs, bread."]
    ] as const) {
      Schema.decodeUnknownSync(CreatePageOutput)(
        await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId: node.id })))
      )
      Schema.decodeUnknownSync(ApplyPageEditOutput)(
        await workspaceStub.applyPageEdit(
          Schema.encodeSync(ApplyPageEditInput)(
            new ApplyPageEditInput({ workspaceId, nodeId: node.id, index: 0, deleteCount: 0, insertText: body })
          )
        )
      )
    }

    const output = Schema.decodeUnknownSync(SearchNodesOutput)(
      await workspaceStub.searchNodes(
        Schema.encodeSync(SearchNodesInput)(new SearchNodesInput({ workspaceId, query: "athenaeum-fts5rollout" }))
      )
    )

    const matchedIds = output.results.map((r) => r.nodeId).sort()
    expect(matchedIds).toEqual([nodeA.id, nodeB.id].sort())
    expect(output.results.some((r) => r.nodeId === nodeC.id)).toBe(false)
  })

  it("also matches on node title alone (no page required)", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(
        Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Quarterly roadmap review" }))
      )
    ).node

    const output = Schema.decodeUnknownSync(SearchNodesOutput)(
      await workspaceStub.searchNodes(Schema.encodeSync(SearchNodesInput)(new SearchNodesInput({ workspaceId, query: "roadmap" })))
    )

    expect(output.results.some((r) => r.nodeId === node.id)).toBe(true)
  })

  it("rejects an empty/whitespace-only search query", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const error = await rejectionToDomainError(
      workspaceStub.searchNodes(Schema.encodeSync(SearchNodesInput)(new SearchNodesInput({ workspaceId, query: "   " })))
    )
    expect(error._tag).toBe("ValidationError")
  })
})

// Supertag-centering pass — adversarial-review fix (`read-model.ts`'s `paramForFieldValue`,
// found during this pass's own real-browser verification, not hypothetical): `eq`/`in` against a
// plain `{kind: "column", ...}` `FieldRef` had zero test coverage anywhere in this codebase before
// this pass (confirmed by grep) — every prior `runView` filter test above exercises `hasTag` only.
// `NoteTags.tsx`'s `graph_node_tags` read and `SupertagFieldPopover.tsx`'s `graph_facts` read
// (both decisions-doc-§1-named patterns: "runView({viewName, viewSpec: {filter: {op:'eq',
// field:{kind:'column', column:'nodeId'}, value: nodeId}}})") are the first real callers of this
// exact shape, and both returned zero rows against data proven (by direct SQLite inspection) to
// exist — `jsonParam`'s unconditional `JSON.stringify` was comparing a raw TEXT column against a
// JSON-quoted string literal.
describe("runView: eq/in against a plain column FieldRef (not a fact value)", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("graph_node_tags: eq on the string `nodeId` column finds the real row (not double-JSON-encoded)", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`views-node-tags-eq-${crypto.randomUUID()}@example.com`)
    workspaceStub = (await connectToWorkspaceWithSocketAs(workspaceId, credential)).stub

    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Ada" })))
    ).node
    Schema.decodeUnknownSync(AssignTagOutput)(
      await workspaceStub.assignTag(
        Schema.encodeSync(AssignTagInput)(assignInput(workspaceId, node.id, BaseTagIds.Person, `views-assign-eq-${crypto.randomUUID()}`))
      )
    )

    const spec = new ViewSpec({
      filter: { op: "eq", field: { kind: "column", column: "nodeId" }, value: node.id },
      view: "table",
      visibleColumns: ["nodeId", "tagId"],
      rowLimit: 50
    })
    const output = Schema.decodeUnknownSync(RunViewOutput)(
      await workspaceStub.runView(
        Schema.encodeSync(RunViewInput)(new RunViewInput({ workspaceId, viewName: "graph_node_tags", viewSpec: spec }))
      )
    )

    expect(output.rows).toEqual([{ nodeId: node.id, tagId: BaseTagIds.Person }])
  })

  it("graph_facts: eq on the string `nodeId` column finds the real fact row", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`views-add-fact-${crypto.randomUUID()}@example.com`)
    workspaceStub = (await connectToWorkspaceWithSocketAs(workspaceId, credential)).stub

    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Grace" })))
    ).node
    const fact = Schema.decodeUnknownSync(AddFactOutput)(
      await workspaceStub.addFact(
        Schema.encodeSync(AddFactInput)(new AddFactInput({ workspaceId, nodeId: node.id, predicateId: "role", value: "Engineer", requestId: "views-role", commitMessage: "Set role.", attribution: webFieldAttribution() }))
      )
    ).fact

    const spec = new ViewSpec({
      filter: { op: "eq", field: { kind: "column", column: "nodeId" }, value: node.id },
      view: "table",
      visibleColumns: ["id", "nodeId", "predicateId", "value"],
      rowLimit: 50
    })
    const output = Schema.decodeUnknownSync(RunViewOutput)(
      await workspaceStub.runView(
        Schema.encodeSync(RunViewInput)(new RunViewInput({ workspaceId, viewName: "graph_facts", viewSpec: spec }))
      )
    )

    // `graph_facts.value` is stored `JSON.stringify`-encoded (`upsertFact`) and `runView` returns
    // it as the raw stored TEXT, not re-decoded — an established, documented convention
    // (`workouts.test.ts`'s own "a caller must `JSON.parse` each value itself" note), not
    // something this fix changes. Only the `eq` filter itself (finding the row by `nodeId` at
    // all) is what this test is really proving.
    expect(output.rows).toEqual([{ id: fact.id, nodeId: node.id, predicateId: "role", value: JSON.stringify("Engineer") }])
  })

  it("graph_node_tags: in on the string `nodeId` column matches, and a non-member id does not", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`views-node-tags-in-${crypto.randomUUID()}@example.com`)
    workspaceStub = (await connectToWorkspaceWithSocketAs(workspaceId, credential)).stub

    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Linus" })))
    ).node
    await workspaceStub.assignTag(
      Schema.encodeSync(AssignTagInput)(assignInput(workspaceId, node.id, BaseTagIds.Person, `views-assign-in-${crypto.randomUUID()}`))
    )

    const spec = new ViewSpec({
      filter: { op: "in", field: { kind: "column", column: "nodeId" }, values: [node.id, "00000000-0000-4000-8000-000000000000"] },
      view: "table",
      visibleColumns: ["nodeId", "tagId"],
      rowLimit: 50
    })
    const output = Schema.decodeUnknownSync(RunViewOutput)(
      await workspaceStub.runView(
        Schema.encodeSync(RunViewInput)(new RunViewInput({ workspaceId, viewName: "graph_node_tags", viewSpec: spec }))
      )
    )

    expect(output.rows).toEqual([{ nodeId: node.id, tagId: BaseTagIds.Person }])
  })
})
