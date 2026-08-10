/**
 * The complete physical state vocabulary for a fresh OwnerVault v2.
 *
 * Nothing writes storage in this package yet. This is a structural scaffold:
 * it classifies physical keys, enforces their common envelope, and fixes
 * snapshot/restore policy before field codecs exist. Category-specific field
 * codecs belong with the repositories that introduce those fields.
 */
import {
  isOwnerVaultCatalogCurrentPayload,
  ownerVaultCatalogMaximumObjectBytes,
  isOwnerVaultCatalogPagePayload,
  isOwnerVaultCatalogRevisionIdentifier,
  isOwnerVaultCatalogRootPayload,
} from "./catalog";

export const ownerVaultStoragePrefix = "v2.ov/";

export const ownerVaultStorageCategories = [
  "root.identity",
  "root.admission",
  "root.floors",
  "root.log-head",
  "root.runtime",
  "root.accounting",
  // catalog.derived was the pre-C1 non-authoritative placeholder. Fresh v2
  // namespaces use immutable roots/pages plus this one mutable head pointer.
  "catalog.current",
  "catalog.root",
  "catalog.page",
  // Retention is deliberately separate from immutable catalog roots. Pins
  // may retain a historical root without changing the root's digest.
  "catalog.retention",
  "audit.restore-source",
  "device",
  "device-challenge",
  "nonce",
  "jti",
  "capability-receipt",
  "capability-receipt-index",
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
  "backup.preimage",
  "backup.gc-journal",
  "backup.manifest",
  "backup.page",
  "backup.restore-journal",
  "socket.admission",
  "socket.jti",
  "control.initialization-ack",
  "control.floor-sync",
] as const;

export type OwnerVaultStorageCategory = (typeof ownerVaultStorageCategories)[number];
export type OwnerVaultSnapshotPolicy = "include" | "exclude" | "audit";
export type OwnerVaultRestorePolicy =
  | "apply"
  | "never"
  | "target-overlay"
  | "rebuild"
  | "audit-only";

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
const catalogPageIdentifierPattern = /^[0-9]{20}-[0-9]{4}$/u;
const catalogRevisionIdentifierPattern = /^[0-9]{20}$/u;
const backupPreimageIdentifierPattern = /^[0-9]{20}-[0-9]{4}$/u;
const authorityScopeKeys = new Set([
  "ownerID",
  "vaultID",
  "generationEpoch",
  "namespaceState",
  "sourceOwnerID",
  "sourceVaultID",
  "sourceGenerationEpoch",
  "sourceScope",
]);
const regularMaximumBytes = 16 * 1024;
const rootMaximumBytes = 8 * 1024;
const appendMaximumBytes = 1_100_000; // append wire payloads remain limited to 1 MiB.
/** Catalog builder targets 24 KiB; this is the corruption/admission hard stop. */
const catalogMaximumBytes = 32 * 1024;
const journalMaximumBytes = 32 * 1024;
const maximumBlobTrackedLeases = 32;
const maximumCapabilityReceiptIndexEntries = 64;
const blobHashPattern = /^[a-f0-9]{64}$/u;

const plainRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;

const exactKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
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

/** Restore headers retain the immutable *source* scope solely to seed D0. */
const validRestoreJournal = (value: unknown): boolean => {
  const source = plainRecord(value);
  if (source === undefined) return false;
  const receipt = source.receipt === undefined ? undefined : plainRecord(source.receipt);
  const receiptRoot = receipt === undefined ? undefined : plainRecord(receipt.targetRoot);
  const rest = Object.fromEntries(
    Object.entries(source).filter(([key]) => key !== "source" && key !== "receipt"),
  );
  const receiptRest =
    receipt === undefined
      ? undefined
      : Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "targetRoot"));
  return (
    (source.source === undefined || validAuditSourceScope(source.source)) &&
    (receipt === undefined ||
      (validTargetRoot(receiptRoot) &&
        receiptRest !== undefined &&
        !hasForbiddenScope(receiptRest))) &&
    !hasForbiddenScope(rest)
  );
};

