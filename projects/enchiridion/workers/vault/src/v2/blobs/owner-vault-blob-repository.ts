/** @enchiridion/effect-module */
/**
 * The production blob store is deliberately a two-phase saga.  Durable Object
 * state owns admission, authority, receipts and lifecycle fences; R2 is only
 * ever touched between transactions.  In particular, do not move an R2 call
 * into `storage.transact`: it would turn an external await into a DO
 * transaction and make retries non-deterministic.
 */
import type { BlobR2Boundary } from "@enchiridion/runtime";
import { Effect } from "effect";
import type {
  OwnerVaultDomainTransactionError,
  OwnerVaultStorageAddress,
  OwnerVaultStorageRepository,
  OwnerVaultStorageRepositoryError,
  OwnerVaultStorageTransactionFailure,
  OwnerVaultTx,
} from "../owner-vault/repository";
import type { OwnerVaultStorageRecord } from "../owner-vault/storage-registry";
import type {
  BlobAuthorization,
  BlobLimits,
  BlobMetadata,
  BlobOperationError,
  BlobReceipt,
  BlobScope,
  BlobStageCommand,
  BlobStageExecution,
  BlobStagingRepository,
} from "./blobs";
import { BlobOperationError as BlobError, blobObjectKey } from "./blobs";

const maximumTrackedLeases = 32;
const hash = /^[a-f0-9]{64}$/u;
const safeID = /^[A-Za-z0-9_-]{1,128}$/u;
const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const object = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
const payload = (value: object): Readonly<Record<string, unknown>> =>
  Object.fromEntries(Object.entries(value));
