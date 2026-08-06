import { describe, expect, test } from "bun:test";
import { Effect, Exit, Redacted } from "effect";
import {
  CapabilityAudience,
  CapabilityAuthority,
  type CapabilityKeyMaterial,
  CapabilityMethod,
  CapabilityVerificationError,
  makeCapabilityKeyMaterial,
  makeCapabilitySigner,
  makeCapabilityVerifier,
  makeWorkerBoundary,
  maximumCapabilityTTLSeconds,
  signCapability,
  signCapabilityHmac,
  verifyCapability,
} from "./index";

const key: CapabilityKeyMaterial = {
  keyID: "internal-key-1",
  secret: Redacted.make("capability-test-secret"),
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
    const signer = makeCapabilitySigner(key);
    const verifier = makeCapabilityVerifier(key);
    const signed = await Effect.runPromise(signer.sign(input, 1_000));
    const verified = await Effect.runPromise(verifier.verify(signed, binding, expectation, 1_030));
    expect(verified.credentialEpoch).toBe(4);
    expect(verified.generationEpoch).toBe(9);
    expect(verified.jti).toBe(input.jti);
    expect(JSON.stringify(signed)).not.toContain("capability-test-secret");
  });

  test("rejects tampering, request/identity mismatch, audience mismatch, and expiry", async () => {
    const signed = await Effect.runPromise(signCapability(input, key, 1_000));
    const tampered = { value: `${signed.value.slice(0, -1)}x` };
    const tamperedExit = await Effect.runPromiseExit(
      verifyCapability(tampered, binding, expectation, key, 1_030),
    );
    const mismatchExit = await Effect.runPromiseExit(
      verifyCapability(
        signed,
        { ...binding, path: "/v1/owner-vault/other" },
        expectation,
        key,
        1_030,
      ),
    );
    const queryExit = await Effect.runPromiseExit(
      verifyCapability(
        signed,
        { ...binding, canonicalQuery: "backup=incremental&region=eu" },
        expectation,
        key,
        1_030,
      ),
    );
    const ownerExit = await Effect.runPromiseExit(
      verifyCapability(signed, { ...binding, ownerID: "owner-2" }, expectation, key, 1_030),
    );
    const vaultExit = await Effect.runPromiseExit(
      verifyCapability(signed, binding, { ...expectation, vaultID: "vault-2" }, key, 1_030),
    );
    const audienceExit = await Effect.runPromiseExit(
      verifyCapability(
        signed,
        binding,
        { audience: CapabilityAudience.Directory, authority: CapabilityAuthority.Directory },
        key,
        1_030,
      ),
    );
    const expiredExit = await Effect.runPromiseExit(
      verifyCapability(signed, binding, expectation, key, 1_060),
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
      signCapability({ ...input, ttlSeconds: maximumCapabilityTTLSeconds + 1 }, key, 1_000),
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
      const exit = await Effect.runPromiseExit(signCapability({ ...input, path }, key, 1_000));
      expect(Exit.isFailure(exit)).toBe(true);
    }
    for (const canonicalQuery of invalidQueries) {
      const exit = await Effect.runPromiseExit(
        signCapability({ ...input, canonicalQuery }, key, 1_000),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }
  });

  test("rejects non-safe verification timestamps before authorization", async () => {
    const signed = await Effect.runPromise(signCapability(input, key, 1_000));
    for (const nowSeconds of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const exit = await Effect.runPromiseExit(
        verifyCapability(signed, binding, expectation, key, nowSeconds),
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
        verifyCapability(signed, binding, expectation, key, 1_030),
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
