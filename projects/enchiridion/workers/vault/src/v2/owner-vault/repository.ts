/** @enchiridion/effect-module */
import {
  type DurableObjectBoundaryError,
  type DurableObjectStorage,
  type DurableObjectTransactionDomainCodec,
  durableObjectTransactionDomainCodec,
} from "@enchiridion/runtime";
import { Data, Effect, Schema } from "effect";
import {
  type DurableObjectStorageKeyPage,
  type DurableObjectStorageListNative,
  listDurableObjectStoragePage,
  maximumDurableObjectListPageEntries,
} from "../runtime/durable-object-list";
import {
  type OwnerVaultStorageCategory,
  type OwnerVaultStorageRecord,
  type OwnerVaultTargetRoot,
  assertOwnerVaultStorageRecord,
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
const schemaVersion = 1;

const accountingMaximumBytes = ownerVaultStorageRegistry.get(accountingCategory)?.maximumBytes;
if (accountingMaximumBytes === undefined) throw new Error("OwnerVault accounting category missing.");
/** Fixed safety subtraction retains the entire reserve even as accounting evolves. */
export const ownerVaultAccountingEnvelopeSafetyBytes = accountingMaximumBytes;
export const ownerVaultMaximumAccountedBytes =
  ownerVaultIsolateCeilingBytes - ownerVaultAdmissionReserveBytes - ownerVaultAccountingEnvelopeSafetyBytes;

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
  purpose === OwnerVaultInspectionPurpose.BackupSnapshot || purpose === OwnerVaultInspectionPurpose.RestoreAudit;

const inspectionPermits = (purpose: OwnerVaultInspectionPurpose, category: OwnerVaultStorageCategory): boolean => {
  const definition = ownerVaultStorageRegistry.get(category);
  return definition !== undefined && (purpose === OwnerVaultInspectionPurpose.BackupSnapshot
    ? definition.snapshot === "include"
    : purpose === OwnerVaultInspectionPurpose.RestoreAudit && definition.snapshot === "audit");
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

const decodeAccounting = (value: unknown): Accounting | undefined => {
  const source = record(value);
  return source !== undefined && exact(source, ["usedBytes"]) && nonNegativeInteger(source.usedBytes)
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

const stableBytes = (value: unknown): { readonly value: unknown; readonly bytes: number } | undefined => {
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

const serializeRecord = (
  address: OwnerVaultStorageAddress,
  payload: Readonly<Record<string, unknown>>,
): { readonly key: string; readonly value: unknown; readonly bytes: number; readonly record: OwnerVaultStorageRecord } | undefined => {
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

const listPrefix = (address: OwnerVaultStorageAddress): string | undefined => {
  const definition = ownerVaultStorageRegistry.get(address.category);
  if (definition === undefined) return undefined;
  if (address.identifier !== undefined) return keyFor(address);
  const singleton = keyFor(address);
  if (singleton !== undefined) return singleton;
  try {
    if (address.category === "append-log.entry") {
      const key = definition.key("00000000000000000000");
      return key.slice(0, key.lastIndexOf("/") + 1);
    }
    const key = definition.key("x");
    return key.slice(0, key.lastIndexOf("/") + 1);
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

export class OwnerVaultStorageRepositoryError extends Data.TaggedError(
  "OwnerVaultStorageRepositoryError",
)<{ readonly reason: "listing_unavailable" | "unavailable" }> {}

const storageError = <A = never>(
  reason: OwnerVaultStorageError["reason"],
): Effect.Effect<A, OwnerVaultStorageError> =>
  Effect.fail({ _tag: "OwnerVaultStorageError", reason });

const isOwnerVaultStorageError = (value: unknown): value is OwnerVaultStorageError =>
  value !== null &&
  typeof value === "object" &&
  (value as { readonly _tag?: unknown })._tag === "OwnerVaultStorageError";

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
const transactionCodec: DurableObjectTransactionDomainCodec<OwnerVaultStorageError> =
  durableObjectTransactionDomainCodec(transactionErrorSchema);

export type OwnerVaultStorageTransactionFailure =
  | OwnerVaultStorageError
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
  readonly delete: (
    address: OwnerVaultStorageAddress,
  ) => Effect.Effect<void, OwnerVaultStorageTransactionFailure>;
}

export interface OwnerVaultStorageRepository {
  /** The sole read/modify/write gateway for the OwnerVault's DO state. */
  readonly transact: <A>(
    operation: (tx: OwnerVaultTx) => Effect.Effect<A, OwnerVaultStorageTransactionFailure>,
  ) => Effect.Effect<A, OwnerVaultStorageError | OwnerVaultStorageRepositoryError>;
  /**
   * A bounded snapshot/audit primitive. Runtime policy allows snapshot rows
   * only for backup and audit rows only for restore audit.
   */
  readonly inspectPage: (
    purpose: OwnerVaultInspectionPurpose,
    address: OwnerVaultStorageAddress,
    cursor: string | undefined,
    limit: number,
  ) => Effect.Effect<OwnerVaultStoragePage, OwnerVaultStorageRepositoryError | OwnerVaultStorageError>;
}

const accountingAddress: OwnerVaultStorageAddress = { category: accountingCategory };
const runtimeAddress: OwnerVaultStorageAddress = { category: runtimeCategory };
const identityAddress: OwnerVaultStorageAddress = { category: identityCategory };

/**
 * Per-record v2 OwnerVault physical storage.  This intentionally never adopts
 * the legacy aggregate VaultDO map: a generation starts with only its root
 * records, then grows through registered, independently bounded rows.
 */
export const makeDurableObjectOwnerVaultStorageRepository = (
  storage: DurableObjectStorage,
  listing?: DurableObjectStorageListNative,
): OwnerVaultStorageRepository => {
  let transactionActive = false;

  const transact = <A>(
    operation: (tx: OwnerVaultTx) => Effect.Effect<A, OwnerVaultStorageTransactionFailure>,
  ): Effect.Effect<A, OwnerVaultStorageError | OwnerVaultStorageRepositoryError> =>
    Effect.suspend(() => {
      if (transactionActive) return storageError("nested_transaction");
      return storage
        .transactionOutcome<A, OwnerVaultStorageError>(transactionCodec, (native) => {
          transactionActive = true;

          const raw = (
            address: OwnerVaultStorageAddress,
          ): Effect.Effect<readonly [string, unknown | undefined], OwnerVaultStorageTransactionFailure> => {
            const key = keyFor(address);
            return key === undefined
              ? storageError<readonly [string, undefined]>("invalid_address")
              : native.get(key).pipe(Effect.map((value) => [key, value] as const));
          };

          const read = (
            address: OwnerVaultStorageAddress,
          ): Effect.Effect<OwnerVaultStorageRecord | undefined, OwnerVaultStorageTransactionFailure> =>
            Effect.flatMap(raw(address), ([key, value]) => {
              if (value === undefined) return Effect.succeed(undefined);
              const decoded = decodeStored(key, value);
              return decoded === undefined
                ? storageError<OwnerVaultStorageRecord>("state_corrupt")
                : Effect.succeed(decoded.record);
            });

          const ready = (): Effect.Effect<Accounting, OwnerVaultStorageTransactionFailure> =>
            Effect.all([read(identityAddress), read(runtimeAddress), read(accountingAddress)]).pipe(
              Effect.flatMap(([identity, runtime, accounting]) => {
                if (identity === undefined) return storageError("not_initialized");
                if (decodeRuntimeJournal(runtime?.payload) === undefined)
                  return storageError("migration_required");
                const current = decodeAccounting(accounting?.payload);
                return current === undefined || current.usedBytes > ownerVaultMaximumAccountedBytes
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
          ): Effect.Effect<void, OwnerVaultStorageTransactionFailure> =>
            Effect.flatMap(raw(identityAddress), ([identityKey, existing]) => {
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
              if (proposed === undefined || runtime === undefined) return storageError("invalid_record");
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
              const usedBytes = proposed.bytes + runtime.bytes;
              return usedBytes > ownerVaultMaximumAccountedBytes
                ? storageError("quota_exceeded")
                : native.put(proposed.key, proposed.value).pipe(
                    Effect.zipRight(native.put(runtime.key, runtime.value)),
                    Effect.zipRight(writeAccounting(usedBytes)),
                  );
            });

          const put = (
            address: OwnerVaultStorageAddress,
            payload: Readonly<Record<string, unknown>>,
          ): Effect.Effect<void, OwnerVaultStorageTransactionFailure> => {
            if (address.category === identityCategory) return storageError("identity_conflict");
            if (address.category === accountingCategory || address.category === runtimeCategory)
              return storageError("invalid_address");
            const next = serializeRecord(address, payload);
            if (next === undefined) return storageError("invalid_record");
            return Effect.flatMap(ready(), (accounting) =>
              Effect.flatMap(raw(address), ([key, previous]) => {
                if (key !== next.key) return storageError("invalid_address");
                const prior = previous === undefined ? undefined : decodeStored(key, previous);
                if (previous !== undefined && prior === undefined) return storageError("state_corrupt");
                const usedBytes = accounting.usedBytes - (prior?.bytes ?? 0) + next.bytes;
                if (!nonNegativeInteger(usedBytes)) return storageError("state_corrupt");
                if (usedBytes > ownerVaultMaximumAccountedBytes)
                  return storageError("quota_exceeded");
                return native.put(next.key, next.value).pipe(
                  Effect.zipRight(writeAccounting(usedBytes)),
                );
              }),
            );
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
            return Effect.flatMap(ready(), (accounting) =>
              Effect.flatMap(raw(address), ([key, previous]) => {
                if (previous === undefined) return Effect.void;
                const prior = decodeStored(key, previous);
                if (prior === undefined) return storageError("state_corrupt");
                const usedBytes = accounting.usedBytes - prior.bytes;
                if (!nonNegativeInteger(usedBytes)) return storageError("state_corrupt");
                return native.delete(key).pipe(
                  Effect.zipRight(writeAccounting(usedBytes)),
                  Effect.asVoid,
                );
              }),
            );
          };

          const tx: OwnerVaultTx = {
            [ownerVaultTxBrand]: "OwnerVaultTx",
            initialize,
            get: read,
            put,
            delete: remove,
          };
          return operation(Object.freeze(tx)).pipe(
            Effect.ensuring(Effect.sync(() => {
              transactionActive = false;
            })),
          );
        })
        .pipe(
          Effect.flatMap((outcome) =>
            outcome._tag === "success" ? Effect.succeed(outcome.value) : Effect.fail(outcome.error),
          ),
          Effect.mapError((error) =>
            isOwnerVaultStorageError(error)
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
  ): Effect.Effect<OwnerVaultStoragePage, OwnerVaultStorageRepositoryError | OwnerVaultStorageError> =>
    Effect.tryPromise({
      try: async () => {
        if (!validInspectionPurpose(purpose) || !inspectionPermits(purpose, address.category))
          throw { _tag: "OwnerVaultStorageError", reason: "inspection_forbidden" } satisfies OwnerVaultStorageError;
        if (listing === undefined) throw new OwnerVaultStorageRepositoryError({ reason: "listing_unavailable" });
        const prefix = listPrefix(address);
        if (
          prefix === undefined ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > maximumDurableObjectListPageEntries ||
          (cursor !== undefined && (!cursor.startsWith(prefix) || cursor.length > 512))
        )
          throw { _tag: "OwnerVaultStorageError", reason: "invalid_address" } satisfies OwnerVaultStorageError;
        const page: DurableObjectStorageKeyPage = await listDurableObjectStoragePage(listing, {
          prefix,
          ...(cursor === undefined ? {} : { startAfter: cursor }),
          limit,
        });
        const entries: (readonly [string, OwnerVaultStorageRecord])[] = [];
        for (const [key, value] of page.entries) {
          const decoded = decodeStored(key, value);
          if (decoded === undefined || decoded.record.category !== address.category)
            throw { _tag: "OwnerVaultStorageError", reason: "state_corrupt" } satisfies OwnerVaultStorageError;
          entries.push([key, decoded.record]);
        }
        return { entries, ...(page.nextStartAfter === undefined ? {} : { nextCursor: page.nextStartAfter }) };
      },
      catch: (cause) =>
        isOwnerVaultStorageError(cause) || cause instanceof OwnerVaultStorageRepositoryError
          ? cause
          : new OwnerVaultStorageRepositoryError({ reason: "listing_unavailable" }),
    });

  return Object.freeze({ transact, inspectPage });
};
