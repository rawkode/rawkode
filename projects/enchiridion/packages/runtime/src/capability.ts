import { Config, Effect, Redacted } from "effect";
import { signCapabilityHmac, unknownRecord, verifyCapabilityHmac } from "./adapters";
import {
  CapabilityConfigurationError,
  CapabilitySigningError,
  CapabilityVerificationError,
} from "./errors";

export enum CapabilityAuthority {
  Directory = "Directory",
  OwnerVault = "OwnerVault",
}

export enum CapabilityAudience {
  Directory = "Directory",
  OwnerVault = "OwnerVault",
}

export enum CapabilityMethod {
  GET = "GET",
  POST = "POST",
  PUT = "PUT",
  PATCH = "PATCH",
  DELETE = "DELETE",
}

export interface CapabilityKeyMaterial {
  readonly keyID: string;
  readonly secret: Redacted.Redacted;
}

export const maximumPriorCapabilityKeys = 2;

/** Long-lived opaque credential-binding HMAC material. Never accepted by the
 * short-lived internal-capability signer or verifier. */
export interface CredentialBindingKeyRing {
  readonly purpose: "credential-binding";
  readonly current: CapabilityKeyMaterial;
  readonly prior: readonly CapabilityKeyMaterial[];
}

/** Short-lived Worker capability HMAC material. The signer always uses `current`. */
export interface InternalCapabilityKeyRing {
  readonly purpose: "internal-capability";
  readonly current: CapabilityKeyMaterial;
  readonly prior: readonly CapabilityKeyMaterial[];
}

/** Exact request data bound by the compact capability. OwnerVault requires both IDs. */
export interface CapabilityRequestBinding {
  readonly method: CapabilityMethod;
  readonly path: string;
  readonly canonicalQuery: string;
  readonly bodySHA256: string;
  readonly ownerID?: string;
  readonly vaultID?: string;
}

/** The intended receiver of a capability. OwnerVault requires exact identity. */
export interface CapabilityExpectation {
  readonly audience: CapabilityAudience;
  readonly authority: CapabilityAuthority;
  readonly ownerID?: string;
  readonly vaultID?: string;
}

export interface CapabilityClaims extends CapabilityRequestBinding {
  readonly audience: CapabilityAudience;
  readonly authority: CapabilityAuthority;
  readonly keyID: string;
  readonly jti: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly credentialEpoch: number;
  readonly generationEpoch: number;
}

export type CapabilityClaimsInput = Omit<CapabilityClaims, "keyID" | "issuedAt" | "expiresAt"> & {
  readonly ttlSeconds: number;
};

export interface SignedCapability {
  readonly value: string;
}

/** A narrow internal signing capability. The key material stays Redacted. */
export interface CapabilitySigner {
  readonly sign: (
    input: CapabilityClaimsInput,
    nowSeconds: number,
  ) => Effect.Effect<SignedCapability, CapabilityConfigurationError | CapabilitySigningError>;
}

/** Verifies a capability against its exact request binding and intended authority. */
export interface CapabilityVerifier {
  readonly verify: (
    signed: SignedCapability,
    binding: CapabilityRequestBinding,
    expected: CapabilityExpectation,
    nowSeconds: number,
  ) => Effect.Effect<CapabilityClaims, CapabilityConfigurationError | CapabilityVerificationError>;
}

const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const JTI = /^[A-Za-z0-9_-]{16,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTITY = /^[A-Za-z0-9._~-]{1,128}$/u;
const MAX_CANONICAL_QUERY_LENGTH = 1_024;
/** Capability TTL is deliberately short so credential and generation revocation converges quickly. */
export const maximumCapabilityTTLSeconds = 60;

const base64url = (bytes: Uint8Array<ArrayBuffer>): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};

