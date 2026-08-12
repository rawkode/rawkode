/** @enchiridion/effect-module */
/**
 * The OwnerVault production provider graph.  This is intentionally a small
 * composition-only module: it grants no transport authority and every
 * mutable provider below shares the one DO storage repository.
 */
import {
  makeBlobR2Boundary,
  makeImmutableR2Boundary,
  makeManifestSigner,
  makeManifestVerifier,
} from "@enchiridion/runtime";
import { Effect } from "effect";
import { makeOwnerVaultBlobStagingRepository } from "../blobs/owner-vault-blob-repository";
import {
  type OwnerVaultProductionAuthority,
  ownerVaultProductionLimitsMatchEnforcement,
} from "../entry/owner-vault-production";
import { ownerID, vaultID } from "../foundation/schemas";
import { makeOwnerVaultPrivateStorageRestoreTarget } from "./backup";
import { OwnerVaultBackupError, type OwnerVaultBackupRuntime } from "./backup-types";
import { makeOwnerVaultDomainProvider } from "./domains";
import type { OwnerVaultStorageRepository } from "./repository";
import { makeOwnerVaultSnapshotPinController } from "./snapshot-pin";
import type { OwnerVaultTargetRoot } from "./storage-registry";

export interface OwnerVaultProviderGraph {
  readonly domains: ReturnType<typeof makeOwnerVaultDomainProvider>;
  readonly blobs: ReturnType<typeof makeOwnerVaultBlobStagingRepository>;
  readonly snapshots: ReturnType<typeof makeOwnerVaultSnapshotPinController>;
  readonly backupRuntime: () => Effect.Effect<OwnerVaultBackupRuntime, OwnerVaultBackupError>;
  readonly privateRestoreTarget: (
    assertFreshPrivateTarget: () => Effect.Effect<void, OwnerVaultBackupError>,
  ) => ReturnType<typeof makeOwnerVaultPrivateStorageRestoreTarget>;
}

/**
 * Creates the concrete P02/P03/C2/C4 providers after the fixed target root
 * has been authenticated.  A malformed root or an authority mismatch fails
 * before any provider can perform a durable or R2 operation.
 */
export const makeOwnerVaultProviderGraph = (
  repository: OwnerVaultStorageRepository,
  root: OwnerVaultTargetRoot,
  production: OwnerVaultProductionAuthority,
): OwnerVaultProviderGraph | undefined => {
  const owner = ownerID(root.ownerID);
  const vault = vaultID(root.vaultID);
  if (
    owner === undefined ||
    vault === undefined ||
    !Number.isSafeInteger(root.generationEpoch) ||
    root.generationEpoch < 1 ||
    /** A production authority whose limits diverge from the compiled
     * enforcement caps grants no provider and performs no storage/R2 work. */
    !ownerVaultProductionLimitsMatchEnforcement(production.limits)
  )
    return undefined;
  const scope = { ownerID: owner, vaultID: vault, generationEpoch: root.generationEpoch } as const;
  const blobLimits = production.limits.blob;
  const blobs = makeOwnerVaultBlobStagingRepository({
    storage: repository,
    r2: makeBlobR2Boundary(production.blobR2.native, {
      maximumKeyBytes: production.limits.r2.maximumKeyBytes,
      maximumObjectBytes: production.limits.r2.maximumObjectBytes,
    }),
    scope,
    limits: blobLimits,
    deleteGraceSeconds: blobLimits.tombstoneGraceSeconds,
  });
  const backupRuntime = (): Effect.Effect<OwnerVaultBackupRuntime, OwnerVaultBackupError> =>
    production.manifestKeys().pipe(
      Effect.map((keys) => ({
        r2: makeImmutableR2Boundary(production.backupR2.native, production.limits.r2),
        signer: makeManifestSigner(keys),
        verifier: makeManifestVerifier(keys),
      })),
      Effect.mapError(() => new OwnerVaultBackupError({ reason: "source_unavailable" })),
    );
  return Object.freeze({
    domains: makeOwnerVaultDomainProvider(repository, root),
    blobs,
    snapshots: makeOwnerVaultSnapshotPinController(repository),
    backupRuntime,
    privateRestoreTarget: (
      assertFreshPrivateTarget: () => Effect.Effect<void, OwnerVaultBackupError>,
    ) =>
      makeOwnerVaultPrivateStorageRestoreTarget({
        repository,
        root,
        assertFreshPrivateTarget,
        blobScope: scope,
        blobLimits,
      }),
  });
};
