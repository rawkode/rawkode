/** @enchiridion/effect-module */
import { sha256Hex } from "@enchiridion/protocol";

/**
 * The OwnerVault catalog is a compact, immutable index over snapshot rows.
 * It is deliberately not a listing cache: readers follow the current root,
 * verify its immutable pages, then fetch the addressed physical records.
 */
export const ownerVaultCatalogMaximumObjects = 4096;
export const ownerVaultCatalogMaximumObjectBytes = 8 * 1024 * 1024;
export const ownerVaultCatalogMaximumTotalBytes = 96 * 1024 * 1024;
export const ownerVaultCatalogMaximumPageEntries = 128;
export const ownerVaultCatalogTargetPageBytes = 24 * 1024;
export const ownerVaultCatalogMaximumPageBytes = 32 * 1024;

const encoder = new TextEncoder();
const base64 = /^[A-Za-z0-9+/]{43}=$/u;
const hex = /^[a-f0-9]{64}$/u;
const revision = /^[0-9]{20}$/u;
const pageIdentifier = /^[0-9]{20}-[0-9]{4}$/u;

export interface OwnerVaultCatalogEntry {
  readonly ordinal: number;
  readonly key: string;
  readonly category: string;
  readonly bytes: number;
  readonly digest: string;
}

export interface OwnerVaultCatalogPageDescriptor {
  readonly ordinal: number;
  readonly identifier: string;
  readonly count: number;
  readonly bytes: number;
  readonly digest: string;
}

export interface OwnerVaultCatalogRootPayload {
  readonly scope: {
    readonly ownerID: string;
    readonly vaultID: string;
    readonly generationEpoch: number;
    readonly namespaceState: "PRIVATE" | "ACTIVE";
  };
  readonly catalogRevision: number;
  readonly catalogDigest: string;
  readonly pages: readonly OwnerVaultCatalogPageDescriptor[];
  /** Catalog identity; it is not the append-chain proof. */
  readonly highWaterMark: string;
  readonly appendLogSequence: number;
  readonly appendLogDigest: string;
}

export interface OwnerVaultCatalogCurrentPayload {
  readonly catalogRevision: number;
  readonly rootDigest: string;
}

const plainRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;

const exact = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const safeNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const canonical = (value: unknown): string | undefined => {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    const entries = value.map(canonical);
    return entries.some((entry) => entry === undefined) ? undefined : `[${entries.join(",")}]`;
  }
  const object = plainRecord(value);
  if (object === undefined) return undefined;
  const entries: string[] = [];
  for (const key of Object.keys(object).sort()) {
    const child = canonical(object[key]);
    if (child === undefined) return undefined;
    entries.push(`${JSON.stringify(key)}:${child}`);
  }
  return `{${entries.join(",")}}`;
};

export const ownerVaultCatalogCanonicalBytes = (value: unknown): Uint8Array | undefined => {
  const text = canonical(value);
  return text === undefined ? undefined : encoder.encode(text);
};

export const ownerVaultCatalogDigest = (value: unknown): string | undefined => {
  const bytes = ownerVaultCatalogCanonicalBytes(value);
  if (bytes === undefined) return undefined;
  const hex = sha256Hex(bytes);
  let binary = "";
  for (let index = 0; index < hex.length; index += 2)
    binary += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2), 16));
  return btoa(binary);
};

export const ownerVaultCatalogRevisionIdentifier = (value: number): string | undefined =>
  safeNonNegativeInteger(value) && value <= Number.MAX_SAFE_INTEGER
    ? String(value).padStart(20, "0")
    : undefined;

export const ownerVaultCatalogPageIdentifier = (
  catalogRevision: number,
  ordinal: number,
): string | undefined => {
  const root = ownerVaultCatalogRevisionIdentifier(catalogRevision);
  return root !== undefined && safeNonNegativeInteger(ordinal) && ordinal <= 9999
    ? `${root}-${String(ordinal).padStart(4, "0")}`
    : undefined;
};

