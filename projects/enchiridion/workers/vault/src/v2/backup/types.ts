/** @enchiridion/effect-module */
import type {
  ImmutableR2Boundary,
  ManifestSignature,
  ManifestSigner,
  ManifestVerifier,
} from "@enchiridion/runtime";
import { Context, Data, Effect } from "effect";
import type { OwnerID, VaultID } from "../foundation/schemas";

export interface BackupScope {
  readonly ownerID: OwnerID;
  readonly vaultID: VaultID;
  readonly generationEpoch: number;
}

/** Every snapshot has an authenticated catalog entry for each of these classes. */
export type BackupObjectKind = "blob" | "device" | "document" | "receipt" | "session" | "tombstone";

/** Plain bytes captured by the source generation before immutable archival. */
export interface BackupSnapshotObject {
  readonly kind: BackupObjectKind;
  readonly sourceID: string;
  readonly bytes: Uint8Array;
}

/** Captured atomically with the source catalog at one immutable high-water. */
export interface BackupSnapshot {
  readonly highWaterMark: string;
  readonly routingEpoch: number;
  readonly controlEpoch: number;
  readonly credentialEpoch: number;
  readonly generationEpoch: number;
  readonly catalogDigest: string;
  readonly objects: readonly BackupSnapshotObject[];
}

export interface BackupManifestObject {
  readonly kind: BackupObjectKind;
  readonly key: string;
  readonly sha256Base64: string;
  readonly size: number;
}

/** The signature always covers canonical bytes of this unsigned value only. */
export interface BackupManifest {
  readonly version: 1;
  readonly backupID: string;
  readonly scope: BackupScope;
  readonly highWaterMark: string;
  readonly routingEpoch: number;
  readonly controlEpoch: number;
  readonly credentialEpoch: number;
  readonly generationEpoch: number;
  readonly catalogDigest: string;
  readonly createdAtMilliseconds: number;
  readonly expiresAtMilliseconds: number;
  readonly protocolVersion: 2;
  readonly schemaVersion: 1;
  readonly objects: readonly BackupManifestObject[];
}

export interface SignedBackupManifest {
  readonly manifest: BackupManifest;
  readonly signature: ManifestSignature;
}

export interface BackupLimits {
  readonly maximumObjects: number;
  readonly maximumObjectBytes: number;
  readonly maximumTotalObjectBytes: number;
  readonly maximumManifestBytes: number;
  readonly maximumObjectKeyBytes: number;
  readonly maximumManifestLifetimeMilliseconds: number;
}

export const defaultBackupLimits: BackupLimits = {
  maximumObjects: 10_000,
  maximumObjectBytes: 32 * 1_024 * 1_024,
  maximumTotalObjectBytes: 512 * 1_024 * 1_024,
  maximumManifestBytes: 4 * 1_024 * 1_024,
  maximumObjectKeyBytes: 1_024,
  maximumManifestLifetimeMilliseconds: 31 * 24 * 60 * 60 * 1_000,
};

export class BackupError extends Data.TaggedError("BackupError")<{
  readonly reason:
    | "archive_conflict"
    | "integrity_failed"
    | "invalid_backup"
    | "manifest_expired"
    | "manifest_invalid"
    | "manifest_untrusted"
    | "promotion_rejected"
    | "recovery_conflict"
    | "source_invalid";
}> {}

export interface BackupSnapshotSource {
  readonly snapshot: (
    scope: BackupScope,
    backupID: string,
  ) => Effect.Effect<BackupSnapshot, BackupError>;
}

/** A target must prove it is a private, inactive later generation before writes. */
export interface BackupRestoreTarget {
  readonly scope: BackupScope;
  readonly inactivePrivate: boolean;
}

/**
 * Fresh-generation restore boundary. It deliberately has no active-route
 * mutation: `BackupPromotionCallbacks.activateTarget` owns the only routing
 * CAS, after the P03-05 promotion state machine reaches `PROMOTING`.
 */
export interface BackupRecoveryRepository {
  readonly allocateInactiveGeneration: (
    source: BackupScope,
    backupID: string,
  ) => Effect.Effect<BackupRestoreTarget, BackupError>;
  readonly controlEpochFloor: (source: BackupScope) => Effect.Effect<number, BackupError>;
  readonly restoreObject: (
    target: BackupRestoreTarget,
    object: BackupManifestObject,
    bytes: Uint8Array,
  ) => Effect.Effect<void, BackupError>;
  readonly validateInactiveGeneration: (
    target: BackupRestoreTarget,
    manifest: BackupManifest,
  ) => Effect.Effect<void, BackupError>;
}

