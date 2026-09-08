import type { Key } from "./types.js";

// Type-level plumbing ported unchanged from cloudflare-os's typed-storage. `collection()` itself
// does no storage work — it's a schema builder, evaluated entirely at the type level plus a
// trivial identity cast at runtime — so none of this needs an Effect wrapper.

/** A record-to-index-key mapping function. Returning `null` (or, for the array forms, an empty
 *  array) omits the record from that index. */
export type IndexFunction<T> =
  | ((record: T) => string | null)
  | ((record: T) => string[])
  | ((record: T) => number | null)
  | ((record: T) => number[]);

export type FnReturnType<T> = T extends (...args: any) => infer R ? R : never;
export type RemoveArray<T> = T extends Array<infer U> ? U : T;

type ValidPrimaryKeys<T> = {
  [K in keyof T]: T[K] extends Key ? K : never;
}[keyof T];

export type PrimaryKeySpec<T> = ValidPrimaryKeys<T> | ((record: T) => Key);

export type PrimaryKeyType<T, K extends PrimaryKeySpec<T>> =
    K extends ValidPrimaryKeys<T> ? T[K]
  : K extends ((record: T) => Key) ? FnReturnType<K>
  : never;

interface CollectionSchemaBrand {
  "__COLLECTION_SCHEMA_BRAND": never;
}

export interface CollectionSchema<
      T extends object,
      PrimaryKey extends PrimaryKeySpec<T>,
      UniqueIndexes,
      NonUniqueIndexes
    > extends CollectionSchemaBrand {
  primaryKey: PrimaryKey;
  uniqueIndexes?: UniqueIndexes;
  nonUniqueIndexes?: NonUniqueIndexes;
}

/**
 * Declares a collection's schema: its primary key (a property name, or a function deriving a key
 * from a record) plus optional unique/non-unique secondary indexes. Purely a type-level builder —
 * `createEffectTypedStorage` is what actually wires a schema to a `DurableObjectStorage`.
 *
 * Usage is identical to cloudflare-os's `typed-storage`:
 *
 * ```ts
 * const users = collection<User>()({
 *   primaryKey: "uid",
 *   uniqueIndexes: { byEmail: (u) => u.emails },
 *   nonUniqueIndexes: { byGroup: (u) => u.groups },
 * });
 * ```
 */
export function collection<T extends object>() {
  return function<PrimaryKey extends PrimaryKeySpec<T>,
                  UniqueIndexes,
                  NonUniqueIndexes>(
      options: {
        primaryKey: PrimaryKey,
        uniqueIndexes?: UniqueIndexes,
        nonUniqueIndexes?: NonUniqueIndexes,
      })
      : CollectionSchema<T, PrimaryKey, UniqueIndexes, NonUniqueIndexes> {
    return options as (CollectionSchemaBrand & typeof options);
  }
}

// Re-exported only within the package (not from the public barrel) — external code never needs
// to name `CollectionSchemaBrand` directly, it only ever produces/consumes it structurally via
// `collection()` and `createEffectTypedStorage()`.
export type { CollectionSchemaBrand };
