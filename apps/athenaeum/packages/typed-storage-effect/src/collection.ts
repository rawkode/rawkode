import { Effect, Scope } from "effect";
import type { Key, ListOptions } from "./types.js";
import { KvPrefixedView } from "./kv-prefixed-view.js";
import type { Subscriber } from "./subscriber.js";
import { IndexConflictSignal, mapStorageError, type TypedStorageError } from "./errors.js";
import type {
  CollectionSchema,
  FnReturnType,
  IndexFunction,
  PrimaryKeySpec,
  PrimaryKeyType,
  RemoveArray,
} from "./schema.js";

// =======================================================================================
// Public Effect-facing types

/** An index where each key matches exactly one record. Every operation is an Effect: failures
 *  (a thrown error from the underlying `DurableObjectStorage` API, or an index-consistency
 *  assertion) surface through the error channel as `TypedStorageError` instead of a thrown
 *  exception. */
export interface UniqueIndex<T, K> {
  get(key: K): Effect.Effect<T | undefined, TypedStorageError>;
  list(options?: ListOptions<K>): Effect.Effect<ReadonlyArray<T>, TypedStorageError>;
  delete(key: K): Effect.Effect<boolean, TypedStorageError>;
}

/** An index where each key may match multiple records. */
export interface NonUniqueIndex<T, K> {
  get(key: K): Effect.Effect<ReadonlyArray<T>, TypedStorageError>;
  list(options?: ListOptions<K>): Effect.Effect<ReadonlyArray<T>, TypedStorageError>;
  delete(key: K): Effect.Effect<number, TypedStorageError>;
}

export type UniqueIndexed<T, Indexes> = {
  [K in keyof Indexes]: UniqueIndex<T, RemoveArray<FnReturnType<Indexes[K]>>>
}

export type NonUniqueIndexed<T, Indexes> = {
  [K in keyof Indexes]: NonUniqueIndex<T, RemoveArray<FnReturnType<Indexes[K]>>>
}

/**
 * A typed collection of records, keyed by primary key, with Effect-returning CRUD and an
 * Effect-`Scope`-based subscription mechanism (see `subscribe` below) in place of the original
 * `typed-storage`'s plain callback registration.
 */
export interface Collection<T extends object, PrimaryKey = string> extends UniqueIndex<T, PrimaryKey> {
  put(value: T): Effect.Effect<void, TypedStorageError>;

  /**
   * Registers `subscriber` to receive `add`/`update`/`remove` notifications for this collection,
   * for as long as the returned Effect's `Scope` remains open — this is the resource-model
   * replacement for the original's `subscribe(sub)` / `unsubscribe(sub)` pair. Run it with
   * `Effect.scoped(...)`, or `yield*` it inside another scoped Effect (e.g. one backing a Cap'n
   * Web `RpcTarget` stub in the Backend stage): the subscriber is automatically removed when the
   * scope closes, including on interruption (abrupt client disconnect) — not just on a clean
   * unsubscribe call.
   */
  subscribe(subscriber: Subscriber<T>): Effect.Effect<void, never, Scope.Scope>;
}

// =======================================================================================
// Internal raw (synchronous, unwrapped) machinery.
//
// This section is a near-verbatim port of cloudflare-os's `createCollection` — the index
// bookkeeping (`addIndexSubscriber`, the unique/non-unique index loops) is preserved exactly,
// including the nested-KV-namespace technique for multi-value non-unique indexes. The only
// behavioral change from the original: a unique-index conflict throws `IndexConflictSignal`
// (defined in errors.ts) instead of a plain `Error`, so the Effect-wrapping layer below can
// convert it into a typed `IndexConflictError` rather than a generic `StorageError`.
//
// Kept synchronous and un-exported: `storage.transactionSync()` requires a synchronous callback,
// so this layer runs entirely inside `Effect.try`'s `try:` thunk at the public boundary, never as
// an Effect program itself.

interface RawUniqueIndex<T, K extends Key> {
  get(key: K): T | undefined;
  list(options?: ListOptions<K>): Generator<T, void>;
  delete(key: K): boolean;
}

interface RawNonUniqueIndex<T, K extends Key> {
  get(key: K): Generator<T, void>;
  list(options?: ListOptions<K>): Generator<T, void>;
  delete(key: K): number;
}

interface RawCollection<T extends object> extends RawUniqueIndex<T, Key> {
  put(value: T): void;
  subscribe(subscriber: Subscriber<T>): void;
  unsubscribe(subscriber: Subscriber<T>): void;
}

