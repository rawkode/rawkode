import { Effect } from "effect";
import { createCollection, type CollectionImpl } from "./collection.js";
import { createSingleton, type Singleton } from "./singleton.js";
import { StorageError } from "./errors.js";
import type { CollectionSchema, CollectionSchemaBrand } from "./schema.js";

/** The top-level typed-storage handle: one `transaction()` escape hatch plus every declared
 *  collection/singleton, each already bound to the given `DurableObjectStorage`. */
export interface TypedStorage {
  /**
   * Runs `f` inside `storage.transactionSync()`. `f` itself must stay synchronous — Durable
   * Object transactions are synchronous by design (see `storage.transactionSync`'s type) — this
   * only adds Effect-typed error handling around that call, it does not make the transaction body
   * asynchronous.
   */
  transaction<T>(f: () => T): Effect.Effect<T, StorageError>;
}

type TypedStorageImpl<Collections, Singletons> = TypedStorage
  & {
    [K in keyof Collections]: Collections[K] extends
        CollectionSchema<infer T, infer P, infer U, infer N>
            ? CollectionImpl<T, P, U, N> : never
  }
  & {
    [K in keyof Singletons]: Singleton<Singletons[K]>;
  };

/**
 * Builds a typed storage handle over one `DurableObjectStorage`, from a schema of named
 * collections (see `collection()`) and named singletons (a plain object whose values are the
 * default value for each singleton, keyed by singleton name — same shape as the original
 * `typed-storage`'s `createTypedStorage`).
 *
 * Every method on the returned object is an Effect program; nothing runs until the caller
 * executes it (e.g. via `Effect.runPromise`, or by composing it into a larger program run inside
 * the owning `WorkspaceDurableObject`'s request-handling Layer).
 */
export function createEffectTypedStorage<Collections extends Record<string, CollectionSchemaBrand>,
                                   Singletons>(
    storage: DurableObjectStorage,
    schema: {
      collections?: Collections;
      singletons?: Singletons;
    })
    : TypedStorageImpl<Collections, Singletons> {
  let typedStorage: TypedStorage = {
    transaction: (f) => Effect.try({
      try: () => storage.transactionSync(f),
      // Deliberately narrower than `mapStorageError`: `transaction()`'s error channel is typed
      // as plain `StorageError`, not `TypedStorageError`, since `f` is caller-supplied code with
      // no defined relationship to this package's own `IndexConflictSignal`.
      catch: (cause): StorageError => new StorageError({
        operation: "transaction",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
    }),
  };
  let result: Record<string, unknown> = { ...typedStorage };

  for (let [colName, colSchema] of Object.entries(schema.collections || {})) {
    result[colName] = createCollection(storage, colName, <any>colSchema);
  }

  for (let [key, defaultValue] of Object.entries(schema.singletons || {})) {
    result[key] = createSingleton(storage, key, defaultValue);
  }

  return result as TypedStorageImpl<Collections, Singletons>;
}