const exact = (source: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(source).length === keys.length && keys.every((key) => Object.hasOwn(source, key));
const failed = <A>(reason: BlobOperationError["reason"]): Effect.Effect<A, BlobOperationError> =>
  Effect.fail(new BlobError({ reason }));
const storageFailed = <A>(): Effect.Effect<A, BlobOperationError> => failed("stage_conflict");
type BlobTransactionFailure = BlobOperationError | OwnerVaultStorageTransactionFailure;
const domainFailure = (error: BlobOperationError): OwnerVaultDomainTransactionError => ({
  _tag: "OwnerVaultDomainTransactionError",
  reason:
    error.reason === "generation_stale"
      ? "blob_generation_stale"
      : error.reason === "quota_exceeded"
        ? "blob_quota_exceeded"
        : error.reason === "replay_conflict"
          ? "blob_replay_conflict"
          : "blob_stage_conflict",
});
const blobFailureFromTransaction = (
  error: OwnerVaultStorageTransactionFailure | OwnerVaultStorageRepositoryError,
): BlobOperationError =>
  new BlobError({
    reason:
      error._tag === "OwnerVaultDomainTransactionError"
        ? error.reason === "blob_generation_stale"
          ? "generation_stale"
          : error.reason === "blob_quota_exceeded"
            ? "quota_exceeded"
            : error.reason === "blob_replay_conflict"
              ? "replay_conflict"
              : "stage_conflict"
        : "stage_conflict",
  });
const storageAddress = (
  category: OwnerVaultStorageAddress["category"],
  identifier?: string,
): OwnerVaultStorageAddress => (identifier === undefined ? { category } : { category, identifier });

/** The only identifier used for a lease is the signed operation ID. */
const leaseAddress = (operationID: string) => storageAddress("blob.lease", operationID);
const refAddress = (sha256: string) => storageAddress("blob.reference", sha256);
const metadataAddress = (sha256: string) => storageAddress("blob.metadata", sha256);
const tombstoneAddress = (sha256: string) => storageAddress("blob.tombstone", sha256);
const purgeAddress = (sha256: string) => storageAddress("blob.purge", sha256);
const receiptAddress = (requestID: string) => storageAddress("operation-receipt", requestID);
const identityAddress = storageAddress("root.identity");
const floorsAddress = storageAddress("root.floors");
const blobAccountingAddress = storageAddress("blob.accounting");

interface Floors {
  readonly securityFloor: number;
}
export interface OwnerVaultBlobAccounting {
  readonly referencedBytes: number;
  readonly reservedStageBytes: number;
  readonly prospectiveFinalBytes: number;
  readonly leaseIDs: readonly string[];
  readonly purgeSHA256s: readonly string[];
}
interface Lease {
  readonly phase: "RESERVED" | "PUBLISHED" | "CLEANUP";
  readonly requestID: string;
  readonly operationID: string;
  readonly stageKey: string;
  readonly finalKey: string;
  readonly sha256: string;
  readonly size: number;
  readonly deviceID: string;
  readonly authEpoch: number;
  readonly credentialEpoch: number;
  readonly securityFloor: number;
  readonly expiresAtSeconds: number;
}
export interface OwnerVaultBlobReference {
  readonly objectKey: string;
  readonly size: number;
  readonly referenceCount: number;
  readonly activeLeaseCount: number;
}
export interface OwnerVaultBlobTombstone {
  readonly objectKey: string;
  readonly deletedAtSeconds: number;
  readonly purgeAfterSeconds: number;
}
/** Canonical persisted final-object metadata, shared with C1 restore reconstruction. */
export interface OwnerVaultBlobStoredMetadata {
  readonly requestID: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly objectKey: string;
}
export interface OwnerVaultBlobPurge {
  readonly objectKey: string;
  readonly leaseID: string;
  readonly startedAtSeconds: number;
}
/** Persisted stage metadata deliberately omits the generation epoch; reads re-hydrate it. */
interface StoredStageMetadata {
  readonly requestID: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly objectKey: string;
}
interface StoredStageResponse {
  readonly metadata: StoredStageMetadata;
  readonly status: "APPLIED";
}
interface StoredDeleteResponse {
  readonly sha256: string;
  readonly status: "APPLIED";
}
type StoredReceipt =
  | {
      readonly kind: "blob-stage";
      readonly fingerprint: string;
      readonly response: StoredStageResponse;
    }
  | {
      readonly kind: "blob-delete";
      readonly fingerprint: string;
      readonly response: StoredDeleteResponse;
    };

const decodeFloors = (record: OwnerVaultStorageRecord | undefined): Floors | undefined => {
  const source = record === undefined ? undefined : object(record.payload);
  return source !== undefined && exact(source, ["securityFloor"]) && integer(source.securityFloor)
    ? { securityFloor: source.securityFloor }
    : undefined;
};
type BlobAccounting = OwnerVaultBlobAccounting;
type Reference = OwnerVaultBlobReference;
type Tombstone = OwnerVaultBlobTombstone;
type Purge = OwnerVaultBlobPurge;

/** Shared canonical P03 shape check used by durable decoding and restore reconstruction. */
export const isOwnerVaultBlobAccounting = (value: OwnerVaultBlobAccounting): boolean =>
  integer(value.referencedBytes) &&
  integer(value.reservedStageBytes) &&
  integer(value.prospectiveFinalBytes) &&
  value.leaseIDs.length <= maximumTrackedLeases &&
  value.leaseIDs.every((entry) => safeID.test(entry)) &&
  new Set(value.leaseIDs).size === value.leaseIDs.length &&
  value.purgeSHA256s.length <= maximumTrackedLeases &&
  value.purgeSHA256s.every((entry) => hash.test(entry)) &&
  new Set(value.purgeSHA256s).size === value.purgeSHA256s.length;

/** Shared canonical P03 shape check used by durable decoding and restore reconstruction. */
export const isOwnerVaultBlobReference = (value: OwnerVaultBlobReference): boolean =>
  typeof value.objectKey === "string" &&
  value.objectKey.length > 0 &&
  value.objectKey.length <= 1024 &&
  integer(value.size) &&
  integer(value.referenceCount) &&
  integer(value.activeLeaseCount);

/** Shared canonical P03 shape check used by durable decoding and restore reconstruction. */
export const isOwnerVaultBlobTombstone = (value: OwnerVaultBlobTombstone): boolean =>
  typeof value.objectKey === "string" &&
  value.objectKey.length > 0 &&
  integer(value.deletedAtSeconds) &&
  integer(value.purgeAfterSeconds) &&
  value.purgeAfterSeconds >= value.deletedAtSeconds;

const decodeBlobAccounting = (
  record: OwnerVaultStorageRecord | undefined,
): BlobAccounting | undefined => {
  const source = record === undefined ? undefined : object(record.payload);
  if (
    source === undefined ||
    !exact(source, [
      "leaseIDs",
      "prospectiveFinalBytes",
      "purgeSHA256s",
      "referencedBytes",
      "reservedStageBytes",
    ])
  )
    return undefined;
  const leaseIDs = source.leaseIDs;
  const purgeSHA256s = source.purgeSHA256s;
  if (
    !Array.isArray(leaseIDs) ||
    !leaseIDs.every((value): value is string => typeof value === "string") ||
    !Array.isArray(purgeSHA256s) ||
    !purgeSHA256s.every((value): value is string => typeof value === "string")
  )
    return undefined;
  if (
    !integer(source.referencedBytes) ||
    !integer(source.reservedStageBytes) ||
    !integer(source.prospectiveFinalBytes)
  )
    return undefined;
  const candidate: BlobAccounting = {
    referencedBytes: source.referencedBytes,
    reservedStageBytes: source.reservedStageBytes,
    prospectiveFinalBytes: source.prospectiveFinalBytes,
    leaseIDs,
    purgeSHA256s,
  };
  return isOwnerVaultBlobAccounting(candidate) ? candidate : undefined;
};
const decodeLease = (record: OwnerVaultStorageRecord | undefined): Lease | undefined => {
  const source = record === undefined ? undefined : object(record.payload);
  const keys = [
    "authEpoch",
    "credentialEpoch",
    "deviceID",
    "expiresAtSeconds",
    "finalKey",
    "operationID",
    "phase",
    "requestID",
    "securityFloor",
    "sha256",
    "size",
    "stageKey",
  ] as const;
  const boundedKey = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 1024;
  if (
    source === undefined ||
    !exact(source, keys) ||
    (source.phase !== "RESERVED" && source.phase !== "PUBLISHED" && source.phase !== "CLEANUP") ||
    !boundedKey(source.requestID) ||
    !boundedKey(source.operationID) ||
    !boundedKey(source.deviceID) ||
    !boundedKey(source.stageKey) ||
    !boundedKey(source.finalKey) ||
    typeof source.sha256 !== "string" ||
    !hash.test(source.sha256) ||
    !integer(source.size) ||
    !integer(source.authEpoch, 1) ||
    !integer(source.credentialEpoch, 1) ||
    !integer(source.securityFloor) ||
    !integer(source.expiresAtSeconds)
  )
    return undefined;
  return {
    phase: source.phase,
    requestID: source.requestID,
    operationID: source.operationID,
    deviceID: source.deviceID,
    stageKey: source.stageKey,
    finalKey: source.finalKey,
    sha256: source.sha256,
    size: source.size,
    authEpoch: source.authEpoch,
    credentialEpoch: source.credentialEpoch,
    securityFloor: source.securityFloor,
    expiresAtSeconds: source.expiresAtSeconds,
  };
};
const decodeReference = (record: OwnerVaultStorageRecord | undefined): Reference | undefined => {
  const source = record === undefined ? undefined : object(record.payload);
  if (
    source === undefined ||
    !exact(source, ["activeLeaseCount", "objectKey", "referenceCount", "size"]) ||
    typeof source.objectKey !== "string" ||
    typeof source.size !== "number" ||
    typeof source.referenceCount !== "number" ||
    typeof source.activeLeaseCount !== "number"
  )
    return undefined;
  const candidate: Reference = {
    objectKey: source.objectKey,
    size: source.size,
    referenceCount: source.referenceCount,
    activeLeaseCount: source.activeLeaseCount,
  };
  return isOwnerVaultBlobReference(candidate) ? candidate : undefined;
};
const decodeTombstone = (record: OwnerVaultStorageRecord | undefined): Tombstone | undefined => {
  const source = record === undefined ? undefined : object(record.payload);
  if (
    source === undefined ||
    !exact(source, ["deletedAtSeconds", "objectKey", "purgeAfterSeconds"]) ||
    typeof source.objectKey !== "string" ||
    typeof source.deletedAtSeconds !== "number" ||
    typeof source.purgeAfterSeconds !== "number"
  )
    return undefined;
  const candidate: Tombstone = {
    objectKey: source.objectKey,
    deletedAtSeconds: source.deletedAtSeconds,
    purgeAfterSeconds: source.purgeAfterSeconds,
  };
  return isOwnerVaultBlobTombstone(candidate) ? candidate : undefined;
};

/** P03's one persisted-metadata decoder; restore import must not reinterpret payloads. */
export const decodeOwnerVaultBlobStoredMetadata = (
  record: OwnerVaultStorageRecord | undefined,
): OwnerVaultBlobStoredMetadata | undefined => {
  const source = record === undefined ? undefined : object(record.payload);
  return source !== undefined &&
    exact(source, ["objectKey", "path", "requestID", "sha256", "size"]) &&
    typeof source.requestID === "string" &&
    safeID.test(source.requestID) &&
    typeof source.path === "string" &&
    typeof source.sha256 === "string" &&
    hash.test(source.sha256) &&
    typeof source.size === "number" &&
    integer(source.size) &&
    typeof source.objectKey === "string" &&
    source.objectKey.length > 0 &&
    source.objectKey.length <= 1024
    ? {
        requestID: source.requestID,
        path: source.path,
        sha256: source.sha256,
        size: source.size,
        objectKey: source.objectKey,
      }
    : undefined;
};
/** P03's canonical persisted reference decoder. */
export const decodeOwnerVaultBlobReference = decodeReference;
/** P03's canonical persisted tombstone decoder. */
export const decodeOwnerVaultBlobTombstone = decodeTombstone;
const decodePurge = (record: OwnerVaultStorageRecord | undefined): Purge | undefined => {
  const source = record === undefined ? undefined : object(record.payload);
  return source !== undefined &&
    exact(source, ["leaseID", "objectKey", "startedAtSeconds"]) &&
    typeof source.objectKey === "string" &&
    typeof source.leaseID === "string" &&
    safeID.test(source.leaseID) &&
    integer(source.startedAtSeconds)
    ? {
        objectKey: source.objectKey,
        leaseID: source.leaseID,
        startedAtSeconds: source.startedAtSeconds,
      }
    : undefined;
};
/** Exact decoder for the persisted stage response; unknown or mistyped members fail closed. */
const decodeStageResponse = (value: unknown): StoredStageResponse | undefined => {
  const source = object(value);
  const metadata = source === undefined ? undefined : object(source.metadata);
  if (
    source === undefined ||
    metadata === undefined ||
    !exact(source, ["metadata", "status"]) ||
    source.status !== "APPLIED" ||
    !exact(metadata, ["objectKey", "path", "requestID", "sha256", "size"]) ||
    typeof metadata.requestID !== "string" ||
    !safeID.test(metadata.requestID) ||
    typeof metadata.path !== "string" ||
    typeof metadata.sha256 !== "string" ||
    !hash.test(metadata.sha256) ||
    !integer(metadata.size) ||
    typeof metadata.objectKey !== "string" ||
    metadata.objectKey.length === 0 ||
    metadata.objectKey.length > 1024
  )
    return undefined;
  return {
    metadata: {
      requestID: metadata.requestID,
      path: metadata.path,
      sha256: metadata.sha256,
      size: metadata.size,
      objectKey: metadata.objectKey,
    },
    status: "APPLIED",
  };
};
const decodeDeleteResponse = (value: unknown): StoredDeleteResponse | undefined => {
  const source = object(value);
  return source !== undefined &&
    exact(source, ["sha256", "status"]) &&
    source.status === "APPLIED" &&
    typeof source.sha256 === "string" &&
    hash.test(source.sha256)
    ? { sha256: source.sha256, status: "APPLIED" }
    : undefined;
};
const decodeReceipt = (record: OwnerVaultStorageRecord | undefined): StoredReceipt | undefined => {
  const source = record === undefined ? undefined : object(record.payload);
  if (
    source === undefined ||
    !exact(source, ["fingerprint", "kind", "response"]) ||
    typeof source.fingerprint !== "string"
  )
    return undefined;
  if (source.kind === "blob-stage") {
    const response = decodeStageResponse(source.response);
    return response === undefined
      ? undefined
      : { kind: "blob-stage", fingerprint: source.fingerprint, response };
  }
  if (source.kind === "blob-delete") {
    const response = decodeDeleteResponse(source.response);
    return response === undefined
      ? undefined
      : { kind: "blob-delete", fingerprint: source.fingerprint, response };
  }
  return undefined;
};

const stageFingerprint = (command: BlobStageCommand): string =>
  [
    command.operationID.value,
    command.requestID.value,
    command.stageRandom,
    command.path,
    command.sha256,
    String(command.size),
    command.deviceID,
    String(command.authEpoch),
    String(command.credentialEpoch),
  ].join("\u0000");
const deleteFingerprint = (
  authorization: BlobAuthorization,
  sha256: string,
  requestID: string,
): string =>
  [
    authorization.deviceID,
    String(authorization.authEpoch),
    String(authorization.credentialEpoch),
    sha256,
    requestID,
  ].join("\u0000");
const sameScope = (left: BlobScope, right: BlobScope): boolean =>
  left.ownerID.value === right.ownerID.value &&
  left.vaultID.value === right.vaultID.value &&
  left.generationEpoch === right.generationEpoch;
const stageAuthorization = (command: BlobStageCommand): BlobAuthorization => ({
  ownerID: command.scope.ownerID,
  vaultID: command.scope.vaultID,
  generationEpoch: command.scope.generationEpoch,
  deviceID: command.deviceID,
  authEpoch: command.authEpoch,
  credentialEpoch: command.credentialEpoch,
});
const hexToBase64 = (value: string): string | undefined => {
  if (!hash.test(value)) return undefined;
  const bytes = Uint8Array.from(value.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16));
  return bytes.byteLength === 32 ? btoa(String.fromCharCode(...bytes)) : undefined;
};

