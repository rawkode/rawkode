/**
 * Internal change-notification shape used both by user-provided subscriptions and by this
 * package's own index-maintenance machinery (each index registers a `Subscriber` on the owning
 * collection to keep itself in sync transactionally). Ported unchanged from cloudflare-os's
 * `typed-storage` — see `Collection.subscribe` in `collection.ts` for how this is surfaced
 * through Effect's resource model at the public boundary.
 */
export interface Subscriber<T> {
  add(record: T): void;
  update(oldRecord: T, newRecord: T): void;
  remove(record: T): void;
}

/** The `Singleton` analog of `Subscriber<T>`. */
export interface SingletonSubscriber<T> {
  update(value: T): void;
}
