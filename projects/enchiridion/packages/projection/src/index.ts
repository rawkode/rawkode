// @enchiridion/projection — Loro doc -> graph-view row-set extraction.
//
// See /Users/rawkode/.claude/plans/cheeky-greeting-lampson.md, plan
// §Backend architecture ("Projection tables") and §Phasing P1, plus the
// full semantic contract in
// apps/enchiridion/Documentation/GraphDataModel.md. This package turns one
// page's raw Loro snapshot bytes, plus the vault's loaded
// `SupertagRegistry` (`@enchiridion/schema`), into plain row objects for
// every table/view in that contract's public surface:
// `graph_nodes`, `graph_tags`, `graph_tag_parents`, `graph_tag_closure`,
// `graph_node_tags`, `graph_facts`, `graph_relation_definitions`,
// `graph_edges`, `graph_issues`, and FTS-ready text for
// `graph_text_search`. It does NOT execute any SQL itself — per the task
// brief, the target consumer is DO SQLite inside VaultDO, and wiring these
// rows into actual `INSERT`s against VaultDO's own storage is a SEPARATE
// follow-up task (this package must not, and does not, touch
// `workers/vault`). See "WIRING NOTES FOR THE FOLLOW-UP TASK" at the
// bottom of this file for exactly what that task needs to do.
//
// WHOLE-PAGE vs. WHOLE-REGISTRY vs. WHOLE-VAULT: three different scopes,
// three different entry points, matching the shape the old app's
// `GraphDatabase`/`GraphProjectionStore` split across "install" (whole
// registry, once), "replacePage" (one page, on every doc write), and
// "refreshIssues" (whole vault, cross-page):
//   - `projectPage()` — one page's doc bytes -> that page's own rows
//     (`graph_nodes`, `graph_facts`, `graph_edges`, `graph_text_search`,
//     plus that page's `graph_node_tags` slice). Call once per doc write,
//     matching the plan's synchronous-per-write reprojection requirement.
//   - `projectTagCatalog()` (`tags.ts`) / `projectRelationDefinitions()`
//     (`edges.ts`) — the whole loaded `SupertagRegistry` ->
//     `graph_tags`/`graph_tag_parents`/`graph_tag_closure`/
//     `graph_relation_definitions`. Call once per registry
//     load/module-deploy (these describe the schema DAG, not any one
//     page's content) — matches Swift's `rebuildTagClosure`/`saveRelation`
//     running at database install, not per page.
//   - `detectGraphIssues()` (`issues.ts`) — every accumulated forward edge
//     across the WHOLE vault, plus every referenced node's
//     existence/effective-tag info -> `graph_issues`. Inherently
//     cross-page (an edge's cardinality/target-existence can only be
//     judged against every other edge for the same relation and every
//     node's live state), matching Swift's `refreshIssues` operating over
//     the entire `_graph_edges` table.
//
// SYNCHRONOUS: every function in this package is synchronous (no
// `crypto.subtle` calls, unlike `graph-core`'s PageID digests) — see
// `facts.ts`'s header for why, and because the plan requires reprojection
// to run "synchronously, in the same DO SQLite transaction as the
// doc-storage write" (§Backend architecture).

import { predicateId } from "@enchiridion/graph-core";
import type { SupertagRegistry } from "@enchiridion/schema";
import { booleanField, openProjectionDoc, PageContainer, shallowMap, stringField } from "./doc";
import { decodeEdgeEntry, type GraphEdgeRow } from "./edges";
import { extractBodyText, type FormattingMarkRun, type PageReference } from "./text";
import { projectFacts, type GraphFactRow } from "./facts";
import { projectNodeTags, projectTagCatalog, type GraphNodeTagRow, type TagCatalogProjection } from "./tags";

export type { LoroDoc, LoroMap, LoroText } from "./doc";
export { booleanField, openProjectionDoc, PageContainer, shallowMap, stringField } from "./doc";

export type { SupertagValue, SupertagValueType } from "./values";
export {
  decodePropertyValues,
  encodePropertyValues,
  parsePropertyStorageKey,
  propertyStorageKey,
} from "./values";

