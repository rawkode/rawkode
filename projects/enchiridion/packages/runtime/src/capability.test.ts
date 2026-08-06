import { describe, expect, test } from "bun:test";
import { Effect, Exit, Redacted } from "effect";
import {
  CapabilityAudience,
  CapabilityAuthority,
  type CapabilityKeyMaterial,
  CapabilityMethod,
  CapabilityVerificationError,
  type CredentialBindingKeyRing,
  type InternalCapabilityKeyRing,
  makeCapabilityKeyMaterial,
  makeCapabilitySigner,
  makeCapabilityVerifier,
  makeCredentialBindingKeyRing,
  makeInternalCapabilityKeyRing,
  makeWorkerBoundary,
  maximumCapabilityTTLSeconds,
  maximumPriorCapabilityKeys,
  signCapability,
  signCapabilityHmac,
  validateDistinctKeyRings,
  verifyCapability,
} from "./index";

const key: CapabilityKeyMaterial = {
  keyID: "internal-key-1",
  secret: Redacted.make("capability-test-secret"),
};

const keyRing: InternalCapabilityKeyRing = {
  purpose: "internal-capability",
  current: key,
  prior: [],
};

const binding = {
  method: CapabilityMethod.POST,
  path: "/v1/owner-vault/restore",
  canonicalQuery: "backup=full&region=eu",
  bodySHA256: "a".repeat(64),
  ownerID: "owner-1",
  vaultID: "vault-1",
} as const;

const input = {
  ...binding,
  audience: CapabilityAudience.OwnerVault,
  authority: CapabilityAuthority.OwnerVault,
  credentialEpoch: 4,
  generationEpoch: 9,
  jti: "capability-jti-0001",
  ttlSeconds: 60,
} as const;

const expectation = {
  audience: CapabilityAudience.OwnerVault,
  authority: CapabilityAuthority.OwnerVault,
  ownerID: binding.ownerID,
  vaultID: binding.vaultID,
} as const;

const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};

const signedRawPayload = async (payload: string): Promise<{ readonly value: string }> => {
  const encodedPayload = base64url(new TextEncoder().encode(payload));
  const signature = await Effect.runPromise(signCapabilityHmac(key.secret, encodedPayload));
  return { value: `v1.${encodedPayload}.${base64url(signature)}` };
};

