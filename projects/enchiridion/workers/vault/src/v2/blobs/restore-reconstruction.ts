/** @enchiridion/effect-module */
/**
 * Pure P03 restore reconstruction.
 *
 * C1 supplies an immutable, already-decoded inventory after record restore.
 * This module neither decodes ingress nor touches storage/R2; it only proves
 * the restored blob lifecycle is internally consistent and derives the
 * target-local accounting and purge work that C1 must materialize atomically.
 */
import { type BlobLimits, type BlobScope, blobObjectKey, validBlobPath } from "./blobs";
import {
  type OwnerVaultBlobAccounting,
  type OwnerVaultBlobReference,
  type OwnerVaultBlobTombstone,
  isOwnerVaultBlobAccounting,
  isOwnerVaultBlobReference,
  isOwnerVaultBlobTombstone,
} from "./owner-vault-blob-repository";

const hash = /^[a-f0-9]{64}$/u;
const identifier = /^[A-Za-z0-9_-]{1,128}$/u;
const maximumRestoredBlobRows = 4_096;
const maximumPendingPurges = 32;

export interface OwnerVaultRestoredBlobMetadata {
  readonly sha256: string;
  readonly requestID: string;
  readonly path: string;
  readonly size: number;
  readonly objectKey: string;
}

export interface OwnerVaultRestoredBlobReference {
  readonly sha256: string;
  readonly reference: OwnerVaultBlobReference;
}

export interface OwnerVaultRestoredBlobTombstone {
  readonly sha256: string;
  readonly tombstone: OwnerVaultBlobTombstone;
}

/** Immutable decoded inventory only: no `unknown`, native storage, or R2 input is admitted here. */
export interface OwnerVaultRestoredBlobInventory {
  readonly metadata: readonly OwnerVaultRestoredBlobMetadata[];
  readonly references: readonly OwnerVaultRestoredBlobReference[];
  readonly tombstones: readonly OwnerVaultRestoredBlobTombstone[];
}

export interface OwnerVaultBlobRestoreReconstruction {
  /** Exact reference records C1 should retain after its own record restore. */
  readonly references: readonly OwnerVaultRestoredBlobReference[];
  /** Exact tombstones C1 should retain and schedule for target-local purge. */
  readonly tombstones: readonly OwnerVaultRestoredBlobTombstone[];
  /** Target-local state: restored backups never revive a source lease. */
  readonly accounting: OwnerVaultBlobAccounting;
  readonly lifecycle: {
    readonly purgeSHA256s: readonly string[];
    readonly leaseIDs: readonly [];
  };
}

export type OwnerVaultBlobRestoreReconstructionResult =
  | { readonly _tag: "OwnerVaultBlobRestoreReconstructionSuccess"; readonly value: OwnerVaultBlobRestoreReconstruction }
  | {
    readonly _tag: "OwnerVaultBlobRestoreReconstructionFailure";
    readonly reason:
      | "invalid_inventory"
      | "invalid_limits"
      | "lifecycle_conflict"
      | "quota_exceeded";
  };

const failed = (
  reason: Extract<OwnerVaultBlobRestoreReconstructionResult, { readonly _tag: "OwnerVaultBlobRestoreReconstructionFailure" }>["reason"],
): OwnerVaultBlobRestoreReconstructionResult => ({ _tag: "OwnerVaultBlobRestoreReconstructionFailure", reason });
const successful = (value: OwnerVaultBlobRestoreReconstruction): OwnerVaultBlobRestoreReconstructionResult =>
  ({ _tag: "OwnerVaultBlobRestoreReconstructionSuccess", value });
const integer = (value: number, minimum = 0): boolean => Number.isSafeInteger(value) && value >= minimum;
const validLimits = (limits: BlobLimits): boolean =>
  integer(limits.maximumBlobBytes, 1) && integer(limits.maximumVaultBytes, limits.maximumBlobBytes) &&
  integer(limits.maximumOrphanBytes) && limits.maximumOrphanBytes <= limits.maximumVaultBytes &&
  integer(limits.maximumOrphanCount) && integer(limits.maximumActiveLeasesPerVault, 1) &&
  integer(limits.maximumActiveLeasesPerFinal, 1) && integer(limits.stageTTLSeconds, 1);