export type { BodyTextExtraction, FormattingMarkRun, PageReference } from "./text";
export { encodePageReferencePayload, extractBodyText, FORMATTING_MARK_STYLES } from "./text";

export type { GraphEdgeOrigin, GraphEdgeRow, GraphRelationDefinitionRow } from "./edges";
export { buildEdgeEntry, cardinalityEndpoints, decodeEdgeEntry, projectRelationDefinitions } from "./edges";

export type { GraphFactOrigin, GraphFactRow, GraphValueType } from "./facts";
export { projectFacts } from "./facts";

export type {
  GraphNodeTagRow,
  GraphTagClosureRow,
  GraphTagParentRow,
  GraphTagRow,
  TagCatalogProjection,
} from "./tags";
export { projectNodeTags, projectTagCatalog } from "./tags";

export type { GraphIssueKind, GraphIssueNodeInfo, GraphIssueRow } from "./issues";
export { detectGraphIssues } from "./issues";

/** `graph_nodes` row — matches the old app's public view column-for-column
 *  (apps/enchiridion/Sources/EnchiridionCore/GraphDatabase.swift:156-167).
 *  `kind`/`createdAt` are NOT read from the doc — see `ProjectPageInput`'s
 *  doc comment for why.
 *
 *  `personVisibility`/`personOrigin` — PRIVACY GATE (adversarial review
 *  finding, plan §Gadgets P4: "the P2 privacy classification for
 *  calendar-attendee Person pages lives only at the materialization layer
 *  and has no enforcement at the query layer"). These mirror
 *  `workers/gatekeeper-google/src/materialized-doc.ts`'s
 *  `setPersonClassificationIfMissing` exactly: read off the doc's
 *  `objectMetadata` root container (NOT a supertag field — see that
 *  file's header for why: bookkeeping about the page, not user-authored
 *  data), values `"other"`/`"promoted"` for visibility and
 *  `"calendarAttendee"`/`"gmailCorrespondent"`/etc. for origin. `undefined`
 *  for the overwhelming majority of pages, which are not Person pages
 *  materialized from an external provider and never had this container's
 *  keys set at all — this is a passthrough of whatever's present, not a
 *  Person-specific code path (this package has no concept of "the Person
 *  supertag"). Consumers that need to enforce the privacy gate (see
 *  `workers/vault/src/supertag-accessors.ts`'s `SupertagAccessorFilterOptions`)
 *  filter on this value; consumers that don't care (most of `graph_nodes`'s
 *  own columns) simply ignore it. */
export interface GraphNodeRow {
  nodeID: string;
  title: string;
  plainText: string;
  kind: string;
  createdAt: number;
  modifiedAt: number;
  deletedAt?: number;
  isPinned: boolean;
  personVisibility?: string;
  personOrigin?: string;
}

/** One `graph_text_search` FTS5 input row — `{nodeID, title, body}`,
 *  matching `graph_text_search`'s columns
 *  (GraphDatabase.swift:112-114). `undefined` when the page is deleted,
 *  matching Swift's `if page.deletedAt == nil { INSERT INTO
 *  graph_text_search ... }` (GraphProjectionStore.replacePage,
 *  GraphDatabase.swift:477-482) — a deleted page has no FTS row at all,
 *  not a tombstoned one. */
export interface GraphTextSearchRow {
  nodeID: string;
  title: string;
  body: string;
}

