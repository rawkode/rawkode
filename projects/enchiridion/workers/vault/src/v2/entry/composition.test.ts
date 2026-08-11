import { expect, test } from "bun:test";
import {
  type AccessJwksSessionFactory,
  AccessJwtVerificationError,
  type AccessJwtVerificationRequest,
  type VerifiedAccessJwt,
} from "@enchiridion/runtime";
import { Effect, Exit } from "effect";
import { accessAssertionHeadersFromWorkerHeaders } from "../foundation/access";
import {
  makeVaultV2EntryComposition,
  makeVaultV2EntryCompositionCache,
  parseVaultV2EntryEnv,
} from "./composition";

const manifestPrivate =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgnqgn2CchsOl0SE25sbl1fSF4GeFyIyhcGXfmk+nORRihRANCAARgDj/LiRqx4+xQpW1yKXYVWEGHCg+4hJxT4PbHMBrFWthHzkiAYKYvic295OBVCfvBwjOQEZVKtWmC+t+IMFbF";
const manifestPublic =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEYA4/y4kasePsUKVtcil2FVhBhwoPuIScU+D2xzAaxVrYR85IgGCmL4nNveTgVQn7wcIzkBGVSrVpgvrfiDBWxQ==";
const limits = JSON.stringify({
  blob: {
    maximumBlobBytes: 8388608,
    maximumVaultBytes: 100663296,
    maximumOrphanBytes: 8388608,
    maximumOrphanCount: 32,
    maximumActiveLeasesPerVault: 32,
    maximumActiveLeasesPerFinal: 32,
    stageTTLSeconds: 900,
    tombstoneGraceSeconds: 86400,
  },
  catalog: {
    maximumObjects: 4096,
    maximumObjectBytes: 8388608,
    maximumTotalBytes: 100663296,
    maximumPageEntries: 128,
    targetPageBytes: 24576,
    maximumPageBytes: 32768,
    maximumRootBytes: 8192,
  },
  backup: {
    maximumPageBytes: 524288,
    maximumPageEntries: 128,
    maximumObjectBytes: 8388608,
    maximumTotalBytes: 100663296,
    maximumManifestBytes: 1048576,
    maximumRestoreJournalBytes: 65536,
    maximumObjects: 4096,
  },
  pins: { maximumPins: 1024, gcChunk: 128, retentionSeconds: 86400 },
  r2: {
    maximumKeyBytes: 1024,
    maximumObjectBytes: 8388608,
    maximumCursorBytes: 1024,
    maximumListPageSize: 128,
  },
});
const r2 = (): unknown => ({
  head: async () => null,
  get: async () => null,
  put: async () => null,
  list: async () => ({ objects: [], truncated: false }),
  delete: async () => undefined,
});

const environment = (directory: unknown): Readonly<Record<string, unknown>> => ({
  ENCHIRIDION_V2_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  ENCHIRIDION_V2_ACCESS_AUDIENCE: "audience",
  ENCHIRIDION_V2_ACCESS_JWKS_CACHE_TTL_SECONDS: "60",
  ENCHIRIDION_V2_ACCESS_JWKS_REFRESH_COOLDOWN_SECONDS: "10",
  ENCHIRIDION_V2_ACCESS_MAXIMUM_ASSERTION_LIFETIME_SECONDS: "300",
  ENCHIRIDION_V2_CREDENTIAL_BINDING_CURRENT_KEY_ID: "issuer-current",
  ENCHIRIDION_V2_CREDENTIAL_BINDING_CURRENT_SECRET: "issuer-secret-0123456789-abcdefghijklmno",
  ENCHIRIDION_V2_CREDENTIAL_BINDING_READ_KEYS_JSON:
    '[{"keyID":"issuer-current","secret":"issuer-secret-0123456789-abcdefghijklmno"}]',
  ENCHIRIDION_V2_DIRECTORY_CAPABILITY_CURRENT_KEY_ID: "capability-current",
  ENCHIRIDION_V2_DIRECTORY_CAPABILITY_CURRENT_SECRET:
    "capability-secret-0123456789-abcdefghijklmno",
  ENCHIRIDION_V2_DIRECTORY_CAPABILITY_PRIOR_KEYS_JSON: "[]",
  ENCHIRIDION_V2_CREDENTIAL_QUOTA: "1",
  ENCHIRIDION_V2_OWNER_VAULT_LIMITS_JSON: limits,
  ENCHIRIDION_V2_MANIFEST_CURRENT_KEY_ID: "manifest-current",
  ENCHIRIDION_V2_MANIFEST_CURRENT_PKCS8_BASE64: manifestPrivate,
  ENCHIRIDION_V2_MANIFEST_CURRENT_SPKI_BASE64: manifestPublic,
  ENCHIRIDION_V2_MANIFEST_PRIOR_KEYS_JSON: "[]",
  ENCHIRIDION_V2_MANIFEST_REVOKED_KEY_IDS_JSON: "[]",
  ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_CURRENT_KEY_ID: "socket-current",
  ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_CURRENT_SECRET:
    "socket-admission-current-secret-0123456789-abcdef",
  ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_PRIOR_KEYS_JSON: "[]",
  ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_REVOKED_KEY_IDS_JSON: "[]",
  ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_CURRENT_KEY_ID: "owner-control-current",
  ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_CURRENT_SECRET:
    "owner-control-current-secret-0123456789-abcdef",
  ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_PRIOR_KEYS_JSON: "[]",
  ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_REVOKED_KEY_IDS_JSON: "[]",
  CREDENTIAL_DIRECTORY_DO: directory,
  OWNER_VAULT_V2_DO: directory,
  BLOB_R2: r2(),
  BACKUP_R2: r2(),
});

