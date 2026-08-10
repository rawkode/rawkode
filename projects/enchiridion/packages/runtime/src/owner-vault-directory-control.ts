import { Effect, Redacted } from "effect";
import { signCapabilityHmac, unknownRecord, verifyCapabilityHmac } from "./adapters";
import type { CapabilityKeyMaterial } from "./capability";
import type {
  CapabilityConfigurationError,
  CapabilitySigningError,
  CapabilityVerificationError,
} from "./errors";
import {
  CapabilityConfigurationError as ConfigurationError,
  CapabilitySigningError as SigningError,
  CapabilityVerificationError as VerificationError,
} from "./errors";

/** A separate authority from legacy DirectoryControl and generic v1 capabilities. */
export enum OwnerVaultDirectoryControlResource {
  PrivateInitialize = "private-initialize",
  CredentialFence = "credential-fence",
  Snapshot = "snapshot",
  Restore = "restore",
}

export const ownerVaultPrivateInitializePath = "/__v2/internal/owner-vault/private-initialize";
export const ownerVaultCredentialFencePath = "/__v2/internal/owner-vault/credential-fence";
export const ownerVaultSnapshotPath = "/__v2/internal/owner-vault/snapshot";
export const ownerVaultRestorePath = "/__v2/internal/owner-vault/restore";
export const maximumOwnerVaultDirectoryControlTTLSeconds = 60;
export const maximumPriorOwnerVaultDirectoryControlKeys = 2;

interface Common {
  readonly ownerID: string;
  readonly vaultID: string;
  /** The receiving target generation; never inferred from any source tuple. */
  readonly generationEpoch: number;
  readonly routingEpoch: number;
  readonly credentialEpoch: number;
  readonly controlEpoch: number;
  readonly securityFloor: number;
  readonly operationID: string;
  readonly jti: string;
  readonly method: "POST";
  readonly canonicalQuery: "";
  readonly bodySHA256: string;
}

export interface OwnerVaultPrivateInitializeBinding extends Common {
  readonly resource: OwnerVaultDirectoryControlResource.PrivateInitialize;
  readonly path: typeof ownerVaultPrivateInitializePath;
  readonly sourceGeneration: number;
  readonly targetGeneration: number;
  readonly allocationID: string;
  readonly initID: string;
  readonly backupID: string;
  readonly manifestDigest: string;
}
export interface OwnerVaultCredentialFenceBinding extends Common {
  readonly resource: OwnerVaultDirectoryControlResource.CredentialFence;
  readonly path: typeof ownerVaultCredentialFencePath;
  readonly expectedCredentialEpoch: number;
  readonly expectedRoutingEpoch: number;
  readonly expectedControlEpoch: number;
  readonly expectedSecurityFloor: number;
  readonly raisedCredentialEpoch: number;
  readonly raisedRoutingEpoch: number;
}
export interface OwnerVaultSnapshotBinding extends Common {
  readonly resource: OwnerVaultDirectoryControlResource.Snapshot;
  readonly path: typeof ownerVaultSnapshotPath;
  readonly backupID: string;
  readonly sourceGeneration: number;
  readonly sourceRoutingEpoch: number;
  readonly sourceCredentialEpoch: number;
  readonly sourceControlEpoch: number;
  readonly sourceSecurityFloor: number;
}
export interface OwnerVaultRestoreBinding extends Common {
  readonly resource: OwnerVaultDirectoryControlResource.Restore;
  readonly path: typeof ownerVaultRestorePath;
  readonly allocationID: string;
  readonly initID: string;
  readonly sourceGeneration: number;
  readonly targetGeneration: number;
  readonly backupID: string;
  readonly manifestDigest: string;
}
export type OwnerVaultDirectoryControlRequestBinding =
  | OwnerVaultPrivateInitializeBinding
  | OwnerVaultCredentialFenceBinding
  | OwnerVaultSnapshotBinding
  | OwnerVaultRestoreBinding;