export interface ProjectPageInput {
  pageID: string;
  /** A page's exported Loro snapshot bytes (`LoroDoc.export({mode:
   *  "snapshot"})` / `exportSnapshot()`, matching
   *  `workers/vault/src/loro-storage.ts`'s `LoroPageDoc.exportSnapshot()`
   *  output shape) — NOT update/diff bytes. */
  docBytes: Uint8Array;
  registry: SupertagRegistry;
  /** The vault catalog's `docType` for this page — NOT read from the doc
   *  itself. Mirrors the established VaultDO convention documented in
   *  `workers/vault/src/projection.ts`'s `extractNodeFields`: "kind ...
   *  come[s] from the vault-meta catalog entry ... duplicating that as an
   *  independently-editable field inside every page's own doc would just
   *  create a second place for it to drift from the catalog." */
  kind: string;
  /** The vault catalog's `createdAt` for this page (epoch ms) — same
   *  catalog-is-authoritative rationale as `kind`. */
  catalogCreatedAt: number;
  /** Worker-owned "last touched" bookkeeping (epoch ms) — NOT part of the
   *  doc's canonical schema, same convention as `workers/vault/src/
   *  projection.ts`'s `system.modifiedAt` (that file's header: "written by
   *  vault-do.ts's createOrUpdatePage RPC as its own small local edit").
   *  Passed in rather than read from the doc for the same reason `kind`/
   *  `catalogCreatedAt` are: this package has no opinion on where a
   *  worker keeps its own bookkeeping keys, only on what the doc's own
   *  five containers (`root`/`objectMetadata`/`tags`/`values`/`edges`)
   *  mean. */
  modifiedAt: number;
  /** Precomputed whole-registry tag catalog (`projectTagCatalog(registry)`)
   *  — pass this when projecting many pages against the same registry so
   *  the tag-closure DAG isn't recomputed per page. Computed internally
   *  when omitted. */
  tagCatalog?: TagCatalogProjection;
}

export interface ProjectedPage {
  node: GraphNodeRow;
  /** This page's OWN (non-inherited) supertag ids, from its `tags`
   *  container — exposed for callers that need it independently of
   *  `nodeTags` (e.g. to recompute `nodeTags` later without reopening the
   *  doc, via `projectNodeTags` directly). */
  directTagIDs: string[];
  /** This page's full `graph_node_tags` slice (direct + inherited, with
   *  depth) — see `tags.ts`'s `projectNodeTags`. */
  nodeTags: GraphNodeTagRow[];
  facts: GraphFactRow[];
  /** Forward canonical edges this page owns as source. See `edges.ts`'s
   *  header for why backlinks are never produced here — they are a
   *  query-time VIEW projection, not a second stored row (see "WIRING
   *  NOTES" below). */
  edges: GraphEdgeRow[];
  /** `undefined` for a deleted page — see `GraphTextSearchRow`'s doc
   *  comment. */
  textSearch: GraphTextSearchRow | undefined;
  /** Page-reference marks found in the body text, deduplicated by target.
   *  NOT mapped to `graph_edges` rows by this package — see "SCOPE
   *  BOUNDARY: inline-reference (@mention) edges" below. Exposed so a
   *  caller (or a follow-up task) can build that mapping once a relation
   *  convention for it exists. */
  references: PageReference[];
  formattingMarks: FormattingMarkRun[];
}

