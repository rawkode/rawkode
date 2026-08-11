/** @enchiridion/effect-module */
import { parseJSONWithoutDuplicateMembers, sha256Hex } from "@enchiridion/protocol";
import type {
  OwnerVaultBackupManifest,
  OwnerVaultBackupPage,
  OwnerVaultSignedBackupManifest,
} from "./backup-types";
import type { OwnerVaultStorageAddress } from "./repository";
import {
  type OwnerVaultStorageCategory,
  type OwnerVaultStorageRecord,
  ownerVaultStorageCategories,
} from "./storage-registry";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const base64 = /^[A-Za-z0-9+/]{43}=$/u;
const identifier = /^[A-Za-z0-9_-]{1,128}$/u;

const plainRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
const exactKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const safeNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** The only path from an untrusted category string into the closed category union. */
const storageCategory = (value: unknown): OwnerVaultStorageCategory | undefined =>
  ownerVaultStorageCategories.find((category) => category === value);
const hash = (bytes: Uint8Array): string => {
  const hex = sha256Hex(bytes);
  let binary = "";
  for (let index = 0; index < hex.length; index += 2)
    binary += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2), 16));
  return btoa(binary);
};

export const ownerVaultBackupDigest = hash;
export const validOwnerVaultBackupDigest = (value: unknown): value is string =>
  typeof value === "string" &&
  base64.test(value) &&
  (() => {
    try {
      return btoa(atob(value)) === value;
    } catch {
      return false;
    }
  })();

/** The archive inventory keeps padded base64; Directory control commits the
 * same SHA-256 in canonical unpadded base64url. */
export const ownerVaultBackupControlDigest = (bytes: Uint8Array): string =>
  ownerVaultBackupDigest(bytes).replace(/\+/gu, "-").replace(/\//gu, "_").slice(0, -1);
export const validOwnerVaultBackupControlDigest = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9_-]{43}$/u.test(value) &&
  (() => {
    try {
      const padded = `${value.replace(/-/gu, "+").replace(/_/gu, "/")}=`;
      return btoa(atob(padded)) === padded;
    } catch {
      return false;
    }
  })();

const canonicalValue = (value: unknown): string | undefined => {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    const entries = value.map(canonicalValue);
    return entries.some((entry) => entry === undefined) ? undefined : `[${entries.join(",")}]`;
  }
  const record = plainRecord(value);
  if (record === undefined) return undefined;
  const keys = Object.keys(record).sort();
  const entries: string[] = [];
  for (const key of keys) {
    const child = canonicalValue(record[key]);
    if (child === undefined) return undefined;
    entries.push(`${JSON.stringify(key)}:${child}`);
  }
  return `{${entries.join(",")}}`;
};

export const canonicalOwnerVaultBackupBytes = (value: unknown): Uint8Array | undefined => {
  const text = canonicalValue(value);
  return text === undefined ? undefined : encoder.encode(text);
};

export const canonicalSnapshotRecordBytes = (
  address: OwnerVaultStorageAddress,
  record: OwnerVaultStorageRecord,
): Uint8Array | undefined => canonicalOwnerVaultBackupBytes({ address, record });

export const decodeSnapshotRecordBytes = (
  bytes: Uint8Array,
):
  | { readonly address: OwnerVaultStorageAddress; readonly record: OwnerVaultStorageRecord }
  | undefined => {
  try {
    const text = decoder.decode(bytes);
    const parsed = parseJSONWithoutDuplicateMembers(text);
    const canonical = canonicalOwnerVaultBackupBytes(parsed);
    if (
      canonical === undefined ||
      decoder.decode(canonical) !== text ||
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    )
      return undefined;
    const root = plainRecord(parsed);
    if (root === undefined || !exactKeys(root, ["address", "record"])) return undefined;
    const item = plainRecord(root.address);
    const stored = plainRecord(root.record);
    if (item === undefined || stored === undefined) return undefined;
    if (
      Object.keys(item).some((key) => key !== "category" && key !== "identifier") ||
      typeof item.category !== "string" ||
      (item.identifier !== undefined &&
        (typeof item.identifier !== "string" || !identifier.test(item.identifier)))
    )
      return undefined;
    const category = storageCategory(item.category);
    const payload = plainRecord(stored.payload);
    if (
      category === undefined ||
      Object.keys(stored).length !== 3 ||
      stored.version !== 1 ||
      typeof stored.category !== "string" ||
      payload === undefined ||
      stored.category !== item.category
    )
      return undefined;
    return {
      address: item.identifier === undefined ? { category } : { category, identifier: item.identifier },
      record: { category, version: 1, payload },
    };
  } catch {
    return undefined;
  }
};

