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
  SnapshotReceiptLeaseV1 = "snapshot-receipt-lease-v1",
  RestoreReceiptLeaseV1 = "restore-receipt-lease-v1",
}

export const ownerVaultPrivateInitializePath = "/__v2/internal/owner-vault/private-initialize";
export const ownerVaultCredentialFencePath = "/__v2/internal/owner-vault/credential-fence";
/** Versioned receipt-lease controls. The unversioned snapshot/restore routes
 * were deliberately never kept as aliases: an old bearer must fail closed. */
export const ownerVaultSnapshotReceiptLeaseV1Path =
  "/__v2/internal/owner-vault/snapshot-receipt-lease-v1";
export const ownerVaultRestoreReceiptLeaseV1Path =
  "/__v2/internal/owner-vault/restore-receipt-lease-v1";
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
export interface OwnerVaultSnapshotReceiptLeaseV1Binding extends Common {
  readonly resource: OwnerVaultDirectoryControlResource.SnapshotReceiptLeaseV1;
  readonly path: typeof ownerVaultSnapshotReceiptLeaseV1Path;
  readonly backupID: string;
  readonly sourceGeneration: number;
  readonly sourceRoutingEpoch: number;
  readonly sourceCredentialEpoch: number;
  readonly sourceControlEpoch: number;
  readonly sourceSecurityFloor: number;
}
export interface OwnerVaultRestoreReceiptLeaseV1Binding extends Common {
  readonly resource: OwnerVaultDirectoryControlResource.RestoreReceiptLeaseV1;
  readonly path: typeof ownerVaultRestoreReceiptLeaseV1Path;
  readonly allocationID: string;
  readonly initID: string;
  readonly sourceGeneration: number;
  readonly targetGeneration: number;
  readonly backupID: string;
  readonly manifestDigest: string;
  /** The exact signed source publication, including its transport signature. */
  readonly sourceSnapshotPublication: OwnerVaultSourceSnapshotPublicationV1;
}
export interface OwnerVaultSourceSnapshotPublicationV1 {
  readonly schema: "source-snapshot-publication-v1";
  readonly authority: "owner-vault-production-manifest-ring-v1";
  readonly algorithm: "ES256-P256-canonical-low-s-der";
  readonly publication: {
    readonly category: "owner-vault.snapshot-pin";
    readonly schema: "snapshot-pin-v2";
    readonly state: "COMPLETED";
  };
  readonly sourceRoot: {
    readonly ownerID: string;
    readonly vaultID: string;
    readonly generationEpoch: number;
    readonly namespaceState: "PRIVATE";
  };
  readonly backupID: string;
  readonly manifestDigest: string;
  readonly snapshotOperationID: string;
  readonly snapshotJTI: string;
  readonly snapshotCommandSHA256: string;
  readonly signingKeyID: string;
  readonly signature: { readonly keyID: string; readonly signatureDERBase64: string };
}
export type OwnerVaultDirectoryControlRequestBinding =
  | OwnerVaultPrivateInitializeBinding
  | OwnerVaultCredentialFenceBinding
  | OwnerVaultSnapshotReceiptLeaseV1Binding
  | OwnerVaultRestoreReceiptLeaseV1Binding;

