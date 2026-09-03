import * as Schema from "effect/Schema"
import { EntityId, Node } from "./node.js"
import { MutationAttribution, MutationCommitMessage, MutationRequestId } from "./ledger.js"

// Wire schemas for the Phase 0 exit criterion's `createNode`/`listNodes` round trip (plan
// §"Phased delivery": "one createNode/listNodes round trip, Workspace DO ⇄ web") plus the live
// `NodesChangedEvent` subscription payload needed for the widened live-subscription exit
// criterion (plan §"Verification": "a Layer.scoped service hands back a Collection.subscribe
// -backed RpcTarget stub to the client"). Every RPC method gets its own input/output schema
// pair per the plan's `defineRpcMethod(schema, effectProgram)` shim design — decoded with
// `Schema.decodeUnknown` at the DO boundary, not trusted as already-typed.

export class CreateNodeInput extends Schema.Class<CreateNodeInput>("CreateNodeInput")({
  workspaceId: EntityId,
  title: Schema.String.pipe(Schema.minLength(1)),
  // Web-stage addition: optional caller-supplied id, defaulted server-side (crypto.randomUUID())
  // when absent — preserves every existing caller's behavior unchanged. The one caller that
  // supplies it is the web app's daily-note resolver (`web/src/daily-note-id.ts`), which needs a
  // deterministic id derived from the calendar date so "resolve or create today's note" can
  // `getNode(deterministicId)` first and only fall back to `createNode` on `NodeNotFound` —
  // without this, the server always minting a fresh random id would make that resolution
  // impossible to implement as a real (non-mocked) client-side flow. `put`'s underlying primary-
  // key write is a plain upsert (see `nodes-repository-live.ts`), so a caller-supplied id that
  // collides with an existing node silently overwrites it; the daily-note flow's own
  // getNode-before-createNode sequencing is what keeps that safe in the single-tab Phase 1 case,
  // not anything enforced here.
  id: Schema.optional(EntityId)
}) {}

export class CreateNodeOutput extends Schema.Class<CreateNodeOutput>("CreateNodeOutput")({
  node: Node
}) {}

/** Authenticated, attributable creation contract. The older CreateNodeInput remains a
 * compatibility route and deliberately does not gain these required fields. */
export class CreateNodeWithIntentInput extends Schema.Class<CreateNodeWithIntentInput>("CreateNodeWithIntentInput")({
  workspaceId: EntityId,
  title: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(500)),
  id: Schema.optional(EntityId),
  requestId: MutationRequestId,
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

export class ListNodesInput extends Schema.Class<ListNodesInput>("ListNodesInput")({
  workspaceId: EntityId
}) {}

export class ListNodesOutput extends Schema.Class<ListNodesOutput>("ListNodesOutput")({
  nodes: Schema.Array(Node)
}) {}

/**
 * `getNode` wire schemas. Added for the Phase 0 Verify stage (plan §"Verification": "a
 * deliberately triggered Data.TaggedError (e.g. request a nonexistent node)... surface[s] as
 * correctly-typed errors on the client side of the Cap'n Web boundary") — `createNode`/
 * `listNodes` alone give no way to exercise `NodeNotFound` (`NodesRepository.get`'s own failure
 * mode) across the RPC boundary, so this method exists specifically to make that error path
 * reachable and testable, not because Phase 0's product surface needs a single-node fetch.
 */
export class GetNodeInput extends Schema.Class<GetNodeInput>("GetNodeInput")({
  workspaceId: EntityId,
  nodeId: EntityId
}) {}

export class GetNodeOutput extends Schema.Class<GetNodeOutput>("GetNodeOutput")({
  node: Node
}) {}

/**
 * Payload pushed to a live `nodes` subscription stub (see plan's Phase 0 exit criterion #2:
 * a `Collection.subscribe`-backed `RpcTarget` feeding the client on every change) — the same
 * shape as `ListNodesOutput` plus the `workspaceId` the push applies to, since a client may in
 * principle hold subscriptions open for more than one workspace.
 */
export class NodesChangedEvent extends Schema.Class<NodesChangedEvent>("NodesChangedEvent")({
  workspaceId: EntityId,
  nodes: Schema.Array(Node)
}) {}
