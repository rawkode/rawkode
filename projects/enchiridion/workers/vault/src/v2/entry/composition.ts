/** @enchiridion/effect-module */
import {
  type AccessJwksSessionFactory,
  AccessJwtVerifier,
  type CapabilityConfigurationError,
  type CapabilitySigningError,
  type CapabilityVerificationError,
  type DurableObjectNamespaceNative,
  type OwnerVaultDirectoryControlClaims,
  type OwnerVaultDirectoryControlClaimsInput,
  type OwnerVaultDirectoryControlExpectation,
  type OwnerVaultDirectoryControlRequestBinding,
  type OwnerVaultSocketAdmissionSigner,
  type OwnerVaultSocketAdmissionVerifier,
  P256Crypto,
  type SignedOwnerVaultDirectoryControl,
  makeAccessJwtVerifier,
  makeOwnerVaultDirectoryControlKeyRing,
  makeOwnerVaultSocketAdmissionKeyRing,
  makeOwnerVaultSocketAdmissionSigner,
  makeOwnerVaultSocketAdmissionVerifier,
  makeP256Crypto,
  maximumPriorOwnerVaultDirectoryControlKeys,
  maximumPriorOwnerVaultSocketAdmissionKeys,
  signOwnerVaultDirectoryControl,
  verifyOwnerVaultDirectoryControl,
} from "@enchiridion/runtime";
import { Effect, Redacted } from "effect";
import {
  type OwnerVaultInitializationClient,
  makeOwnerVaultInitializationClient,
} from "../directory/lifecycle";
import { makeDirectorySecureRandom } from "../directory/service";
import type { DirectorySecureRandom } from "../directory/types";
import { type AccessAssertionVerifier, makeAccessAssertionVerifier } from "../foundation/access";
import { VaultV2Config, type VaultV2ConfigInput, makeVaultV2Config } from "../foundation/config";
import {
  type DirectoryControlCapabilityFactory,
  type InternalCapabilityFactory,
  type VersionedIssuerHasher,
  makeDirectoryControlCapabilityFactory,
  makeInternalCapabilityFactory,
  makeVersionedIssuerHasher,
} from "../foundation/crypto";
import { VaultV2Metrics } from "../foundation/metrics";
import {
  type OwnerVaultProductionAuthority,
  makeOwnerVaultProductionAuthority,
} from "./owner-vault-production";

