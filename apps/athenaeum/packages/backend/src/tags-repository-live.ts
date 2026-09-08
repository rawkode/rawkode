// Adapts `typed-storage-effect`'s Effect-wrapped DO-SQLite collection to `@athenaeum/domain`'s
// `TagsRepository` `Context.Tag` interface — same pattern as `nodes-repository-live.ts` (see that
// file's header comment for the overall convention this mirrors).

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { TreeFormatter } from "effect/ParseResult"
import { Tag as TagEntity, TagNotFound, TagsRepository, UnexpectedError, type EntityId } from "@athenaeum/domain"
import { collection, createEffectTypedStorage, type Collection, type TypedStorageError } from "@athenaeum/typed-storage-effect"

const tagsCollectionSchema = collection<TagEntity>()({
  primaryKey: "id"
})

export interface TagsCollections {
  readonly tags: Collection<TagEntity, EntityId>
}

export const makeTagsCollections = (storage: DurableObjectStorage): TagsCollections => {
  const typedStorage = createEffectTypedStorage(storage, { collections: { tags: tagsCollectionSchema } })
  return { tags: typedStorage.tags }
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
export const reviveTag = (raw: unknown): Effect.Effect<TagEntity, UnexpectedError> =>
  Schema.decodeUnknown(TagEntity)(raw).pipe(
    Effect.mapError(
      (parseError) =>
        new UnexpectedError({ message: `corrupt stored tag: ${TreeFormatter.formatErrorSync(parseError)}` })
    )
  )

export const makeTagsRepositoryLive = (collections: TagsCollections): Layer.Layer<TagsRepository> =>
  Layer.succeed(TagsRepository, {
    get: (tagId) =>
      collections.tags.get(tagId).pipe(
        Effect.mapError(toUnexpectedError),
        Effect.flatMap(
          (maybeTag): Effect.Effect<TagEntity, TagNotFound | UnexpectedError> =>
            maybeTag === undefined ? Effect.fail(new TagNotFound({ tagId })) : reviveTag(maybeTag)
        )
      ),
    put: (tag) =>
      collections.tags.put(tag).pipe(
        Effect.mapError(toUnexpectedError),
        Effect.as(tag)
      ),
    // `workspaceId` is accepted for interface symmetry only (see `TagsRepository`'s own doc comment
    // in domain): storage is already workspace-scoped by which `WorkspaceDurableObject` instance owns
    // this collection, so every row in it belongs to the caller's workspace by construction.
    list: (_workspaceId) =>
      collections.tags.list().pipe(
        Effect.mapError(toUnexpectedError),
        Effect.flatMap((rawTags) => Effect.forEach(rawTags, reviveTag))
      )
  })
