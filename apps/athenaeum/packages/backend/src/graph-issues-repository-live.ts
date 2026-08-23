// Same pattern as `tags-repository-live.ts`. No secondary indexes — `GraphServiceLive` only ever
// lists the whole workspace's issues (`listGraphIssues`) or looks one up by id.

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { TreeFormatter } from "effect/ParseResult"
import {
  GraphIssue,
  GraphIssueNotFound,
  GraphIssuesRepository,
  UnexpectedError,
  type EntityId
} from "@athenaeum/domain"
import { collection, createEffectTypedStorage, type Collection, type TypedStorageError } from "@athenaeum/typed-storage-effect"

const graphIssuesCollectionSchema = collection<GraphIssue>()({
  primaryKey: "id"
})

export interface GraphIssuesCollections {
  readonly graphIssues: Collection<GraphIssue, EntityId>
}

export const makeGraphIssuesCollections = (storage: DurableObjectStorage): GraphIssuesCollections => {
  const typedStorage = createEffectTypedStorage(storage, {
    collections: { graphIssues: graphIssuesCollectionSchema }
  })
  return { graphIssues: typedStorage.graphIssues }
}

const toUnexpectedError = (error: TypedStorageError): UnexpectedError =>
  new UnexpectedError({
    message:
      error._tag === "StorageError"
        ? error.message
        : `index conflict: ${error.collection}.${error.index} (key ${error.key})`
  })

export const reviveGraphIssue = (raw: unknown): Effect.Effect<GraphIssue, UnexpectedError> =>
  Schema.decodeUnknown(GraphIssue)(raw).pipe(
    Effect.mapError(
      (parseError) =>
        new UnexpectedError({
          message: `corrupt stored graphIssue: ${TreeFormatter.formatErrorSync(parseError)}`
        })
    )
  )

export const makeGraphIssuesRepositoryLive = (
  collections: GraphIssuesCollections
): Layer.Layer<GraphIssuesRepository> =>
  Layer.succeed(GraphIssuesRepository, {
    get: (graphIssueId) =>
      collections.graphIssues.get(graphIssueId).pipe(
        Effect.mapError(toUnexpectedError),
        Effect.flatMap(
          (maybe): Effect.Effect<GraphIssue, GraphIssueNotFound | UnexpectedError> =>
            maybe === undefined ? Effect.fail(new GraphIssueNotFound({ graphIssueId })) : reviveGraphIssue(maybe)
        )
      ),
    put: (graphIssue) =>
      collections.graphIssues.put(graphIssue).pipe(Effect.mapError(toUnexpectedError), Effect.as(graphIssue)),
    list: (_workspaceId) =>
      collections.graphIssues.list().pipe(
        Effect.mapError(toUnexpectedError),
        Effect.flatMap((raw) => Effect.forEach(raw, reviveGraphIssue))
      )
  })