/** The only v2 production bindings. Values are validated before use and never logged. */
export interface VaultV2EntryEnv {
  readonly ENCHIRIDION_V2_ACCESS_TEAM_DOMAIN: string;
  readonly ENCHIRIDION_V2_ACCESS_AUDIENCE: string;
  readonly ENCHIRIDION_V2_ACCESS_JWKS_CACHE_TTL_SECONDS: string;
  readonly ENCHIRIDION_V2_ACCESS_JWKS_REFRESH_COOLDOWN_SECONDS: string;
  readonly ENCHIRIDION_V2_ACCESS_MAXIMUM_ASSERTION_LIFETIME_SECONDS: string;
  readonly ENCHIRIDION_V2_CREDENTIAL_BINDING_CURRENT_KEY_ID: string;
  readonly ENCHIRIDION_V2_CREDENTIAL_BINDING_CURRENT_SECRET: string;
  /** JSON array of `{ keyID, secret }`; it must include the current key exactly once. */
  readonly ENCHIRIDION_V2_CREDENTIAL_BINDING_READ_KEYS_JSON: string;
  readonly ENCHIRIDION_V2_DIRECTORY_CAPABILITY_CURRENT_KEY_ID: string;
  readonly ENCHIRIDION_V2_DIRECTORY_CAPABILITY_CURRENT_SECRET: string;
  /** JSON array of `{ keyID, secret }`; retained prior capability keys only. */
  readonly ENCHIRIDION_V2_DIRECTORY_CAPABILITY_PRIOR_KEYS_JSON: string;
  readonly ENCHIRIDION_V2_CREDENTIAL_QUOTA: string;
  /** Exact public production cap set; no per-provider fallback is permitted. */
  readonly ENCHIRIDION_V2_OWNER_VAULT_LIMITS_JSON: string;
  readonly ENCHIRIDION_V2_MANIFEST_CURRENT_KEY_ID: string;
  /** Secret-only binding: canonical P-256 PKCS#8, never a Wrangler var. */
  readonly ENCHIRIDION_V2_MANIFEST_CURRENT_PKCS8_BASE64: string;
  readonly ENCHIRIDION_V2_MANIFEST_CURRENT_SPKI_BASE64: string;
  readonly ENCHIRIDION_V2_MANIFEST_PRIOR_KEYS_JSON: string;
  readonly ENCHIRIDION_V2_MANIFEST_REVOKED_KEY_IDS_JSON: string;
  /** Public identifier; current material is supplied through a Wrangler secret. */
  readonly ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_CURRENT_KEY_ID: string;
  readonly ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_CURRENT_SECRET: string;
  /** Canonical secret JSON array of `{ keyID, secret }`; never a plaintext Wrangler var. */
  readonly ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_PRIOR_KEYS_JSON: string;
  readonly ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_REVOKED_KEY_IDS_JSON: string;
  /** Public identifier; current material is supplied through a Wrangler secret. */
  readonly ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_CURRENT_KEY_ID: string;
  /** Secret-only key material; never a plaintext Wrangler var. */
  readonly ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_CURRENT_SECRET: string;
  /** Canonical secret JSON array of `{ keyID, secret }`; never a plaintext Wrangler var. */
  readonly ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_PRIOR_KEYS_JSON: string;
  readonly ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_REVOKED_KEY_IDS_JSON: string;
  readonly CREDENTIAL_DIRECTORY_DO: DurableObjectNamespaceNative;
  /** Target-only binding; P06-05 supplies the OwnerVaultV2 implementation. */
  readonly OWNER_VAULT_V2_DO: DurableObjectNamespaceNative;
  readonly BLOB_R2: unknown;
  readonly BACKUP_R2: unknown;
}

interface RawKey {
  readonly keyID: string;
  readonly secret: string;
}

interface RawSocketAdmissionKey extends RawKey {}
const socketKeyID = /^[A-Za-z0-9_-]{1,64}$/u;
const minimumSocketSecretBytes = 32;
const maximumSocketSecretBytes = 4_096;
const maximumRevokedSocketKeys = 32;

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;

const stringField = (
  source: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
};

const isDirectoryNamespace = (value: unknown): value is DurableObjectNamespaceNative => {
  try {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof Reflect.get(value, "idFromName") === "function" &&
      typeof Reflect.get(value, "get") === "function"
    );
  } catch {
    return false;
  }
};