export type BackupPromotionStatus =
  | "FAILED"
  | "FREEZE_REQUESTED"
  | "FROZEN"
  | "PROMOTED"
  | "PROMOTING"
  | "READY_PRIVATE"
  | "RESTORING";

/** Durable proof that this exact run fenced its source at a named high-water. */
export interface BackupPromotionFrozenEvidence {
  readonly source: BackupScope;
  readonly target: BackupScope;
  readonly expectedRoutingEpoch: number;
  readonly expectedSourceGenerationEpoch: number;
  readonly controlEpoch: number;
  readonly snapshotHighWater: string;
}

/** Durable proof that the exact frozen target was validated while still private. */
export interface BackupPromotionReadyPrivateEvidence extends BackupPromotionFrozenEvidence {
  readonly validationDigest: string;
}

/** Persisted, restartable promotion state; `revision` is an optimistic CAS fence. */
export interface BackupPromotionRun {
  readonly runID: string;
  readonly backupID: string;
  readonly source: BackupScope;
  readonly target: BackupScope;
  readonly expectedRoutingEpoch: number;
  readonly expectedSourceGenerationEpoch: number;
  readonly controlEpoch: number;
  readonly revision: number;
  readonly status: BackupPromotionStatus;
  readonly snapshotHighWater?: string;
  readonly validationDigest?: string;
  readonly frozenEvidence?: BackupPromotionFrozenEvidence;
  readonly readyPrivateEvidence?: BackupPromotionReadyPrivateEvidence;
}

/** A durable provider supplies storage; P03-05 owns all transition rules. */
export interface BackupPromotionRepository {
  readonly read: (runID: string) => Effect.Effect<BackupPromotionRun | undefined, BackupError>;
  /** Atomically creates a run only when its source/routing epoch has no live run. */
  readonly createIfSourceUnfenced: (
    next: BackupPromotionRun,
  ) => Effect.Effect<boolean, BackupError>;
  readonly compareAndSet: (
    expected: BackupPromotionRun | undefined,
    next: BackupPromotionRun,
  ) => Effect.Effect<boolean, BackupError>;
}

/** Every callback must be idempotent for the same run ID and target. */
export interface BackupPromotionCallbacks {
  /** Atomically fences source writes/read-only and returns its snapshot high-water. */
  readonly freezeSource: (
    source: BackupScope,
    controlEpoch: number,
    runID: string,
  ) => Effect.Effect<string, BackupError>;
  readonly restorePrivate: (
    target: BackupScope,
    snapshotHighWater: string,
    runID: string,
  ) => Effect.Effect<void, BackupError>;
  readonly validatePrivate: (
    target: BackupScope,
    runID: string,
  ) => Effect.Effect<string, BackupError>;
  /** Atomic routing CAS; target stays private until this succeeds and source cannot be restored. */
  readonly activateTarget: (
    source: BackupScope,
    target: BackupScope,
    expectedRoutingEpoch: number,
    controlEpoch: number,
    runID: string,
  ) => Effect.Effect<void, BackupError>;
}

export interface BackupRuntime {
  readonly r2: ImmutableR2Boundary;
  readonly signer: ManifestSigner;
  readonly verifier: ManifestVerifier;
}

export const BackupRuntime = Context.GenericTag<BackupRuntime>(
  "@enchiridion/worker-vault/v2/backup/BackupRuntime",
);
export const BackupSnapshotSource = Context.GenericTag<BackupSnapshotSource>(
  "@enchiridion/worker-vault/v2/backup/BackupSnapshotSource",
);
export const BackupRecoveryRepository = Context.GenericTag<BackupRecoveryRepository>(
  "@enchiridion/worker-vault/v2/backup/BackupRecoveryRepository",
);
export const BackupPromotionRepository = Context.GenericTag<BackupPromotionRepository>(
  "@enchiridion/worker-vault/v2/backup/BackupPromotionRepository",
);
export const BackupPromotionCallbacks = Context.GenericTag<BackupPromotionCallbacks>(
  "@enchiridion/worker-vault/v2/backup/BackupPromotionCallbacks",
);

export const backupFailure = <A>(reason: BackupError["reason"]): Effect.Effect<A, BackupError> =>
  Effect.fail(new BackupError({ reason }));