const validAppendHead = (value: unknown): boolean => {
  const source = plainRecord(value);
  return (
    source !== undefined &&
    exactKeys(source, ["appendLogDigest", "appendLogSequence"]) &&
    typeof source.appendLogSequence === "number" &&
    Number.isSafeInteger(source.appendLogSequence) &&
    source.appendLogSequence >= 0 &&
    typeof source.appendLogDigest === "string" &&
    /^[a-f0-9]{64}$/u.test(source.appendLogDigest)
  );
};

/** The security fence is target-local; generation authority is root.identity. */
const validSecurityFloor = (value: unknown): boolean => {
  const source = plainRecord(value);
  return (
    source !== undefined &&
    exactKeys(source, ["securityFloor"]) &&
    typeof source.securityFloor === "number" &&
    Number.isSafeInteger(source.securityFloor) &&
    source.securityFloor >= 0
  );
};

/** A fixed singleton, never a storage listing: it gives alarms an exact,
 * bounded expiration cursor for otherwise opaque capability receipts. */
const validCapabilityReceiptIndex = (value: unknown): boolean => {
  const source = plainRecord(value);
  if (source === undefined || !exactKeys(source, ["cursor", "entries"]) || !Number.isSafeInteger(source.cursor) || source.cursor < 0 || !Array.isArray(source.entries) || source.entries.length > maximumCapabilityReceiptIndexEntries) return false;
  let previous = "";
  return source.entries.every((entry) => {
    const row = plainRecord(entry);
    if (row === undefined || !exactKeys(row, ["expiresAtSeconds", "jti"]) || typeof row.jti !== "string" || !identifierPattern.test(row.jti) || !Number.isSafeInteger(row.expiresAtSeconds) || row.expiresAtSeconds < 1) return false;
    const sortKey = `${row.expiresAtSeconds.toString().padStart(12, "0")}/${row.jti}`;
    const ordered = previous === "" || previous < sortKey;
    previous = sortKey;
    return ordered;
  }) && (source.entries.length === 0 ? source.cursor === 0 : source.cursor < source.entries.length);
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
    !exactKeys(source, [
      "leaseIDs",
      "prospectiveFinalBytes",
      "purgeSHA256s",
      "referencedBytes",
      "reservedStageBytes",
    ])
  )
    return false;
  const leaseIDs = source.leaseIDs;
  const purgeSHA256s = source.purgeSHA256s;
  return (
    [source.referencedBytes, source.reservedStageBytes, source.prospectiveFinalBytes].every(
      (entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0,
    ) &&
    Array.isArray(leaseIDs) &&
    leaseIDs.length <= maximumBlobTrackedLeases &&
    leaseIDs.every((entry) => typeof entry === "string" && identifierPattern.test(entry)) &&
    new Set(leaseIDs).size === leaseIDs.length &&
    Array.isArray(purgeSHA256s) &&
    purgeSHA256s.length <= maximumBlobTrackedLeases &&
    purgeSHA256s.every((entry) => typeof entry === "string" && blobHashPattern.test(entry)) &&
    new Set(purgeSHA256s).size === purgeSHA256s.length
  );
};

/** Socket tokens are never stored. This bounded journal retains only an
 * irreversible fingerprint plus the non-bearer state required to reconcile
 * a prepared hibernating socket after an isolate restart. */