/** Exact runtime binding parser. No untyped Worker env value reaches composition. */
export const parseVaultV2EntryEnv = (value: unknown): VaultV2EntryEnv | undefined => {
  try {
    const source = record(value);
    if (source === undefined) return undefined;
    const teamDomain = stringField(source, "ENCHIRIDION_V2_ACCESS_TEAM_DOMAIN");
    const audience = stringField(source, "ENCHIRIDION_V2_ACCESS_AUDIENCE");
    const cacheTTL = stringField(source, "ENCHIRIDION_V2_ACCESS_JWKS_CACHE_TTL_SECONDS");
    const cooldown = stringField(source, "ENCHIRIDION_V2_ACCESS_JWKS_REFRESH_COOLDOWN_SECONDS");
    const maximumLifetime = stringField(
      source,
      "ENCHIRIDION_V2_ACCESS_MAXIMUM_ASSERTION_LIFETIME_SECONDS",
    );
    const issuerKeyID = stringField(source, "ENCHIRIDION_V2_CREDENTIAL_BINDING_CURRENT_KEY_ID");
    const issuerSecret = stringField(source, "ENCHIRIDION_V2_CREDENTIAL_BINDING_CURRENT_SECRET");
    const issuerReads = stringField(source, "ENCHIRIDION_V2_CREDENTIAL_BINDING_READ_KEYS_JSON");
    const capabilityKeyID = stringField(
      source,
      "ENCHIRIDION_V2_DIRECTORY_CAPABILITY_CURRENT_KEY_ID",
    );
    const capabilitySecret = stringField(
      source,
      "ENCHIRIDION_V2_DIRECTORY_CAPABILITY_CURRENT_SECRET",
    );
    const capabilityPriors = stringField(
      source,
      "ENCHIRIDION_V2_DIRECTORY_CAPABILITY_PRIOR_KEYS_JSON",
    );
    const quota = stringField(source, "ENCHIRIDION_V2_CREDENTIAL_QUOTA");
    const limits = stringField(source, "ENCHIRIDION_V2_OWNER_VAULT_LIMITS_JSON");
    const manifestKeyID = stringField(source, "ENCHIRIDION_V2_MANIFEST_CURRENT_KEY_ID");
    const manifestPKCS8 = stringField(source, "ENCHIRIDION_V2_MANIFEST_CURRENT_PKCS8_BASE64");
    const manifestSPKI = stringField(source, "ENCHIRIDION_V2_MANIFEST_CURRENT_SPKI_BASE64");
    const manifestPrior = stringField(source, "ENCHIRIDION_V2_MANIFEST_PRIOR_KEYS_JSON");
    const manifestRevoked = stringField(source, "ENCHIRIDION_V2_MANIFEST_REVOKED_KEY_IDS_JSON");
    const socketCurrentKeyID = stringField(
      source,
      "ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_CURRENT_KEY_ID",
    );
    const socketCurrentSecret = stringField(
      source,
      "ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_CURRENT_SECRET",
    );
    const socketPrior = stringField(
      source,
      "ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_PRIOR_KEYS_JSON",
    );
    const socketRevoked = stringField(
      source,
      "ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_REVOKED_KEY_IDS_JSON",
    );
    const ownerVaultControlCurrentKeyID = stringField(
      source,
      "ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_CURRENT_KEY_ID",
    );
    const ownerVaultControlCurrentSecret = stringField(
      source,
      "ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_CURRENT_SECRET",
    );
    const ownerVaultControlPrior = stringField(
      source,
      "ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_PRIOR_KEYS_JSON",
    );
    const ownerVaultControlRevoked = stringField(
      source,
      "ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_REVOKED_KEY_IDS_JSON",
    );
    const directory = source.CREDENTIAL_DIRECTORY_DO;
    const ownerVault = source.OWNER_VAULT_V2_DO;
    if (
      teamDomain === undefined ||
      audience === undefined ||
      cacheTTL === undefined ||
      cooldown === undefined ||
      maximumLifetime === undefined ||
      issuerKeyID === undefined ||
      issuerSecret === undefined ||
      issuerReads === undefined ||
      capabilityKeyID === undefined ||
      capabilitySecret === undefined ||
      capabilityPriors === undefined ||
      quota === undefined ||
      limits === undefined ||
      manifestKeyID === undefined ||
      manifestPKCS8 === undefined ||
      manifestSPKI === undefined ||
      manifestPrior === undefined ||
      manifestRevoked === undefined ||
      socketCurrentKeyID === undefined ||
      socketCurrentSecret === undefined ||
      socketPrior === undefined ||
      socketRevoked === undefined ||
      ownerVaultControlCurrentKeyID === undefined ||
      ownerVaultControlCurrentSecret === undefined ||
      ownerVaultControlPrior === undefined ||
      ownerVaultControlRevoked === undefined ||
      !isDirectoryNamespace(directory) ||
      !isDirectoryNamespace(ownerVault)
    )
      return undefined;
    return {
      ENCHIRIDION_V2_ACCESS_TEAM_DOMAIN: teamDomain,
      ENCHIRIDION_V2_ACCESS_AUDIENCE: audience,
      ENCHIRIDION_V2_ACCESS_JWKS_CACHE_TTL_SECONDS: cacheTTL,
      ENCHIRIDION_V2_ACCESS_JWKS_REFRESH_COOLDOWN_SECONDS: cooldown,
      ENCHIRIDION_V2_ACCESS_MAXIMUM_ASSERTION_LIFETIME_SECONDS: maximumLifetime,
      ENCHIRIDION_V2_CREDENTIAL_BINDING_CURRENT_KEY_ID: issuerKeyID,
      ENCHIRIDION_V2_CREDENTIAL_BINDING_CURRENT_SECRET: issuerSecret,
      ENCHIRIDION_V2_CREDENTIAL_BINDING_READ_KEYS_JSON: issuerReads,
      ENCHIRIDION_V2_DIRECTORY_CAPABILITY_CURRENT_KEY_ID: capabilityKeyID,
      ENCHIRIDION_V2_DIRECTORY_CAPABILITY_CURRENT_SECRET: capabilitySecret,
      ENCHIRIDION_V2_DIRECTORY_CAPABILITY_PRIOR_KEYS_JSON: capabilityPriors,
      ENCHIRIDION_V2_CREDENTIAL_QUOTA: quota,
      ENCHIRIDION_V2_OWNER_VAULT_LIMITS_JSON: limits,
      ENCHIRIDION_V2_MANIFEST_CURRENT_KEY_ID: manifestKeyID,
      ENCHIRIDION_V2_MANIFEST_CURRENT_PKCS8_BASE64: manifestPKCS8,
      ENCHIRIDION_V2_MANIFEST_CURRENT_SPKI_BASE64: manifestSPKI,
      ENCHIRIDION_V2_MANIFEST_PRIOR_KEYS_JSON: manifestPrior,
      ENCHIRIDION_V2_MANIFEST_REVOKED_KEY_IDS_JSON: manifestRevoked,
      ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_CURRENT_KEY_ID: socketCurrentKeyID,
      ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_CURRENT_SECRET: socketCurrentSecret,
      ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_PRIOR_KEYS_JSON: socketPrior,
      ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_REVOKED_KEY_IDS_JSON: socketRevoked,
      ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_CURRENT_KEY_ID: ownerVaultControlCurrentKeyID,
      ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_CURRENT_SECRET: ownerVaultControlCurrentSecret,
      ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_PRIOR_KEYS_JSON: ownerVaultControlPrior,
      ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_REVOKED_KEY_IDS_JSON: ownerVaultControlRevoked,
      CREDENTIAL_DIRECTORY_DO: directory,
      OWNER_VAULT_V2_DO: ownerVault,
      BLOB_R2: source.BLOB_R2,
      BACKUP_R2: source.BACKUP_R2,
    };
  } catch {
    return undefined;
  }
};