const validMetadata = (scope: BlobScope, limits: BlobLimits, value: OwnerVaultRestoredBlobMetadata): boolean =>
  hash.test(value.sha256) && identifier.test(value.requestID) && validBlobPath(value.path) &&
  integer(value.size) && value.size <= limits.maximumBlobBytes &&
  blobObjectKey(scope, value.sha256) === value.objectKey;
const uniqueSHA256 = <A extends { readonly sha256: string }>(values: readonly A[]): boolean =>
  values.every((value) => hash.test(value.sha256)) && new Set(values.map((value) => value.sha256)).size === values.length;
const byHash = <A extends { readonly sha256: string }>(values: readonly A[]): ReadonlyMap<string, A> =>
  new Map(values.map((value) => [value.sha256, value]));

/**
 * Reconstructs target-local blob accounting from a completed immutable backup
 * inventory. It intentionally returns a closed tagged result rather than an
 * Effect: C1 can call it inside its one durable finalize transaction without
 * introducing I/O, async work, or a nested transaction.
 */
export const reconstructOwnerVaultRestoredBlobInventory = (
  scope: BlobScope,
  limits: BlobLimits,
  inventory: OwnerVaultRestoredBlobInventory,
): OwnerVaultBlobRestoreReconstructionResult => {
  if (!validLimits(limits)) return failed("invalid_limits");
  const totalRows = inventory.metadata.length + inventory.references.length + inventory.tombstones.length;
  if (totalRows > maximumRestoredBlobRows ||
    !uniqueSHA256(inventory.metadata) || !uniqueSHA256(inventory.references) || !uniqueSHA256(inventory.tombstones) ||
    !inventory.metadata.every((value) => validMetadata(scope, limits, value)) ||
    !inventory.references.every((value) => isOwnerVaultBlobReference(value.reference)) ||
    !inventory.tombstones.every((value) => isOwnerVaultBlobTombstone(value.tombstone)))
    return failed("invalid_inventory");

  const metadata = byHash(inventory.metadata);
  const tombstones = byHash(inventory.tombstones);
  let referencedBytes = 0;
  const retainedReferences: OwnerVaultRestoredBlobReference[] = [];
  for (const item of inventory.references) {
    const expectedObjectKey = blobObjectKey(scope, item.sha256);
    if (expectedObjectKey === undefined || item.reference.objectKey !== expectedObjectKey ||
      item.reference.size > limits.maximumBlobBytes || item.reference.activeLeaseCount !== 0)
      return failed("invalid_inventory");
    const metadataEntry = metadata.get(item.sha256);
    const tombstoneEntry = tombstones.get(item.sha256);
    if (item.reference.referenceCount > 0) {
      if (metadataEntry === undefined || tombstoneEntry !== undefined ||
        metadataEntry.size !== item.reference.size || metadataEntry.objectKey !== item.reference.objectKey)
        return failed("lifecycle_conflict");
      referencedBytes += item.reference.size;
      if (!Number.isSafeInteger(referencedBytes) || referencedBytes > limits.maximumVaultBytes)
        return failed("quota_exceeded");
    } else if (metadataEntry !== undefined || tombstoneEntry === undefined ||
      tombstoneEntry.tombstone.objectKey !== item.reference.objectKey)
      return failed("lifecycle_conflict");
    retainedReferences.push({ sha256: item.sha256, reference: { ...item.reference } });
  }

  if ([...metadata.keys()].some((sha256) => !inventory.references.some((reference) => reference.sha256 === sha256)) ||
    [...tombstones.keys()].some((sha256) => !inventory.references.some((reference) => reference.sha256 === sha256)))
    return failed("lifecycle_conflict");
  const purgeSHA256s = [...tombstones.keys()].sort();
  if (purgeSHA256s.length > maximumPendingPurges) return failed("quota_exceeded");
  const accounting: OwnerVaultBlobAccounting = {
    referencedBytes,
    reservedStageBytes: 0,
    prospectiveFinalBytes: 0,
    leaseIDs: [],
    purgeSHA256s,
  };
  if (!isOwnerVaultBlobAccounting(accounting)) return failed("invalid_inventory");
  return successful({
    references: retainedReferences.sort((left, right) => left.sha256.localeCompare(right.sha256)),
    tombstones: [...inventory.tombstones].sort((left, right) => left.sha256.localeCompare(right.sha256)),
    accounting,
    lifecycle: { purgeSHA256s, leaseIDs: [] },
  });
};