function parseDateMs(iso: string): number | undefined {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Projects one page's Loro doc bytes into every per-page row-set in the
 *  public-view contract. See this file's header for what's whole-registry
 *  or whole-vault instead (call those separately). */
export function projectPage(input: ProjectPageInput): ProjectedPage {
  const doc = openProjectionDoc(input.docBytes);

  const root = shallowMap(doc.getMap(PageContainer.root));
  const isPinned = booleanField(root, "isPinned") ?? false;
  const deletedAtRaw = stringField(root, "deletedAt");
  const deletedAt = deletedAtRaw ? parseDateMs(deletedAtRaw) : undefined;

  const title = doc.getText(PageContainer.title).toString();
  const { plainText, references, formattingMarks } = extractBodyText(
    doc.getText(PageContainer.body),
    input.pageID,
  );

  // PRIVACY GATE extraction — see `GraphNodeRow`'s doc comment above.
  // `objectMetadata` was previously declared in `doc.ts` "for parity ...
  // but not read by this package yet" — this is that follow-up. Absent
  // for every page that isn't a materialized Person page (the normal
  // case), present (`"other"`/`"calendarAttendee"` by default, never
  // auto-promoted) for one born from `gatekeeper-google`'s calendar/Gmail
  // ingest — see `materialized-doc.ts`'s header for the full writer-side
  // contract this reads.
  const objectMetadata = shallowMap(doc.getMap(PageContainer.objectMetadata));
  const personVisibility = stringField(objectMetadata, "personVisibility");
  const personOrigin = stringField(objectMetadata, "personOrigin");

  const tagsMap = shallowMap(doc.getMap(PageContainer.tags));
  const directTagIDs = Object.entries(tagsMap)
    .filter(([, value]) => value === true)
    .map(([tagID]) => tagID)
    .sort();

  const rawValues: Record<string, string> = {};
  for (const [key, value] of Object.entries(shallowMap(doc.getMap(PageContainer.values)))) {
    if (typeof value === "string") rawValues[key] = value;
  }
  const facts = projectFacts(input.pageID, directTagIDs, rawValues, input.registry, input.catalogCreatedAt);

  const edges: GraphEdgeRow[] = [];
  for (const value of Object.values(shallowMap(doc.getMap(PageContainer.edges)))) {
    if (typeof value !== "string") continue;
    const decoded = decodeEdgeEntry(value, input.pageID);
    if (decoded) edges.push(decoded);
  }
  edges.sort((a, b) => a.edgeID.localeCompare(b.edgeID));

  const tagCatalog = input.tagCatalog ?? projectTagCatalog(input.registry);
  const nodeTags = projectNodeTags(input.pageID, directTagIDs, tagCatalog.tagClosure);

  const node: GraphNodeRow = {
    nodeID: input.pageID,
    title,
    plainText,
    kind: input.kind,
    createdAt: input.catalogCreatedAt,
    modifiedAt: input.modifiedAt,
    deletedAt,
    isPinned,
    personVisibility,
    personOrigin,
  };

  return {
    node,
    directTagIDs,
    nodeTags,
    facts,
    edges,
    textSearch: deletedAt === undefined ? { nodeID: input.pageID, title, body: plainText } : undefined,
    references,
    formattingMarks,
  };
}

/** Convenience re-export: the exact storage-key/predicate-id format the
 *  `values` container and `graph_facts.predicate_id` share — see
 *  `values.ts`'s header. */
export { predicateId };

// ---------------------------------------------------------------------------
// SCOPE BOUNDARY: inline-reference (@mention) edges
// ---------------------------------------------------------------------------
//
// Swift's `GraphProjectionStore.replaceMentions`
// (GraphDatabase.swift:485-511) turns every page-reference mark into a
// `GraphEdgeOrigin.inlineReference`-origin edge against a fixed built-in
// `BuiltInRelations.mentions` relation id. This package's `extractBodyText`
// (`text.ts`) extracts the SAME page-reference marks (exposed as
// `ProjectedPage.references`), but deliberately does NOT convert them into
// `graph_edges` rows here. Reason: `BuiltInRelations.mentions` was a fixed,
// hardcoded relation in Swift's closed built-in set; this module system is
// data-driven (plan §Supertag module contract) and has no equivalent
// "the" mentions relation — `supertags/core`'s own `mentions` relation
// (index.ts) is one module's choice among possibly several loaded modules,
// not a guaranteed universal identity this package could reference without
// hardcoding a specific module's namespace into a supposedly
// module-agnostic package. Resolving that — either a registry-level
// convention for "the" inline-reference relation, or a caller-supplied
// relation id parameter — is left to a follow-up task; `references` is
// exposed precisely so that task doesn't need to re-implement the delta
// walk.
//
// ---------------------------------------------------------------------------
// WIRING NOTES FOR THE FOLLOW-UP TASK (VaultDO integration)
// ---------------------------------------------------------------------------
//
// This package produces plain row objects; nothing here executes SQL. The
// follow-up task (explicitly out of scope for this one — `workers/vault`
// is untouched) needs to:
//
// 1. Call `projectPage()` once per doc write inside the same DO SQLite
//    transaction as the doc-storage write (plan requirement), after
//    `DELETE`ing that page's existing rows from `graph_nodes`/
//    `graph_facts`/the edge-storage table/`graph_node_tags` (matching
//    Swift's replace-not-upsert pattern, GraphDatabase.swift:430-434) and
//    before re-`INSERT`ing this call's output.
//
// 2. Call `projectTagCatalog()`/`projectRelationDefinitions()` once per
//    registry load (module deploy / VaultDO boot), replacing
//    `graph_tags`/`graph_tag_parents`/`graph_tag_closure`/
//    `graph_relation_definitions` wholesale — these describe the schema
//    DAG, not page content.
//
// 3. Accumulate every page's `edges` output plus live node
//    existence/effective-tag info, and call `detectGraphIssues()` to
//    (re)populate `graph_issues` — either on every write (small vaults) or
//    incrementally, filtered to the touched relations' edges (mirrors
//    Swift's `refreshIssues(for: relationIDs:)`, GraphDatabase.swift:
//    531-565).
//
// 4. FIX `workers/vault/src/schema.ts`'s DDL to match this package's
//    output — two corrections needed there (not made here; that file is
//    off-limits to this task):
//
//    a. `graph_edges` is currently a plain TABLE with `direction`/
//       `relationship_name`/`canonical_source_node_id`/
//       `canonical_target_node_id` columns baked in — i.e. it looks
//       shaped to hold BOTH forward and inverse rows physically. Per
//       GraphDataModel.md's evolution rule #3 ("Never materialize
//       backlinks as independently editable data") and the old app's own
//       `_graph_edges` (private, forward-only TABLE) /
//       `graph_edges` (public VIEW, UNION ALL of forward + inverse) split
//       (GraphDatabase.swift:67-77, 216-244), that table needs to become:
//         - a private storage table (e.g. rename to `_graph_edges`, or
//           keep `graph_edges` as the name and introduce a new private
//           one — naming is the wiring task's call) holding exactly this
//           package's `GraphEdgeRow` shape (`edge_id`, `relation_id`,
//           `source_node_id`, `target_node_id`, `origin`, `created_at`) —
//           forward rows only, one row per edge, ever;
//         - a public `graph_edges` VIEW computing the inverse at query
//           time. The exact SQL (a direct port of
//           GraphDatabase.swift:216-244, joined against
//           `graph_relation_definitions` for `forward_name`/
//           `inverse_name`):
//
//         CREATE VIEW graph_edges AS
//         SELECT e.edge_id,
//                e.source_node_id AS from_node_id,
//                e.target_node_id AS to_node_id,
//                e.relation_id,
//                r.forward_name AS relationship_name,
//                'forward' AS direction,
//                e.source_node_id AS canonical_source_node_id,
//                e.target_node_id AS canonical_target_node_id,
//                e.origin,
//                e.created_at
//         FROM _graph_edges e
//         JOIN graph_relation_definitions r ON r.relation_id = e.relation_id
//         UNION ALL
//         SELECT e.edge_id,
//                e.target_node_id AS from_node_id,
//                e.source_node_id AS to_node_id,
//                e.relation_id,
//                r.inverse_name AS relationship_name,
//                'inverse' AS direction,
//                e.source_node_id AS canonical_source_node_id,
//                e.target_node_id AS canonical_target_node_id,
//                e.origin,
//                e.created_at
//         FROM _graph_edges e
//         JOIN graph_relation_definitions r ON r.relation_id = e.relation_id;
//
//    b. `graph_relation_definitions`'s `targets_per_source`/
//       `sources_per_target` columns are declared `INTEGER` in
//       `workers/vault/src/schema.ts` — this package emits `"one" |
//       "many"` STRINGS for those fields (matching the old app's TEXT
//       columns, GraphDatabase.swift:12), so the DDL needs those two
//       columns changed to `TEXT`.
//
// Everything else in `PROJECTION_VIEW_NAMES`
// (`workers/vault/src/schema.ts`) already matches this package's row
// shapes column-for-column and needs no DDL change.
//
// UPDATE (P4 privacy-gate fix, done in the follow-up task, not here):
// `GraphNodeRow` gained `personVisibility`/`personOrigin` (optional
// strings) — `workers/vault/src/schema.ts`'s `graph_nodes` DDL gained two
// matching nullable `TEXT` columns (`person_visibility`, `person_origin`),
// added via the guarded-`ALTER TABLE` pattern
// `workers/gatekeeper-google/src/schema.ts`'s `addGrantedScopesColumnIfMissing`
// established, and `projection.ts`'s `projectNode()` now writes them
// through. See `workers/vault/src/supertag-accessors.ts`'s
// `SupertagAccessorFilterOptions` for the query-layer enforcement this
// makes possible.
