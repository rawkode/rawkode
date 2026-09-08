// Effect-wrapped port of cloudflare-os's packages/typed-storage/src/index.ts against Durable
// Object's synchronous storage.kv/storage.transactionSync() API — see
// /Users/rawkode/.claude/plans/i-ve-tried-to-build-proud-thacker.md, "typed-storage-effect is a
// new package, not a dependency on cloudflare-os" and "Effect-TS integration".
//
// Public surface intentionally mirrors the original almost exactly (`collection()`,
// `createEffectTypedStorage()` in place of `createTypedStorage()`, the same `ListOptions`/
// `UniqueIndex`/`NonUniqueIndex`/`Collection`/`Singleton` shapes), with two Effect-idiomatic
// departures documented at their definitions:
//   - every operation returns an `Effect` instead of executing synchronously (`errors.ts`,
//     `collection.ts`, `singleton.ts`, `storage.ts`);
//   - `subscribe()` returns a `Scope`-based resource Effect instead of taking a paired
//     `unsubscribe()` call (`Collection.subscribe`, `Singleton.subscribe` in `collection.ts` /
//     `singleton.ts`).

export type { Key, ListOptions } from "./types.js";
export { keyString } from "./types.js";

export {
  StorageError,
  IndexConflictError,
  type TypedStorageError,
} from "./errors.js";

export type { Subscriber, SingletonSubscriber } from "./subscriber.js";

export { collection } from "./schema.js";
export type { IndexFunction, PrimaryKeySpec } from "./schema.js";

export {
  createCollection,
  type UniqueIndex,
  type NonUniqueIndex,
  type Collection,
  type CollectionImpl,
} from "./collection.js";

export { createSingleton, type Singleton } from "./singleton.js";

export { createEffectTypedStorage, type TypedStorage } from "./storage.js";
