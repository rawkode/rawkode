import type { Key, ListOptions, StorageValue } from "./types.js";
import { keyString } from "./types.js";

// Internal helper class that implements a view of KV storage by adding a prefix to all keys.
// Also accepts `Key` (string | number) as the key type, encoding numbers so that they sort
// nicely. Ported unchanged (mechanics-wise) from cloudflare-os's typed-storage `KvPrefixedView` —
// this is the trickiest correctness logic in the original (index maintenance), so it is kept
// synchronous and internal; the Effect boundary is applied one layer up, around
// `storage.transactionSync()`/`storage.kv` call sites, not inside this class.
//
// Not exported from the package: callers only ever see the Effect-wrapped Collection/Singleton
// API built on top of it.
export class KvPrefixedView<T extends StorageValue> {
  #kv: SyncKvStorage;
  #name: string;

  // If the key is itself a property of T, we'd like to avoid duplicating it in storage. So, we
  // null out the property in the value before storing, and then put it back on load.
  //
  // However, there's a catch: We don't necessarily know at load time (especially in list())
  // whether the key type was a string or a number originally. So, we only do this nulling at
  // store time for string keys, and we only perform the replacement at load time if the property
  // was nulled out. Integers won't take much storage space anyway.
  #keyPropName?: keyof T;

  constructor(kv: SyncKvStorage, name: string, keyPropName?: keyof T) {
    this.#kv = kv;
    this.#name = name;
    this.#keyPropName = keyPropName;
  }

  #rawKey(key: Key) {
    return `${this.#name}:${keyString(key)}`;
  }

  get(key: Key): T | undefined {
    let kstr = keyString(key);
    let result = this.#kv.get<T>(`${this.#name}:${kstr}`);
    if (this.#keyPropName && result !== undefined) {
      if (result[this.#keyPropName] === null) {
        result[this.#keyPropName] = <any>key;
      }
    }
    return result;
  }

  *list(options: ListOptions<Key> = {}): Generator<T, void> {
    for (let [key, value] of this.#kv.list<T>({
      start: options.start !== undefined ? this.#rawKey(options.start) : undefined,
      startAfter: options.startAfter !== undefined ? this.#rawKey(options.startAfter) : undefined,
      end: options.end !== undefined ? this.#rawKey(options.end) : undefined,
      prefix: options.prefix !== undefined ? this.#rawKey(options.prefix) : `${this.#name}:`,
      reverse: options.reverse,
      limit: options.limit,
    })) {
      if (this.#keyPropName) {
        if (value[this.#keyPropName] === null) {
          value[this.#keyPropName] = <any>key.slice(this.#name.length + 1);
        }
      }
      yield value;
    }
  }

  *listKeys(options: ListOptions<Key> = {}): Generator<string, void> {
    for (let [key, _] of this.#kv.list<T>({
      start: options.start !== undefined ? this.#rawKey(options.start) : undefined,
      startAfter: options.startAfter !== undefined ? this.#rawKey(options.startAfter) : undefined,
      end: options.end !== undefined ? this.#rawKey(options.end) : undefined,
      prefix: options.prefix !== undefined ? this.#rawKey(options.prefix) : `${this.#name}:`,
      reverse: options.reverse,
      limit: options.limit,
    })) {
      yield key.slice(this.#name.length + 1);
    }
  }

  put(key: Key, value: T): void {
    if (this.#keyPropName !== undefined && typeof key === "string") {
      value[this.#keyPropName] = <any>null;
      try {
        this.#kv.put<T>(this.#rawKey(key), value);
      } finally {
        // Change the value back to how we found it. The caller may intend to keep using it.
        value[this.#keyPropName] = <any>key;
      }
    } else {
      this.#kv.put<T>(this.#rawKey(key), value);
    }
  }

  delete(key: Key): boolean {
    return this.#kv.delete(this.#rawKey(key));
  }

  getChild<U extends StorageValue>(name: string): KvPrefixedView<U> {
    return new KvPrefixedView(this.#kv, `${this.#name}.${name}`);
  }

  getUniqueId(): number {
    let key = `${this.#name}#`;
    let id = this.#kv.get<number>(key) || 0;
    this.#kv.put(key, id + 1);
    return id;
  }
}
