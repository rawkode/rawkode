// `SyncFeedService` — the structured-record side of the plan's "Sync protocol" (task item 6):
// "a real append-only per-workspace sequenced feed... that records every mutation to nodes/tags/
// facts/relationDefinitions/edges as a feed entry with (replicaEpoch, monotonicCounter), plus a
// syncFeed RPC method a client can page through with a cursor to catch up — and a workspace epoch
// value that changes on demand... causing a client with a stale epoch to be told to bootstrap
// fresh rather than trust its cursor."
//
// Backend-internal Effect Service (not a domain `Context.Tag` — see `graph-service-live.ts`'s
// header comment for why service *orchestration* interfaces live in backend, only storage
// *repository* interfaces live in domain), composed into `WorkspaceDurableObject`'s Layer alongside
// `GraphServiceLive`/`NotesServiceLive`, both of which call `SyncFeedService.append` after every
// mutation.

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { TreeFormatter } from "effect/ParseResult"
import { SyncFeedEntry, UnexpectedError, WorkspaceEpoch, type EntityId } from "@athenaeum/domain"
import {
  collection,
  createEffectTypedStorage,
  type Collection,
  type NonUniqueIndex,
  type Singleton,
  type TypedStorageError
} from "@athenaeum/typed-storage-effect"

const syncFeedEntryCollectionSchema = collection<SyncFeedEntry>()({
  // A string primary key so entries sort correctly by insertion order within typed-storage's
  // lexicographic key ordering: zero-padded so numeric ordering matches string ordering (plain
  // `${epoch}:${counter}` would sort "10" before "2"). 12 hex digits comfortably covers Phase 1's
  // scale (the plan's own unbounded-growth caveat on this feed is a later-phase compaction
  // concern, not a Phase 1 key-width concern).
  primaryKey: (entry: SyncFeedEntry) =>
    `${entry.replicaEpoch.toString(16).padStart(8, "0")}:${entry.monotonicCounter.toString(16).padStart(12, "0")}`,
  nonUniqueIndexes: {
    // Backs `append`'s write-side idempotency check (adversarial-review fix — see that function's
    // doc comment): looking up every prior feed entry for a given `entityId` is what lets a retry
    // with the same id+hash be recognized and skipped instead of unconditionally appended.
    byEntityId: (entry: SyncFeedEntry) => entry.entityId
  }
})

export interface SyncFeedCollections {
  readonly syncFeedEntries: Collection<SyncFeedEntry, string> & {
    readonly byEntityId: NonUniqueIndex<SyncFeedEntry, EntityId>
  }
  readonly epoch: Singleton<string>
  // The integer tag stamped into `SyncFeedEntry.replicaEpoch` for the *current* `epoch` string
  // (see the bottom of this file for why this needs to be a persisted per-DO singleton, not an
  // in-memory/module-level cache). Incremented on every `rotateEpoch`, alongside minting a fresh
  // `epoch` string — the two singletons always change together.
  readonly epochGeneration: Singleton<number>
  readonly nextCounter: Singleton<number>
}

export const makeSyncFeedCollections = (storage: DurableObjectStorage): SyncFeedCollections => {
  const typedStorage = createEffectTypedStorage(storage, {
    collections: { syncFeedEntries: syncFeedEntryCollectionSchema },
    // `""` is not a valid `WorkspaceEpoch` (its schema requires `minLength(1)`) — used here purely as
    // "no epoch minted yet" sentinel so `currentEpoch` below knows to mint+persist the workspace's
    // first random epoch lazily on first read, rather than requiring `WorkspaceDurableObject`'s
    // constructor to do it eagerly.
    singletons: { epoch: "", epochGeneration: 0, nextCounter: 0 }
  })
  return {
    syncFeedEntries: typedStorage.syncFeedEntries,
    epoch: typedStorage.epoch,
    epochGeneration: typedStorage.epochGeneration,
    nextCounter: typedStorage.nextCounter
  }
}

const toUnexpectedError = (error: TypedStorageError): UnexpectedError =>
  new UnexpectedError({
    message:
      error._tag === "StorageError"
        ? error.message
        : `index conflict: ${error.collection}.${error.index} (key ${error.key})`
  })

/** See `nodes-repository-live.ts`'s `reviveNode` for why every record read from storage must be
 *  re-decoded into a real `Schema.Class` instance before it can be embedded in another
 *  `Schema.Class` constructor (`SyncFeedOutput`'s `entries: Array(SyncFeedEntry)`). */
