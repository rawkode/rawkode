// Materialized transitive-closure maintenance for `tags` (plan §"Storage & domain model":
// "tagClosure — materialized transitive closure, feeds the graph_tag_closure read-only view";
// task item 3: "when a Tag's parentIds change (or a tag is created), recompute/update the
// materialized tagClosure collection... a simple recompute-the-whole-closure-for-affected-tags
// approach is fine for Phase 1's scale... but do get it correct for multi-level inheritance
// chains, tested").
//
// Design decision: recompute the **whole workspace's** closure from scratch on every tag
// create/parent-change, not just the affected subtree. At Phase 1's scale (a personal workspace's
// supertag DAG — dozens, not millions, of tags) this is simpler and more obviously correct than
// incremental closure maintenance (no risk of an incremental-update bug silently leaving stale
// entries behind), at the cost of O(tags²) work per mutation — worth revisiting only if a later
// phase's tag count makes that cost real.
//
// Reflexivity: every tag is its own ancestor-and-descendant (`{ancestorId: t, descendantId: t}`
// is always in the closure). This isn't a special case bolted on top of the DAG walk — it's the
// base case of the walk (a 0-length path from a tag to itself) — and it's what lets a `hasTag`
// predicate (view-spec.ts) be answered uniformly as "does any of this node's own tags have
// `queriedTagId` as an ancestor-or-self in the closure", without a separate "or the node has this
// tag directly" branch.

import * as Effect from "effect/Effect"
import { EntityId, Tag, UnexpectedError } from "@athenaeum/domain"
import { collection, createEffectTypedStorage, type Collection, type NonUniqueIndex, type TypedStorageError } from "@athenaeum/typed-storage-effect"

/** One `(ancestorId, descendantId)` pair — `descendantId` inherits from `ancestorId`, directly or
 *  transitively (including the reflexive `ancestorId === descendantId` case). Backend-internal:
 *  not a domain entity (the plan describes `tagClosure` as a materialized index, not a
 *  first-class row a client ever writes), though its shape mirrors `graph-rpc.ts`'s
 *  `TagClosureEntry` wire schema exactly (see `graph-service-live.ts`'s `listTagClosure`, which
 *  maps one to the other one-for-one).
 */
export interface TagClosureRow {
  readonly id: string
  readonly ancestorId: EntityId
  readonly descendantId: EntityId
}

const tagClosureCollectionSchema = collection<TagClosureRow>()({
  primaryKey: "id",
  nonUniqueIndexes: {
    byAncestor: (row: TagClosureRow) => row.ancestorId,
    byDescendant: (row: TagClosureRow) => row.descendantId
  }
})

export interface TagClosureCollections {
  readonly tagClosure: Collection<TagClosureRow, string> & {
    readonly byAncestor: NonUniqueIndex<TagClosureRow, EntityId>
    readonly byDescendant: NonUniqueIndex<TagClosureRow, EntityId>
  }
}

export const makeTagClosureCollections = (storage: DurableObjectStorage): TagClosureCollections => {
  const typedStorage = createEffectTypedStorage(storage, {
    collections: { tagClosure: tagClosureCollectionSchema }
  })
  return { tagClosure: typedStorage.tagClosure }
}

const closureRowId = (ancestorId: EntityId, descendantId: EntityId): string => `${ancestorId}:${descendantId}`

/**
 * Pure computation: every tag's full ancestor set (itself plus every tag reachable by following
 * `parentIds` edges, however deep the DAG goes), expressed as the flat `(ancestor, descendant)`
 * pair list the `tagClosure` collection stores. Cycle-safe (a `visited` set per starting tag) even
 * though `Tag.parentIds` is not expected to ever contain a cycle in practice — defensive, not
 * load-bearing for any currently-reachable code path.
 */
export const computeTagClosure = (tags: ReadonlyArray<Tag>): ReadonlyArray<TagClosureRow> => {
  const byId = new Map<EntityId, Tag>(tags.map((tag) => [tag.id, tag]))
  const rows: Array<TagClosureRow> = []

  for (const tag of tags) {
    const visited = new Set<EntityId>()
    const stack: Array<EntityId> = [tag.id]
    while (stack.length > 0) {
      const ancestorId = stack.pop()!
      if (visited.has(ancestorId)) continue
      visited.add(ancestorId)
      rows.push({ id: closureRowId(ancestorId, tag.id), ancestorId, descendantId: tag.id })
      const ancestorTag = byId.get(ancestorId)
      if (ancestorTag) stack.push(...ancestorTag.parentIds)
    }
  }

  return rows
}

const toUnexpectedError = (error: TypedStorageError): UnexpectedError =>
  new UnexpectedError({
    message:
      error._tag === "StorageError" ? error.message : `index conflict: ${error.collection}.${error.index}`
  })

/**
 * Recomputes and persists the whole workspace's tag closure: reads every tag currently in `tags`,
 * deletes every existing `tagClosure` row, and writes the freshly computed set. Called by
 * `GraphServiceLive` after any tag create/parent change (task item 3) — never partial, always the
 * full workspace, per this module's own doc comment above.
 */
export const recomputeAndPersistTagClosure = (
  collections: TagClosureCollections,
  allTags: ReadonlyArray<Tag>
): Effect.Effect<void, UnexpectedError> =>
  Effect.gen(function* () {
    const existing = yield* collections.tagClosure.list().pipe(Effect.mapError(toUnexpectedError))
    yield* Effect.forEach(
      existing,
      (row) => collections.tagClosure.delete(row.id).pipe(Effect.mapError(toUnexpectedError)),
      { discard: true }
    )
    const fresh = computeTagClosure(allTags)
    yield* Effect.forEach(
      fresh,
      (row) => collections.tagClosure.put(row).pipe(Effect.mapError(toUnexpectedError)),
      { discard: true }
    )
  })