export const isOwnerVaultCatalogCurrentPayload = (
  value: unknown,
): value is OwnerVaultCatalogCurrentPayload => {
  const source = plainRecord(value);
  return (
    source !== undefined &&
    exact(source, ["catalogRevision", "rootDigest"]) &&
    safeNonNegativeInteger(source.catalogRevision) &&
    typeof source.rootDigest === "string" &&
    base64.test(source.rootDigest)
  );
};

const isEntry = (value: unknown, ordinal: number): value is OwnerVaultCatalogEntry => {
  const source = plainRecord(value);
  return (
    source !== undefined &&
    exact(source, ["ordinal", "key", "category", "bytes", "digest"]) &&
    source.ordinal === ordinal &&
    typeof source.key === "string" &&
    source.key.startsWith("v2.ov/") &&
    source.key.length <= 512 &&
    typeof source.category === "string" &&
    source.category.length > 0 &&
    source.category.length <= 128 &&
    safeNonNegativeInteger(source.bytes) &&
    source.bytes <= ownerVaultCatalogMaximumObjectBytes &&
    typeof source.digest === "string" &&
    base64.test(source.digest)
  );
};

export const isOwnerVaultCatalogPagePayload = (
  value: unknown,
): value is { readonly entries: readonly OwnerVaultCatalogEntry[]; readonly digest: string } => {
  const source = plainRecord(value);
  if (
    source === undefined ||
    !exact(source, ["entries", "digest"]) ||
    !Array.isArray(source.entries) ||
    source.entries.length > ownerVaultCatalogMaximumPageEntries ||
    typeof source.digest !== "string" ||
    !base64.test(source.digest)
  )
    return false;
  const first = source.entries[0] === undefined ? 0 : plainRecord(source.entries[0])?.ordinal;
  if (
    !safeNonNegativeInteger(first) ||
    first > Number.MAX_SAFE_INTEGER - Math.max(0, source.entries.length - 1) ||
    !source.entries.every((entry, index) => isEntry(entry, first + index))
  )
    return false;
  const digest = ownerVaultCatalogDigest(source.entries);
  const bytes = ownerVaultCatalogCanonicalBytes({
    entries: source.entries,
    digest: source.digest,
  })?.byteLength;
  return (
    digest === source.digest && bytes !== undefined && bytes <= ownerVaultCatalogMaximumPageBytes
  );
};

const isScope = (value: unknown): boolean => {
  const source = plainRecord(value);
  return (
    source !== undefined &&
    exact(source, ["ownerID", "vaultID", "generationEpoch", "namespaceState"]) &&
    typeof source.ownerID === "string" &&
    source.ownerID.length > 0 &&
    typeof source.vaultID === "string" &&
    source.vaultID.length > 0 &&
    safeNonNegativeInteger(source.generationEpoch) &&
    source.generationEpoch >= 1 &&
    (source.namespaceState === "PRIVATE" || source.namespaceState === "ACTIVE")
  );
};

const isDescriptor = (
  value: unknown,
  ordinal: number,
  catalogRevision: number,
): value is OwnerVaultCatalogPageDescriptor => {
  const source = plainRecord(value);
  const expectedPrefix = ownerVaultCatalogRevisionIdentifier(catalogRevision);
  return (
    source !== undefined &&
    exact(source, ["ordinal", "identifier", "count", "bytes", "digest"]) &&
    source.ordinal === ordinal &&
    typeof source.identifier === "string" &&
    expectedPrefix !== undefined &&
    source.identifier.startsWith(`${expectedPrefix}-`) &&
    pageIdentifier.test(source.identifier) &&
    safeNonNegativeInteger(source.count) &&
    source.count > 0 &&
    source.count <= ownerVaultCatalogMaximumPageEntries &&
    safeNonNegativeInteger(source.bytes) &&
    source.bytes <= ownerVaultCatalogMaximumPageBytes &&
    typeof source.digest === "string" &&
    base64.test(source.digest)
  );
};

