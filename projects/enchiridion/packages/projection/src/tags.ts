// @enchiridion/projection — tag catalog + inheritance-closure projection.
//
// Port of `GraphDatabase.rebuildTagClosure`
// (apps/enchiridion/Sources/EnchiridionCore/GraphDatabase.swift:378-420) and
// its `graph_tags`/`graph_tag_parents`/`graph_tag_closure`/`graph_node_tags`
// view shapes (GraphDatabase.swift:169-199). Whole-registry projections
// (not per-page) — `graph_tags`/`graph_tag_parents`/`graph_tag_closure`
// describe the tag DAG itself, computed once per loaded `SupertagRegistry`;
// `graph_node_tags` additionally needs one page's direct tag set, so it's a
// second function (`projectNodeTags`) taking that as an argument.
//
// DEPTH SEMANTICS: `depth` on a closure row is the shortest number of
// `parents` hops from descendant to ancestor (0 for a tag's closure over
// itself), matching Swift's `ancestors(of:path:)` memoized DFS, which
// takes `min(existing, parentDepth + 1)` across every path to the same
// ancestor (diamond inheritance keeps the shortest path's depth, not the
// first one found).
//
// `graph_tags.is_base`/`.sort_order`/`.deleted` HAVE NO REGISTRY
// EQUIVALENT: Swift's fixed built-in-tag list (`'person','organization',
// ...` GraphDatabase.swift:174) and its `supertag_schemas` table's runtime
// `sort_order`/`deleted` columns don't exist in this data-driven,
// as-code module system (plan §Supertag module contract: "supertags
// as-code, repo-defined" — there is no runtime tag authoring or deletion
// to track, and no user-configurable display order). `sortOrder`/`deleted`
// are therefore always `0`/`false` here; `isBase` defaults to `false` for
// every tag unless the caller passes `baseTagIDs` (e.g.
// `supertags/core`'s `CoreSupertagIDs` values, if the wiring layer wants
// the equivalent of Swift's fixed base-tag flag for its 8 ported
// supertags) — see `projectTagCatalog`'s doc comment.

import type { QualifiedSupertagDefinition, SupertagRegistry } from "@enchiridion/schema";

export interface GraphTagRow {
  tagID: string;
  name: string;
  sortOrder: number;
  deleted: boolean;
  isBase: boolean;
}

export interface GraphTagParentRow {
  tagID: string;
  parentTagID: string;
}

export interface GraphTagClosureRow {
  descendantTagID: string;
  ancestorTagID: string;
  depth: number;
}

export interface GraphNodeTagRow {
  nodeID: string;
  tagID: string;
  depth: number;
  direct: boolean;
}

export interface TagCatalogProjection {
  tags: GraphTagRow[];
  tagParents: GraphTagParentRow[];
  tagClosure: GraphTagClosureRow[];
}

/** Computes, for every supertag across the loaded registry, its full
 *  ancestor closure with depths — port of `rebuildTagClosure`'s
 *  memoized-DFS `ancestors(of:path:)` (GraphDatabase.swift:389-401).
 *  Cycle-tolerant the same way `effectiveTagIDs`/`effectiveFields`
 *  (`inheritance.ts`) are: `SupertagRegistry.build()` already rejects
 *  cyclic inheritance at registry-construction time, so this is a second,
 *  defensive line — a `path.includes(id)` cycle here simply stops
 *  descending rather than throwing, matching the sibling functions'
 *  documented cycle-tolerance rather than Swift's
 *  `GraphModelError.inheritanceCycle` throw (Swift's registry doesn't
 *  reject cycles up front the way `SupertagRegistry.build()` does — see
 *  `inheritance.ts`'s header for that divergence being intentional). */
