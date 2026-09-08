// Same pattern as `facts-repository-live.ts`. Two non-unique indexes (task item 1: "edges by
// sourceNodeId and by targetNodeId for the backlinks feature") — `bySourceNodeId` backs
// `GraphServiceLive`'s cardinality-conflict check (all edges a given source already has under a
// given `RelationDefinition`), `byTargetNodeId` backs `listBacklinks` (plan: "Backlinks are a
// query (non-unique index target→edges), never a second stored record").

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { TreeFormatter } from "effect/ParseResult"
import { Edge, EdgeNotFound, EdgesRepository, UnexpectedError, type EntityId } from "@athenaeum/domain"
import { collection, createEffectTypedStorage, type Collection, type NonUniqueIndex, type TypedStorageError } from "@athenaeum/typed-storage-effect"

const edgesCollectionSchema = collection<Edge>()({
  primaryKey: "id",
  nonUniqueIndexes: {
    bySourceNodeId: (edge: Edge) => edge.sourceNodeId,
    byTargetNodeId: (edge: Edge) => edge.targetNodeId,
    // Phase 3 addition — see `nodes-repository-live.ts`'s identically-named index for the
    // rationale.
    byPendingChatId: (edge: Edge) => edge.pending?.chatId ?? null
  }
})

export interface EdgesCollections {
  readonly edges: Collection<Edge, EntityId> & {
    readonly bySourceNodeId: NonUniqueIndex<Edge, EntityId>
    readonly byTargetNodeId: NonUniqueIndex<Edge, EntityId>
    readonly byPendingChatId: NonUniqueIndex<Edge, EntityId>
  }
}

export const makeEdgesCollections = (storage: DurableObjectStorage): EdgesCollections => {
  const typedStorage = createEffectTypedStorage(storage, { collections: { edges: edgesCollectionSchema } })
  return { edges: typedStorage.edges }
}

const toUnexpectedError = (error: TypedStorageError): UnexpectedError =>
  new UnexpectedError({
    message:
      error._tag === "StorageError"
        ? error.message
        : `index conflict: ${error.collection}.${error.index} (key ${error.key})`
  })

export const reviveEdge = (raw: unknown): Effect.Effect<Edge, UnexpectedError> =>
  Schema.decodeUnknown(Edge)(raw).pipe(
    Effect.mapError(
      (parseError) =>
        new UnexpectedError({ message: `corrupt stored edge: ${TreeFormatter.formatErrorSync(parseError)}` })
    )
  )

export const makeEdgesRepositoryLive = (collections: EdgesCollections): Layer.Layer<EdgesRepository> =>
  Layer.succeed(EdgesRepository, {
    get: (edgeId) =>
      collections.edges.get(edgeId).pipe(
        Effect.mapError(toUnexpectedError),
        Effect.flatMap(
          (maybeEdge): Effect.Effect<Edge, EdgeNotFound | UnexpectedError> =>
            maybeEdge === undefined ? Effect.fail(new EdgeNotFound({ edgeId })) : reviveEdge(maybeEdge)
        )
      ),
    put: (edge) => collections.edges.put(edge).pipe(Effect.mapError(toUnexpectedError), Effect.as(edge)),
    list: (_workspaceId) =>
      collections.edges.list().pipe(
        Effect.mapError(toUnexpectedError),
        Effect.flatMap((rawEdges) => Effect.forEach(rawEdges, reviveEdge)),
        // Phase 3 addition — same mainline-visibility guarantee as `NodesRepository.list` above.
        Effect.map((edges) => edges.filter((edge) => edge.pending === undefined))
      ),
    delete: (edgeId) => collections.edges.delete(edgeId).pipe(Effect.mapError(toUnexpectedError), Effect.asVoid)
  })
