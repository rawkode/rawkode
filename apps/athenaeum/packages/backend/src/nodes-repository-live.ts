// Adapts `typed-storage-effect`'s Effect-wrapped DO-SQLite collection to `@athenaeum/domain`'s
// `NodesRepository` `Context.Tag` interface (plan §"Storage & domain model": "each owning its own
// typed-storage-effect collections", §"Effect-TS integration": "NodesRepositoryLive layer backed
// by typed-storage-effect's createEffectTypedStorage over ctx.storage"). This is the one place
// `@athenaeum/domain` and `@athenaeum/typed-storage-effect` meet — `domain` itself has zero
// dependency on either Cloudflare or `typed-storage-effect`, by design (see its own package
// report), so the wiring lives here in `backend`.

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { TreeFormatter } from "effect/ParseResult"
import {
  Node as NodeEntity,
  NodeNotFound,
  NodesRepository,
  UnexpectedError,
  type EntityId
} from "@athenaeum/domain"
import {
  collection,
  createEffectTypedStorage,
  type Collection,
  type NonUniqueIndex,
  type TypedStorageError
} from "@athenaeum/typed-storage-effect"

/**
 * The one collection this Phase 0 slice needs: `nodes`, keyed by `id`, with a non-unique
 * `byWorkspaceId` index — the plan's full `nodes` collection (`primaryTagIds` and everything else
 * beyond `id`/`workspaceId`/`title`/`createdAt`) is out of scope, matching `@athenaeum/domain`'s own
 * `Node` schema for this phase.
 */
const nodesCollectionSchema = collection<NodeEntity>()({
  primaryKey: "id",
  nonUniqueIndexes: {
    byWorkspaceId: (node: NodeEntity) => node.workspaceId,
    // Phase 3 addition (`AgentEditService`): backs `mergeChanges`/`revertChanges`/
    // `reconcilePendingChanges`, which all need "every pending node this chat produced" without
    // a full-workspace scan. `null` (not the string `"undefined"`) for an ordinary mainline node —
    // per `collection.ts`'s `addIndexSubscriber`, an index function returning `null` means "no
    // index entry for this record," so mainline nodes are simply absent from this index, not
    // indexed under a bogus shared key.
    byPendingChatId: (node: NodeEntity) => node.pending?.chatId ?? null
  }
})

/** Every collection this DO instance's storage exposes — kept as its own type so
 *  `workspace-durable-object.ts` can build the storage handle once and hand pieces of it (the
 *  `NodesRepositoryLive` layer, the raw `nodes` collection for live subscriptions) to different
 *  consumers without re-deriving the schema. */
export interface WorkspaceCollections {
  readonly nodes: Collection<NodeEntity, EntityId> & {
    readonly byWorkspaceId: NonUniqueIndex<NodeEntity, EntityId>
    readonly byPendingChatId: NonUniqueIndex<NodeEntity, EntityId>
  }
}

/** Builds this DO instance's typed-storage-effect handle once (called from the constructor, per
 *  the plan's "DO class boundary" pattern) against real `DurableObjectStorage`. */
export const makeWorkspaceCollections = (storage: DurableObjectStorage): WorkspaceCollections => {
  const typedStorage = createEffectTypedStorage(storage, {
    collections: { nodes: nodesCollectionSchema }
  })
  return { nodes: typedStorage.nodes }
}

/** Exported (not just used locally) so `nodes-subscription.ts` can map its own `TypedStorageError`
 *  reads (`collections.nodes.byWorkspaceId.get`) through the same conversion, rather than duplicating
 *  it or — as flagged in review — bypassing it entirely by running storage effects with a raw
 *  `Effect.runPromise` instead of threading them through the `DomainError` channel. */
export const toUnexpectedError = (error: TypedStorageError): UnexpectedError =>
  new UnexpectedError({
    message: error._tag === "StorageError"
      ? error.message
      : `index conflict: ${error.collection}.${error.index} (key ${error.key})`
  })

