import { Effect } from "effect";
import { signCapabilityHmac, unknownRecord, verifyCapabilityHmac } from "./adapters";
import { type InternalCapabilityKeyRing, makeInternalCapabilityKeyRing } from "./capability";
import {
  type CapabilityConfigurationError,
  CapabilitySigningError,
  CapabilityVerificationError,
} from "./errors";

/**
 * OwnerVault's four Directory-issued operations deliberately have a different
 * token type from the legacy DirectoryControl journal.  The discriminated
 * request/expectation pairs make a new resource impossible to authorize with
 * an optional-field bag or an old control token.
 */
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

interface OwnerVaultDirectoryControlCommon {
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generationEpoch: number;
  readonly operationID: string;
  readonly jti: string;
  readonly method: "POST";
  readonly canonicalQuery: "";
  readonly bodySHA256: string;
}

interface OwnerVaultDirectoryControlCurrent {
  readonly credentialEpoch: number;
  readonly routingEpoch: number;
  readonly controlEpoch: number;
  readonly securityFloor: number;
}

export interface OwnerVaultPrivateInitializeBinding
  extends OwnerVaultDirectoryControlCommon,
    OwnerVaultDirectoryControlCurrent {
  readonly resource: OwnerVaultDirectoryControlResource.PrivateInitialize;
  readonly path: typeof ownerVaultPrivateInitializePath;
  readonly initDigest: string;
}

/** Both raised values are authenticated; a receiver cannot apply a partial fence. */
export interface OwnerVaultCredentialFenceBinding extends OwnerVaultDirectoryControlCommon {
  readonly resource: OwnerVaultDirectoryControlResource.CredentialFence;
  readonly path: typeof ownerVaultCredentialFencePath;
  readonly expectedCredentialEpoch: number;
  readonly expectedRoutingEpoch: number;
  readonly credentialEpoch: number;
  readonly routingEpoch: number;
  readonly controlEpoch: number;
  readonly securityFloor: number;
}

export interface OwnerVaultSnapshotBinding
  extends OwnerVaultDirectoryControlCommon,
    OwnerVaultDirectoryControlCurrent {
  readonly resource: OwnerVaultDirectoryControlResource.Snapshot;
  readonly path: typeof ownerVaultSnapshotPath;
  readonly backupID: string;
}

export interface OwnerVaultRestoreBinding
  extends OwnerVaultDirectoryControlCommon,
    OwnerVaultDirectoryControlCurrent {
  readonly resource: OwnerVaultDirectoryControlResource.Restore;
  readonly path: typeof ownerVaultRestorePath;
  readonly restoreID: string;
  readonly backupID: string;
  readonly manifestDigest: string;
}

export type OwnerVaultDirectoryControlRequestBinding =
  | OwnerVaultPrivateInitializeBinding
  | OwnerVaultCredentialFenceBinding
  | OwnerVaultSnapshotBinding
  | OwnerVaultRestoreBinding;

interface OwnerVaultDirectoryControlExpectedCommon extends OwnerVaultDirectoryControlCurrent {
  readonly resource: OwnerVaultDirectoryControlResource;
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generationEpoch: number;
  readonly operationID: string;
}

export interface OwnerVaultPrivateInitializeExpectation
  extends OwnerVaultDirectoryControlExpectedCommon {
  readonly resource: OwnerVaultDirectoryControlResource.PrivateInitialize;
  readonly initDigest: string;
}
export interface OwnerVaultCredentialFenceExpectation
  extends OwnerVaultDirectoryControlExpectedCommon {
  readonly resource: OwnerVaultDirectoryControlResource.CredentialFence;
  readonly expectedCredentialEpoch: number;
  readonly expectedRoutingEpoch: number;
}
export interface OwnerVaultSnapshotExpectation extends OwnerVaultDirectoryControlExpectedCommon {
  readonly resource: OwnerVaultDirectoryControlResource.Snapshot;
  readonly backupID: string;
}
export interface OwnerVaultRestoreExpectation extends OwnerVaultDirectoryControlExpectedCommon {
  readonly resource: OwnerVaultDirectoryControlResource.Restore;
  readonly restoreID: string;
  readonly backupID: string;
  readonly manifestDigest: string;
}
export type OwnerVaultDirectoryControlExpectation =
  | OwnerVaultPrivateInitializeExpectation
  | OwnerVaultCredentialFenceExpectation
  | OwnerVaultSnapshotExpectation
  | OwnerVaultRestoreExpectation;