const parseInteger = (value: string): number | undefined =>
  /^(?:0|[1-9][0-9]{0,9})$/u.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : undefined;

const parseKeys = (source: string): readonly RawKey[] | undefined => {
  try {
    const value = JSON.parse(source);
    if (!Array.isArray(value)) return undefined;
    const keys: RawKey[] = [];
    for (const item of value) {
      const key = record(item);
      if (
        key === undefined ||
        Object.keys(key).length !== 2 ||
        typeof key.keyID !== "string" ||
        typeof key.secret !== "string"
      )
        return undefined;
      keys.push({ keyID: key.keyID, secret: key.secret });
    }
    return keys;
  } catch {
    return undefined;
  }
};

const socketSecret = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const bytes = new TextEncoder().encode(value);
  return (
    bytes.byteLength >= minimumSocketSecretBytes &&
    bytes.byteLength <= maximumSocketSecretBytes &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x21 && code <= 0x7e;
    })
  );
};

/** Secret key JSON must be byte-canonical so distinct secret spellings cannot share an authority. */
const parseSocketAdmissionPriorKeys = (
  source: string,
): readonly RawSocketAdmissionKey[] | undefined => {
  try {
    const value = JSON.parse(source);
    if (
      !Array.isArray(value) ||
      JSON.stringify(value) !== source ||
      value.length > maximumPriorOwnerVaultSocketAdmissionKeys
    )
      return undefined;
    const keys: RawSocketAdmissionKey[] = [];
    for (const item of value) {
      const key = record(item);
      if (
        key === undefined ||
        !exactKeyPair(key) ||
        !socketKeyID.test(key.keyID as string) ||
        !socketSecret(key.secret)
      )
        return undefined;
      keys.push({ keyID: key.keyID as string, secret: key.secret as string });
    }
    return keys;
  } catch {
    return undefined;
  }
};