function computeClosure(
  supertags: readonly QualifiedSupertagDefinition[],
): Map<string, Map<string, number>> {
  const byID = new Map(supertags.map((tag) => [tag.id, tag] as const));
  const closure = new Map<string, Map<string, number>>();

  function ancestorsOf(id: string, path: readonly string[]): Map<string, number> {
    const cached = closure.get(id);
    if (cached) return cached;
    const definition = byID.get(id);
    const result = new Map<string, number>([[id, 0]]);
    if (!definition || path.includes(id)) {
      closure.set(id, result);
      return result;
    }
    for (const parentID of definition.parents ?? []) {
      if (!byID.has(parentID)) continue;
      for (const [ancestorID, parentDepth] of ancestorsOf(parentID, [...path, id])) {
        const depth = parentDepth + 1;
        const existing = result.get(ancestorID);
        if (existing === undefined || depth < existing) result.set(ancestorID, depth);
      }
    }
    closure.set(id, result);
    return result;
  }

  for (const tag of supertags) ancestorsOf(tag.id, []);
  return closure;
}

/** Projects `graph_tags`/`graph_tag_parents`/`graph_tag_closure` from every
 *  supertag loaded in `registry` — a whole-registry projection, called
 *  once per registry (not per page), matching Swift's
 *  `rebuildTagClosure`'s single pass over every loaded `supertag_schemas`
 *  row. `baseTagIDs` (optional) flags rows whose id is in the set as
 *  `isBase: true` — see this file's header for why the registry itself
 *  has no such concept. */
export function projectTagCatalog(
  registry: SupertagRegistry,
  baseTagIDs: ReadonlySet<string> = new Set(),
): TagCatalogProjection {
  const supertags = registry.allSupertags();
  const closure = computeClosure(supertags);

  const tags: GraphTagRow[] = supertags.map((tag) => ({
    tagID: tag.id,
    name: tag.name,
    sortOrder: 0,
    deleted: false,
    isBase: baseTagIDs.has(tag.id),
  }));

  const tagParents: GraphTagParentRow[] = [];
  for (const tag of supertags) {
    for (const parentID of tag.parents ?? []) {
      if (!supertags.some((candidate) => candidate.id === parentID)) continue;
      tagParents.push({ tagID: tag.id, parentTagID: parentID });
    }
  }

  const tagClosure: GraphTagClosureRow[] = [];
  for (const tag of supertags) {
    const ancestors = closure.get(tag.id) ?? new Map<string, number>([[tag.id, 0]]);
    for (const [ancestorID, depth] of ancestors) {
      tagClosure.push({ descendantTagID: tag.id, ancestorTagID: ancestorID, depth });
    }
  }

  return { tags, tagParents, tagClosure };
}

/** Projects `graph_node_tags` rows for one page given its DIRECT supertag
 *  ids (from that page's `tags` container) — port of the `graph_node_tags`
 *  view's join (GraphDatabase.swift:190-199): every ancestor of every
 *  direct tag, with `direct: true` only at `depth === 0` (i.e. the tag
 *  itself), and the MINIMUM depth across every direct tag that reaches a
 *  given ancestor (matches the view's `MIN(closure.depth)` /
 *  `MAX(CASE WHEN closure.depth = 0 ...)` aggregation, which is exactly
 *  what a `Map`-keyed-by-ancestor accumulation with `Math.min` reproduces
 *  for one node). `closure` is the same whole-registry closure
 *  `projectTagCatalog` computed — pass its `tagClosure` rows (or recompute
 *  via `projectTagCatalog(registry)` and reuse) rather than recomputing
 *  the DAG per page. */
export function projectNodeTags(
  nodeID: string,
  directTagIDs: readonly string[],
  tagClosure: readonly GraphTagClosureRow[],
): GraphNodeTagRow[] {
  const closureByDescendant = new Map<string, GraphTagClosureRow[]>();
  for (const row of tagClosure) {
    const list = closureByDescendant.get(row.descendantTagID);
    if (list) list.push(row);
    else closureByDescendant.set(row.descendantTagID, [row]);
  }

  const best = new Map<string, number>();
  for (const directTagID of directTagIDs) {
    for (const row of closureByDescendant.get(directTagID) ?? []) {
      const existing = best.get(row.ancestorTagID);
      if (existing === undefined || row.depth < existing) best.set(row.ancestorTagID, row.depth);
    }
  }

  return [...best.entries()]
    .map(([tagID, depth]) => ({ nodeID, tagID, depth, direct: depth === 0 }))
    .sort((a, b) => a.tagID.localeCompare(b.tagID));
}