describe("internal capabilities", () => {
  test("signs and verifies a request-bound OwnerVault capability", async () => {
    const signer = makeCapabilitySigner(keyRing);
    const verifier = makeCapabilityVerifier(keyRing);
    const signed = await Effect.runPromise(signer.sign(input, 1_000));
    const verified = await Effect.runPromise(verifier.verify(signed, binding, expectation, 1_030));
    expect(verified.credentialEpoch).toBe(4);
    expect(verified.generationEpoch).toBe(9);
    expect(verified.jti).toBe(input.jti);
    expect(JSON.stringify(signed)).not.toContain("capability-test-secret");
  });

  test("signs only with the current key and verifies an exact bounded prior key", async () => {
    const prior: CapabilityKeyMaterial = {
      keyID: "internal-key-0",
      secret: Redacted.make("capability-prior-secret"),
    };
    const rotated = await Effect.runPromise(
      makeInternalCapabilityKeyRing({ current: key, prior: [prior] }),
    );
    const currentSigned = await Effect.runPromise(signCapability(input, rotated, 1_000));
    const currentClaims = await Effect.runPromise(
      verifyCapability(currentSigned, binding, expectation, rotated, 1_030),
    );
    expect(currentClaims.keyID).toBe(key.keyID);

    const staleSigned = await Effect.runPromise(
      signCapability(input, { purpose: "internal-capability", current: prior, prior: [] }, 1_000),
    );
    const priorClaims = await Effect.runPromise(
      verifyCapability(staleSigned, binding, expectation, rotated, 1_030),
    );
    expect(priorClaims.keyID).toBe(prior.keyID);

    const noLongerTrusted = await Effect.runPromiseExit(
      verifyCapability(staleSigned, binding, expectation, keyRing, 1_030),
    );
    expect(Exit.isFailure(noLongerTrusted)).toBe(true);
    expect(JSON.stringify(noLongerTrusted)).toContain("unknown_or_stale_key");
  });

  test("validates bounded, distinct Redacted credential and internal key rings", async () => {
    const credentialBinding: CredentialBindingKeyRing = await Effect.runPromise(
      makeCredentialBindingKeyRing({
        current: {
          keyID: "credential-key-1",
          secret: Redacted.make("credential-binding-secret"),
        },
      }),
    );
    const internalCapability = await Effect.runPromise(
      makeInternalCapabilityKeyRing({ current: key }),
    );
    await Effect.runPromise(validateDistinctKeyRings(credentialBinding, internalCapability));
    expect(JSON.stringify(credentialBinding)).not.toContain("credential-binding-secret");

    const overlap = await Effect.runPromiseExit(
      validateDistinctKeyRings(
        credentialBinding,
        await Effect.runPromise(
          makeInternalCapabilityKeyRing({
            current: {
              keyID: "internal-key-other",
              secret: Redacted.make("credential-binding-secret"),
            },
          }),
        ),
      ),
    );
    expect(Exit.isFailure(overlap)).toBe(true);
    expect(JSON.stringify(overlap)).not.toContain("credential-binding-secret");

    const tooManyPrior = await Effect.runPromiseExit(
      makeInternalCapabilityKeyRing({
        current: key,
        prior: Array.from({ length: maximumPriorCapabilityKeys + 1 }, (_, index) => ({
          keyID: `prior-key-${index}`,
          secret: Redacted.make(`prior-secret-${index}`),
        })),
      }),
    );
    expect(Exit.isFailure(tooManyPrior)).toBe(true);
  });

  test("rejects tampering, request/identity mismatch, audience mismatch, and expiry", async () => {
    const signed = await Effect.runPromise(signCapability(input, keyRing, 1_000));
    const tampered = { value: `${signed.value.slice(0, -1)}x` };
    const tamperedExit = await Effect.runPromiseExit(
      verifyCapability(tampered, binding, expectation, keyRing, 1_030),
    );
    const mismatchExit = await Effect.runPromiseExit(
      verifyCapability(
        signed,
        { ...binding, path: "/v1/owner-vault/other" },
        expectation,
        keyRing,
        1_030,
      ),
    );
    const queryExit = await Effect.runPromiseExit(
      verifyCapability(
        signed,
        { ...binding, canonicalQuery: "backup=incremental&region=eu" },
        expectation,
        keyRing,
        1_030,
      ),
    );
    const ownerExit = await Effect.runPromiseExit(
      verifyCapability(signed, { ...binding, ownerID: "owner-2" }, expectation, keyRing, 1_030),
    );
    const vaultExit = await Effect.runPromiseExit(
      verifyCapability(signed, binding, { ...expectation, vaultID: "vault-2" }, keyRing, 1_030),
    );
    const audienceExit = await Effect.runPromiseExit(
      verifyCapability(
        signed,
        binding,
        { audience: CapabilityAudience.Directory, authority: CapabilityAuthority.Directory },
        keyRing,
        1_030,
      ),
    );
    const expiredExit = await Effect.runPromiseExit(
      verifyCapability(signed, binding, expectation, keyRing, 1_060),
    );
    for (const exit of [
      tamperedExit,
      mismatchExit,
      queryExit,
      ownerExit,
      vaultExit,
      audienceExit,
      expiredExit,
    ]) {
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain(CapabilityVerificationError.name);
    }
  });

  test("rejects TTLs above the approved 60-second capability limit", async () => {
    const exit = await Effect.runPromiseExit(
      signCapability({ ...input, ttlSeconds: maximumCapabilityTTLSeconds + 1 }, keyRing, 1_000),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("rejects every noncanonical path and query binding spelling", async () => {
    const invalidPaths = [
      "v1/owner-vault/restore",
      "/v1//owner-vault/restore",
      "/v1/./owner-vault",
      "/v1/../owner-vault",
      "/v1/%2E/owner-vault",
      "/v1/%7E/owner-vault",
      "/v1/%2f/owner-vault",
      "/v1/%2F/owner-vault",
    ];
    const invalidQueries = [
      "backup=full&backup=incremental",
      "backup+mode=full",
      "backup=%2f",
      "backup=%7E",
      "region=eu&backup=full",
    ];
    for (const path of invalidPaths) {
      const exit = await Effect.runPromiseExit(signCapability({ ...input, path }, keyRing, 1_000));
      expect(Exit.isFailure(exit)).toBe(true);
    }
    for (const canonicalQuery of invalidQueries) {
      const exit = await Effect.runPromiseExit(
        signCapability({ ...input, canonicalQuery }, keyRing, 1_000),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }
  });

  test("rejects non-safe verification timestamps before authorization", async () => {
    const signed = await Effect.runPromise(signCapability(input, keyRing, 1_000));
    for (const nowSeconds of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const exit = await Effect.runPromiseExit(
        verifyCapability(signed, binding, expectation, keyRing, nowSeconds),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain(CapabilityVerificationError.name);
    }
  });

  test("rejects signed payloads with noncanonical order or extra claims", async () => {
    const noncanonical = await signedRawPayload(
      '{"version":1,"aud":"OwnerVault","authority":"OwnerVault","bodySHA256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","canonicalQuery":"backup=full&region=eu","credentialEpoch":4,"expiresAt":1060,"generationEpoch":9,"issuedAt":1000,"jti":"capability-jti-0001","keyID":"internal-key-1","method":"POST","ownerID":"owner-1","path":"/v1/owner-vault/restore","vaultID":"vault-1"}',
    );
    const extraClaim = await signedRawPayload(
      '{"aud":"OwnerVault","authority":"OwnerVault","bodySHA256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","canonicalQuery":"backup=full&region=eu","credentialEpoch":4,"expiresAt":1060,"generationEpoch":9,"issuedAt":1000,"jti":"capability-jti-0001","keyID":"internal-key-1","method":"POST","ownerID":"owner-1","path":"/v1/owner-vault/restore","vaultID":"vault-1","version":1,"extra":true}',
    );
    for (const signed of [noncanonical, extraClaim]) {
      const exit = await Effect.runPromiseExit(
        verifyCapability(signed, binding, expectation, keyRing, 1_030),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain(CapabilityVerificationError.name);
    }
  });

  test("rejects invalid Redacted key input without retaining its value", async () => {
    const exit = await Effect.runPromiseExit(
      makeCapabilityKeyMaterial({
        keyID: "bad key id",
        secret: Redacted.make("sensitive-invalid-secret"),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).not.toContain("sensitive-invalid-secret");
  });

  test("converts the one Effect worker handler into a safe Promise Response boundary", async () => {
    const boundary = makeWorkerBoundary(() => Effect.succeed(new Response("ok", { status: 200 })));
    const response = await boundary.handle(new Request("https://worker.test/v1"), {}, {});
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  test("worker boundary replaces an Effect failure with a fixed safe response", async () => {
    const boundary = makeWorkerBoundary(() => Effect.die("sensitive worker failure"));
    const response = await boundary.handle(new Request("https://worker.test/v1"), {}, {});
    expect(response.status).toBe(500);
    expect(response.statusText).toBe("Internal Server Error");
    expect(await response.text()).not.toContain("sensitive worker failure");
  });
});