test("entry binding parser accepts non-enumerable Durable Object namespace methods", () => {
  const namespace = Object.create(null);
  Object.defineProperties(namespace, {
    idFromName: { value: () => ({ toString: () => "directory" }) },
    get: { value: () => ({ fetch: () => Promise.resolve(new Response()) }) },
  });
  expect(parseVaultV2EntryEnv(environment(namespace))?.CREDENTIAL_DIRECTORY_DO).toBe(namespace);
  expect(parseVaultV2EntryEnv(environment({}))).toBeUndefined();
  expect(
    parseVaultV2EntryEnv({
      ...environment(namespace),
      ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_CURRENT_SECRET: undefined,
    }),
  ).toBeUndefined();
  expect(
    parseVaultV2EntryEnv({
      ...environment(namespace),
      ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_CURRENT_SECRET: undefined,
    }),
  ).toBeUndefined();
});

test("entry composition caches only a successful construction and permits retry after invalid bindings", () => {
  const namespace = Object.create(null);
  Object.defineProperties(namespace, {
    idFromName: { value: () => ({ toString: () => "directory" }) },
    get: { value: () => ({ fetch: () => Promise.resolve(new Response()) }) },
  });
  const cache = makeVaultV2EntryCompositionCache();
  expect(
    cache({
      ...environment(namespace),
      ENCHIRIDION_V2_CREDENTIAL_QUOTA: "0",
    }),
  ).toBeUndefined();
  const first = cache(environment(namespace));
  const second = cache(environment(namespace));
  expect(first).toBeDefined();
  expect(second).toBe(first);
});

test("keeps issuer and capability secrets separate and constructs the default JOSE composition", () => {
  const namespace = Object.create(null);
  Object.defineProperties(namespace, {
    idFromName: { value: () => ({ toString: () => "directory" }) },
    get: { value: () => ({ fetch: () => Promise.resolve(new Response()) }) },
  });
  const parsed = parseVaultV2EntryEnv(environment(namespace));
  if (parsed === undefined) throw new Error("test setup invalid");
  expect(makeVaultV2EntryComposition(parsed)).toBeDefined();
  expect(
    makeVaultV2EntryComposition(
      parseVaultV2EntryEnv({
        ...environment(namespace),
        ENCHIRIDION_V2_DIRECTORY_CAPABILITY_CURRENT_SECRET:
          "issuer-secret-0123456789-abcdefghijklmno",
      }) ?? parsed,
    ),
  ).toBeUndefined();
});

test("requires exact immutable production limits and distinct structural R2 bindings", () => {
  const namespace = Object.create(null);
  Object.defineProperties(namespace, {
    idFromName: { value: () => ({ toString: () => "directory" }) },
    get: { value: () => ({ fetch: () => Promise.resolve(new Response()) }) },
  });
  const parsed = parseVaultV2EntryEnv(environment(namespace));
  if (parsed === undefined) throw new Error("test setup invalid");
  const authority = makeVaultV2EntryComposition(parsed)?.ownerVaultProduction;
  expect(authority).toBeDefined();
  expect(Object.isFrozen(authority?.limits)).toBe(true);
  expect(authority?.blobR2.purpose).toBe("owner-vault-blob-r2");
  expect(authority?.backupR2.purpose).toBe("owner-vault-backup-r2");
  expect(
    makeVaultV2EntryComposition({
      ...parsed,
      ENCHIRIDION_V2_OWNER_VAULT_LIMITS_JSON: limits.replace("24576", "32769"),
    }),
  ).toBeUndefined();
  expect(
    makeVaultV2EntryComposition({
      ...parsed,
      ENCHIRIDION_V2_OWNER_VAULT_LIMITS_JSON: limits.replace('"gcChunk":128', '"gcChunk":0'),
    }),
  ).toBeUndefined();
  expect(
    makeVaultV2EntryComposition({
      ...parsed,
      ENCHIRIDION_V2_OWNER_VAULT_LIMITS_JSON: limits.replace(
        '"stageTTLSeconds":900',
        '"stageTTLSeconds":0',
      ),
    }),
  ).toBeUndefined();
  expect(
    makeVaultV2EntryComposition({
      ...parsed,
      ENCHIRIDION_V2_OWNER_VAULT_LIMITS_JSON: limits.replace(
        '"maximumBlobBytes":8388608',
        '"maximumBlobBytes":8388609',
      ),
    }),
  ).toBeUndefined();
  expect(makeVaultV2EntryComposition({ ...parsed, BLOB_R2: parsed.BACKUP_R2 })).toBeUndefined();
  expect(makeVaultV2EntryComposition({ ...parsed, BLOB_R2: {} })).toBeUndefined();
});

