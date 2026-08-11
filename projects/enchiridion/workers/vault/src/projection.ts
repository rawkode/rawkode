// @enchiridion/worker-vault — reprojection: Loro doc state -> the full
// public-view projection contract.
//
// Plan §Backend architecture: "Reprojection runs synchronously, in the
// same DO SQLite transaction as the doc-storage write" and "on boot a
// `lastProjectedVersion` check auto-heals drift."
//
// P1: this file now calls the REAL projection logic in
// `@enchiridion/projection` (`projectPage()`) instead of the P0
// graph_nodes-only placeholder — see that package's `index.ts` header,
// "WIRING NOTES FOR THE FOLLOW-UP TASK", point 1, for the exact contract
// this implements: DELETE a page's existing projection rows, then
// re-INSERT this call's fresh output (replace-not-upsert, matching
// Swift's `GraphProjectionStore.replacePage`, GraphDatabase.swift:430-434).
//
// Doc container shape this reads from is `@enchiridion/projection`'s own
// concern now (`doc.ts`'s `PageContainer`: `root`/`objectMetadata`/`tags`/
// `values`/`edges`/`title`/`body`) — this file just exports the page's
// snapshot bytes (`LoroPageDoc.exportSnapshot()`) and hands them to
// `projectPage()`, which opens its own `LoroDoc` from those bytes
// (deliberately NOT sharing `loro-storage.ts`'s `LoroPageDoc` instance —
// see `packages/projection/src/doc.ts`'s header on why that package is its
// own point of contact with `loro-crdt`, to avoid a circular dependency
// between this worker and the package it depends on).
//
// `system` (LoroMap): still this worker's own bookkeeping container, NOT
// part of `@enchiridion/projection`'s doc-shape contract — `modifiedAt`
// (epoch ms), written by `vault-write-model.ts`'s `touchModifiedAt` as a
// real local Loro op on every write. `resolveModifiedAt` below reads it
// back (falling back to `catalogCreatedAt` for a page that predates this
// bookkeeping, or for the boot-time drift-heal path, which has no "this
// instant" value to pass) — matching the old P0 placeholder's
// `extractNodeFields` behavior exactly, just relocated here since
// `@enchiridion/projection`'s `ProjectPageInput.modifiedAt` is a passed
// parameter, not read from the doc (see that package's `index.ts`,
// `ProjectPageInput`'s doc comment).

import {
  detectGraphIssues,
  projectPage,
  type GraphEdgeOrigin,
  type GraphEdgeRow,
  type GraphFactRow,
  type GraphIssueNodeInfo,
  type GraphIssueRow,
  type GraphNodeRow,
  type GraphNodeTagRow,
  type GraphTextSearchRow,
  type ProjectedPage,
} from "@enchiridion/projection";
import type { LoroPageDoc } from "./loro-storage";
import type { SqlExecutor } from "./schema";
import { supertagRegistry, tagCatalog } from "./supertag-registry";

/** Reads `system.modifiedAt` off a hydrated doc — see this file's header.
 *  `system` is this worker's own bookkeeping container (never read by
 *  `@enchiridion/projection` itself), so this stays a small local helper
 *  rather than something that package owns. */
export function resolveModifiedAt(doc: LoroPageDoc, fallback: number): number {
  const system = doc.mapShallowValue("system");
  const raw = system.modifiedAt;
  return typeof raw === "number" ? raw : fallback;
}

/** Upserts one row into `graph_nodes` — the one projection table keyed
 *  one-row-per-page where upsert (rather than delete-then-insert) is both
 *  correct and simpler, since there's nothing to "clear out" beyond what
 *  `ON CONFLICT` already overwrites.
 *
 *  `person_visibility`/`person_origin` — PRIVACY GATE (see `schema.ts`'s
 *  DDL comment on `graph_nodes` and `@enchiridion/projection`'s
 *  `GraphNodeRow.personVisibility`/`.personOrigin` doc comment): persisted
 *  straight through from `projectPage()`'s output, `NULL` when absent
 *  (the normal case — most pages were never materialized from a calendar/
 *  Gmail provider). This is the ONE call site that writes `graph_nodes`
 *  (`writeProjectedPage` below), so this is also the one place the
 *  privacy-gate columns actually land in storage on every reprojection —
 *  no other code path inserts into this table. */
export function projectNode(sql: SqlExecutor, node: GraphNodeRow): void {
  sql.exec(
    `INSERT INTO graph_nodes
       (node_id, title, plain_text, kind, created_at, modified_at, deleted_at, is_pinned, person_visibility, person_origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (node_id) DO UPDATE SET
       title = excluded.title,
       plain_text = excluded.plain_text,
       kind = excluded.kind,
       created_at = excluded.created_at,
       modified_at = excluded.modified_at,
       deleted_at = excluded.deleted_at,
       is_pinned = excluded.is_pinned,
       person_visibility = excluded.person_visibility,
       person_origin = excluded.person_origin`,
    node.nodeID,
    node.title,
    node.plainText,
    node.kind,
    node.createdAt,
    node.modifiedAt,
    node.deletedAt ?? null,
    node.isPinned ? 1 : 0,
    node.personVisibility ?? null,
    node.personOrigin ?? null,
  );
}

