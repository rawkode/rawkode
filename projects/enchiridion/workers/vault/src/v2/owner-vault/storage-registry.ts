/**
 * The complete physical state vocabulary for a fresh OwnerVault v2.
 *
 * Nothing writes storage in this package yet. This is a structural scaffold:
 * it classifies physical keys, enforces their common envelope, and fixes
 * snapshot/restore policy before field codecs exist. Category-specific field
 * codecs belong with the repositories that introduce those fields.
 */
export const ownerVaultStoragePrefix = "v2.ov/";

export const ownerVaultStorageCategories = [
  "root.identity",
  "root.admission",
  "root.floors",
  "root.log-head",
  "root.runtime",
  "root.accounting",
  "catalog.derived",
  "audit.restore-source",
  "device",
  "device-challenge",
  "nonce",
  "jti",
  "capability-receipt",
  "operation-receipt",
  "operation-index",
  "session",
  "resume",
  "rate-window",
  "append-log.entry",
  "append-log.head",
  "blob.metadata",
  "blob.accounting",
  "blob.reference",
  "blob.tombstone",
  "blob.lease",
  "blob.purge",
  "backup.pin",
  "backup.manifest",
  "backup.page",
  "backup.restore-journal",
  "control.initialization-ack",
  "control.floor-sync",
] as const;

export type OwnerVaultStorageCategory = (typeof ownerVaultStorageCategories)[number];
export type OwnerVaultSnapshotPolicy = "include" | "exclude" | "audit";
export type OwnerVaultRestorePolicy = "apply" | "never" | "target-overlay" | "rebuild" | "audit-only";

/** Immutable target identity for one fresh OwnerVault generation. */
export interface OwnerVaultTargetRoot {
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generationEpoch: number;
  readonly namespaceState: "PRIVATE" | "ACTIVE";
}

/** Restore source identity is descriptive audit data, never target authority. */
export interface OwnerVaultAuditSourceScope {
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generationEpoch: number;
}

export interface OwnerVaultStorageRecord {
  readonly category: OwnerVaultStorageCategory;
  readonly version: 1;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface OwnerVaultStorageCategoryDefinition {
  readonly category: OwnerVaultStorageCategory;
  readonly snapshot: OwnerVaultSnapshotPolicy;
  readonly restore: OwnerVaultRestorePolicy;
  readonly maximumBytes: number;
  readonly key: (identifier?: string) => string;
  readonly matches: (key: string) => boolean;
  readonly decode: (value: unknown) => OwnerVaultStorageRecord | undefined;
}

/** A source record may be copied into a restore only when both policies permit it. */
export const isRestorableOwnerVaultStorageCategory = (
  definition: Pick<OwnerVaultStorageCategoryDefinition, "snapshot" | "restore">,
): boolean => definition.snapshot === "include" && definition.restore === "apply";

const identifierPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const appendSequencePattern = /^[0-9]{20}$/u;
const authorityScopeKeys = new Set(["ownerID", "vaultID", "generationEpoch", "namespaceState", "sourceOwnerID", "sourceVaultID", "sourceGenerationEpoch", "sourceScope"]);
const regularMaximumBytes = 16 * 1024;
const rootMaximumBytes = 8 * 1024;
const appendMaximumBytes = 1_100_000; // append wire payloads remain limited to 1 MiB.
const catalogMaximumBytes = 24 * 1024;
const journalMaximumBytes = 32 * 1024;
const maximumBlobTrackedLeases = 32;
const blobHashPattern = /^[a-f0-9]{64}$/u;

const plainRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;

const exactKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
};

const hasForbiddenScope = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasForbiddenScope);
  const record = plainRecord(value);
  if (record === undefined) return false;
  return Object.entries(record).some(
    ([key, entry]) => authorityScopeKeys.has(key) || hasForbiddenScope(entry),
  );
};

const validTargetRoot = (value: unknown): value is OwnerVaultTargetRoot => {
  const source = plainRecord(value);
  return (
    source !== undefined &&
    exactKeys(source, ["ownerID", "vaultID", "generationEpoch", "namespaceState"]) &&
    typeof source.ownerID === "string" &&
    source.ownerID.length > 0 &&
    typeof source.vaultID === "string" &&
    source.vaultID.length > 0 &&
    typeof source.generationEpoch === "number" &&
    Number.isSafeInteger(source.generationEpoch) &&
    source.generationEpoch >= 1 &&
    (source.namespaceState === "PRIVATE" || source.namespaceState === "ACTIVE")
  );
};

const validAuditSourceScope = (value: unknown): value is OwnerVaultAuditSourceScope => {
  const source = plainRecord(value);
  return (
    source !== undefined &&
    exactKeys(source, ["ownerID", "vaultID", "generationEpoch"]) &&
    typeof source.ownerID === "string" &&
    source.ownerID.length > 0 &&
    typeof source.vaultID === "string" &&
    source.vaultID.length > 0 &&
    typeof source.generationEpoch === "number" &&
    Number.isSafeInteger(source.generationEpoch) &&
    source.generationEpoch >= 1
  );
};

