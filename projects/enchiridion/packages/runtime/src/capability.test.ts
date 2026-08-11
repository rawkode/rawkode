import { describe, expect, test } from "bun:test";
import { Effect, Exit, Redacted } from "effect";
import {
  CapabilityAudience,
  CapabilityAuthority,
  type CapabilityKeyMaterial,
  CapabilityMethod,
  CapabilityVerificationError,
  type CredentialBindingKeyRing,
  DirectoryControlCapabilityAudience,
  DirectoryControlCapabilityAuthority,
  DirectoryControlResource,
  type InternalCapabilityKeyRing,
  makeCapabilityKeyMaterial,
  makeCapabilitySigner,
  makeCapabilityVerifier,
  makeCredentialBindingKeyRing,
  makeDirectoryControlCapabilitySigner,
  makeDirectoryControlCapabilityVerifier,
  makeInternalCapabilityKeyRing,
  makeWorkerBoundary,
  maximumCapabilityTTLSeconds,
  maximumPriorCapabilityKeys,
  signCapability,
  signCapabilityHmac,
  signDirectoryControlCapability,
  validateDistinctKeyRings,
  verifyCapability,
  verifyDirectoryControlCapability,
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

const directoryControlBinding = {
  method: CapabilityMethod.POST,
  path: "/v2/directory/credential-transition",
  canonicalQuery: "resume=false",
  bodySHA256: "b".repeat(64),
  ownerID: "owner-1",
  vaultID: "vault-1",
  resource: DirectoryControlResource.CredentialTransition,
} as const;

const directoryControlInput = {
  ...directoryControlBinding,
  audience: DirectoryControlCapabilityAudience.DirectoryControl,
  authority: DirectoryControlCapabilityAuthority.DirectoryControl,
  credentialEpoch: 4,
  generationEpoch: 9,
  routingEpoch: 12,
  jti: "directory-control-jti-0001",
  operationID: "credential-transition-0001",
  ttlSeconds: 60,
} as const;

const directoryControlExpectation = {
  audience: DirectoryControlCapabilityAudience.DirectoryControl,
  authority: DirectoryControlCapabilityAuthority.DirectoryControl,
  ownerID: directoryControlBinding.ownerID,
  vaultID: directoryControlBinding.vaultID,
  resource: DirectoryControlResource.CredentialTransition,
  credentialEpoch: 4,
  generationEpoch: 9,
  routingEpoch: 12,
  operationID: "credential-transition-0001",
} as const;

const ownerVaultInitializationBinding = {
  method: CapabilityMethod.POST,
  path: "/__v2/internal/owner-vault/initialize",
  canonicalQuery: "",
  bodySHA256: "c".repeat(64),
  ownerID: "owner-1",
  vaultID: "vault-1",
  resource: DirectoryControlResource.OwnerVaultInitialization,
  initDigest: "d".repeat(64),
  controlEpoch: 15,
  jti: "owner-vault-init-0001",
} as const;

const ownerVaultInitializationInput = {
  ...ownerVaultInitializationBinding,
  audience: DirectoryControlCapabilityAudience.DirectoryControl,
  authority: DirectoryControlCapabilityAuthority.DirectoryControl,
  credentialEpoch: 4,
  generationEpoch: 9,
  routingEpoch: 12,
  operationID: "owner-vault-init-0001",
  ttlSeconds: 60,
} as const;

const ownerVaultInitializationExpectation = {
  audience: DirectoryControlCapabilityAudience.DirectoryControl,
  authority: DirectoryControlCapabilityAuthority.DirectoryControl,
  resource: DirectoryControlResource.OwnerVaultInitialization,
  ownerID: ownerVaultInitializationBinding.ownerID,
  vaultID: ownerVaultInitializationBinding.vaultID,
  credentialEpoch: 4,
  generationEpoch: 9,
  routingEpoch: 12,
  controlEpoch: 15,
  operationID: "owner-vault-init-0001",
  jti: ownerVaultInitializationBinding.jti,
} as const;

const ownerVaultFloorSyncBinding = {
  method: CapabilityMethod.POST,
  path: "/__v2/internal/owner-vault/floor-sync",
  canonicalQuery: "",
  bodySHA256: "e".repeat(64),
  ownerID: "owner-1",
  vaultID: "vault-1",
  resource: DirectoryControlResource.OwnerVaultFloorSync,
  floorSyncDigest: "f".repeat(64),
  controlEpoch: 16,
  jti: "owner-vault-floor-001",
} as const;

const ownerVaultFloorSyncInput = {
  ...ownerVaultFloorSyncBinding,
  audience: DirectoryControlCapabilityAudience.DirectoryControl,
  authority: DirectoryControlCapabilityAuthority.DirectoryControl,
  credentialEpoch: 4,
  generationEpoch: 9,
  routingEpoch: 12,
  operationID: "owner-vault-floor-001",
  ttlSeconds: 60,
} as const;

const ownerVaultFloorSyncExpectation = {
  audience: DirectoryControlCapabilityAudience.DirectoryControl,
  authority: DirectoryControlCapabilityAuthority.DirectoryControl,
  resource: DirectoryControlResource.OwnerVaultFloorSync,
  ownerID: ownerVaultFloorSyncBinding.ownerID,
  vaultID: ownerVaultFloorSyncBinding.vaultID,
  credentialEpoch: 4,
  generationEpoch: 9,
  routingEpoch: 12,
  controlEpoch: 16,
  operationID: "owner-vault-floor-001",
  jti: ownerVaultFloorSyncBinding.jti,
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

const signedRawBytes = async (payload: Uint8Array): Promise<{ readonly value: string }> => {
  const encodedPayload = base64url(payload);
  const signature = await Effect.runPromise(signCapabilityHmac(key.secret, encodedPayload));
  return { value: `v1.${encodedPayload}.${base64url(signature)}` };
};

const payloadText = (signed: { readonly value: string }): string => {
  const payload = signed.value.split(".")[1];
  if (payload === undefined) throw new Error("test setup invalid");
  return new TextDecoder().decode(
    Uint8Array.from(
      atob(
        `${payload.replace(/-/gu, "+").replace(/_/gu, "/")}${"=".repeat((4 - (payload.length % 4)) % 4)}`,
      ),
      (character) => character.charCodeAt(0),
    ),
  );
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

  test("signs and verifies an exact DirectoryControl capability without exposing its key", async () => {
    const signer = makeDirectoryControlCapabilitySigner(keyRing);
    const verifier = makeDirectoryControlCapabilityVerifier(keyRing);
    const signed = await Effect.runPromise(signer.sign(directoryControlInput, 1_000));
    const claims = await Effect.runPromise(
      verifier.verify(signed, directoryControlBinding, directoryControlExpectation, 1_030),
    );
    expect(claims.operationID).toBe(directoryControlInput.operationID);
    expect(claims.jti).toBe(directoryControlInput.jti);
    expect(claims.routingEpoch).toBe(12);
    expect(JSON.stringify(signed)).not.toContain("capability-test-secret");
  });

  test("requires caller-supplied JTIs for fixed OwnerVault initialization and floor controls", async () => {
    for (const [input, binding, expected] of [
      [
        ownerVaultInitializationInput,
        ownerVaultInitializationBinding,
        ownerVaultInitializationExpectation,
      ],
      [ownerVaultFloorSyncInput, ownerVaultFloorSyncBinding, ownerVaultFloorSyncExpectation],
    ] as const) {
      const signed = await Effect.runPromise(signDirectoryControlCapability(input, keyRing, 1_000));
      const claims = await Effect.runPromise(
        verifyDirectoryControlCapability(signed, binding, expected, keyRing, 1_030),
      );
      expect(claims.jti).toBe(input.jti);

      const missingBinding = { ...binding };
      Reflect.deleteProperty(missingBinding, "jti");
      const missingExpectation = { ...expected };
      Reflect.deleteProperty(missingExpectation, "jti");
      for (const invalid of [
        verifyDirectoryControlCapability(signed, missingBinding, expected, keyRing, 1_030),
        verifyDirectoryControlCapability(signed, binding, missingExpectation, keyRing, 1_030),
        verifyDirectoryControlCapability(
          signed,
          { ...binding, jti: "owner-vault-other-01" },
          expected,
          keyRing,
          1_030,
        ),
        verifyDirectoryControlCapability(
          signed,
          binding,
          { ...expected, jti: "owner-vault-other-01" },
          keyRing,
          1_030,
        ),
      ]) {
        expect(Exit.isFailure(await Effect.runPromiseExit(invalid))).toBe(true);
      }

      const old = await signedRawPayload(payloadText(signed).replace(`"jti":"${input.jti}",`, ""));
      const extra = await signedRawPayload(`${payloadText(signed).slice(0, -1)},"extra":true}`);
      for (const malformed of [old, extra]) {
        expect(
          Exit.isFailure(
            await Effect.runPromiseExit(
              verifyDirectoryControlCapability(malformed, binding, expected, keyRing, 1_030),
            ),
          ),
        ).toBe(true);
      }
    }
    for (const input of [
      { ...ownerVaultInitializationInput, jti: "short" },
      { ...ownerVaultFloorSyncInput, jti: "owner vault floor invalid" },
    ]) {
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(signDirectoryControlCapability(input, keyRing, 1_000)),
        ),
      ).toBe(true);
    }
  });

  test("binds every DirectoryControl identity, epoch, operation, and request field", async () => {
    const signed = await Effect.runPromise(
      signDirectoryControlCapability(directoryControlInput, keyRing, 1_000),
    );
    const substitutions = [
      verifyDirectoryControlCapability(
        signed,
        { ...directoryControlBinding, ownerID: "owner-2" },
        directoryControlExpectation,
        keyRing,
        1_030,
      ),
      verifyDirectoryControlCapability(
        signed,
        { ...directoryControlBinding, vaultID: "vault-2" },
        directoryControlExpectation,
        keyRing,
        1_030,
      ),
      verifyDirectoryControlCapability(
        signed,
        { ...directoryControlBinding, bodySHA256: "c".repeat(64) },
        directoryControlExpectation,
        keyRing,
        1_030,
      ),
      verifyDirectoryControlCapability(
        signed,
        { ...directoryControlBinding, path: "/v2/directory/other" },
        directoryControlExpectation,
        keyRing,
        1_030,
      ),
      verifyDirectoryControlCapability(
        signed,
        directoryControlBinding,
        { ...directoryControlExpectation, ownerID: "owner-2" },
        keyRing,
        1_030,
      ),
    ];
    for (const result of substitutions) {
      expect(Exit.isFailure(await Effect.runPromiseExit(result))).toBe(true);
    }

    for (const input of [
      { ...directoryControlInput, credentialEpoch: 5 },
      { ...directoryControlInput, generationEpoch: 10 },
      { ...directoryControlInput, routingEpoch: 13 },
      { ...directoryControlInput, operationID: "credential-transition-0002" },
    ]) {
      const substituted = await Effect.runPromise(
        signDirectoryControlCapability(input, keyRing, 1_000),
      );
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(
            verifyDirectoryControlCapability(
              substituted,
              directoryControlBinding,
              directoryControlExpectation,
              keyRing,
              1_030,
            ),
          ),
        ),
      ).toBe(true);
    }
  });

  test("rejects other capability purposes as DirectoryControl authority", async () => {
    const directory = await Effect.runPromise(
      signCapability(
        {
          method: directoryControlBinding.method,
          path: directoryControlBinding.path,
          canonicalQuery: directoryControlBinding.canonicalQuery,
          bodySHA256: directoryControlBinding.bodySHA256,
          audience: CapabilityAudience.Directory,
          authority: CapabilityAuthority.Directory,
          credentialEpoch: 4,
          generationEpoch: 9,
          jti: directoryControlInput.jti,
          ttlSeconds: 60,
        },
        keyRing,
        1_000,
      ),
    );
    const ownerVault = await Effect.runPromise(signCapability(input, keyRing, 1_000));
    const substitutedAudience = await signedRawPayload(
      '{"aud":"Directory","authority":"DirectoryControl","bodySHA256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","canonicalQuery":"resume=false","credentialEpoch":4,"expiresAt":1060,"generationEpoch":9,"issuedAt":1000,"jti":"directory-control-jti-0001","keyID":"internal-key-1","method":"POST","operationID":"credential-transition-0001","ownerID":"owner-1","path":"/v2/directory/credential-transition","resource":"credential-transition","routingEpoch":12,"vaultID":"vault-1","version":1}',
    );
    const substitutedAuthority = await signedRawPayload(
      '{"aud":"DirectoryControl","authority":"Directory","bodySHA256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","canonicalQuery":"resume=false","credentialEpoch":4,"expiresAt":1060,"generationEpoch":9,"issuedAt":1000,"jti":"directory-control-jti-0001","keyID":"internal-key-1","method":"POST","operationID":"credential-transition-0001","ownerID":"owner-1","path":"/v2/directory/credential-transition","resource":"credential-transition","routingEpoch":12,"vaultID":"vault-1","version":1}',
    );
    for (const signed of [directory, ownerVault, substitutedAudience, substitutedAuthority]) {
      const result = await Effect.runPromiseExit(
        verifyDirectoryControlCapability(
          signed,
          directoryControlBinding,
          directoryControlExpectation,
          keyRing,
          1_030,
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }
  });

  test("does not allow DirectoryControl capability tokens into legacy Directory or OwnerVault verifiers", async () => {
    const signed = await Effect.runPromise(
      signDirectoryControlCapability(directoryControlInput, keyRing, 1_000),
    );
    const directory = await Effect.runPromiseExit(
      verifyCapability(
        signed,
        {
          method: directoryControlBinding.method,
          path: directoryControlBinding.path,
          canonicalQuery: directoryControlBinding.canonicalQuery,
          bodySHA256: directoryControlBinding.bodySHA256,
        },
        { audience: CapabilityAudience.Directory, authority: CapabilityAuthority.Directory },
        keyRing,
        1_030,
      ),
    );
    const ownerVault = await Effect.runPromiseExit(
      verifyCapability(signed, directoryControlBinding, expectation, keyRing, 1_030),
    );
    expect(Exit.isFailure(directory)).toBe(true);
    expect(Exit.isFailure(ownerVault)).toBe(true);
  });

  test("rejects DirectoryControl zero or unsafe epochs, expiry, and stale keys", async () => {
    for (const input of [
      { ...directoryControlInput, credentialEpoch: 0 },
      { ...directoryControlInput, generationEpoch: 0 },
      { ...directoryControlInput, routingEpoch: 0 },
      { ...directoryControlInput, routingEpoch: Number.MAX_SAFE_INTEGER + 1 },
      { ...directoryControlInput, ttlSeconds: maximumCapabilityTTLSeconds + 1 },
    ]) {
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(signDirectoryControlCapability(input, keyRing, 1_000)),
        ),
      ).toBe(true);
    }
    const expired = await Effect.runPromise(
      signDirectoryControlCapability({ ...directoryControlInput, ttlSeconds: 1 }, keyRing, 1_000),
    );
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          verifyDirectoryControlCapability(
            expired,
            directoryControlBinding,
            directoryControlExpectation,
            keyRing,
            1_001,
          ),
        ),
      ),
    ).toBe(true);

    const prior: CapabilityKeyMaterial = {
      keyID: "directory-control-prior",
      secret: Redacted.make("directory-control-prior-secret"),
    };
    const priorSigned = await Effect.runPromise(
      signDirectoryControlCapability(
        directoryControlInput,
        { purpose: "internal-capability", current: prior, prior: [] },
        1_000,
      ),
    );
    const accepting = await Effect.runPromise(
      makeInternalCapabilityKeyRing({ current: key, prior: [prior] }),
    );
    expect(
      (
        await Effect.runPromise(
          verifyDirectoryControlCapability(
            priorSigned,
            directoryControlBinding,
            directoryControlExpectation,
            accepting,
            1_030,
          ),
        )
      ).keyID,
    ).toBe(prior.keyID);
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          verifyDirectoryControlCapability(
            priorSigned,
            directoryControlBinding,
            directoryControlExpectation,
            keyRing,
            1_030,
          ),
        ),
      ),
    ).toBe(true);
  });

  test("rejects noncanonical and extra DirectoryControl claims before authorization", async () => {
    const noncanonical = await signedRawPayload(
      '{"version":1,"aud":"DirectoryControl","authority":"DirectoryControl","bodySHA256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","canonicalQuery":"resume=false","credentialEpoch":4,"expiresAt":1060,"generationEpoch":9,"issuedAt":1000,"jti":"directory-control-jti-0001","keyID":"internal-key-1","method":"POST","operationID":"credential-transition-0001","ownerID":"owner-1","path":"/v2/directory/credential-transition","resource":"credential-transition","routingEpoch":12,"vaultID":"vault-1"}',
    );
    const extra = await signedRawPayload(
      '{"aud":"DirectoryControl","authority":"DirectoryControl","bodySHA256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","canonicalQuery":"resume=false","credentialEpoch":4,"expiresAt":1060,"generationEpoch":9,"issuedAt":1000,"jti":"directory-control-jti-0001","keyID":"internal-key-1","method":"POST","operationID":"credential-transition-0001","ownerID":"owner-1","path":"/v2/directory/credential-transition","resource":"credential-transition","routingEpoch":12,"vaultID":"vault-1","version":1,"extra":true}',
    );
    for (const signed of [noncanonical, extra]) {
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(
            verifyDirectoryControlCapability(
              signed,
              directoryControlBinding,
              directoryControlExpectation,
              keyRing,
              1_030,
            ),
          ),
        ),
      ).toBe(true);
    }
  });

  test("rejects a signed non-UTF8 DirectoryControl payload with a closed error", async () => {
    const signed = await signedRawBytes(Uint8Array.of(0xff, 0xfe, 0xfd));
    const result = await Effect.runPromiseExit(
      verifyDirectoryControlCapability(
        signed,
        directoryControlBinding,
        directoryControlExpectation,
        keyRing,
        1_030,
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(JSON.stringify(result)).toContain(CapabilityVerificationError.name);
    expect(JSON.stringify(result)).not.toContain("fffe");
  });

  test("converts the one Effect worker handler into a safe Promise Response boundary", async () => {
    const boundary = makeWorkerBoundary(() => Effect.succeed(new Response("ok", { status: 200 })));
    expect(Object.isFrozen(boundary)).toBe(true);
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