export interface OwnerVaultBlobRepositoryConfig {
  readonly storage: OwnerVaultStorageRepository;
  readonly r2: BlobR2Boundary;
  readonly scope: BlobScope;
  readonly limits: BlobLimits;
  /** A tombstoned content hash cannot be staged again until R2 deletion is durably finalized. */
  readonly deleteGraceSeconds: number;
}

export interface BlobDeleteCommand {
  readonly authorization: BlobAuthorization;
  readonly requestID: string;
  readonly sha256: string;
  readonly nowSeconds: number;
}
export interface OwnerVaultBlobLifecycleRepository extends BlobStagingRepository {
  readonly deleteBySHA256: (
    command: BlobDeleteCommand,
  ) => Effect.Effect<{ readonly sha256: string; readonly status: "APPLIED" }, BlobOperationError>;
  /** Alarm-safe, bounded recovery for expired upload leases and due deletion purges. */
  readonly reconcile: (nowSeconds: number) => Effect.Effect<number, BlobOperationError>;
}

/**
 * OwnerVault-backed implementation. Its root records must be initialized by
 * the OwnerVault initialization package before it accepts traffic:
 *
 * - root.identity: immutable owner, vault, and generation authority
 * - root.floors: { securityFloor }
 * - blob.accounting: bounded blob lifecycle counters and pending work indexes
 * - device/<id>: a DeviceRecord-shaped authority row.
 */