/** Expectations intentionally mirror every request claim (except key/time). */
export type OwnerVaultDirectoryControlExpectation = OwnerVaultDirectoryControlRequestBinding;
interface Signed {
  readonly keyID: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
export type OwnerVaultPrivateInitializeClaims = OwnerVaultPrivateInitializeBinding & Signed;
export type OwnerVaultCredentialFenceClaims = OwnerVaultCredentialFenceBinding & Signed;
export type OwnerVaultSnapshotClaims = OwnerVaultSnapshotBinding & Signed;
export type OwnerVaultRestoreClaims = OwnerVaultRestoreBinding & Signed;
export type OwnerVaultDirectoryControlClaims =
  | OwnerVaultPrivateInitializeClaims
  | OwnerVaultCredentialFenceClaims
  | OwnerVaultSnapshotClaims
  | OwnerVaultRestoreClaims;
export type OwnerVaultPrivateInitializeClaimsInput = OwnerVaultPrivateInitializeBinding & {
  readonly ttlSeconds: number;
};
export type OwnerVaultCredentialFenceClaimsInput = OwnerVaultCredentialFenceBinding & {
  readonly ttlSeconds: number;
};
export type OwnerVaultSnapshotClaimsInput = OwnerVaultSnapshotBinding & {
  readonly ttlSeconds: number;
};
export type OwnerVaultRestoreClaimsInput = OwnerVaultRestoreBinding & {
  readonly ttlSeconds: number;
};
export type OwnerVaultDirectoryControlClaimsInput =
  | OwnerVaultPrivateInitializeClaimsInput
  | OwnerVaultCredentialFenceClaimsInput
  | OwnerVaultSnapshotClaimsInput
  | OwnerVaultRestoreClaimsInput;
export interface SignedOwnerVaultDirectoryControl {
  readonly value: string;
}

export interface OwnerVaultDirectoryControlKeyRing {
  readonly purpose: "owner-vault-directory-control";
  readonly current: CapabilityKeyMaterial;
  readonly prior: readonly CapabilityKeyMaterial[];
  readonly revokedKeyIDs: readonly string[];
}

const keyID = /^[A-Za-z0-9_-]{1,64}$/u;
const id = /^[A-Za-z0-9._~-]{1,128}$/u;
const opaque = /^[A-Za-z0-9_-]{16,128}$/u;
const digest = /^[a-f0-9]{64}$/u;
const encoder = new TextEncoder();
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const b64url = (value: Uint8Array): string => {
  let text = "";
  for (const byte of value) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};
const fromB64url = (value: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const padded = `${value.replace(/-/gu, "+").replace(/_/gu, "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    return b64url(bytes) === value ? bytes : undefined;
  } catch {
    return undefined;
  }
};
const commonValid = (value: Common): boolean =>
  id.test(value.ownerID) &&
  id.test(value.vaultID) &&
  value.ownerID !== value.vaultID &&
  positive(value.generationEpoch) &&
  positive(value.routingEpoch) &&
  positive(value.credentialEpoch) &&
  positive(value.controlEpoch) &&
  positive(value.securityFloor) &&
  opaque.test(value.operationID) &&
  opaque.test(value.jti) &&
  value.method === "POST" &&
  value.canonicalQuery === "" &&
  digest.test(value.bodySHA256);
const allocationValid = (value: {
  readonly sourceGeneration: number;
  readonly targetGeneration: number;
  readonly allocationID: string;
  readonly initID: string;
  readonly backupID: string;
  readonly manifestDigest: string;
}): boolean =>
  positive(value.sourceGeneration) &&
  positive(value.targetGeneration) &&
  opaque.test(value.allocationID) &&
  opaque.test(value.initID) &&
  opaque.test(value.backupID) &&
  digest.test(value.manifestDigest);
const bindingValid = (value: OwnerVaultDirectoryControlRequestBinding): boolean => {
  switch (value.resource) {
    case OwnerVaultDirectoryControlResource.PrivateInitialize:
      return (
        commonValid(value) &&
        value.path === ownerVaultPrivateInitializePath &&
        allocationValid(value) &&
        value.generationEpoch === value.targetGeneration
      );
    case OwnerVaultDirectoryControlResource.CredentialFence:
      return (
        commonValid(value) &&
        value.path === ownerVaultCredentialFencePath &&
        positive(value.expectedCredentialEpoch) &&
        positive(value.expectedRoutingEpoch) &&
        positive(value.expectedControlEpoch) &&
        positive(value.expectedSecurityFloor) &&
        positive(value.raisedCredentialEpoch) &&
        positive(value.raisedRoutingEpoch) &&
        value.credentialEpoch === value.raisedCredentialEpoch &&
        value.routingEpoch === value.raisedRoutingEpoch &&
        value.controlEpoch === value.expectedControlEpoch &&
        value.securityFloor === value.expectedSecurityFloor &&
        value.raisedCredentialEpoch === value.expectedCredentialEpoch + 1 &&
        value.raisedRoutingEpoch === value.expectedRoutingEpoch + 1
      );
    case OwnerVaultDirectoryControlResource.Snapshot:
      return (
        commonValid(value) &&
        value.path === ownerVaultSnapshotPath &&
        opaque.test(value.backupID) &&
        positive(value.sourceGeneration) &&
        positive(value.sourceRoutingEpoch) &&
        positive(value.sourceCredentialEpoch) &&
        positive(value.sourceControlEpoch) &&
        positive(value.sourceSecurityFloor)
      );
    case OwnerVaultDirectoryControlResource.Restore:
      return (
        commonValid(value) &&
        value.path === ownerVaultRestorePath &&
        allocationValid(value) &&
        value.generationEpoch === value.targetGeneration
      );
  }
};
const claimsValid = (value: OwnerVaultDirectoryControlClaims): boolean =>
  bindingValid(value) &&
  keyID.test(value.keyID) &&
  positive(value.issuedAt) &&
  positive(value.expiresAt) &&
  value.expiresAt > value.issuedAt &&
  value.expiresAt - value.issuedAt <= maximumOwnerVaultDirectoryControlTTLSeconds;

/** Every branch explicitly fixes its own shape and serialization order. */
const canonical = (claims: OwnerVaultDirectoryControlClaims): string => {
  const common = {
    resource: claims.resource,
    ownerID: claims.ownerID,
    vaultID: claims.vaultID,
    generationEpoch: claims.generationEpoch,
    routingEpoch: claims.routingEpoch,
    credentialEpoch: claims.credentialEpoch,
    controlEpoch: claims.controlEpoch,
    securityFloor: claims.securityFloor,
    operationID: claims.operationID,
    jti: claims.jti,
    method: claims.method,
    path: claims.path,
    canonicalQuery: claims.canonicalQuery,
    bodySHA256: claims.bodySHA256,
    keyID: claims.keyID,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  };
  switch (claims.resource) {
    case OwnerVaultDirectoryControlResource.PrivateInitialize:
      return JSON.stringify({
        ...common,
        sourceGeneration: claims.sourceGeneration,
        targetGeneration: claims.targetGeneration,
        allocationID: claims.allocationID,
        initID: claims.initID,
        backupID: claims.backupID,
        manifestDigest: claims.manifestDigest,
      });
    case OwnerVaultDirectoryControlResource.CredentialFence:
      return JSON.stringify({
        ...common,
        expectedCredentialEpoch: claims.expectedCredentialEpoch,
        expectedRoutingEpoch: claims.expectedRoutingEpoch,
        expectedControlEpoch: claims.expectedControlEpoch,
        expectedSecurityFloor: claims.expectedSecurityFloor,
        raisedCredentialEpoch: claims.raisedCredentialEpoch,
        raisedRoutingEpoch: claims.raisedRoutingEpoch,
      });
    case OwnerVaultDirectoryControlResource.Snapshot:
      return JSON.stringify({
        ...common,
        backupID: claims.backupID,
        sourceGeneration: claims.sourceGeneration,
        sourceRoutingEpoch: claims.sourceRoutingEpoch,
        sourceCredentialEpoch: claims.sourceCredentialEpoch,
        sourceControlEpoch: claims.sourceControlEpoch,
        sourceSecurityFloor: claims.sourceSecurityFloor,
      });
    case OwnerVaultDirectoryControlResource.Restore:
      return JSON.stringify({
        ...common,
        allocationID: claims.allocationID,
        initID: claims.initID,
        sourceGeneration: claims.sourceGeneration,
        targetGeneration: claims.targetGeneration,
        backupID: claims.backupID,
        manifestDigest: claims.manifestDigest,
      });
  }
};
const commonKeys = [
  "resource",
  "ownerID",
  "vaultID",
  "generationEpoch",
  "routingEpoch",
  "credentialEpoch",
  "controlEpoch",
  "securityFloor",
  "operationID",
  "jti",
  "method",
  "path",
  "canonicalQuery",
  "bodySHA256",
  "keyID",
  "issuedAt",
  "expiresAt",
] as const;
const hasExact = (record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
interface DecodedCommon {
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generationEpoch: number;
  readonly routingEpoch: number;
  readonly credentialEpoch: number;
  readonly controlEpoch: number;
  readonly securityFloor: number;
  readonly operationID: string;
  readonly jti: string;
  readonly bodySHA256: string;
  readonly keyID: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
const decodeCommon = (record: Readonly<Record<string, unknown>>): DecodedCommon | undefined =>
  typeof record.ownerID === "string" &&
  typeof record.vaultID === "string" &&
  typeof record.generationEpoch === "number" &&
  typeof record.routingEpoch === "number" &&
  typeof record.credentialEpoch === "number" &&
  typeof record.controlEpoch === "number" &&
  typeof record.securityFloor === "number" &&
  typeof record.operationID === "string" &&
  typeof record.jti === "string" &&
  record.method === "POST" &&
  record.canonicalQuery === "" &&
  typeof record.bodySHA256 === "string" &&
  typeof record.keyID === "string" &&
  typeof record.issuedAt === "number" &&
  typeof record.expiresAt === "number"
    ? {
        ownerID: record.ownerID,
        vaultID: record.vaultID,
        generationEpoch: record.generationEpoch,
        routingEpoch: record.routingEpoch,
        credentialEpoch: record.credentialEpoch,
        controlEpoch: record.controlEpoch,
        securityFloor: record.securityFloor,
        operationID: record.operationID,
        jti: record.jti,
        bodySHA256: record.bodySHA256,
        keyID: record.keyID,
        issuedAt: record.issuedAt,
        expiresAt: record.expiresAt,
      }
    : undefined;
const invalid = <A = never>(): Effect.Effect<A, CapabilityVerificationError> =>
  Effect.fail(new VerificationError({ reason: "claims_invalid" }));
const decode = (
  value: unknown,
): Effect.Effect<OwnerVaultDirectoryControlClaims, CapabilityVerificationError> =>
  Effect.gen(function* () {
    const record = yield* unknownRecord("unknown-record", value).pipe(
      Effect.mapError(() => new VerificationError({ reason: "claims_invalid" })),
    );
    const common = decodeCommon(record);
    if (
      common === undefined ||
      typeof record.resource !== "string" ||
      typeof record.path !== "string"
    )
      return yield* invalid();
    switch (record.resource) {
      case OwnerVaultDirectoryControlResource.PrivateInitialize: {
        if (
          !hasExact(record, [
            ...commonKeys,
            "sourceGeneration",
            "targetGeneration",
            "allocationID",
            "initID",
            "backupID",
            "manifestDigest",
          ]) ||
          record.path !== ownerVaultPrivateInitializePath ||
          typeof record.sourceGeneration !== "number" ||
          typeof record.targetGeneration !== "number" ||
          typeof record.allocationID !== "string" ||
          typeof record.initID !== "string" ||
          typeof record.backupID !== "string" ||
          typeof record.manifestDigest !== "string"
        )
          return yield* invalid();
        const claims: OwnerVaultPrivateInitializeClaims = {
          resource: record.resource,
          path: ownerVaultPrivateInitializePath,
          method: "POST",
          canonicalQuery: "",
          ...common,
          sourceGeneration: record.sourceGeneration,
          targetGeneration: record.targetGeneration,
          allocationID: record.allocationID,
          initID: record.initID,
          backupID: record.backupID,
          manifestDigest: record.manifestDigest,
        };
        return claimsValid(claims) ? claims : yield* invalid();
      }
      case OwnerVaultDirectoryControlResource.CredentialFence: {
        if (
          !hasExact(record, [
            ...commonKeys,
            "expectedCredentialEpoch",
            "expectedRoutingEpoch",
            "expectedControlEpoch",
            "expectedSecurityFloor",
            "raisedCredentialEpoch",
            "raisedRoutingEpoch",
          ]) ||
          record.path !== ownerVaultCredentialFencePath ||
          typeof record.expectedCredentialEpoch !== "number" ||
          typeof record.expectedRoutingEpoch !== "number" ||
          typeof record.expectedControlEpoch !== "number" ||
          typeof record.expectedSecurityFloor !== "number" ||
          typeof record.raisedCredentialEpoch !== "number" ||
          typeof record.raisedRoutingEpoch !== "number"
        )
          return yield* invalid();
        const claims: OwnerVaultCredentialFenceClaims = {
          resource: record.resource,
          path: ownerVaultCredentialFencePath,
          method: "POST",
          canonicalQuery: "",
          ...common,
          expectedCredentialEpoch: record.expectedCredentialEpoch,
          expectedRoutingEpoch: record.expectedRoutingEpoch,
          expectedControlEpoch: record.expectedControlEpoch,
          expectedSecurityFloor: record.expectedSecurityFloor,
          raisedCredentialEpoch: record.raisedCredentialEpoch,
          raisedRoutingEpoch: record.raisedRoutingEpoch,
        };
        return claimsValid(claims) ? claims : yield* invalid();
      }
      case OwnerVaultDirectoryControlResource.Snapshot: {
        if (
          !hasExact(record, [
            ...commonKeys,
            "backupID",
            "sourceGeneration",
            "sourceRoutingEpoch",
            "sourceCredentialEpoch",
            "sourceControlEpoch",
            "sourceSecurityFloor",
          ]) ||
          record.path !== ownerVaultSnapshotPath ||
          typeof record.backupID !== "string" ||
          typeof record.sourceGeneration !== "number" ||
          typeof record.sourceRoutingEpoch !== "number" ||
          typeof record.sourceCredentialEpoch !== "number" ||
          typeof record.sourceControlEpoch !== "number" ||
          typeof record.sourceSecurityFloor !== "number"
        )
          return yield* invalid();
        const claims: OwnerVaultSnapshotClaims = {
          resource: record.resource,
          path: ownerVaultSnapshotPath,
          method: "POST",
          canonicalQuery: "",
          ...common,
          backupID: record.backupID,
          sourceGeneration: record.sourceGeneration,
          sourceRoutingEpoch: record.sourceRoutingEpoch,
          sourceCredentialEpoch: record.sourceCredentialEpoch,
          sourceControlEpoch: record.sourceControlEpoch,
          sourceSecurityFloor: record.sourceSecurityFloor,
        };
        return claimsValid(claims) ? claims : yield* invalid();
      }
      case OwnerVaultDirectoryControlResource.Restore: {
        if (
          !hasExact(record, [
            ...commonKeys,
            "allocationID",
            "initID",
            "sourceGeneration",
            "targetGeneration",
            "backupID",
            "manifestDigest",
          ]) ||
          record.path !== ownerVaultRestorePath ||
          typeof record.allocationID !== "string" ||
          typeof record.initID !== "string" ||
          typeof record.sourceGeneration !== "number" ||
          typeof record.targetGeneration !== "number" ||
          typeof record.backupID !== "string" ||
          typeof record.manifestDigest !== "string"
        )
          return yield* invalid();
        const claims: OwnerVaultRestoreClaims = {
          resource: record.resource,
          path: ownerVaultRestorePath,
          method: "POST",
          canonicalQuery: "",
          ...common,
          allocationID: record.allocationID,
          initID: record.initID,
          sourceGeneration: record.sourceGeneration,
          targetGeneration: record.targetGeneration,
          backupID: record.backupID,
          manifestDigest: record.manifestDigest,
        };
        return claimsValid(claims) ? claims : yield* invalid();
      }
      default:
        return yield* invalid();
    }
  });

export const makeOwnerVaultDirectoryControlKeyRing = (input: {
  readonly current: CapabilityKeyMaterial;
  readonly prior?: readonly CapabilityKeyMaterial[];
  readonly revokedKeyIDs?: readonly string[];
}): Effect.Effect<OwnerVaultDirectoryControlKeyRing, CapabilityConfigurationError> => {
  const prior = input.prior ?? [];
  const revoked = input.revokedKeyIDs ?? [];
  const active = [input.current, ...prior];
  if (prior.length > maximumPriorOwnerVaultDirectoryControlKeys)
    return Effect.fail(new ConfigurationError({ reason: "too_many_prior_keys" }));
  if (
    active.some((entry) => !keyID.test(entry.keyID)) ||
    revoked.some((entry) => !keyID.test(entry))
  )
    return Effect.fail(new ConfigurationError({ reason: "invalid_key_id" }));
  if (active.some((entry) => Redacted.value(entry.secret).length === 0))
    return Effect.fail(new ConfigurationError({ reason: "invalid_secret" }));
  if (
    new Set(active.map((entry) => entry.keyID)).size !== active.length ||
    new Set(active.map((entry) => Redacted.value(entry.secret))).size !== active.length ||
    new Set(revoked).size !== revoked.length
  )
    return Effect.fail(new ConfigurationError({ reason: "duplicate_key_id" }));
  if (active.some((entry) => revoked.includes(entry.keyID)))
    return Effect.fail(new ConfigurationError({ reason: "key_ring_overlap" }));
  return Effect.succeed({
    purpose: "owner-vault-directory-control",
    current: input.current,
    prior,
    revokedKeyIDs: revoked,
  });
};
const createClaims = (
  input: OwnerVaultDirectoryControlClaimsInput,
  key: string,
  now: number,
): OwnerVaultDirectoryControlClaims => {
  const signed = { keyID: key, issuedAt: now, expiresAt: now + input.ttlSeconds };
  switch (input.resource) {
    case OwnerVaultDirectoryControlResource.PrivateInitialize: {
      const { ttlSeconds: _, ...binding } = input;
      return { ...binding, ...signed };
    }
    case OwnerVaultDirectoryControlResource.CredentialFence: {
      const { ttlSeconds: _, ...binding } = input;
      return { ...binding, ...signed };
    }
    case OwnerVaultDirectoryControlResource.Snapshot: {
      const { ttlSeconds: _, ...binding } = input;
      return { ...binding, ...signed };
    }
    case OwnerVaultDirectoryControlResource.Restore: {
      const { ttlSeconds: _, ...binding } = input;
      return { ...binding, ...signed };
    }
  }
};
const signedBinding = (
  binding: OwnerVaultDirectoryControlRequestBinding,
  claims: OwnerVaultDirectoryControlClaims,
): OwnerVaultDirectoryControlClaims => {
  const signed = {
    keyID: claims.keyID,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  };
  switch (binding.resource) {
    case OwnerVaultDirectoryControlResource.PrivateInitialize:
      return { ...binding, ...signed };
    case OwnerVaultDirectoryControlResource.CredentialFence:
      return { ...binding, ...signed };
    case OwnerVaultDirectoryControlResource.Snapshot:
      return { ...binding, ...signed };
    case OwnerVaultDirectoryControlResource.Restore:
      return { ...binding, ...signed };
  }
};
const sameBinding = (
  claims: OwnerVaultDirectoryControlClaims,
  binding: OwnerVaultDirectoryControlRequestBinding,
): boolean => canonical(claims) === canonical(signedBinding(binding, claims));

export const signOwnerVaultDirectoryControl = (
  input: OwnerVaultDirectoryControlClaimsInput,
  keyRing: OwnerVaultDirectoryControlKeyRing,
  nowSeconds: number,
): Effect.Effect<
  SignedOwnerVaultDirectoryControl,
  CapabilityConfigurationError | CapabilitySigningError
> =>
  Effect.gen(function* () {
    const ring = yield* makeOwnerVaultDirectoryControlKeyRing(keyRing);
    if (!positive(input.ttlSeconds) || !positive(nowSeconds))
      return yield* Effect.fail(new SigningError({ reason: "invalid_claims" }));
    const claims = createClaims(input, ring.current.keyID, nowSeconds);
    if (!claimsValid(claims))
      return yield* Effect.fail(new SigningError({ reason: "invalid_claims" }));
    const payload = b64url(encoder.encode(canonical(claims)));
    const signature = yield* signCapabilityHmac(ring.current.secret, payload).pipe(
      Effect.mapError(() => new SigningError({ reason: "crypto_failed" })),
    );
    return { value: `ovdc1.${payload}.${b64url(signature)}` };
  });
export const verifyOwnerVaultDirectoryControl = (
  signed: SignedOwnerVaultDirectoryControl,
  binding: OwnerVaultDirectoryControlRequestBinding,
  expected: OwnerVaultDirectoryControlExpectation,
  keyRing: OwnerVaultDirectoryControlKeyRing,
  nowSeconds: number,
): Effect.Effect<
  OwnerVaultDirectoryControlClaims,
  CapabilityConfigurationError | CapabilityVerificationError
> =>
  Effect.gen(function* () {
    const ring = yield* makeOwnerVaultDirectoryControlKeyRing(keyRing);
    if (!positive(nowSeconds) || !bindingValid(binding) || !bindingValid(expected))
      return yield* Effect.fail(new VerificationError({ reason: "claims_invalid" }));
    const parts = signed.value.split(".");
    if (
      parts.length !== 3 ||
      parts[0] !== "ovdc1" ||
      parts[1] === undefined ||
      parts[2] === undefined
    )
      return yield* Effect.fail(new VerificationError({ reason: "malformed_token" }));
    const payloadBytes = fromB64url(parts[1]);
    if (payloadBytes === undefined)
      return yield* Effect.fail(new VerificationError({ reason: "malformed_token" }));
    let payload: string;
    let parsed: unknown;
    try {
      payload = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
      parsed = JSON.parse(payload);
    } catch {
      return yield* Effect.fail(new VerificationError({ reason: "malformed_token" }));
    }
    const claims = yield* decode(parsed);
    if (payload !== canonical(claims))
      return yield* Effect.fail(new VerificationError({ reason: "claims_invalid" }));
    const key = [ring.current, ...ring.prior].find((entry) => entry.keyID === claims.keyID);
    if (key === undefined || ring.revokedKeyIDs.includes(claims.keyID))
      return yield* Effect.fail(new VerificationError({ reason: "unknown_or_stale_key" }));
    const signature = fromB64url(parts[2]);
    if (signature === undefined)
      return yield* Effect.fail(new VerificationError({ reason: "malformed_token" }));
    const verified = yield* verifyCapabilityHmac(key.secret, parts[1], signature).pipe(
      Effect.mapError(() => new VerificationError({ reason: "signature_invalid" })),
    );
    if (!verified)
      return yield* Effect.fail(new VerificationError({ reason: "signature_invalid" }));
    if (!sameBinding(claims, binding) || !sameBinding(claims, expected))
      return yield* Effect.fail(new VerificationError({ reason: "binding_mismatch" }));
    if (claims.expiresAt <= nowSeconds)
      return yield* Effect.fail(new VerificationError({ reason: "expired" }));
    if (claims.issuedAt > nowSeconds)
      return yield* Effect.fail(new VerificationError({ reason: "not_yet_valid" }));
    return claims;
  });