interface OwnerVaultDirectoryControlSigned {
  readonly keyID: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
export type OwnerVaultPrivateInitializeClaims = OwnerVaultPrivateInitializeBinding &
  OwnerVaultDirectoryControlSigned;
export type OwnerVaultCredentialFenceClaims = OwnerVaultCredentialFenceBinding &
  OwnerVaultDirectoryControlSigned;
export type OwnerVaultSnapshotClaims = OwnerVaultSnapshotBinding & OwnerVaultDirectoryControlSigned;
export type OwnerVaultRestoreClaims = OwnerVaultRestoreBinding & OwnerVaultDirectoryControlSigned;
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

const keyIDPattern = /^[A-Za-z0-9_-]{1,64}$/u;
const identifierPattern = /^[A-Za-z0-9._~-]{1,128}$/u;
const operationPattern = /^[A-Za-z0-9_-]{16,128}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const textEncoder = new TextEncoder();

const base64url = (bytes: Uint8Array): string => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
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
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const nonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const commonValid = (value: OwnerVaultDirectoryControlCommon): boolean =>
  identifierPattern.test(value.ownerID) &&
  identifierPattern.test(value.vaultID) &&
  value.ownerID !== value.vaultID &&
  positive(value.generationEpoch) &&
  operationPattern.test(value.operationID) &&
  operationPattern.test(value.jti) &&
  value.method === "POST" &&
  value.canonicalQuery === "" &&
  digestPattern.test(value.bodySHA256);
const currentValid = (value: OwnerVaultDirectoryControlCurrent): boolean =>
  positive(value.credentialEpoch) &&
  positive(value.routingEpoch) &&
  positive(value.controlEpoch) &&
  nonNegative(value.securityFloor);
const fenceValid = (value: OwnerVaultCredentialFenceBinding): boolean =>
  commonValid(value) &&
  positive(value.expectedCredentialEpoch) &&
  positive(value.expectedRoutingEpoch) &&
  value.credentialEpoch === value.expectedCredentialEpoch + 1 &&
  value.routingEpoch === value.expectedRoutingEpoch + 1 &&
  positive(value.controlEpoch) &&
  nonNegative(value.securityFloor);
const bindingValid = (value: OwnerVaultDirectoryControlRequestBinding): boolean => {
  switch (value.resource) {
    case OwnerVaultDirectoryControlResource.PrivateInitialize:
      return (
        commonValid(value) &&
        value.path === ownerVaultPrivateInitializePath &&
        digestPattern.test(value.initDigest) &&
        currentValid(value)
      );
    case OwnerVaultDirectoryControlResource.CredentialFence:
      return value.path === ownerVaultCredentialFencePath && fenceValid(value);
    case OwnerVaultDirectoryControlResource.Snapshot:
      return (
        commonValid(value) &&
        value.path === ownerVaultSnapshotPath &&
        operationPattern.test(value.backupID) &&
        currentValid(value)
      );
    case OwnerVaultDirectoryControlResource.Restore:
      return (
        commonValid(value) &&
        value.path === ownerVaultRestorePath &&
        operationPattern.test(value.restoreID) &&
        operationPattern.test(value.backupID) &&
        digestPattern.test(value.manifestDigest) &&
        currentValid(value)
      );
  }
};
const expectationValid = (value: OwnerVaultDirectoryControlExpectation): boolean => {
  const common =
    identifierPattern.test(value.ownerID) &&
    identifierPattern.test(value.vaultID) &&
    value.ownerID !== value.vaultID &&
    positive(value.generationEpoch) &&
    operationPattern.test(value.operationID) &&
    currentValid(value);
  if (!common) return false;
  switch (value.resource) {
    case OwnerVaultDirectoryControlResource.PrivateInitialize:
      return digestPattern.test(value.initDigest);
    case OwnerVaultDirectoryControlResource.CredentialFence:
      return (
        positive(value.expectedCredentialEpoch) &&
        positive(value.expectedRoutingEpoch) &&
        value.credentialEpoch === value.expectedCredentialEpoch + 1 &&
        value.routingEpoch === value.expectedRoutingEpoch + 1
      );
    case OwnerVaultDirectoryControlResource.Snapshot:
      return operationPattern.test(value.backupID);
    case OwnerVaultDirectoryControlResource.Restore:
      return (
        operationPattern.test(value.restoreID) &&
        operationPattern.test(value.backupID) &&
        digestPattern.test(value.manifestDigest)
      );
  }
};
const claimsValid = (value: OwnerVaultDirectoryControlClaims): boolean =>
  bindingValid(value) &&
  keyIDPattern.test(value.keyID) &&
  positive(value.expiresAt) &&
  nonNegative(value.issuedAt) &&
  value.expiresAt > value.issuedAt &&
  value.expiresAt - value.issuedAt <= maximumOwnerVaultDirectoryControlTTLSeconds;

/** Fixed key order is part of the signed protocol. */
const canonicalPayload = (claims: OwnerVaultDirectoryControlClaims): string => {
  const common = {
    resource: claims.resource,
    ownerID: claims.ownerID,
    vaultID: claims.vaultID,
    generationEpoch: claims.generationEpoch,
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
        initDigest: claims.initDigest,
        credentialEpoch: claims.credentialEpoch,
        routingEpoch: claims.routingEpoch,
        controlEpoch: claims.controlEpoch,
        securityFloor: claims.securityFloor,
      });
    case OwnerVaultDirectoryControlResource.CredentialFence:
      return JSON.stringify({
        ...common,
        expectedCredentialEpoch: claims.expectedCredentialEpoch,
        expectedRoutingEpoch: claims.expectedRoutingEpoch,
        credentialEpoch: claims.credentialEpoch,
        routingEpoch: claims.routingEpoch,
        controlEpoch: claims.controlEpoch,
        securityFloor: claims.securityFloor,
      });
    case OwnerVaultDirectoryControlResource.Snapshot:
      return JSON.stringify({
        ...common,
        backupID: claims.backupID,
        credentialEpoch: claims.credentialEpoch,
        routingEpoch: claims.routingEpoch,
        controlEpoch: claims.controlEpoch,
        securityFloor: claims.securityFloor,
      });
    case OwnerVaultDirectoryControlResource.Restore:
      return JSON.stringify({
        ...common,
        restoreID: claims.restoreID,
        backupID: claims.backupID,
        manifestDigest: claims.manifestDigest,
        credentialEpoch: claims.credentialEpoch,
        routingEpoch: claims.routingEpoch,
        controlEpoch: claims.controlEpoch,
        securityFloor: claims.securityFloor,
      });
  }
};

