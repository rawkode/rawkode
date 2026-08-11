import { describe, expect, test } from "bun:test";
import {
  AccessJwtVerificationError,
  CapabilityAudience,
  CapabilityAuthority,
  CapabilityMethod,
  AccessJwtVerifier as RuntimeAccessJwtVerifier,
} from "@enchiridion/runtime";
import { Redacted } from "effect";
import { Effect, Exit, Layer, Ref } from "effect";
import {
  type AccessAssertionError,
  type AccessAssertionHeaderValues,
  accessAssertionHeadersFromWorkerHeaders,
  cfAccessJwtAssertionHeaderName,
  forbiddenCredentialHeaderNames,
  makeAccessAssertionVerifier,
} from "./access";
import {
  VaultV2Config,
  type VaultV2ConfigInput,
  layerVaultV2Config,
  layerVaultV2Foundation,
  makeVaultV2Config,
} from "./config";
import {
  isCredentialBindingDigest,
  makeInternalCapabilityFactory,
  makeVersionedIssuerHasher,
  verifiedAccessIssuer,
} from "./crypto";
import { CredentialDirectory, OwnerVaultInitializer, makeCredentialDirectory } from "./directory";
import { noopVaultV2MetricsLayer } from "./metrics";
import {
  CredentialDirectoryRepository,
  makeInMemoryCredentialDirectoryRepository,
} from "./repositories";
import {
  credentialID,
  isCredentialID,
  isOwnerID,
  isRequestID,
  isVaultID,
  opaqueAccessSubject,
  ownerID,
  requestID,
  vaultID,
} from "./schemas";

const now = 1_760_000_000;
const accessSubject = "service-token-device-7";
const secret = (label: string): Redacted.Redacted =>
  Redacted.make(`${label}-0123456789-abcdefghijklmno`);

const configInput: VaultV2ConfigInput = {
  access: {
    teamDomain: "team.cloudflareaccess.com",
    jwksURL: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
    applicationAudience: "access-app-aud",
    jwksCacheTTLSeconds: 30,
    jwksRefreshCooldownSeconds: 10,
    maximumAssertionLifetimeSeconds: 300,
  },
  issuerWriteKey: { keyID: "issuer-v2", secret: secret("issuer-write") },
  issuerReadKeys: [
    { keyID: "issuer-v1", secret: secret("issuer-legacy") },
    { keyID: "issuer-v2", secret: secret("issuer-write") },
  ],
  capabilityKeys: {
    current: { keyID: "capability-v1", secret: secret("capability-current") },
    prior: [],
  },
  credentialQuota: 2,
};

const required = <A>(value: A | undefined): A => {
  if (value === undefined) throw new Error("test setup value is invalid");
  return value;
};

const subject = required(opaqueAccessSubject(accessSubject));
const issuer = required(verifiedAccessIssuer("https://team.cloudflareaccess.com"));
const alternateIssuer = required(verifiedAccessIssuer("https://other.cloudflareaccess.com"));
const directoryOwner = required(ownerID("owner-1"));
const directoryVault = required(vaultID("vault-1"));
const directoryCredential = required(credentialID("credential-1"));
const revokeRequest = required(requestID("revoke-request-0001"));
const conflictingRevokeRequest = required(requestID("revoke-request-0002"));

const jwt = (header = { alg: "RS256", typ: "JWT", kid: "key-1" }): string => {
  const text = btoa(JSON.stringify(header))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
  return `${text}.claims.signature`;
};
const headers = (value: string): AccessAssertionHeaderValues => ({
  values: () => [value],
  hasForbiddenCredential: () => false,
});

const validClaims = {
  iss: "https://team.cloudflareaccess.com",
  aud: "access-app-aud",
  iat: now - 10,
  nbf: now - 5,
  exp: now + 60,
  sub: accessSubject,
};

const verifiedAccess = (claims = validClaims) => ({
  protectedHeader: { alg: "RS256" as const, typ: "JWT" as const, kid: "key-1" },
  claims,
});

