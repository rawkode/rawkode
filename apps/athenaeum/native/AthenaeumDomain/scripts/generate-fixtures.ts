// Generates real TS-encoder-produced JSON fixtures for `AthenaeumDomainTests`'s round-trip
// decode tests, by calling `@athenaeum/domain`'s actual `Schema.encodeSync` against real
// constructed entity/RPC-schema instances — not hand-guessed JSON. Run with:
//
//   node --experimental-strip-types scripts/generate-fixtures.ts
//   (or, on Node >=23.6, just `node scripts/generate-fixtures.ts` — type stripping is default)
//
// Requires `packages/domain`'s `dist/` to be built and up to date (`pnpm --filter @athenaeum/domain
// run build`, or `node_modules/.bin/tsc` inside that package) — this script imports the built
// output, not `src/*.ts` directly, matching how every other consumer of `@athenaeum/domain`
// (backend, web) actually imports it.
//
// **Binary-field exception** (see `Sources/AthenaeumDomain/SyncRPC.swift`'s header comment):
// `StartPageSyncOutput`/`PageSyncMessageInput`/`PageSyncMessageOutput` carry
// `Schema.Uint8ArrayFromSelf` fields, whose raw `Schema.encodeSync` output is a JS `Uint8Array` —
// not directly JSON-safe (`JSON.stringify` turns it into an index-keyed object, not a JSON array
// or string). For exactly those three fixtures, this script still calls `Schema.encodeSync`
// against a real instance, but then explicitly re-encodes the byte field as a base64 string
// (`Buffer.from(bytes).toString("base64")`) before writing the fixture — matching the Swift side's
// documented choice to model those fields as `Data` (base64 by default). This is a hand-adapted
// JSON transport encoding, not a raw dump of `Schema.encodeSync`'s own (non-JSON-safe) output;
// every other fixture below *is* a raw, unmodified `Schema.encodeSync` + `JSON.stringify` dump.

import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import * as Schema from "effect/Schema"
import {
  AddFactInput,
  AddFactOutput,
  ApplyPageEditInput,
  ApplyPageEditOutput,
  AssignTagInput,
  AssignTagOutput,
  BASE_TAGS,
  CreateEdgeInput,
  CreateEdgeOutput,
  CreateNodeInput,
  CreateNodeOutput,
  CreatePageInput,
  CreatePageOutput,
  CreateRelationDefinitionInput,
  CreateRelationDefinitionOutput,
  CreateTagInput,
  CreateTagOutput,
  Edge,
  Fact,
  GetNodeInput,
  GetNodeOutput,
  GetPageTextInput,
  GetPageTextOutput,
  GraphIssue,
  ListBacklinksInput,
  ListBacklinksOutput,
  ListGraphIssuesInput,
  ListGraphIssuesOutput,
  ListNodesInput,
  ListNodesOutput,
  ListTagClosureInput,
  ListTagClosureOutput,
  ListTagsInput,
  ListTagsOutput,
  Node,
  NodesChangedEvent,
  Page,
  PageSyncMessageInput,
  PageSyncMessageOutput,
  RelationDefinition,
  RotateEpochInput,
  RotateEpochOutput,
  RunViewInput,
  RunViewOutput,
  SearchNodesInput,
  SearchNodesOutput,
  SearchResultEntry,
  StartPageSyncInput,
  StartPageSyncOutput,
  SyncFeedEntry,
  SyncFeedInput,
  SyncFeedOutput,
  Tag,
  TagClosureEntry,
  ViewSpec
} from "../../../packages/domain/dist/index.js"

const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(here, "..", "Tests", "AthenaeumDomainTests", "Fixtures")

const write = (name: string, json: unknown) => {
  const path = join(fixturesDir, `${name}.json`)
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n")
  console.log(`wrote ${path}`)
}

const encode = <A, I>(schema: Schema.Schema<A, I>, value: A) => Schema.encodeSync(schema)(value)

// --- Shared sample values ------------------------------------------------------------------

const workspaceId = "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e5f"
const nodeId = "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60"
const nodeId2 = "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61"
const tagId = "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e62"
const factId = "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e63"
const edgeId = "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e64"
const relationDefinitionId = "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e65"
const graphIssueId = "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e66"
const createdAt = "2026-08-20T12:34:56.000Z"

const sampleNode = new Node({ id: nodeId, workspaceId, title: "Daily note — 2026-08-20", createdAt })
const sampleNode2 = new Node({ id: nodeId2, workspaceId, title: "Second node", createdAt })

// --- Entities -------------------------------------------------------------------------------