const fromBase64url = (value: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const padded = `${value.replace(/-/gu, "+").replace(/_/gu, "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
    const binary = atob(padded);
    const bytes: Uint8Array<ArrayBuffer> = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return base64url(bytes) === value ? bytes : undefined;
  } catch {
    return undefined;
  }
};

/** Canonical claim serialization is part of the signed protocol, not incidental JSON. */
const canonicalPayload = (claims: CapabilityClaims): string => {
  if (claims.authority === CapabilityAuthority.OwnerVault) {
    if (claims.ownerID === undefined || claims.vaultID === undefined)
      throw new TypeError("OwnerVault claims require owner and vault identity.");
    return JSON.stringify({
      aud: claims.audience,
      authority: claims.authority,
      bodySHA256: claims.bodySHA256,
      canonicalQuery: claims.canonicalQuery,
      credentialEpoch: claims.credentialEpoch,
      expiresAt: claims.expiresAt,
      generationEpoch: claims.generationEpoch,
      issuedAt: claims.issuedAt,
      jti: claims.jti,
      keyID: claims.keyID,
      method: claims.method,
      ownerID: claims.ownerID,
      path: claims.path,
      vaultID: claims.vaultID,
      version: 1,
    });
  }
  return JSON.stringify({
    aud: claims.audience,
    authority: claims.authority,
    bodySHA256: claims.bodySHA256,
    canonicalQuery: claims.canonicalQuery,
    credentialEpoch: claims.credentialEpoch,
    expiresAt: claims.expiresAt,
    generationEpoch: claims.generationEpoch,
    issuedAt: claims.issuedAt,
    jti: claims.jti,
    keyID: claims.keyID,
    method: claims.method,
    path: claims.path,
    version: 1,
  });
};

const isAuthority = (value: unknown): value is CapabilityAuthority =>
  value === CapabilityAuthority.Directory || value === CapabilityAuthority.OwnerVault;
const isAudience = (value: unknown): value is CapabilityAudience =>
  value === CapabilityAudience.Directory || value === CapabilityAudience.OwnerVault;
const isMethod = (value: unknown): value is CapabilityMethod =>
  value === CapabilityMethod.GET ||
  value === CapabilityMethod.POST ||
  value === CapabilityMethod.PUT ||
  value === CapabilityMethod.PATCH ||
  value === CapabilityMethod.DELETE;

const percentEncodeRFC3986 = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const canonicalComponent = (value: string): string | undefined => {
  try {
    const decoded = decodeURIComponent(value);
    return percentEncodeRFC3986(decoded) === value ? decoded : undefined;
  } catch {
    return undefined;
  }
};

const isCanonicalPath = (value: string): boolean => {
  if (!value.startsWith("/") || value.length > 512) return false;
  if (value === "/") return true;
  if (value.endsWith("/")) return false;
  return value
    .slice(1)
    .split("/")
    .every((segment) => {
      const decoded = canonicalComponent(segment);
      return (
        decoded !== undefined &&
        decoded !== "" &&
        decoded !== "." &&
        decoded !== ".." &&
        !decoded.includes("/")
      );
    });
};

const isCanonicalQuery = (value: string): boolean => {
  if (value === "") return true;
  if (value.length > MAX_CANONICAL_QUERY_LENGTH || value.startsWith("?") || value.includes("+"))
    return false;
  try {
    const names = new Set<string>();
    const entries: readonly (readonly [string, string])[] = value.split("&").map((part) => {
      const equals = part.indexOf("=");
      if (equals < 1 || part.indexOf("=", equals + 1) >= 0) throw new TypeError("Invalid query");
      const key = canonicalComponent(part.slice(0, equals));
      const entry = canonicalComponent(part.slice(equals + 1));
      if (key === undefined || entry === undefined || names.has(key))
        throw new TypeError("Invalid query");
      names.add(key);
      return [key, entry];
    });
    return (
      entries
        .map(([key, entry]): readonly [string, string] => [
          percentEncodeRFC3986(key),
          percentEncodeRFC3986(entry),
        ])
        .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
          leftKey === rightKey
            ? leftValue < rightValue
              ? -1
              : leftValue > rightValue
                ? 1
                : 0
            : leftKey < rightKey
              ? -1
              : 1,
        )
        .map(([key, entry]) => `${key}=${entry}`)
        .join("&") === value
    );
  } catch {
    return false;
  }
};

const validAuthorityScope = (value: {
  readonly audience: CapabilityAudience;
  readonly authority: CapabilityAuthority;
  readonly ownerID?: string;
  readonly vaultID?: string;
}): boolean =>
  value.authority === CapabilityAuthority.OwnerVault
    ? value.audience === CapabilityAudience.OwnerVault &&
      typeof value.ownerID === "string" &&
      typeof value.vaultID === "string" &&
      IDENTITY.test(value.ownerID) &&
      IDENTITY.test(value.vaultID)
    : value.audience === CapabilityAudience.Directory &&
      value.ownerID === undefined &&
      value.vaultID === undefined;

const validRequestBinding = (value: CapabilityRequestBinding): boolean =>
  isMethod(value.method) &&
  isCanonicalPath(value.path) &&
  isCanonicalQuery(value.canonicalQuery) &&
  SHA256.test(value.bodySHA256) &&
  (value.ownerID === undefined || IDENTITY.test(value.ownerID)) &&
  (value.vaultID === undefined || IDENTITY.test(value.vaultID));

const validClaims = (value: CapabilityClaims): boolean =>
  isAuthority(value.authority) &&
  isAudience(value.audience) &&
  validAuthorityScope(value) &&
  validRequestBinding(value) &&
  KEY_ID.test(value.keyID) &&
  JTI.test(value.jti) &&
  Number.isSafeInteger(value.issuedAt) &&
  value.issuedAt >= 0 &&
  Number.isSafeInteger(value.expiresAt) &&
  value.expiresAt > value.issuedAt &&
  value.expiresAt - value.issuedAt <= maximumCapabilityTTLSeconds &&
  Number.isInteger(value.credentialEpoch) &&
  value.credentialEpoch >= 0 &&
  Number.isInteger(value.generationEpoch) &&
  value.generationEpoch >= 0;

const capabilityKeySource = Config.all({
  keyID: Config.string("ENCHIRIDION_CAPABILITY_KEY_ID"),
  secret: Config.redacted("ENCHIRIDION_CAPABILITY_HMAC_KEY"),
});

/** Separate Redacted key configuration; this is intentionally not RuntimeConfig. */
export const capabilityKeyMaterialSource = capabilityKeySource.pipe(
  Config.validate({
    message: "ENCHIRIDION_CAPABILITY_KEY_ID must be a safe capability key id",
    validation: (material) => KEY_ID.test(material.keyID),
  }),
);

export const makeCapabilityKeyMaterial = (
  input: CapabilityKeyMaterial,
): Effect.Effect<CapabilityKeyMaterial, CapabilityConfigurationError> => {
  if (!KEY_ID.test(input.keyID))
    return Effect.fail(new CapabilityConfigurationError({ reason: "invalid_key_id" }));
  if (Redacted.value(input.secret).length === 0)
    return Effect.fail(new CapabilityConfigurationError({ reason: "invalid_secret" }));
  return Effect.succeed({ keyID: input.keyID, secret: input.secret });
};

const validateKeyRing = (
  current: CapabilityKeyMaterial,
  prior: readonly CapabilityKeyMaterial[],
): Effect.Effect<readonly CapabilityKeyMaterial[], CapabilityConfigurationError> => {
  if (prior.length > maximumPriorCapabilityKeys)
    return Effect.fail(new CapabilityConfigurationError({ reason: "too_many_prior_keys" }));
  return Effect.flatMap(
    Effect.all([current, ...prior].map((key) => makeCapabilityKeyMaterial(key))),
    (keys) => {
      if (new Set(keys.map((key) => key.keyID)).size !== keys.length)
        return Effect.fail(new CapabilityConfigurationError({ reason: "duplicate_key_id" }));
      if (new Set(keys.map((key) => Redacted.value(key.secret))).size !== keys.length)
        return Effect.fail(new CapabilityConfigurationError({ reason: "duplicate_secret" }));
      return Effect.succeed(keys);
    },
  );
};

export const makeCredentialBindingKeyRing = (input: {
  readonly current: CapabilityKeyMaterial;
  readonly prior?: readonly CapabilityKeyMaterial[];
}): Effect.Effect<CredentialBindingKeyRing, CapabilityConfigurationError> =>
  Effect.map(validateKeyRing(input.current, input.prior ?? []), () => ({
    purpose: "credential-binding",
    current: input.current,
    prior: input.prior ?? [],
  }));

export const makeInternalCapabilityKeyRing = (input: {
  readonly current: CapabilityKeyMaterial;
  readonly prior?: readonly CapabilityKeyMaterial[];
}): Effect.Effect<InternalCapabilityKeyRing, CapabilityConfigurationError> =>
  Effect.map(validateKeyRing(input.current, input.prior ?? []), () => ({
    purpose: "internal-capability",
    current: input.current,
    prior: input.prior ?? [],
  }));

/** Reject accidental key reuse between durable credential and internal-capability domains. */
export const validateDistinctKeyRings = (
  credentialBinding: CredentialBindingKeyRing,
  internalCapability: InternalCapabilityKeyRing,
): Effect.Effect<void, CapabilityConfigurationError> =>
  Effect.gen(function* () {
    const credential = yield* makeCredentialBindingKeyRing(credentialBinding);
    const capability = yield* makeInternalCapabilityKeyRing(internalCapability);
    const credentialKeys = [credential.current, ...credential.prior];
    const capabilityKeys = [capability.current, ...capability.prior];
    const collides = credentialKeys.some((credentialKey) =>
      capabilityKeys.some(
        (capabilityKey) =>
          capabilityKey.keyID === credentialKey.keyID ||
          Redacted.value(capabilityKey.secret) === Redacted.value(credentialKey.secret),
      ),
    );
    if (collides)
      return yield* Effect.fail(new CapabilityConfigurationError({ reason: "key_ring_overlap" }));
  });

export const signCapability = (
  input: CapabilityClaimsInput,
  keyRing: InternalCapabilityKeyRing,
  nowSeconds: number,
): Effect.Effect<SignedCapability, CapabilityConfigurationError | CapabilitySigningError> =>
  Effect.gen(function* () {
    const ring = yield* makeInternalCapabilityKeyRing(keyRing);
    const material = ring.current;
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0)
      return yield* Effect.fail(new CapabilitySigningError({ reason: "invalid_claims" }));
    const claims: CapabilityClaims = {
      audience: input.audience,
      authority: input.authority,
      bodySHA256: input.bodySHA256,
      canonicalQuery: input.canonicalQuery,
      credentialEpoch: input.credentialEpoch,
      expiresAt: nowSeconds + input.ttlSeconds,
      generationEpoch: input.generationEpoch,
      issuedAt: nowSeconds,
      jti: input.jti,
      keyID: material.keyID,
      method: input.method,
      ownerID: input.ownerID,
      path: input.path,
      vaultID: input.vaultID,
    };
    if (!Number.isInteger(input.ttlSeconds) || !validClaims(claims))
      return yield* Effect.fail(new CapabilitySigningError({ reason: "invalid_claims" }));
    const payload = base64url(new TextEncoder().encode(canonicalPayload(claims)));
    const signature = yield* signCapabilityHmac(material.secret, payload).pipe(
      Effect.mapError(() => new CapabilitySigningError({ reason: "crypto_failed" })),
    );
    return { value: `v1.${payload}.${base64url(signature)}` };
  });

const directoryClaimKeys = [
  "aud",
  "authority",
  "bodySHA256",
  "canonicalQuery",
  "credentialEpoch",
  "expiresAt",
  "generationEpoch",
  "issuedAt",
  "jti",
  "keyID",
  "method",
  "path",
  "version",
];
const ownerVaultClaimKeys = [...directoryClaimKeys, "ownerID", "vaultID"];

const claimsFromUnknown = (
  value: unknown,
): Effect.Effect<CapabilityClaims, CapabilityVerificationError> =>
  Effect.gen(function* () {
    const record = yield* unknownRecord("unknown-record", value).pipe(
      Effect.mapError(() => new CapabilityVerificationError({ reason: "claims_invalid" })),
    );
    const {
      aud,
      authority,
      bodySHA256,
      canonicalQuery,
      credentialEpoch,
      expiresAt,
      generationEpoch,
      issuedAt,
      jti,
      keyID,
      method,
      ownerID,
      path,
      vaultID,
      version,
    } = record;
    const expectedKeys =
      authority === CapabilityAuthority.OwnerVault ? ownerVaultClaimKeys : directoryClaimKeys;
    if (
      Object.keys(record).length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.hasOwn(record, key)) ||
      !isAudience(aud) ||
      !isAuthority(authority) ||
      !isMethod(method) ||
      typeof bodySHA256 !== "string" ||
      typeof canonicalQuery !== "string" ||
      typeof credentialEpoch !== "number" ||
      typeof expiresAt !== "number" ||
      typeof generationEpoch !== "number" ||
      typeof issuedAt !== "number" ||
      typeof jti !== "string" ||
      typeof keyID !== "string" ||
      typeof path !== "string" ||
      (ownerID !== undefined && typeof ownerID !== "string") ||
      (vaultID !== undefined && typeof vaultID !== "string") ||
      version !== 1
    )
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "claims_invalid" }));
    const claims: CapabilityClaims = {
      audience: aud,
      authority,
      bodySHA256,
      canonicalQuery,
      credentialEpoch,
      expiresAt,
      generationEpoch,
      issuedAt,
      jti,
      keyID,
      method,
      ownerID,
      path,
      vaultID,
    };
    if (!validClaims(claims))
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "claims_invalid" }));
    return claims;
  });

export const verifyCapability = (
  signed: SignedCapability,
  binding: CapabilityRequestBinding,
  expected: CapabilityExpectation,
  keyRing: InternalCapabilityKeyRing,
  nowSeconds: number,
): Effect.Effect<CapabilityClaims, CapabilityConfigurationError | CapabilityVerificationError> =>
  Effect.gen(function* () {
    const ring = yield* makeInternalCapabilityKeyRing(keyRing);
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0)
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "claims_invalid" }));
    const parts = signed.value.split(".");
    if (parts.length !== 3 || parts[0] !== "v1" || parts[1] === undefined || parts[2] === undefined)
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "malformed_token" }));
    const payloadBytes = fromBase64url(parts[1]);
    if (payloadBytes === undefined)
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "malformed_token" }));
    const payload = new TextDecoder().decode(payloadBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "malformed_token" }));
    }
    const claims = yield* claimsFromUnknown(parsed);
    if (payload !== canonicalPayload(claims))
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "claims_invalid" }));
    const material = [ring.current, ...ring.prior].find((key) => key.keyID === claims.keyID);
    if (material === undefined)
      return yield* Effect.fail(
        new CapabilityVerificationError({ reason: "unknown_or_stale_key" }),
      );
    const signature = fromBase64url(parts[2]);
    if (signature === undefined)
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "malformed_token" }));
    const verified = yield* verifyCapabilityHmac(material.secret, parts[1], signature).pipe(
      Effect.mapError(() => new CapabilityVerificationError({ reason: "signature_invalid" })),
    );
    if (!verified)
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "signature_invalid" }));
    if (
      claims.audience !== expected.audience ||
      claims.authority !== expected.authority ||
      !validAuthorityScope(expected) ||
      !validRequestBinding(binding)
    )
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "binding_mismatch" }));
    if (
      claims.method !== binding.method ||
      claims.path !== binding.path ||
      claims.canonicalQuery !== binding.canonicalQuery ||
      claims.bodySHA256 !== binding.bodySHA256
    )
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "binding_mismatch" }));
    if (
      claims.authority === CapabilityAuthority.OwnerVault &&
      (claims.ownerID !== binding.ownerID ||
        claims.vaultID !== binding.vaultID ||
        claims.ownerID !== expected.ownerID ||
        claims.vaultID !== expected.vaultID)
    )
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "binding_mismatch" }));
    if (claims.expiresAt <= nowSeconds)
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "expired" }));
    if (claims.issuedAt > nowSeconds)
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "not_yet_valid" }));
    return claims;
  });

export const makeCapabilitySigner = (keyRing: InternalCapabilityKeyRing): CapabilitySigner => ({
  sign: (input, nowSeconds) => signCapability(input, keyRing, nowSeconds),
});

export const makeCapabilityVerifier = (keyRing: InternalCapabilityKeyRing): CapabilityVerifier => ({
  verify: (signed, binding, expected, nowSeconds) =>
    verifyCapability(signed, binding, expected, keyRing, nowSeconds),
});