const accessLayer = (
  result: Effect.Effect<
    ReturnType<typeof verifiedAccess>,
    AccessJwtVerificationError
  > = Effect.succeed(verifiedAccess()),
) =>
  Layer.mergeAll(
    layerVaultV2Config(configInput),
    noopVaultV2MetricsLayer,
    Layer.succeed(RuntimeAccessJwtVerifier, { verify: () => result }),
  );

const capabilityFactory = (capabilityKeys: VaultV2ConfigInput["capabilityKeys"]) =>
  makeInternalCapabilityFactory.pipe(
    Effect.provide(layerVaultV2Config({ ...configInput, capabilityKeys })),
  );

describe("v2 foundation access assertions", () => {
  test("accepts a verified service-token subject without retaining it in claims", async () => {
    const assertion = await Effect.runPromise(
      makeAccessAssertionVerifier.pipe(
        Effect.flatMap((verifier) => verifier.verify(headers(jwt()), now)),
        Effect.provide(accessLayer()),
      ),
    );
    expect(assertion.subject.value).toBe(accessSubject);
    expect(String(assertion.issuer)).toBe("https://team.cloudflareaccess.com");
    expect(assertion.claims).not.toHaveProperty("sub");
  });

  test("rejects duplicate and oversized headers through the public Worker header bridge", async () => {
    const duplicate = new Headers();
    duplicate.append(cfAccessJwtAssertionHeaderName, jwt());
    duplicate.append(cfAccessJwtAssertionHeaderName, jwt());
    const oversized = new Headers({ [cfAccessJwtAssertionHeaderName]: "x".repeat(8_193) });
    for (const workerHeaders of [duplicate, oversized]) {
      const exit = await Effect.runPromiseExit(
        makeAccessAssertionVerifier.pipe(
          Effect.flatMap((verifier) =>
            verifier.verify(accessAssertionHeadersFromWorkerHeaders(workerHeaders), now),
          ),
          Effect.provide(accessLayer()),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("missing_assertion");
    }
  });

  test("fails closed before JWT verification when a valid assertion is mixed with any legacy credential", async () => {
    const rawSecret = "raw-legacy-secret-must-never-be-observed";
    for (const forbidden of forbiddenCredentialHeaderNames) {
      let verified = 0;
      const workerHeaders = new Headers({ "Cf-Access-Jwt-Assertion": jwt() });
      workerHeaders.set(forbidden.toUpperCase(), "");
      const exit = await Effect.runPromiseExit(
        makeAccessAssertionVerifier.pipe(
          Effect.flatMap((verifier) =>
            verifier.verify(accessAssertionHeadersFromWorkerHeaders(workerHeaders), now),
          ),
          Effect.provide(
            Layer.mergeAll(
              layerVaultV2Config(configInput),
              noopVaultV2MetricsLayer,
              Layer.succeed(RuntimeAccessJwtVerifier, {
                verify: () =>
                  Effect.sync(() => {
                    verified += 1;
                    return verifiedAccess();
                  }),
              }),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(verified).toBe(0);
      expect(JSON.stringify(exit)).not.toContain(rawSecret);
    }
    let combinedVerifications = 0;
    const combined = new Headers({ "Cf-Access-Jwt-Assertion": jwt() });
    combined.append("authorization", "");
    combined.append("authorization", " ");
    const combinedExit = await Effect.runPromiseExit(
      makeAccessAssertionVerifier.pipe(
        Effect.flatMap((verifier) =>
          verifier.verify(accessAssertionHeadersFromWorkerHeaders(combined), now),
        ),
        Effect.provide(
          Layer.mergeAll(
            layerVaultV2Config(configInput),
            noopVaultV2MetricsLayer,
            Layer.succeed(RuntimeAccessJwtVerifier, {
              verify: () =>
                Effect.sync(() => {
                  combinedVerifications += 1;
                  return verifiedAccess();
                }),
            }),
          ),
        ),
      ),
    );
    expect(Exit.isFailure(combinedExit)).toBe(true);
    expect(combinedVerifications).toBe(0);
    for (const cookie of [
      "CF_Authorization=secret",
      "session=secret; CF_Authorization=also-secret",
    ]) {
      const workerHeaders = new Headers({
        "Cf-Access-Jwt-Assertion": jwt(),
        cOoKiE: cookie,
      });
      const exit = await Effect.runPromiseExit(
        makeAccessAssertionVerifier.pipe(
          Effect.flatMap((verifier) =>
            verifier.verify(accessAssertionHeadersFromWorkerHeaders(workerHeaders), now),
          ),
          Effect.provide(accessLayer()),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).not.toContain(cookie);
    }
  });

  test("contains hostile native Header getters without calling JWT verification or exposing values", async () => {
    const secret = "hostile-header-secret";
    for (const hostile of [
      {
        has: () => {
          throw new Error(secret);
        },
        get: () => jwt(),
      },
      {
        has: () => false,
        get: () => {
          throw new Error(secret);
        },
      },
    ]) {
      let verified = 0;
      const exit = await Effect.runPromiseExit(
        makeAccessAssertionVerifier.pipe(
          Effect.flatMap((verifier) =>
            verifier.verify(
              accessAssertionHeadersFromWorkerHeaders(hostile as unknown as Headers),
              now,
            ),
          ),
          Effect.provide(
            Layer.mergeAll(
              layerVaultV2Config(configInput),
              noopVaultV2MetricsLayer,
              Layer.succeed(RuntimeAccessJwtVerifier, {
                verify: () =>
                  Effect.sync(() => {
                    verified += 1;
                    return verifiedAccess();
                  }),
              }),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(verified).toBe(0);
      expect(JSON.stringify(exit)).not.toContain(secret);
    }
  });

  test("maps bound runtime verifier failures and post-verification lifetime failures closed", async () => {
    const runtimeFailures: readonly [
      AccessJwtVerificationError["reason"],
      AccessAssertionError["reason"],
    ][] = [
      ["unknown_key", "unknown_key"],
      ["jwks_unavailable", "jwks_unavailable"],
      ["malformed_assertion", "malformed_assertion"],
      ["claims_invalid", "claims_invalid"],
    ];
    for (const [runtimeReason, expectedReason] of runtimeFailures) {
      const exit = await Effect.runPromiseExit(
        makeAccessAssertionVerifier.pipe(
          Effect.flatMap((verifier) => verifier.verify(headers(jwt()), now)),
          Effect.provide(
            accessLayer(Effect.fail(new AccessJwtVerificationError({ reason: runtimeReason }))),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain(expectedReason);
      expect(JSON.stringify(exit)).not.toContain(accessSubject);
    }
    const lifetimeExit = await Effect.runPromiseExit(
      makeAccessAssertionVerifier.pipe(
        Effect.flatMap((verifier) => verifier.verify(headers(jwt()), now)),
        Effect.provide(
          accessLayer(Effect.succeed(verifiedAccess({ ...validClaims, exp: now + 301 }))),
        ),
      ),
    );
    expect(Exit.isFailure(lifetimeExit)).toBe(true);
    expect(JSON.stringify(lifetimeExit)).toContain("claims_invalid");
  });
});

describe("v2 foundation binding, configuration, and directory", () => {
  test("binds version, normalized issuer, and subject so issuer substitution fails", async () => {
    const config = await Effect.runPromise(makeVaultV2Config(configInput));
    const hasher = makeVersionedIssuerHasher(config.credentialBindingKeys);
    const digest = await Effect.runPromise(hasher.issue({ issuer, subject }));
    const alternateDigest = await Effect.runPromise(
      hasher.issue({ issuer: alternateIssuer, subject }),
    );
    expect(digest).not.toBe(alternateDigest);
    expect(await Effect.runPromise(hasher.matches({ issuer, subject }, digest))).toBe(true);
    expect(
      await Effect.runPromise(hasher.matches({ issuer: alternateIssuer, subject }, digest)),
    ).toBe(false);
    expect(JSON.stringify(digest)).not.toContain(accessSubject);
  });

  test("constructs current/prior runtime capability rings from validated config", async () => {
    const current = { keyID: "cap-current", secret: secret("cap-current") };
    const prior = { keyID: "cap-prior", secret: secret("cap-prior") };
    const ring = await Effect.runPromise(capabilityFactory({ current, prior: [prior] }));
    const priorOnly = await Effect.runPromise(capabilityFactory({ current: prior, prior: [] }));
    const input = {
      audience: CapabilityAudience.OwnerVault,
      authority: CapabilityAuthority.OwnerVault,
      method: CapabilityMethod.POST,
      path: "/v2/mutations",
      canonicalQuery: "",
      bodySHA256: "a".repeat(64),
      ownerID: "owner-1",
      vaultID: "vault-1",
      credentialEpoch: 1,
      generationEpoch: 1,
      jti: "abcdefghijklmnop",
      ttlSeconds: 30,
    };
    const binding = {
      method: CapabilityMethod.POST,
      path: "/v2/mutations",
      canonicalQuery: "",
      bodySHA256: "a".repeat(64),
      ownerID: "owner-1",
      vaultID: "vault-1",
    };
    const expected = {
      audience: CapabilityAudience.OwnerVault,
      authority: CapabilityAuthority.OwnerVault,
      ownerID: "owner-1",
      vaultID: "vault-1",
    };
    const signed = await Effect.runPromise(ring.signer.sign(input, 100));
    expect(
      await Effect.runPromise(ring.verifier.verify(signed, binding, expected, 101)),
    ).toMatchObject({
      keyID: "cap-current",
    });
    const old = await Effect.runPromise(priorOnly.signer.sign(input, 100));
    expect(
      await Effect.runPromise(ring.verifier.verify(old, binding, expected, 101)),
    ).toMatchObject({
      keyID: "cap-prior",
    });
    const retired = await Effect.runPromise(
      capabilityFactory({
        current: { keyID: "cap-retired", secret: secret("cap-retired") },
        prior: [],
      }),
    );
    const stale = await Effect.runPromise(retired.signer.sign(input, 100));
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(ring.verifier.verify(stale, binding, expected, 101)),
      ),
    ).toBe(true);
  });

  test("rejects malformed Access/key inputs before any service receives them", async () => {
    const invalidInputs: readonly VaultV2ConfigInput[] = [
      { ...configInput, access: { ...configInput.access, jwksURL: "http://bad.test/certs" } },
      {
        ...configInput,
        issuerReadKeys: [{ keyID: "issuer-v2", secret: secret("different-secret") }],
      },
      {
        ...configInput,
        capabilityKeys: {
          current: { keyID: "issuer-v2", secret: secret("separate-secret") },
          prior: [],
        },
      },
      {
        ...configInput,
        capabilityKeys: {
          current: { keyID: "cap-short", secret: Redacted.make("too-short") },
          prior: [],
        },
      },
      {
        ...configInput,
        capabilityKeys: {
          current: configInput.capabilityKeys.current,
          prior: [configInput.capabilityKeys.current],
        },
      },
    ];
    for (const input of invalidInputs) {
      const exit = await Effect.runPromiseExit(makeVaultV2Config(input));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).not.toContain("different-secret");
      expect(JSON.stringify(exit)).not.toContain("too-short");
    }
  });

  test("rejects every noncanonical Cloudflare team host in direct config and layer construction", async () => {
    const overlongLabel = `${"a".repeat(64)}.cloudflareaccess.com`;
    const overlongHost = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.cloudflareaccess.com`;
    const invalidDomains = [
      "bad..host.cloudflareaccess.com",
      "-label.cloudflareaccess.com",
      "label-.cloudflareaccess.com",
      overlongLabel,
      overlongHost,
      "127.0.0.1",
      "team.cloudflareaccess.com:443",
      "user@team.cloudflareaccess.com",
      "team.cloudflareaccess.com/path",
      "team.cloudflareaccess.com?query=value",
      "team.cloudflareaccess.com#fragment",
      "a.b.cloudflareaccess.com",
      "team.example.com",
    ];
    for (const teamDomain of invalidDomains) {
      const input = { ...configInput, access: { ...configInput.access, teamDomain } };
      const direct = await Effect.runPromiseExit(makeVaultV2Config(input));
      const layered = await Effect.runPromiseExit(
        Effect.gen(function* () {
          yield* VaultV2Config;
        }).pipe(Effect.provide(layerVaultV2Config(input))),
      );
      expect(Exit.isFailure(direct)).toBe(true);
      expect(Exit.isFailure(layered)).toBe(true);
    }
  });

  test("builds validated config and runtime Access verifier together before Vault services", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* VaultV2Config;
        const verifier = yield* RuntimeAccessJwtVerifier;
        return { issuer: config.access.issuer, verifier };
      }).pipe(Effect.provide(layerVaultV2Foundation(configInput))),
    );
    expect(result.issuer).toBe("https://team.cloudflareaccess.com");
    expect(typeof result.verifier.verify).toBe("function");
  });

  test("persists only a hasher-made binding digest and makes revoke idempotent only per request ID", async () => {
    const repository = await Effect.runPromise(makeInMemoryCredentialDirectoryRepository);
    const directory = await Effect.runPromise(
      makeCredentialDirectory.pipe(
        Effect.provide(
          Layer.mergeAll(
            repository.layer,
            layerVaultV2Config(configInput),
            noopVaultV2MetricsLayer,
            Layer.succeed(OwnerVaultInitializer, { ensureInitialized: () => Effect.succeed(true) }),
          ),
        ),
      ),
    );
    const config = await Effect.runPromise(makeVaultV2Config(configInput));
    const digest = await Effect.runPromise(
      makeVersionedIssuerHasher(config.credentialBindingKeys).issue({ issuer, subject }),
    );
    const identity = {
      ownerID: directoryOwner,
      vaultID: directoryVault,
      generationEpoch: 1,
      bindingDigest: digest,
    };
    const independentlyParsedIdentity = {
      ownerID: required(ownerID("owner-1")),
      vaultID: required(vaultID("vault-1")),
      generationEpoch: 1,
      bindingDigest: digest,
    };
    const [initialized] = await Effect.runPromise(
      Effect.all(
        [
          directory.ensureInitialized(identity),
          directory.ensureInitialized(independentlyParsedIdentity),
        ],
        { concurrency: "unbounded" },
      ),
    );
    expect(initialized.status).toBe("ACTIVE");
    const conflict = await Effect.runPromiseExit(
      directory.ensureInitialized({
        ...identity,
        vaultID: required(vaultID("vault-2")),
      }),
    );
    expect(Exit.isFailure(conflict)).toBe(true);
    await Effect.runPromise(directory.enrollCredential(identity, directoryCredential));
    const revoked = await Effect.runPromise(
      directory.revokeCredential(digest, directoryCredential, revokeRequest),
    );
    expect(
      await Effect.runPromise(
        directory.revokeCredential(digest, directoryCredential, revokeRequest),
      ),
    ).toEqual(revoked);
    const revokeConflict = await Effect.runPromiseExit(
      directory.revokeCredential(digest, directoryCredential, conflictingRevokeRequest),
    );
    expect(Exit.isFailure(revokeConflict)).toBe(true);
    const persisted = await Effect.runPromise(repository.repository.read(digest));
    expect(JSON.stringify(persisted)).not.toContain(accessSubject);
    expect(JSON.stringify(persisted)).not.toContain("person@example.test");

    const record = required(persisted);
    const forgedRecord = { ...record, bindingDigest: Object.create(Object(digest)) };
    expect(
      await Effect.runPromise(
        repository.repository.compareAndSet(digest, record.revision, forgedRecord),
      ),
    ).toBe(false);
  });

  test("rejects raw emails, bearer strings, spaces, and short request IDs at the identifier boundary", () => {
    expect(ownerID("person@example.test")).toBeUndefined();
    expect(vaultID("Bearer opaque-token")).toBeUndefined();
    expect(credentialID("has spaces")).toBeUndefined();
    expect(requestID("short")).toBeUndefined();
  });

  test("rejects primitive, copied, prototype, and Reflect-created opaque-token forgeries", async () => {
    const config = await Effect.runPromise(makeVaultV2Config(configInput));
    const digest = await Effect.runPromise(
      makeVersionedIssuerHasher(config.credentialBindingKeys).issue({ issuer, subject }),
    );
    const values = [directoryOwner, directoryVault, directoryCredential, revokeRequest, digest];
    const validators = [
      isOwnerID,
      isVaultID,
      isCredentialID,
      isRequestID,
      isCredentialBindingDigest,
    ];
    for (let index = 0; index < values.length; index += 1) {
      const value = required(values[index]);
      const validator = required(validators[index]);
      expect(Object.isFrozen(value)).toBe(true);
      expect(validator(value.value)).toBe(false);
      expect(validator({ value: value.value })).toBe(false);
      expect(validator(Object.create(Object(value)))).toBe(false);
      expect(validator(Object.assign({}, value))).toBe(false);
      expect(validator(Object.defineProperties({}, Object.getOwnPropertyDescriptors(value)))).toBe(
        false,
      );
      const reflected = Reflect.construct(Object, []);
      Object.defineProperty(reflected, "value", { value: value.value, enumerable: true });
      expect(validator(reflected)).toBe(false);
    }
  });

  test("rejects raw valid-looking values and v2.fake before directory mutation or persistence", async () => {
    const repository = await Effect.runPromise(makeInMemoryCredentialDirectoryRepository);
    const directory = await Effect.runPromise(
      makeCredentialDirectory.pipe(
        Effect.provide(
          Layer.mergeAll(
            repository.layer,
            layerVaultV2Config(configInput),
            noopVaultV2MetricsLayer,
            Layer.succeed(OwnerVaultInitializer, { ensureInitialized: () => Effect.succeed(true) }),
          ),
        ),
      ),
    );
    const rawInitialize = Reflect.apply(directory.ensureInitialized, directory, [
      {
        ownerID: "owner-1",
        vaultID: "vault-1",
        generationEpoch: 1,
        bindingDigest: "v2.fake",
      },
    ]);
    const rawRevoke = Reflect.apply(directory.revokeCredential, directory, [
      "v2.fake",
      "credential-1",
      "revoke-request-0001",
    ]);
    expect(Exit.isFailure(await Effect.runPromiseExit(rawInitialize))).toBe(true);
    expect(Exit.isFailure(await Effect.runPromiseExit(rawRevoke))).toBe(true);
    expect(await Effect.runPromise(Ref.get(repository.state))).toEqual({});
    expect(isCredentialBindingDigest(`v2.fake.${"a".repeat(43)}`)).toBe(false);
  });

  test("trusted repository decoding rejects unknown or corrupt durable record fields", async () => {
    const repository = await Effect.runPromise(makeInMemoryCredentialDirectoryRepository);
    const config = await Effect.runPromise(makeVaultV2Config(configInput));
    const digest = await Effect.runPromise(
      makeVersionedIssuerHasher(config.credentialBindingKeys).issue({ issuer, subject }),
    );
    const stored = {
      ownerID: "owner-1",
      vaultID: "vault-1",
      generationEpoch: 1,
      bindingDigest: digest.value,
      initID: `init-${digest.value}`,
      initializerConfirmed: true,
      revision: 1,
      status: "ACTIVE",
      credentials: {},
    };
    await Effect.runPromise(Ref.set(repository.state, { [digest.value]: stored }));
    const decoded = required(await Effect.runPromise(repository.repository.read(digest)));
    expect(isCredentialBindingDigest(decoded.bindingDigest)).toBe(true);
    const canonicalFakeDigest = `v2.fake.${"a".repeat(43)}`;
    const corruptRecords = [
      { ...stored, initializerConfirmed: "true" },
      { ...stored, initializerConfirmed: false },
      { ...stored, ownerID: "person@example.test" },
      { ...stored, bindingDigest: "v2.fake" },
      {
        ...stored,
        bindingDigest: canonicalFakeDigest,
        initID: `init-${canonicalFakeDigest}`,
      },
      { ...stored, credentials: { "credential-1": { revoked: "false" } } },
      {
        ...stored,
        credentials: {
          "credential-1": {
            credentialID: "credential-1",
            credentialEpoch: 1,
            routingEpoch: 1,
            revoked: true,
            revocationRequestID: "short",
          },
        },
      },
      { ...stored, unexpected: true },
    ];
    for (const corrupt of corruptRecords) {
      await Effect.runPromise(Ref.set(repository.state, { [digest.value]: corrupt }));
      expect(await Effect.runPromise(repository.repository.read(digest))).toBeUndefined();
      expect(
        await Effect.runPromise(
          repository.repository.compareAndSet(digest, decoded.revision, decoded),
        ),
      ).toBe(false);
    }
  });

  test("CAS rejects malformed next records instead of normalizing or dropping fields", async () => {
    const repository = await Effect.runPromise(makeInMemoryCredentialDirectoryRepository);
    const config = await Effect.runPromise(makeVaultV2Config(configInput));
    const digest = await Effect.runPromise(
      makeVersionedIssuerHasher(config.credentialBindingKeys).issue({ issuer, subject }),
    );
    const stored = {
      ownerID: "owner-1",
      vaultID: "vault-1",
      generationEpoch: 1,
      bindingDigest: digest.value,
      initID: `init-${digest.value}`,
      initializerConfirmed: true,
      revision: 1,
      status: "ACTIVE",
      credentials: {},
    };
    await Effect.runPromise(Ref.set(repository.state, { [digest.value]: stored }));
    const current = required(await Effect.runPromise(repository.repository.read(digest)));
    const credential = {
      credentialID: directoryCredential,
      credentialEpoch: 1,
      routingEpoch: 1,
      revoked: false,
    };
    const validNext = {
      ...current,
      revision: current.revision + 1,
      credentials: { [directoryCredential.value]: credential },
    };
    const invalidNexts = [
      { ...validNext, initializerConfirmed: "true" },
      { ...validNext, status: "CORRUPTED" },
      { ...validNext, rawSecret: "must-not-write" },
      {
        ...validNext,
        credentials: {
          ...validNext.credentials,
          [directoryCredential.value]: { ...credential, debug: true },
        },
      },
      {
        ...validNext,
        credentials: {
          ...validNext.credentials,
          [directoryCredential.value]: { ...credential, revoked: "false" },
        },
      },
      {
        ...validNext,
        credentials: {
          ...validNext.credentials,
          [directoryCredential.value]: { ...credential, revoked: true },
        },
      },
      {
        ...validNext,
        credentials: {
          ...validNext.credentials,
          [directoryCredential.value]: {
            ...credential,
            revocationRequestID: revokeRequest.value,
          },
        },
      },
    ];
    const before = await Effect.runPromise(Ref.get(repository.state));
    for (const invalid of invalidNexts) {
      expect(
        await Effect.runPromise(
          repository.repository.compareAndSet(digest, current.revision, invalid),
        ),
      ).toBe(false);
      expect(await Effect.runPromise(Ref.get(repository.state))).toEqual(before);
    }
  });
});
