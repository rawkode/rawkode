import * as Schema from "effect/Schema"
import { EntityId, IsoDateTimeString } from "./node.js"

// Plan §"Storage & domain model": "graphIssues — surfaced merge conflicts on concurrent
// max-one edges (Evolution Rule #4: 'preserve conflicting graph assertions through merge and
// expose deterministic issues')." A `GraphIssue` is the durable, queryable record of a
// detected conflict — it does not resolve or reject the conflicting edges, it exposes them
// (per Evolution Rule #4's "preserve... and expose", not "reject").

/**
 * The kinds of graph conflict this schema can currently represent. The plan names exactly one
 * (a cardinality-one relation ending up with more than one edge after a concurrent merge);
 * `GraphIssueKind` is a literal union rather than a bare string specifically so that adding a
 * second kind later is a one-line, exhaustively-checked change at every switch over it, the same
 * discipline `RelationCardinality` and `SyncFeedEntry.operation` already follow in this package.
 */
export const GraphIssueKind = Schema.Literal("concurrent-max-one-edge-conflict")
export type GraphIssueKind = typeof GraphIssueKind.Type

export class GraphIssue extends Schema.Class<GraphIssue>("GraphIssue")({
  id: EntityId,
  kind: GraphIssueKind,
  relationDefinitionId: EntityId,
  nodeId: EntityId,
  conflictingEdgeIds: Schema.Array(EntityId),
  createdAt: IsoDateTimeString
}) {}
