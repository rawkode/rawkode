import { describe, expect, test } from "bun:test";
import { Effect, Exit, Redacted } from "effect";
import {
  CapabilityAudience,
  CapabilityAuthority,
  type CapabilityKeyMaterial,
  CapabilityMethod,
  type InternalCapabilityKeyRing,
  OwnerVaultDirectoryControlResource,
  makeOwnerVaultDirectoryControlKeyRing,
  ownerVaultCredentialFencePath,
  ownerVaultPrivateInitializePath,
  ownerVaultRestorePath,
  ownerVaultSnapshotPath,
  signCapability,
  signCapabilityHmac,
  signOwnerVaultDirectoryControl,
  verifyCapability,
  verifyOwnerVaultDirectoryControl,
} from "./index";
import type {
  OwnerVaultCredentialFenceBinding,
  OwnerVaultPrivateInitializeBinding,
  OwnerVaultRestoreBinding,
  OwnerVaultSnapshotBinding,
} from "./owner-vault-directory-control";

const key: CapabilityKeyMaterial = {
  keyID: "owner-vault-control-current",
  secret: Redacted.make("owner-vault-control-current-secret"),
};
const previous: CapabilityKeyMaterial = {
  keyID: "owner-vault-control-prior",
  secret: Redacted.make("owner-vault-control-prior-secret"),
};
const rotated: CapabilityKeyMaterial = {
  keyID: "owner-vault-control-rotated",
  secret: Redacted.make("owner-vault-control-rotated-secret"),
};
const sha = "a".repeat(64);
const base = {
  ownerID: "owner-control-0001",
  vaultID: "vault-control-0001",
  generationEpoch: 7,
  routingEpoch: 11,
  credentialEpoch: 13,
  controlEpoch: 17,
  securityFloor: 19,
  operationID: "operation-control-0001",
  jti: "jti-control-00000001",
  method: "POST" as const,
  canonicalQuery: "" as const,
  bodySHA256: sha,
};
const privateInitialize: OwnerVaultPrivateInitializeBinding = {
  ...base,
  resource: OwnerVaultDirectoryControlResource.PrivateInitialize,
  path: ownerVaultPrivateInitializePath,
  sourceGeneration: 5,
  targetGeneration: 7,
  allocationID: "allocation-control-001",
  initID: "init-control-00000001",
  backupID: "backup-control-000001",
  manifestDigest: sha,
};
const fence: OwnerVaultCredentialFenceBinding = {
  ...base,
  resource: OwnerVaultDirectoryControlResource.CredentialFence,
  path: ownerVaultCredentialFencePath,
  expectedCredentialEpoch: 12,
  expectedRoutingEpoch: 10,
  expectedControlEpoch: 17,
  expectedSecurityFloor: 19,
  raisedCredentialEpoch: 13,
  raisedRoutingEpoch: 11,
};
const snapshot: OwnerVaultSnapshotBinding = {
  ...base,
  resource: OwnerVaultDirectoryControlResource.Snapshot,
  path: ownerVaultSnapshotPath,
  backupID: "backup-control-000001",
  sourceGeneration: 5,
  sourceRoutingEpoch: 9,
  sourceCredentialEpoch: 8,
  sourceControlEpoch: 7,
  sourceSecurityFloor: 6,
};
const restore: OwnerVaultRestoreBinding = {
  ...base,
  resource: OwnerVaultDirectoryControlResource.Restore,
  path: ownerVaultRestorePath,
  allocationID: "allocation-control-001",
  initID: "init-control-00000001",
  sourceGeneration: 5,
  targetGeneration: 7,
  backupID: "backup-control-000001",
  manifestDigest: sha,
};
const encoded = (bytes: Uint8Array): string => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};
const signedRaw = async (payload: string | Uint8Array, material = key) => {
  const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const body = encoded(bytes);
  const signature = await Effect.runPromise(signCapabilityHmac(material.secret, body));
  return { value: `ovdc1.${body}.${encoded(signature)}` };
};
const ring = async () => Effect.runPromise(makeOwnerVaultDirectoryControlKeyRing({ current: key }));
const signed = (
  binding:
    | OwnerVaultPrivateInitializeBinding
    | OwnerVaultCredentialFenceBinding
    | OwnerVaultSnapshotBinding
    | OwnerVaultRestoreBinding,
  keys: Awaited<ReturnType<typeof ring>>,
) => signOwnerVaultDirectoryControl({ ...binding, ttlSeconds: 30 }, keys, 100);