const validSocketAdmission = (value: unknown): boolean => {
  const source = plainRecord(value);
  const challenge = source === undefined ? undefined : plainRecord(source.challenge);
  return (
    source !== undefined &&
    exactKeys(source, [
      "acceptedAtMilliseconds",
      "bindingNonce",
      "challenge",
      "controlEpoch",
      "createdAtMilliseconds",
      "credentialEpoch",
      "deviceID",
      "expiresAtMilliseconds",
      "expiresAtSeconds",
      "fingerprint",
      "generationEpoch",
      "issuedAtSeconds",
      "jti",
      "namespaceState",
      "operationID",
      "ownerID",
      "phase",
      "quotaReserved",
      "routingEpoch",
      "securityFloor",
      "sessionID",
      "socketGeneration",
      "upgradeNonce",
      "vaultID",
    ]) &&
    source.phase !== undefined &&
    ["PREPARED", "ACCEPTED", "EXPIRED", "CLOSED"].includes(source.phase as string) &&
    typeof source.bindingNonce === "string" &&
    /^[A-Za-z0-9_-]{22,128}$/u.test(source.bindingNonce) &&
    typeof source.fingerprint === "string" &&
    blobHashPattern.test(source.fingerprint) &&
    typeof source.jti === "string" &&
    /^[A-Za-z0-9_-]{16,64}$/u.test(source.jti) &&
    typeof source.operationID === "string" &&
    /^[A-Za-z0-9_-]{16,64}$/u.test(source.operationID) &&
    typeof source.ownerID === "string" &&
    identifierPattern.test(source.ownerID) &&
    typeof source.vaultID === "string" &&
    identifierPattern.test(source.vaultID) &&
    source.ownerID !== source.vaultID &&
    typeof source.generationEpoch === "number" &&
    Number.isSafeInteger(source.generationEpoch) &&
    source.generationEpoch >= 1 &&
    (source.namespaceState === "PRIVATE" || source.namespaceState === "ACTIVE") &&
    typeof source.routingEpoch === "number" &&
    Number.isSafeInteger(source.routingEpoch) &&
    source.routingEpoch >= 1 &&
    typeof source.credentialEpoch === "number" &&
    Number.isSafeInteger(source.credentialEpoch) &&
    source.credentialEpoch >= 1 &&
    typeof source.controlEpoch === "number" &&
    Number.isSafeInteger(source.controlEpoch) &&
    source.controlEpoch >= 1 &&
    typeof source.securityFloor === "number" &&
    Number.isSafeInteger(source.securityFloor) &&
    source.securityFloor >= 1 &&
    typeof source.deviceID === "string" &&
    identifierPattern.test(source.deviceID) &&
    typeof source.sessionID === "string" &&
    identifierPattern.test(source.sessionID) &&
    typeof source.upgradeNonce === "string" &&
    /^[A-Za-z0-9_-]{22,128}$/u.test(source.upgradeNonce) &&
    typeof source.createdAtMilliseconds === "number" &&
    Number.isSafeInteger(source.createdAtMilliseconds) &&
    source.createdAtMilliseconds >= 0 &&
    typeof source.acceptedAtMilliseconds === "number" &&
    Number.isSafeInteger(source.acceptedAtMilliseconds) &&
    (source.phase === "PREPARED" || source.phase === "EXPIRED"
      ? source.acceptedAtMilliseconds === 0
      : source.acceptedAtMilliseconds >= source.createdAtMilliseconds) &&
    typeof source.issuedAtSeconds === "number" &&
    Number.isSafeInteger(source.issuedAtSeconds) &&
    source.issuedAtSeconds >= 0 &&
    typeof source.expiresAtSeconds === "number" &&
    Number.isSafeInteger(source.expiresAtSeconds) &&
    source.expiresAtSeconds > source.issuedAtSeconds &&
    typeof source.expiresAtMilliseconds === "number" &&
    Number.isSafeInteger(source.expiresAtMilliseconds) &&
    source.expiresAtMilliseconds === source.expiresAtSeconds * 1_000 &&
    source.expiresAtMilliseconds > source.createdAtMilliseconds &&
    typeof source.socketGeneration === "number" &&
    Number.isSafeInteger(source.socketGeneration) &&
    source.socketGeneration >= 1 &&
    typeof source.quotaReserved === "boolean" &&
    challenge !== undefined &&
    exactKeys(challenge, ["challengeBase64", "challengeID", "challengeAudience"]) &&
    typeof challenge.challengeID === "string" &&
    identifierPattern.test(challenge.challengeID) &&
    typeof challenge.challengeBase64 === "string" &&
    /^[A-Za-z0-9_-]{22,128}$/u.test(challenge.challengeBase64) &&
    challenge.challengeAudience === "owner-vault-socket"
  );
};

