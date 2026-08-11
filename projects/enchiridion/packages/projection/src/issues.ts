// @enchiridion/projection — edge-level graph issue detection.
//
// Port of `GraphProjectionStore.refreshIssues`/`insertIssues`
// (apps/enchiridion/Sources/EnchiridionCore/GraphDatabase.swift:513-675) and
// the `graph_issues` view (GraphDatabase.swift:246-250).
//
// SCOPE — deliberately NOT everything Swift's `GraphIssueKind` covers: per
// this task's brief ("only cardinality-violation/unresolved-target/
// invalid-source-or-target-type edge-level issues are in scope here") and
// `PageModels.swift`'s header (the P1 SupertagConflict investigation),
// property-VALUE conflicts (concurrent writes to the same scalar/select
// storage key) are Loro-LWW-silent and have no detection mechanism yet —
// not invented here. `inheritanceCycle` is also out of scope: cyclic
// inheritance is rejected at `SupertagRegistry.build()` time
// (`registry.ts`), so a live registry can never contain one for this
// function to report.
//
// WHOLE-VAULT, NOT PER-PAGE: unlike `projectPage()`'s other outputs, issue
// detection inherently needs cross-page information — whether an edge's
// target node exists at all, and what tags the source/target nodes carry
// — exactly matching Swift's `refreshIssues` operating over the ENTIRE
// `_graph_edges` table plus a `pages`/`graph_node_tags` join, not one
// page's row set. Callers accumulate `GraphEdgeRow[]` across every
// projected page (plus each node's existence/tag info) and call
// `detectGraphIssues` once over that whole batch — or, for the
// `refreshIssues(for: relationIDs:)` incremental case Swift also supports
// (GraphDatabase.swift:531-565), filter `edges`/`nodeInfo` down to the
// affected relations before calling.

import type { QualifiedRelationDefinition, SupertagRegistry } from "@enchiridion/schema";
import { cardinalityEndpoints, type GraphEdgeRow } from "./edges";

export type GraphIssueKind =
  | "cardinalityViolation"
  | "unresolvedTarget"
  | "invalidSourceType"
  | "invalidTargetType";

/** `graph_issues` row — matches the old app's public view column-for-column
 *  (GraphDatabase.swift:246-250). `edgeID`/`relationID` are always present
 *  here (every issue kind in this package's scope is edge-shaped), unlike
 *  Swift's nullable columns, which also serve node-shaped issue kinds this
 *  package doesn't produce. */
export interface GraphIssueRow {
  issueID: string;
  kind: GraphIssueKind;
  nodeID: string;
  edgeID: string;
  relationID: string;
  message: string;
  createdAt: number;
}

/** What `detectGraphIssues` needs to know about a node referenced by an
 *  edge — existence (soft-deleted/purged nodes count as absent, matching
 *  Swift's `WHERE deleted_at IS NULL` filter feeding `existingNodes`,
 *  GraphDatabase.swift:594) and its EFFECTIVE tag set (direct + inherited
 *  — endpoint-type constraints check the full closure, matching the old
 *  app's `graph_node_tags` join, which is closure-inclusive per that
 *  view's own definition). */
export interface GraphIssueNodeInfo {
  exists: boolean;
  effectiveTagIDs: ReadonlySet<string>;
}

function issueID(kind: GraphIssueKind, edgeID: string): string {
  return `issue_${kind}:${edgeID}`;
}

function relationEndpointConstraint(
  relation: QualifiedRelationDefinition,
  endpoint: "from" | "to",
): ReadonlySet<string> {
  return new Set(relation[endpoint]);
}

/** Detects cardinality-violation, unresolved-target, and invalid-source/
 *  target-type issues over one accumulated batch of forward edges — see
 *  this file's header for scope and the whole-vault calling convention.
 *  `nodeInfo` should have an entry for every node id appearing as an
 *  edge's source or target; a missing entry is treated as
 *  `{ exists: false, effectiveTagIDs: new Set() }` (matches Swift
 *  treating an id absent from its `existingNodes` query the same way). */