const parseOwnerVaultDirectoryControlPriorKeys = (
  source: string,
): readonly RawSocketAdmissionKey[] | undefined => {
  try {
    const value = JSON.parse(source);
    if (
      !Array.isArray(value) ||
      JSON.stringify(value) !== source ||
      value.length > maximumPriorOwnerVaultDirectoryControlKeys
    )
      return undefined;
    const keys: RawSocketAdmissionKey[] = [];
    for (const item of value) {
      const key = record(item);
      if (
        key === undefined ||
        !exactKeyPair(key) ||
        !socketKeyID.test(key.keyID as string) ||
        !socketSecret(key.secret)
      )
        return undefined;
      keys.push({ keyID: key.keyID as string, secret: key.secret as string });
    }
    return keys;
  } catch {
    return undefined;
  }
};

const exactKeyPair = (value: Readonly<Record<string, unknown>>): boolean =>
  Object.keys(value).length === 2 &&
  Object.hasOwn(value, "keyID") &&
  Object.hasOwn(value, "secret") &&
  typeof value.keyID === "string" &&
  typeof value.secret === "string";

const parseSocketAdmissionRevokedKeyIDs = (source: string): readonly string[] | undefined => {
  try {
    const value = JSON.parse(source);
    return Array.isArray(value) &&
      JSON.stringify(value) === source &&
      value.length <= maximumRevokedSocketKeys &&
      value.every((key): key is string => typeof key === "string" && socketKeyID.test(key)) &&
      new Set(value).size === value.length
      ? value
      : undefined;
  } catch {
    return undefined;
  }
};

const distinctSocketAdmissionMaterial = (
  current: RawSocketAdmissionKey,
  prior: readonly RawSocketAdmissionKey[],
  revoked: readonly string[],
  directoryCurrentKeyID: string,
  directoryCurrentSecret: string,
  directoryPrior: readonly RawKey[],
): boolean => {
  const keys = [current, ...prior];
  const directoryIDs = [directoryCurrentKeyID, ...directoryPrior.map((entry) => entry.keyID)];
  const directorySecrets = [directoryCurrentSecret, ...directoryPrior.map((entry) => entry.secret)];
  return (
    socketKeyID.test(current.keyID) &&
    socketSecret(current.secret) &&
    new Set(keys.map((entry) => entry.keyID)).size === keys.length &&
    new Set(keys.map((entry) => entry.secret)).size === keys.length &&
    !keys.some(
      (entry) =>
        revoked.includes(entry.keyID) ||
        directoryIDs.includes(entry.keyID) ||
        directorySecrets.includes(entry.secret),
    )
  );
};

const configInput = (env: VaultV2EntryEnv): VaultV2ConfigInput | undefined => {
  const cacheTTL = parseInteger(env.ENCHIRIDION_V2_ACCESS_JWKS_CACHE_TTL_SECONDS);
  const cooldown = parseInteger(env.ENCHIRIDION_V2_ACCESS_JWKS_REFRESH_COOLDOWN_SECONDS);
  const maximumLifetime = parseInteger(
    env.ENCHIRIDION_V2_ACCESS_MAXIMUM_ASSERTION_LIFETIME_SECONDS,
  );
  const quota = parseInteger(env.ENCHIRIDION_V2_CREDENTIAL_QUOTA);
  const reads = parseKeys(env.ENCHIRIDION_V2_CREDENTIAL_BINDING_READ_KEYS_JSON);
  const priors = parseKeys(env.ENCHIRIDION_V2_DIRECTORY_CAPABILITY_PRIOR_KEYS_JSON);
  if (
    cacheTTL === undefined ||
    cooldown === undefined ||
    maximumLifetime === undefined ||
    quota === undefined ||
    reads === undefined ||
    priors === undefined
  )
    return undefined;
  return {
    access: {
      teamDomain: env.ENCHIRIDION_V2_ACCESS_TEAM_DOMAIN,
      jwksURL: `https://${env.ENCHIRIDION_V2_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`,
      applicationAudience: env.ENCHIRIDION_V2_ACCESS_AUDIENCE,
      jwksCacheTTLSeconds: cacheTTL,
      jwksRefreshCooldownSeconds: cooldown,
      maximumAssertionLifetimeSeconds: maximumLifetime,
    },
    issuerWriteKey: {
      keyID: env.ENCHIRIDION_V2_CREDENTIAL_BINDING_CURRENT_KEY_ID,
      secret: Redacted.make(env.ENCHIRIDION_V2_CREDENTIAL_BINDING_CURRENT_SECRET),
    },
    issuerReadKeys: reads.map((key) => ({ keyID: key.keyID, secret: Redacted.make(key.secret) })),
    capabilityKeys: {
      current: {
        keyID: env.ENCHIRIDION_V2_DIRECTORY_CAPABILITY_CURRENT_KEY_ID,
        secret: Redacted.make(env.ENCHIRIDION_V2_DIRECTORY_CAPABILITY_CURRENT_SECRET),
      },
      prior: priors.map((key) => ({ keyID: key.keyID, secret: Redacted.make(key.secret) })),
    },
    credentialQuota: quota,
  };
};