const commonKeys = [
  "resource",
  "ownerID",
  "vaultID",
  "generationEpoch",
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
const exact = (record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
interface DecodedCommon {
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generationEpoch: number;
  readonly operationID: string;
  readonly jti: string;
  readonly path: string;
  readonly bodySHA256: string;
  readonly keyID: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
const decodedCommon = (record: Readonly<Record<string, unknown>>): DecodedCommon | undefined =>
  typeof record.ownerID === "string" &&
  typeof record.vaultID === "string" &&
  typeof record.generationEpoch === "number" &&
  typeof record.operationID === "string" &&
  typeof record.jti === "string" &&
  record.method === "POST" &&
  typeof record.path === "string" &&
  record.canonicalQuery === "" &&
  typeof record.bodySHA256 === "string" &&
  typeof record.keyID === "string" &&
  typeof record.issuedAt === "number" &&
  typeof record.expiresAt === "number"
    ? {
        ownerID: record.ownerID,
        vaultID: record.vaultID,
        generationEpoch: record.generationEpoch,
        operationID: record.operationID,
        jti: record.jti,
        path: record.path,
        bodySHA256: record.bodySHA256,
        keyID: record.keyID,
        issuedAt: record.issuedAt,
        expiresAt: record.expiresAt,
      }
    : undefined;
const fromUnknown = (
  value: unknown,
): Effect.Effect<OwnerVaultDirectoryControlClaims, CapabilityVerificationError> =>
  Effect.gen(function* () {
    const record = yield* unknownRecord("unknown-record", value).pipe(
      Effect.mapError(() => new CapabilityVerificationError({ reason: "claims_invalid" })),
    );
    const common = decodedCommon(record);
    if (common === undefined || typeof record.resource !== "string")
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "claims_invalid" }));
    switch (record.resource) {
      case OwnerVaultDirectoryControlResource.PrivateInitialize: {
        if (
          !exact(record, [
            ...commonKeys,
            "initDigest",
            "credentialEpoch",
            "routingEpoch",
            "controlEpoch",
            "securityFloor",
          ]) ||
          typeof record.initDigest !== "string" ||
          typeof record.credentialEpoch !== "number" ||
          typeof record.routingEpoch !== "number" ||
          typeof record.controlEpoch !== "number" ||
          typeof record.securityFloor !== "number" ||
          common.path !== ownerVaultPrivateInitializePath
        )
          return yield* Effect.fail(new CapabilityVerificationError({ reason: "claims_invalid" }));
        const claims: OwnerVaultPrivateInitializeClaims = {
          resource: record.resource,
          ownerID: common.ownerID,
          vaultID: common.vaultID,
          generationEpoch: common.generationEpoch,
          operationID: common.operationID,
          jti: common.jti,
          method: "POST",
          path: ownerVaultPrivateInitializePath,
          canonicalQuery: "",
          bodySHA256: common.bodySHA256,
          initDigest: record.initDigest,
          credentialEpoch: record.credentialEpoch,
          routingEpoch: record.routingEpoch,
          controlEpoch: record.controlEpoch,
          securityFloor: record.securityFloor,
          keyID: common.keyID,
          issuedAt: common.issuedAt,
          expiresAt: common.expiresAt,
        };
        return claimsValid(claims)
          ? claims
          : yield* Effect.fail(new CapabilityVerificationError({ reason: "claims_invalid" }));
      }
      case OwnerVaultDirectoryControlResource.CredentialFence: {
        if (
          !exact(record, [
            ...commonKeys,
            "expectedCredentialEpoch",
            "expectedRoutingEpoch",
            "credentialEpoch",
            "routingEpoch",
            "controlEpoch",
            "securityFloor",
          ]) ||
          typeof record.expectedCredentialEpoch !== "number" ||
          typeof record.expectedRoutingEpoch !== "number" ||
          typeof record.credentialEpoch !== "number" ||
          typeof record.routingEpoch !== "number" ||
          typeof record.controlEpoch !== "number" ||
          typeof record.securityFloor !== "number" ||
          common.path !== ownerVaultCredentialFencePath
        )
          return yield* Effect.fail(new CapabilityVerificationError({ reason: "claims_invalid" }));
        const claims: OwnerVaultCredentialFenceClaims = {
          resource: record.resource,
          ownerID: common.ownerID,
          vaultID: common.vaultID,
          generationEpoch: common.generationEpoch,
          operationID: common.operationID,
          jti: common.jti,
          method: "POST",
          path: ownerVaultCredentialFencePath,
          canonicalQuery: "",
          bodySHA256: common.bodySHA256,
          expectedCredentialEpoch: record.expectedCredentialEpoch,
          expectedRoutingEpoch: record.expectedRoutingEpoch,
          credentialEpoch: record.credentialEpoch,
          routingEpoch: record.routingEpoch,
          controlEpoch: record.controlEpoch,
          securityFloor: record.securityFloor,
          keyID: common.keyID,
          issuedAt: common.issuedAt,
          expiresAt: common.expiresAt,
        };
        return claimsValid(claims)
          ? claims
          : yield* Effect.fail(new CapabilityVerificationError({ reason: "claims_invalid" }));
      }
      case OwnerVaultDirectoryControlResource.Snapshot: {
        if (
          !exact(record, [
            ...commonKeys,
            "backupID",
            "credentialEpoch",
            "routingEpoch",
            "controlEpoch",
            "securityFloor",
          ]) ||
          typeof record.backupID !== "string" ||
          typeof record.credentialEpoch !== "number" ||
          typeof record.routingEpoch !== "number" ||
          typeof record.controlEpoch !== "number" ||
          typeof record.securityFloor !== "number" ||
          common.path !== ownerVaultSnapshotPath
        )
          return yield* Effect.fail(new CapabilityVerificationError({ reason: "claims_invalid" }));
        const claims: OwnerVaultSnapshotClaims = {
          resource: record.resource,
          ownerID: common.ownerID,
          vaultID: common.vaultID,
          generationEpoch: common.generationEpoch,
          operationID: common.operationID,
          jti: common.jti,
          method: "POST",
          path: ownerVaultSnapshotPath,
          canonicalQuery: "",
          bodySHA256: common.bodySHA256,
          backupID: record.backupID,
          credentialEpoch: record.credentialEpoch,
          routingEpoch: record.routingEpoch,
          controlEpoch: record.controlEpoch,
          securityFloor: record.securityFloor,
          keyID: common.keyID,
          issuedAt: common.issuedAt,
          expiresAt: common.expiresAt,
        };
        return claimsValid(claims)
          ? claims
          : yield* Effect.fail(new CapabilityVerificationError({ reason: "claims_invalid" }));
      }
      case OwnerVaultDirectoryControlResource.Restore: {
        if (
          !exact(record, [
            ...commonKeys,
            "restoreID",
            "backupID",
            "manifestDigest",
            "credentialEpoch",
            "routingEpoch",
            "controlEpoch",
            "securityFloor",
          ]) ||
          typeof record.restoreID !== "string" ||
          typeof record.backupID !== "string" ||
          typeof record.manifestDigest !== "string" ||
          typeof record.credentialEpoch !== "number" ||
          typeof record.routingEpoch !== "number" ||
          typeof record.controlEpoch !== "number" ||
          typeof record.securityFloor !== "number" ||
          common.path !== ownerVaultRestorePath
        )
          return yield* Effect.fail(new CapabilityVerificationError({ reason: "claims_invalid" }));
        const claims: OwnerVaultRestoreClaims = {
          resource: record.resource,
          ownerID: common.ownerID,
          vaultID: common.vaultID,
          generationEpoch: common.generationEpoch,
          operationID: common.operationID,
          jti: common.jti,
          method: "POST",
          path: ownerVaultRestorePath,
          canonicalQuery: "",
          bodySHA256: common.bodySHA256,
          restoreID: record.restoreID,
          backupID: record.backupID,
          manifestDigest: record.manifestDigest,
          credentialEpoch: record.credentialEpoch,
          routingEpoch: record.routingEpoch,
          controlEpoch: record.controlEpoch,
          securityFloor: record.securityFloor,
          keyID: common.keyID,
          issuedAt: common.issuedAt,
          expiresAt: common.expiresAt,
        };
        return claimsValid(claims)
          ? claims
          : yield* Effect.fail(new CapabilityVerificationError({ reason: "claims_invalid" }));
      }
      default:
        return yield* Effect.fail(new CapabilityVerificationError({ reason: "claims_invalid" }));
    }
  });

