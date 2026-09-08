// Key/value primitives shared by every layer of this package. Ported unchanged (mechanics-wise)
// from cloudflare-os's packages/typed-storage/src/index.ts — see that file's "Types" section.

/** Specifies constraints on an indexed list() operation. */
export type ListOptions<T = string> = {
  /** List starting at the given key, including the key itself. */
  start?: T;

  /** List starting immediately after the given key. */
  startAfter?: T;

  /** List ending immediately before the given key. */
  end?: T;

  /**
   * List only keys starting with the given prefix.
   *
   * This only makes sense for string keys, not integers.
   */
  prefix?: T extends string ? T : never;

  /**
   * Stop after the given number of matches.
   *
   * Note that for non-unique indexes, this counts the number of matching keys, not the number of
   * records. Hence, more than `limit` records may be returned. Meanwhile, a subsequent `list()` can
   * use `startAfter` set to the last record's key and be assured that it won't miss anything.
   */
  limit?: number;

  /**
   * Normally, keys are listed in ascending order. Set `reverse: true` to list in descending order.
   *
   * For non-unique indexes, this also reverses the order of matches for a particular key.
   */
  reverse?: boolean;

  /**
   * When listing by an index where each record may have multiple keys, the default is to
   * list a record again for each key within the list range. Set `dedupe: true` to list each
   * record only once.
   *
   * Note that when used together with the `limit` option, the limit is enforced on the total
   * number of matching keys, before de-duplication, hence de-duplication may cause the returned
   * list to have fewer than `limit` keys even if the limit was reached. Keep in mind also that
   * any de-duplication applies only within a single call to list(), so if you are making several
   * `limit`ed calls in sequence to list incrementally, you may still get duplicates between calls.
   * Generally, `limit` and `dedupe` don't work well together.
   */
  dedupe?: boolean;
};

export type Key = string | number;
export type StorageValue = NonNullable<unknown>;

/** Encodes a `Key` as a string suitable for storage, so that integer keys sort correctly
 *  alongside string keys of the same collection (variable-length hex, length-prefixed). */
export function keyString(key: Key): string {
  if (typeof key === "string") {
    return key;
  } else if (Number.isInteger(key) && key < Number.MAX_SAFE_INTEGER) {
    let hex = key.toString(16);
    let prefix = String.fromCharCode(96 + hex.length);
    return prefix + hex;
  } else {
    throw new TypeError(`Storage keys must be strings or integers. Got: ${key}`);
  }
}