write("Node", encode(Node, sampleNode))
write("BaseTags", encode(Schema.Array(Tag), BASE_TAGS))
write(
  "Page",
  encode(Page, new Page({ nodeId, automergeDocId: "doc-abc123", headsHash: "sha256:deadbeef" }))
)
write(
  "Fact",
  encode(
    Fact,
    new Fact({
      id: factId,
      nodeId,
      predicateId: "status",
      value: { done: false, priority: 2, tags: ["urgent", "home"], note: null }
    })
  )
)
write(
  "RelationDefinition",
  encode(
    RelationDefinition,
    new RelationDefinition({
      id: relationDefinitionId,
      forwardName: "employs",
      inverseName: "employed by",
      sourceTagId: tagId,
      targetTagId: tagId,
      cardinality: "one-to-many"
    })
  )
)
write(
  "Edge",
  encode(Edge, new Edge({ id: edgeId, relationDefinitionId, sourceNodeId: nodeId, targetNodeId: nodeId2 }))
)
write(
  "GraphIssue",
  encode(
    GraphIssue,
    new GraphIssue({
      id: graphIssueId,
      kind: "concurrent-max-one-edge-conflict",
      relationDefinitionId,
      nodeId,
      conflictingEdgeIds: [edgeId],
      createdAt
    })
  )
)
write(
  "ViewSpec",
  encode(
    ViewSpec,
    new ViewSpec({
      filter: {
        op: "and",
        predicates: [
          { op: "eq", field: { kind: "column", column: "title" }, value: "Daily note" },
          { op: "hasTag", tagId },
          {
            op: "in",
            field: { kind: "fact", predicateId: "status" },
            values: ["todo", "doing"]
          }
        ]
      },
      groupBy: "status",
      sortColumn: "createdAt",
      sortDescending: true,
      view: "board",
      visibleColumns: ["title", "status"],
      rowLimit: 50
    })
  )
)
// A minimal ViewSpec exercising every optional field's *absence* — verifies the Swift side omits
// the same keys on decode/encode that `Schema.optional` omits here.
write(
  "ViewSpecMinimal",
  encode(
    ViewSpec,
    new ViewSpec({ view: "table", visibleColumns: ["title"], rowLimit: 10 })
  )
)
write(
  "SyncFeedEntry",
  encode(
    SyncFeedEntry,
    new SyncFeedEntry({
      replicaEpoch: 0,
      monotonicCounter: 42,
      entityKind: "node",
      entityId: nodeId,
      operation: "put",
      payload: { id: nodeId, workspaceId, title: "Daily note", createdAt },
      hash: "sha256:cafebabe"
    })
  )
)

// --- RPC wire schemas -------------------------------------------------------------------------

write("CreateNodeInput", encode(CreateNodeInput, new CreateNodeInput({ workspaceId, title: "New node" })))
write(
  "CreateNodeInputWithId",
  encode(CreateNodeInput, new CreateNodeInput({ workspaceId, title: "New node", id: nodeId }))
)
write("CreateNodeOutput", encode(CreateNodeOutput, new CreateNodeOutput({ node: sampleNode })))
write("GetNodeInput", encode(GetNodeInput, new GetNodeInput({ workspaceId, nodeId })))
write("GetNodeOutput", encode(GetNodeOutput, new GetNodeOutput({ node: sampleNode })))
write("ListNodesInput", encode(ListNodesInput, new ListNodesInput({ workspaceId })))
write(
  "ListNodesOutput",
  encode(ListNodesOutput, new ListNodesOutput({ nodes: [sampleNode, sampleNode2] }))
)
write(
  "NodesChangedEvent",
  encode(NodesChangedEvent, new NodesChangedEvent({ workspaceId, nodes: [sampleNode] }))
)