const claimsFor = (
  input: OwnerVaultDirectoryControlClaimsInput,
  keyID: string,
  nowSeconds: number,
): OwnerVaultDirectoryControlClaims => {
  const signed = { keyID, issuedAt: nowSeconds, expiresAt: nowSeconds + input.ttlSeconds };
  switch (input.resource) {
    case OwnerVaultDirectoryControlResource.PrivateInitialize:
      return { ...input, ...signed };
    case OwnerVaultDirectoryControlResource.CredentialFence:
      return { ...input, ...signed };
    case OwnerVaultDirectoryControlResource.Snapshot:
      return { ...input, ...signed };
    case OwnerVaultDirectoryControlResource.Restore:
      return { ...input, ...signed };
  }
};

const sameBinding = (
  claims: OwnerVaultDirectoryControlClaims,
  binding: OwnerVaultDirectoryControlRequestBinding,
): boolean => {
  if (
    claims.resource !== binding.resource ||
    claims.ownerID !== binding.ownerID ||
    claims.vaultID !== binding.vaultID ||
    claims.generationEpoch !== binding.generationEpoch ||
    claims.operationID !== binding.operationID ||
    claims.jti !== binding.jti ||
    claims.method !== binding.method ||
    claims.path !== binding.path ||
    claims.canonicalQuery !== binding.canonicalQuery ||
    claims.bodySHA256 !== binding.bodySHA256
  )
    return false;
  switch (claims.resource) {
    case OwnerVaultDirectoryControlResource.PrivateInitialize:
      return (
        binding.resource === claims.resource &&
        claims.initDigest === binding.initDigest &&
        claims.credentialEpoch === binding.credentialEpoch &&
        claims.routingEpoch === binding.routingEpoch &&
        claims.controlEpoch === binding.controlEpoch &&
        claims.securityFloor === binding.securityFloor
      );
    case OwnerVaultDirectoryControlResource.CredentialFence:
      return (
        binding.resource === claims.resource &&
        claims.expectedCredentialEpoch === binding.expectedCredentialEpoch &&
        claims.expectedRoutingEpoch === binding.expectedRoutingEpoch &&
        claims.credentialEpoch === binding.credentialEpoch &&
        claims.routingEpoch === binding.routingEpoch &&
        claims.controlEpoch === binding.controlEpoch &&
        claims.securityFloor === binding.securityFloor
      );
    case OwnerVaultDirectoryControlResource.Snapshot:
      return (
        binding.resource === claims.resource &&
        claims.backupID === binding.backupID &&
        claims.credentialEpoch === binding.credentialEpoch &&
        claims.routingEpoch === binding.routingEpoch &&
        claims.controlEpoch === binding.controlEpoch &&
        claims.securityFloor === binding.securityFloor
      );
    case OwnerVaultDirectoryControlResource.Restore:
      return (
        binding.resource === claims.resource &&
        claims.restoreID === binding.restoreID &&
        claims.backupID === binding.backupID &&
        claims.manifestDigest === binding.manifestDigest &&
        claims.credentialEpoch === binding.credentialEpoch &&
        claims.routingEpoch === binding.routingEpoch &&
        claims.controlEpoch === binding.controlEpoch &&
        claims.securityFloor === binding.securityFloor
      );
  }
};
const sameExpectation = (
  claims: OwnerVaultDirectoryControlClaims,
  expected: OwnerVaultDirectoryControlExpectation,
): boolean => {
  if (
    claims.resource !== expected.resource ||
    claims.ownerID !== expected.ownerID ||
    claims.vaultID !== expected.vaultID ||
    claims.generationEpoch !== expected.generationEpoch ||
    claims.operationID !== expected.operationID ||
    claims.credentialEpoch !== expected.credentialEpoch ||
    claims.routingEpoch !== expected.routingEpoch ||
    claims.controlEpoch !== expected.controlEpoch ||
    claims.securityFloor !== expected.securityFloor
  )
    return false;
  switch (claims.resource) {
    case OwnerVaultDirectoryControlResource.PrivateInitialize:
      return expected.resource === claims.resource && claims.initDigest === expected.initDigest;
    case OwnerVaultDirectoryControlResource.CredentialFence:
      return (
        expected.resource === claims.resource &&
        claims.expectedCredentialEpoch === expected.expectedCredentialEpoch &&
        claims.expectedRoutingEpoch === expected.expectedRoutingEpoch
      );
    case OwnerVaultDirectoryControlResource.Snapshot:
      return expected.resource === claims.resource && claims.backupID === expected.backupID;
    case OwnerVaultDirectoryControlResource.Restore:
      return (
        expected.resource === claims.resource &&
        claims.restoreID === expected.restoreID &&
        claims.backupID === expected.backupID &&
        claims.manifestDigest === expected.manifestDigest
      );
  }
};

