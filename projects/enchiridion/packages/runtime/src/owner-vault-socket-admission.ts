import { Effect, Redacted } from "effect";
import { signCapabilityHmac, unknownRecord, verifyCapabilityHmac } from "./adapters";
import {
  CapabilityConfigurationError,
  CapabilitySigningError,
  CapabilityVerificationError,
} from "./errors";

/** A separate protocol for admission to the OwnerVault WebSocket. It is not a
 * DirectoryControl capability and cannot be accepted by the generic verifier. */
export enum OwnerVaultSocketAdmissionAuthority {
  OwnerVaultSocketAdmission = "OwnerVaultSocketAdmission",
}

export const ownerVaultSocketAdmissionPath = "/internal/owner-vault/socket";
export const maximumOwnerVaultSocketAdmissionTTLSeconds = 60;
export const maximumPriorOwnerVaultSocketAdmissionKeys = 2;

export interface OwnerVaultSocketAdmissionKeyMaterial {
  readonly keyID: string;
  readonly secret: Redacted.Redacted;
}

export interface OwnerVaultSocketAdmissionKeyRing {
  readonly purpose: "owner-vault-socket-admission";
  readonly current: OwnerVaultSocketAdmissionKeyMaterial;
  readonly prior: readonly OwnerVaultSocketAdmissionKeyMaterial[];
  readonly revokedKeyIDs: readonly string[];
}

export interface OwnerVaultSocketAdmissionRequestBinding {
  readonly method: "GET";
  readonly canonicalQuery: string;
  readonly bodySHA256: string;
  readonly ownerID: string;
  readonly vaultID: string;
  readonly deviceID: string;
  readonly sessionID: string;
  readonly operationID: string;
  readonly upgradeNonce: string;
}

/** Current durable authority values. All are exact checks, so epoch advances
 * revoke previously issued tokens without keeping replay state in this layer. */
export interface OwnerVaultSocketAdmissionExpectation {
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generationEpoch: number;
  readonly routingEpoch: number;
  readonly credentialEpoch: number;
  readonly controlEpoch: number;
  readonly securityFloor: number;
  readonly deviceID: string;
  readonly sessionID: string;
  readonly operationID: string;
}

