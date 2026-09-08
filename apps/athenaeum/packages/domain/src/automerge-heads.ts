/**
 * Stable, storage-independent representation of Automerge heads.
 *
 * Automerge heads are binary actor hashes. Keep their byte representation, ordering and empty
 * sentinel identical wherever a persisted page/proposal/commit hash is produced.
 */
export const canonicalAutomergeHeadsHash = (heads: Iterable<Uint8Array | string>): string =>
  Array.from(heads, (head) => typeof head === "string" ? head : Array.from(head).join(","))
    .sort()
    .join("|") || "empty"