/** Expectations intentionally mirror every request claim (except key/time). */
export type OwnerVaultDirectoryControlExpectation = OwnerVaultDirectoryControlRequestBinding;
interface Signed {
  readonly keyID: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
export type OwnerVaultPrivateInitializeClaims = OwnerVaultPrivateInitializeBinding & Signed;
export type OwnerVaultCredentialFenceClaims = OwnerVaultCredentialFenceBinding & Signed;
export type OwnerVaultSnapshotReceiptLeaseV1Claims = OwnerVaultSnapshotReceiptLeaseV1Binding &
  Signed;
export type OwnerVaultRestoreReceiptLeaseV1Claims = OwnerVaultRestoreReceiptLeaseV1Binding & Signed;
export type OwnerVaultDirectoryControlClaims =
  | OwnerVaultPrivateInitializeClaims
  | OwnerVaultCredentialFenceClaims
  | OwnerVaultSnapshotReceiptLeaseV1Claims
  | OwnerVaultRestoreReceiptLeaseV1Claims;
export type OwnerVaultPrivateInitializeClaimsInput = OwnerVaultPrivateInitializeBinding & {
  readonly ttlSeconds: number;
};
export type OwnerVaultCredentialFenceClaimsInput = OwnerVaultCredentialFenceBinding & {
  readonly ttlSeconds: number;
};
export type OwnerVaultSnapshotReceiptLeaseV1ClaimsInput =
  OwnerVaultSnapshotReceiptLeaseV1Binding & {
    readonly ttlSeconds: number;
  };
export type OwnerVaultRestoreReceiptLeaseV1ClaimsInput = OwnerVaultRestoreReceiptLeaseV1Binding & {
  readonly ttlSeconds: number;
};
export type OwnerVaultDirectoryControlClaimsInput =
  | OwnerVaultPrivateInitializeClaimsInput
  | OwnerVaultCredentialFenceClaimsInput
  | OwnerVaultSnapshotReceiptLeaseV1ClaimsInput
  | OwnerVaultRestoreReceiptLeaseV1ClaimsInput;
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
const sha256Hex = /^[a-f0-9]{64}$/u;
const sha256Base64url = /^[A-Za-z0-9_-]{43}$/u;
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
/** A SHA-256 digest has exactly 32 bytes and one canonical, unpadded base64url spelling. */
const manifestDigestValid = (value: string): boolean => {
  if (!sha256Base64url.test(value)) return false;
  const bytes = fromB64url(value);
  return bytes !== undefined && bytes.byteLength === 32;
};
const canonicalDERBase64 = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false;
  try {
    return btoa(atob(value)) === value;
  } catch {
    return false;
  }
};
const plain = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
const exactProof = (value: Readonly<Record<string, unknown>>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
export const isOwnerVaultSourceSnapshotPublication = (
  value: unknown,
): value is OwnerVaultSourceSnapshotPublicationV1 => {
  const proof = plain(value);
  const publication = proof === undefined ? undefined : plain(proof.publication);
  const root = proof === undefined ? undefined : plain(proof.sourceRoot);
  const signature = proof === undefined ? undefined : plain(proof.signature);
  return (
    proof !== undefined &&
    exactProof(proof, [
      "schema",
      "authority",
      "algorithm",
      "publication",
      "sourceRoot",
      "backupID",
      "manifestDigest",
      "snapshotOperationID",
      "snapshotJTI",
      "snapshotCommandSHA256",
      "signingKeyID",
      "signature",
    ]) &&
    proof.schema === "source-snapshot-publication-v1" &&
    proof.authority === "owner-vault-production-manifest-ring-v1" &&
    proof.algorithm === "ES256-P256-canonical-low-s-der" &&
    publication !== undefined &&
    exactProof(publication, ["category", "schema", "state"]) &&
    publication.category === "owner-vault.snapshot-pin" &&
    publication.schema === "snapshot-pin-v2" &&
    publication.state === "COMPLETED" &&
    root !== undefined &&
    exactProof(root, ["ownerID", "vaultID", "generationEpoch", "namespaceState"]) &&
    typeof root.ownerID === "string" &&
    id.test(root.ownerID) &&
    typeof root.vaultID === "string" &&
    id.test(root.vaultID) &&
    positive(root.generationEpoch) &&
    root.namespaceState === "PRIVATE" &&
    typeof proof.backupID === "string" &&
    opaque.test(proof.backupID) &&
    typeof proof.manifestDigest === "string" &&
    manifestDigestValid(proof.manifestDigest) &&
    typeof proof.snapshotOperationID === "string" &&
    opaque.test(proof.snapshotOperationID) &&
    typeof proof.snapshotJTI === "string" &&
    opaque.test(proof.snapshotJTI) &&
    typeof proof.snapshotCommandSHA256 === "string" &&
    sha256Hex.test(proof.snapshotCommandSHA256) &&
    typeof proof.signingKeyID === "string" &&
    keyID.test(proof.signingKeyID) &&
    signature !== undefined &&
    exactProof(signature, ["keyID", "signatureDERBase64"]) &&
    signature.keyID === proof.signingKeyID &&
    canonicalDERBase64(signature.signatureDERBase64)
  );
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
  sha256Hex.test(value.bodySHA256);
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
  manifestDigestValid(value.manifestDigest);
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
    case OwnerVaultDirectoryControlResource.SnapshotReceiptLeaseV1:
      return (
        commonValid(value) &&
        value.path === ownerVaultSnapshotReceiptLeaseV1Path &&
        opaque.test(value.backupID) &&
        positive(value.sourceGeneration) &&
        positive(value.sourceRoutingEpoch) &&
        positive(value.sourceCredentialEpoch) &&
        positive(value.sourceControlEpoch) &&
        positive(value.sourceSecurityFloor)
      );
    case OwnerVaultDirectoryControlResource.RestoreReceiptLeaseV1:
      return (
        commonValid(value) &&
        value.path === ownerVaultRestoreReceiptLeaseV1Path &&
        allocationValid(value) &&
        isOwnerVaultSourceSnapshotPublication(value.sourceSnapshotPublication) &&
        value.sourceSnapshotPublication.sourceRoot.ownerID === value.ownerID &&
        value.sourceSnapshotPublication.sourceRoot.vaultID === value.vaultID &&
        value.sourceSnapshotPublication.sourceRoot.generationEpoch === value.sourceGeneration &&
        value.sourceSnapshotPublication.backupID === value.backupID &&
        value.sourceSnapshotPublication.manifestDigest === value.manifestDigest &&
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
    case OwnerVaultDirectoryControlResource.SnapshotReceiptLeaseV1:
      return JSON.stringify({
        ...common,
        backupID: claims.backupID,
        sourceGeneration: claims.sourceGeneration,
        sourceRoutingEpoch: claims.sourceRoutingEpoch,
        sourceCredentialEpoch: claims.sourceCredentialEpoch,
        sourceControlEpoch: claims.sourceControlEpoch,
        sourceSecurityFloor: claims.sourceSecurityFloor,
      });
    case OwnerVaultDirectoryControlResource.RestoreReceiptLeaseV1:
      return JSON.stringify({
        ...common,
        allocationID: claims.allocationID,
        initID: claims.initID,
        sourceGeneration: claims.sourceGeneration,
        targetGeneration: claims.targetGeneration,
        backupID: claims.backupID,
        manifestDigest: claims.manifestDigest,
        sourceSnapshotPublication: claims.sourceSnapshotPublication,
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
      case OwnerVaultDirectoryControlResource.SnapshotReceiptLeaseV1: {
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
          record.path !== ownerVaultSnapshotReceiptLeaseV1Path ||
          typeof record.backupID !== "string" ||
          typeof record.sourceGeneration !== "number" ||
          typeof record.sourceRoutingEpoch !== "number" ||
          typeof record.sourceCredentialEpoch !== "number" ||
          typeof record.sourceControlEpoch !== "number" ||
          typeof record.sourceSecurityFloor !== "number"
        )
          return yield* invalid();
        const claims: OwnerVaultSnapshotReceiptLeaseV1Claims = {
          resource: record.resource,
          path: ownerVaultSnapshotReceiptLeaseV1Path,
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
      case OwnerVaultDirectoryControlResource.RestoreReceiptLeaseV1: {
        const sourceSnapshotPublication = record.sourceSnapshotPublication;
        if (
          !hasExact(record, [
            ...commonKeys,
            "allocationID",
            "initID",
            "sourceGeneration",
            "targetGeneration",
            "backupID",
            "manifestDigest",
            "sourceSnapshotPublication",
          ]) ||
          record.path !== ownerVaultRestoreReceiptLeaseV1Path ||
          typeof record.allocationID !== "string" ||
          typeof record.initID !== "string" ||
          typeof record.sourceGeneration !== "number" ||
          typeof record.targetGeneration !== "number" ||
          typeof record.backupID !== "string" ||
          typeof record.manifestDigest !== "string" ||
          !isOwnerVaultSourceSnapshotPublication(sourceSnapshotPublication)
        )
          return yield* invalid();
        const claims: OwnerVaultRestoreReceiptLeaseV1Claims = {
          resource: record.resource,
          path: ownerVaultRestoreReceiptLeaseV1Path,
          method: "POST",
          canonicalQuery: "",
          ...common,
          allocationID: record.allocationID,
          initID: record.initID,
          sourceGeneration: record.sourceGeneration,
          targetGeneration: record.targetGeneration,
          backupID: record.backupID,
          manifestDigest: record.manifestDigest,
          sourceSnapshotPublication,
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
    case OwnerVaultDirectoryControlResource.SnapshotReceiptLeaseV1: {
      const { ttlSeconds: _, ...binding } = input;
      return { ...binding, ...signed };
    }
    case OwnerVaultDirectoryControlResource.RestoreReceiptLeaseV1: {
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
    case OwnerVaultDirectoryControlResource.SnapshotReceiptLeaseV1:
      return { ...binding, ...signed };
    case OwnerVaultDirectoryControlResource.RestoreReceiptLeaseV1:
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
    if (ring.revokedKeyIDs.includes(claims.keyID))
      return yield* Effect.fail(new VerificationError({ reason: "unknown_or_stale_key" }));
    const key = [ring.current, ...ring.prior].find((entry) => entry.keyID === claims.keyID);
    if (key === undefined)
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
