import { expect, test } from "bun:test";
import { resolve } from "node:path";
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
import {
  ownerVaultProductionLimitsMatchEnforcement,
  parseOwnerVaultProductionLimits,
} from "./owner-vault-production";

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

test("rejects structurally invalid or revoked-active manifest configuration at composition time", async () => {
  const namespace = Object.create(null);
  Object.defineProperties(namespace, {
    idFromName: { value: () => ({ toString: () => "directory" }) },
    get: { value: () => ({ fetch: () => Promise.resolve(new Response()) }) },
  });
  const raw = environment(namespace);
  const invalidKeyPairEnvironment = parseVaultV2EntryEnv({
    ...raw,
    ENCHIRIDION_V2_MANIFEST_CURRENT_SPKI_BASE64: "bad",
  });
  if (invalidKeyPairEnvironment === undefined) throw new Error("test setup invalid");
  /** A malformed or revoked-active ring is a construction failure, not a
   * deferred first-backup failure: the isolate never composes at all. */
  expect(makeVaultV2EntryComposition(invalidKeyPairEnvironment)).toBeUndefined();
  const revokedEnvironment = parseVaultV2EntryEnv({
    ...raw,
    ENCHIRIDION_V2_MANIFEST_REVOKED_KEY_IDS_JSON: '["manifest-current"]',
  });
  if (revokedEnvironment === undefined) throw new Error("test setup invalid");
  expect(makeVaultV2EntryComposition(revokedEnvironment)).toBeUndefined();
  const composed = makeVaultV2EntryCompositionCache()(raw);
  if (composed === undefined) throw new Error("test setup invalid");
  const ring = await Effect.runPromise(composed.ownerVaultProduction.manifestKeys());
  expect(ring.current.keyID).toBe("manifest-current");
  /** The eager composition-time validation is cached; use replays it. */
  const retry = await Effect.runPromise(composed.ownerVaultProduction.manifestKeys());
  expect(retry).toBe(ring);
  /** PKCS8 secret material never appears in the composed object graph. */
  expect(JSON.stringify(composed)).not.toContain(manifestPrivate.slice(0, 24));
});