test("validates manifest key pairing and rejects revoked active configuration without caching failure", () => {
  const namespace = Object.create(null);
  Object.defineProperties(namespace, {
    idFromName: { value: () => ({ toString: () => "directory" }) },
    get: { value: () => ({ fetch: () => Promise.resolve(new Response()) }) },
  });
  const raw = environment(namespace);
  const invalidKeyPair = makeVaultV2EntryComposition(
    parseVaultV2EntryEnv({ ...raw, ENCHIRIDION_V2_MANIFEST_CURRENT_SPKI_BASE64: "bad" })!,
  );
  const revoked = makeVaultV2EntryComposition(
    parseVaultV2EntryEnv({
      ...raw,
      ENCHIRIDION_V2_MANIFEST_REVOKED_KEY_IDS_JSON: '["manifest-current"]',
    })!,
  );
  const composed = makeVaultV2EntryCompositionCache()(raw);
  return Promise.all([
    Effect.runPromiseExit(
      invalidKeyPair?.ownerVaultProduction.manifestKeys() ?? Effect.die("missing"),
    ),
    Effect.runPromiseExit(revoked?.ownerVaultProduction.manifestKeys() ?? Effect.die("missing")),
    Effect.runPromise(composed?.ownerVaultProduction.manifestKeys() ?? Effect.die("missing")),
  ]).then(([invalid, revokedExit, ring]) => {
    expect(Exit.isFailure(invalid)).toBe(true);
    expect(Exit.isFailure(revokedExit)).toBe(true);
    expect(ring.current.keyID).toBe("manifest-current");
    return Effect.runPromise(composed!.ownerVaultProduction.manifestKeys()).then((retry) =>
      expect(retry).toBe(ring),
    );
  });
});

test("builds an isolated bounded socket-admission ring and retries only valid configuration", async () => {
  const namespace = Object.create(null);
  Object.defineProperties(namespace, {
    idFromName: { value: () => ({ toString: () => "directory" }) },
    get: { value: () => ({ fetch: () => Promise.resolve(new Response()) }) },
  });
  const raw = environment(namespace);
  const cache = makeVaultV2EntryCompositionCache();
  expect(
    cache({ ...raw, ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_CURRENT_SECRET: "too-short" }),
  ).toBeUndefined();
  expect(
    cache({
      ...raw,
      ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_PRIOR_KEYS_JSON:
        '[ {"keyID":"socket-prior","secret":"socket-admission-prior-secret-0123456789-abcdef"}]',
    }),
  ).toBeUndefined();
  expect(
    cache({
      ...raw,
      ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_REVOKED_KEY_IDS_JSON: '["socket-current"]',
    }),
  ).toBeUndefined();
  expect(
    cache({
      ...raw,
      ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_CURRENT_SECRET:
        raw.ENCHIRIDION_V2_DIRECTORY_CAPABILITY_CURRENT_SECRET,
    }),
  ).toBeUndefined();
  expect(
    cache({
      ...raw,
      ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_CURRENT_KEY_ID: "capability-current",
    }),
  ).toBeUndefined();
  expect(
    cache({
      ...raw,
      ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_PRIOR_KEYS_JSON:
        '[{"keyID":"socket-current","secret":"socket-admission-prior-secret-0123456789-abcdef"}]',
    }),
  ).toBeUndefined();
  expect(
    cache({
      ...raw,
      ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_PRIOR_KEYS_JSON:
        '[{"keyID":"socket-prior-a","secret":"socket-admission-prior-a-secret-0123456789-abcdef"},{"keyID":"socket-prior-b","secret":"socket-admission-prior-b-secret-0123456789-abcdef"},{"keyID":"socket-prior-c","secret":"socket-admission-prior-c-secret-0123456789-abcdef"}]',
    }),
  ).toBeUndefined();
  const composed = cache(raw);
  if (composed === undefined) throw new Error("test setup invalid");
  expect(composed.ownerVaultSocketAdmission.signer).not.toBe(composed.directoryControls.signer);
  expect(composed.ownerVaultDirectoryControls).toBeDefined();
  const retry = cache(raw);
  expect(retry).toBe(composed);
  expect(JSON.stringify(composed)).not.toContain("socket-admission-current-secret");
  expect(JSON.stringify(composed)).not.toContain("owner-control-current-secret");
});