export const signOwnerVaultDirectoryControl = (
  input: OwnerVaultDirectoryControlClaimsInput,
  keyRing: InternalCapabilityKeyRing,
  nowSeconds: number,
): Effect.Effect<
  SignedOwnerVaultDirectoryControl,
  CapabilityConfigurationError | CapabilitySigningError
> =>
  Effect.gen(function* () {
    const ring = yield* makeInternalCapabilityKeyRing(keyRing);
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0 || !positive(input.ttlSeconds))
      return yield* Effect.fail(new CapabilitySigningError({ reason: "invalid_claims" }));
    const claims = claimsFor(input, ring.current.keyID, nowSeconds);
    if (!claimsValid(claims))
      return yield* Effect.fail(new CapabilitySigningError({ reason: "invalid_claims" }));
    const payload = base64url(textEncoder.encode(canonicalPayload(claims)));
    const signature = yield* signCapabilityHmac(ring.current.secret, payload).pipe(
      Effect.mapError(() => new CapabilitySigningError({ reason: "crypto_failed" })),
    );
    return { value: `ovdc1.${payload}.${base64url(signature)}` };
  });

export const verifyOwnerVaultDirectoryControl = (
  signed: SignedOwnerVaultDirectoryControl,
  binding: OwnerVaultDirectoryControlRequestBinding,
  expected: OwnerVaultDirectoryControlExpectation,
  keyRing: InternalCapabilityKeyRing,
  nowSeconds: number,
): Effect.Effect<
  OwnerVaultDirectoryControlClaims,
  CapabilityConfigurationError | CapabilityVerificationError
