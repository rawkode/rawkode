// @enchiridion/projection — canonical edge decoding + relation-definition
// projection.
//
// Port of `PageDocument.decodedEdges`/`graphEdges`
// (apps/swift/Sources/EnchiridionSync/PageDocument.swift:873-894) for the
// read side, plus `GraphDatabase.swift`'s `graph_relation_definitions` view
// (GraphDatabase.swift:208-214) for the registry-projection side.
//
// WHY EDGE DECODING DOESN'T CALL `registry.relationIDForProperty()`: a
// page's `edges` container holds pre-resolved `KnowledgeEdge` JSON — the
// relation id was already computed once, at *write* time, by whatever
// wrote the edge (`PageDocument.setProperty`'s
// `BuiltInRelations.relationID(for: key)` call on the Swift side; this
// package's `buildEdgeEntry` helper below on the TS side, for test
// fixtures/future writers). Projection is read-only and source-owned edges
// are the one canonical mutation owner (plan/GraphDataModel.md: "Keep one
// canonical mutation owner for every edge or fact") — re-deriving the
// relation id from the *current* registry state at read time would let a
// module upgrade silently reinterpret an already-written edge under a
// different relation, which is exactly the kind of drift the "one
// canonical owner" rule exists to prevent. `registry.relationIDForProperty`
// /`.allRelations()` are used by `buildEdgeEntry` (the write-time helper)
// and `projectRelationDefinitions` (the whole-registry
// `graph_relation_definitions` projector) below instead.

import { relationIDForProperty, type SupertagPropertyKey, type SupertagRegistry } from "@enchiridion/schema";

export type GraphEdgeOrigin = "user" | "inlineReference" | "provider" | "system";

/** One forward, canonical edge row — matches the OLD app's PRIVATE
 *  `_graph_edges` storage table (GraphDatabase.swift:67-77), NOT the public
 *  `graph_edges` VIEW (which additionally UNIONs the inverse projection —
 *  see this package's `index.ts` header for the view SQL the wiring task
 *  needs to install). `projectPage()` only ever produces forward rows;
 *  backlinks are never materialized (GraphDataModel.md evolution rule #3). */
export interface GraphEdgeRow {
  edgeID: string;
  relationID: string;
  sourceNodeID: string;
  targetNodeID: string;
  origin: GraphEdgeOrigin;
  createdAt: number;
}

interface DecodedEdgeJson {
  id: string;
  relationID: string;
  sourceNodeID: string;
  targetNodeID: string;
  origin?: string;
  createdAt?: string;
}

const EDGE_ORIGINS: ReadonlySet<string> = new Set(["user", "inlineReference", "provider", "system"]);

function isGraphEdgeOrigin(value: unknown): value is GraphEdgeOrigin {
  return typeof value === "string" && EDGE_ORIGINS.has(value);
}

/** Decodes one `edges`-container JSON-string entry. Returns `undefined` for
 *  malformed JSON/shape (never throws) — matches
 *  `PageDocument.decodedEdges`'s `compactMap`-drop-on-failure pattern. The
 *  page's own id (`sourcePageID`) OVERRIDES whatever `sourceNodeID` is
 *  embedded in the JSON, matching `PageDocument.graphEdges`'s explicit
 *  `edge.sourceNodeID = pageID` reassignment (PageDocument.swift:886-888)
 *  — a page's `edges` container can only ever describe edges *it* owns as
 *  source, regardless of what's embedded in a possibly-stale blob. */
export function decodeEdgeEntry(json: string, sourcePageID: string): GraphEdgeRow | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Partial<DecodedEdgeJson>;
  if (
    typeof record.id !== "string" ||
    typeof record.relationID !== "string" ||
    typeof record.targetNodeID !== "string"
  ) {
    return undefined;
  }
  const createdAt = record.createdAt ? Date.parse(record.createdAt) : Number.NaN;
  return {
    edgeID: record.id,
    relationID: record.relationID,
    sourceNodeID: sourcePageID,
    targetNodeID: record.targetNodeID,
    origin: isGraphEdgeOrigin(record.origin) ? record.origin : "user",
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
  };
}