const reviveSyncFeedEntry = (raw: unknown): Effect.Effect<SyncFeedEntry, UnexpectedError> =>
  Schema.decodeUnknown(SyncFeedEntry)(raw).pipe(
    Effect.mapError(
      (parseError) =>
        new UnexpectedError({
          message: `corrupt stored sync feed entry: ${TreeFormatter.formatErrorSync(parseError)}`
        })
    )
  )

/**
 * A cheap, synchronous, non-cryptographic content hash (FNV-1a over the JSON-stringified
 * payload) — sufficient for `SyncFeedEntry.hash`'s documented job ("idempotent by ID+hash":
 * letting a replayed/duplicated feed entry be recognized and skipped), not a security property.
 * Kept synchronous deliberately: this runs inside `Effect.try`-wrapped `put()` calls, which must
 * stay synchronous per `typed-storage-effect`'s own constraint (`storage.transactionSync`).
 */
export const fnv1aHash = (input: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

export class SyncFeedService extends Context.Tag("@athenaeum/backend/SyncFeedService")<
  SyncFeedService,
  {
    /** The workspace's current epoch, minting and persisting a fresh random one on first access. */
    readonly currentEpoch: Effect.Effect<WorkspaceEpoch, UnexpectedError>
    /** Admin/test-only (task item 6): rotates to a fresh random epoch, invalidating every
     *  outstanding client cursor. */
    readonly rotateEpoch: Effect.Effect<WorkspaceEpoch, UnexpectedError>
    /** Appends one mutation record to the feed, stamped with the current epoch and the next
     *  monotonic counter value. Called by `GraphServiceLive`/`NotesServiceLive` after every
     *  successful mutation.
     *
     *  **Write-side idempotency (adversarial-review fix):** before minting a new counter/entry,
     *  checks whether a feed entry already exists for this exact `(entityKind, entityId)` whose
     *  stored `hash` matches this call's payload hash — if so, that existing entry is returned
     *  unchanged instead of appending a duplicate. This is real deduplication, not just a
     *  documented intent: previously `append` unconditionally created a new entry on every call,
     *  and because every mutation minted a fresh `crypto.randomUUID()` entity id per call, two
     *  calls that were logically the same retried mutation could never actually collide on
     *  `entityId` (see this class's original doc comment history / the domain `sync.ts` doc
     *  comment on `SyncFeedEntry.hash` for the full before/after). It only helps a caller that
     *  supplies a *stable* `entityId` across retries (`rpc.ts`'s `CreateNodeInput.id`,
     *  `graph-rpc.ts`'s `AddFactInput.id`) — a caller that lets the server mint a fresh id every
     *  call gets a fresh feed entry every call, which is correct: there is no way to tell that
     *  apart from a genuinely new mutation without a stable id. */
    readonly append: (
      entityKind: string,
      entityId: EntityId,
      operation: "put" | "delete",
      payload: unknown
    ) => Effect.Effect<SyncFeedEntry, UnexpectedError>
    /** Pages through the feed. See `sync-rpc.ts`'s `SyncFeedInput`/`SyncFeedOutput` doc comments
     *  for the epoch-mismatch/cursor semantics this implements directly. */
    readonly listPage: (
      knownEpoch: WorkspaceEpoch | undefined,
      afterCounter: number | undefined,
      limit: number
    ) => Effect.Effect<
      { epoch: WorkspaceEpoch; epochMismatch: boolean; entries: ReadonlyArray<SyncFeedEntry>; nextAfterCounter?: number },
      UnexpectedError
    >
  }
>() {}

const randomEpoch = (): WorkspaceEpoch => WorkspaceEpoch.make(crypto.randomUUID())

/** Reads the current `(epoch, epochGeneration)` pair, minting+persisting both lazily on first
 *  access (mirrors `collections.epoch`'s own "" sentinel). `epochGeneration` is what actually
 *  fills `SyncFeedEntry.replicaEpoch` (a plain non-negative integer, per sync.ts's doc comment) —
 *  `WorkspaceEpoch` itself stays an opaque random string a client only ever compares for equality
 *  (also documented there). Both are persisted DO-instance state, not a module-level cache: this
 *  Worker script's Durable Object classes can be colocated with other DO instances inside the
 *  same isolate for efficiency, so any module-level mutable state would risk leaking across
 *  unrelated workspaces' epoch bookkeeping — everything here instead lives in `collections`, which is
 *  this specific DO instance's own SQLite storage. */
const currentEpochAndGeneration = (
  collections: SyncFeedCollections
): Effect.Effect<{ epoch: WorkspaceEpoch; generation: number }, UnexpectedError> =>
  Effect.gen(function* () {
    const stored = yield* collections.epoch.get().pipe(Effect.mapError(toUnexpectedError))
    if (stored.length > 0) {
      const generation = yield* collections.epochGeneration.get().pipe(Effect.mapError(toUnexpectedError))
      return { epoch: WorkspaceEpoch.make(stored), generation }
    }
    const fresh = randomEpoch()
    yield* collections.epoch.put(fresh).pipe(Effect.mapError(toUnexpectedError))
    return { epoch: fresh, generation: 0 }
  })

export const makeSyncFeedServiceLive = (
  collections: SyncFeedCollections
): Layer.Layer<SyncFeedService> =>
  Layer.succeed(SyncFeedService, {
    currentEpoch: currentEpochAndGeneration(collections).pipe(Effect.map(({ epoch }) => epoch)),

    rotateEpoch: Effect.gen(function* () {
      const { generation } = yield* currentEpochAndGeneration(collections)
      const fresh = randomEpoch()
      yield* collections.epoch.put(fresh).pipe(Effect.mapError(toUnexpectedError))
      yield* collections.epochGeneration.put(generation + 1).pipe(Effect.mapError(toUnexpectedError))
      // A rotated epoch starts its own counter sequence at 0 — entries are already permanently
      // disambiguated by `replicaEpoch`, so counters may legitimately repeat across epochs (the
      // primary key above namespaces by epoch first, precisely so this is safe).
      yield* collections.nextCounter.put(0).pipe(Effect.mapError(toUnexpectedError))
      return fresh
    }),

    append: (entityKind, entityId, operation, payload) =>
      Effect.gen(function* () {
        const hash = fnv1aHash(JSON.stringify(payload))

        const priorRaw = yield* collections.syncFeedEntries.byEntityId
          .get(entityId)
          .pipe(Effect.mapError(toUnexpectedError))
        const prior = yield* Effect.forEach(priorRaw, reviveSyncFeedEntry)
        const duplicate = prior.find(
          (e) => e.entityKind === entityKind && e.operation === operation && e.hash === hash
        )
        if (duplicate !== undefined) {
          return duplicate
        }

        const { generation } = yield* currentEpochAndGeneration(collections)
        const counter = yield* collections.nextCounter.get().pipe(Effect.mapError(toUnexpectedError))
        yield* collections.nextCounter.put(counter + 1).pipe(Effect.mapError(toUnexpectedError))

        const entry = new SyncFeedEntry({
          replicaEpoch: generation,
          monotonicCounter: counter,
          entityKind,
          entityId,
          operation,
          payload,
          hash
        })
        yield* collections.syncFeedEntries.put(entry).pipe(Effect.mapError(toUnexpectedError))
        return entry
      }),

    listPage: (knownEpoch, afterCounter, limit) =>
      Effect.gen(function* () {
        const { epoch, generation } = yield* currentEpochAndGeneration(collections)

        if (knownEpoch !== undefined && knownEpoch !== epoch) {
          return { epoch, epochMismatch: true, entries: [], nextAfterCounter: undefined }
        }

        const allRaw = yield* collections.syncFeedEntries.list().pipe(Effect.mapError(toUnexpectedError))
        const all = yield* Effect.forEach(allRaw, reviveSyncFeedEntry)
        const inEpoch = all
          .filter((e) => e.replicaEpoch === generation)
          .sort((a, b) => a.monotonicCounter - b.monotonicCounter)
        const afterIndex =
          afterCounter === undefined ? 0 : inEpoch.findIndex((e) => e.monotonicCounter > afterCounter)
        const startIndex = afterCounter === undefined ? 0 : afterIndex === -1 ? inEpoch.length : afterIndex
        const page = inEpoch.slice(startIndex, startIndex + limit)

        return {
          epoch,
          epochMismatch: false,
          entries: page,
          nextAfterCounter: page.length > 0 ? page[page.length - 1]!.monotonicCounter : undefined
        }
      })
  })