function createRawCollection<
      T extends object,
      PrimaryKey extends PrimaryKeySpec<T>,
      UniqueIndexes,
      NonUniqueIndexes
    >(
      storage: DurableObjectStorage,
      name: string,
      schema: CollectionSchema<T, PrimaryKey, UniqueIndexes, NonUniqueIndexes>,
    ): RawCollection<T> & Record<string, RawUniqueIndex<T, Key> | RawNonUniqueIndex<T, Key>> {
  let subscribers: Set<Subscriber<T>> = new Set();

  let mainKv: KvPrefixedView<T>;
  let pkForT: (record: T) => Key;
  if (typeof schema.primaryKey === "function") {
    mainKv = new KvPrefixedView<T>(storage.kv, name);
    pkForT = schema.primaryKey as (record: T) => Key;
  } else {
    let pk = <keyof T>schema.primaryKey;
    mainKv = new KvPrefixedView<T>(storage.kv, name, pk);
    pkForT = (record: T) => <Key>record[pk];
  }

  // ---------------------------------------------------------------------------
  // Primary key operations

  let coll: RawCollection<T> = {
    get(key: Key): T | undefined {
      return mainKv.get(key);
    },
    put(record: T): void {
      let key = pkForT(record);
      if (subscribers.size == 0) {
        mainKv.put(key, record);
      } else {
        storage.transactionSync(() => {
          let oldRecord = mainKv.get(key);
          if (oldRecord === undefined) {
            for (let subscriber of subscribers) {
              subscriber.add(record);
            }
          } else {
            for (let subscriber of subscribers) {
              subscriber.update(oldRecord, record);
            }
          }
          mainKv.put(key, record);
        });
      }
    },
    *list(options: ListOptions<Key> = {}): Generator<T, void> {
      yield* mainKv.list(options);
    },
    delete(key: Key): boolean {
      if (subscribers.size == 0) {
        return mainKv.delete(key);
      } else {
        return storage.transactionSync(() => {
          let oldRecord = mainKv.get(key);
          if (oldRecord === undefined) {
            return false;
          }

          for (let subscriber of subscribers) {
            subscriber.remove(oldRecord);
          }
          return mainKv.delete(key);
        });
      }
    },

    subscribe(subscriber: Subscriber<T>): void {
      subscribers.add(subscriber);
    },
    unsubscribe(subscriber: Subscriber<T>): void {
      subscribers.delete(subscriber);
    }
  };

  let result: Record<string, unknown> = { ...coll };

  // ---------------------------------------------------------------------------
  // Helper for indexing

  // Add a subscriber subscribing on behalf of an index based on the given IndexFunction. This
  // code is shared for unique and non-unique indexes. This code in particular takes care of the
  // case where the index function returns an array.
  function addIndexSubscriber(
      idx: IndexFunction<T>,
      ops: {
        add(idxKey: Key, pk: Key, type: "Insertion" | "Update"): void;
        remove(idxKey: Key, pk: Key): void;
      }) {
    subscribers.add({
      add(record: T) {
        let pk = pkForT(record);
        let idxKeys = idx(record);
        if (Array.isArray(idxKeys)) {
          for (let idxKey of idxKeys) {
            ops.add(idxKey, pk, "Insertion");
          }
        } else if (idxKeys !== null) {
          ops.add(idxKeys, pk, "Insertion");
        }
      },
      update(oldRecord: T, newRecord: T) {
        let pk = pkForT(newRecord);

        let oldIdxKeys: Key | Key[] | null = idx(oldRecord);
        let newIdxKeys: Key | Key[] | null = idx(newRecord);

        if (Array.isArray(oldIdxKeys) || Array.isArray(newIdxKeys)) {
          if (!Array.isArray(oldIdxKeys)) {
            if (oldIdxKeys === null) {
              oldIdxKeys = [];
            } else {
              oldIdxKeys = [oldIdxKeys];
            }
          }
          if (!Array.isArray(newIdxKeys)) {
            if (newIdxKeys === null) {
              newIdxKeys = [];
            } else {
              newIdxKeys = [newIdxKeys];
            }
          }

          for (let idxKey of oldIdxKeys) {
            if (!newIdxKeys.includes(idxKey)) {
              ops.remove(idxKey, pk);
            }
          }
          for (let idxKey of newIdxKeys) {
            if (!oldIdxKeys.includes(idxKey)) {
              ops.add(idxKey, pk, "Update");
            }
          }
        } else {
          if (oldIdxKeys == newIdxKeys) {
            // Index doesn't need an update.
            return;
          }

          if (oldIdxKeys !== null) {
            ops.remove(oldIdxKeys, pk);
          }
          if (newIdxKeys !== null) {
            ops.add(newIdxKeys, pk, "Update");
          }
        }
      },
      remove(record: T) {
        let pk = pkForT(record);
        let idxKeys = idx(record);
        if (Array.isArray(idxKeys)) {
          for (let idxKey of idxKeys) {
            ops.remove(idxKey, pk);
          }
        } else if (idxKeys !== null) {
          ops.remove(idxKeys, pk);
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Unique indexes

  for (let [idxName, idx] of Object.entries(schema.uniqueIndexes || {})) {
    let idxKv = new KvPrefixedView<Key>(storage.kv, `${name}.${idxName}`);

    let index: RawUniqueIndex<T, Key> = {
      get(key: Key): T | undefined {
        let pk = idxKv.get(key);
        return pk === undefined ? undefined : coll.get(pk);
      },
      *list(options: ListOptions<Key> = {}): Generator<T, void> {
        if (options.dedupe) {
          let seen = new Set();
          for (let pk of idxKv.list(options)) {
            if (!seen.has(pk)) {
              seen.add(pk);
              yield coll.get(pk)!;
            }
          }
        } else {
          for (let pk of idxKv.list(options)) {
            yield coll.get(pk)!;
          }
        }
      },
      delete(key: Key): boolean {
        let pk = idxKv.get(key);
        return pk === undefined ? false : coll.delete(pk);
      },
    };
    result[idxName] = index;

    addIndexSubscriber(idx as IndexFunction<T>, {
      add(idxKey: Key, pk: Key, type: "Insertion" | "Update") {
        let oldValue = idxKv.get(idxKey);
        if (oldValue !== undefined) {
          throw new IndexConflictSignal(name, idxName, String(idxKey), String(oldValue), type);
        }
        idxKv.put(idxKey, pk);
      },
      remove(idxKey: Key, pk: Key) {
        if (!idxKv.delete(idxKey)) {
          throw new Error(
              `Index '${name}.${idxName}' is inconsistent: removed record is not present.`);
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Non-unique indexes

  for (let [idxName, idx] of Object.entries(schema.nonUniqueIndexes || {})) {
    let idxKv = new KvPrefixedView<number>(storage.kv, `${name}.${idxName}`);

    let index: RawNonUniqueIndex<T, Key> = {
      *get(key: Key): Generator<T, void> {
        let id = idxKv.get(key)
        if (id === undefined) return;
        let child = idxKv.getChild(id.toString());
        for (let pk of child.listKeys()) {
          yield coll.get(pk)!;
        }
      },
      *list(options: ListOptions<Key> = {}): Generator<T, void> {
        if (options.dedupe) {
          let seen = new Set<Key>();
          // TODO(perf): Since we do nested list()s here, but only one list() operation is allowed
          //   at a time by the KV storage interface, the outer list has to be buffered upfront.
          //   But we could arguably buffer a few at a time and use `startAfter` to get more. But
          //   it's probably rare to list() on a non-unique index anyway?
          for (let id of Array.from(idxKv.list(options))) {
            let child = idxKv.getChild(id.toString());
            for (let pk of child.listKeys({reverse: options.reverse})) {
              if (!seen.has(pk)) {
                seen.add(pk);
                yield coll.get(pk)!;
              }
            }
          }
        } else {
          for (let id of Array.from(idxKv.list(options))) {
            let child = idxKv.getChild(id.toString());
            for (let pk of child.listKeys({reverse: options.reverse})) {
              yield coll.get(pk)!;
            }
          }
        }
      },
      delete(key: Key): number {
        let id = idxKv.get(key);
        if (id === undefined) {
          return 0;
        } else {
          let child = idxKv.getChild(id.toString());
          let count = 0;
          // TODO(perf): Each call to delete() may invalidate the listKeys() cursor so we need
          //   to buffer them upfront. But if we wanted to we could buffer a few at a time, delete
          //   them, then list again, etc. But it's probably rare to delete() on a non-unique index
          //   anyway?
          for (let pk of Array.from(child.listKeys())) {
            coll.delete(pk);
            ++count;
          }
          return count;
        }
      },
    };
    result[idxName] = index;

    addIndexSubscriber(idx as IndexFunction<T>, {
      add(idxKey: Key, pk: Key, type: "Insertion" | "Update") {
        let id = idxKv.get(idxKey);
        if (id === undefined) {
          id = idxKv.getUniqueId();
          idxKv.put(idxKey, id);
        }

        let child = idxKv.getChild(id.toString());
        child.put(pk, {});
      },
      remove(idxKey: Key, pk: Key) {
        let id = idxKv.get(idxKey);
        if (id === undefined) {
          throw new Error(
              `Index '${name}.${idxName}' is inconsistent: removed record is not present.`);
        }

        let child = idxKv.getChild(id.toString());
        child.delete(pk);
        if (Array.from(child.list({limit: 1})).length == 0) {
          idxKv.delete(idxKey);
        }
      }
    });
  }

  // ---------------------------------------------------------------------------

  return result as RawCollection<T> & Record<string, RawUniqueIndex<T, Key> | RawNonUniqueIndex<T, Key>>;
}

// =======================================================================================
// Public Effect-wrapped factory

export type CollectionImpl<T extends object,
                    PrimaryKey extends PrimaryKeySpec<T>,
                    UniqueIndexes,
                    NonUniqueIndexes> =
    & Collection<T, PrimaryKeyType<T, PrimaryKey>>
    & UniqueIndexed<T, UniqueIndexes>
    & NonUniqueIndexed<T, NonUniqueIndexes>;

/** Wraps one raw `UniqueIndex` (or the collection's own primary-key operations, which share the
 *  same shape) in Effect, mapping thrown errors through `mapErr`. */
function wrapUniqueIndex<T, K extends Key>(
  raw: RawUniqueIndex<T, K>,
  mapErr: (cause: unknown) => TypedStorageError,
): UniqueIndex<T, K> {
  return {
    get: (key) => Effect.try({ try: () => raw.get(key), catch: mapErr }),
    list: (options) => Effect.try({ try: () => Array.from(raw.list(options ?? {})), catch: mapErr }),
    delete: (key) => Effect.try({ try: () => raw.delete(key), catch: mapErr }),
  };
}

function wrapNonUniqueIndex<T, K extends Key>(
  raw: RawNonUniqueIndex<T, K>,
  mapErr: (cause: unknown) => TypedStorageError,
): NonUniqueIndex<T, K> {
  return {
    get: (key) => Effect.try({ try: () => Array.from(raw.get(key)), catch: mapErr }),
    list: (options) => Effect.try({ try: () => Array.from(raw.list(options ?? {})), catch: mapErr }),
    delete: (key) => Effect.try({ try: () => raw.delete(key), catch: mapErr }),
  };
}

/**
 * Builds one collection's Effect-wrapped API (primary-key operations plus any declared unique/
 * non-unique indexes) against real `DurableObjectStorage`. Called once per collection from
 * `createEffectTypedStorage` — not normally called directly.
 */
export function createCollection<
      T extends object,
      PrimaryKey extends PrimaryKeySpec<T>,
      UniqueIndexes,
      NonUniqueIndexes
    >(
      storage: DurableObjectStorage,
      name: string,
      schema: CollectionSchema<T, PrimaryKey, UniqueIndexes, NonUniqueIndexes>,
    ): CollectionImpl<T, PrimaryKey, UniqueIndexes, NonUniqueIndexes> {
  let raw = createRawCollection(storage, name, schema);
  let mapErr = mapStorageError(name);

  let coll: Collection<T, Key> = {
    get: (key) => Effect.try({ try: () => raw.get(key), catch: mapErr }),
    put: (record) => Effect.try({ try: () => raw.put(record), catch: mapErr }),
    list: (options) => Effect.try({ try: () => Array.from(raw.list(options ?? {})), catch: mapErr }),
    delete: (key) => Effect.try({ try: () => raw.delete(key), catch: mapErr }),
    subscribe: (subscriber) =>
      Effect.acquireRelease(
        Effect.sync(() => { raw.subscribe(subscriber); }),
        () => Effect.sync(() => { raw.unsubscribe(subscriber); }),
      ),
  };

  let result: Record<string, unknown> = { ...coll };

  for (let idxName of Object.keys(schema.uniqueIndexes ?? {})) {
    result[idxName] = wrapUniqueIndex(raw[idxName] as RawUniqueIndex<T, Key>, mapErr);
  }
  for (let idxName of Object.keys(schema.nonUniqueIndexes ?? {})) {
    result[idxName] = wrapNonUniqueIndex(raw[idxName] as RawNonUniqueIndex<T, Key>, mapErr);
  }

  return result as CollectionImpl<T, PrimaryKey, UniqueIndexes, NonUniqueIndexes>;
}
