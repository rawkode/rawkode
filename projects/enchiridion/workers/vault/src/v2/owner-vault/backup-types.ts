/** @enchiridion/effect-module */
import type { ImmutableR2Boundary, ManifestSigner, ManifestVerifier } from "@enchiridion/runtime";
import { Data, Effect } from "effect";
import type { OwnerVaultStorageAddress, OwnerVaultStorageRepository } from "./repository";
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
  readonly logHead: number;
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
  readonly releaseSnapshot: (pin: OwnerVaultSnapshotPin) => Effect.Effect<void, OwnerVaultBackupError>;
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
  readonly logHead: number;
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
  readonly state: "APPLYING" | "COMPLETED";
}

/** The target root and all security state are created independently of a source backup. */
export interface OwnerVaultPrivateRestoreTarget {
  readonly root: OwnerVaultTargetRoot;
  readonly assertFreshPrivateTarget: () => Effect.Effect<void, OwnerVaultBackupError>;
  readonly readJournal: (backupID: string) => Effect.Effect<OwnerVaultRestoreJournal | undefined, OwnerVaultBackupError>;
  readonly writeJournal: (journal: OwnerVaultRestoreJournal) => Effect.Effect<void, OwnerVaultBackupError>;
  readonly applyRecord: (entry: OwnerVaultBackupPageEntry, record: OwnerVaultStorageRecord) => Effect.Effect<void, OwnerVaultBackupError>;
  readonly writeRestoreAudit: (source: OwnerVaultBackupScope, backupID: string, manifestDigest: string) => Effect.Effect<void, OwnerVaultBackupError>;
  /** Rebuilds derived catalog/accounting and sets log head only after exact 1..N validation. */
  readonly completeRestore: (input: { readonly backupID: string; readonly highWaterMark: string; readonly logHead: number; readonly manifestDigest: string }) => Effect.Effect<void, OwnerVaultBackupError>;
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
  readonly rebuildDerived: (input: { readonly backupID: string; readonly highWaterMark: string; readonly logHead: number; readonly manifestDigest: string }) => Effect.Effect<void, OwnerVaultBackupError>;
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