test("keeps PKCS8 and admission secrets out of production Wrangler vars and pins vars limits to enforcement", async () => {
  const jsonc = (source: string): unknown =>
    JSON.parse(
      source
        .split("\n")
        .filter((line) => !/^\s*\/\//u.test(line))
        .join("\n"),
    );
  const production = jsonc(
    await Bun.file(resolve(import.meta.dir, "../../../wrangler.v2.jsonc")).text(),
  );
  const vars =
    typeof production === "object" && production !== null && "vars" in production
      ? production.vars
      : undefined;
  if (typeof vars !== "object" || vars === null) throw new Error("test setup invalid");
  const varNames = Object.keys(vars);
  /** Secret-only bindings must be provisioned as Wrangler secrets, never vars. */
  for (const secretBinding of [
    "ENCHIRIDION_V2_MANIFEST_CURRENT_PKCS8_BASE64",
    "ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_CURRENT_SECRET",
    "ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_PRIOR_KEYS_JSON",
    "ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_CURRENT_SECRET",
    "ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_PRIOR_KEYS_JSON",
    "ENCHIRIDION_V2_CREDENTIAL_BINDING_CURRENT_SECRET",
    "ENCHIRIDION_V2_DIRECTORY_CAPABILITY_CURRENT_SECRET",
  ]) {
    expect(varNames).not.toContain(secretBinding);
  }
  /** The deployed limits JSON must be the exact single production authority. */
  const configuredLimits = Object.entries(vars).find(
    ([name]) => name === "ENCHIRIDION_V2_OWNER_VAULT_LIMITS_JSON",
  )?.[1];
  if (typeof configuredLimits !== "string") throw new Error("test setup invalid");
  const parsedLimits = parseOwnerVaultProductionLimits(configuredLimits);
  expect(parsedLimits).toBeDefined();
  if (parsedLimits !== undefined)
    expect(ownerVaultProductionLimitsMatchEnforcement(parsedLimits)).toBe(true);
  /** Workerd harness configs must stay pinned to the same enforced caps. */
  for (const path of [
    "./wrangler.directory-workerd-test.jsonc",
    "../owner-vault/wrangler.owner-vault-workerd-test.jsonc",
  ]) {
    const harness = jsonc(await Bun.file(resolve(import.meta.dir, path)).text());
    const harnessVars =
      typeof harness === "object" && harness !== null && "vars" in harness
        ? harness.vars
        : undefined;
    if (typeof harnessVars !== "object" || harnessVars === null)
      throw new Error("test setup invalid");
    const harnessLimits = Object.entries(harnessVars).find(
      ([name]) => name === "ENCHIRIDION_V2_OWNER_VAULT_LIMITS_JSON",
    )?.[1];
    if (typeof harnessLimits !== "string") throw new Error("test setup invalid");
    const parsedHarnessLimits = parseOwnerVaultProductionLimits(harnessLimits);
    expect(parsedHarnessLimits).toBeDefined();
    if (parsedHarnessLimits !== undefined)
      expect(ownerVaultProductionLimitsMatchEnforcement(parsedHarnessLimits)).toBe(true);
  }
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

test("rejects malformed individual prior key pairs while accepting exact ones", () => {
  const namespace = Object.create(null);
  Object.defineProperties(namespace, {
    idFromName: { value: () => ({ toString: () => "directory" }) },
    get: { value: () => ({ fetch: () => Promise.resolve(new Response()) }) },
  });
  const raw = environment(namespace);
  const cache = makeVaultV2EntryCompositionCache();
  const socketShapes = [
    '[{"keyID":"socket-prior"}]',
    '[{"secret":"socket-admission-prior-secret-0123456789-abcdef"}]',
    '[{"keyID":"socket-prior","secret":"socket-admission-prior-secret-0123456789-abcdef","extra":"x"}]',
    '[{"keyID":123,"secret":"socket-admission-prior-secret-0123456789-abcdef"}]',
    '[{"keyID":"socket-prior","secret":123}]',
    '[{"keyID":"bad key!","secret":"socket-admission-prior-secret-0123456789-abcdef"}]',
    '[{"keyID":"socket-prior","secret":"socket-admission-prior-secret-0123456789-abcdef"},{"keyID":"socket-prior","secret":"socket-admission-prior-secret-0123456789-abcdef"}]',
    '["socket-prior"]',
  ];
  for (const shape of socketShapes) {
    expect(
      cache({ ...raw, ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_PRIOR_KEYS_JSON: shape }),
    ).toBeUndefined();
  }
  const controlShapes = [
    '[{"keyID":"owner-control-prior"}]',
    '[{"keyID":"owner-control-prior","secret":"owner-control-prior-secret-0123456789-abcdef","extra":"x"}]',
    '[{"keyID":123,"secret":"owner-control-prior-secret-0123456789-abcdef"}]',
    '[{"keyID":"owner-control-prior","secret":123}]',
    '[{"keyID":"owner-control-prior","secret":"owner-control-prior-secret-0123456789-abcdef"},{"keyID":"owner-control-prior","secret":"owner-control-prior-secret-0123456789-abcdef"}]',
  ];
  for (const shape of controlShapes) {
    expect(
      cache({ ...raw, ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_PRIOR_KEYS_JSON: shape }),
    ).toBeUndefined();
  }
  const composed = cache({
    ...raw,
    ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_PRIOR_KEYS_JSON:
      '[{"keyID":"socket-prior","secret":"socket-admission-prior-secret-0123456789-abcdef"}]',
    ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_PRIOR_KEYS_JSON:
      '[{"keyID":"owner-control-prior","secret":"owner-control-prior-secret-0123456789-abcdef"}]',
  });
  expect(composed).toBeDefined();
  expect(composed?.ownerVaultSocketAdmission).toBeDefined();
  expect(composed?.ownerVaultDirectoryControls).toBeDefined();
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
