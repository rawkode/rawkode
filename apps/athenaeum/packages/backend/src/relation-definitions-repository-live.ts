// Same pattern as `tags-repository-live.ts`. No secondary indexes needed — `GraphServiceLive`
// only ever looks relation definitions up by id (`get`) or lists the whole workspace's set.

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { TreeFormatter } from "effect/ParseResult"
import {
  RelationDefinition,
  RelationDefinitionNotFound,
  RelationDefinitionsRepository,
  UnexpectedError,
  type EntityId
} from "@athenaeum/domain"
import { collection, createEffectTypedStorage, type Collection, type TypedStorageError } from "@athenaeum/typed-storage-effect"

const relationDefinitionsCollectionSchema = collection<RelationDefinition>()({
  primaryKey: "id"
})

export interface RelationDefinitionsCollections {
  readonly relationDefinitions: Collection<RelationDefinition, EntityId>
}

export const makeRelationDefinitionsCollections = (
  storage: DurableObjectStorage
): RelationDefinitionsCollections => {
  const typedStorage = createEffectTypedStorage(storage, {
    collections: { relationDefinitions: relationDefinitionsCollectionSchema }
  })
  return { relationDefinitions: typedStorage.relationDefinitions }
}

const toUnexpectedError = (error: TypedStorageError): UnexpectedError =>
  new UnexpectedError({
    message:
      error._tag === "StorageError"
        ? error.message
        : `index conflict: ${error.collection}.${error.index} (key ${error.key})`
  })

export const reviveRelationDefinition = (raw: unknown): Effect.Effect<RelationDefinition, UnexpectedError> =>
  Schema.decodeUnknown(RelationDefinition)(raw).pipe(
    Effect.mapError(
      (parseError) =>
        new UnexpectedError({
          message: `corrupt stored relationDefinition: ${TreeFormatter.formatErrorSync(parseError)}`
        })
    )
  )

export const makeRelationDefinitionsRepositoryLive = (
  collections: RelationDefinitionsCollections
): Layer.Layer<RelationDefinitionsRepository> =>
  Layer.succeed(RelationDefinitionsRepository, {
    get: (relationDefinitionId) =>
      collections.relationDefinitions.get(relationDefinitionId).pipe(
        Effect.mapError(toUnexpectedError),
        Effect.flatMap(
          (maybe): Effect.Effect<RelationDefinition, RelationDefinitionNotFound | UnexpectedError> =>
            maybe === undefined
              ? Effect.fail(new RelationDefinitionNotFound({ relationDefinitionId }))
              : reviveRelationDefinition(maybe)
        )
      ),
    put: (relationDefinition) =>
      collections.relationDefinitions
        .put(relationDefinition)
        .pipe(Effect.mapError(toUnexpectedError), Effect.as(relationDefinition)),
    list: (_workspaceId) =>
      collections.relationDefinitions.list().pipe(
        Effect.mapError(toUnexpectedError),
        Effect.flatMap((raw) => Effect.forEach(raw, reviveRelationDefinition))
      )
  })
