import { describe, expect, test } from "bun:test";
import { Effect, Exit, Redacted } from "effect";
import { signCapabilityHmac } from "./adapters";
import {
  CapabilityAudience,
  CapabilityAuthority,
  CapabilityMethod,
  makeInternalCapabilityKeyRing,
  signCapability,
  verifyCapability,
} from "./capability";
import {
  type OwnerVaultSocketAdmissionClaimsInput,
  type OwnerVaultSocketAdmissionExpectation,
  type OwnerVaultSocketAdmissionKeyRing,
  type OwnerVaultSocketAdmissionRequestBinding,
  makeOwnerVaultSocketAdmissionKeyRing,
  signOwnerVaultSocketAdmission,
  verifyOwnerVaultSocketAdmission,
} from "./owner-vault-socket-admission";

const input: OwnerVaultSocketAdmissionClaimsInput = {
  ownerID: "owner",
  vaultID: "vault",
  generationEpoch: 2,
  routingEpoch: 3,
  credentialEpoch: 4,
  controlEpoch: 5,
  securityFloor: 6,
  deviceID: "device",
  sessionID: "session",
  operationID: "operation",
  jti: "0123456789abcdef",
  method: "GET",
  canonicalQuery: "",
  upgradeNonce: "nonce",
  bodySHA256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  ttlSeconds: 60,
};
const binding: OwnerVaultSocketAdmissionRequestBinding = {
  method: "GET",
  path: "/__v2/internal/owner-vault/socket",
  canonicalQuery: "",
  bodySHA256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  headerName: "X-Enchiridion-OwnerVault-Socket-Admission",
  headerValue: "",
  ownerID: "owner",
  vaultID: "vault",
  deviceID: "device",
  sessionID: "session",
  operationID: "operation",
  upgradeNonce: "nonce",
};
const expected: OwnerVaultSocketAdmissionExpectation = {
  ownerID: "owner",
  vaultID: "vault",
  generationEpoch: 2,
  routingEpoch: 3,
  credentialEpoch: 4,
  controlEpoch: 5,
  securityFloor: 6,
  deviceID: "device",
  sessionID: "session",
  operationID: "operation",
};
const ring = async (): Promise<OwnerVaultSocketAdmissionKeyRing> =>
  Effect.runPromise(
    makeOwnerVaultSocketAdmissionKeyRing({
      current: {
        keyID: "socket-current",
        secret: Redacted.make("socket-current-secret"),
      },
    }),
  );
const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};
const signedRaw = async (payload: string, keys: OwnerVaultSocketAdmissionKeyRing) => {
  const body = base64url(new TextEncoder().encode(payload));
  const signature = await Effect.runPromise(signCapabilityHmac(keys.current.secret, body));
  return { value: `ovsa1.${body}.${base64url(signature)}` };
};

