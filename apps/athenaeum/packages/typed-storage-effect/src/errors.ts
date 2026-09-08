import { Data } from "effect";

/**
 * A storage operation failed unexpectedly — either the underlying `DurableObjectStorage`
 * synchronous API (`storage.kv` / `storage.transactionSync()`) threw, or an internal
 * index-consistency assertion failed (e.g. "index is inconsistent: removed record is not
 * present" — a bug in this library or in how it was used, not a normal outcome a caller is
 * expected to branch on).
 *
 * This is the Effect-typed replacement for the original `typed-storage`'s behavior of letting
 * such failures propagate as thrown exceptions out of otherwise-synchronous methods.
 */
export class StorageError extends Data.TaggedError("StorageError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

/**
 * A `Collection.put()` would violate a unique index: the index key computed for the new/updated
 * record already maps to a different record.
 *
 * Split out from `StorageError` (rather than folded into it) because, unlike the other failure
 * modes above, this one is an expected, structurally-meaningful outcome a caller may want to
 * handle distinctly (e.g. `Effect.catchTag("IndexConflictError", ...)` to surface "that email is
 * already taken" instead of a generic storage failure).
 */
export class IndexConflictError extends Data.TaggedError("IndexConflictError")<{
  readonly collection: string;
  readonly index: string;
  readonly key: string;
  readonly conflictingPrimaryKey: string;
  readonly operation: "Insertion" | "Update";
}> {}

/**
 * The error channel shared by every collection/index/singleton operation in this package.
 *
 * Simplification for this Phase 0 package (noted explicitly rather than silently): in the
 * original `typed-storage`, only `Collection.put()` can trigger a unique-index conflict — a
 * `get()`/`list()`/`delete()` cannot. A fully precise port would give each method its own,
 * narrower error union reflecting that. Instead every method here is typed with the same
 * `TypedStorageError` union; call sites that cannot actually produce `IndexConflictError` simply
 * never do so at runtime. This trades a small amount of type precision for a much smaller,
 * easier-to-review set of signatures — worth revisiting if a later phase wants tighter types.
 */
export type TypedStorageError = StorageError | IndexConflictError;

/**
 * Internal-only marker thrown from inside the raw (synchronous, unwrapped) collection/index
 * machinery when a unique-index add would conflict. Never thrown across the package's public
 * boundary — `mapStorageError` below catches it and converts it to `IndexConflictError` before
 * any Effect-wrapped method returns.
 */
export class IndexConflictSignal extends Error {
  readonly collection: string;
  readonly index: string;
  readonly key: string;
  readonly conflictingPrimaryKey: string;
  readonly operation: "Insertion" | "Update";

  constructor(
    collection: string,
    index: string,
    key: string,
    conflictingPrimaryKey: string,
    operation: "Insertion" | "Update",
  ) {
    super(`${operation} conflicts with record '${conflictingPrimaryKey}' in '${collection}.${index}'.`);
    this.name = "IndexConflictSignal";
    this.collection = collection;
    this.index = index;
    this.key = key;
    this.conflictingPrimaryKey = conflictingPrimaryKey;
    this.operation = operation;
  }
}

/** Builds an `Effect.try`/`Effect.acquireRelease` `catch` handler scoped to one operation name,
 *  turning any thrown error (an `IndexConflictSignal` or anything else) into a `TypedStorageError`. */
export function mapStorageError(operation: string): (cause: unknown) => TypedStorageError {
  return (cause: unknown): TypedStorageError => {
    if (cause instanceof IndexConflictSignal) {
      return new IndexConflictError({
        collection: cause.collection,
        index: cause.index,
        key: cause.key,
        conflictingPrimaryKey: cause.conflictingPrimaryKey,
        operation: cause.operation,
      });
    }
    return new StorageError({
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  };
}