/** The security fence is target-local; generation authority is root.identity. */
const validSecurityFloor = (value: unknown): boolean => {
  const source = plainRecord(value);
  return source !== undefined &&
    exactKeys(source, ["securityFloor"]) &&
    typeof source.securityFloor === "number" &&
    Number.isSafeInteger(source.securityFloor) &&
    source.securityFloor >= 0;
};

/**
 * Blob lifecycle accounting is a bounded derived index, never a source of
 * identity or a cross-domain aggregate. It is rebuilt from blob rows after
 * restore and its exact shape makes corruption fail closed.
 */
const validBlobAccounting = (value: unknown): boolean => {
  const source = plainRecord(value);
  if (
    source === undefined ||
    !exactKeys(source, ["leaseIDs", "prospectiveFinalBytes", "purgeSHA256s", "referencedBytes", "reservedStageBytes"])
  )
    return false;
  const leaseIDs = source.leaseIDs;
  const purgeSHA256s = source.purgeSHA256s;
  return [source.referencedBytes, source.reservedStageBytes, source.prospectiveFinalBytes].every(
    (entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0,
  ) &&
    Array.isArray(leaseIDs) &&
    leaseIDs.length <= maximumBlobTrackedLeases &&
    leaseIDs.every((entry) => typeof entry === "string" && identifierPattern.test(entry)) &&
    new Set(leaseIDs).size === leaseIDs.length &&
    Array.isArray(purgeSHA256s) &&
    purgeSHA256s.length <= maximumBlobTrackedLeases &&
    purgeSHA256s.every((entry) => typeof entry === "string" && blobHashPattern.test(entry)) &&
    new Set(purgeSHA256s).size === purgeSHA256s.length;
};

const decodeEnvelope = (
  category: OwnerVaultStorageCategory,
  value: unknown,
  permits: (payload: Readonly<Record<string, unknown>>) => boolean,
): OwnerVaultStorageRecord | undefined => {
  const envelope = plainRecord(value);
  if (
    envelope === undefined ||
    !exactKeys(envelope, ["category", "payload", "version"]) ||
    envelope.category !== category ||
    envelope.version !== 1
  )
    return undefined;
  const payload = plainRecord(envelope.payload);
  return payload !== undefined && permits(payload) ? { category, version: 1, payload } : undefined;
};

const staticKey = (name: string) => {
  const key = `${ownerVaultStoragePrefix}${name}`;
  return { key: () => key, matches: (candidate: string) => candidate === key };
};
const keyedFamily = (name: string) => {
  const prefix = `${ownerVaultStoragePrefix}${name}/`;
  return {
    key: (identifier?: string) => {
      if (identifier === undefined || !identifierPattern.test(identifier))
        throw new OwnerVaultStorageRegistryError("invalid_key");
      return `${prefix}${identifier}`;
    },
    matches: (candidate: string) => identifierPattern.test(candidate.slice(prefix.length)) && candidate.startsWith(prefix),
  };
};

export class OwnerVaultStorageRegistryError extends Error {
  constructor(readonly reason: "invalid_key" | "unknown_key" | "invalid_record") {
    super(`owner_vault_storage_${reason}`);
  }
}

const definitions: readonly OwnerVaultStorageCategoryDefinition[] = [
  // DirectoryControl creates the target identity; a source identity is never restored.
  { category: "root.identity", snapshot: "exclude", restore: "never", maximumBytes: rootMaximumBytes, ...staticKey("root/identity"), decode: (value) => decodeEnvelope("root.identity", value, (payload) => validTargetRoot(payload)) },
  { category: "root.admission", snapshot: "exclude", restore: "never", maximumBytes: rootMaximumBytes, ...staticKey("root/admission"), decode: (value) => decodeEnvelope("root.admission", value, (payload) => !hasForbiddenScope(payload)) },
  { category: "root.floors", snapshot: "exclude", restore: "target-overlay", maximumBytes: rootMaximumBytes, ...staticKey("root/floors"), decode: (value) => decodeEnvelope("root.floors", value, validSecurityFloor) },
  { category: "root.log-head", snapshot: "exclude", restore: "rebuild", maximumBytes: rootMaximumBytes, ...staticKey("root/log-head"), decode: (value) => decodeEnvelope("root.log-head", value, (payload) => !hasForbiddenScope(payload)) },
  { category: "root.runtime", snapshot: "exclude", restore: "never", maximumBytes: rootMaximumBytes, ...staticKey("root/runtime"), decode: (value) => decodeEnvelope("root.runtime", value, (payload) => !hasForbiddenScope(payload)) },
  { category: "root.accounting", snapshot: "exclude", restore: "rebuild", maximumBytes: rootMaximumBytes, ...staticKey("root/accounting"), decode: (value) => decodeEnvelope("root.accounting", value, (payload) => !hasForbiddenScope(payload)) },
  { category: "catalog.derived", snapshot: "exclude", restore: "rebuild", maximumBytes: catalogMaximumBytes, ...keyedFamily("catalog"), decode: (value) => decodeEnvelope("catalog.derived", value, (payload) => !hasForbiddenScope(payload)) },
  { category: "audit.restore-source", snapshot: "audit", restore: "audit-only", maximumBytes: regularMaximumBytes, ...staticKey("audit/restore-source"), decode: (value) => decodeEnvelope("audit.restore-source", value, (payload) => exactKeys(payload, ["audit", "source"]) && validAuditSourceScope(payload.source) && !hasForbiddenScope(payload.audit)) },
  ...(["device", "operation-receipt", "operation-index"] as const).map((category) => ({ category, snapshot: "include" as const, restore: "apply" as const, maximumBytes: regularMaximumBytes, ...keyedFamily(category), decode: (value: unknown) => decodeEnvelope(category, value, (payload) => !hasForbiddenScope(payload)) })),
  // Challenges, replay fences, capabilities, and live sessions are target-local security state.
  ...(["device-challenge", "nonce", "jti", "capability-receipt", "session", "resume", "rate-window"] as const).map((category) => ({ category, snapshot: "exclude" as const, restore: "never" as const, maximumBytes: regularMaximumBytes, ...keyedFamily(category), decode: (value: unknown) => decodeEnvelope(category, value, (payload) => !hasForbiddenScope(payload)) })),
  { category: "append-log.entry", snapshot: "include", restore: "apply", maximumBytes: appendMaximumBytes, key: (identifier?: string) => { if (identifier === undefined || !appendSequencePattern.test(identifier)) throw new OwnerVaultStorageRegistryError("invalid_key"); return `${ownerVaultStoragePrefix}append-log/entry/${identifier}`; }, matches: (key) => /^v2\.ov\/append-log\/entry\/[0-9]{20}$/u.test(key), decode: (value) => decodeEnvelope("append-log.entry", value, (payload) => !hasForbiddenScope(payload)) },
  { category: "append-log.head", snapshot: "exclude", restore: "rebuild", maximumBytes: rootMaximumBytes, ...staticKey("append-log/head"), decode: (value) => decodeEnvelope("append-log.head", value, (payload) => !hasForbiddenScope(payload)) },
  { category: "blob.accounting", snapshot: "exclude", restore: "rebuild", maximumBytes: rootMaximumBytes, ...staticKey("blob/accounting"), decode: (value) => decodeEnvelope("blob.accounting", value, validBlobAccounting) },
  ...(["blob.metadata", "blob.reference", "blob.tombstone", "backup.manifest", "backup.page"] as const).map((category) => ({ category, snapshot: "include" as const, restore: "apply" as const, maximumBytes: regularMaximumBytes, ...keyedFamily(category.replace(".", "/")), decode: (value: unknown) => decodeEnvelope(category, value, (payload) => !hasForbiddenScope(payload)) })),
  ...(["blob.lease", "blob.purge", "backup.pin"] as const).map((category) => ({ category, snapshot: "exclude" as const, restore: "never" as const, maximumBytes: regularMaximumBytes, ...keyedFamily(category.replace(".", "/")), decode: (value: unknown) => decodeEnvelope(category, value, (payload) => !hasForbiddenScope(payload)) })),
  { category: "backup.restore-journal", snapshot: "exclude", restore: "never", maximumBytes: journalMaximumBytes, ...keyedFamily("backup/restore-journal"), decode: (value) => decodeEnvelope("backup.restore-journal", value, (payload) => !hasForbiddenScope(payload)) },
  { category: "control.initialization-ack", snapshot: "exclude", restore: "never", maximumBytes: regularMaximumBytes, ...keyedFamily("control/initialization-ack"), decode: (value) => decodeEnvelope("control.initialization-ack", value, (payload) => !hasForbiddenScope(payload)) },
  { category: "control.floor-sync", snapshot: "exclude", restore: "never", maximumBytes: regularMaximumBytes, ...keyedFamily("control/floor-sync"), decode: (value) => decodeEnvelope("control.floor-sync", value, (payload) => !hasForbiddenScope(payload)) },
];

export const ownerVaultStorageRegistry: ReadonlyMap<OwnerVaultStorageCategory, OwnerVaultStorageCategoryDefinition> = new Map(definitions.map((definition) => [definition.category, Object.freeze(definition)]));

/** Resolves exactly one category; unknown and ambiguous physical keys are fatal. */
export const ownerVaultStorageDefinitionForKey = (key: string): OwnerVaultStorageCategoryDefinition => {
  const matches = definitions.filter((definition) => definition.matches(key));
  if (matches.length !== 1) throw new OwnerVaultStorageRegistryError("unknown_key");
  return matches[0]!;
};

export const assertOwnerVaultStorageRecord = (key: string, value: unknown): OwnerVaultStorageRecord => {
  const definition = ownerVaultStorageDefinitionForKey(key);
  const record = definition.decode(value);
  if (record === undefined) throw new OwnerVaultStorageRegistryError("invalid_record");
  return record;
};
