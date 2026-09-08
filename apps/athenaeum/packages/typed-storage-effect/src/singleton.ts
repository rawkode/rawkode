import { Effect, Scope } from "effect";
import { StorageError } from "./errors.js";
import type { SingletonSubscriber } from "./subscriber.js";

/** A single typed value stored under one key, with a default used until first `put()`. Mirrors
 *  `Collection`'s Effect-returning CRUD and `Scope`-based `subscribe`. */
export interface Singleton<T> {
  get(): Effect.Effect<T, StorageError>;
  put(value: T): Effect.Effect<void, StorageError>;

  /** See `Collection.subscribe` for the resource-model contract this follows. */
  subscribe(subscriber: SingletonSubscriber<T>): Effect.Effect<void, never, Scope.Scope>;
}

/** Builds one singleton's Effect-wrapped API. Called once per declared singleton from
 *  `createEffectTypedStorage` — not normally called directly. */
export function createSingleton<T>(
  storage: DurableObjectStorage,
  key: string,
  defaultValue: T,
): Singleton<T> {
  let subscribers = new Set<SingletonSubscriber<T>>();
  // Narrower than `mapStorageError`: a singleton has no unique index, so it can never produce an
  // `IndexConflictError` — its error channel is plain `StorageError`.
  let mapErr = (cause: unknown): StorageError => new StorageError({
    operation: key,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

  return {
    get: () => Effect.try({
      try: () => {
        let result = storage.kv.get<T>(key);
        return result === undefined ? defaultValue : result;
      },
      catch: mapErr,
    }),

    put: (value) => Effect.try({
      try: () => {
        if (subscribers.size === 0) {
          storage.kv.put(key, value);
        } else {
          storage.transactionSync(() => {
            for (let subscriber of subscribers) {
              subscriber.update(value);
            }
            storage.kv.put(key, value);
          });
        }
      },
      catch: mapErr,
    }),

    subscribe: (subscriber) =>
      Effect.acquireRelease(
        Effect.sync(() => { subscribers.add(subscriber); }),
        () => Effect.sync(() => { subscribers.delete(subscriber); }),
      ),
  };
}
