// Same pattern as `tags-repository-live.ts`/`nodes-repository-live.ts`. Adds a `byNodeId`
// non-unique index (task item 1: "Add appropriate indexes (e.g. facts by nodeId...)") — not used
// by the `FactsRepository` `Context.Tag` interface itself (which only needs get/put/list, per
// domain's own doc comment: a per-node lookup is a `ViewSpec` filter, not a repository method),
// but exposed on `FactsCollections` for `GraphServiceLive` to query directly, the same way
// `nodes-subscription.ts` reaches past `NodesRepository` to use `WorkspaceCollections.nodes.byWorkspaceId`
// directly when it needs an indexed query the domain repository interface doesn't expose.

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { TreeFormatter } from "effect/ParseResult"
import { Fact, FactNotFound, FactsRepository, UnexpectedError, type EntityId } from "@athenaeum/domain"
import { collection, createEffectTypedStorage, type Collection, type NonUniqueIndex, type TypedStorageError } from "@athenaeum/typed-storage-effect"

const factsCollectionSchema = collection<Fact>()({
  primaryKey: "id",
  nonUniqueIndexes: {
    byNodeId: (fact: Fact) => fact.nodeId,
    // Phase 3 addition — see `nodes-repository-live.ts`'s identically-named index for the
    // rationale (`AgentEditService`'s merge/revert/reconcile need "every pending fact this chat
    // produced" without a full-workspace scan).
    byPendingChatId: (fact: Fact) => fact.pending?.chatId ?? null
  }
})

export interface FactsCollections {
  readonly facts: Collection<Fact, EntityId> & {
    readonly byNodeId: NonUniqueIndex<Fact, EntityId>
    readonly byPendingChatId: NonUniqueIndex<Fact, EntityId>
  }
}

export const makeFactsCollections = (storage: DurableObjectStorage): FactsCollections => {
  const typedStorage = createEffectTypedStorage(storage, { collections: { facts: factsCollectionSchema } })
  return { facts: typedStorage.facts }
}

const toUnexpectedError = (error: TypedStorageError): UnexpectedError =>
  new UnexpectedError({
    message:
      error._tag === "StorageError"
        ? error.message
        : `index conflict: ${error.collection}.${error.index} (key ${error.key})`
  })

export const reviveFact = (raw: unknown): Effect.Effect<Fact, UnexpectedError> =>
  Schema.decodeUnknown(Fact)(raw).pipe(
    Effect.mapError(
      (parseError) =>
        new UnexpectedError({ message: `corrupt stored fact: ${TreeFormatter.formatErrorSync(parseError)}` })
    )
  )

export const makeFactsRepositoryLive = (collections: FactsCollections): Layer.Layer<FactsRepository> =>
  Layer.succeed(FactsRepository, {
    get: (factId) =>
      collections.facts.get(factId).pipe(
        Effect.mapError(toUnexpectedError),
        Effect.flatMap(
          (maybeFact): Effect.Effect<Fact, FactNotFound | UnexpectedError> =>
            maybeFact === undefined ? Effect.fail(new FactNotFound({ factId })) : reviveFact(maybeFact)
        )
      ),
    put: (fact) => collections.facts.put(fact).pipe(Effect.mapError(toUnexpectedError), Effect.as(fact)),
    list: (_workspaceId) =>
      collections.facts.list().pipe(
        Effect.mapError(toUnexpectedError),
        Effect.flatMap((rawFacts) => Effect.forEach(rawFacts, reviveFact)),
        // Phase 3 addition — same mainline-visibility guarantee as `NodesRepository.list` above.
        Effect.map((facts) => facts.filter((fact) => fact.pending === undefined))
      ),
    delete: (factId) => collections.facts.delete(factId).pipe(Effect.mapError(toUnexpectedError), Effect.asVoid)
  })