describe("OwnerVault DirectoryControl capability", () => {
  test("binds the complete approved tuple for every fixed POST resource", async () => {
    const keys = await ring();
    for (const binding of [privateInitialize, fence, snapshot, restore] as const) {
      const token = await Effect.runPromise(signed(binding, keys));
      const claims = await Effect.runPromise(
        verifyOwnerVaultDirectoryControl(token, binding, binding, keys, 110),
      );
      expect(claims.resource).toBe(binding.resource);
    }
  });

  test("requires allocation/source-target and exact fence raise/security invariants", async () => {
    const keys = await ring();
    const badTarget = await Effect.runPromiseExit(
      signed({ ...privateInitialize, generationEpoch: 6 }, keys),
    );
    const unchangedFence = await Effect.runPromiseExit(
      signed({ ...fence, raisedCredentialEpoch: 12, credentialEpoch: 12 }, keys),
    );
    const overflowFence = await Effect.runPromiseExit(
      signed(
        {
          ...fence,
          expectedCredentialEpoch: Number.MAX_SAFE_INTEGER,
          raisedCredentialEpoch: Number.MAX_SAFE_INTEGER,
          credentialEpoch: Number.MAX_SAFE_INTEGER,
        },
        keys,
      ),
    );
    expect(Exit.isFailure(badTarget)).toBe(true);
    expect(Exit.isFailure(unchangedFence)).toBe(true);
    expect(Exit.isFailure(overflowFence)).toBe(true);
    const token = await Effect.runPromise(signed(fence, keys));
    const staleControl = await Effect.runPromiseExit(
      verifyOwnerVaultDirectoryControl(
        token,
        fence,
        { ...fence, expectedControlEpoch: 18, controlEpoch: 18 },
        keys,
        110,
      ),
    );
    expect(Exit.isFailure(staleControl)).toBe(true);
  });

  test("rejects substitutions across every common and resource-owned authority field", async () => {
    const keys = await ring();
    const privateToken = await Effect.runPromise(signed(privateInitialize, keys));
    const privateMutations = [
      { ...privateInitialize, ownerID: "owner-control-0002" },
      { ...privateInitialize, vaultID: "vault-control-0002" },
      { ...privateInitialize, generationEpoch: 8, targetGeneration: 8 },
      { ...privateInitialize, routingEpoch: 12 },
      { ...privateInitialize, credentialEpoch: 14 },
      { ...privateInitialize, controlEpoch: 18 },
      { ...privateInitialize, securityFloor: 20 },
      { ...privateInitialize, operationID: "operation-control-0002" },
      { ...privateInitialize, jti: "jti-control-00000002" },
      { ...privateInitialize, bodySHA256: "b".repeat(64) },
      { ...privateInitialize, sourceGeneration: 6 },
      { ...privateInitialize, allocationID: "allocation-control-002" },
      { ...privateInitialize, initID: "init-control-00000002" },
      { ...privateInitialize, backupID: "backup-control-000002" },
      { ...privateInitialize, manifestDigest: "b".repeat(64) },
    ];
    for (const expected of privateMutations) {
      const exit = await Effect.runPromiseExit(
        verifyOwnerVaultDirectoryControl(privateToken, privateInitialize, expected, keys, 110),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }
    const snapshotToken = await Effect.runPromise(signed(snapshot, keys));
    for (const expected of [
      { ...snapshot, sourceGeneration: 6 },
      { ...snapshot, sourceRoutingEpoch: 10 },
      { ...snapshot, sourceCredentialEpoch: 9 },
      { ...snapshot, sourceControlEpoch: 8 },
      { ...snapshot, sourceSecurityFloor: 7 },
    ]) {
      const exit = await Effect.runPromiseExit(
        verifyOwnerVaultDirectoryControl(snapshotToken, snapshot, expected, keys, 110),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }
    const restoreToken = await Effect.runPromise(signed(restore, keys));
    for (const expected of [
      { ...restore, sourceGeneration: 6 },
      { ...restore, allocationID: "allocation-control-002" },
      { ...restore, initID: "init-control-00000002" },
      { ...restore, backupID: "backup-control-000002" },
      { ...restore, manifestDigest: "b".repeat(64) },
    ]) {
      const exit = await Effect.runPromiseExit(
        verifyOwnerVaultDirectoryControl(restoreToken, restore, expected, keys, 110),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }
  });

  test("rejects unknown, duplicate, noncanonical, non-UTF8, wrong-path and expired claims", async () => {
    const keys = await ring();
    const token = await Effect.runPromise(signed(privateInitialize, keys));
    const payload = token.value.split(".")[1];
    if (payload === undefined) throw new Error("test setup invalid");
    const text = new TextDecoder().decode(
      Uint8Array.from(
        atob(
          payload.replace(/-/gu, "+").replace(/_/gu, "/") +
            "=".repeat((4 - (payload.length % 4)) % 4),
        ),
        (character) => character.charCodeAt(0),
      ),
    );
    const extra = await signedRaw(`${text.slice(0, -1)},"extra":true}`);
    const duplicate = await signedRaw(`${text.slice(0, -1)},"resource":"private-initialize"}`);
    const reordered = await signedRaw(
      JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(text)).reverse())),
    );
    const wrongPath = await signedRaw(
      text.replace(ownerVaultPrivateInitializePath, ownerVaultSnapshotPath),
    );
    const wrongMethod = await signedRaw(text.replace('"method":"POST"', '"method":"GET"'));
    const wrongQuery = await signedRaw(
      text.replace('"canonicalQuery":""', '"canonicalQuery":"x=y"'),
    );
    const nonUTF8 = await signedRaw(new Uint8Array([0xff, 0xfe, 0xfd]));
    for (const candidate of [
      extra,
      duplicate,
      reordered,
      wrongPath,
      wrongMethod,
      wrongQuery,
      nonUTF8,
    ]) {
      const exit = await Effect.runPromiseExit(
        verifyOwnerVaultDirectoryControl(
          candidate,
          privateInitialize,
          privateInitialize,
          keys,
          110,
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }
    const expired = await Effect.runPromiseExit(
      verifyOwnerVaultDirectoryControl(token, privateInitialize, privateInitialize, keys, 130),
    );
    expect(Exit.isFailure(expired)).toBe(true);
    const ttl = await Effect.runPromiseExit(
      signOwnerVaultDirectoryControl({ ...privateInitialize, ttlSeconds: 61 }, keys, 100),
    );
    expect(Exit.isFailure(ttl)).toBe(true);
  });

  test("uses a dedicated current/prior/revoked ring and never accepts generic v1 framing", async () => {
    const active = await Effect.runPromise(
      makeOwnerVaultDirectoryControlKeyRing({ current: key, prior: [previous] }),
    );
    const prior = await Effect.runPromise(
      makeOwnerVaultDirectoryControlKeyRing({ current: previous }),
    );
    const priorToken = await Effect.runPromise(signed(privateInitialize, prior));
    await Effect.runPromise(
      verifyOwnerVaultDirectoryControl(
        priorToken,
        privateInitialize,
        privateInitialize,
        active,
        110,
      ),
    );
    const revoked = await Effect.runPromise(
      makeOwnerVaultDirectoryControlKeyRing({ current: rotated, revokedKeyIDs: [previous.keyID] }),
    );
    const revokedExit = await Effect.runPromiseExit(
      verifyOwnerVaultDirectoryControl(
        priorToken,
        privateInitialize,
        privateInitialize,
        revoked,
        110,
      ),
    );
    const legacyExit = await Effect.runPromiseExit(
      verifyOwnerVaultDirectoryControl(
        { value: priorToken.value.replace("ovdc1.", "v1.") },
        privateInitialize,
        privateInitialize,
        active,
        110,
      ),
    );
    const overlap = await Effect.runPromiseExit(
      makeOwnerVaultDirectoryControlKeyRing({ current: key, revokedKeyIDs: [key.keyID] }),
    );
    const genericRing: InternalCapabilityKeyRing = {
      purpose: "internal-capability",
      current: key,
      prior: [],
    };
    const generic = await Effect.runPromise(
      signCapability(
        {
          audience: CapabilityAudience.OwnerVault,
          authority: CapabilityAuthority.OwnerVault,
          method: CapabilityMethod.POST,
          path: ownerVaultPrivateInitializePath,
          canonicalQuery: "",
          bodySHA256: sha,
          ownerID: privateInitialize.ownerID,
          vaultID: privateInitialize.vaultID,
          credentialEpoch: privateInitialize.credentialEpoch,
          generationEpoch: privateInitialize.generationEpoch,
          jti: privateInitialize.jti,
          ttlSeconds: 30,
        },
        genericRing,
        100,
      ),
    );
    const genericToOvd = await Effect.runPromiseExit(
      verifyOwnerVaultDirectoryControl(generic, privateInitialize, privateInitialize, active, 110),
    );
    const ovdcToGeneric = await Effect.runPromiseExit(
      verifyCapability(
        priorToken,
        {
          method: CapabilityMethod.POST,
          path: ownerVaultPrivateInitializePath,
          canonicalQuery: "",
          bodySHA256: sha,
          ownerID: privateInitialize.ownerID,
          vaultID: privateInitialize.vaultID,
        },
        {
          audience: CapabilityAudience.OwnerVault,
          authority: CapabilityAuthority.OwnerVault,
          ownerID: privateInitialize.ownerID,
          vaultID: privateInitialize.vaultID,
        },
        genericRing,
        110,
      ),
    );
    expect(Exit.isFailure(revokedExit)).toBe(true);
    expect(Exit.isFailure(legacyExit)).toBe(true);
    expect(Exit.isFailure(overlap)).toBe(true);
    expect(Exit.isFailure(genericToOvd)).toBe(true);
    expect(Exit.isFailure(ovdcToGeneric)).toBe(true);
    expect(JSON.stringify(active)).not.toContain("owner-vault-control-current-secret");
  });
});