describe("OwnerVault socket admission", () => {
  test("uses its own token/ring and binds all runtime and durable authority", async () => {
    const keys = await ring();
    const signed = await Effect.runPromise(signOwnerVaultSocketAdmission(input, keys, 1_000));
    const signedBinding = { ...binding, headerValue: signed.value };
    expect(signed.value.startsWith("ovsa1.")).toBe(true);
    await expect(
      Effect.runPromise(
        verifyOwnerVaultSocketAdmission(signed, signedBinding, expected, keys, 1_030),
      ),
    ).resolves.toMatchObject({ ownerID: "owner", securityFloor: 6 });
    for (const changed of [
      { ownerID: "other" },
      { vaultID: "other" },
      { deviceID: "other" },
      { sessionID: "other" },
      { operationID: "other" },
      { generationEpoch: 9 },
      { routingEpoch: 9 },
      { credentialEpoch: 9 },
      { controlEpoch: 9 },
      { securityFloor: 9 },
    ]) {
      const exit = await Effect.runPromiseExit(
        verifyOwnerVaultSocketAdmission(
          signed,
          signedBinding,
          { ...expected, ...changed },
          keys,
          1_030,
        ),
      );
      expect(JSON.stringify(exit)).toContain("binding_mismatch");
    }
    expect(
      JSON.stringify(
        await Effect.runPromiseExit(
          verifyOwnerVaultSocketAdmission(
            signed,
            { ...signedBinding, upgradeNonce: "other" },
            expected,
            keys,
            1_030,
          ),
        ),
      ),
    ).toContain("binding_mismatch");
    expect(
      JSON.stringify(
        await Effect.runPromiseExit(
          verifyOwnerVaultSocketAdmission(signed, signedBinding, expected, keys, 1_060),
        ),
      ),
    ).toContain("expired");
    for (const [key, value] of [
      ["path", "/internal/owner-vault/socket"],
      ["path", "/__v2/internal/owner-vault/other"],
      ["canonicalQuery", "next=1"],
      ["bodySHA256", "a".repeat(64)],
      ["headerName", "Enchiridion-OwnerVault-Socket-Admission"],
      ["headerValue", `${signed.value},${signed.value}`],
      ["headerValue", `${signed.value},other`],
      ["headerValue", `ovsa1.${"a".repeat(4_096)}`],
    ]) {
      if (key === undefined || value === undefined) throw new Error("test setup invalid");
      const hostile = { ...signedBinding };
      Reflect.set(hostile, key, value);
      const exit = await Effect.runPromiseExit(
        verifyOwnerVaultSocketAdmission(signed, hostile, expected, keys, 1_030),
      );
      expect(JSON.stringify(exit)).toContain("binding_mismatch");
    }
    for (const [key, value] of [
      ["canonicalQuery", "next=1"],
      ["bodySHA256", "a".repeat(64)],
    ]) {
      if (key === undefined || value === undefined) throw new Error("test setup invalid");
      const hostile = { ...input };
      Reflect.set(hostile, key, value);
      const exit = await Effect.runPromiseExit(signOwnerVaultSocketAdmission(hostile, keys, 1_000));
      expect(JSON.stringify(exit)).toContain("invalid_claims");
    }
    const payloadPart = signed.value.split(".")[1];
    if (payloadPart === undefined) throw new Error("test setup invalid");
    const payload = new TextDecoder().decode(
      Uint8Array.from(
        atob(
          payloadPart
            .replace(/-/gu, "+")
            .replace(/_/gu, "/")
            .padEnd(Math.ceil(payloadPart.length / 4) * 4, "="),
        ),
        (character) => character.charCodeAt(0),
      ),
    );
    const oldPathPayload = payload.replace(
      '"path":"/__v2/internal/owner-vault/socket"',
      '"path":"/internal/owner-vault/socket"',
    );
    if (oldPathPayload === payload) throw new Error("test setup invalid");
    const oldPath = await signedRaw(oldPathPayload, keys);
    const oldPathExit = await Effect.runPromiseExit(
      verifyOwnerVaultSocketAdmission(
        oldPath,
        { ...signedBinding, headerValue: oldPath.value },
        expected,
        keys,
        1_030,
      ),
    );
    expect(JSON.stringify(oldPathExit)).toContain("claims_invalid");
    const oversizedValue = `ovsa1.${"a".repeat(4_096)}.a`;
    const oversizedExit = await Effect.runPromiseExit(
      verifyOwnerVaultSocketAdmission(
        { value: oversizedValue },
        { ...binding, headerValue: oversizedValue },
        expected,
        keys,
        1_030,
      ),
    );
    expect(JSON.stringify(oversizedExit)).toContain("binding_mismatch");
  });

  test("accepts an exactly configured prior key and rejects malformed or non-UTF8 payloads", async () => {
    const previous = await Effect.runPromise(
      makeOwnerVaultSocketAdmissionKeyRing({
        current: {
          keyID: "socket-prior",
          secret: Redacted.make("socket-prior-secret"),
        },
      }),
    );
    const signed = await Effect.runPromise(signOwnerVaultSocketAdmission(input, previous, 1_000));
    const signedBinding = { ...binding, headerValue: signed.value };
    const rotated = await Effect.runPromise(
      makeOwnerVaultSocketAdmissionKeyRing({
        current: {
          keyID: "socket-current",
          secret: Redacted.make("socket-current-secret"),
        },
        prior: [previous.current],
      }),
    );
    await expect(
      Effect.runPromise(
        verifyOwnerVaultSocketAdmission(signed, signedBinding, expected, rotated, 1_030),
      ),
    ).resolves.toBeDefined();
    const revoked = await Effect.runPromise(
      makeOwnerVaultSocketAdmissionKeyRing({
        current: {
          keyID: "socket-current",
          secret: Redacted.make("socket-current-secret"),
        },
        revokedKeyIDs: ["socket-prior"],
      }),
    );
    const revokedExit = await Effect.runPromiseExit(
      verifyOwnerVaultSocketAdmission(signed, signedBinding, expected, revoked, 1_030),
    );
    expect(JSON.stringify(revokedExit)).toContain("unknown_or_stale_key");
    const foreignGrammar = { value: signed.value.replace("ovsa1.", "v1.") };
    const foreignExit = await Effect.runPromiseExit(
      verifyOwnerVaultSocketAdmission(
        foreignGrammar,
        { ...binding, headerValue: foreignGrammar.value },
        expected,
        rotated,
        1_030,
      ),
    );
    expect(JSON.stringify(foreignExit)).toContain("binding_mismatch");
    const genericRing = await Effect.runPromise(
      makeInternalCapabilityKeyRing({
        current: {
          keyID: "socket-current",
          secret: Redacted.make("socket-current-secret"),
        },
      }),
    );
    const generic = await Effect.runPromise(
      signCapability(
        {
          audience: CapabilityAudience.OwnerVault,
          authority: CapabilityAuthority.OwnerVault,
          ownerID: "owner",
          vaultID: "vault",
          method: CapabilityMethod.GET,
          path: "/__v2/internal/owner-vault/socket",
          canonicalQuery: "",
          bodySHA256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          credentialEpoch: 4,
          generationEpoch: 2,
          jti: "0123456789abcdef",
          ttlSeconds: 60,
        },
        genericRing,
        1_000,
      ),
    );
    const genericRejectsSocket = await Effect.runPromiseExit(
      verifyCapability(
        signed,
        {
          method: CapabilityMethod.GET,
          path: "/__v2/internal/owner-vault/socket",
          canonicalQuery: "",
          bodySHA256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          ownerID: "owner",
          vaultID: "vault",
        },
        {
          audience: CapabilityAudience.OwnerVault,
          authority: CapabilityAuthority.OwnerVault,
          ownerID: "owner",
          vaultID: "vault",
        },
        genericRing,
        1_030,
      ),
    );
    const socketRejectsGeneric = await Effect.runPromiseExit(
      verifyOwnerVaultSocketAdmission(
        generic,
        { ...binding, headerValue: generic.value },
        expected,
        rotated,
        1_030,
      ),
    );
    expect(JSON.stringify(genericRejectsSocket)).toContain("malformed_token");
    expect(JSON.stringify(socketRejectsGeneric)).toContain("binding_mismatch");
    const overlap = await Effect.runPromiseExit(
      makeOwnerVaultSocketAdmissionKeyRing({
        current: {
          keyID: "socket-current",
          secret: Redacted.make("socket-current-secret"),
        },
        revokedKeyIDs: ["socket-current"],
      }),
    );
    expect(JSON.stringify(overlap)).toContain("key_ring_overlap");
    const nonUtf8 = { value: "ovsa1.__8.AA" };
    const exit = await Effect.runPromiseExit(
      verifyOwnerVaultSocketAdmission(
        nonUtf8,
        { ...binding, headerValue: nonUtf8.value },
        expected,
        rotated,
        1_030,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("malformed_token");
  });
});