export interface OwnerVaultSocketAdmissionFactory {
  readonly signer: OwnerVaultSocketAdmissionSigner;
  readonly verifier: OwnerVaultSocketAdmissionVerifier;
}

/** Fixed ovdc1 verifier/signer; the HMAC ring never escapes isolate composition. */
export interface OwnerVaultDirectoryControlFactory {
  readonly sign: (
    input: OwnerVaultDirectoryControlClaimsInput,
    nowSeconds: number,
  ) => Effect.Effect<
    SignedOwnerVaultDirectoryControl,
    CapabilityConfigurationError | CapabilitySigningError
  >;
  readonly verify: (
    signed: SignedOwnerVaultDirectoryControl,
    binding: OwnerVaultDirectoryControlRequestBinding,
    expected: OwnerVaultDirectoryControlExpectation,
    nowSeconds: number,
  ) => Effect.Effect<
    OwnerVaultDirectoryControlClaims,
    CapabilityConfigurationError | CapabilityVerificationError
  >;
}

/**
 * The socket ring is deliberately constructed apart from `VaultV2Config`:
 * runtime rejects generic/Directory capability material at its own boundary,
 * and this parser additionally rejects secret substitution before caching.
 */
const makeOwnerVaultSocketAdmissionFactory = (
  env: VaultV2EntryEnv,
  directoryPrior: readonly RawKey[],
): Effect.Effect<OwnerVaultSocketAdmissionFactory, CapabilityConfigurationError> => {
  const prior = parseSocketAdmissionPriorKeys(
    env.ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_PRIOR_KEYS_JSON,
  );
  const revoked = parseSocketAdmissionRevokedKeyIDs(
    env.ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_REVOKED_KEY_IDS_JSON,
  );
  const current: RawSocketAdmissionKey = {
    keyID: env.ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_CURRENT_KEY_ID,
    secret: env.ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_CURRENT_SECRET,
  };
  if (
    prior === undefined ||
    revoked === undefined ||
    !distinctSocketAdmissionMaterial(
      current,
      prior,
      revoked,
      env.ENCHIRIDION_V2_DIRECTORY_CAPABILITY_CURRENT_KEY_ID,
      env.ENCHIRIDION_V2_DIRECTORY_CAPABILITY_CURRENT_SECRET,
      directoryPrior,
    )
  )
    return Effect.die("owner_vault_socket_admission_configuration_invalid");
  return makeOwnerVaultSocketAdmissionKeyRing({
    current: { keyID: current.keyID, secret: Redacted.make(current.secret) },
    prior: prior.map((key) => ({ keyID: key.keyID, secret: Redacted.make(key.secret) })),
    revokedKeyIDs: revoked,
  }).pipe(
    Effect.map((keyRing) =>
      Object.freeze({
        signer: makeOwnerVaultSocketAdmissionSigner(keyRing),
        verifier: makeOwnerVaultSocketAdmissionVerifier(keyRing),
      }),
    ),
  );
};