const validSocketJti = (value: unknown): boolean => {
  const source = plainRecord(value);
  return (
    source !== undefined &&
    exactKeys(source, ["expiresAtMilliseconds", "fingerprint", "operationID"]) &&
    typeof source.operationID === "string" &&
    /^[A-Za-z0-9_-]{16,64}$/u.test(source.operationID) &&
    typeof source.fingerprint === "string" &&
    blobHashPattern.test(source.fingerprint) &&
    typeof source.expiresAtMilliseconds === "number" &&
    Number.isSafeInteger(source.expiresAtMilliseconds) &&
    source.expiresAtMilliseconds > 0
  );
};

/** Backup pins are the one excluded local record that names its own target scope. */
const validBackupPin = (value: unknown): boolean => {
  const source = plainRecord(value);
  const scope = source === undefined ? undefined : plainRecord(source.scope);
  const keys = source === undefined ? [] : Object.keys(source).sort();
  const expected = [
    "appendLogDigest",
    "appendLogSequence",
    "backupID",
    "catalogDigest",
    "catalogRevision",
    "highWaterMark",
    "pinProof",
    "retained",
    "rootDigest",
    "scope",
    "state",
    ...(source?.manifestDigest === undefined ? [] : ["manifestDigest"]),
  ].sort();
  return (
    source !== undefined &&
    scope !== undefined &&
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    exactKeys(scope, ["ownerID", "vaultID", "generationEpoch"]) &&
    typeof scope.ownerID === "string" &&
    typeof scope.vaultID === "string" &&
    typeof scope.generationEpoch === "number" &&
    Number.isSafeInteger(scope.generationEpoch) &&
    scope.generationEpoch >= 1 &&
    typeof source.backupID === "string" &&
    identifierPattern.test(source.backupID) &&
    typeof source.catalogRevision === "number" &&
    Number.isSafeInteger(source.catalogRevision) &&
    source.catalogRevision >= 0 &&
    [source.catalogDigest, source.highWaterMark, source.rootDigest].every(
      (entry) => typeof entry === "string" && /^[A-Za-z0-9+/]{43}=$/u.test(entry),
    ) &&
    typeof source.appendLogSequence === "number" &&
    Number.isSafeInteger(source.appendLogSequence) &&
    source.appendLogSequence >= 0 &&
    typeof source.appendLogDigest === "string" &&
    /^[a-f0-9]{64}$/u.test(source.appendLogDigest) &&
    typeof source.pinProof === "string" &&
    /^[A-Za-z0-9_-]{16,512}$/u.test(source.pinProof) &&
    typeof source.retained === "boolean" &&
    (source.state === "OPEN" ||
      source.state === "COMPLETED" ||
      source.state === "ABORTED" ||
      source.state === "EXPIRED") &&
    (source.manifestDigest === undefined ||
      (typeof source.manifestDigest === "string" &&
        /^[A-Za-z0-9+/]{43}=$/u.test(source.manifestDigest)))
  );
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
    matches: (candidate: string) =>
      identifierPattern.test(candidate.slice(prefix.length)) && candidate.startsWith(prefix),
  };
};

export class OwnerVaultStorageRegistryError extends Error {
  constructor(readonly reason: "invalid_key" | "unknown_key" | "invalid_record") {
    super(`owner_vault_storage_${reason}`);
  }
}

