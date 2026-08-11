/** @enchiridion/effect-module */
import type { ImmutableR2Boundary, ManifestSigner, ManifestVerifier } from "@enchiridion/runtime";
import { Data, Effect } from "effect";
import type { OwnerVaultStorageAddress, OwnerVaultStorageRepository } from "./repository";
import type { BlobLimits, BlobScope } from "../blobs/blobs";
import type {
  OwnerVaultBlobRestoreReconstructionResult,
  OwnerVaultRestoredBlobMetadata,
  OwnerVaultRestoredBlobInventory,
} from "../blobs/restore-reconstruction";
import type { OwnerVaultAppendLogEntry } from "./domains";
import type { OwnerVaultRestoreImport } from "./restore-import";
import type { OwnerVaultStorageCategory, OwnerVaultStorageRecord, OwnerVaultTargetRoot } from "./storage-registry";

export const ownerVaultBackupMaximumPageBytes = 512 * 1024;
export const ownerVaultBackupMaximumPageEntries = 128;
export const ownerVaultBackupMaximumObjectBytes = 8 * 1024 * 1024;
export const ownerVaultBackupMaximumTotalBytes = 96 * 1024 * 1024;
export const ownerVaultBackupMaximumManifestBytes = 1024 * 1024;
export const ownerVaultBackupMaximumRestoreJournalBytes = 64 * 1024;
/** Keeps a manifest under its hard limit even for small source records. */
export const ownerVaultBackupMaximumObjects = 4_096;

export interface OwnerVaultBackupScope {
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generationEpoch: number;
}

/** A durable, source-local proof that a named high-water catalog is frozen. */
export interface OwnerVaultSnapshotPin {
  readonly backupID: string;
  readonly scope: OwnerVaultBackupScope;
  readonly highWaterMark: string;
  readonly appendLogSequence: number;
  readonly appendLogDigest: string;
  readonly catalogDigest: string;
  readonly pinProof: string;
}

export interface OwnerVaultSnapshotObject {
  readonly ordinal: number;
  readonly address: OwnerVaultStorageAddress;
  readonly record: OwnerVaultStorageRecord;
  readonly sha256Base64: string;
  readonly size: number;
  /** R2-backed values must carry authoritative metadata for the source provider to verify. */
  readonly r2?: { readonly key: string; readonly size: number; readonly sha256Base64: string };
}

export interface OwnerVaultSnapshotPage {
  readonly entries: readonly OwnerVaultSnapshotObject[];
  readonly digest: string;
  readonly nextCursor?: string;
}

/**
 * P06-05 implements this at the OwnerVault DO boundary. `beginSnapshot` must
 * atomically pin an immutable catalog and high-water before exposing a page.
 * This package deliberately has no list-enumeration fallback.
 */
export interface OwnerVaultBackupSnapshotSource {
  readonly beginSnapshot: (scope: OwnerVaultBackupScope, backupID: string) => Effect.Effect<OwnerVaultSnapshotPin, OwnerVaultBackupError>;
  readonly readSnapshotPage: (pin: OwnerVaultSnapshotPin, cursor: string | undefined) => Effect.Effect<OwnerVaultSnapshotPage, OwnerVaultBackupError>;
  /** Marks the exact immutable signed manifest as complete before retention is released. */
  readonly completeSnapshot: (pin: OwnerVaultSnapshotPin, manifestDigest: string) => Effect.Effect<void, OwnerVaultBackupError>;
  readonly releaseSnapshot: (pin: OwnerVaultSnapshotPin) => Effect.Effect<void, OwnerVaultBackupError>;
  /** Explicit operator abort only; normal archive failures intentionally remain OPEN for retry. */
  readonly abortSnapshot: (pin: OwnerVaultSnapshotPin) => Effect.Effect<void, OwnerVaultBackupError>;
}

export interface OwnerVaultBackupPageEntry {
  readonly ordinal: number;
  readonly key: string;
  readonly sha256Base64: string;
  readonly size: number;
  readonly category: OwnerVaultStorageCategory;
  readonly identifier?: string;
  readonly r2?: { readonly key: string; readonly size: number; readonly sha256Base64: string };
}

export interface OwnerVaultBackupPage {
  readonly ordinal: number;
  readonly entries: readonly OwnerVaultBackupPageEntry[];
  readonly digest: string;
}

export interface OwnerVaultBackupManifest {
  readonly version: 1;
  readonly backupID: string;
  readonly source: OwnerVaultBackupScope;
  readonly highWaterMark: string;
  readonly appendLogSequence: number;
  readonly appendLogDigest: string;
  readonly catalogDigest: string;
  readonly pinProof: string;
  readonly totalBytes: number;
  readonly objectCount: number;
  readonly pages: readonly { readonly ordinal: number; readonly key: string; readonly digest: string; readonly count: number; readonly size: number }[];
}

export interface OwnerVaultSignedBackupManifest {
  readonly manifest: OwnerVaultBackupManifest;
  readonly signature: { readonly keyID: string; readonly signatureDERBase64: string };
}