/**
 * `DurableObjectStorage` round-trips values through its own (structured-clone-based)
 * serialization — a record read back from `storage.kv` is a plain object, not the `NodeEntity`
 * (`Schema.Class`) instance that was originally `put()`. That's invisible for most consumers, but
 * `Schema.Class`'s own validation of a *nested* class field (e.g. `ListNodesOutput`'s
 * `nodes: Schema.Array(Node)`) requires an actual `Node` instance, not a structurally-identical
 * plain object — discovered by the smoke test below throwing `"Expected Node, actual {...}"`.
 * Revive every record read from storage back into a real `Node` instance here, at the one place
 * `typed-storage-effect`'s raw storage values become domain values, rather than pushing this
 * concern onto every RPC method.
 */
export const reviveNode = (raw: unknown): Effect.Effect<NodeEntity, UnexpectedError> =>
  Schema.decodeUnknown(NodeEntity)(raw).pipe(
    Effect.mapError(
      (parseError) =>
        new UnexpectedError({ message: `corrupt stored node: ${TreeFormatter.formatErrorSync(parseError)}` })
    )
  )

/**
 * Test-only injection point for the Verify stage's "genuine mid-fiber kill" exit criterion (plan
 * §"Verification", exit criterion #2: "kill the isolate mid-`await` inside an Effect program and
 * verify recovery on next wake" — see `test/do-recovery.test.ts`'s dedicated suite for this, which
 * documents why the two `isProxyTest: true` suites above it cannot literally satisfy that clause:
 * `typed-storage-effect`'s collection operations are synchronous `Effect.try` wrappers with no
 * externally-observable async window to land a kill inside).
 *
 * `beforeWrite`, when set, is `yield*`-ed inside `put()`'s Effect program immediately before the
 * actual storage write — a real suspension point a test can park a fiber at (e.g. awaiting a
 * `Promise` that only settles when the test decides to), then kill the DO isolate while genuinely
 * suspended there, then assert the write never landed. `undefined` (the default, and the only
 * value production code ever sees) makes this an unconditional no-op — `Effect.suspend` re-reads
 * the field on every call so a test can install/remove the hook around just the scenario it needs,
 * without this module carrying any conditional/env-based branching in the production path.
 */
export const putTestHook: { beforeWrite: (() => Effect.Effect<void>) | undefined } = {
  beforeWrite: undefined
}

/** `NodesRepositoryLive`: the domain `Context.Tag` implementation, backed by `collections.nodes`.
 *  A plain `Layer.succeed` (no resource acquisition of its own — `collections` is already live by
 *  the time this is called), composed into the DO's instance Layer alongside the logger layer. */
export const makeNodesRepositoryLive = (
  collections: WorkspaceCollections
): Layer.Layer<NodesRepository> =>
  Layer.succeed(NodesRepository, {
    get: (nodeId) =>
      collections.nodes.get(nodeId).pipe(
        Effect.mapError(toUnexpectedError),
        Effect.flatMap(
          (maybeNode): Effect.Effect<NodeEntity, NodeNotFound | UnexpectedError> =>
            maybeNode === undefined ? Effect.fail(new NodeNotFound({ nodeId })) : reviveNode(maybeNode)
        )
      ),
    put: (node) =>
      Effect.suspend(() => (putTestHook.beforeWrite ? putTestHook.beforeWrite() : Effect.void)).pipe(
        Effect.flatMap(() => collections.nodes.put(node).pipe(Effect.mapError(toUnexpectedError))),
        Effect.as(node)
      ),
    list: (workspaceId) =>
      collections.nodes.byWorkspaceId.get(workspaceId).pipe(
        Effect.mapError(toUnexpectedError),
        Effect.flatMap((rawNodes) => Effect.forEach(rawNodes, reviveNode)),
        // Phase 3 addition: mainline `listNodes` must never surface an agent chat's not-yet-
        // accepted pending nodes (plan §Q15: "invisible to mainline reads... until accepted") —
        // this is the one place every mainline node listing funnels through, so filtering here
        // (rather than in every RPC method that calls `.list()`) makes the guarantee structural.
        // A chat's OWN preview of its pending nodes never goes through this method — it resolves
        // bindings via `.get(nodeId)`, which is deliberately NOT filtered (see that method above):
        // an agent tool that just created a pending node must still be able to `get()` it back.
        Effect.map((nodes) => nodes.filter((node) => node.pending === undefined))
      ),
    delete: (nodeId) => collections.nodes.delete(nodeId).pipe(Effect.mapError(toUnexpectedError), Effect.asVoid)
  })
