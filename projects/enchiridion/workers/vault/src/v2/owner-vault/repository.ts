/** @enchiridion/effect-module */
import {
  type DurableObjectBoundaryError,
  type DurableObjectStorage,
  type DurableObjectTransactionDomainCodec,
  durableObjectTransactionDomainCodec,
} from "@enchiridion/runtime";
import { Data, Effect, Schema } from "effect";
import { ownerVaultAppendProofD0 } from "./append-proof";
import { canonicalSnapshotRecordBytes, ownerVaultBackupDigest } from "./backup-canonical";
import {
  type OwnerVaultCatalogEntry,
  type OwnerVaultCatalogRootPayload,
  isOwnerVaultCatalogCurrentPayload,
  isOwnerVaultCatalogPagePayload,
  isOwnerVaultCatalogRootPayload,
  ownerVaultCatalogCanonicalBytes,
  ownerVaultCatalogDigest,
  ownerVaultCatalogMaximumObjectBytes,
  ownerVaultCatalogMaximumObjects,
  ownerVaultCatalogMaximumPageEntries,
  ownerVaultCatalogMaximumTotalBytes,
  ownerVaultCatalogPageIdentifier,
  ownerVaultCatalogPages,
  ownerVaultCatalogRevisionIdentifier,
  ownerVaultCatalogWithinQuota,
} from "./catalog";
import {
  type OwnerVaultStorageCategory,
  type OwnerVaultStorageRecord,
  type OwnerVaultTargetRoot,
  assertOwnerVaultStorageRecord,
  isRestorableOwnerVaultStorageCategory,
  ownerVaultStoragePrefix,
  ownerVaultStorageRegistry,
} from "./storage-registry";

const kibibyte = 1024;
const mebibyte = 1024 * kibibyte;

/** Cloudflare's isolate ceiling; this is never itself an admission target. */
export const ownerVaultIsolateCeilingBytes = 128 * mebibyte;
/** Space deliberately left for execution, list pages, and transaction copies. */
export const ownerVaultAdmissionReserveBytes = 16 * mebibyte;
/**
 * The largest sum of application rows this repository will admit.  The
 * accounting envelope has a fixed worst-case allowance below this limit, so
 * successful admission always leaves the full reserve intact below
 * Cloudflare's 128 MiB isolate ceiling.
 */
const identityCategory: OwnerVaultStorageCategory = "root.identity";
const accountingCategory: OwnerVaultStorageCategory = "root.accounting";
const runtimeCategory: OwnerVaultStorageCategory = "root.runtime";
const catalogCurrentCategory: OwnerVaultStorageCategory = "catalog.current";
const catalogRootCategory: OwnerVaultStorageCategory = "catalog.root";
const catalogPageCategory: OwnerVaultStorageCategory = "catalog.page";
const catalogRetentionCategory: OwnerVaultStorageCategory = "catalog.retention";
const backupPreimageCategory: OwnerVaultStorageCategory = "backup.preimage";
const schemaVersion = 1;

const accountingMaximumBytes = ownerVaultStorageRegistry.get(accountingCategory)?.maximumBytes;
if (accountingMaximumBytes === undefined)
  throw new Error("OwnerVault accounting category missing.");
/** Fixed safety subtraction retains the entire reserve even as accounting evolves. */
export const ownerVaultAccountingEnvelopeSafetyBytes = accountingMaximumBytes;
export const ownerVaultMaximumAccountedBytes =
  ownerVaultIsolateCeilingBytes -
  ownerVaultAdmissionReserveBytes -
  ownerVaultAccountingEnvelopeSafetyBytes;

export interface OwnerVaultStorageAddress {
  readonly category: OwnerVaultStorageCategory;
  /** Required exactly for registry families and forbidden for registry singleton rows. */
  readonly identifier?: string;
}

export interface OwnerVaultStoragePage {
  readonly entries: readonly (readonly [key: string, record: OwnerVaultStorageRecord])[];
  readonly nextCursor?: string;
}

export const OwnerVaultInspectionPurpose = {
  BackupSnapshot: "backup-snapshot",
  RestoreAudit: "restore-audit",
} as const;
export type OwnerVaultInspectionPurpose =
  (typeof OwnerVaultInspectionPurpose)[keyof typeof OwnerVaultInspectionPurpose];

const validInspectionPurpose = (purpose: unknown): purpose is OwnerVaultInspectionPurpose =>
  purpose === OwnerVaultInspectionPurpose.BackupSnapshot ||
  purpose === OwnerVaultInspectionPurpose.RestoreAudit;

const inspectionPermits = (
  purpose: OwnerVaultInspectionPurpose,
  category: OwnerVaultStorageCategory,
): boolean => {
  const definition = ownerVaultStorageRegistry.get(category);
  return (
    definition !== undefined &&
    (purpose === OwnerVaultInspectionPurpose.BackupSnapshot
      ? definition.snapshot === "include"
      : purpose === OwnerVaultInspectionPurpose.RestoreAudit && definition.snapshot === "audit")
  );
};

interface Accounting {
  readonly usedBytes: number;
}