export const canonicalManifestBytes = (
  manifest: OwnerVaultBackupManifest,
): Uint8Array | undefined => canonicalOwnerVaultBackupBytes(manifest);
export const canonicalSignedManifestBytes = (
  signed: OwnerVaultSignedBackupManifest,
): Uint8Array | undefined => canonicalOwnerVaultBackupBytes(signed);
export const canonicalPageBytes = (page: OwnerVaultBackupPage): Uint8Array | undefined =>
  canonicalOwnerVaultBackupBytes(page);

const decodeManifestPageDescriptor = (
  value: unknown,
): OwnerVaultBackupManifest["pages"][number] | undefined => {
  const source = plainRecord(value);
  return source !== undefined &&
    exactKeys(source, ["count", "digest", "key", "ordinal", "size"]) &&
    safeNonNegative(source.ordinal) &&
    typeof source.key === "string" &&
    typeof source.digest === "string" &&
    safeNonNegative(source.count) &&
    safeNonNegative(source.size)
    ? {
        ordinal: source.ordinal,
        key: source.key,
        digest: source.digest,
        count: source.count,
        size: source.size,
      }
    : undefined;
};

/** Exact structural decoder: unknown, missing, or mistyped members fail closed. */
const decodeManifest = (value: unknown): OwnerVaultBackupManifest | undefined => {
  const source = plainRecord(value);
  const scope = source === undefined ? undefined : plainRecord(source.source);
  if (
    source === undefined ||
    scope === undefined ||
    !exactKeys(source, [
      "appendLogDigest",
      "appendLogSequence",
      "backupID",
      "catalogDigest",
      "highWaterMark",
      "objectCount",
      "pages",
      "pinProof",
      "source",
      "totalBytes",
      "version",
    ]) ||
    source.version !== 1 ||
    typeof source.backupID !== "string" ||
    !exactKeys(scope, ["generationEpoch", "ownerID", "vaultID"]) ||
    typeof scope.ownerID !== "string" ||
    typeof scope.vaultID !== "string" ||
    !safeNonNegative(scope.generationEpoch) ||
    typeof source.highWaterMark !== "string" ||
    !safeNonNegative(source.appendLogSequence) ||
    typeof source.appendLogDigest !== "string" ||
    typeof source.catalogDigest !== "string" ||
    typeof source.pinProof !== "string" ||
    !safeNonNegative(source.totalBytes) ||
    !safeNonNegative(source.objectCount) ||
    !Array.isArray(source.pages)
  )
    return undefined;
  const pages: OwnerVaultBackupManifest["pages"][number][] = [];
  for (const page of source.pages) {
    const decoded = decodeManifestPageDescriptor(page);
    if (decoded === undefined) return undefined;
    pages.push(decoded);
  }
  return {
    version: 1,
    backupID: source.backupID,
    source: {
      ownerID: scope.ownerID,
      vaultID: scope.vaultID,
      generationEpoch: scope.generationEpoch,
    },
    highWaterMark: source.highWaterMark,
    appendLogSequence: source.appendLogSequence,
    appendLogDigest: source.appendLogDigest,
    catalogDigest: source.catalogDigest,
    pinProof: source.pinProof,
    totalBytes: source.totalBytes,
    objectCount: source.objectCount,
    pages,
  };
};

const decodeManifestSignature = (
  value: unknown,
): OwnerVaultSignedBackupManifest["signature"] | undefined => {
  const source = plainRecord(value);
  return source !== undefined &&
    exactKeys(source, ["keyID", "signatureDERBase64"]) &&
    typeof source.keyID === "string" &&
    typeof source.signatureDERBase64 === "string"
    ? { keyID: source.keyID, signatureDERBase64: source.signatureDERBase64 }
    : undefined;
};

export const decodeCanonicalSignedManifest = (
  bytes: Uint8Array,
): OwnerVaultSignedBackupManifest | undefined => {
  try {
    const text = decoder.decode(bytes);
    const parsed = parseJSONWithoutDuplicateMembers(text);
    const canonical = canonicalOwnerVaultBackupBytes(parsed);
    if (canonical === undefined || decoder.decode(canonical) !== text) return undefined;
    const source = plainRecord(parsed);
    if (source === undefined || !exactKeys(source, ["manifest", "signature"])) return undefined;
    const manifest = decodeManifest(source.manifest);
    const signature = decodeManifestSignature(source.signature);
    return manifest === undefined || signature === undefined ? undefined : { manifest, signature };
  } catch {
    return undefined;
  }
};
