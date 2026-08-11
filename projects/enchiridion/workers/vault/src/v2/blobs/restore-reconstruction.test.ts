import { describe, expect, test } from "bun:test";
import { ownerID, vaultID } from "../foundation/schemas";
import { type BlobLimits, type BlobScope, blobObjectKey } from "./blobs";
import { reconstructOwnerVaultRestoredBlobInventory } from "./restore-reconstruction";

const required = <A>(value: A | undefined): A => {
  if (value === undefined) throw new Error("invalid test setup");
  return value;
};
const sha256 = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
const deletedSHA256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const secondSHA256 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const scope: BlobScope = {
  ownerID: required(ownerID("owner-1")),
  vaultID: required(vaultID("vault-1")),
  generationEpoch: 2,
};
const limits: BlobLimits = {
  maximumBlobBytes: 16,
  maximumVaultBytes: 32,
  maximumOrphanBytes: 16,
  maximumOrphanCount: 2,
  maximumActiveLeasesPerVault: 4,
  maximumActiveLeasesPerFinal: 4,
  stageTTLSeconds: 10,
};
const objectKey = required(blobObjectKey(scope, sha256));
const deletedObjectKey = required(blobObjectKey(scope, deletedSHA256));
const secondObjectKey = required(blobObjectKey(scope, secondSHA256));
const valid = () => ({
  metadata: [{ sha256, requestID: "restore-request-0001", path: "notes/today", size: 3, objectKey }],
  references: [
    { sha256, reference: { objectKey, size: 3, referenceCount: 1, activeLeaseCount: 0 } },
    { sha256: deletedSHA256, reference: { objectKey: deletedObjectKey, size: 4, referenceCount: 0, activeLeaseCount: 0 } },
  ],
  tombstones: [{ sha256: deletedSHA256, tombstone: { objectKey: deletedObjectKey, deletedAtSeconds: 10, purgeAfterSeconds: 20 } }],
} as const);

describe("OwnerVault blob restore reconstruction", () => {
  test("reconstructs deterministic target-local accounting and purge lifecycle from a valid immutable inventory", () => {
    const result = reconstructOwnerVaultRestoredBlobInventory(scope, limits, valid());
    expect(result).toEqual({
      _tag: "OwnerVaultBlobRestoreReconstructionSuccess",
      value: {
        references: [
          { sha256, reference: { objectKey, size: 3, referenceCount: 1, activeLeaseCount: 0 } },
          { sha256: deletedSHA256, reference: { objectKey: deletedObjectKey, size: 4, referenceCount: 0, activeLeaseCount: 0 } },
        ].sort((left, right) => left.sha256.localeCompare(right.sha256)),
        tombstones: [{ sha256: deletedSHA256, tombstone: { objectKey: deletedObjectKey, deletedAtSeconds: 10, purgeAfterSeconds: 20 } }],
        accounting: { referencedBytes: 3, reservedStageBytes: 0, prospectiveFinalBytes: 0, leaseIDs: [], purgeSHA256s: [deletedSHA256] },
        lifecycle: { leaseIDs: [], purgeSHA256s: [deletedSHA256] },
      },
    });
  });

  test("fails closed for malformed canonical reference/accounting invariants", () => {
    const inventory = valid();
    const result = reconstructOwnerVaultRestoredBlobInventory(scope, limits, {
      ...inventory,
      references: [{ sha256, reference: { objectKey, size: 3, referenceCount: 1, activeLeaseCount: -1 } }],
      tombstones: [],
    });
    expect(result).toEqual({ _tag: "OwnerVaultBlobRestoreReconstructionFailure", reason: "invalid_inventory" });
  });

  test("fails closed for inconsistent reference, metadata, and tombstone lifecycle", () => {
    const inventory = valid();
    const result = reconstructOwnerVaultRestoredBlobInventory(scope, limits, {
      ...inventory,
      tombstones: [{ sha256, tombstone: { objectKey, deletedAtSeconds: 10, purgeAfterSeconds: 20 } }],
    });
    expect(result).toEqual({ _tag: "OwnerVaultBlobRestoreReconstructionFailure", reason: "lifecycle_conflict" });
  });

  test("rejects active source leases and impossible restore limits instead of reviving lifecycle work", () => {
    const inventory = valid();
    const activeLease = reconstructOwnerVaultRestoredBlobInventory(scope, limits, {
      ...inventory,
      references: [{ sha256, reference: { objectKey, size: 3, referenceCount: 1, activeLeaseCount: 1 } }],
      tombstones: [],
    });
    expect(activeLease).toEqual({ _tag: "OwnerVaultBlobRestoreReconstructionFailure", reason: "invalid_inventory" });

    const overflow = reconstructOwnerVaultRestoredBlobInventory(scope, { ...limits, maximumVaultBytes: 2 }, valid());
    expect(overflow).toEqual({ _tag: "OwnerVaultBlobRestoreReconstructionFailure", reason: "invalid_limits" });
  });

  test("rejects a bounded but over-quota reconstructed reference total", () => {
    const inventory = valid();
    const result = reconstructOwnerVaultRestoredBlobInventory(scope, { ...limits, maximumBlobBytes: 3, maximumVaultBytes: 3, maximumOrphanBytes: 3 }, {
      metadata: [
        inventory.metadata[0],
        { sha256: secondSHA256, requestID: "restore-request-0002", path: "notes/tomorrow", size: 1, objectKey: secondObjectKey },
      ],
      references: [
        { sha256, reference: { objectKey, size: 3, referenceCount: 1, activeLeaseCount: 0 } },
        { sha256: secondSHA256, reference: { objectKey: secondObjectKey, size: 1, referenceCount: 1, activeLeaseCount: 0 } },
      ],
      tombstones: [],
    });
    expect(result).toEqual({ _tag: "OwnerVaultBlobRestoreReconstructionFailure", reason: "quota_exceeded" });
  });
});
