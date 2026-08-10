import { describe, expect, test } from "bun:test";
import { Effect, Exit, Redacted } from "effect";
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
  canonicalQuery: "a=b",
  upgradeNonce: "nonce",
  bodySHA256: "a".repeat(64),
  ttlSeconds: 60,
};
const binding: OwnerVaultSocketAdmissionRequestBinding = {
  method: "GET",
  canonicalQuery: "a=b",
  bodySHA256: "a".repeat(64),
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

describe("OwnerVault socket admission", () => {
  test("uses its own token/ring and binds all runtime and durable authority", async () => {
    const keys = await ring();
    const signed = await Effect.runPromise(signOwnerVaultSocketAdmission(input, keys, 1_000));
    expect(signed.value.startsWith("ovsa1.")).toBe(true);
    await expect(
      Effect.runPromise(verifyOwnerVaultSocketAdmission(signed, binding, expected, keys, 1_030)),
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
        verifyOwnerVaultSocketAdmission(signed, binding, { ...expected, ...changed }, keys, 1_030),
      );
      expect(JSON.stringify(exit)).toContain("binding_mismatch");
    }
    expect(
      JSON.stringify(
        await Effect.runPromiseExit(
          verifyOwnerVaultSocketAdmission(
            signed,
            { ...binding, upgradeNonce: "other" },
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
          verifyOwnerVaultSocketAdmission(signed, binding, expected, keys, 1_060),
        ),
      ),
    ).toContain("expired");
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
      Effect.runPromise(verifyOwnerVaultSocketAdmission(signed, binding, expected, rotated, 1_030)),
    ).resolves.toBeDefined();
    const revoked = await Effect.runPromise(
      makeOwnerVaultSocketAdmissionKeyRing({
        current: { keyID: "socket-current", secret: Redacted.make("socket-current-secret") },
        prior: [previous.current],
        revokedKeyIDs: ["socket-prior"],
      }),
    );
    const revokedExit = await Effect.runPromiseExit(
      verifyOwnerVaultSocketAdmission(signed, binding, expected, revoked, 1_030),
    );
    expect(JSON.stringify(revokedExit)).toContain("unknown_or_stale_key");
    const foreignGrammar = { value: signed.value.replace("ovsa1.", "v1.") };
    const foreignExit = await Effect.runPromiseExit(
      verifyOwnerVaultSocketAdmission(foreignGrammar, binding, expected, rotated, 1_030),
    );
    expect(JSON.stringify(foreignExit)).toContain("malformed_token");
    const nonUtf8 = { value: "ovsa1.__8.AA" };
    const exit = await Effect.runPromiseExit(
      verifyOwnerVaultSocketAdmission(nonUtf8, binding, expected, rotated, 1_030),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("malformed_token");
  });
});