> =>
  Effect.gen(function* () {
    const ring = yield* makeInternalCapabilityKeyRing(keyRing);
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0)
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "claims_invalid" }));
    const parts = signed.value.split(".");
    if (
      parts.length !== 3 ||
      parts[0] !== "ovdc1" ||
      parts[1] === undefined ||
      parts[2] === undefined
    )
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "malformed_token" }));
    const payloadBytes = fromBase64url(parts[1]);
    if (payloadBytes === undefined)
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "malformed_token" }));
    let payload: string;
    let parsed: unknown;
    try {
      payload = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
      parsed = JSON.parse(payload);
    } catch {
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "malformed_token" }));
    }
    const claims = yield* fromUnknown(parsed);
    if (payload !== canonicalPayload(claims))
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "claims_invalid" }));
    const material = [ring.current, ...ring.prior].find(
      (candidate) => candidate.keyID === claims.keyID,
    );
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
      !bindingValid(binding) ||
      !expectationValid(expected) ||
      !sameBinding(claims, binding) ||
      !sameExpectation(claims, expected)
    )
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "binding_mismatch" }));
    if (claims.expiresAt <= nowSeconds)
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "expired" }));
    if (claims.issuedAt > nowSeconds)
      return yield* Effect.fail(new CapabilityVerificationError({ reason: "not_yet_valid" }));
    return claims;
  });
