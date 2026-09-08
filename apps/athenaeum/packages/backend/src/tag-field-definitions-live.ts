// Storage for `TagFieldDefinition` (domain/src/tag-field-definition.ts) — same "backend-internal
// collection, not a domain `Context.Tag` repository" pattern `tag-closure.ts`/`node-tags-live.ts`
// establish for `TagClosureRow`/`NodeTagRow` (see those files' header comments): a
// `TagFieldDefinition` row is real, workspace-wide schema (like a `Tag` or `RelationDefinition`),
// but this pass's whole point (docs/supertag-centering-decisions.md §1) is a MINIMAL new surface —
// create+list only, no edit/delete yet (see tag-field-definition.ts's own "deliberately deferred"
// note) — so a full domain `Context.Tag` repository interface (get/put/list/delete, mirroring
// `TagsRepository`) would be over-built for what `GraphService.defineTagField`/`listTagFields`
// actually need today. `GraphServiceLive` (graph-service-live.ts) consumes this collection
// directly, exactly the way it already consumes `tagClosureCollections`/`nodeTagsCollections`
// rather than going through a repository indirection for those either.
//
// No SQL read-model projection: unlike `Tag`/`RelationDefinition`/`Fact`/`Edge`, field
// DEFINITIONS are never queried through a `graph_*` view (view-spec.ts's `GraphViewName` has no
// such view) — only field VALUES are, and those are ordinary `Fact` rows already covered by the
// existing `graph_facts` read-model. This collection is therefore KV-only, the same shape
// `agent-edit-collections.ts`'s `chatBindings` collection already establishes for "real schema
// that never needs a SQL-queryable projection."

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { TreeFormatter } from "effect/ParseResult"
import { TagFieldDefinition, UnexpectedError, type EntityId } from "@athenaeum/domain"
import {
  collection,
  createEffectTypedStorage,
  type Collection,
  type NonUniqueIndex,
  type TypedStorageError
} from "@athenaeum/typed-storage-effect"

const tagFieldDefinitionsCollectionSchema = collection<TagFieldDefinition>()({
  primaryKey: "id",
  nonUniqueIndexes: {
    byTagId: (field: TagFieldDefinition) => field.tagId
  }
})

export interface TagFieldDefinitionsCollections {
  readonly tagFieldDefinitions: Collection<TagFieldDefinition, EntityId> & {
    readonly byTagId: NonUniqueIndex<TagFieldDefinition, EntityId>
  }
}

export const makeTagFieldDefinitionsCollections = (
  storage: DurableObjectStorage
): TagFieldDefinitionsCollections => {
  const typedStorage = createEffectTypedStorage(storage, {
    collections: { tagFieldDefinitions: tagFieldDefinitionsCollectionSchema }
  })
  return { tagFieldDefinitions: typedStorage.tagFieldDefinitions }
}

export const toUnexpectedError = (error: TypedStorageError): UnexpectedError =>
  new UnexpectedError({
    message:
      error._tag === "StorageError"
        ? error.message
        : `index conflict: ${error.collection}.${error.index} (key ${error.key})`
  })

/** See `nodes-repository-live.ts`'s `reviveNode` for why every record read from storage must be
 *  re-decoded into a real `Schema.Class` instance rather than trusted as structurally identical. */
export const reviveTagFieldDefinition = (raw: unknown): Effect.Effect<TagFieldDefinition, UnexpectedError> =>
  Schema.decodeUnknown(TagFieldDefinition)(raw).pipe(
    Effect.mapError(
      (parseError) =>
        new UnexpectedError({
          message: `corrupt stored tag field definition: ${TreeFormatter.formatErrorSync(parseError)}`
        })
    )
  )