export interface OwnerVaultRestoreJournal {
  readonly backupID: string;
  readonly manifestDigest: string;
  readonly lastAppliedOrdinal: number;
  /** Rolling source-scoped Dn tuple; ordinal zero starts at D0. */
  readonly appendLogSequence: number;
  readonly appendLogDigest: string;
  readonly state: "APPLYING" | "COMPLETED";
}

/**
 * Fully typed C1 import contract.  R2 reads/copies and signature verification
 * happen before this boundary; it accepts only an already-decoded inventory.
 */
export interface OwnerVaultRestoreImportRecord {
  readonly ordinal: number;
  readonly address: OwnerVaultStorageAddress;
  readonly version: 1;
  readonly category: OwnerVaultStorageCategory;
  readonly codec: "owner-vault-storage-record-v1";
  readonly sha256Base64: string;
  readonly size: number;
}

export interface OwnerVaultRestoreImportPlan {
  readonly backupID: string;
  readonly manifestDigest: string;
  /** Immutable source scope, used for D0 rather than the later PRIVATE target. */
  readonly source: OwnerVaultBackupScope;
  readonly highWaterMark: string;
  readonly appendLogSequence: number;
  readonly appendLogDigest: string;
  readonly totalBytes: number;
  readonly objectCount: number;
  /** Deterministic hash chain over the exact ordinal/address/version/hash inventory. */
  readonly hashChain: string;
  readonly records: readonly OwnerVaultRestoreImportRecord[];
}

export interface OwnerVaultRestoreImportReceipt {
  readonly restoreID: string;
  readonly outcome: "COMPLETED";
  readonly targetRoot: OwnerVaultTargetRoot;
  readonly securityFloor: number;
  readonly manifestDigest: string;
  readonly inventoryDigest: string;
  readonly appendLogSequence: number;
  readonly appendLogDigest: string;
  /** Deterministic target inventory/catalog content proof. */
  readonly targetCatalogProof: string;
  readonly accountingProof: string;
  readonly blobProof: string;
  readonly finalizationProof: string;
}

/**
 * Target R2 evidence is represented only by the already-decoded target-keyed
 * P03 inventory. Its pure callback rejects a source object key fail-closed.
 */
export interface OwnerVaultRestoreImportFinalization {
  readonly blobScope: BlobScope;
  readonly blobLimits: BlobLimits;
  /** Verified outside the transaction after R2 copy/rekey; C1 binds it to restored metadata. */
  readonly targetBlobEvidence: readonly OwnerVaultRestoredBlobMetadata[];
}

/** Pure P02 seam: C1 supplies exact restored rows, never caller-selected subsets. */
export type OwnerVaultRestoreAppendLogValidator = (input: {
  readonly scope: OwnerVaultBackupScope;
  readonly entries: readonly OwnerVaultAppendLogEntry[];
  readonly appendLogSequence: number;
  readonly appendLogDigest: string;
}) => boolean;

export type OwnerVaultRestoreReconstruction = (
  scope: BlobScope,
  limits: BlobLimits,
  inventory: OwnerVaultRestoredBlobInventory,
) => OwnerVaultBlobRestoreReconstructionResult;

/**
 * Composition boundary for a pre-initialized later PRIVATE target.  The C1
 * importer owns its journal and atomic publication; this adapter only admits
 * verified archive/R2 material to that contract.
 */
export interface OwnerVaultPrivateRestoreTarget {
  readonly root: OwnerVaultTargetRoot;
  readonly assertFreshPrivateTarget: () => Effect.Effect<void, OwnerVaultBackupError>;
  readonly restoreImport: OwnerVaultRestoreImport;
  readonly blobScope: BlobScope;
  readonly blobLimits: BlobLimits;
}

export interface OwnerVaultBackupRuntime {
  readonly r2: ImmutableR2Boundary;
  readonly signer: ManifestSigner;
  readonly verifier: ManifestVerifier;
}

export interface OwnerVaultStorageRestoreAdapterOptions {
  readonly repository: OwnerVaultStorageRepository;
  readonly root: OwnerVaultTargetRoot;
  /** P06-05 supplies the DO-local no-source-state check; storage listing is never used as a fallback. */
  readonly assertFreshPrivateTarget: () => Effect.Effect<void, OwnerVaultBackupError>;
  readonly blobScope: BlobScope;
  readonly blobLimits: BlobLimits;
  readonly reconstruct?: OwnerVaultRestoreReconstruction;
  readonly validateAppendLog?: OwnerVaultRestoreAppendLogValidator;
}

export class OwnerVaultBackupError extends Data.TaggedError("OwnerVaultBackupError")<{
  readonly reason:
    | "archive_conflict"
    | "catalog_invalid"
    | "integrity_failed"
    | "invalid_backup"
    | "manifest_invalid"
    | "manifest_untrusted"
    | "private_target_required"
    | "restore_conflict"
    | "source_unavailable";
}> {}

export const ownerVaultBackupFailure = <A = never>(
  reason: OwnerVaultBackupError["reason"],
): Effect.Effect<A, OwnerVaultBackupError> => Effect.fail(new OwnerVaultBackupError({ reason }));