export interface OwnerVaultSocketAdmissionClaims extends OwnerVaultSocketAdmissionRequestBinding {
  readonly generationEpoch: number;
  readonly routingEpoch: number;
  readonly credentialEpoch: number;
  readonly controlEpoch: number;
  readonly securityFloor: number;
  readonly jti: string;
  readonly path: typeof ownerVaultSocketAdmissionPath;
  readonly keyID: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export type OwnerVaultSocketAdmissionClaimsInput = Omit<
  OwnerVaultSocketAdmissionClaims,
  "keyID" | "issuedAt" | "expiresAt" | "path"
> & { readonly ttlSeconds: number };

export interface SignedOwnerVaultSocketAdmission {
  readonly value: string;
}

export interface OwnerVaultSocketAdmissionSigner {
  readonly sign: (
    input: OwnerVaultSocketAdmissionClaimsInput,
    nowSeconds: number,
  ) => Effect.Effect<
    SignedOwnerVaultSocketAdmission,
    CapabilityConfigurationError | CapabilitySigningError
  >;
}

export interface OwnerVaultSocketAdmissionVerifier {
  readonly verify: (
    signed: SignedOwnerVaultSocketAdmission,
    binding: OwnerVaultSocketAdmissionRequestBinding,
    expected: OwnerVaultSocketAdmissionExpectation,
    nowSeconds: number,
  ) => Effect.Effect<
    OwnerVaultSocketAdmissionClaims,
    CapabilityConfigurationError | CapabilityVerificationError
  >;
}

const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const JTI = /^[A-Za-z0-9_-]{16,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAXIMUM_QUERY_BYTES = 1_024;
const textEncoder = new TextEncoder();

const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};
const fromBase64url = (value: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const padded = `${value.replace(/-/gu, "+").replace(/_/gu, "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    return base64url(bytes) === value ? bytes : undefined;
  } catch {
    return undefined;
  }
};
const percentEncode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const canonicalComponent = (value: string): string | undefined => {
  try {
    const decoded = decodeURIComponent(value);
    return percentEncode(decoded) === value ? decoded : undefined;
  } catch {
    return undefined;
  }
};
const canonicalQuery = (value: string): boolean => {
  if (value === "") return true;
  if (
    textEncoder.encode(value).byteLength > MAXIMUM_QUERY_BYTES ||
    value.startsWith("?") ||
    value.includes("+")
  )
    return false;
  try {
    const names = new Set<string>();
    const entries = value.split("&").map((part) => {
      const equals = part.indexOf("=");
      if (equals < 1 || part.indexOf("=", equals + 1) >= 0) throw new TypeError("query");
      const name = canonicalComponent(part.slice(0, equals));
      const entry = canonicalComponent(part.slice(equals + 1));
      if (name === undefined || entry === undefined || names.has(name))
        throw new TypeError("query");
      names.add(name);
      return [percentEncode(name), percentEncode(entry)] as const;
    });
    return (
      entries
        .sort(([leftName, leftValue], [rightName, rightValue]) =>
          leftName === rightName
            ? leftValue.localeCompare(rightValue)
            : leftName.localeCompare(rightName),
        )
        .map(([name, entry]) => `${name}=${entry}`)
        .join("&") === value
    );
  } catch {
    return false;
  }
};
const safeEpoch = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const validBinding = (value: OwnerVaultSocketAdmissionRequestBinding): boolean =>
  value.method === "GET" &&
  canonicalQuery(value.canonicalQuery) &&
  SHA256.test(value.bodySHA256) &&
  ID.test(value.ownerID) &&
  ID.test(value.vaultID) &&
  ID.test(value.deviceID) &&
  ID.test(value.sessionID) &&
  ID.test(value.operationID) &&
  ID.test(value.upgradeNonce);
const validExpectation = (value: OwnerVaultSocketAdmissionExpectation): boolean =>
  ID.test(value.ownerID) &&
  ID.test(value.vaultID) &&
  ID.test(value.deviceID) &&
  ID.test(value.sessionID) &&
  ID.test(value.operationID) &&
  safeEpoch(value.generationEpoch) &&
  safeEpoch(value.routingEpoch) &&
  safeEpoch(value.credentialEpoch) &&
  safeEpoch(value.controlEpoch) &&
  safeEpoch(value.securityFloor);
const validClaims = (value: OwnerVaultSocketAdmissionClaims): boolean =>
  validBinding(value) &&
  value.path === ownerVaultSocketAdmissionPath &&
  KEY_ID.test(value.keyID) &&
  JTI.test(value.jti) &&
  safeEpoch(value.generationEpoch) &&
  safeEpoch(value.routingEpoch) &&
  safeEpoch(value.credentialEpoch) &&
  safeEpoch(value.controlEpoch) &&
  safeEpoch(value.securityFloor) &&
  Number.isSafeInteger(value.issuedAt) &&
  value.issuedAt >= 0 &&
  Number.isSafeInteger(value.expiresAt) &&
  value.expiresAt > value.issuedAt &&
  value.expiresAt - value.issuedAt <= maximumOwnerVaultSocketAdmissionTTLSeconds;

/** The field order is the protocol. No authority/audience/version claims are
 * added: token framing and its distinct type provide domain separation. */
const canonicalPayload = (claims: OwnerVaultSocketAdmissionClaims): string =>
  JSON.stringify({
    ownerID: claims.ownerID,
    vaultID: claims.vaultID,
    generationEpoch: claims.generationEpoch,
    routingEpoch: claims.routingEpoch,
    credentialEpoch: claims.credentialEpoch,
    controlEpoch: claims.controlEpoch,
    securityFloor: claims.securityFloor,
    deviceID: claims.deviceID,
    sessionID: claims.sessionID,
    operationID: claims.operationID,
    jti: claims.jti,
    method: claims.method,
    path: claims.path,
    canonicalQuery: claims.canonicalQuery,
    upgradeNonce: claims.upgradeNonce,
    bodySHA256: claims.bodySHA256,
    keyID: claims.keyID,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  });
const claimKeys = [
  "ownerID",
  "vaultID",
  "generationEpoch",
  "routingEpoch",
  "credentialEpoch",
  "controlEpoch",
  "securityFloor",
  "deviceID",
  "sessionID",
  "operationID",
  "jti",
  "method",
  "path",
  "canonicalQuery",
  "upgradeNonce",
  "bodySHA256",
  "keyID",
  "issuedAt",
  "expiresAt",
] as const;
const claimsFromUnknown = (
  value: unknown,
): Effect.Effect<OwnerVaultSocketAdmissionClaims, CapabilityVerificationError> =>
  Effect.gen(function* () {
    const record = yield* unknownRecord("unknown-record", value).pipe(
      Effect.mapError(() => new CapabilityVerificationError({ reason: "claims_invalid" })),
    );
    if (
      Object.keys(record).length !== claimKeys.length ||
      claimKeys.some((key) => !Object.hasOwn(record, key)) ||
      typeof record.ownerID !== "string" ||
      typeof record.vaultID !== "string" ||
      typeof record.generationEpoch !== "number" ||
      typeof record.routingEpoch !== "number" ||
      typeof record.credentialEpoch !== "number" ||
      typeof record.controlEpoch !== "number" ||
      typeof record.securityFloor !== "number" ||
      typeof record.deviceID !== "string" ||
      typeof record.sessionID !== "string" ||
      typeof record.operationID !== "string" ||
      typeof record.jti !== "string" ||
      record.method !== "GET" ||
      record.path !== ownerVaultSocketAdmissionPath ||
      typeof record.canonicalQuery !== "string" ||
      typeof record.upgradeNonce !== "string" ||
      typeof record.bodySHA256 !== "string" ||
      typeof record.keyID !== "string" ||
      typeof record.issuedAt !== "number" ||
      typeof record.expiresAt !== "number"
    )
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "claims_invalid" }));
    const claims: OwnerVaultSocketAdmissionClaims = {
      ownerID: record.ownerID,
      vaultID: record.vaultID,
      generationEpoch: record.generationEpoch,
      routingEpoch: record.routingEpoch,
      credentialEpoch: record.credentialEpoch,
      controlEpoch: record.controlEpoch,
      securityFloor: record.securityFloor,
      deviceID: record.deviceID,
      sessionID: record.sessionID,
      operationID: record.operationID,
      jti: record.jti,
      method: record.method,
      path: record.path,
      canonicalQuery: record.canonicalQuery,
      upgradeNonce: record.upgradeNonce,
      bodySHA256: record.bodySHA256,
      keyID: record.keyID,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
    };
    if (!validClaims(claims))
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "claims_invalid" }));
    return claims;
  });

export const makeOwnerVaultSocketAdmissionKeyRing = (input: {
  readonly current: OwnerVaultSocketAdmissionKeyMaterial;
  readonly prior?: readonly OwnerVaultSocketAdmissionKeyMaterial[];
  readonly revokedKeyIDs?: readonly string[];
}): Effect.Effect<OwnerVaultSocketAdmissionKeyRing, CapabilityConfigurationError> => {
  const prior = input.prior ?? [];
  const revokedKeyIDs = input.revokedKeyIDs ?? [];
  if (prior.length > maximumPriorOwnerVaultSocketAdmissionKeys)
    return Effect.fail(new CapabilityConfigurationError({ reason: "too_many_prior_keys" }));
  const keys = [input.current, ...prior];
  if (keys.some((key) => !KEY_ID.test(key.keyID)))
    return Effect.fail(new CapabilityConfigurationError({ reason: "invalid_key_id" }));
  if (keys.some((key) => Redacted.value(key.secret).length === 0))
    return Effect.fail(new CapabilityConfigurationError({ reason: "invalid_secret" }));
  if (new Set(keys.map((key) => key.keyID)).size !== keys.length)
    return Effect.fail(new CapabilityConfigurationError({ reason: "duplicate_key_id" }));
  if (new Set(keys.map((key) => Redacted.value(key.secret))).size !== keys.length)
    return Effect.fail(new CapabilityConfigurationError({ reason: "duplicate_secret" }));
  if (
    revokedKeyIDs.some((keyID) => !KEY_ID.test(keyID)) ||
    new Set(revokedKeyIDs).size !== revokedKeyIDs.length
  )
    return Effect.fail(new CapabilityConfigurationError({ reason: "invalid_key_id" }));
  if (keys.some((key) => revokedKeyIDs.includes(key.keyID)))
    return Effect.fail(new CapabilityConfigurationError({ reason: "key_ring_overlap" }));
  return Effect.succeed({
    purpose: "owner-vault-socket-admission",
    current: input.current,
    prior,
    revokedKeyIDs,
  });
};

export const signOwnerVaultSocketAdmission = (
  input: OwnerVaultSocketAdmissionClaimsInput,
  keyRing: OwnerVaultSocketAdmissionKeyRing,
  nowSeconds: number,
): Effect.Effect<
  SignedOwnerVaultSocketAdmission,
  CapabilityConfigurationError | CapabilitySigningError
> =>
  Effect.gen(function* () {
    const ring = yield* makeOwnerVaultSocketAdmissionKeyRing(keyRing);
    const claims: OwnerVaultSocketAdmissionClaims = {
      ...input,
      path: ownerVaultSocketAdmissionPath,
      keyID: ring.current.keyID,
      issuedAt: nowSeconds,
      expiresAt: nowSeconds + input.ttlSeconds,
    };
    if (
      !Number.isSafeInteger(nowSeconds) ||
      nowSeconds < 0 ||
      !Number.isInteger(input.ttlSeconds) ||
      !validClaims(claims)
    )
      return yield* Effect.fail(new CapabilitySigningError({ reason: "invalid_claims" }));
    const payload = base64url(textEncoder.encode(canonicalPayload(claims)));
    const signature = yield* signCapabilityHmac(ring.current.secret, payload).pipe(
      Effect.mapError(() => new CapabilitySigningError({ reason: "crypto_failed" })),
    );
    return { value: `ovsa1.${payload}.${base64url(signature)}` };
  });

export const verifyOwnerVaultSocketAdmission = (
  signed: SignedOwnerVaultSocketAdmission,
  binding: OwnerVaultSocketAdmissionRequestBinding,
  expected: OwnerVaultSocketAdmissionExpectation,
  keyRing: OwnerVaultSocketAdmissionKeyRing,
  nowSeconds: number,
): Effect.Effect<
  OwnerVaultSocketAdmissionClaims,
  CapabilityConfigurationError | CapabilityVerificationError
> =>
  Effect.gen(function* () {
    const ring = yield* makeOwnerVaultSocketAdmissionKeyRing(keyRing);
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0)
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "claims_invalid" }));
    const parts = signed.value.split(".");
    if (
      parts.length !== 3 ||
      parts[0] !== "ovsa1" ||
      parts[1] === undefined ||
      parts[2] === undefined
    )
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "malformed_token" }));
    const bytes = fromBase64url(parts[1]);
    if (bytes === undefined)
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "malformed_token" }));
    let payload: string;
    let parsed: unknown;
    try {
      payload = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      parsed = JSON.parse(payload);
    } catch {
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "malformed_token" }));
    }
    const claims = yield* claimsFromUnknown(parsed);
    if (payload !== canonicalPayload(claims))
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "claims_invalid" }));
    const material = [ring.current, ...ring.prior].find((key) => key.keyID === claims.keyID);
    if (material === undefined || ring.revokedKeyIDs.includes(claims.keyID))
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
    if (!validBinding(binding) || !validExpectation(expected))
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "binding_mismatch" }));
    if (
      claims.method !== binding.method ||
      claims.path !== ownerVaultSocketAdmissionPath ||
      claims.canonicalQuery !== binding.canonicalQuery ||
      claims.bodySHA256 !== binding.bodySHA256 ||
      claims.ownerID !== binding.ownerID ||
      claims.vaultID !== binding.vaultID ||
      claims.deviceID !== binding.deviceID ||
      claims.sessionID !== binding.sessionID ||
      claims.operationID !== binding.operationID ||
      claims.upgradeNonce !== binding.upgradeNonce ||
      claims.ownerID !== expected.ownerID ||
      claims.vaultID !== expected.vaultID ||
      claims.deviceID !== expected.deviceID ||
      claims.sessionID !== expected.sessionID ||
      claims.operationID !== expected.operationID ||
      claims.generationEpoch !== expected.generationEpoch ||
      claims.routingEpoch !== expected.routingEpoch ||
      claims.credentialEpoch !== expected.credentialEpoch ||
      claims.controlEpoch !== expected.controlEpoch ||
      claims.securityFloor !== expected.securityFloor
    )
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "binding_mismatch" }));
    if (claims.expiresAt <= nowSeconds)
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "expired" }));
    if (claims.issuedAt > nowSeconds)
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "not_yet_valid" }));
    return claims;
  });

export const makeOwnerVaultSocketAdmissionSigner = (
  keyRing: OwnerVaultSocketAdmissionKeyRing,
): OwnerVaultSocketAdmissionSigner => ({
  sign: (input, nowSeconds) => signOwnerVaultSocketAdmission(input, keyRing, nowSeconds),
});
export const makeOwnerVaultSocketAdmissionVerifier = (
  keyRing: OwnerVaultSocketAdmissionKeyRing,
): OwnerVaultSocketAdmissionVerifier => ({
  verify: (signed, binding, expected, nowSeconds) =>
    verifyOwnerVaultSocketAdmission(signed, binding, expected, keyRing, nowSeconds),
});
