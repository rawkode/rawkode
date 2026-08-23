// Node-tag membership storage — same "backend-internal collection, not a domain `Context.Tag`
// repository" pattern `tag-closure.ts` establishes for `TagClosureRow` (see that file's header
// comment): the plan doesn't name a `nodeTags`/membership collection explicitly (`Node`'s own
// `primaryTagIds[]` field is Phase-0-deferred, per node.ts's doc comment), but `graph_node_tags`
// (view-spec.ts's `GraphViewName`) and the `hasTag` `ViewPredicate` op both need a real
// node-to-tag membership relation to query against — see `graph-rpc.ts`'s `AssignTagInput` doc
// comment for the full "why this stage added it, and why here rather than widening `Node`"
// reasoning.
//
// Canonical storage is this `typed-storage-effect` collection (KV, like every other collection);
// `read-model.ts`'s `rm_node_tags`/`graph_node_tags` is a derived, parallel SQL projection of it,
// written alongside every `put` here — same split as every other entity in this stage.

import { UnexpectedError, type EntityId } from "@athenaeum/domain"
import {
  collection,
  createEffectTypedStorage,
  type Collection,
  type NonUniqueIndex,
  type TypedStorageError
} from "@athenaeum/typed-storage-effect"

export interface NodeTagRow {
  readonly id: string
  readonly nodeId: EntityId
  readonly tagId: EntityId
}

const nodeTagsCollectionSchema = collection<NodeTagRow>()({
  primaryKey: "id",
  nonUniqueIndexes: {
    byNodeId: (row: NodeTagRow) => row.nodeId,
    byTagId: (row: NodeTagRow) => row.tagId
  }
})

export interface NodeTagsCollections {
  readonly nodeTags: Collection<NodeTagRow, string> & {
    readonly byNodeId: NonUniqueIndex<NodeTagRow, EntityId>
    readonly byTagId: NonUniqueIndex<NodeTagRow, EntityId>
  }
}

export const makeNodeTagsCollections = (storage: DurableObjectStorage): NodeTagsCollections => {
  const typedStorage = createEffectTypedStorage(storage, {
    collections: { nodeTags: nodeTagsCollectionSchema }
  })
  return { nodeTags: typedStorage.nodeTags }
}

/** A `(nodeId, tagId)` pair assigns at most one row — deterministic composite key, so
 *  re-assigning the same tag to the same node is naturally idempotent (a `put` with the same key
 *  just overwrites itself) rather than accumulating duplicate rows. */
export const nodeTagRowId = (nodeId: EntityId, tagId: EntityId): string => `${nodeId}:${tagId}`

export const nodeTagsToUnexpectedError = (error: TypedStorageError): UnexpectedError =>
  new UnexpectedError({
    message:
      error._tag === "StorageError"
        ? error.message
        : `index conflict: ${error.collection}.${error.index} (key ${error.key})`
  })
