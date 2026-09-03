import * as Schema from "effect/Schema"
import { EntityId, PendingMarker } from "./node.js"

// Plan §"Storage & domain model": "edges — canonical, source-owned relationship instances.
// Backlinks are a query (non-unique index target→edges), never a second stored record —
// GraphDataModel.md Evolution Rule #3, verbatim." Accordingly there is no `InverseEdge`/
// `Backlink` schema here: a backlink is computed by querying `Edge` rows where
// `targetNodeId` matches, using `RelationDefinition.inverseName` for display — a read, not a
// stored entity.
//
// Phase 3 storage-schema task: optional `pending` marker, mirroring `Node.pending` (see that
// field's doc comment in node.ts) — an `Edge` an agent chat proposed via the `addEdge` tool but
// the user hasn't accepted yet.

export class Edge extends Schema.Class<Edge>("Edge")({
  id: EntityId,
  relationDefinitionId: EntityId,
  sourceNodeId: EntityId,
  targetNodeId: EntityId,
  pending: Schema.optional(PendingMarker)
}) {}