test("keeps the ovdc1 control authority isolated from Directory and socket admission keys", () => {
  const namespace = Object.create(null);
  Object.defineProperties(namespace, {
    idFromName: { value: () => ({ toString: () => "directory" }) },
    get: { value: () => ({ fetch: () => Promise.resolve(new Response()) }) },
  });
  const raw = environment(namespace);
  const cache = makeVaultV2EntryCompositionCache();
  expect(
    cache({
      ...raw,
      ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_CURRENT_SECRET:
        raw.ENCHIRIDION_V2_DIRECTORY_CAPABILITY_CURRENT_SECRET,
    }),
  ).toBeUndefined();
  expect(
    cache({
      ...raw,
      ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_CURRENT_KEY_ID: "socket-current",
    }),
  ).toBeUndefined();
  expect(
    cache({
      ...raw,
      ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_PRIOR_KEYS_JSON:
        '[ {"keyID":"owner-control-prior","secret":"owner-control-prior-secret-0123456789-abcdef"}]',
    }),
  ).toBeUndefined();
  expect(
    cache({
      ...raw,
      ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_REVOKED_KEY_IDS_JSON:
        '["owner-control-current"]',
    }),
  ).toBeUndefined();
  expect(cache(raw)?.ownerVaultDirectoryControls).toBeDefined();
});

test("reuses the injected Access singleton across cold, kid rotation, cached operation, and expiry outage", async () => {
  const namespace = Object.create(null);
  Object.defineProperties(namespace, {
    idFromName: { value: () => ({ toString: () => "directory" }) },
    get: { value: () => ({ fetch: () => Promise.resolve(new Response()) }) },
  });
  const creations: boolean[] = [];
  const verified = (request: AccessJwtVerificationRequest): VerifiedAccessJwt => ({
    protectedHeader: { alg: "RS256", typ: "JWT", kid: "fixture" },
    claims: {
      iss: request.issuer,
      aud: request.audience,
      iat: request.nowSeconds - 1,
      nbf: request.nowSeconds - 1,
      exp: request.nowSeconds + 60,
      sub: "opaque-subject",
    },
  });
  const factory: AccessJwksSessionFactory = (_configuration, forceRefresh) =>
    Effect.sync(() => {
      creations.push(forceRefresh);
      const position = creations.length;
      return {
        verify: (request: AccessJwtVerificationRequest) =>
          position === 1
            ? Effect.fail(new AccessJwtVerificationError({ reason: "unknown_key" }))
            : position === 3
              ? Effect.fail(new AccessJwtVerificationError({ reason: "jwks_unavailable" }))
              : Effect.succeed(verified(request)),
      };
    });
  const cache = makeVaultV2EntryCompositionCache({ accessJwksSessionFactory: factory });
  const composition = cache(environment(namespace));
  if (composition === undefined) throw new Error("test setup invalid");
  const headers = accessAssertionHeadersFromWorkerHeaders(
    new Headers({
      "Cf-Access-Jwt-Assertion":
        "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImZpeHR1cmUifQ.eyJmaXh0dXJlIjp0cnVlfQ.fixture",
    }),
  );
  const initial = 1_760_000_000;
  expect(
    await Effect.runPromise(composition.assertionVerifier.verify(headers, initial)),
  ).toMatchObject({
    claims: { exp: initial + 60 },
  });
  expect(creations).toEqual([false, true]);
  expect(
    await Effect.runPromise(composition.assertionVerifier.verify(headers, initial + 1)),
  ).toMatchObject({
    claims: { exp: initial + 61 },
  });
  expect(creations).toEqual([false, true]);
  const expired = await Effect.runPromiseExit(
    composition.assertionVerifier.verify(headers, initial + 61),
  );
  expect(Exit.isFailure(expired)).toBe(true);
  expect(JSON.stringify(expired)).toContain("jwks_unavailable");
  expect(creations).toEqual([false, true, false]);
});