write("CreateTagInput", encode(CreateTagInput, new CreateTagInput({ workspaceId, name: "Project", parentIds: [] })))
write(
  "CreateTagOutput",
  encode(CreateTagOutput, new CreateTagOutput({ tag: new Tag({ id: tagId, name: "Project", parentIds: [], builtin: false }) }))
)
write(
  "AddFactInput",
  encode(
    AddFactInput,
    new AddFactInput({ workspaceId, nodeId, predicateId: "status", value: "todo" })
  )
)
write(
  "AddFactOutput",
  encode(
    AddFactOutput,
    new AddFactOutput({ fact: new Fact({ id: factId, nodeId, predicateId: "status", value: "todo" }) })
  )
)
write(
  "CreateRelationDefinitionInput",
  encode(
    CreateRelationDefinitionInput,
    new CreateRelationDefinitionInput({
      workspaceId,
      forwardName: "employs",
      inverseName: "employed by",
      sourceTagId: tagId,
      targetTagId: tagId,
      cardinality: "many-to-many"
    })
  )
)
write(
  "CreateRelationDefinitionOutput",
  encode(
    CreateRelationDefinitionOutput,
    new CreateRelationDefinitionOutput({
      relationDefinition: new RelationDefinition({
        id: relationDefinitionId,
        forwardName: "employs",
        inverseName: "employed by",
        sourceTagId: tagId,
        targetTagId: tagId,
        cardinality: "many-to-many"
      })
    })
  )
)
write(
  "CreateEdgeInput",
  encode(
    CreateEdgeInput,
    new CreateEdgeInput({ workspaceId, relationDefinitionId, sourceNodeId: nodeId, targetNodeId: nodeId2 })
  )
)
write(
  "CreateEdgeOutput",
  encode(
    CreateEdgeOutput,
    new CreateEdgeOutput({ edge: new Edge({ id: edgeId, relationDefinitionId, sourceNodeId: nodeId, targetNodeId: nodeId2 }) })
  )
)
write(
  "RunViewInput",
  encode(
    RunViewInput,
    new RunViewInput({
      workspaceId,
      viewName: "graph_nodes",
      viewSpec: new ViewSpec({ view: "table", visibleColumns: ["title"], rowLimit: 25 })
    })
  )
)
write(
  "RunViewOutput",
  encode(RunViewOutput, new RunViewOutput({ rows: [{ id: nodeId, title: "Row one" }, { id: nodeId2, title: "Row two" }] }))
)
write("ListBacklinksInput", encode(ListBacklinksInput, new ListBacklinksInput({ workspaceId, nodeId })))
write(
  "ListBacklinksOutput",
  encode(
    ListBacklinksOutput,
    new ListBacklinksOutput({ edges: [new Edge({ id: edgeId, relationDefinitionId, sourceNodeId: nodeId2, targetNodeId: nodeId })] })
  )
)
write("ListGraphIssuesInput", encode(ListGraphIssuesInput, new ListGraphIssuesInput({ workspaceId })))
write(
  "ListGraphIssuesOutput",
  encode(
    ListGraphIssuesOutput,
    new ListGraphIssuesOutput({
      graphIssues: [
        new GraphIssue({
          id: graphIssueId,
          kind: "concurrent-max-one-edge-conflict",
          relationDefinitionId,
          nodeId,
          conflictingEdgeIds: [edgeId],
          createdAt
        })
      ]
    })
  )
)
write("ListTagClosureInput", encode(ListTagClosureInput, new ListTagClosureInput({ workspaceId })))
write(
  "ListTagClosureOutput",
  encode(
    ListTagClosureOutput,
    new ListTagClosureOutput({ entries: [new TagClosureEntry({ ancestorId: tagId, descendantId: tagId })] })
  )
)
write("ListTagsInput", encode(ListTagsInput, new ListTagsInput({ workspaceId })))
write(
  "ListTagsOutput",
  encode(ListTagsOutput, new ListTagsOutput({ tags: [new Tag({ id: tagId, name: "Project", parentIds: [], builtin: false })] }))
)
write("AssignTagInput", encode(AssignTagInput, new AssignTagInput({ workspaceId, nodeId, tagId })))
write("AssignTagOutput", encode(AssignTagOutput, new AssignTagOutput({ nodeId, tagId })))

write(
  "SearchNodesInput",
  encode(SearchNodesInput, new SearchNodesInput({ workspaceId, query: "daily", limit: 10 }))
)
write(
  "SearchNodesOutput",
  encode(
    SearchNodesOutput,
    new SearchNodesOutput({
      results: [new SearchResultEntry({ nodeId, title: "Daily note", snippet: "...daily standup notes..." })]
    })
  )
)

write("CreatePageInput", encode(CreatePageInput, new CreatePageInput({ workspaceId, nodeId })))
write(
  "CreatePageOutput",
  encode(
    CreatePageOutput,
    new CreatePageOutput({ page: new Page({ nodeId, automergeDocId: "doc-abc123", headsHash: "sha256:00" }), text: "" })
  )
)
write("GetPageTextInput", encode(GetPageTextInput, new GetPageTextInput({ workspaceId, nodeId })))
write(
  "GetPageTextOutput",
  encode(
    GetPageTextOutput,
    new GetPageTextOutput({
      page: new Page({ nodeId, automergeDocId: "doc-abc123", headsHash: "sha256:01" }),
      text: "Hello, world!"
    })
  )
)
write(
  "ApplyPageEditInput",
  encode(
    ApplyPageEditInput,
    new ApplyPageEditInput({ workspaceId, nodeId, index: 5, deleteCount: 0, insertText: ", world" })
  )
)
write(
  "ApplyPageEditOutput",
  encode(
    ApplyPageEditOutput,
    new ApplyPageEditOutput({
      page: new Page({ nodeId, automergeDocId: "doc-abc123", headsHash: "sha256:02" }),
      text: "Hello, world!"
    })
  )
)

