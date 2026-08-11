/** @enchiridion/effect-module */
import { parseJSONWithoutDuplicateMembers, sha256Hex } from "@enchiridion/protocol";
import type { OwnerVaultStorageAddress } from "./repository";
import type { OwnerVaultStorageRecord } from "./storage-registry";
import type { OwnerVaultBackupManifest, OwnerVaultBackupPage, OwnerVaultSignedBackupManifest } from "./backup-types";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const base64 = /^[A-Za-z0-9+/]{43}=$/u;
const identifier = /^[A-Za-z0-9_-]{1,128}$/u;
const hash = (bytes: Uint8Array): string => {
  const hex = sha256Hex(bytes);
  let binary = "";
  for (let index = 0; index < hex.length; index += 2) binary += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2), 16));
  return btoa(binary);
};

export const ownerVaultBackupDigest = hash;
export const validOwnerVaultBackupDigest = (value: unknown): value is string =>
  typeof value === "string" && base64.test(value) && (() => { try { return btoa(atob(value)) === value; } catch { return false; } })();

/** The archive inventory keeps padded base64; Directory control commits the
 * same SHA-256 in canonical unpadded base64url. */
export const ownerVaultBackupControlDigest = (bytes: Uint8Array): string =>
  ownerVaultBackupDigest(bytes).replace(/\+/gu, "-").replace(/\//gu, "_").slice(0, -1);
export const validOwnerVaultBackupControlDigest = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value) && (() => {
    try {
      const padded = `${value.replace(/-/gu, "+").replace(/_/gu, "/")}=`;
      return btoa(atob(padded)) === padded;
    } catch {
      return false;
    }
  })();

const canonicalValue = (value: unknown): string | undefined => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    const entries = value.map(canonicalValue);
    return entries.some((entry) => entry === undefined) ? undefined : `[${entries.join(",")}]`;
  }
  if (typeof value !== "object" || value === undefined) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
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
): { readonly address: OwnerVaultStorageAddress; readonly record: OwnerVaultStorageRecord } | undefined => {
  try {
    const text = decoder.decode(bytes);
    const parsed = parseJSONWithoutDuplicateMembers(text);
    const canonical = canonicalOwnerVaultBackupBytes(parsed);
    if (canonical === undefined || decoder.decode(canonical) !== text || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const root = parsed as Record<string, unknown>;
    if (Object.keys(root).length !== 2 || !("address" in root) || !("record" in root)) return undefined;
    const address = root.address;
    const record = root.record;
    if (address === null || typeof address !== "object" || Array.isArray(address) || record === null || typeof record !== "object" || Array.isArray(record)) return undefined;
    const item = address as Record<string, unknown>;
    const stored = record as Record<string, unknown>;
    if (Object.keys(item).some((key) => key !== "category" && key !== "identifier") || typeof item.category !== "string" || (item.identifier !== undefined && (typeof item.identifier !== "string" || !identifier.test(item.identifier)))) return undefined;
    if (Object.keys(stored).length !== 3 || stored.version !== 1 || typeof stored.category !== "string" || stored.payload === null || typeof stored.payload !== "object" || Array.isArray(stored.payload) || stored.category !== item.category) return undefined;
    return { address: item.identifier === undefined ? { category: item.category as OwnerVaultStorageAddress["category"] } : { category: item.category as OwnerVaultStorageAddress["category"], identifier: item.identifier }, record: { category: stored.category as OwnerVaultStorageRecord["category"], version: 1, payload: stored.payload as Readonly<Record<string, unknown>> } };
  } catch { return undefined; }
};

export const canonicalManifestBytes = (manifest: OwnerVaultBackupManifest): Uint8Array | undefined => canonicalOwnerVaultBackupBytes(manifest);
export const canonicalSignedManifestBytes = (signed: OwnerVaultSignedBackupManifest): Uint8Array | undefined => canonicalOwnerVaultBackupBytes(signed);
export const canonicalPageBytes = (page: OwnerVaultBackupPage): Uint8Array | undefined => canonicalOwnerVaultBackupBytes(page);

export const decodeCanonicalSignedManifest = (bytes: Uint8Array): OwnerVaultSignedBackupManifest | undefined => {
  try {
    const text = decoder.decode(bytes);
    const parsed = parseJSONWithoutDuplicateMembers(text);
    const canonical = canonicalOwnerVaultBackupBytes(parsed);
    if (canonical === undefined || decoder.decode(canonical) !== text || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const source = parsed as Record<string, unknown>;
    if (Object.keys(source).length !== 2 || source.manifest === null || typeof source.manifest !== "object" || source.signature === null || typeof source.signature !== "object") return undefined;
    return source as unknown as OwnerVaultSignedBackupManifest;
  } catch { return undefined; }
};