interface RuntimeJournal {
  readonly schemaVersion: 1;
  readonly migrationJournal: { readonly state: "ready"; readonly step: 0 };
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;

const exact = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Re-projects an already-typed structure as a storage payload without asserting. */
const asPayload = (value: object): Readonly<Record<string, unknown>> =>
  Object.fromEntries(Object.entries(value));

/** Exact decoder for the persisted root.identity payload; mirrors the registry's validator. */
const decodeTargetRoot = (value: unknown): OwnerVaultTargetRoot | undefined => {
  const source = record(value);
  return source !== undefined &&
    exact(source, ["ownerID", "vaultID", "generationEpoch", "namespaceState"]) &&
    typeof source.ownerID === "string" &&
    source.ownerID.length > 0 &&
    typeof source.vaultID === "string" &&
    source.vaultID.length > 0 &&
    nonNegativeInteger(source.generationEpoch) &&
    source.generationEpoch >= 1 &&
    (source.namespaceState === "PRIVATE" || source.namespaceState === "ACTIVE")
    ? {
        ownerID: source.ownerID,
        vaultID: source.vaultID,
        generationEpoch: source.generationEpoch,
        namespaceState: source.namespaceState,
      }
    : undefined;
};

const decodeAccounting = (value: unknown): Accounting | undefined => {
  const source = record(value);
  return source !== undefined &&
    exact(source, ["usedBytes"]) &&
    nonNegativeInteger(source.usedBytes)
    ? { usedBytes: source.usedBytes }
    : undefined;
};

const decodeRuntimeJournal = (value: unknown): RuntimeJournal | undefined => {
  const source = record(value);
  const journal = source === undefined ? undefined : record(source.migrationJournal);
  return source !== undefined &&
    exact(source, ["schemaVersion", "migrationJournal"]) &&
    source.schemaVersion === schemaVersion &&
    journal !== undefined &&
    exact(journal, ["state", "step"]) &&
    journal.state === "ready" &&
    journal.step === 0
    ? { schemaVersion, migrationJournal: { state: "ready", step: 0 } }
    : undefined;
};

const stableBytes = (
  value: unknown,
): { readonly value: unknown; readonly bytes: number } | undefined => {
  try {
    const source = JSON.stringify(value);
    if (source === undefined) return undefined;
    const normalized: unknown = JSON.parse(source);
    return { value: normalized, bytes: new TextEncoder().encode(source).byteLength };
  } catch {
    return undefined;
  }
};

const envelope = (
  category: OwnerVaultStorageCategory,
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => ({ category, version: 1, payload });

const keyFor = (address: OwnerVaultStorageAddress): string | undefined => {
  const definition = ownerVaultStorageRegistry.get(address.category);
  if (definition === undefined) return undefined;
  try {
    const singleton = definition.key();
    return address.identifier === undefined ? singleton : undefined;
  } catch {
    try {
      return address.identifier === undefined ? undefined : definition.key(address.identifier);
    } catch {
      return undefined;
    }
  }
};

/** Prefix calculation is only a catalog-entry filter, never a storage scan. */
const catalogFilterKey = (address: OwnerVaultStorageAddress): string | undefined => {
  if (address.identifier !== undefined) return keyFor(address);
  const definition = ownerVaultStorageRegistry.get(address.category);
  if (definition === undefined) return undefined;
  try {
    const singleton = definition.key();
    return singleton;
  } catch {
    try {
      const example =
        address.category === "append-log.entry"
          ? definition.key("00000000000000000000")
          : definition.key("x");
      return example.slice(0, example.lastIndexOf("/") + 1);
    } catch {
      return undefined;
    }
  }
};

const serializeRecord = (
  address: OwnerVaultStorageAddress,
  payload: Readonly<Record<string, unknown>>,
):
  | {
      readonly key: string;
      readonly value: unknown;
      readonly bytes: number;
      readonly record: OwnerVaultStorageRecord;
    }
  | undefined => {
  const key = keyFor(address);
  const definition = ownerVaultStorageRegistry.get(address.category);
  if (key === undefined || definition === undefined) return undefined;
  const normalized = stableBytes(envelope(address.category, payload));
  if (normalized === undefined || normalized.bytes > definition.maximumBytes) return undefined;
  try {
    const decoded = assertOwnerVaultStorageRecord(key, normalized.value);
    return { key, value: normalized.value, bytes: normalized.bytes, record: decoded };
  } catch {
    return undefined;
  }
};

const decodeStored = (
  key: string,
  value: unknown,
): { readonly record: OwnerVaultStorageRecord; readonly bytes: number } | undefined => {
  const normalized = stableBytes(value);
  if (normalized === undefined) return undefined;
  try {
    const decoded = assertOwnerVaultStorageRecord(key, normalized.value);
    const definition = ownerVaultStorageRegistry.get(decoded.category);
    if (definition === undefined || normalized.bytes > definition.maximumBytes) return undefined;
    return { record: decoded, bytes: normalized.bytes };
  } catch {
    return undefined;
  }
};

export interface OwnerVaultStorageError {
  readonly _tag: "OwnerVaultStorageError";
  readonly reason:
    | "invalid_address"
    | "invalid_record"
    | "identity_conflict"
    | "migration_required"
    | "nested_transaction"
    | "not_initialized"
    | "inspection_forbidden"
    | "quota_exceeded"
    | "state_corrupt";
}

/**
 * Closed semantic rejections that a v2 OwnerVault domain may raise while it
 * is holding the sole durable transaction.  They are deliberately separate
 * from storage faults: the transaction boundary serializes them, rolls back
 * every staged row, and returns the original typed reason to the caller.
 */
export interface OwnerVaultDomainTransactionError {
  readonly _tag: "OwnerVaultDomainTransactionError";
  readonly reason:
    | "authorization_denied"
    | "capability_replayed"
    | "nonce_replayed"
    | "observed_high_water_ahead"
    | "operation_capacity"
    | "rate_limited"
    | "replay_conflict"
    | "blob_generation_stale"
    | "blob_stage_conflict"
    | "blob_quota_exceeded"
    | "blob_replay_conflict";
}

export class OwnerVaultStorageRepositoryError extends Data.TaggedError(
  "OwnerVaultStorageRepositoryError",
)<{ readonly reason: "listing_unavailable" | "unavailable" }> {}

const storageError = <A = never>(
  reason: OwnerVaultStorageError["reason"],
): Effect.Effect<A, OwnerVaultStorageError> =>
  Effect.fail({ _tag: "OwnerVaultStorageError", reason });

const isOwnerVaultStorageError = (value: unknown): value is OwnerVaultStorageError =>
  record(value)?._tag === "OwnerVaultStorageError";

const isOwnerVaultDomainTransactionError = (
  value: unknown,
): value is OwnerVaultDomainTransactionError =>
  record(value)?._tag === "OwnerVaultDomainTransactionError";

const transactionErrorSchema = Schema.Struct({
  _tag: Schema.Literal("OwnerVaultStorageError"),
  reason: Schema.Literal(
    "invalid_address",
    "invalid_record",
    "identity_conflict",
    "migration_required",
    "nested_transaction",
    "not_initialized",
    "inspection_forbidden",
    "quota_exceeded",
    "state_corrupt",
  ),
});
const domainTransactionErrorSchema = Schema.Struct({
  _tag: Schema.Literal("OwnerVaultDomainTransactionError"),
  reason: Schema.Literal(
    "authorization_denied",
    "capability_replayed",
    "nonce_replayed",
    "observed_high_water_ahead",
    "operation_capacity",
    "rate_limited",
    "replay_conflict",
    "blob_generation_stale",
    "blob_stage_conflict",
    "blob_quota_exceeded",
    "blob_replay_conflict",
  ),
});
const transactionCodec: DurableObjectTransactionDomainCodec<
  OwnerVaultStorageError | OwnerVaultDomainTransactionError
> = durableObjectTransactionDomainCodec(
  Schema.Union(transactionErrorSchema, domainTransactionErrorSchema),
);

export type OwnerVaultStorageTransactionFailure =
  | OwnerVaultStorageError
  | OwnerVaultDomainTransactionError
  | DurableObjectBoundaryError;

/**
 * This brand is intentionally unconstructable outside this module.  The only
 * code that can obtain a transaction is the one native DO transaction below;
 * crypto, R2, WebSocket, and external fetch work have no API surface here.
 */
const ownerVaultTxBrand: unique symbol = Symbol("OwnerVaultTx");
export interface OwnerVaultTx {
  readonly [ownerVaultTxBrand]: "OwnerVaultTx";
  readonly initialize: (
    root: OwnerVaultTargetRoot,
  ) => Effect.Effect<void, OwnerVaultStorageTransactionFailure>;
  readonly get: (
    address: OwnerVaultStorageAddress,
  ) => Effect.Effect<OwnerVaultStorageRecord | undefined, OwnerVaultStorageTransactionFailure>;
  readonly put: (
    address: OwnerVaultStorageAddress,
    payload: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void, OwnerVaultStorageTransactionFailure>;
  /**
   * Writes one verified restore row without making it visible to the live
   * catalog or accounting yet.  Restore import publishes all such rows only
   * after its complete-inventory proof succeeds in the same transaction.
   */
  readonly putRestoreImport: (
    address: OwnerVaultStorageAddress,
    payload: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void, OwnerVaultStorageTransactionFailure>;
  /** Atomically admits the exact suppressed restore rows into the next catalog. */
  readonly publishRestoreImport: (
    addresses: readonly OwnerVaultStorageAddress[],
  ) => Effect.Effect<void, OwnerVaultStorageTransactionFailure>;
  readonly delete: (
    address: OwnerVaultStorageAddress,
  ) => Effect.Effect<void, OwnerVaultStorageTransactionFailure>;
}

export interface OwnerVaultStorageRepository {
  /** The sole read/modify/write gateway for the OwnerVault's DO state. */
  readonly transact: <A>(
    operation: (tx: OwnerVaultTx) => Effect.Effect<A, OwnerVaultStorageTransactionFailure>,
  ) => Effect.Effect<
    A,
    OwnerVaultStorageError | OwnerVaultDomainTransactionError | OwnerVaultStorageRepositoryError
  >;
  /**
   * A bounded snapshot/audit primitive. Runtime policy allows snapshot rows
   * only for backup and audit rows only for restore audit.
   */
  readonly inspectPage: (
    purpose: OwnerVaultInspectionPurpose,
    address: OwnerVaultStorageAddress,
    cursor: string | undefined,
    limit: number,
  ) => Effect.Effect<
    OwnerVaultStoragePage,
    OwnerVaultStorageRepositoryError | OwnerVaultStorageError
  >;
}

const accountingAddress: OwnerVaultStorageAddress = { category: accountingCategory };
const runtimeAddress: OwnerVaultStorageAddress = { category: runtimeCategory };
const identityAddress: OwnerVaultStorageAddress = { category: identityCategory };
const catalogCurrentAddress: OwnerVaultStorageAddress = { category: catalogCurrentCategory };

interface CatalogState {
  readonly revision: number;
  readonly entries: readonly OwnerVaultCatalogEntry[];
  readonly root: OwnerVaultCatalogRootPayload;
  readonly rootAddress: OwnerVaultStorageAddress;
  readonly pageAddresses: readonly OwnerVaultStorageAddress[];
}

type CatalogDelta =
  | { readonly _tag: "put"; readonly entry: Omit<OwnerVaultCatalogEntry, "ordinal"> }
  | { readonly _tag: "delete" };

interface CatalogSerializedRecord {
  readonly key: string;
  readonly record: OwnerVaultStorageRecord;
}

/**
 * C1's metadata must authenticate the same immutable object representation
 * C2/C4 archive.  Hashing the raw storage envelope here would make a pin
 * prove a different byte stream from the backup it is later asked to sign.
 */
const catalogEntryFor = (
  address: OwnerVaultStorageAddress,
  serialized: CatalogSerializedRecord,
): Omit<OwnerVaultCatalogEntry, "ordinal"> | undefined => {
  const snapshot = canonicalSnapshotRecordBytes(address, serialized.record);
  if (snapshot === undefined || snapshot.byteLength > ownerVaultCatalogMaximumObjectBytes)
    return undefined;
  return {
    key: serialized.key,
    category: address.category,
    bytes: snapshot.byteLength,
    digest: ownerVaultBackupDigest(snapshot),
  };
};

const catalogScopeMatches = (
  root: OwnerVaultCatalogRootPayload,
  identity: OwnerVaultTargetRoot,
): boolean =>
  root.scope.ownerID === identity.ownerID &&
  root.scope.vaultID === identity.vaultID &&
  root.scope.generationEpoch === identity.generationEpoch &&
  root.scope.namespaceState === identity.namespaceState;

const catalogRootPayload = (
  scope: OwnerVaultTargetRoot,
  catalogRevision: number,
  entries: readonly OwnerVaultCatalogEntry[],
  pages: readonly {
    readonly identifier: string;
    readonly count: number;
    readonly bytes: number;
    readonly digest: string;
  }[],
  appendProof: { readonly appendLogSequence: number; readonly appendLogDigest: string },
): OwnerVaultCatalogRootPayload | undefined => {
  const catalogDigest = ownerVaultCatalogDigest(entries);
  if (catalogDigest === undefined) return undefined;
  return {
    scope,
    catalogRevision,
    catalogDigest,
    pages: pages.map((page, ordinal) => ({ ordinal, ...page })),
    highWaterMark: catalogDigest,
    appendLogSequence: appendProof.appendLogSequence,
    appendLogDigest: appendProof.appendLogDigest,
  };
};

const snapshotPreimageIdentifier = (
  catalogRevision: number,
  ordinal: number,
): string | undefined => {
  const revision = ownerVaultCatalogRevisionIdentifier(catalogRevision);
  return revision !== undefined && nonNegativeInteger(ordinal) && ordinal <= 9_999
    ? `${revision}-${String(ordinal).padStart(4, "0")}`
    : undefined;
};

const pinCount = (value: unknown): number | undefined => {
  const source = record(value);
  return source !== undefined && exact(source, ["pinCount"]) && nonNegativeInteger(source.pinCount)
    ? source.pinCount
    : undefined;
};

/**
 * Per-record v2 OwnerVault physical storage.  This intentionally never adopts
 * the legacy aggregate VaultDO map: a generation starts with only its root
 * records, then grows through registered, independently bounded rows.
 */
export const makeDurableObjectOwnerVaultStorageRepository = (
  storage: DurableObjectStorage,
  // Retained only for source compatibility. Catalog readers never enumerate
  // DO storage; an immutable root supplies the complete bounded inventory.
  _listing?: unknown,
): OwnerVaultStorageRepository => {
  let transactionActive = false;

  const transact = <A>(
    operation: (tx: OwnerVaultTx) => Effect.Effect<A, OwnerVaultStorageTransactionFailure>,
  ): Effect.Effect<
    A,
    OwnerVaultStorageError | OwnerVaultDomainTransactionError | OwnerVaultStorageRepositoryError
  > =>
    Effect.suspend(() => {
      if (transactionActive) return storageError("nested_transaction");
      return storage
        .transactionOutcome<A, OwnerVaultStorageError | OwnerVaultDomainTransactionError>(
          transactionCodec,
          (native) => {
            transactionActive = true;

            const raw = (
              address: OwnerVaultStorageAddress,
            ): Effect.Effect<
              readonly [string, unknown | undefined],
              OwnerVaultStorageTransactionFailure
            > => {
              const key = keyFor(address);
              return key === undefined
                ? storageError<readonly [string, undefined]>("invalid_address")
                : native.get(key).pipe(Effect.map((value) => [key, value] as const));
            };

            const read = (
              address: OwnerVaultStorageAddress,
            ): Effect.Effect<
              OwnerVaultStorageRecord | undefined,
              OwnerVaultStorageTransactionFailure
            > =>
              Effect.flatMap(raw(address), ([key, value]) => {
                if (value === undefined) return Effect.succeed(undefined);
                const decoded = decodeStored(key, value);
                return decoded === undefined
                  ? storageError<OwnerVaultStorageRecord>("state_corrupt")
                  : Effect.succeed(decoded.record);
              });

            let catalog: CatalogState | undefined;
            const catalogChanges = new Map<string, CatalogDelta>();
            /** Counted only when a later import-publish transaction admits staged rows. */
            let restoreImportPublicationBytes = 0;

            const loadCatalog = (): Effect.Effect<
              CatalogState,
              OwnerVaultStorageTransactionFailure
            > => {
              if (catalog !== undefined) return Effect.succeed(catalog);
              return Effect.all([read(identityAddress), read(catalogCurrentAddress)]).pipe(
                Effect.flatMap(([identityRecord, currentRecord]) => {
                  if (identityRecord === undefined) return storageError("not_initialized");
                  if (currentRecord === undefined) return storageError("state_corrupt");
                  const identity = decodeTargetRoot(identityRecord.payload);
                  if (identity === undefined) return storageError("state_corrupt");
                  const current = isOwnerVaultCatalogCurrentPayload(currentRecord.payload)
                    ? currentRecord.payload
                    : undefined;
                  if (current === undefined) return storageError("state_corrupt");
                  const rootIdentifier = ownerVaultCatalogRevisionIdentifier(
                    current.catalogRevision,
                  );
                  if (rootIdentifier === undefined) return storageError("state_corrupt");
                  const rootAddress: OwnerVaultStorageAddress = {
                    category: catalogRootCategory,
                    identifier: rootIdentifier,
                  };
                  return read(rootAddress).pipe(
                    Effect.flatMap((rootRecord) => {
                      if (rootRecord === undefined) return storageError("state_corrupt");
                      const root = isOwnerVaultCatalogRootPayload(rootRecord.payload)
                        ? rootRecord.payload
                        : undefined;
                      if (
                        root === undefined ||
                        ownerVaultCatalogDigest(root) !== current.rootDigest ||
                        root.catalogRevision !== current.catalogRevision ||
                        !catalogScopeMatches(root, identity)
                      )
                        return storageError("state_corrupt");
                      const pageAddresses: OwnerVaultStorageAddress[] = [];
                      return Effect.forEach(root.pages, (descriptor) => {
                        const pageAddress: OwnerVaultStorageAddress = {
                          category: catalogPageCategory,
                          identifier: descriptor.identifier,
                        };
                        pageAddresses.push(pageAddress);
                        return read(pageAddress).pipe(
                          Effect.flatMap((pageRecord) => {
                            if (pageRecord === undefined)
                              return storageError<readonly OwnerVaultCatalogEntry[]>(
                                "state_corrupt",
                              );
                            const payload = isOwnerVaultCatalogPagePayload(pageRecord.payload)
                              ? pageRecord.payload
                              : undefined;
                            const bytes = ownerVaultCatalogCanonicalBytes(payload)?.byteLength;
                            if (
                              payload === undefined ||
                              payload.digest !== descriptor.digest ||
                              payload.entries.length !== descriptor.count ||
                              bytes !== descriptor.bytes ||
                              ownerVaultCatalogDigest(payload.entries) !== descriptor.digest
                            )
                              return storageError<readonly OwnerVaultCatalogEntry[]>(
                                "state_corrupt",
                              );
                            return Effect.succeed(payload.entries);
                          }),
                        );
                      }).pipe(
                        Effect.flatMap((pages) => {
                          const entries = pages.flat();
                          const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
                          const ordered = entries.every((entry, index) => {
                            const previous = entries[index - 1];
                            return (
                              entry.ordinal === index &&
                              (index === 0 || (previous !== undefined && previous.key < entry.key))
                            );
                          });
                          if (
                            entries.length > ownerVaultCatalogMaximumObjects ||
                            total > ownerVaultCatalogMaximumTotalBytes ||
                            !ordered ||
                            new Set(entries.map((entry) => entry.key)).size !== entries.length ||
                            ownerVaultCatalogDigest(entries) !== root.catalogDigest ||
                            root.highWaterMark !== root.catalogDigest
                          )
                            return storageError<CatalogState>("state_corrupt");
                          catalog = {
                            revision: root.catalogRevision,
                            entries,
                            root,
                            rootAddress,
                            pageAddresses,
                          };
                          return Effect.succeed(catalog);
                        }),
                      );
                    }),
                  );
                }),
              );
            };

            const ready = (): Effect.Effect<Accounting, OwnerVaultStorageTransactionFailure> =>
              Effect.all([
                read(identityAddress),
                read(runtimeAddress),
                read(accountingAddress),
              ]).pipe(
                Effect.flatMap(([identity, runtime, accounting]) => {
                  if (identity === undefined) return storageError("not_initialized");
                  if (decodeRuntimeJournal(runtime?.payload) === undefined)
                    return storageError("migration_required");
                  const current = decodeAccounting(accounting?.payload);
                  return current === undefined ||
                    current.usedBytes > ownerVaultMaximumAccountedBytes
                    ? storageError<Accounting>("state_corrupt")
                    : Effect.succeed(current);
                }),
              );

            const writeAccounting = (
              usedBytes: number,
            ): Effect.Effect<void, OwnerVaultStorageTransactionFailure> => {
              const serialized = serializeRecord(accountingAddress, { usedBytes });
              return serialized === undefined
                ? storageError("state_corrupt")
                : native.put(serialized.key, serialized.value);
            };

            const initialize = (
              root: OwnerVaultTargetRoot,
            ): Effect.Effect<void, OwnerVaultStorageTransactionFailure> => {
              const initialAppendDigest = ownerVaultAppendProofD0(root);
              if (initialAppendDigest === undefined) return storageError("invalid_record");
              return Effect.flatMap(raw(identityAddress), ([identityKey, existing]) => {
                const proposed = serializeRecord(identityAddress, {
                  ownerID: root.ownerID,
                  vaultID: root.vaultID,
                  generationEpoch: root.generationEpoch,
                  namespaceState: root.namespaceState,
                });
                const runtime = serializeRecord(runtimeAddress, {
                  schemaVersion,
                  migrationJournal: { state: "ready", step: 0 },
                });
                const rootIdentifier = ownerVaultCatalogRevisionIdentifier(0);
                const initialRoot =
                  rootIdentifier === undefined
                    ? undefined
                    : catalogRootPayload(root, 0, [], [], {
                        appendLogSequence: 0,
                        appendLogDigest: initialAppendDigest,
                      });
                const rootDigest =
                  initialRoot === undefined ? undefined : ownerVaultCatalogDigest(initialRoot);
                const catalogRoot =
                  rootIdentifier === undefined || initialRoot === undefined
                    ? undefined
                    : serializeRecord(
                        { category: catalogRootCategory, identifier: rootIdentifier },
                        asPayload(initialRoot),
                      );
                const catalogCurrent =
                  rootDigest === undefined
                    ? undefined
                    : serializeRecord(catalogCurrentAddress, { catalogRevision: 0, rootDigest });
                if (
                  proposed === undefined ||
                  runtime === undefined ||
                  catalogRoot === undefined ||
                  catalogCurrent === undefined
                )
                  return storageError("invalid_record");
                if (existing !== undefined) {
                  const decoded = decodeStored(identityKey, existing);
                  if (decoded === undefined) return storageError("state_corrupt");
                  const prior = decoded.record.payload;
                  return prior.ownerID === root.ownerID &&
                    prior.vaultID === root.vaultID &&
                    prior.generationEpoch === root.generationEpoch &&
                    prior.namespaceState === root.namespaceState
                    ? ready().pipe(Effect.asVoid)
                    : storageError("identity_conflict");
                }
                const usedBytes =
                  proposed.bytes + runtime.bytes + catalogRoot.bytes + catalogCurrent.bytes;
                return usedBytes > ownerVaultMaximumAccountedBytes
                  ? storageError("quota_exceeded")
                  : native
                      .put(proposed.key, proposed.value)
                      .pipe(
                        Effect.zipRight(native.put(runtime.key, runtime.value)),
                        Effect.zipRight(native.put(catalogRoot.key, catalogRoot.value)),
                        Effect.zipRight(native.put(catalogCurrent.key, catalogCurrent.value)),
                        Effect.zipRight(writeAccounting(usedBytes)),
                      );
              });
            };

            /**
             * A pinned catalog owns the old value of every row it names.  We
             * retain a preimage only on the first overwrite/delete for that
             * revision; later writes are against a newer catalog and cannot
             * affect the historical read.  The preimage is deliberately a
             * physical record, never an in-memory snapshot or storage scan.
             */
            const preservePinnedPreimage = (prior: {
              readonly key: string;
              readonly record: OwnerVaultStorageRecord;
              readonly bytes: number;
            }): Effect.Effect<number, OwnerVaultStorageTransactionFailure> =>
              loadCatalog().pipe(
                Effect.flatMap((current) => {
                  const entry = current.entries.find((candidate) => candidate.key === prior.key);
                  if (entry === undefined) return storageError<number>("state_corrupt");
                  const retentionAddress: OwnerVaultStorageAddress = {
                    category: catalogRetentionCategory,
                    identifier: ownerVaultCatalogRevisionIdentifier(current.revision),
                  };
                  if (retentionAddress.identifier === undefined)
                    return storageError<number>("state_corrupt");
                  return read(retentionAddress).pipe(
                    Effect.flatMap((retention) => {
                      const retained = retention === undefined ? 0 : pinCount(retention.payload);
                      if (retained === undefined) return storageError<number>("state_corrupt");
                      if (retained === 0) return Effect.succeed(0);
                      const identifier = snapshotPreimageIdentifier(
                        current.revision,
                        entry.ordinal,
                      );
                      if (identifier === undefined) return storageError<number>("state_corrupt");
                      const address: OwnerVaultStorageAddress = {
                        category: backupPreimageCategory,
                        identifier,
                      };
                      return raw(address).pipe(
                        Effect.flatMap(
                          ([key, existing]): Effect.Effect<
                            number,
                            OwnerVaultStorageTransactionFailure
                          > => {
                            if (existing !== undefined) {
                              const decoded = decodeStored(key, existing);
                              return decoded === undefined
                                ? storageError<number>("state_corrupt")
                                : Effect.succeed(0);
                            }
                            const copy = serializeRecord(address, {
                              key: prior.key,
                              category: prior.record.category,
                              // Catalog bytes describe the canonical snapshot
                              // object, not the physical storage envelope.
                              bytes: entry.bytes,
                              digest: entry.digest,
                              payload: prior.record.payload,
                            });
                            return copy === undefined
                              ? storageError<number>("invalid_record")
                              : native.put(copy.key, copy.value).pipe(Effect.as(copy.bytes));
                          },
                        ),
                      );
                    }),
                  );
                }),
              );

            const put = (
              address: OwnerVaultStorageAddress,
              payload: Readonly<Record<string, unknown>>,
            ): Effect.Effect<void, OwnerVaultStorageTransactionFailure> => {
              if (address.category === identityCategory) return storageError("identity_conflict");
              if (address.category === accountingCategory || address.category === runtimeCategory)
                return storageError("invalid_address");
              const next = serializeRecord(address, payload);
              if (next === undefined) return storageError("invalid_record");
              const included =
                ownerVaultStorageRegistry.get(address.category)?.snapshot === "include";
              const stage = (): Effect.Effect<void, OwnerVaultStorageTransactionFailure> => {
                if (!included) return Effect.void;
                const entry = catalogEntryFor(address, next);
                return entry === undefined
                  ? storageError("invalid_record")
                  : loadCatalog().pipe(
                      Effect.zipRight(
                        Effect.sync(() => {
                          catalogChanges.set(next.key, { _tag: "put", entry });
                        }),
                      ),
                    );
              };
              return Effect.flatMap(stage(), () =>
                Effect.flatMap(ready(), (accounting) =>
                  Effect.flatMap(raw(address), ([key, previous]) => {
                    if (key !== next.key) return storageError("invalid_address");
                    const prior = previous === undefined ? undefined : decodeStored(key, previous);
                    if (previous !== undefined && prior === undefined)
                      return storageError("state_corrupt");
                    const usedBytes = accounting.usedBytes - (prior?.bytes ?? 0) + next.bytes;
                    if (!nonNegativeInteger(usedBytes)) return storageError("state_corrupt");
                    if (usedBytes > ownerVaultMaximumAccountedBytes)
                      return storageError("quota_exceeded");
                    return (
                      included && prior !== undefined
                        ? preservePinnedPreimage({ key, record: prior.record, bytes: prior.bytes })
                        : Effect.succeed(0)
                    ).pipe(
                      Effect.flatMap((preimageBytes) => {
                        const total = usedBytes + preimageBytes;
                        if (!nonNegativeInteger(total) || total > ownerVaultMaximumAccountedBytes)
                          return storageError("quota_exceeded");
                        return native
                          .put(next.key, next.value)
                          .pipe(Effect.zipRight(writeAccounting(total)));
                      }),
                    );
                  }),
                ),
              );
            };

            const putRestoreImport = (
              address: OwnerVaultStorageAddress,
              payload: Readonly<Record<string, unknown>>,
            ): Effect.Effect<void, OwnerVaultStorageTransactionFailure> => {
              const definition = ownerVaultStorageRegistry.get(address.category);
              if (definition === undefined || !isRestorableOwnerVaultStorageCategory(definition))
                return storageError("invalid_address");
              const next = serializeRecord(address, payload);
              if (next === undefined) return storageError("invalid_record");
              return Effect.flatMap(ready(), () =>
                Effect.flatMap(raw(address), ([key, previous]) => {
                  if (key !== next.key) return storageError("invalid_address");
                  if (previous !== undefined) return storageError("identity_conflict");
                  return native
                    .put(next.key, next.value)
                    .pipe(Effect.mapError((error): OwnerVaultStorageTransactionFailure => error));
                }),
              );
            };

            const publishRestoreImport = (
              addresses: readonly OwnerVaultStorageAddress[],
            ): Effect.Effect<void, OwnerVaultStorageTransactionFailure> => {
              if (addresses.length === 0 || addresses.length > ownerVaultCatalogMaximumObjects)
                return storageError("invalid_address");
              const keys = new Set<string>();
              return Effect.forEach(addresses, (address) => {
                const definition = ownerVaultStorageRegistry.get(address.category);
                const key = keyFor(address);
                if (
                  definition === undefined ||
                  key === undefined ||
                  !isRestorableOwnerVaultStorageCategory(definition) ||
                  keys.has(key)
                )
                  return storageError<void>("invalid_address");
                keys.add(key);
                return raw(address).pipe(
                  Effect.flatMap(([actualKey, value]) => {
                    const stored = value === undefined ? undefined : decodeStored(actualKey, value);
                    if (stored === undefined) return storageError<void>("state_corrupt");
                    const entry = catalogEntryFor(address, {
                      key: actualKey,
                      record: stored.record,
                    });
                    if (entry === undefined) return storageError<void>("invalid_record");
                    const total = restoreImportPublicationBytes + stored.bytes;
                    if (!nonNegativeInteger(total)) return storageError<void>("state_corrupt");
                    restoreImportPublicationBytes = total;
                    catalogChanges.set(actualKey, { _tag: "put", entry });
                    return Effect.void;
                  }),
                );
              }).pipe(Effect.zipRight(loadCatalog()), Effect.asVoid);
            };

            const remove = (
              address: OwnerVaultStorageAddress,
            ): Effect.Effect<void, OwnerVaultStorageTransactionFailure> => {
              if (
                address.category === identityCategory ||
                address.category === accountingCategory ||
                address.category === runtimeCategory
              )
                return storageError("invalid_address");
              const included =
                ownerVaultStorageRegistry.get(address.category)?.snapshot === "include";
              return Effect.flatMap(ready(), (accounting) =>
                Effect.flatMap(raw(address), ([key, previous]) => {
                  if (previous === undefined) return Effect.void;
                  const prior = decodeStored(key, previous);
                  if (prior === undefined) return storageError("state_corrupt");
                  const usedBytes = accounting.usedBytes - prior.bytes;
                  if (!nonNegativeInteger(usedBytes)) return storageError("state_corrupt");
                  return (
                    included
                      ? preservePinnedPreimage({ key, record: prior.record, bytes: prior.bytes })
                      : Effect.succeed(0)
                  ).pipe(
                    Effect.flatMap((preimageBytes) => {
                      const total = usedBytes + preimageBytes;
                      if (!nonNegativeInteger(total) || total > ownerVaultMaximumAccountedBytes)
                        return storageError("quota_exceeded");
                      return native.delete(key).pipe(
                        Effect.zipRight(writeAccounting(total)),
                        Effect.zipRight(
                          included
                            ? loadCatalog().pipe(
                                Effect.zipRight(
                                  Effect.sync(() => {
                                    catalogChanges.set(key, { _tag: "delete" });
                                  }),
                                ),
                              )
                            : Effect.void,
                        ),
                        Effect.asVoid,
                      );
                    }),
                  );
                }),
              );
            };

            /**
             * The only catalog write.  Application rows (including log heads)
             * are staged first; this final native-transaction step creates a new
             * immutable root/pages and then swings the single current pointer.
             */
            const finalizeCatalog = (): Effect.Effect<
              void,
              OwnerVaultStorageTransactionFailure
            > => {
              if (catalogChanges.size === 0) return Effect.void;
              return loadCatalog().pipe(
                Effect.flatMap((prior) => {
                  const nextByKey = new Map(prior.entries.map((entry) => [entry.key, entry]));
                  for (const [key, change] of catalogChanges) {
                    if (change._tag === "delete") nextByKey.delete(key);
                    else nextByKey.set(key, { ordinal: 0, ...change.entry });
                  }
                  const entries = [...nextByKey.values()]
                    .sort((left, right) =>
                      left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
                    )
                    .map((entry, ordinal) => ({ ...entry, ordinal }));
                  if (!ownerVaultCatalogWithinQuota(entries)) return storageError("quota_exceeded");
                  if (prior.revision >= Number.MAX_SAFE_INTEGER)
                    return storageError("quota_exceeded");
                  const revision = prior.revision + 1;
                  const revisionIdentifier = ownerVaultCatalogRevisionIdentifier(revision);
                  const pages = ownerVaultCatalogPages(entries);
                  if (
                    revisionIdentifier === undefined ||
                    pages === undefined ||
                    pages.length > 10_000
                  )
                    return storageError("state_corrupt");
                  return Effect.all([
                    read(identityAddress),
                    read({ category: "root.log-head" }),
                  ]).pipe(
                    Effect.flatMap(([identityRecord, logHeadRecord]) => {
                      if (identityRecord === undefined) return storageError("not_initialized");
                      const identity = decodeTargetRoot(identityRecord.payload);
                      if (identity === undefined) return storageError("state_corrupt");
                      const logHeadPayload = logHeadRecord?.payload;
                      const appendLogSequence =
                        logHeadPayload === undefined
                          ? 0
                          : typeof logHeadPayload.appendLogSequence === "number" &&
                              nonNegativeInteger(logHeadPayload.appendLogSequence)
                            ? logHeadPayload.appendLogSequence
                            : undefined;
                      const derivedAppendLogDigest = ownerVaultAppendProofD0(identity);
                      const appendLogDigest =
                        logHeadPayload === undefined
                          ? derivedAppendLogDigest
                          : typeof logHeadPayload.appendLogDigest === "string"
                            ? logHeadPayload.appendLogDigest
                            : undefined;
                      if (appendLogSequence === undefined || appendLogDigest === undefined)
                        return storageError("state_corrupt");
                      const descriptors: {
                        readonly identifier: string;
                        readonly count: number;
                        readonly bytes: number;
                        readonly digest: string;
                      }[] = [];
                      for (const [ordinal, page] of pages.entries()) {
                        const identifier = ownerVaultCatalogPageIdentifier(revision, ordinal);
                        if (identifier === undefined) return storageError("state_corrupt");
                        descriptors.push({
                          identifier,
                          count: page.entries.length,
                          bytes: page.bytes,
                          digest: page.digest,
                        });
                      }
                      const root = catalogRootPayload(identity, revision, entries, descriptors, {
                        appendLogSequence,
                        appendLogDigest,
                      });
                      const rootDigest =
                        root === undefined ? undefined : ownerVaultCatalogDigest(root);
                      const nextRoot =
                        root === undefined
                          ? undefined
                          : serializeRecord(
                              { category: catalogRootCategory, identifier: revisionIdentifier },
                              asPayload(root),
                            );
                      const nextPages = pages.map((page, ordinal) => {
                        const identifier = ownerVaultCatalogPageIdentifier(revision, ordinal);
                        return identifier === undefined
                          ? undefined
                          : serializeRecord(
                              { category: catalogPageCategory, identifier },
                              { entries: page.entries, digest: page.digest },
                            );
                      });
                      const nextCurrent =
                        rootDigest === undefined
                          ? undefined
                          : serializeRecord(catalogCurrentAddress, {
                              catalogRevision: revision,
                              rootDigest,
                            });
                      if (
                        nextRoot === undefined ||
                        nextCurrent === undefined ||
                        nextPages.some((page) => page === undefined)
                      )
                        return storageError("state_corrupt");
                      return Effect.all([
                        read(accountingAddress),
                        read(catalogCurrentAddress),
                        read(prior.rootAddress),
                        Effect.forEach(prior.pageAddresses, read),
                        read({
                          category: catalogRetentionCategory,
                          identifier: ownerVaultCatalogRevisionIdentifier(prior.revision),
                        }),
                      ]).pipe(
                        Effect.flatMap(
                          ([accountingRecord, oldCurrent, oldRoot, oldPages, retentionRecord]) => {
                            const accounting = decodeAccounting(accountingRecord?.payload);
                            const retained =
                              retentionRecord === undefined ? 0 : pinCount(retentionRecord.payload);
                            if (
                              accounting === undefined ||
                              retained === undefined ||
                              oldCurrent === undefined ||
                              oldRoot === undefined ||
                              oldPages.some((page) => page === undefined)
                            )
                              return storageError("state_corrupt");
                            const priorPages = oldPages.flatMap((page) =>
                              page === undefined ? [] : [page],
                            );
                            const oldBytes = [
                              oldCurrent,
                              ...(retained === 0 ? [oldRoot, ...priorPages] : []),
                            ].reduce(
                              (total, item) =>
                                total +
                                (stableBytes(envelope(item.category, item.payload))?.bytes ??
                                  Number.NaN),
                              0,
                            );
                            const writtenPages = nextPages.flatMap((page) =>
                              page === undefined ? [] : [page],
                            );
                            const newBytes =
                              nextCurrent.bytes +
                              nextRoot.bytes +
                              writtenPages.reduce((total, page) => total + page.bytes, 0);
                            const usedBytes =
                              accounting.usedBytes +
                              restoreImportPublicationBytes -
                              oldBytes +
                              newBytes;
                            if (
                              !nonNegativeInteger(usedBytes) ||
                              usedBytes > ownerVaultMaximumAccountedBytes
                            )
                              return storageError("quota_exceeded");
                            return Effect.forEach(writtenPages, (page) =>
                              native.put(page.key, page.value),
                            ).pipe(
                              Effect.zipRight(native.put(nextRoot.key, nextRoot.value)),
                              Effect.zipRight(native.put(nextCurrent.key, nextCurrent.value)),
                              Effect.zipRight(
                                retained === 0
                                  ? Effect.forEach(prior.pageAddresses, (address) =>
                                      raw(address).pipe(
                                        Effect.flatMap(([key]) => native.delete(key)),
                                      ),
                                    )
                                  : Effect.void,
                              ),
                              Effect.zipRight(
                                retained === 0
                                  ? raw(prior.rootAddress).pipe(
                                      Effect.flatMap(([key]) => native.delete(key)),
                                    )
                                  : Effect.void,
                              ),
                              Effect.zipRight(writeAccounting(usedBytes)),
                            );
                          },
                        ),
                      );
                    }),
                  );
                }),
              );
            };

            const tx: OwnerVaultTx = {
              [ownerVaultTxBrand]: "OwnerVaultTx",
              initialize,
              get: read,
              put,
              putRestoreImport,
              publishRestoreImport,
              delete: remove,
            };
            return operation(Object.freeze(tx)).pipe(
              Effect.flatMap((value) => finalizeCatalog().pipe(Effect.as(value))),
              Effect.ensuring(
                Effect.sync(() => {
                  transactionActive = false;
                }),
              ),
            );
          },
        )
        .pipe(
          Effect.flatMap((outcome) =>
            outcome._tag === "success" ? Effect.succeed(outcome.value) : Effect.fail(outcome.error),
          ),
          Effect.mapError((error) =>
            isOwnerVaultStorageError(error) || isOwnerVaultDomainTransactionError(error)
              ? error
              : new OwnerVaultStorageRepositoryError({ reason: "unavailable" }),
          ),
        );
    });

  const inspectPage = (
    purpose: OwnerVaultInspectionPurpose,
    address: OwnerVaultStorageAddress,
    cursor: string | undefined,
    limit: number,
  ): Effect.Effect<
    OwnerVaultStoragePage,
    OwnerVaultStorageRepositoryError | OwnerVaultStorageError
  > =>
    Effect.gen(function* () {
      if (!validInspectionPurpose(purpose) || !inspectionPermits(purpose, address.category))
        return yield* storageError<OwnerVaultStoragePage>("inspection_forbidden");
      const exactKey = catalogFilterKey(address);
      if (
        exactKey === undefined ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > ownerVaultCatalogMaximumPageEntries ||
        (cursor !== undefined &&
          (cursor.length > 512 || !cursor.startsWith(ownerVaultStoragePrefix)))
      )
        return yield* storageError<OwnerVaultStoragePage>("invalid_address");
      const currentKey = keyFor(catalogCurrentAddress);
      const identityKey = keyFor(identityAddress);
      if (currentKey === undefined || identityKey === undefined)
        return yield* storageError<OwnerVaultStoragePage>("state_corrupt");
      const currentValue = yield* storage.get(currentKey);
      const current =
        currentValue === undefined ? undefined : decodeStored(currentKey, currentValue)?.record;
      const currentPayload =
        current !== undefined && isOwnerVaultCatalogCurrentPayload(current.payload)
          ? current.payload
          : undefined;
      if (currentPayload === undefined)
        return yield* storageError<OwnerVaultStoragePage>("state_corrupt");
      const rootIdentifier = ownerVaultCatalogRevisionIdentifier(currentPayload.catalogRevision);
      if (rootIdentifier === undefined)
        return yield* storageError<OwnerVaultStoragePage>("state_corrupt");
      const rootKey = keyFor({ category: catalogRootCategory, identifier: rootIdentifier });
      if (rootKey === undefined) return yield* storageError<OwnerVaultStoragePage>("state_corrupt");
      const rootValue = yield* storage.get(rootKey);
      const rootRecord =
        rootValue === undefined ? undefined : decodeStored(rootKey, rootValue)?.record;
      const root =
        rootRecord !== undefined && isOwnerVaultCatalogRootPayload(rootRecord.payload)
          ? rootRecord.payload
          : undefined;
      const identityValue = yield* storage.get(identityKey);
      const identityRecord =
        identityValue === undefined ? undefined : decodeStored(identityKey, identityValue)?.record;
      const identity =
        identityRecord === undefined ? undefined : decodeTargetRoot(identityRecord.payload);
      if (
        root === undefined ||
        identity === undefined ||
        ownerVaultCatalogDigest(root) !== currentPayload.rootDigest ||
        root.catalogRevision !== currentPayload.catalogRevision ||
        !catalogScopeMatches(root, identity)
      )
        return yield* storageError<OwnerVaultStoragePage>("state_corrupt");
      const listed: OwnerVaultCatalogEntry[] = [];
      for (const descriptor of root.pages) {
        const pageKey = keyFor({
          category: catalogPageCategory,
          identifier: descriptor.identifier,
        });
        if (pageKey === undefined)
          return yield* storageError<OwnerVaultStoragePage>("state_corrupt");
        const pageValue = yield* storage.get(pageKey);
        const pageRecord =
          pageValue === undefined ? undefined : decodeStored(pageKey, pageValue)?.record;
        const payload =
          pageRecord !== undefined && isOwnerVaultCatalogPagePayload(pageRecord.payload)
            ? pageRecord.payload
            : undefined;
        const pageBytes = ownerVaultCatalogCanonicalBytes(payload)?.byteLength;
        if (
          payload === undefined ||
          payload.digest !== descriptor.digest ||
          payload.entries.length !== descriptor.count ||
          pageBytes !== descriptor.bytes ||
          ownerVaultCatalogDigest(payload.entries) !== descriptor.digest
        )
          return yield* storageError<OwnerVaultStoragePage>("state_corrupt");
        listed.push(...payload.entries);
      }
      const ordered = listed.every((entry, index) => {
        const previous = listed[index - 1];
        return (
          entry.ordinal === index &&
          (index === 0 || (previous !== undefined && previous.key < entry.key))
        );
      });
      if (
        !ordered ||
        !ownerVaultCatalogWithinQuota(listed) ||
        ownerVaultCatalogDigest(listed) !== root.catalogDigest ||
        root.highWaterMark !== root.catalogDigest
      )
        return yield* storageError<OwnerVaultStoragePage>("state_corrupt");
      const selected = listed.filter(
        (entry) =>
          entry.category === address.category &&
          (address.identifier === undefined
            ? entry.key.startsWith(exactKey)
            : entry.key === exactKey) &&
          (cursor === undefined || entry.key > cursor),
      );
      const results: (readonly [string, OwnerVaultStorageRecord])[] = [];
      for (const entry of selected.slice(0, limit)) {
        const value = yield* storage.get(entry.key);
        const decoded = value === undefined ? undefined : decodeStored(entry.key, value);
        // Catalog metadata authenticates the immutable C2 record representation,
        // not the mutable Durable Object storage envelope. Reconstruct the exact
        // family address from its already-authenticated key before proving it.
        const identifier = address.identifier ?? entry.key.slice(entry.key.lastIndexOf("/") + 1);
        const entryAddress = { category: address.category, identifier } as const;
        const snapshot =
          decoded === undefined
            ? undefined
            : canonicalSnapshotRecordBytes(entryAddress, decoded.record);
        if (
          decoded === undefined ||
          decoded.record.category !== address.category ||
          keyFor(entryAddress) !== entry.key ||
          snapshot === undefined ||
          snapshot.byteLength !== entry.bytes ||
          ownerVaultBackupDigest(snapshot) !== entry.digest
        )
          return yield* storageError<OwnerVaultStoragePage>("state_corrupt");
        results.push([entry.key, decoded.record]);
      }
      const hasMore = selected.length > results.length;
      return { entries: results, ...(hasMore ? { nextCursor: results.at(-1)?.[0] } : {}) };
    }).pipe(
      Effect.mapError((error) =>
        isOwnerVaultStorageError(error)
          ? error
          : new OwnerVaultStorageRepositoryError({ reason: "unavailable" }),
      ),
    );

  return Object.freeze({ transact, inspectPage });
};
