import { describe, expect, test } from "bun:test";
import { Effect, Exit, Redacted } from "effect";
import {
  type InternalCapabilityKeyRing,
  OwnerVaultDirectoryControlResource,
  ownerVaultCredentialFencePath,
  ownerVaultPrivateInitializePath,
  ownerVaultRestorePath,
  ownerVaultSnapshotPath,
  signCapabilityHmac,
  signOwnerVaultDirectoryControl,
  verifyOwnerVaultDirectoryControl,
} from "./index";

const ring: InternalCapabilityKeyRing = {
  purpose: "internal-capability",
  current: {
    keyID: "directory-control-current",
    secret: Redacted.make("directory-control-test-secret"),
  },
  prior: [],
};
const digest = "a".repeat(64);
const common = {
  ownerID: "owner-control-0001",
  vaultID: "vault-control-0001",
  generationEpoch: 3,
  operationID: "operation-control-0001",
  jti: "jti-control-00000001",
  method: "POST" as const,
  canonicalQuery: "" as const,
  bodySHA256: digest,
};
const current = { credentialEpoch: 7, routingEpoch: 11, controlEpoch: 13, securityFloor: 2 };
const privateInitialize = {
  ...common,
  ...current,
  resource: OwnerVaultDirectoryControlResource.PrivateInitialize,
  path: ownerVaultPrivateInitializePath,
  initDigest: digest,
  ttlSeconds: 30,
} as const;
const privateExpected = {
  resource: OwnerVaultDirectoryControlResource.PrivateInitialize,
  ownerID: common.ownerID,
  vaultID: common.vaultID,
  generationEpoch: common.generationEpoch,
  operationID: common.operationID,
  ...current,
  initDigest: digest,
} as const;
const base64url = (bytes: Uint8Array): string => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};

describe("OwnerVault DirectoryControl capabilities", () => {
  test("authenticates each fixed POST resource and all resource-specific fields", async () => {
    const privateSigned = await Effect.runPromise(
      signOwnerVaultDirectoryControl(privateInitialize, ring, 100),
    );
    const privateClaims = await Effect.runPromise(
      verifyOwnerVaultDirectoryControl(
        privateSigned,
        privateInitialize,
        privateExpected,
        ring,
        110,
      ),
    );
    expect(privateClaims.resource).toBe(OwnerVaultDirectoryControlResource.PrivateInitialize);

    const fence = {
      ...common,
      resource: OwnerVaultDirectoryControlResource.CredentialFence,
      path: ownerVaultCredentialFencePath,
      expectedCredentialEpoch: 7,
      expectedRoutingEpoch: 11,
      credentialEpoch: 8,
      routingEpoch: 12,
      controlEpoch: 13,
      securityFloor: 2,
      ttlSeconds: 30,
    } as const;
    const fenceExpected = {
      resource: OwnerVaultDirectoryControlResource.CredentialFence,
      ownerID: common.ownerID,
      vaultID: common.vaultID,
      generationEpoch: common.generationEpoch,
      operationID: common.operationID,
      expectedCredentialEpoch: 7,
      expectedRoutingEpoch: 11,
      credentialEpoch: 8,
      routingEpoch: 12,
      controlEpoch: 13,
      securityFloor: 2,
    } as const;
    const fenceSigned = await Effect.runPromise(signOwnerVaultDirectoryControl(fence, ring, 100));
    await Effect.runPromise(
      verifyOwnerVaultDirectoryControl(fenceSigned, fence, fenceExpected, ring, 110),
    );
    const staleSecurity = await Effect.runPromiseExit(
      verifyOwnerVaultDirectoryControl(
        fenceSigned,
        fence,
        { ...fenceExpected, securityFloor: 3 },
        ring,
        110,
      ),
    );
    expect(Exit.isFailure(staleSecurity)).toBe(true);

    const snapshot = {
      ...common,
      ...current,
      resource: OwnerVaultDirectoryControlResource.Snapshot,
      path: ownerVaultSnapshotPath,
      backupID: "backup-control-000001",
      ttlSeconds: 30,
    } as const;
    const snapshotExpected = {
      resource: OwnerVaultDirectoryControlResource.Snapshot,
      ownerID: common.ownerID,
      vaultID: common.vaultID,
      generationEpoch: common.generationEpoch,
      operationID: common.operationID,
      ...current,
      backupID: snapshot.backupID,
    } as const;
    const snapshotSigned = await Effect.runPromise(
      signOwnerVaultDirectoryControl(snapshot, ring, 100),
    );
    await Effect.runPromise(
      verifyOwnerVaultDirectoryControl(snapshotSigned, snapshot, snapshotExpected, ring, 110),
    );

    const restore = {
      ...common,
      ...current,
      resource: OwnerVaultDirectoryControlResource.Restore,
      path: ownerVaultRestorePath,
      restoreID: "restore-control-00001",
      backupID: snapshot.backupID,
      manifestDigest: digest,
      ttlSeconds: 30,
    } as const;
    const restoreExpected = {
      resource: OwnerVaultDirectoryControlResource.Restore,
      ownerID: common.ownerID,
      vaultID: common.vaultID,
      generationEpoch: common.generationEpoch,
      operationID: common.operationID,
      ...current,
      restoreID: restore.restoreID,
      backupID: restore.backupID,
      manifestDigest: restore.manifestDigest,
    } as const;
    const restoreSigned = await Effect.runPromise(
      signOwnerVaultDirectoryControl(restore, ring, 100),
    );
    await Effect.runPromise(
      verifyOwnerVaultDirectoryControl(restoreSigned, restore, restoreExpected, ring, 110),
    );
  });

  test("rejects non-raised fence, substituted path, and unknown claim keys before authorization", async () => {
    const invalidFence = {
      ...common,
      resource: OwnerVaultDirectoryControlResource.CredentialFence,
      path: ownerVaultCredentialFencePath,
      expectedCredentialEpoch: 7,
      expectedRoutingEpoch: 11,
      credentialEpoch: 7,
      routingEpoch: 12,
      controlEpoch: 13,
      securityFloor: 2,
      ttlSeconds: 30,
    } as const;
    const signingExit = await Effect.runPromiseExit(
      signOwnerVaultDirectoryControl(invalidFence, ring, 100),
    );
    expect(Exit.isFailure(signingExit)).toBe(true);

    const signed = await Effect.runPromise(
      signOwnerVaultDirectoryControl(privateInitialize, ring, 100),
    );
    const [, encoded] = signed.value.split(".");
    if (encoded === undefined) throw new Error("test setup invalid");
    const payload = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(
            encoded.replace(/-/gu, "+").replace(/_/gu, "/") +
              "=".repeat((4 - (encoded.length % 4)) % 4),
          ),
          (character) => character.charCodeAt(0),
        ),
      ),
    );
    const altered = JSON.stringify({ ...payload, unexpected: true });
    const alteredEncoded = base64url(new TextEncoder().encode(altered));
    const signature = await Effect.runPromise(
      signCapabilityHmac(ring.current.secret, alteredEncoded),
    );
    const unknown = { value: `ovdc1.${alteredEncoded}.${base64url(signature)}` };
    const exit = await Effect.runPromiseExit(
      verifyOwnerVaultDirectoryControl(unknown, privateInitialize, privateExpected, ring, 110),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