export const makeOwnerVaultBlobStagingRepository = (
  config: OwnerVaultBlobRepositoryConfig,
): OwnerVaultBlobLifecycleRepository => {
  const validConfig =
    Number.isSafeInteger(config.deleteGraceSeconds) &&
    config.deleteGraceSeconds >= 1 &&
    config.limits.maximumActiveLeasesPerVault >= 1 &&
    config.limits.maximumActiveLeasesPerVault <= maximumTrackedLeases;
  const transact = <A>(
    operation: (tx: OwnerVaultTx) => Effect.Effect<A, BlobTransactionFailure>,
  ): Effect.Effect<A, BlobOperationError> =>
    validConfig
      ? config.storage
          .transact((tx) =>
            operation(tx).pipe(
              Effect.mapError((error) =>
                error instanceof BlobError ? domainFailure(error) : error,
              ),
            ),
          )
          .pipe(Effect.mapError(blobFailureFromTransaction))
      : failed("invalid_blob");
  const currentAuthority = (
    tx: OwnerVaultTx,
    authorization: BlobAuthorization,
  ): Effect.Effect<Floors, BlobTransactionFailure> =>
    Effect.all([
      tx.get(identityAddress),
      tx.get(floorsAddress),
      tx.get(storageAddress("device", authorization.deviceID)),
    ]).pipe(
      Effect.flatMap(([identityRecord, floorRecord, deviceRecord]) => {
        const identity = identityRecord === undefined ? undefined : object(identityRecord.payload);
        const floors = decodeFloors(floorRecord);
        const device = deviceRecord === undefined ? undefined : object(deviceRecord.payload);
        return identity === undefined ||
          !exact(identity, ["generationEpoch", "namespaceState", "ownerID", "vaultID"]) ||
          identity.ownerID !== config.scope.ownerID.value ||
          identity.vaultID !== config.scope.vaultID.value ||
          identity.generationEpoch !== config.scope.generationEpoch ||
          (identity.namespaceState !== "PRIVATE" && identity.namespaceState !== "ACTIVE") ||
          floors === undefined ||
          device === undefined ||
          authorization.generationEpoch !== config.scope.generationEpoch ||
          !sameScope(authorization, config.scope) ||
          device.revoked !== false ||
          device.deviceID !== authorization.deviceID ||
          device.authEpoch !== authorization.authEpoch ||
          device.credentialEpoch !== authorization.credentialEpoch ||
          !integer(device.securityFloor) ||
          device.securityFloor !== floors.securityFloor
          ? failed("generation_stale")
          : Effect.succeed(floors);
      }),
    );
  const getBlobAccounting = (
    tx: OwnerVaultTx,
  ): Effect.Effect<BlobAccounting, BlobTransactionFailure> =>
    tx.get(blobAccountingAddress).pipe(
      Effect.flatMap((row) => {
        const value = decodeBlobAccounting(row);
        return value === undefined ? storageFailed() : Effect.succeed(value);
      }),
    );
  const writeBlobAccounting = (
    tx: OwnerVaultTx,
    value: BlobAccounting,
  ): Effect.Effect<void, BlobTransactionFailure> =>
    tx
      .put(blobAccountingAddress, {
        referencedBytes: value.referencedBytes,
        reservedStageBytes: value.reservedStageBytes,
        prospectiveFinalBytes: value.prospectiveFinalBytes,
        leaseIDs: [...value.leaseIDs],
        purgeSHA256s: [...value.purgeSHA256s],
      })
      .pipe(Effect.mapError(() => new BlobError({ reason: "stage_conflict" })));
  const readLease = (
    tx: OwnerVaultTx,
    operationID: string,
  ): Effect.Effect<Lease | undefined, BlobTransactionFailure> =>
    tx
      .get(leaseAddress(operationID))
      .pipe(
        Effect.flatMap((row) =>
          row === undefined
            ? Effect.succeed(undefined)
            : decodeLease(row) === undefined
              ? storageFailed()
              : Effect.succeed(decodeLease(row)),
        ),
      );
  const hydrateResponse = (response: StoredStageResponse): BlobStageExecution => ({
    metadata: { ...response.metadata, generationEpoch: config.scope.generationEpoch },
    status: response.status,
  });
  const releaseLease = (
    tx: OwnerVaultTx,
    lease: Lease,
    accounting: BlobAccounting,
  ): Effect.Effect<void, BlobTransactionFailure> => {
    const nextIDs = accounting.leaseIDs.filter((value) => value !== lease.operationID);
    return tx.get(refAddress(lease.sha256)).pipe(
      Effect.flatMap((row) => {
        const reference = decodeReference(row);
        if (reference === undefined || reference.activeLeaseCount < 1) return storageFailed();
        const prospectiveDelta =
          reference.referenceCount === 0 && reference.activeLeaseCount === 1 ? reference.size : 0;
        return tx
          .put(refAddress(lease.sha256), {
            objectKey: reference.objectKey,
            size: reference.size,
            referenceCount: reference.referenceCount,
            activeLeaseCount: reference.activeLeaseCount - 1,
          })
          .pipe(
            Effect.zipRight(tx.delete(leaseAddress(lease.operationID))),
            Effect.zipRight(
              writeBlobAccounting(tx, {
                referencedBytes: accounting.referencedBytes,
                reservedStageBytes: accounting.reservedStageBytes - lease.size,
                prospectiveFinalBytes: accounting.prospectiveFinalBytes - prospectiveDelta,
                leaseIDs: nextIDs,
                purgeSHA256s: accounting.purgeSHA256s,
              }),
            ),
            Effect.mapError(() => new BlobError({ reason: "stage_conflict" })),
          );
      }),
    );
  };
  const preflightReceipt: BlobStagingRepository["preflightReceipt"] = (command, fingerprint) =>
    transact((tx) =>
      currentAuthority(tx, stageAuthorization(command)).pipe(
        Effect.zipRight(tx.get(receiptAddress(command.requestID.value))),
        Effect.flatMap((row) => {
          if (row === undefined) return Effect.succeed(undefined);
          const receipt = decodeReceipt(row);
          if (receipt === undefined || receipt.kind !== "blob-stage") return storageFailed();
          return receipt.fingerprint === fingerprint
            ? Effect.succeed(hydrateResponse(receipt.response))
            : failed("replay_conflict");
        }),
      ),
    );
  const reserveStage: BlobStagingRepository["reserveStage"] = (
    command,
    stageKey,
    finalKey,
    nowSeconds,
  ) =>
    transact((tx) =>
      Effect.gen(function* () {
        const floors = yield* currentAuthority(tx, stageAuthorization(command));
        const accounting = yield* getBlobAccounting(tx);
        const tombstone = yield* tx.get(tombstoneAddress(command.sha256));
        if (
          tombstone !== undefined ||
          !integer(nowSeconds) ||
          accounting.leaseIDs.length >= config.limits.maximumActiveLeasesPerVault
        )
          return yield* failed("stage_conflict");
        const existing = yield* readLease(tx, command.operationID.value);
        if (existing !== undefined) {
          return yield* existing.requestID === command.requestID.value &&
          existing.stageKey === stageKey &&
          existing.finalKey === finalKey &&
          existing.sha256 === command.sha256 &&
          existing.size === command.size &&
          existing.expiresAtSeconds > nowSeconds
            ? Effect.void
            : failed("stage_conflict");
        }
        const referenceRow = yield* tx.get(refAddress(command.sha256));
        const reference = referenceRow === undefined ? undefined : decodeReference(referenceRow);
        if (referenceRow !== undefined && reference === undefined) return yield* storageFailed();
        const nextReference: Reference = reference ?? {
          objectKey: finalKey,
          size: command.size,
          referenceCount: 0,
          activeLeaseCount: 0,
        };
        if (
          nextReference.objectKey !== finalKey ||
          nextReference.size !== command.size ||
          nextReference.activeLeaseCount >= config.limits.maximumActiveLeasesPerFinal
        )
          return yield* failed("stage_conflict");
        const prospective =
          nextReference.referenceCount === 0 && nextReference.activeLeaseCount === 0
            ? command.size
            : 0;
        const total =
          accounting.referencedBytes +
          accounting.reservedStageBytes +
          accounting.prospectiveFinalBytes +
          command.size +
          prospective;
        if (
          total > config.limits.maximumVaultBytes ||
          accounting.prospectiveFinalBytes + prospective > config.limits.maximumOrphanBytes
        )
          return yield* failed("quota_exceeded");
        const lease: Lease = {
          phase: "RESERVED",
          requestID: command.requestID.value,
          operationID: command.operationID.value,
          stageKey,
          finalKey,
          sha256: command.sha256,
          size: command.size,
          deviceID: command.deviceID,
          authEpoch: command.authEpoch,
          credentialEpoch: command.credentialEpoch,
          securityFloor: floors.securityFloor,
          expiresAtSeconds: nowSeconds + config.limits.stageTTLSeconds,
        };
        yield* tx
          .put(refAddress(command.sha256), {
            objectKey: finalKey,
            size: command.size,
            referenceCount: nextReference.referenceCount,
            activeLeaseCount: nextReference.activeLeaseCount + 1,
          })
          .pipe(Effect.mapError(() => new BlobError({ reason: "stage_conflict" })));
        yield* tx
          .put(leaseAddress(lease.operationID), payload(lease))
          .pipe(Effect.mapError(() => new BlobError({ reason: "stage_conflict" })));
        yield* writeBlobAccounting(tx, {
          referencedBytes: accounting.referencedBytes,
          reservedStageBytes: accounting.reservedStageBytes + command.size,
          prospectiveFinalBytes: accounting.prospectiveFinalBytes + prospective,
          leaseIDs: [...accounting.leaseIDs, lease.operationID],
          purgeSHA256s: accounting.purgeSHA256s,
        });
      }),
    );
  const stageImmutable: BlobStagingRepository["stageImmutable"] = (stageKey, body, nowSeconds) =>
    // Snapshot lease state in a completed transaction, then touch R2 outside it.
    transact((tx) => {
      const operationID = stageKey.split("/").at(-2) ?? "";
      return readLease(tx, operationID).pipe(
        Effect.flatMap((lease) =>
          lease === undefined ||
          lease.stageKey !== stageKey ||
          lease.phase !== "RESERVED" ||
          lease.expiresAtSeconds <= nowSeconds
            ? failed("stage_conflict")
            : Effect.void,
        ),
      );
    }).pipe(
      Effect.zipRight(
        config.r2.putIfAbsent(stageKey, new Uint8Array(body)).pipe(
          Effect.catchAll((error) => {
            if (error.reason !== "already_exists") return failed("stage_conflict");
            return config.r2.read(stageKey).pipe(
              Effect.flatMap((stored) =>
                stored.bytes.byteLength === body.byteLength &&
                stored.bytes.every((value, index) => value === body[index])
                  ? Effect.void
                  : failed("stage_conflict"),
              ),
              Effect.mapError(() => new BlobError({ reason: "stage_conflict" })),
            );
          }),
        ),
      ),
    );
  const publishImmutable: BlobStagingRepository["publishImmutable"] = (
    stageKey,
    finalKey,
    expectedHash,
    size,
    nowSeconds,
  ) =>
    // R2 read/put is intentionally between lease-state transactions.
    config.r2
      .read(stageKey)
      .pipe(
        Effect.mapError(() => new BlobError({ reason: "publish_failed" })),
        Effect.flatMap((stage) =>
          stage.bytes.byteLength !== size
            ? failed("publish_failed")
            : config.r2.putIfAbsent(finalKey, stage.bytes).pipe(
                Effect.catchAll((error) =>
                  error.reason === "already_exists"
                    ? config.r2.head(finalKey).pipe(
                        Effect.flatMap((found) =>
                          found === undefined ||
                          found.size !== size ||
                          found.sha256Base64 !== hexToBase64(expectedHash)
                            ? failed("publish_failed")
                            : Effect.void,
                        ),
                        Effect.mapError(() => new BlobError({ reason: "publish_failed" })),
                      )
                    : failed("publish_failed"),
                ),
              ),
        ),
        Effect.zipRight(
          transact((tx) =>
            readLease(tx, stageKey.split("/").at(-2) ?? "").pipe(
              Effect.flatMap((lease) =>
                lease === undefined ||
                lease.stageKey !== stageKey ||
                lease.finalKey !== finalKey ||
                lease.sha256 !== expectedHash ||
                lease.size !== size ||
                lease.expiresAtSeconds <= nowSeconds
                  ? failed("stage_conflict")
                  : tx
                      .put(
                        leaseAddress(lease.operationID),
                        payload({ ...lease, phase: "PUBLISHED" }),
                      )
                      .pipe(Effect.mapError(() => new BlobError({ reason: "stage_conflict" }))),
              ),
            ),
          ),
        ),
      );
  const verifyFinal: BlobStagingRepository["verifyFinal"] = (
    stageKey,
    finalKey,
    expectedHash,
    size,
    nowSeconds,
  ) =>
    config.r2.head(finalKey).pipe(
      Effect.mapError(() => new BlobError({ reason: "final_verification_failed" })),
      Effect.flatMap((found) =>
        found === undefined ||
        found.size !== size ||
        found.sha256Base64 !== hexToBase64(expectedHash)
          ? failed("final_verification_failed")
          : Effect.void,
      ),
    );
  const discardStage: BlobStagingRepository["discardStage"] = (stageKey) =>
    config.r2
      .deleteExact(stageKey)
      .pipe(Effect.mapError(() => new BlobError({ reason: "stage_conflict" })));
  const releaseReservation: BlobStagingRepository["releaseReservation"] = (stageKey, nowSeconds) =>
    // A stage still present is never released: this makes cleanup restart-safe.
    config.r2
      .head(stageKey)
      .pipe(
        Effect.mapError(() => new BlobError({ reason: "stage_conflict" })),
        Effect.flatMap((stage) => {
          if (stage !== undefined) return Effect.void;
          return transact((tx) => {
            const operationID = stageKey.split("/").at(-2) ?? "";
            return readLease(tx, operationID).pipe(
              Effect.flatMap((lease) =>
                lease === undefined
                  ? Effect.void
                  : getBlobAccounting(tx).pipe(
                      Effect.flatMap((accounting) => releaseLease(tx, lease, accounting)),
                    ),
              ),
            );
          });
        }),
      );
  const commitStaged: BlobStagingRepository["commitStaged"] = (
    command,
    stageKey,
    objectKey,
    nowSeconds,
  ) =>
    transact((tx) =>
      Effect.gen(function* () {
        const floors = yield* currentAuthority(tx, stageAuthorization(command));
        const tombstone = yield* tx.get(tombstoneAddress(command.sha256));
        if (tombstone !== undefined) return yield* failed<BlobStageExecution>("stage_conflict");
        const lease = yield* readLease(tx, command.operationID.value);
        if (
          lease === undefined ||
          lease.phase !== "PUBLISHED" ||
          lease.stageKey !== stageKey ||
          lease.finalKey !== objectKey ||
          lease.expiresAtSeconds <= nowSeconds ||
          lease.securityFloor !== floors.securityFloor
        )
          return yield* failed<BlobStageExecution>("stage_conflict");
        const receiptRow = yield* tx.get(receiptAddress(command.requestID.value));
        if (receiptRow !== undefined) {
          const prior = decodeReceipt(receiptRow);
          if (prior?.kind === "blob-stage" && prior.fingerprint === stageFingerprint(command))
            return hydrateResponse(prior.response);
          return yield* failed<BlobStageExecution>("replay_conflict");
        }
        const reference = decodeReference(yield* tx.get(refAddress(command.sha256)));
        const accounting = yield* getBlobAccounting(tx);
        if (
          reference === undefined ||
          reference.activeLeaseCount < 1 ||
          reference.objectKey !== objectKey ||
          reference.size !== command.size
        )
          return yield* storageFailed<BlobStageExecution>();
        const metadata: BlobMetadata = {
          requestID: command.requestID.value,
          path: command.path,
          sha256: command.sha256,
          size: command.size,
          objectKey,
          generationEpoch: command.scope.generationEpoch,
        };
        const response: BlobStageExecution = { metadata, status: "APPLIED" };
        const hadReference = reference.referenceCount > 0;
        const storedMetadata = {
          requestID: metadata.requestID,
          path: metadata.path,
          sha256: metadata.sha256,
          size: metadata.size,
          objectKey: metadata.objectKey,
        };
        const storedResponse = { metadata: storedMetadata, status: "APPLIED" };
        yield* tx
          .put(metadataAddress(command.sha256), storedMetadata)
          .pipe(Effect.mapError(() => new BlobError({ reason: "stage_conflict" })));
        yield* tx
          .put(refAddress(command.sha256), {
            objectKey,
            size: command.size,
            referenceCount: reference.referenceCount + 1,
            activeLeaseCount: reference.activeLeaseCount - 1,
          })
          .pipe(Effect.mapError(() => new BlobError({ reason: "stage_conflict" })));
        yield* tx
          .put(receiptAddress(command.requestID.value), {
            kind: "blob-stage",
            fingerprint: stageFingerprint(command),
            response: storedResponse,
          })
          .pipe(Effect.mapError(() => new BlobError({ reason: "stage_conflict" })));
        yield* tx
          .delete(leaseAddress(lease.operationID))
          .pipe(Effect.mapError(() => new BlobError({ reason: "stage_conflict" })));
        yield* writeBlobAccounting(tx, {
          referencedBytes: accounting.referencedBytes + (hadReference ? 0 : command.size),
          reservedStageBytes: accounting.reservedStageBytes - command.size,
          prospectiveFinalBytes:
            accounting.prospectiveFinalBytes - (hadReference ? 0 : command.size),
          leaseIDs: accounting.leaseIDs.filter((id) => id !== lease.operationID),
          purgeSHA256s: accounting.purgeSHA256s,
        });
        return response;
      }),
    );
  const reconcile = (nowSeconds: number): Effect.Effect<number, BlobOperationError> => {
    const expireOne = (operationID: string): Effect.Effect<number, BlobOperationError> =>
      transact((tx) =>
        readLease(tx, operationID).pipe(
          Effect.flatMap((lease) => {
            if (lease === undefined || lease.expiresAtSeconds > nowSeconds)
              return Effect.succeed(undefined);
            return tx.put(leaseAddress(operationID), payload({ ...lease, phase: "CLEANUP" })).pipe(
              Effect.as(lease),
              Effect.mapError(() => new BlobError({ reason: "stage_conflict" })),
            );
          }),
        ),
      ).pipe(
        Effect.flatMap((lease) => {
          if (lease === undefined) return Effect.succeed(0);
          return config.r2.deleteExact(lease.stageKey).pipe(
            Effect.mapError(() => new BlobError({ reason: "stage_conflict" })),
            Effect.zipRight(
              transact((tx) =>
                getBlobAccounting(tx).pipe(
                  Effect.flatMap((current) =>
                    readLease(tx, operationID).pipe(
                      Effect.flatMap((latest) =>
                        latest?.phase === "CLEANUP"
                          ? releaseLease(tx, latest, current).pipe(Effect.as(1))
                          : Effect.succeed(0),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
        }),
      );
    return transact((tx) => getBlobAccounting(tx)).pipe(
      Effect.flatMap((accounting) =>
        Effect.all([
          Effect.forEach(accounting.leaseIDs, expireOne, { concurrency: 1 }),
          Effect.forEach(accounting.purgeSHA256s, (sha256) => reconcileDelete(sha256, nowSeconds), {
            concurrency: 1,
          }),
        ]).pipe(
          Effect.map(([leases, purges]) =>
            [...leases, ...purges].reduce((total, value) => total + value, 0),
          ),
        ),
      ),
    );
  };
  const deleteBySHA256: OwnerVaultBlobLifecycleRepository["deleteBySHA256"] = (command) =>
    transact<{ readonly sha256: string; readonly status: "APPLIED" }>(
      (tx) =>
        Effect.gen(function* () {
          if (
            !hash.test(command.sha256) ||
            !safeID.test(command.requestID) ||
            !integer(command.nowSeconds)
          )
            return yield* failed<{ readonly sha256: string; readonly status: "APPLIED" }>(
              "invalid_blob",
            );
          yield* currentAuthority(tx, command.authorization);
          const priorReceipt = yield* tx.get(receiptAddress(command.requestID));
          const fingerprint = deleteFingerprint(
            command.authorization,
            command.sha256,
            command.requestID,
          );
          if (priorReceipt !== undefined) {
            const receipt = decodeReceipt(priorReceipt);
            return yield* receipt?.kind === "blob-delete" && receipt.fingerprint === fingerprint
              ? Effect.succeed(receipt.response)
              : failed<StoredDeleteResponse>("replay_conflict");
          }
          const metadata = yield* tx.get(metadataAddress(command.sha256));
          const reference = decodeReference(yield* tx.get(refAddress(command.sha256)));
          const accounting = yield* getBlobAccounting(tx);
          if (
            metadata === undefined ||
            reference === undefined ||
            reference.referenceCount < 1 ||
            reference.activeLeaseCount !== 0
          )
            return yield* failed<{ readonly sha256: string; readonly status: "APPLIED" }>(
              "stage_conflict",
            );
          const response = { sha256: command.sha256, status: "APPLIED" } as const;
          // One transaction atomically removes logical visibility, fences a new PUT, records the receipt and schedules purge.
          yield* tx.delete(metadataAddress(command.sha256));
          yield* tx.put(refAddress(command.sha256), {
            objectKey: reference.objectKey,
            size: reference.size,
            referenceCount: 0,
            activeLeaseCount: 0,
          });
          yield* tx.put(tombstoneAddress(command.sha256), {
            objectKey: reference.objectKey,
            deletedAtSeconds: command.nowSeconds,
            purgeAfterSeconds: command.nowSeconds + config.deleteGraceSeconds,
          });
          yield* tx.put(purgeAddress(command.sha256), {
            objectKey: reference.objectKey,
            leaseID: command.requestID,
            startedAtSeconds: 0,
          });
          yield* tx.put(receiptAddress(command.requestID), {
            kind: "blob-delete",
            fingerprint,
            response,
          });
          if (accounting.purgeSHA256s.length >= maximumTrackedLeases)
            return yield* failed<{ readonly sha256: string; readonly status: "APPLIED" }>(
              "quota_exceeded",
            );
          yield* writeBlobAccounting(tx, {
            referencedBytes: accounting.referencedBytes - reference.size,
            reservedStageBytes: accounting.reservedStageBytes,
            prospectiveFinalBytes: accounting.prospectiveFinalBytes,
            leaseIDs: accounting.leaseIDs,
            purgeSHA256s: [...accounting.purgeSHA256s, command.sha256],
          });
          return response;
        }),
    ).pipe(
      Effect.tap((response) =>
        reconcileDelete(response.sha256, command.nowSeconds).pipe(
          Effect.catchAll(() => Effect.void),
        ),
      ),
    );
  const reconcileDelete = (
    sha256: string,
    nowSeconds: number,
  ): Effect.Effect<number, BlobOperationError> =>
    transact((tx) =>
      Effect.all([
        tx.get(tombstoneAddress(sha256)),
        tx.get(purgeAddress(sha256)),
        tx.get(refAddress(sha256)),
      ]).pipe(
        Effect.flatMap(([tombstoneRow, purgeRow, referenceRow]) => {
          const tombstone = decodeTombstone(tombstoneRow);
          const purge = decodePurge(purgeRow);
          const reference = decodeReference(referenceRow);
          if (
            tombstone === undefined ||
            purge === undefined ||
            reference === undefined ||
            tombstone.purgeAfterSeconds > nowSeconds ||
            reference.referenceCount !== 0 ||
            reference.activeLeaseCount !== 0
          )
            return Effect.succeed(undefined);
          return tx
            .put(purgeAddress(sha256), {
              objectKey: tombstone.objectKey,
              leaseID: purge.leaseID,
              startedAtSeconds: nowSeconds,
            })
            .pipe(
              Effect.as({ tombstone, leaseID: purge.leaseID }),
              Effect.mapError(() => new BlobError({ reason: "stage_conflict" })),
            );
        }),
      ),
    ).pipe(
      Effect.flatMap((claim) => {
        if (claim === undefined) return Effect.succeed(0);
        return config.r2.deleteExact(claim.tombstone.objectKey).pipe(
          Effect.mapError(() => new BlobError({ reason: "stage_conflict" })),
          Effect.zipRight(
            transact((tx) =>
              Effect.all([
                tx.get(tombstoneAddress(sha256)),
                tx.get(purgeAddress(sha256)),
                tx.get(refAddress(sha256)),
                tx.get(blobAccountingAddress),
              ]).pipe(
                Effect.flatMap(([tombstoneRow, purgeRow, referenceRow, accountingRow]) => {
                  const tombstone = decodeTombstone(tombstoneRow);
                  const purge = decodePurge(purgeRow);
                  const reference = decodeReference(referenceRow);
                  const accounting = decodeBlobAccounting(accountingRow);
                  if (
                    tombstone === undefined ||
                    purge?.leaseID !== claim.leaseID ||
                    purge.startedAtSeconds !== nowSeconds ||
                    reference?.referenceCount !== 0 ||
                    reference.activeLeaseCount !== 0 ||
                    accounting === undefined
                  )
                    return Effect.succeed(0);
                  return tx.delete(tombstoneAddress(sha256)).pipe(
                    Effect.zipRight(tx.delete(purgeAddress(sha256))),
                    Effect.zipRight(tx.delete(refAddress(sha256))),
                    Effect.zipRight(
                      writeBlobAccounting(tx, {
                        ...accounting,
                        purgeSHA256s: accounting.purgeSHA256s.filter((value) => value !== sha256),
                      }),
                    ),
                    Effect.as(1),
                    Effect.mapError(() => new BlobError({ reason: "stage_conflict" })),
                  );
                }),
              ),
            ),
          ),
        );
      }),
    );
  return Object.freeze({
    preflightReceipt,
    reserveStage,
    stageImmutable,
    publishImmutable,
    verifyFinal,
    discardStage,
    releaseReservation,
    commitStaged,
    reconcileOrphans: reconcile,
    reconcile,
    deleteBySHA256,
  });
};