export const isOwnerVaultCatalogRootPayload = (
  value: unknown,
): value is OwnerVaultCatalogRootPayload => {
  const source = plainRecord(value);
  const bytes = source === undefined ? undefined : ownerVaultCatalogCanonicalBytes(source);
  /** Narrowed once as a local const so collection callbacks keep the proof. */
  const catalogRevision = source?.catalogRevision;
  return (
    source !== undefined &&
    exact(source, [
      "scope",
      "catalogRevision",
      "catalogDigest",
      "pages",
      "highWaterMark",
      "appendLogSequence",
      "appendLogDigest",
    ]) &&
    isScope(source.scope) &&
    safeNonNegativeInteger(catalogRevision) &&
    typeof source.catalogDigest === "string" &&
    base64.test(source.catalogDigest) &&
    Array.isArray(source.pages) &&
    source.pages.length <= ownerVaultCatalogMaximumObjects / ownerVaultCatalogMaximumPageEntries &&
    source.pages.every((page, index) => isDescriptor(page, index, catalogRevision)) &&
    typeof source.highWaterMark === "string" &&
    base64.test(source.highWaterMark) &&
    safeNonNegativeInteger(source.appendLogSequence) &&
    typeof source.appendLogDigest === "string" &&
    hex.test(source.appendLogDigest) &&
    bytes !== undefined &&
    bytes.byteLength <= 8 * 1024
  );
};

/** Partitions dense, already-sorted entries without ever using storage list order. */
export const ownerVaultCatalogPages = (
  entries: readonly Omit<OwnerVaultCatalogEntry, "ordinal">[],
):
  | readonly {
      readonly entries: readonly OwnerVaultCatalogEntry[];
      readonly digest: string;
      readonly bytes: number;
    }[]
  | undefined => {
  const pages: { entries: OwnerVaultCatalogEntry[]; digest: string; bytes: number }[] = [];
  let page: OwnerVaultCatalogEntry[] = [];
  const push = (): boolean => {
    if (page.length === 0) return true;
    const digest = ownerVaultCatalogDigest(page);
    const bytes = ownerVaultCatalogCanonicalBytes({ entries: page, digest })?.byteLength;
    if (digest === undefined || bytes === undefined || bytes > ownerVaultCatalogMaximumPageBytes)
      return false;
    pages.push({ entries: page, digest, bytes });
    page = [];
    return true;
  };
  for (const [ordinal, entry] of entries.entries()) {
    const next = { ...entry, ordinal };
    const candidate = [...page, next];
    const candidateDigest = ownerVaultCatalogDigest(candidate);
    const candidateBytes = ownerVaultCatalogCanonicalBytes({
      entries: candidate,
      digest: candidateDigest,
    })?.byteLength;
    if (candidateDigest === undefined || candidateBytes === undefined) return undefined;
    if (
      candidate.length > ownerVaultCatalogMaximumPageEntries ||
      candidateBytes > ownerVaultCatalogTargetPageBytes
    ) {
      if (!push()) return undefined;
      page = [next];
    } else page = candidate;
  }
  return push() ? pages : undefined;
};

export const ownerVaultCatalogEntryDigest = (value: unknown): string | undefined =>
  ownerVaultCatalogDigest(value);
export const isOwnerVaultCatalogRevisionIdentifier = (value: string): boolean =>
  revision.test(value);

export const ownerVaultCatalogWithinQuota = (
  entries: readonly Pick<OwnerVaultCatalogEntry, "bytes">[],
): boolean =>
  entries.length <= ownerVaultCatalogMaximumObjects &&
  entries.every(
    (entry) =>
      safeNonNegativeInteger(entry.bytes) && entry.bytes <= ownerVaultCatalogMaximumObjectBytes,
  ) &&
  entries.reduce((total, entry) => total + entry.bytes, 0) <= ownerVaultCatalogMaximumTotalBytes;