const definitions: readonly OwnerVaultStorageCategoryDefinition[] = [
  // DirectoryControl creates the target identity; a source identity is never restored.
  {
    category: "root.identity",
    snapshot: "exclude",
    restore: "never",
    maximumBytes: rootMaximumBytes,
    ...staticKey("root/identity"),
    decode: (value) =>
      decodeEnvelope("root.identity", value, (payload) => validTargetRoot(payload)),
  },
  {
    category: "root.admission",
    snapshot: "exclude",
    restore: "never",
    maximumBytes: rootMaximumBytes,
    ...staticKey("root/admission"),
    decode: (value) =>
      decodeEnvelope("root.admission", value, (payload) => !hasForbiddenScope(payload)),
  },
  {
    category: "root.floors",
    snapshot: "exclude",
    restore: "target-overlay",
    maximumBytes: rootMaximumBytes,
    ...staticKey("root/floors"),
    decode: (value) => decodeEnvelope("root.floors", value, validSecurityFloor),
  },
  {
    category: "root.log-head",
    snapshot: "exclude",
    restore: "rebuild",
    maximumBytes: rootMaximumBytes,
    ...staticKey("root/log-head"),
    decode: (value) => decodeEnvelope("root.log-head", value, validAppendHead),
  },
  {
    category: "root.runtime",
    snapshot: "exclude",
    restore: "never",
    maximumBytes: rootMaximumBytes,
    ...staticKey("root/runtime"),
    decode: (value) =>
      decodeEnvelope("root.runtime", value, (payload) => !hasForbiddenScope(payload)),
  },
  {
    category: "root.accounting",
    snapshot: "exclude",
    restore: "rebuild",
    maximumBytes: rootMaximumBytes,
    ...staticKey("root/accounting"),
    decode: (value) =>
      decodeEnvelope("root.accounting", value, (payload) => !hasForbiddenScope(payload)),
  },
  {
    category: "catalog.current",
    snapshot: "exclude",
    restore: "rebuild",
    maximumBytes: rootMaximumBytes,
    ...staticKey("catalog/current"),
    decode: (value) => decodeEnvelope("catalog.current", value, isOwnerVaultCatalogCurrentPayload),
  },
  {
    category: "catalog.root",
    snapshot: "exclude",
    restore: "rebuild",
    maximumBytes: rootMaximumBytes,
    key: (identifier?: string) => {
      if (identifier === undefined || !isOwnerVaultCatalogRevisionIdentifier(identifier))
        throw new OwnerVaultStorageRegistryError("invalid_key");
      return `${ownerVaultStoragePrefix}catalog/root/${identifier}`;
    },
    matches: (key) => /^v2\.ov\/catalog\/root\/[0-9]{20}$/u.test(key),
    decode: (value) => decodeEnvelope("catalog.root", value, isOwnerVaultCatalogRootPayload),
  },
  {
    category: "catalog.page",
    snapshot: "exclude",
    restore: "rebuild",
    maximumBytes: catalogMaximumBytes,
    key: (identifier?: string) => {
      if (identifier === undefined || !catalogPageIdentifierPattern.test(identifier))
        throw new OwnerVaultStorageRegistryError("invalid_key");
      return `${ownerVaultStoragePrefix}catalog/page/${identifier}`;
    },
    matches: (key) => /^v2\.ov\/catalog\/page\/[0-9]{20}-[0-9]{4}$/u.test(key),
    decode: (value) => decodeEnvelope("catalog.page", value, isOwnerVaultCatalogPagePayload),
  },
  {
    category: "catalog.retention",
    snapshot: "exclude",
    restore: "never",
    maximumBytes: rootMaximumBytes,
    key: (identifier?: string) => {
      if (identifier === undefined || !catalogRevisionIdentifierPattern.test(identifier))
        throw new OwnerVaultStorageRegistryError("invalid_key");
      return `${ownerVaultStoragePrefix}catalog/retention/${identifier}`;
    },
    matches: (key) => /^v2\.ov\/catalog\/retention\/[0-9]{20}$/u.test(key),
    decode: (value) =>
      decodeEnvelope(
        "catalog.retention",
        value,
        (payload) =>
          exactKeys(payload, ["pinCount"]) &&
          typeof payload.pinCount === "number" &&
          Number.isSafeInteger(payload.pinCount) &&
          payload.pinCount >= 0,
      ),
  },
  {
    category: "audit.restore-source",
    snapshot: "audit",
    restore: "audit-only",
    maximumBytes: regularMaximumBytes,
    ...staticKey("audit/restore-source"),
    decode: (value) =>
      decodeEnvelope(
        "audit.restore-source",
        value,
        (payload) =>
          exactKeys(payload, ["audit", "source"]) &&
          validAuditSourceScope(payload.source) &&
          !hasForbiddenScope(payload.audit),
      ),
  },
  {
    category: "capability-receipt-index",
    snapshot: "exclude",
    restore: "never",
    maximumBytes: regularMaximumBytes,
    ...staticKey("capability-receipts/index"),
    decode: (value) => decodeEnvelope("capability-receipt-index", value, validCapabilityReceiptIndex),
  },
  ...(["device", "operation-receipt", "operation-index"] as const).map((category) => ({
    category,
    snapshot: "include" as const,
    restore: "apply" as const,
    maximumBytes: regularMaximumBytes,
    ...keyedFamily(category),
    decode: (value: unknown) =>
      decodeEnvelope(category, value, (payload) => !hasForbiddenScope(payload)),
  })),
  // Challenges, replay fences, capabilities, and live sessions are target-local security state.
  ...(
    [
      "device-challenge",
      "nonce",
      "jti",
      "capability-receipt",
      "session",
      "resume",
      "rate-window",
    ] as const
  ).map((category) => ({
    category,
    snapshot: "exclude" as const,
    restore: "never" as const,
    maximumBytes: regularMaximumBytes,
    ...keyedFamily(category),
    decode: (value: unknown) =>
      decodeEnvelope(category, value, (payload) => !hasForbiddenScope(payload)),
  })),
  {
    category: "append-log.entry",
    snapshot: "include",
    restore: "apply",
    maximumBytes: appendMaximumBytes,
    key: (identifier?: string) => {
      if (identifier === undefined || !appendSequencePattern.test(identifier))
        throw new OwnerVaultStorageRegistryError("invalid_key");
      return `${ownerVaultStoragePrefix}append-log/entry/${identifier}`;
    },
    matches: (key) => /^v2\.ov\/append-log\/entry\/[0-9]{20}$/u.test(key),
    decode: (value) =>
      decodeEnvelope("append-log.entry", value, (payload) => !hasForbiddenScope(payload)),
  },
  {
    category: "append-log.head",
    snapshot: "exclude",
    restore: "rebuild",
    maximumBytes: rootMaximumBytes,
    ...staticKey("append-log/head"),
    decode: (value) => decodeEnvelope("append-log.head", value, validAppendHead),
  },
  {
    category: "blob.accounting",
    snapshot: "exclude",
    restore: "rebuild",
    maximumBytes: rootMaximumBytes,
    ...staticKey("blob/accounting"),
    decode: (value) => decodeEnvelope("blob.accounting", value, validBlobAccounting),
  },
  ...(
    ["blob.metadata", "blob.reference", "blob.tombstone", "backup.manifest", "backup.page"] as const
  ).map((category) => ({
    category,
    snapshot: "include" as const,
    restore: "apply" as const,
    maximumBytes: regularMaximumBytes,
    ...keyedFamily(category.replace(".", "/")),
    decode: (value: unknown) =>
      decodeEnvelope(category, value, (payload) => !hasForbiddenScope(payload)),
  })),
  ...(["blob.lease", "blob.purge"] as const).map((category) => ({
    category,
    snapshot: "exclude" as const,
    restore: "never" as const,
    maximumBytes: regularMaximumBytes,
    ...keyedFamily(category.replace(".", "/")),
    decode: (value: unknown) =>
      decodeEnvelope(category, value, (payload) => !hasForbiddenScope(payload)),
  })),
  {
    category: "backup.pin",
    snapshot: "exclude",
    restore: "never",
    maximumBytes: regularMaximumBytes,
    ...keyedFamily("backup/pin"),
    decode: (value) => decodeEnvelope("backup.pin", value, validBackupPin),
  },
  {
    category: "backup.preimage",
    snapshot: "exclude",
    restore: "never",
    maximumBytes: ownerVaultCatalogMaximumObjectBytes,
    key: (identifier?: string) => {
      if (identifier === undefined || !backupPreimageIdentifierPattern.test(identifier))
        throw new OwnerVaultStorageRegistryError("invalid_key");
      return `${ownerVaultStoragePrefix}backup/preimage/${identifier}`;
    },
    matches: (key) => /^v2\.ov\/backup\/preimage\/[0-9]{20}-[0-9]{4}$/u.test(key),
    decode: (value) =>
      decodeEnvelope("backup.preimage", value, (payload) => !hasForbiddenScope(payload)),
  },
  {
    category: "backup.gc-journal",
    snapshot: "exclude",
    restore: "never",
    maximumBytes: journalMaximumBytes,
    ...keyedFamily("backup/gc-journal"),
    decode: (value) =>
      decodeEnvelope("backup.gc-journal", value, (payload) => !hasForbiddenScope(payload)),
  },
  {
    category: "backup.restore-journal",
    snapshot: "exclude",
    restore: "never",
    maximumBytes: journalMaximumBytes,
    ...keyedFamily("backup/restore-journal"),
    decode: (value) => decodeEnvelope("backup.restore-journal", value, validRestoreJournal),
  },
  {
    category: "socket.admission",
    snapshot: "exclude",
    restore: "never",
    maximumBytes: regularMaximumBytes,
    ...keyedFamily("socket/admission"),
    decode: (value) => decodeEnvelope("socket.admission", value, validSocketAdmission),
  },
  {
    category: "socket.jti",
    snapshot: "exclude",
    restore: "never",
    maximumBytes: regularMaximumBytes,
    ...keyedFamily("socket/jti"),
    decode: (value) => decodeEnvelope("socket.jti", value, validSocketJti),
  },
  {
    category: "control.initialization-ack",
    snapshot: "exclude",
    restore: "never",
    maximumBytes: regularMaximumBytes,
    ...keyedFamily("control/initialization-ack"),
    decode: (value) =>
      decodeEnvelope("control.initialization-ack", value, (payload) => !hasForbiddenScope(payload)),
  },
  {
    category: "control.floor-sync",
    snapshot: "exclude",
    restore: "never",
    maximumBytes: regularMaximumBytes,
    ...keyedFamily("control/floor-sync"),
    decode: (value) =>
      decodeEnvelope("control.floor-sync", value, (payload) => !hasForbiddenScope(payload)),
  },
];

export const ownerVaultStorageRegistry: ReadonlyMap<
  OwnerVaultStorageCategory,
  OwnerVaultStorageCategoryDefinition
> = new Map(definitions.map((definition) => [definition.category, Object.freeze(definition)]));

/** Resolves exactly one category; unknown and ambiguous physical keys are fatal. */
export const ownerVaultStorageDefinitionForKey = (
  key: string,
): OwnerVaultStorageCategoryDefinition => {
  const matches = definitions.filter((definition) => definition.matches(key));
  if (matches.length !== 1) throw new OwnerVaultStorageRegistryError("unknown_key");
  return matches[0]!;
};

export const assertOwnerVaultStorageRecord = (
  key: string,
  value: unknown,
): OwnerVaultStorageRecord => {
  const definition = ownerVaultStorageDefinitionForKey(key);
  const record = definition.decode(value);
  if (record === undefined) throw new OwnerVaultStorageRegistryError("invalid_record");
  return record;
};