export function detectGraphIssues(
  edges: readonly GraphEdgeRow[],
  nodeInfo: ReadonlyMap<string, GraphIssueNodeInfo>,
  registry: SupertagRegistry,
  now: number,
): GraphIssueRow[] {
  const issues: GraphIssueRow[] = [];
  const infoOf = (nodeID: string): GraphIssueNodeInfo =>
    nodeInfo.get(nodeID) ?? { exists: false, effectiveTagIDs: new Set() };

  // 1. Unresolved target — GraphDatabase.swift:613-620.
  for (const edge of edges) {
    if (infoOf(edge.targetNodeID).exists) continue;
    issues.push({
      issueID: issueID("unresolvedTarget", edge.edgeID),
      kind: "unresolvedTarget",
      nodeID: edge.sourceNodeID,
      edgeID: edge.edgeID,
      relationID: edge.relationID,
      message: "The relationship target is unavailable.",
      createdAt: now,
    });
  }

  const relationsByID = new Map(registry.allRelations().map((relation) => [relation.id, relation] as const));

  const edgesByRelation = new Map<string, GraphEdgeRow[]>();
  for (const edge of edges) {
    const list = edgesByRelation.get(edge.relationID);
    if (list) list.push(edge);
    else edgesByRelation.set(edge.relationID, [edge]);
  }

  for (const [relationID, relationEdges] of edgesByRelation) {
    const relation = relationsByID.get(relationID);
    if (!relation) continue;
    const { targetsPerSource, sourcesPerTarget } = cardinalityEndpoints(relation.cardinality);

    // 2. Cardinality violation — GraphDatabase.swift:622-649.
    if (targetsPerSource === "one") {
      const bySource = new Map<string, GraphEdgeRow[]>();
      for (const edge of relationEdges) {
        const list = bySource.get(edge.sourceNodeID);
        if (list) list.push(edge);
        else bySource.set(edge.sourceNodeID, [edge]);
      }
      for (const group of bySource.values()) {
        const distinctTargets = new Set(group.map((edge) => edge.targetNodeID));
        if (distinctTargets.size <= 1) continue;
        for (const edge of group) {
          issues.push({
            issueID: issueID("cardinalityViolation", edge.edgeID),
            kind: "cardinalityViolation",
            nodeID: edge.sourceNodeID,
            edgeID: edge.edgeID,
            relationID,
            message: `${capitalize(relation.forwardName)} allows one target; choose which relationship to keep.`,
            createdAt: now,
          });
        }
      }
    }
    if (sourcesPerTarget === "one") {
      const byTarget = new Map<string, GraphEdgeRow[]>();
      for (const edge of relationEdges) {
        const list = byTarget.get(edge.targetNodeID);
        if (list) list.push(edge);
        else byTarget.set(edge.targetNodeID, [edge]);
      }
      for (const group of byTarget.values()) {
        const distinctSources = new Set(group.map((edge) => edge.sourceNodeID));
        if (distinctSources.size <= 1) continue;
        for (const edge of group) {
          issues.push({
            issueID: issueID("cardinalityViolation", edge.edgeID),
            kind: "cardinalityViolation",
            nodeID: edge.sourceNodeID,
            edgeID: edge.edgeID,
            relationID,
            message: `${capitalize(relation.inverseName)} allows one source; choose which relationship to keep.`,
            createdAt: now,
          });
        }
      }
    }

    // 3/4. Invalid source/target type — GraphDatabase.swift:650-673.
    const sourceConstraint = relationEndpointConstraint(relation, "from");
    if (sourceConstraint.size > 0) {
      for (const edge of relationEdges) {
        const source = infoOf(edge.sourceNodeID);
        if (!source.exists) continue;
        if (setsIntersect(source.effectiveTagIDs, sourceConstraint)) continue;
        issues.push({
          issueID: issueID("invalidSourceType", edge.edgeID),
          kind: "invalidSourceType",
          nodeID: edge.sourceNodeID,
          edgeID: edge.edgeID,
          relationID,
          message: `The source does not have a type allowed by ${relation.forwardName}.`,
          createdAt: now,
        });
      }
    }
    const targetConstraint = relationEndpointConstraint(relation, "to");
    if (targetConstraint.size > 0) {
      for (const edge of relationEdges) {
        const target = infoOf(edge.targetNodeID);
        if (!target.exists) continue;
        if (setsIntersect(target.effectiveTagIDs, targetConstraint)) continue;
        issues.push({
          issueID: issueID("invalidTargetType", edge.edgeID),
          kind: "invalidTargetType",
          nodeID: edge.sourceNodeID,
          edgeID: edge.edgeID,
          relationID,
          message: `The target does not have a type allowed by ${relation.forwardName}.`,
          createdAt: now,
        });
      }
    }
  }

  return issues;
}

function setsIntersect(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}