const makeOwnerVaultDirectoryControlFactory = (
  env: VaultV2EntryEnv,
  directoryPrior: readonly RawKey[],
  socketCurrent: RawSocketAdmissionKey,
  socketPrior: readonly RawSocketAdmissionKey[],
): Effect.Effect<OwnerVaultDirectoryControlFactory, CapabilityConfigurationError> => {
  const prior = parseOwnerVaultDirectoryControlPriorKeys(
    env.ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_PRIOR_KEYS_JSON,
  );
  const revoked = parseSocketAdmissionRevokedKeyIDs(
    env.ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_REVOKED_KEY_IDS_JSON,
  );
  const current: RawSocketAdmissionKey = {
    keyID: env.ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_CURRENT_KEY_ID,
    secret: env.ENCHIRIDION_V2_OWNER_VAULT_DIRECTORY_CONTROL_CURRENT_SECRET,
  };
  const active = prior === undefined ? [] : [current, ...prior];
  const disjoint =
    prior !== undefined &&
    revoked !== undefined &&
    distinctSocketAdmissionMaterial(
      current,
      prior,
      revoked,
      env.ENCHIRIDION_V2_DIRECTORY_CAPABILITY_CURRENT_KEY_ID,
      env.ENCHIRIDION_V2_DIRECTORY_CAPABILITY_CURRENT_SECRET,
      [...directoryPrior, socketCurrent, ...socketPrior],
    ) &&
    !active.some(
      (entry) =>
        entry.keyID === socketCurrent.keyID ||
        entry.secret === socketCurrent.secret ||
        socketPrior.some(
          (socket) => socket.keyID === entry.keyID || socket.secret === entry.secret,
        ),
    );
  if (!disjoint) return Effect.die("owner_vault_directory_control_configuration_invalid");
  return makeOwnerVaultDirectoryControlKeyRing({
    current: { keyID: current.keyID, secret: Redacted.make(current.secret) },
    prior: prior.map((key) => ({ keyID: key.keyID, secret: Redacted.make(key.secret) })),
    revokedKeyIDs: revoked,
  }).pipe(
    Effect.map((keyRing) =>
      Object.freeze({
        sign: (input: OwnerVaultDirectoryControlClaimsInput, nowSeconds: number) =>
          signOwnerVaultDirectoryControl(input, keyRing, nowSeconds),
        verify: (
          signed: SignedOwnerVaultDirectoryControl,
          binding: OwnerVaultDirectoryControlRequestBinding,
          expected: OwnerVaultDirectoryControlExpectation,
          nowSeconds: number,
        ) => verifyOwnerVaultDirectoryControl(signed, binding, expected, keyRing, nowSeconds),
      }),
    ),
  );
};

export interface VaultV2EntryComposition {
  readonly assertionVerifier: AccessAssertionVerifier;
  readonly issuerHasher: VersionedIssuerHasher;
  readonly capabilities: InternalCapabilityFactory;
  readonly directoryControls: DirectoryControlCapabilityFactory;
  readonly random: DirectorySecureRandom;
  readonly ownerVaultInitialization: OwnerVaultInitializationClient;
  /** The sole config authority handed to future OwnerVault provider wiring. */
  readonly ownerVaultProduction: OwnerVaultProductionAuthority;
  readonly ownerVaultSocketAdmission: OwnerVaultSocketAdmissionFactory;
  readonly ownerVaultDirectoryControls: OwnerVaultDirectoryControlFactory;
}

/**
 * The entry has one deliberately narrow test seam.  It substitutes only the
 * runtime JWKS-session constructor; the Access assertion policy, credential
 * derivation, capability keys, and Directory implementation remain the
 * production code paths.
 */
export interface VaultV2EntryCompositionOptions {
  readonly accessJwksSessionFactory?: AccessJwksSessionFactory;
}

const metrics = { increment: () => Effect.void } as const;

/**
 * Constructs all authority objects once per isolate. The only injectable seam
 * is the runtime JWKS factory (inside `makeAccessJwtVerifier`); production
 * uses its audited default and has no credential fallback.
 */