function insertFact(sql: SqlExecutor, fact: GraphFactRow): void {
  sql.exec(
    `INSERT INTO graph_facts
       (fact_id, node_id, predicate_id, tag_id, field_id, value_index, value_type,
        text_value, number_value, boolean_value, local_date_value, date_time_value, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    fact.factID,
    fact.nodeID,
    fact.predicateID,
    fact.tagID,
    fact.fieldID,
    fact.valueIndex,
    fact.valueType,
    fact.textValue ?? null,
    fact.numberValue ?? null,
    fact.booleanValue === undefined ? null : fact.booleanValue ? 1 : 0,
    fact.localDateValue ?? null,
    fact.dateTimeValue ?? null,
    fact.origin,
    fact.createdAt,
  );
}

function insertNodeTag(sql: SqlExecutor, row: GraphNodeTagRow): void {
  sql.exec(
    `INSERT INTO graph_node_tags (node_id, tag_id, depth, direct) VALUES (?, ?, ?, ?)`,
    row.nodeID,
    row.tagID,
    row.depth,
    row.direct ? 1 : 0,
  );
}

function insertEdge(sql: SqlExecutor, edge: GraphEdgeRow): void {
  sql.exec(
    `INSERT INTO _graph_edges (edge_id, relation_id, source_node_id, target_node_id, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    edge.edgeID,
    edge.relationID,
    edge.sourceNodeID,
    edge.targetNodeID,
    edge.origin,
    edge.createdAt,
  );
}

function insertTextSearch(sql: SqlExecutor, row: GraphTextSearchRow): void {
  sql.exec(`INSERT INTO graph_text_search (node_id, title, body) VALUES (?, ?, ?)`, row.nodeID, row.title, row.body);
}

/** Writes one `projectPage()` output — deletes this page's existing
 *  multi-row projection tables' rows first (matching Swift's
 *  replace-not-upsert pattern; `graph_nodes` is upserted instead, see
 *  `projectNode`'s doc comment), then inserts the fresh rows. */
function writeProjectedPage(sql: SqlExecutor, projected: ProjectedPage): void {
  const nodeID = projected.node.nodeID;

  projectNode(sql, projected.node);

  sql.exec("DELETE FROM graph_facts WHERE node_id = ?", nodeID);
  for (const fact of projected.facts) insertFact(sql, fact);

  sql.exec("DELETE FROM graph_node_tags WHERE node_id = ?", nodeID);
  for (const nodeTag of projected.nodeTags) insertNodeTag(sql, nodeTag);

  // Only this page's OWN (source-owned) forward edges live under its node
  // id here — see `@enchiridion/projection`'s `edges.ts` header on why
  // backlinks are never materialized.
  sql.exec("DELETE FROM _graph_edges WHERE source_node_id = ?", nodeID);
  for (const edge of projected.edges) insertEdge(sql, edge);

  sql.exec("DELETE FROM graph_text_search WHERE node_id = ?", nodeID);
  if (projected.textSearch) insertTextSearch(sql, projected.textSearch);
}

interface EdgeRow {
  edge_id: string;
  relation_id: string;
  source_node_id: string;
  target_node_id: string;
  origin: string;
  created_at: number;
  [key: string]: unknown;
}

function readAllEdges(sql: SqlExecutor): GraphEdgeRow[] {
  return sql
    .exec<EdgeRow>("SELECT edge_id, relation_id, source_node_id, target_node_id, origin, created_at FROM _graph_edges")
    .toArray()
    .map((row) => ({
      edgeID: row.edge_id,
      relationID: row.relation_id,
      sourceNodeID: row.source_node_id,
      targetNodeID: row.target_node_id,
      origin: row.origin as GraphEdgeOrigin,
      createdAt: row.created_at,
    }));
}

function readNodeInfo(sql: SqlExecutor): Map<string, GraphIssueNodeInfo> {
  const existingIDs = sql
    .exec<{ node_id: string }>("SELECT node_id FROM graph_nodes WHERE deleted_at IS NULL")
    .toArray()
    .map((r) => r.node_id);

  const tagsByNode = new Map<string, Set<string>>();
  for (const row of sql.exec<{ node_id: string; tag_id: string }>("SELECT node_id, tag_id FROM graph_node_tags").toArray()) {
    const set = tagsByNode.get(row.node_id);
    if (set) set.add(row.tag_id);
    else tagsByNode.set(row.node_id, new Set([row.tag_id]));
  }

  const info = new Map<string, GraphIssueNodeInfo>();
  for (const id of existingIDs) {
    info.set(id, { exists: true, effectiveTagIDs: tagsByNode.get(id) ?? new Set() });
  }
  return info;
}

/** Recomputes `graph_issues` wholesale from the CURRENT state of
 *  `_graph_edges`/`graph_nodes`/`graph_node_tags` — the whole-vault
 *  projection `@enchiridion/projection`'s `detectGraphIssues()` requires
 *  (see that package's `issues.ts` header: "WHOLE-VAULT, NOT PER-PAGE").
 *  Called after every page reprojection AND after a tombstone purge
 *  (`vault-write-model.ts`) since either can change whether an edge's
 *  target still resolves. Delete-all + insert-fresh (not an incremental
 *  diff) — simplest-correct at P1/single-vault scale; the plan's own
 *  `packages/projection` header notes an incremental,
 *  filtered-to-touched-relations variant is a valid future optimization
 *  (mirrors Swift's `refreshIssues(for: relationIDs:)`), not required now. */
export function refreshGraphIssues(sql: SqlExecutor, now: number): GraphIssueRow[] {
  const edges = readAllEdges(sql);
  const nodeInfo = readNodeInfo(sql);
  const issues = detectGraphIssues(edges, nodeInfo, supertagRegistry, now);

  sql.exec("DELETE FROM graph_issues");
  for (const issue of issues) {
    sql.exec(
      `INSERT INTO graph_issues (issue_id, kind, node_id, edge_id, relation_id, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      issue.issueID,
      issue.kind,
      issue.nodeID,
      issue.edgeID,
      issue.relationID,
      issue.message,
      issue.createdAt,
    );
  }
  return issues;
}

/** The full reprojection step for one page: export its hydrated doc as
 *  snapshot bytes, project them via `@enchiridion/projection`'s
 *  `projectPage()` against the worker's one loaded `SupertagRegistry`
 *  (`supertag-registry.ts`), write the result, and refresh `graph_issues`
 *  over the whole vault (this page's edges may have changed which issues
 *  exist). Callers run this inside the same SQL transaction as the
 *  doc-storage write it was triggered by (plan requirement — see
 *  `vault-write-model.ts`). `now` stamps freshly (re)detected issues'
 *  `created_at`; `modifiedAt` (the page's own "last touched" bookkeeping)
 *  is read off the doc itself via `resolveModifiedAt`, not `now` — the two
 *  are equal on the live write paths (which call `touchModifiedAt(doc,
 *  now)` immediately before this), but diverge intentionally on the
 *  boot-time drift-heal path (see `vault-write-model.ts`'s
 *  `healPageDriftIfNeeded`), which reprojects without the page having
 *  actually just been edited. */
export function reprojectPage(
  sql: SqlExecutor,
  doc: LoroPageDoc,
  pageID: string,
  docType: string,
  catalogCreatedAt: number,
  now: number,
): ProjectedPage {
  const modifiedAt = resolveModifiedAt(doc, catalogCreatedAt);
  const docBytes = doc.exportSnapshot();
  const projected = projectPage({
    pageID,
    docBytes,
    registry: supertagRegistry,
    kind: docType,
    catalogCreatedAt,
    modifiedAt,
    tagCatalog,
  });
  writeProjectedPage(sql, projected);
  refreshGraphIssues(sql, now);
  return projected;
}

// --- lastProjectedVersion bookkeeping (drift auto-heal) ---------------

interface ProjectionStateRow {
  last_projected_version_vector: ArrayBuffer;
  [key: string]: unknown;
}

export function readProjectedVersionVector(sql: SqlExecutor, pageID: string): Uint8Array | undefined {
  const row = sql
    .exec<ProjectionStateRow>(
      "SELECT last_projected_version_vector FROM projection_state WHERE page_id = ?",
      pageID,
    )
    .toArray()[0];
  return row ? new Uint8Array(row.last_projected_version_vector) : undefined;
}

export function recordProjectedVersionVector(
  sql: SqlExecutor,
  pageID: string,
  versionVector: Uint8Array,
  now: number,
): void {
  const buffer = versionVector.buffer.slice(
    versionVector.byteOffset,
    versionVector.byteOffset + versionVector.byteLength,
  ) as ArrayBuffer;
  sql.exec(
    `INSERT INTO projection_state (page_id, last_projected_version_vector, projected_at)
     VALUES (?, ?, ?)
     ON CONFLICT (page_id) DO UPDATE SET
       last_projected_version_vector = excluded.last_projected_version_vector,
       projected_at = excluded.projected_at`,
    pageID,
    buffer,
    now,
  );
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Whether `pageID`'s current doc version vector differs from what was
 *  last successfully projected — the plan's boot-time drift check
 *  ("compare a stored `lastProjectedVersion` against actual doc state and
 *  auto-heal drift by reprojecting anything behind"). Byte-inequality
 *  (rather than a true causal "is behind" comparison via `VersionVector
 *  .compare`) is a deliberate, documented simplification: identical bytes
 *  provably means identical state (safe to skip); different bytes means
 *  "something changed since last projection", which is always safe to
 *  reproject (reprojection is idempotent) even in the rare case the
 *  change was concurrent/unrelated to projected fields — reprojecting a
 *  little too eagerly is harmless, reprojecting too rarely is a
 *  correctness bug. */
export function needsReprojection(sql: SqlExecutor, pageID: string, currentVersionVector: Uint8Array): boolean {
  const last = readProjectedVersionVector(sql, pageID);
  if (!last) return true;
  return !bytesEqual(last, currentVersionVector);
}