write(
  "SyncFeedInput",
  encode(SyncFeedInput, new SyncFeedInput({ workspaceId, limit: 100 }))
)
write(
  "SyncFeedInputWithCursor",
  encode(
    SyncFeedInput,
    new SyncFeedInput({ workspaceId, knownEpoch: "epoch-abc123", afterCounter: 41, limit: 100 })
  )
)
write(
  "SyncFeedOutput",
  encode(
    SyncFeedOutput,
    new SyncFeedOutput({
      epoch: "epoch-abc123",
      epochMismatch: false,
      entries: [
        new SyncFeedEntry({
          replicaEpoch: 0,
          monotonicCounter: 42,
          entityKind: "node",
          entityId: nodeId,
          operation: "put",
          payload: { id: nodeId, workspaceId, title: "Daily note", createdAt },
          hash: "sha256:cafebabe"
        })
      ],
      nextAfterCounter: 42
    })
  )
)
write("RotateEpochInput", encode(RotateEpochInput, new RotateEpochInput({ workspaceId })))
write("RotateEpochOutput", encode(RotateEpochOutput, new RotateEpochOutput({ epoch: "epoch-def456" })))

// --- RpcErrorEnvelope fixtures (hand-constructed via each DomainError's real encodeRpcError) ---

import { encodeRpcError, NodeNotFound, ValidationError, GraphIssueDetected } from "../../../packages/domain/dist/index.js"

write("RpcErrorEnvelope_NodeNotFound", encodeRpcError(new NodeNotFound({ nodeId })))
write(
  "RpcErrorEnvelope_ValidationError",
  encodeRpcError(new ValidationError({ message: "title must not be empty" }))
)
write(
  "RpcErrorEnvelope_GraphIssueDetected",
  encodeRpcError(
    new GraphIssueDetected({ relationDefinitionId, nodeId, conflictingEdgeIds: [edgeId, edgeId2()] })
  )
)
function edgeId2() {
  return "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e67"
}

// --- Binary-field RPC schemas (hand-adapted to base64, see header comment) --------------------

const fakeSyncMessageBytes = Uint8Array.from([1, 2, 3, 4, 250, 251, 252, 253, 254, 255, 0])
const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")

{
  const encoded = encode(
    StartPageSyncOutput,
    new StartPageSyncOutput({ sessionId: "session-abc", message: fakeSyncMessageBytes })
  ) as { sessionId: string; message: unknown }
  write("StartPageSyncOutput", { sessionId: encoded.sessionId, message: toBase64(fakeSyncMessageBytes) })
}
write("StartPageSyncInput", encode(StartPageSyncInput, new StartPageSyncInput({ workspaceId, nodeId, sessionId: "session-abc" })))
{
  const encoded = encode(
    PageSyncMessageInput,
    new PageSyncMessageInput({ workspaceId, nodeId, sessionId: "session-abc", ordinal: 3, message: fakeSyncMessageBytes })
  ) as { workspaceId: string; nodeId: string; sessionId: string; ordinal: number; message: unknown }
  write("PageSyncMessageInput", {
    workspaceId: encoded.workspaceId,
    nodeId: encoded.nodeId,
    sessionId: encoded.sessionId,
    ordinal: encoded.ordinal,
    message: toBase64(fakeSyncMessageBytes)
  })
}
{
  const encoded = encode(
    PageSyncMessageOutput,
    new PageSyncMessageOutput({
      sessionId: "session-abc",
      ordinal: 3,
      message: fakeSyncMessageBytes,
      converged: false,
      reset: false
    })
  ) as { sessionId: string; ordinal: number; message: unknown; converged: boolean; reset: boolean }
  write("PageSyncMessageOutput", {
    sessionId: encoded.sessionId,
    ordinal: encoded.ordinal,
    message: toBase64(fakeSyncMessageBytes),
    converged: encoded.converged,
    reset: encoded.reset
  })
}
// `message: null` case (converged, nothing further to send).
write(
  "PageSyncMessageOutputConverged",
  encode(
    PageSyncMessageOutput,
    new PageSyncMessageOutput({ sessionId: "session-abc", ordinal: 4, message: null, converged: true, reset: false })
  )
)

console.log("Fixture generation complete.")