export const makeVaultV2EntryComposition = (
  env: VaultV2EntryEnv,
  options: VaultV2EntryCompositionOptions = {},
): VaultV2EntryComposition | undefined => {
  const input = configInput(env);
  const directoryPrior = parseKeys(env.ENCHIRIDION_V2_DIRECTORY_CAPABILITY_PRIOR_KEYS_JSON);
  if (input === undefined || directoryPrior === undefined) return undefined;
  try {
    const ownerVaultProduction = makeOwnerVaultProductionAuthority({
      limitsJSON: env.ENCHIRIDION_V2_OWNER_VAULT_LIMITS_JSON,
      blobR2: env.BLOB_R2,
      backupR2: env.BACKUP_R2,
      manifestCurrentKeyID: env.ENCHIRIDION_V2_MANIFEST_CURRENT_KEY_ID,
      manifestCurrentPKCS8: env.ENCHIRIDION_V2_MANIFEST_CURRENT_PKCS8_BASE64,
      manifestCurrentSPKI: env.ENCHIRIDION_V2_MANIFEST_CURRENT_SPKI_BASE64,
      manifestPriorKeysJSON: env.ENCHIRIDION_V2_MANIFEST_PRIOR_KEYS_JSON,
      manifestRevokedKeyIDsJSON: env.ENCHIRIDION_V2_MANIFEST_REVOKED_KEY_IDS_JSON,
    });
    if (ownerVaultProduction === undefined) return undefined;
    const config = Effect.runSync(makeVaultV2Config(input));
    const runtimeVerifier = Effect.runSync(
      makeAccessJwtVerifier(
        {
          jwksURL: config.access.jwksURL,
          cacheTTLSeconds: config.access.jwksCacheTTLSeconds,
          refreshCooldownSeconds: config.access.jwksRefreshCooldownSeconds,
        },
        options.accessJwksSessionFactory,
      ),
    );
    const assertionVerifier = Effect.runSync(
      makeAccessAssertionVerifier.pipe(
        Effect.provideService(VaultV2Config, config),
        Effect.provideService(AccessJwtVerifier, runtimeVerifier),
        Effect.provideService(VaultV2Metrics, metrics),
      ),
    );
    const capabilities = Effect.runSync(
      makeInternalCapabilityFactory.pipe(Effect.provideService(VaultV2Config, config)),
    );
    const directoryControls = Effect.runSync(
      makeDirectoryControlCapabilityFactory.pipe(Effect.provideService(VaultV2Config, config)),
    );
    const ownerVaultSocketAdmission = Effect.runSync(
      makeOwnerVaultSocketAdmissionFactory(env, directoryPrior),
    );
    const socketPrior = parseSocketAdmissionPriorKeys(
      env.ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_PRIOR_KEYS_JSON,
    );
    if (socketPrior === undefined) return undefined;
    const ownerVaultDirectoryControls = Effect.runSync(
      makeOwnerVaultDirectoryControlFactory(
        env,
        directoryPrior,
        {
          keyID: env.ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_CURRENT_KEY_ID,
          secret: env.ENCHIRIDION_V2_OWNER_VAULT_SOCKET_ADMISSION_CURRENT_SECRET,
        },
        socketPrior,
      ),
    );
    const random = Effect.runSync(
      makeDirectorySecureRandom.pipe(Effect.provideService(P256Crypto, makeP256Crypto())),
    );
    return {
      assertionVerifier,
      issuerHasher: makeVersionedIssuerHasher(config.credentialBindingKeys),
      capabilities,
      directoryControls,
      random,
      ownerVaultInitialization: makeOwnerVaultInitializationClient(env.OWNER_VAULT_V2_DO),
      ownerVaultProduction,
      ownerVaultSocketAdmission,
      ownerVaultDirectoryControls,
    };
  } catch {
    return undefined;
  }
};

/** A per-isolate composition cache; failed construction is deliberately never cached. */
export const makeVaultV2EntryCompositionCache = (
  options: VaultV2EntryCompositionOptions = {},
): ((raw: unknown) => VaultV2EntryComposition | undefined) => {
  let isolateComposition: VaultV2EntryComposition | undefined;
  return (raw) => {
    if (isolateComposition !== undefined) return isolateComposition;
    const env = parseVaultV2EntryEnv(raw);
    if (env === undefined) return undefined;
    const constructed = makeVaultV2EntryComposition(env, options);
    if (constructed !== undefined) isolateComposition = constructed;
    return isolateComposition;
  };
};

const productionComposition = makeVaultV2EntryCompositionCache();

/**
 * A Worker isolate has one immutable binding set. Invalid first bindings never
 * poison the isolate: only a fully validated composition becomes authoritative.
 */
export const vaultV2EntryComposition = (raw: unknown): VaultV2EntryComposition | undefined => {
  return productionComposition(raw);
};