/** Write-side helper for constructing an `edges`-container JSON entry —
 *  used by this package's test fixtures (and available to a future real
 *  writer) to mirror `PageDocument.setProperty`'s edge-construction path
 *  exactly, INCLUDING its `registry.relationIDForProperty()` resolution
 *  (`BuiltInRelations.relationID(for: key)` on the Swift side). This is the
 *  one place in this package that calls `relationIDForProperty` — see this
 *  file's header for why decoding doesn't. */
export function buildEdgeEntry(
  registry: SupertagRegistry,
  input: {
    edgeID: string;
    key: SupertagPropertyKey;
    sourceNodeID: string;
    targetNodeID: string;
    origin?: GraphEdgeOrigin;
    createdAt?: Date;
  },
): string {
  const relationID = registry.relationIDForProperty(input.key);
  const payload: DecodedEdgeJson = {
    id: input.edgeID,
    relationID,
    sourceNodeID: input.sourceNodeID,
    targetNodeID: input.targetNodeID,
    origin: input.origin ?? "user",
    createdAt: (input.createdAt ?? new Date()).toISOString(),
  };
  return JSON.stringify(payload);
}

/** `graph_relation_definitions` row — matches the old app's public view
 *  column-for-column (GraphDatabase.swift:209-214), except
 *  `targetsPerSource`/`sourcesPerTarget` are `"one" | "many"` strings
 *  (matching that view's TEXT columns) rather than
 *  `workers/vault/src/schema.ts`'s current placeholder `INTEGER` columns
 *  for the same two fields — see this package's `index.ts` header for why
 *  that DDL needs correcting as part of the wiring follow-up. */
export interface GraphRelationDefinitionRow {
  relationID: string;
  forwardName: string;
  inverseName: string;
  targetsPerSource: "one" | "many";
  sourcesPerTarget: "one" | "many";
  isSystem: boolean;
}

/** `RelationCardinality` -> `{targetsPerSource, sourcesPerTarget}`, matching
 *  Swift's `RelationCardinality` static factories
 *  (GraphSchema.swift:102-105): `manyToOne` names "many sources, one
 *  target" (so `targetsPerSource: one`, `sourcesPerTarget: many`), etc. */
export function cardinalityEndpoints(
  cardinality: "oneToOne" | "oneToMany" | "manyToOne" | "manyToMany",
): { targetsPerSource: "one" | "many"; sourcesPerTarget: "one" | "many" } {
  switch (cardinality) {
    case "oneToOne":
      return { targetsPerSource: "one", sourcesPerTarget: "one" };
    case "oneToMany":
      return { targetsPerSource: "many", sourcesPerTarget: "one" };
    case "manyToOne":
      return { targetsPerSource: "one", sourcesPerTarget: "many" };
    case "manyToMany":
      return { targetsPerSource: "many", sourcesPerTarget: "many" };
  }
}

/** Projects every relation declared across the loaded registry into
 *  `graph_relation_definitions` rows — a whole-registry projection (not
 *  per-page), matching Swift's `saveRelation` writing every
 *  `BuiltInRelations.all` entry once at database install
 *  (GraphDatabase.swift:124-125). `isSystem` is always `false` here: unlike
 *  Swift's fixed built-in relation table, every relation in this
 *  data-driven module system is authored, versioned, repo-defined code
 *  (plan §Supertag module contract: "supertags as-code, repo-defined") —
 *  there is no runtime-authored-vs-built-in distinction left to encode. */
export function projectRelationDefinitions(registry: SupertagRegistry): GraphRelationDefinitionRow[] {
  return registry.allRelations().map((relation) => {
    const endpoints = cardinalityEndpoints(relation.cardinality);
    return {
      relationID: relation.id,
      forwardName: relation.forwardName,
      inverseName: relation.inverseName,
      targetsPerSource: endpoints.targetsPerSource,
      sourcesPerTarget: endpoints.sourcesPerTarget,
      isSystem: false,
    };
  });
}
